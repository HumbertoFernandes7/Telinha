/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of addon/loader/main.js, the capture flags (PAYLOAD.md section 6.1): %APPDATA%\Telinha\capture-flags.json
 * asks for Chromium's WGC texture capture (WebRtcAllowWgcUsingTexture) and/or the GPU's AV1 encoder for WebRTC
 * (WebRtcAV1HWEncode), which the loader adds to enable-features before app ready and keeps there when Discord's bootstrap
 * appends its own enable-features later.
 *
 *   node --test addon/test/main.capture.test.mjs        (also run by `pnpm test:addon`)
 *
 * Same set-up as main.hooks.test.mjs: a byte-identical loader copy in a fake %APPDATA%\Telinha tree, a fake electron whose
 * app.commandLine keeps Chromium's "the last append wins" semantics, os.release() and process.platform swapped per test.
 * What needs a real Discord: that Chromium really turns the feature on (REAL-TEST.md; the plugin logs what it sees).
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loaderPayload, loaderScratch, makeLoaderTree, STUB_UPDATER, useWorld, vencordLike } from "./fake/loader-kit.mjs";

// the loader trees stay after the run (coverage of a loader copy is mapped back to addon/loader/ at report time)
const BASE = loaderScratch("main-capture");
const FEATURE = "WebRtcAllowWgcUsingTexture";
const AV1 = "WebRtcAV1HWEncode";
const tick = () => new Promise(r => setImmediate(r));

/** Windows build `build` (os.release()) on win32, or another platform; `wayland`: a Linux Wayland session's variables. */
function useOs(t, { build = 26300, platform = "win32", wayland = false } = {}) {
    t.mock.method(os, "release", () => `10.0.${build}`);
    const before = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...before, value: platform });
    t.after(() => Object.defineProperty(process, "platform", before));
    // the machine running the tests may itself be a Wayland session: the variables are always set here
    for (const [name, value] of [["XDG_SESSION_TYPE", wayland ? "wayland" : undefined], ["WAYLAND_DISPLAY", wayland ? "wayland-0" : undefined]]) {
        const had = Object.hasOwn(process.env, name);
        const old = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
        t.after(() => had ? (process.env[name] = old) : delete process.env[name]);
    }
}

/**
 * One boot of a loader copy. `flags`: the capture-flags.json content (an object is written as JSON, a string as is, null =
 * no file); `before(electron)`: runs before the boot (a switch already on the command line...); `patcher`: the fake Vencord.
 */
function boot(t, { flags = { wgcTexture: true }, build, platform, wayland, argv = [], before, patcher = vencordLike() } = {}) {
    useOs(t, { build, platform, wayland });
    const tree = makeLoaderTree({ installed: loaderPayload({ replace: { "updater.js": STUB_UPDATER } }), base: BASE });
    const flagsFile = join(tree.home, "capture-flags.json");
    if (flags !== null) writeFileSync(flagsFile, typeof flags === "string" ? flags : JSON.stringify(flags));
    const w = useWorld(t, { patcher, argv });
    before?.(w.electron);
    const loader = tree.load();
    loader.boot({ vencordPatcher: tree.patcher, vanilla: t.mock.fn() });
    const commandLine = w.electron.app.commandLine;
    return { tree, flagsFile, state: loader.state, electron: w.electron, commandLine, features: () => commandLine.getSwitchValue("enable-features"), loader };
}

const ready = async electron => {
    electron.app.becomeReady();
    await tick();
    await tick();
};

/** Discord's bootstrap (resources/_app.asar), which sets its own enable-features without merging. */
const DISCORD_FEATURE = "DocumentPolicyIncludeJSCallStacksInCrashReports";
const discordBootstrap = electron => electron.app.commandLine.appendSwitch("enable-features", DISCORD_FEATURE);

