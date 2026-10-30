/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Self-test of the individual fakes (test/fakes): each one used the way a plugin module uses the real thing. If one
// of these breaks, every work package that relies on that fake breaks with it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { screenAudioStatusMain, setScreenAudioHelperPathForTests } from "@plugins/telinha/core/audio/screenAudioMain";
import { listSources } from "@plugins/telinha/native";
import { settings } from "@plugins/telinha/settings";
import { installWebAudio } from "@test/fakes/audio";
import { mockSpawn } from "@test/fakes/childProcess";
import { eventually, useFakeClock } from "@test/fakes/clock";
import { canvas2d, resetMedia, resizeObservers } from "@test/fakes/dom";
import { ipcEvent } from "@test/fakes/electron";
import { installFetch, jsonResponse } from "@test/fakes/fetch";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { Modal, ModalHost, modals, pluginSettings, Select, toasts, webpackModules } from "@test/fakes/vencord";
import { CspPolicies } from "@test/fakes/vencord/main/csp";
import { findByCodeLazy, findStoreLazy } from "@webpack";
import { openModal, showToast } from "@webpack/common";

describe("fakes", () => {
    test("@webpack: lazy finders resolve what the test provided, and throw when nothing was", () => {
        const play = findByCodeLazy("Unable to find sound for pack name");
        assert.throws(() => play("x"), /nothing provided/);
        const played: unknown[] = [];
        webpackModules.provideByCode("Unable to find sound for pack name", (...args: unknown[]) => played.push(args));
        webpackModules.provideStore("NotificationSettingsStore", { isSoundDisabled: (n: string) => n === "off" });
        play("stream_started", 0.4);
        assert.deepEqual(played, [["stream_started", 0.4]]);
        assert.equal(findStoreLazy("NotificationSettingsStore").isSoundDisabled("off"), true);
        webpackModules.reset();
    });

    test("fetch is blocked unless routed", async () => {
        await assert.rejects(fetch("https://discord.com/api/oauth2/keys"), /network disabled/);
        const net = installFetch(url => (url.endsWith("/keys") ? jsonResponse({ keys: [] }) : undefined));
        assert.deepEqual(await (await fetch("https://discord.com/api/oauth2/keys")).json(), { keys: [] });
        await assert.rejects(fetch("https://example.com"), /no route/);
        assert.equal(net.calls.length, 2);
        net.restore();
    });

    test("Web Audio: context, worklet module, worklet node and a destination track", async () => {
        const audio = installWebAudio();
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.audioWorklet.addModule("blob:fake");
        const node = new AudioWorkletNode(ctx, "telinha-pcm-player");
        const dest = ctx.createMediaStreamDestination();
        node.connect(dest);
        node.port.postMessage("pcm");
        await ctx.resume();
        assert.equal(ctx.state, "running");
        assert.equal(dest.stream.getAudioTracks().length, 1);
        assert.deepEqual(audio.workletNodes[0].port.posted, [{ data: "pcm" }]);
        audio.restore();
        assert.equal(typeof (globalThis as { AudioContext?: unknown; }).AudioContext, "undefined");
    });

    test("child_process.spawn: the main-process code talks to a FakeChildProcess (screen audio probe)", async t => {
        const dir = mkdtempSync(join(tmpdir(), "tl-fakes-"));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const helper = join(dir, "telinha-audio.exe");
        writeFileSync(helper, "not a real exe");
        setScreenAudioHelperPathForTests(helper);
        t.mock.method(os, "release", () => "10.0.22631");
        const procs = mockSpawn(t, p => setImmediate(() => p.exit(0)));
        const status = await screenAudioStatusMain();
        assert.equal(status.available, process.platform === "win32");
        if (process.platform === "win32") assert.deepEqual(procs.spawned.map(p => [p.command, p.args]), [[helper, ["--probe"]]]);
        setScreenAudioHelperPathForTests(null);
    });

    test("electron: native.ts lists desktopCapturer sources and fed the CSP at load", async () => {
        const { sources } = await listSources(ipcEvent(), 320, 180);
        assert.deepEqual(sources.map(s => [s.id, s.kind, s.thumbnail?.slice(0, 23)]), [
            ["screen:0:0", "screen", "data:image/jpeg;base64,"],
            ["window:1234:0", "window", "data:image/jpeg;base64,"]
        ]);
        assert.ok(Object.keys(CspPolicies).length > 0 && Object.keys(CspPolicies).every(u => u.startsWith("wss://")));
    });

    test("dom: ResizeObserver, element size, fullscreen and the 2D canvas", async () => {
        const el = document.createElement("div");
        const widths: number[] = [];
        new ResizeObserver(() => widths.push(el.clientWidth)).observe(el);
        resizeObservers.resize(el, { width: 640, height: 360 });
        assert.deepEqual(widths, [640]);

        let changes = 0;
        document.addEventListener("fullscreenchange", () => changes++);
        await el.requestFullscreen();
        assert.equal(document.fullscreenElement, el);
        await document.exitFullscreen();
        assert.equal(document.fullscreenElement, null);
        assert.equal(changes, 2);

        canvas2d.pixels = (w, h) => new Uint8ClampedArray(w * h * 4);
        const ctx = document.createElement("canvas").getContext("2d")!;
        assert.equal(ctx.getImageData(0, 0, 4, 2).data.length, 32);
        resetMedia();
    });

    test("dom: the classes have the browser's names, Animation.cancel() leaves no unhandled rejection", async () => {
        const w = window as unknown as Record<string, { name: string; }>;
        for (const name of ["Node", "Event", "Text", "Comment", "Document", "DocumentFragment", "HTMLSelectElement", "HTMLFormElement", "Range", "URL"])
            assert.equal(w[name].name, name);
        assert.equal(document.createTextNode("x").constructor.name, "Text");
        assert.equal(document.createComment("x").constructor.name, "Comment");

        const anim = document.createElement("div").animate([{ opacity: 0 }, { opacity: 1 }], 100);
        anim.cancel();
        // a rejection nobody handles fails the test run (node:test), as it did before the fake handled it
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(anim.finished, { name: "AbortError" });
    });

    test("setup: console lines starting with [Telinha] are dropped (with or without the text glued on), the rest print", { skip: !!process.env.TELINHA_TEST_ECHO && "the silencer is off" }, t => {
        const written: string[] = [];
        for (const stream of [process.stdout, process.stderr])
            t.mock.method(stream, "write", (chunk: unknown) => !!written.push(String(chunk)));
        console.log("[Telinha]", "separate");
        console.warn("[Telinha] glued", new Error("x"));
        console.error(new Error("not ours"));
        console.info("other");
        t.mock.restoreAll();
        assert.equal(written.length, 2);
        assert.match(written[0], /not ours/);
        assert.match(written[1], /other/);
    });

    test("settings: load() is eager by default; { lazy: true } keeps plain to what was written, defaults only on read", () => {
        pluginSettings.load({ groupPassword: "x" });
        assert.equal(settings.plain.rejectOutsiders, true, "eager: every default is in plain");

        pluginSettings.load({ groupPassword: "x" }, { lazy: true });
        assert.deepEqual(settings.plain, { groupPassword: "x" });
        assert.equal(settings.store.rejectOutsiders, true, "the store answers the default...");
        assert.equal(pluginSettings.get("defaultAccess"), "all", "...also a SELECT's");
        assert.equal("rejectOutsiders" in settings.plain, false, "...without storing it");
        settings.store.rejectOutsiders = true; // the same as the default: written, but no change to announce
        assert.deepEqual(Object.keys(settings.plain), ["groupPassword", "rejectOutsiders"]);

        pluginSettings.reset(); // back to eager
        assert.equal(settings.plain.groupPassword, "");
        assert.equal(settings.plain.defaultAccess, "all");
    });

    test("clock: a tick shows every due timer the end of it; stepwise shows each its own instant", t => {
        const clock = useFakeClock(t);
        const start = clock.now();
        const seen: number[] = [];
        const timers = (offset: number) => [500, 1000, 1500].forEach(delay => setTimeout(() => seen.push(clock.now() - start - offset), delay));

        timers(0);
        clock.tick(2000);
        assert.deepEqual(seen, [2000, 2000, 2000]);

        seen.length = 0;
        timers(2000);
        clock.tick(2000, { stepwise: true });
        assert.deepEqual(seen, [500, 1000, 1500]);
        assert.equal(clock.now() - start, 4000);

        clock.tick(0, { stepwise: true }); // nothing to step: still runs what is due now, like tick(0)
        let chained = 0;
        setTimeout(() => void setTimeout(() => chained++, 0), 0);
        clock.tick(2, { stepwise: true });
        assert.equal(chained, 1, "a timer set by a timer runs in the next millisecond");
    });

    test("clock: eventually() polls with the real event loop, with or without the fake clock", async t => {
        let ready = false;
        setTimeout(() => void (ready = true), 5); // real timer: needs the 1 ms real waits
        await eventually(() => ready);

        const clock = useFakeClock(t);
        ready = false;
        setImmediate(() => void (ready = true));
        await eventually(() => ready); // a fake setTimeout(1) here would never fire
        await assert.rejects(eventually(() => false, { timeoutMs: 20 }), /condition still false after 20 ms/);
        clock.restore();
    });

    test("modals and toasts: openModal → ModalHost renders it; actions and onClose work", async () => {
        let applied = 0;
        render(<ModalHost />);
        // outside an event handler: a store change that re-renders goes inside act()
        act(() => void openModal(props => (
            <Modal {...props} title="Quem pode assistir" actions={[{ text: "Aplicar", variant: "primary", onClick: () => applied++ }]}>
                <Select options={[{ label: "Todos", value: "all" }, { label: "Senha", value: "password" }]} isSelected={v => v === "all"}
                    select={v => showToast({ text: `escolheu ${v}` })} serialize={String} />
            </Modal>
        )));
        fireEvent.click(screen.getByText("Aplicar"));
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "password" } });
        assert.equal(applied, 1);
        assert.deepEqual(toasts.map(x => x.text), ["escolheu password"]);
        fireEvent.click(screen.getByLabelText("Fechar"));
        await settle();
        assert.equal(modals.list().length, 0);
        assert.equal(screen.queryByText("Quem pode assistir"), null);
    });
});