describe("capture-flags.json asks for the GPU capture (Windows 11 24H2+)", () => {
    test("the feature goes into enable-features before app ready, and stays when Discord's bootstrap appends its own", async t => {
        const { state, features, electron, tree, flagsFile } = boot(t, { patcher: vencordLike(), before: e => e.app.commandLine.appendSwitch("enable-features", "FromArgv") });
        assert.equal(features(), `FromArgv,${FEATURE}`, "merged with what was already there");
        discordBootstrap(electron);
        assert.equal(features(), `${DISCORD_FEATURE},${FEATURE}`, "Discord's later call keeps ours (and replaces the rest, as without us)");
        assert.deepEqual({ ...state.capture, file: state.capture.file.toLowerCase() }, {
            file: flagsFile.toLowerCase(), build: 26300, wgcTexture: true, applied: null, enableFeatures: null, reason: null, av1HwEncode: false, av1Applied: null,
            screenAudioInChromium: { asked: false, applied: null, disableFeatures: null, reason: null }
        });
        assert.match(tree.mainLog(), new RegExp(`capture: GPU capture asked for: ${FEATURE} added to enable-features \\(Windows build 26300\\)`));

        await ready(electron);
        assert.equal(state.capture.applied, true);
        assert.equal(state.capture.enableFeatures, `${DISCORD_FEATURE},${FEATURE}`);
        assert.match(tree.mainLog(), new RegExp(`capture: enable-features at app ready: ${DISCORD_FEATURE},${FEATURE} -> GPU capture applied`));
        assert.deepEqual(state.errors, []);
    });

    test("other switches pass untouched; a value that already has the feature (by name) is not changed; '--Enable-Features' counts", t => {
        const { commandLine, features } = boot(t);
        commandLine.appendSwitch("disable-features", "Foo");
        commandLine.appendSwitch("enable-h264-mf-zero-copy");
        assert.deepEqual(commandLine.appended.slice(-2), [["disable-features", "Foo"], ["enable-h264-mf-zero-copy", undefined]]);
        commandLine.appendSwitch("enable-features", `A, *${FEATURE}<Trial ,B`);
        assert.equal(features(), `A,*${FEATURE}<Trial,B`);
        commandLine.appendSwitch("--Enable-Features", "C");
        assert.equal(features(), `C,${FEATURE}`);
        commandLine.appendSwitch("enable-features", `${FEATURE}:param/1`);
        assert.equal(features(), `${FEATURE}:param/1`);
    });

    test("a second boot in the same process (hand-off to another loader version) does not stack another wrapper", t => {
        const { commandLine, loader, tree, features } = boot(t);
        const wrapper = commandLine.appendSwitch;
        assert.deepEqual(wrapper.telinhaKeeps, [FEATURE]);
        loader.boot({ vencordPatcher: tree.patcher, vanilla: t.mock.fn() });
        assert.equal(commandLine.appendSwitch, wrapper);
        commandLine.appendSwitch("enable-features", "X");
        assert.equal(features(), `X,${FEATURE}`);
    });

    test("something replaces enable-features behind the wrapper: logged as NOT applied, still no boot problem", async t => {
        const { state, electron, commandLine, tree } = boot(t);
        commandLine.switches.set("enable-features", "SomethingElse");
        await ready(electron);
        assert.equal(state.capture.applied, false);
        assert.equal(state.capture.reason, "enable-features was replaced after the loader added the feature");
        assert.match(tree.mainLog(), /capture: enable-features at app ready: SomethingElse -> GPU capture NOT applied/);
        assert.deepEqual(state.errors, []);
    });

    test("enable-features empty at ready (the fake answers undefined): '(empty)', not applied", async t => {
        const { state, electron, commandLine, tree } = boot(t);
        commandLine.getSwitchValue = () => undefined;
        await ready(electron);
        assert.equal(state.capture.enableFeatures, "");
        assert.equal(state.capture.applied, false);
        assert.match(tree.mainLog(), /at app ready: \(empty\) -> GPU capture NOT applied/);
    });

    test("app.whenReady() rejecting: the capture part says nothing (the CSP part reports it)", async t => {
        const { state, electron } = boot(t, { patcher: vencordLike({ installCsp: false }) });
        electron.app.failReady(new Error("no ready"));
        await tick();
        assert.equal(state.capture.applied, null);
        assert.deepEqual(state.errors.map(e => e.split(":")[0]), ["csp"]);
    });

    test("app.commandLine missing with only the screen audio asked: its own reason, capture.reason untouched, no AV1 wording", t => {
        const { state, tree } = boot(t, { flags: { screenAudioInChromium: true }, before: e => delete e.app.commandLine });
        assert.equal(state.capture.screenAudioInChromium.applied, false);
        assert.match(state.capture.screenAudioInChromium.reason, /^could not turn it on \(/);
        assert.equal(state.capture.reason, null);
        assert.match(tree.mainLog(), /capture: screen audio in Chromium not applied: could not turn it on/);
        assert.doesNotMatch(tree.mainLog(), /AV1 hardware encode not applied/);
    });

    test("app.commandLine missing (a broken Electron): not applied, logged, no boot problem, Vencord still loads", t => {
        const { state, tree } = boot(t, { before: e => delete e.app.commandLine });
        assert.equal(state.capture.wgcTexture, true);
        assert.equal(state.capture.applied, false);
        assert.match(state.capture.reason, /^could not turn it on \(/);
        assert.match(tree.mainLog(), /capture: GPU capture not applied: could not turn it on/);
        assert.deepEqual(state.errors, []);
        assert.equal(state.vencordLoaded, true);
    });
});

describe("capture-flags.json asks for the GPU's AV1 encoder (AV1 pinned in the plugin)", () => {
    test("alone: the feature goes into enable-features, stays after Discord's bootstrap, and app ready says applied", async t => {
        const { state, features, electron, tree } = boot(t, { flags: { format: 1, wgcTexture: false, av1HwEncode: true } });
        assert.equal(features(), AV1);
        discordBootstrap(electron);
        assert.equal(features(), `${DISCORD_FEATURE},${AV1}`);
        assert.deepEqual([state.capture.wgcTexture, state.capture.applied, state.capture.av1HwEncode, state.capture.av1Applied], [false, null, true, null]);
        assert.match(tree.mainLog(), new RegExp(`capture: AV1 hardware encode asked for: ${AV1} added to enable-features`));
        assert.doesNotMatch(tree.mainLog(), /GPU capture/);
        await ready(electron);
        assert.equal(state.capture.av1Applied, true);
        assert.equal(state.capture.applied, null, "the GPU capture was not asked for");
        assert.match(tree.mainLog(), new RegExp(`capture: enable-features at app ready: ${DISCORD_FEATURE},${AV1} -> AV1 hardware encode applied$`, "m"));
        assert.deepEqual(state.errors, []);
    });

    test("with the GPU capture: both features, one wrapper that keeps both, one line at ready", async t => {
        const { state, features, electron, commandLine, tree } = boot(t, { flags: { format: 1, wgcTexture: true, av1HwEncode: true } });
        assert.equal(features(), `${FEATURE},${AV1}`);
        assert.deepEqual(commandLine.appendSwitch.telinhaKeeps, [FEATURE, AV1]);
        discordBootstrap(electron);
        assert.equal(features(), `${DISCORD_FEATURE},${FEATURE},${AV1}`);
        await ready(electron);
        assert.deepEqual([state.capture.applied, state.capture.av1Applied], [true, true]);
        assert.match(tree.mainLog(), /-> GPU capture applied; AV1 hardware encode applied/);
    });

    test("an older Windows: the GPU capture is not applied, the AV1 feature still is", async t => {
        const { state, features, electron } = boot(t, { build: 19045, flags: { wgcTexture: true, av1HwEncode: true } });
        assert.equal(features(), AV1);
        assert.equal(state.capture.applied, false);
        assert.match(state.capture.reason, /^Windows build 19045: /);
        await ready(electron);
        assert.deepEqual([state.capture.applied, state.capture.av1Applied], [false, true]);
    });

    test("a hand-off to a loader that asks for more widens the one wrapper (never stacks), and keeps both", t => {
        const { commandLine, loader, tree, features, flagsFile } = boot(t);
        const first = commandLine.appendSwitch;
        assert.deepEqual(first.telinhaKeeps, [FEATURE]);
        writeFileSync(flagsFile, JSON.stringify({ format: 1, wgcTexture: true, av1HwEncode: true }));
        loader.boot({ vencordPatcher: tree.patcher, vanilla: t.mock.fn() });
        const second = commandLine.appendSwitch;
        assert.notEqual(second, first);
        assert.deepEqual(second.telinhaKeeps, [FEATURE, AV1]);
        assert.equal(second.telinhaOriginal, first.telinhaOriginal, "the wider wrapper calls the same original");
        commandLine.appendSwitch("enable-features", "X");
        assert.equal(features(), `X,${FEATURE},${AV1}`);
    });

    test("something replaces enable-features behind the wrapper: AV1 NOT applied, no boot problem", async t => {
        const { state, electron, commandLine, tree } = boot(t, { flags: { av1HwEncode: true } });
        commandLine.switches.set("enable-features", "SomethingElse");
        await ready(electron);
        assert.equal(state.capture.av1Applied, false);
        assert.match(tree.mainLog(), /-> AV1 hardware encode NOT applied/);
        assert.deepEqual(state.errors, []);
    });

    test("app.commandLine missing: AV1 not applied, logged, no boot problem", t => {
        const { state, tree } = boot(t, { flags: { av1HwEncode: true }, before: e => delete e.app.commandLine });
        assert.equal(state.capture.av1Applied, false);
        assert.equal(state.capture.applied, null);
        assert.match(tree.mainLog(), /capture: AV1 hardware encode not applied: could not turn it on/);
        assert.deepEqual(state.errors, []);
    });

    for (const flags of [{ av1HwEncode: false }, { av1HwEncode: "true" }, { av1HwEncode: 1 }]) {
        test(`not asked for, or a value that is not true: ${JSON.stringify(flags)}`, t => {
            const { state, commandLine } = boot(t, { flags });
            assert.deepEqual(commandLine.appended, []);
            assert.deepEqual([state.capture.av1HwEncode, state.capture.av1Applied], [false, null]);
        });
    }
});

describe("capture-flags.json asks for the screen's sound in Chromium (screenAudioInChromium)", () => {
    const SA = ["AudioServiceOutOfProcess", "RestrictOwnAudioAddChromiumBack"];
    const disabled = commandLine => commandLine.getSwitchValue("disable-features");

    test("both go into disable-features, merged with what Discord already passes (theirs are kept)", async t => {
        const { state, electron, commandLine, tree } = boot(t, {
            flags: { format: 1, screenAudioInChromium: true },
            before: e => e.app.commandLine.appendSwitch("disable-features", "FromDiscord,Other")
        });
        assert.equal(disabled(commandLine), `FromDiscord,Other,${SA.join(",")}`);
        assert.equal(commandLine.getSwitchValue("enable-features"), "", "enable-features untouched");
        assert.deepEqual(state.capture.screenAudioInChromium, { asked: true, applied: null, disableFeatures: null, reason: null });
        assert.match(tree.mainLog(), /capture: screen audio in Chromium asked for: AudioServiceOutOfProcess,RestrictOwnAudioAddChromiumBack added to disable-features/);
        await ready(electron);
        assert.deepEqual(state.capture.screenAudioInChromium, { asked: true, applied: true, disableFeatures: `FromDiscord,Other,${SA.join(",")}`, reason: null });
        assert.match(tree.mainLog(), /-> screen audio in Chromium applied$/m);
        assert.deepEqual(state.errors, []);
    });

    test("no duplicates when the features are already disabled", t => {
        const { commandLine } = boot(t, {
            flags: { screenAudioInChromium: true },
            before: e => e.app.commandLine.appendSwitch("disable-features", `A,${SA[0]}`)
        });
        assert.equal(disabled(commandLine), `A,${SA[0]},${SA[1]}`);
    });

    test("a later disable-features from Discord's bootstrap keeps ours (and enable-features keeps its own)", async t => {
        const { state, electron, commandLine } = boot(t, { flags: { wgcTexture: true, screenAudioInChromium: true } });
        discordBootstrap(electron);
        commandLine.appendSwitch("disable-features", "DiscordOwn");
        assert.equal(disabled(commandLine), `DiscordOwn,${SA.join(",")}`);
        assert.equal(commandLine.getSwitchValue("enable-features"), `${DISCORD_FEATURE},${FEATURE}`);
        assert.deepEqual(commandLine.appendSwitch.telinhaKeepsDisabled, SA);
        assert.deepEqual(commandLine.appendSwitch.telinhaKeeps, [FEATURE]);
        await ready(electron);
        assert.equal(state.capture.screenAudioInChromium.applied, true);
        assert.match(state.capture.screenAudioInChromium.disableFeatures, /DiscordOwn/);
    });

    test("getSwitchValue answering nothing for disable-features at app ready: the value is \"\" and it is NOT applied", async t => {
        const { state, electron, commandLine, tree } = boot(t, { flags: { screenAudioInChromium: true } });
        const real = commandLine.getSwitchValue;
        commandLine.getSwitchValue = name => (name === "disable-features" ? undefined : real(name));
        await ready(electron);
        assert.equal(state.capture.screenAudioInChromium.disableFeatures, "");
        assert.equal(state.capture.screenAudioInChromium.applied, false);
        assert.match(tree.mainLog(), /-> screen audio in Chromium NOT applied/);
        assert.deepEqual(state.errors, []);
    });

    test("something replaces disable-features behind the wrapper: NOT applied, no boot problem", async t => {
        const { state, electron, commandLine, tree } = boot(t, { flags: { screenAudioInChromium: true } });
        commandLine.switches.set("disable-features", "SomethingElse");
        await ready(electron);
        assert.equal(state.capture.screenAudioInChromium.applied, false);
        assert.match(tree.mainLog(), /-> screen audio in Chromium NOT applied/);
        assert.deepEqual(state.errors, []);
    });

    for (const flags of [{}, { screenAudioInChromium: false }, { screenAudioInChromium: "true" }, { screenAudioInChromium: 1 }]) {
        test(`not asked for, or a value that is not true: ${JSON.stringify(flags)} changes nothing`, t => {
            const { state, commandLine } = boot(t, { flags });
            assert.deepEqual(commandLine.appended, []);
            assert.equal(commandLine.appendSwitch.telinhaKeepsDisabled, undefined);
            assert.deepEqual(state.capture.screenAudioInChromium, { asked: false, applied: null, disableFeatures: null, reason: null });
        });
    }

    test("a hand-off to a loader that asks for it widens the one wrapper (never stacks)", t => {
        const { commandLine, tree, flagsFile } = boot(t, { flags: { wgcTexture: true } });
        const first = commandLine.appendSwitch;
        writeFileSync(flagsFile, JSON.stringify({ wgcTexture: true, screenAudioInChromium: true }));
        tree.load().boot({ vencordPatcher: tree.patcher, vanilla: t.mock.fn() });
        const second = commandLine.appendSwitch;
        assert.notEqual(second, first);
        assert.deepEqual(second.telinhaKeeps, [FEATURE]);
        assert.deepEqual(second.telinhaKeepsDisabled, SA);
        assert.equal(second.telinhaOriginal, first.telinhaOriginal, "the original is not wrapped twice");
    });
});

describe("the GPU capture stays off", () => {
    test("no capture-flags.json (the default): nothing appended, nothing logged", t => {
        const { state, commandLine, tree } = boot(t, { flags: null });
        assert.deepEqual(commandLine.appended, []);
        assert.equal(commandLine.appendSwitch.telinhaKeeps, undefined, "no wrapper either");
        assert.deepEqual([state.capture.wgcTexture, state.capture.applied, state.capture.reason], [false, null, null]);
        assert.doesNotMatch(tree.mainLog(), /capture:/);
    });

    for (const flags of [{ wgcTexture: false }, { wgcTexture: "yes" }, [], "null"]) {
        test(`turned off in the plugin, or a value that is not true: ${JSON.stringify(flags)}`, t => {
            const { state, commandLine } = boot(t, { flags });
            assert.deepEqual(commandLine.appended, []);
            assert.deepEqual([state.capture.wgcTexture, state.capture.reason], [false, null]);
        });
    }

    test("a broken file: ignored (off) and logged, never a boot problem", t => {
        const { state, commandLine, tree } = boot(t, { flags: "{ not json" });
        assert.deepEqual(commandLine.appended, []);
        assert.match(state.capture.reason, /^capture-flags\.json ignored \(/);
        assert.match(tree.mainLog(), /capture: capture-flags\.json ignored \(/);
        assert.deepEqual(state.errors, []);
    });

    test("Windows older than 11 24H2: asked for but not applied, and the log says why", t => {
        const { state, commandLine, tree } = boot(t, { build: 22631 });
        assert.deepEqual(commandLine.appended, []);
        assert.equal(state.capture.applied, false);
        assert.equal(state.capture.reason, `Windows build 22631: ${FEATURE} needs Windows 11 24H2 (build 26100) or newer`);
        assert.match(tree.mainLog(), /capture: GPU capture asked for but not applied \(Windows build 22631: /);
    });

    test("not Windows: build unknown ('?'), not applied", t => {
        const { state, commandLine } = boot(t, { platform: "linux" });
        assert.deepEqual(commandLine.appended, []);
        assert.equal(state.capture.build, 0);
        assert.match(state.capture.reason, /^Windows build \?: /);
    });

    test("Linux under Wayland: the PipeWire capturer goes into enable-features, even with no capture-flags.json", async t => {
        const { state, features, electron, tree } = boot(t, { platform: "linux", wayland: true, flags: null });
        assert.equal(features(), "WebRTCPipeWireCapturer");
        discordBootstrap(electron);
        assert.equal(features(), `${DISCORD_FEATURE},WebRTCPipeWireCapturer`, "Discord's later call keeps it");
        await ready(electron);
        assert.match(tree.mainLog(), /capture: Wayland: WebRTCPipeWireCapturer added to enable-features/);
        assert.match(tree.mainLog(), /PipeWire capturer applied/);
        assert.equal(state.capture.applied, null, "the GPU capture was not asked for");
    });

    test("Linux without Wayland (X11) and Windows: no PipeWire capturer", t => {
        assert.deepEqual(boot(t, { platform: "linux", flags: null }).commandLine.appended, []);
    });

    test("--vanilla: the loader stays out of the way (no hooks, no flags)", t => {
        const { state, commandLine } = boot(t, { argv: ["--vanilla"] });
        assert.deepEqual(commandLine.appended, []);
        assert.equal(state.capture, null);
    });
});
