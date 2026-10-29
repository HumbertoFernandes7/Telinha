/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of addon/loader/main.js, the hooks half: prepare() (version, manifest, natives), the ipcMain hooks around a
 * Vencord's synchronous channels, the IPC handlers for the natives (and who may call them), the CSP chain and the dormant
 * BrowserWindow fallback.
 *
 *   node --test addon/test/main.hooks.test.mjs        (also run by `pnpm test:addon`)
 *
 * main.js runs IN this process from a byte-identical copy under the OS temp dir (fake %APPDATA%\Telinha\addon), against a
 * fake `electron` and a Vencord look-alike (fake/loader-kit.mjs). The real Vencord + real fake-Discord boot lives in
 * run-main-test.mjs / run-update-test.mjs; these tests drive the branches those cannot reach (broken manifests, hooks
 * that never fire, CSP failures, non-Discord callers...). The loader code is untouched.
 *
 * What needs a real Electron: that webRequest, ipcMain and BrowserWindow behave like the fake (one onHeadersReceived
 * listener, event.returnValue semantics, constructor.name filtering of getAllWindows): REAL-TEST.md is the manual check.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, test } from "node:test";

import { FAKE_NATIVES, loaderPayload, loaderScratch, makeElectron, makeLoaderTree, STUB_UPDATER, useWorld, vencordLike } from "./fake/loader-kit.mjs";

// the loader trees stay after the run (coverage of a loader copy is mapped back to addon/loader/ at report time)
const BASE = loaderScratch("main-hooks");
const tick = () => new Promise(r => setImmediate(r));
const CH_RENDERER = "VencordPreloadGetRendererJs";
const CH_MAP = "VencordGetPluginIpcMethodMap";
const CH_INFO = "TelinhaAddonPreloadInfo";
// minified like Vencord's `~plugins` module, so the loader can patch the PluginMeta entry in
const VENCORD_JS = 'var Xx={[a.name]:{folderName:"_api/badges",userPlugin:!1}};var Vencord={};';

/**
 * Builds a tree + world, loads the loader copy and boots it once.
 *   payload: loaderPayload options    world: useWorld options    patcher: what the fake Vencord does when required
 *   updater: false = the REAL updater.js (default: a recording stub)
 */
function boot(t, { payload = {}, world = {}, patcher = vencordLike({ rendererJs: VENCORD_JS }), updater = true, tree: treeOpts = {}, opts = {} } = {}) {
    const p = loaderPayload({ ...payload, replace: { ...(updater ? { "updater.js": STUB_UPDATER } : {}), ...payload.replace } });
    const tree = makeLoaderTree({ installed: p, base: BASE, ...treeOpts });
    const w = useWorld(t, { patcher, ...world });
    const loader = tree.load();
    const vanilla = t.mock.fn();
    let result;
    let thrown = null;
    try {
        result = loader.boot({ vencordPatcher: tree.patcher, vanilla, ...opts });
    } catch (err) {
        thrown = err;
    }
    return { tree, w, loader, state: loader.state, electron: w.electron, vanilla, result, thrown, logs: w.logs, req: createRequire(tree.mainPath) };
}

const ready = async electron => {
    electron.app.becomeReady();
    await tick();
    await tick();
};
const respond = (wr, details) => new Promise(resolve => wr.listener(details, resolve));
const csp = (...parts) => ({ "content-security-policy": [parts.join("; ")] });
const connectSrc = out => /connect-src ([^;]*)/.exec(out.responseHeaders["content-security-policy"][0])?.[1].split(" ") ?? [];

describe("prepare(): what the loader reads from its folder", () => {
    test("version.json, addon.json and the plugin's natives: state, channel names, helper folder", t => {
        const { state, tree } = boot(t);
        assert.deepEqual([state.version, state.commit], ["0.1.0", "base0100"]);
        assert.equal(state.nativesLoaded, true);
        assert.deepEqual(state.nativeChannels, ["TelinhaAddon_Telinha_listSources", "TelinhaAddon_Telinha_stopScreenAudio"], "only the functions the natives module exports");
        assert.deepEqual(state.addonChannels.sort(), ["bootOk", "updateCheck", "updateDownload", "updateStatus"].map(m => `TelinhaAddon_TelinhaAddon_${m}`));
        assert.equal(process.env.TELINHA_TEST_HELPER_DIR, tree.addonDir, "the plugin's helper executables are looked up in the add-on folder");
        assert.equal(state.helperDir, tree.addonDir);
        assert.deepEqual(state.errors, []);
        assert.equal(state.vencordLoaded, true);
    });

    test("a manifest without helperDirEnv sets no environment variable", t => {
        const { state } = boot(t, { payload: { manifest: { helperDirEnv: undefined } } });
        assert.equal(state.helperDir, null);
        assert.equal(process.env.TELINHA_TEST_HELPER_DIR, undefined);
    });

    test("a manifest without `main` (no natives): loaded state, no plugin channels, the plugin's entry left out of the IPC map", t => {
        const { state, electron } = boot(t, { payload: { manifest: { main: undefined } } });
        assert.equal(state.nativesLoaded, true);
        assert.deepEqual(state.nativeChannels, []);
        const map = electron.ipcMain.sendSync(CH_MAP);
        assert.equal("Telinha" in map, false, "the plugin then says its own 'native part not loaded'");
        assert.ok(map.TelinhaAddon, "the loader's own natives are still there");
    });

    test("natives that throw while loading: recorded and logged, the renderer side still served, no plugin natives", t => {
        const { state, electron, tree } = boot(t, { payload: { replace: { "telinha.main.js": "throw new Error('simulated broken natives');\n" } } });
        assert.equal(state.nativesLoaded, false);
        assert.deepEqual(state.nativeChannels, []);
        assert.ok(state.errors.some(e => e.startsWith("natives: ")));
        assert.match(tree.mainLog(), /ERROR natives: .*simulated broken natives/);
        assert.equal("Telinha" in electron.ipcMain.sendSync(CH_MAP), false);
        assert.match(electron.ipcMain.sendSync(CH_RENDERER), /__TelinhaAddonBoot/, "our renderer is still appended");
    });

    test("a natives module that exports null breaks prepare(): logged as 'boot', Vencord still loads (without our hooks)", t => {
        const { state, electron, logs } = boot(t, { payload: { replace: { "telinha.main.js": "module.exports = null;\n" } } });
        assert.ok(state.errors.some(e => e.startsWith("boot: ")));
        assert.equal(state.vencordLoaded, true);
        assert.equal(state.rendererHooked, false);
        assert.equal(electron.ipcMain.sendSync(CH_RENDERER), VENCORD_JS, "Vencord's renderer goes out unmodified");
        assert.ok(logs.error.some(l => /addon: boot failed/.test(l)));
    });

    test("version.json unreadable: noted, the rest of the boot goes on", t => {
        const tree = makeLoaderTree({ installed: loaderPayload({ replace: { "updater.js": STUB_UPDATER } }), base: BASE });
        rmSync(join(tree.addonDir, "version.json"));
        useWorld(t, { patcher: vencordLike({ rendererJs: VENCORD_JS }) });
        const loader = tree.load();
        loader.boot({ vencordPatcher: tree.patcher, vanilla() { } });
        assert.ok(loader.state.errors.some(e => e.startsWith("version: ")));
        assert.equal(loader.state.version, null);
        assert.equal(loader.state.nativesLoaded, true);
        assert.equal(loader.state.rendererHooked, true);
    });

    test("a version.json without version or commit fields leaves them null", t => {
        const tree = makeLoaderTree({ installed: loaderPayload({ replace: { "updater.js": STUB_UPDATER } }), base: BASE });
        writeFileSync(join(tree.addonDir, "version.json"), "{}");
        useWorld(t, { patcher: vencordLike() });
        const loader = tree.load();
        loader.boot({ vencordPatcher: tree.patcher, vanilla() { } });
        assert.deepEqual([loader.state.version, loader.state.commit], [null, null]);
        assert.deepEqual(loader.state.errors, []);
    });

    test("a failure that is not an Error object is kept and logged by its text", t => {
        const { state, tree } = boot(t, { payload: { replace: { "telinha.main.js": "throw 'string failure';\n" } } });
        assert.ok(state.errors.includes("natives: string failure"));
        assert.match(tree.mainLog(), /ERROR natives: string failure/);
    });

    test("addon.json missing or not JSON: the loader prepares nothing, Vencord still starts", t => {
        for (const text of [null, "{ not json"]) {
            const tree = makeLoaderTree({ installed: loaderPayload({ replace: { "updater.js": STUB_UPDATER } }), base: BASE });
            if (text === null) rmSync(join(tree.addonDir, "addon.json"));
            else writeFileSync(join(tree.addonDir, "addon.json"), text);
            useWorld(t, { patcher: vencordLike() });
            const loader = tree.load();
            loader.boot({ vencordPatcher: tree.patcher, vanilla() { } });
            assert.ok(loader.state.errors.some(e => e.startsWith("manifest: ")), String(text));
            assert.equal(loader.state.vencordLoaded, true);
            assert.equal(loader.state.nativesLoaded, false);
            assert.equal(loader.state.rendererHooked, false);
        }
    });

    test("a manifest without pluginName or renderer is refused with its own message", t => {
        for (const manifest of [{ pluginName: undefined }, { renderer: undefined }]) {
            const { state } = boot(t, { payload: { manifest } });
            assert.ok(state.errors.some(e => /manifest: .*addon\.json has no pluginName\/renderer/.test(e)), JSON.stringify(manifest));
            assert.equal(state.nativesLoaded, false);
        }
    });

    test("an add-on.json that is `null`/an empty object is refused the same way", t => {
        const { state } = boot(t, { payload: { replace: { "addon.json": "{}" } } });
        assert.ok(state.errors.some(e => /no pluginName\/renderer/.test(e)));
    });
});

describe("the hooks around Vencord's two synchronous IPC channels", () => {
    test("both channels answered by Vencord are extended; ipcMain.on is put back afterwards", t => {
        const { state, electron, logs } = boot(t, { patcher: vencordLike({ rendererJs: VENCORD_JS, ipcMap: { SomePlugin: { m: "ch" } } }) });
        assert.deepEqual([state.rendererHooked, state.ipcMapHooked], [true, true]);
        assert.equal(Object.hasOwn(electron.ipcMain, "on"), false, "no own `on`: the prototype's is back");
        assert.equal(electron.ipcMain.on, EventEmitter.prototype.on);

        const js = electron.ipcMain.sendSync(CH_RENDERER);
        assert.ok(js.startsWith('var Xx={"Telinha":{"folderName":"telinha-addon","userPlugin":true},[a.name]'), js.slice(0, 120));
        assert.ok(js.includes("__TelinhaAddonRegister") && js.includes("__telinhaRenderer"), "register.js + the plugin renderer, appended");
        assert.deepEqual([state.metaPatched, state.metaReason, state.rendererServed], [true, null, 1]);
        assert.ok(logs.log.some(l => /renderer served/.test(l)));

        const map = electron.ipcMain.sendSync(CH_MAP);
        assert.deepEqual(Object.keys(map).sort(), ["SomePlugin", "Telinha", "TelinhaAddon"]);
        assert.deepEqual(map.Telinha, { listSources: "TelinhaAddon_Telinha_listSources", stopScreenAudio: "TelinhaAddon_Telinha_stopScreenAudio" });
        assert.equal(map.TelinhaAddon.bootOk, "TelinhaAddon_TelinhaAddon_bootOk");
        assert.deepEqual(map.SomePlugin, { m: "ch" });
    });

    test("an own `on` / `addListener` of ipcMain is restored by descriptor, not deleted", t => {
        const { electron } = boot(t, { world: { electron: makeElectron({ ownOn: true }) } });
        const desc = Object.getOwnPropertyDescriptor(electron.ipcMain, "on");
        assert.equal(desc.value, EventEmitter.prototype.on);
        assert.equal(Object.getOwnPropertyDescriptor(electron.ipcMain, "addListener").value, EventEmitter.prototype.addListener);
    });

    test("the renderer is counted and the first serving tells the updater (boot marker); later ones do not", t => {
        const { electron, state } = boot(t);
        electron.ipcMain.sendSync(CH_RENDERER);
        electron.ipcMain.sendSync(CH_RENDERER);
        assert.equal(state.rendererServed, 2);
        assert.equal(globalThis.__updStub.calls.filter(c => c[0] === "markServed").length, 1);
    });

    test("a Vencord whose channel is renamed: hooks never fire, ipcMain.on stays wrapped, the loader says so", t => {
        const { state, electron, logs } = boot(t, { patcher: vencordLike({ answerRenderer: false, answerMap: false }) });
        assert.deepEqual([state.rendererHooked, state.ipcMapHooked], [false, false]);
        assert.notEqual(electron.ipcMain.on, EventEmitter.prototype.on, "not restored: the hooks may still be needed");
        assert.ok(logs.log.some(l => /Vencord IPC hooks not seen/.test(l)));
    });

    test("only one of the two channels seen: still not restored", t => {
        const { state, logs } = boot(t, { patcher: vencordLike({ answerMap: false }) });
        assert.deepEqual([state.rendererHooked, state.ipcMapHooked], [true, false]);
        assert.ok(logs.log.some(l => /Vencord IPC hooks not seen/.test(l)));
    });

    test("the stand-in event hands back what the listener just set (a listener may read event.returnValue)", t => {
        let readBack;
        const patcher = electron => {
            electron.ipcMain.on(CH_RENDERER, e => {
                e.returnValue = VENCORD_JS;
                readBack = e.returnValue;
            });
        };
        const { electron } = boot(t, { patcher });
        assert.match(electron.ipcMain.sendSync(CH_RENDERER), /__TelinhaAddonBoot/);
        assert.equal(readBack, VENCORD_JS, "the listener saw its own answer, not ours");
    });

    test("a listener that answers later (async) or never is left alone: no reply is forced", t => {
        const patcher = electron => {
            electron.ipcMain.on(CH_RENDERER, () => { });
            electron.ipcMain.on(CH_MAP, e => { setImmediate(() => { e.returnValue = {}; }); });
        };
        const { electron, state } = boot(t, { patcher });
        assert.equal(electron.ipcMain.sendSync(CH_RENDERER), undefined);
        assert.equal(electron.ipcMain.sendSync(CH_MAP), undefined);
        assert.equal(state.rendererServed, 0);
    });

    test("addListener is wrapped like on; other channels and non-function listeners are untouched", t => {
        let seen = null;
        let thrown = null;
        const patcher = electron => {
            electron.ipcMain.addListener(CH_RENDERER, e => { e.returnValue = VENCORD_JS; });
            electron.ipcMain.on("SomeOtherChannel", e => { e.returnValue = "mine"; });
            try {
                electron.ipcMain.on("Broken", 5);
            } catch (err) {
                thrown = err;
            }
            seen = true;
        };
        const { electron, state } = boot(t, { patcher });
        assert.equal(seen, true);
        assert.equal(state.rendererHooked, true);
        assert.match(electron.ipcMain.sendSync(CH_RENDERER), /__TelinhaAddonBoot/);
        assert.equal(electron.ipcMain.sendSync("SomeOtherChannel"), "mine");
        assert.equal(thrown?.code, "ERR_INVALID_ARG_TYPE", "the loader hands the bad listener to Node's own validation");
    });

    test("building the reply fails (register.js gone): logged, and Vencord's own answer goes out untouched", t => {
        const { electron, state, tree } = boot(t, { payload: { drop: ["register.js"] } });
        assert.equal(electron.ipcMain.sendSync(CH_RENDERER), VENCORD_JS);
        assert.ok(state.errors.some(e => e.startsWith("transform reply: ")));
        assert.match(tree.mainLog(), /ERROR transform reply: /);
        assert.equal(state.rendererServed, 0);
    });

    test("PluginMeta not found in Vencord's renderer: the add-on goes out anyway, the reason is in the state", t => {
        const { electron, state } = boot(t, { patcher: vencordLike({ rendererJs: "var nothing = 1;" }) });
        const js = electron.ipcMain.sendSync(CH_RENDERER);
        assert.ok(js.startsWith("var nothing = 1;"));
        assert.equal(state.metaPatched, false);
        assert.match(state.metaReason, /expected 1 PluginMeta literal, found 0/);
    });

    test("a Vencord build that already bundles the plugin: its natives win, ours stay out; our own still go in", t => {
        const { electron, state, logs } = boot(t, { patcher: vencordLike({ ipcMap: { Telinha: { listSources: "VencordsOwnChannel" } } }) });
        const map = electron.ipcMain.sendSync(CH_MAP);
        assert.deepEqual(map.Telinha, { listSources: "VencordsOwnChannel" });
        assert.ok(map.TelinhaAddon);
        assert.equal(state.vencordBundlesPlugin, true);
        electron.ipcMain.sendSync(CH_MAP);
        assert.equal(logs.log.filter(l => /already bundles Telinha; the add-on stays passive/.test(l)).length, 1, "said once");
    });

    test("a null IPC map from Vencord is treated as empty", t => {
        const { electron } = boot(t, { patcher: vencordLike({ ipcMap: null }) });
        const map = electron.ipcMain.sendSync(CH_MAP);
        assert.deepEqual(Object.keys(map).sort(), ["Telinha", "TelinhaAddon"]);
    });

    test("without a loader updater there are no loader natives: the map only gains the plugin's", t => {
        const { electron } = boot(t, { payload: { replace: { "updater.js": "throw new Error('broken updater');\n" } }, updater: false });
        const map = electron.ipcMain.sendSync(CH_MAP);
        assert.deepEqual(Object.keys(map), ["Telinha"]);
    });
});

describe("the fallback preload's info channel (TelinhaAddonPreloadInfo)", () => {
    test("answers what preload.js needs, with our renderer wrapped as 'preload-fallback', and tells the updater", t => {
        const { electron, state } = boot(t, { patcher: vencordLike({ answerRenderer: false, answerMap: false }) });
        const info = electron.ipcMain.sendSync(CH_INFO);
        assert.equal(info.pluginName, "Telinha");
        assert.equal(info.ipcMapHooked, false);
        assert.deepEqual(Object.keys(info.methods), ["listSources", "stopScreenAudio"]);
        assert.equal(info.addonHelpers, "TelinhaAddon");
        assert.deepEqual(Object.keys(info.addonMethods).sort(), ["bootOk", "updateCheck", "updateDownload", "updateStatus"]);
        assert.match(info.rendererJs, /"via":"preload-fallback"/);
        assert.match(info.rendererJs, /"metaReason":"renderer hook not active"/);
        assert.equal(globalThis.__updStub.calls.filter(c => c[0] === "markServed").length, 1);
        void state;
    });

    test("with the hooks working the info handler is still there, and reports ipcMapHooked", t => {
        const { electron } = boot(t);
        assert.equal(electron.ipcMain.sendSync(CH_INFO).ipcMapHooked, true);
    });

    test("the renderer cannot be read: logged, rendererJs is empty, the updater is not told", t => {
        const { electron, state } = boot(t, { payload: { drop: ["register.js"] }, patcher: vencordLike({ answerRenderer: false, answerMap: false }) });
        const info = electron.ipcMain.sendSync(CH_INFO);
        assert.equal(info.rendererJs, "");
        assert.ok(state.errors.some(e => e.startsWith("preload info: ")));
        assert.equal(globalThis.__updStub.calls.filter(c => c[0] === "markServed").length, 0);
    });
});

describe("IPC handlers for the natives", () => {
    const DISCORD = "https://discord.com/channels/@me";

    test("the plugin's natives are called with the IPC event and the renderer's arguments; the result goes back", async t => {
        const { electron } = boot(t);
        const out = await electron.ipcMain.invoke("TelinhaAddon_Telinha_listSources", DISCORD, 320, 180);
        assert.deepEqual(out, { sources: [], w: 320, h: 180 });
        assert.deepEqual(globalThis.__telinhaNativeCalls, [["listSources", 320, 180]]);
        assert.equal(await electron.ipcMain.invoke("TelinhaAddon_Telinha_stopScreenAudio", DISCORD), "stopped");
    });

    test("only Discord's own pages may call them (any discord.com subdomain over https)", async t => {
        const { electron } = boot(t);
        for (const ok of ["https://discord.com/app", "https://ptb.discord.com/channels/1", "https://canary.discord.com/", "https://a.b.discord.com/x", "HTTPS://DISCORD.COM/app"])
            assert.deepEqual(await electron.ipcMain.invoke("TelinhaAddon_Telinha_listSources", ok, 1, 1), { sources: [], w: 1, h: 1 }, ok);
        for (const bad of ["http://discord.com/", "https://evil.example/", "https://discord.com.evil.example/", "https://notdiscord.com/", "https://evildiscord.com/", "data:text/html,x", "file:///c:/x.html", ""])
            await assert.rejects(electron.ipcMain.invoke("TelinhaAddon_Telinha_listSources", bad, 1, 1), /Telinha add-on: refused IPC from/, JSON.stringify(bad));
    });

    test("a call with no sender frame at all is refused as 'unknown frame', for the loader's own natives too", async t => {
        const { electron } = boot(t);
        await assert.rejects(electron.ipcMain.invoke("TelinhaAddon_Telinha_listSources", undefined, 1, 1), /refused IPC from unknown frame/);
        await assert.rejects(electron.ipcMain.invoke("TelinhaAddon_TelinhaAddon_updateStatus", "https://evil.example/"), /refused IPC from https:\/\/evil\.example\//);
        assert.deepEqual(globalThis.__telinhaNativeCalls, [], "the native was never reached");
    });

    test("the loader's own natives: status, check (options sanitised), download", async t => {
        const { electron } = boot(t);
        const call = (m, ...args) => electron.ipcMain.invoke(`TelinhaAddon_TelinhaAddon_${m}`, DISCORD, ...args);
        assert.deepEqual(await call("updateStatus"), { phase: "idle" });
        assert.deepEqual(await call("updateCheck", { autoDownload: true, manual: true, extra: "ignored" }), { phase: "checked" });
        await call("updateCheck", { autoDownload: "yes", manual: 1 });
        await call("updateCheck");
        await call("updateCheck", "not an object");
        assert.deepEqual(await call("updateDownload"), { phase: "downloaded" });
        const checks = globalThis.__updStub.calls.filter(c => c[0] === "check").map(c => c[1]);
        assert.deepEqual(checks, [{ autoDownload: true, manual: true }, { autoDownload: false, manual: false }, {}, {}], "only strict `true` counts; non-objects give no options");
    });

    test("bootOk: reports healthy only when this start had no main-process problem, and records the confirmation", async t => {
        const { electron, state } = boot(t);
        const r = await electron.ipcMain.invoke("TelinhaAddon_TelinhaAddon_bootOk", DISCORD, { enabled: 1, started: 0, via: 7, extra: "x" });
        assert.deepEqual(r, { confirmed: true });
        assert.equal(state.bootConfirmed, true);
        const [, args] = globalThis.__updStub.calls.find(c => c[0] === "confirmBoot");
        assert.deepEqual(args, { healthy: true, problems: [], info: { enabled: true, started: false, via: "7" } });
    });

    test("bootOk with no info, or info that is not an object: info is null", async t => {
        const { electron } = boot(t);
        for (const info of [undefined, null, "text", 5]) {
            await electron.ipcMain.invoke("TelinhaAddon_TelinhaAddon_bootOk", DISCORD, info);
            const last = globalThis.__updStub.calls.filter(c => c[0] === "confirmBoot").at(-1)[1];
            assert.equal(last.info, null, String(info));
        }
        await electron.ipcMain.invoke("TelinhaAddon_TelinhaAddon_bootOk", DISCORD, { enabled: true, started: true });
        assert.equal(globalThis.__updStub.calls.filter(c => c[0] === "confirmBoot").at(-1)[1].info.via, "");
    });

    test("bootOk lists what went wrong in this start (Vencord / natives not loaded, recorded errors) and is not healthy", async t => {
        const { electron, state } = boot(t, {
            payload: { replace: { "telinha.main.js": "throw new Error('natives are down\\nsecond line');\n" } },
            patcher: () => { throw Object.assign(new Error("vencord is down"), {}); }
        });
        const r = await electron.ipcMain.invoke("TelinhaAddon_TelinhaAddon_bootOk", DISCORD, { enabled: true, started: true, via: "register" }).catch(e => e);
        const args = globalThis.__updStub?.calls.find(c => c[0] === "confirmBoot")?.[1];
        assert.deepEqual(r, { confirmed: false });
        assert.equal(state.bootConfirmed, false);
        assert.equal(args.healthy, false);
        assert.ok(args.problems.includes("Vencord not loaded"));
        assert.ok(args.problems.includes("plugin natives not loaded"));
        assert.ok(args.problems.some(p => /^natives: Error: natives are down$/.test(p)), "each recorded error appears by its first line only");
    });
});

describe("the CSP chain (Vencord's listener first, then ours)", () => {
    const wr = electron => electron.session.defaultSession.webRequest;

    test("chained inside Vencord's listener: relays from addon.json are added to the main frame's CSP; Vencord's rewrite is kept", async t => {
        const seen = [];
        const { electron, state, logs } = boot(t, { patcher: vencordLike({ onCsp: d => seen.push(d.url) }) });
        await ready(electron);
        assert.equal(state.cspMode, "chained");
        assert.equal(wr(electron).installs, 1, "one listener (Electron keeps a single one)");
        const out = await respond(wr(electron), { resourceType: "mainFrame", url: "https://discord.com/app", responseHeaders: csp("default-src 'self'", "connect-src 'self' https://discord.com") });
        assert.deepEqual(connectSrc(out), ["'self'", "https://discord.com", "wss://relay.example"]);
        assert.deepEqual(seen, ["https://discord.com/app"], "Vencord's own listener ran");
        assert.equal(state.cspApplied, 1);
        assert.ok(logs.log.some(l => /CSP: added 1 sources \(chained\)/.test(l)));
        await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: csp("default-src 'self'") });
        assert.equal(logs.log.filter(l => /CSP: added/.test(l)).length, 1, "logged once");
        assert.equal(state.cspApplied, 2);
    });

    test("sub-resources, and frames without a CSP header or without headers, are left alone", async t => {
        const { electron, state } = boot(t);
        await ready(electron);
        const sub = await respond(wr(electron), { resourceType: "stylesheet", responseHeaders: csp("default-src 'self'") });
        assert.deepEqual(sub.responseHeaders, csp("default-src 'self'"));
        const none = await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: { "content-type": ["text/html"] } });
        assert.deepEqual(none.responseHeaders, { "content-type": ["text/html"] });
        const bare = await respond(wr(electron), { resourceType: "mainFrame" });
        assert.equal(bare.responseHeaders, undefined);
        assert.equal(state.cspApplied, 0);
    });

    test("sources the plugin's native module added at load (globalThis.__TelinhaAddonCsp) join the manifest's", async t => {
        const { electron } = boot(t);
        globalThis.__TelinhaAddonCsp = { "wss://late.example": ["connect-src"], "https://img.example": ["img-src"] };
        await ready(electron);
        const out = await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: csp("default-src 'self'") });
        assert.deepEqual(connectSrc(out), ["'self'", "wss://relay.example", "wss://late.example"]);
        assert.match(out.responseHeaders["content-security-policy"][0], /img-src 'self' https:\/\/img\.example/);
    });

    test("no sources in addon.json but some added by the natives at load (what native.ts's CspPolicies becomes): the chain is installed", async t => {
        const natives = `${FAKE_NATIVES}\nglobalThis.__TelinhaAddonCsp = { "wss://native.example": ["connect-src"] };\n`;
        const { electron, state } = boot(t, { payload: { manifest: { csp: undefined }, replace: { "telinha.main.js": natives } } });
        await ready(electron);
        const out = await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: csp("default-src 'self'") });
        assert.deepEqual(connectSrc(out), ["'self'", "wss://native.example"]);
        assert.equal(state.cspMode, "chained");
    });

    test("no sources at all (no manifest csp, nothing from natives): the CSP is not touched and electron is not even asked", async t => {
        const electron = makeElectron();
        let asked = 0;
        const whenReady = electron.app.whenReady;
        electron.app.whenReady = () => (asked++, whenReady());
        const { state } = boot(t, { payload: { manifest: { csp: undefined } }, world: { electron }, patcher: vencordLike({ installCsp: false }) });
        await ready(electron);
        assert.equal(asked, 0);
        assert.equal(state.cspMode, null);
        assert.equal(electron.session.defaultSession.webRequest.installs, 0);
    });

    test("Vencord's listener answering with no response object (callback()) still gets our sources", async t => {
        const patcher = electron => {
            electron.app.whenReady().then(() => electron.session.defaultSession.webRequest.onHeadersReceived((details, cb) => cb()));
        };
        const { electron } = boot(t, { patcher });
        await ready(electron);
        const out = await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: csp("default-src 'self'") });
        assert.deepEqual(connectSrc(out), ["'self'", "wss://relay.example"]);
        assert.equal(out.cancel, false);
    });

    test("a failure while rewriting one response is logged once; the response still goes out as Vencord made it", async t => {
        const { electron, state } = boot(t);
        await ready(electron);
        const headers = {};
        Object.defineProperty(headers, "content-security-policy", { enumerable: true, get() { throw new Error("headers exploded"); } });
        const out1 = await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: headers });
        const out2 = await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: headers });
        assert.equal(out1.cancel, false);
        assert.equal(out2.responseHeaders, headers);
        assert.equal(state.errors.filter(e => e.startsWith("csp response: ")).length, 1, "not repeated for every request");
    });

    test("Vencord installs no listener: after one macrotask the loader installs its own ('standalone')", async t => {
        const { electron, state, logs } = boot(t, { patcher: vencordLike({ installCsp: false }) });
        await ready(electron);
        assert.equal(state.cspMode, "standalone");
        assert.ok(logs.log.some(l => /Vencord did not install a CSP listener; installed our own/.test(l)));
        const out = await respond(wr(electron), { resourceType: "mainFrame", responseHeaders: csp("default-src 'self'") });
        assert.deepEqual(connectSrc(out), ["'self'", "wss://relay.example"]);
        const sub = await respond(wr(electron), { resourceType: "image", responseHeaders: {} });
        assert.deepEqual(sub.responseHeaders, {});
    });

    test("...but not when Vencord itself failed to load (vanilla Discord: no CSP of ours)", async t => {
        const { electron, state } = boot(t, { patcher: () => { throw new Error("vencord is down"); } });
        await ready(electron);
        assert.equal(state.vencordLoaded, false);
        assert.equal(state.cspMode, null);
        assert.equal(electron.session.defaultSession.webRequest.installs, 0);
    });

    test("a call that clears the listener (no function among the arguments) passes straight through", async t => {
        const patcher = electron => {
            electron.app.whenReady().then(() => electron.session.defaultSession.webRequest.onHeadersReceived(null));
        };
        const { electron, state } = boot(t, { patcher });
        await ready(electron);
        assert.equal(state.cspMode, "standalone", "nothing chained, so the standalone listener took over");
    });

    test("electron not ready / session unavailable: logged as a 'csp' failure, never thrown", async t => {
        const electron = makeElectron();
        Object.defineProperty(electron.session, "defaultSession", { get() { throw new Error("Session can only be received when app is ready"); } });
        const { state } = boot(t, { world: { electron }, patcher: vencordLike({ installCsp: false }) });
        await ready(electron);
        assert.ok(state.errors.some(e => /^csp: .*Session can only be received/.test(e)));
    });

    test("whenReady() rejecting is a 'csp' failure too", async t => {
        const { electron, state } = boot(t, { patcher: vencordLike({ installCsp: false }) });
        electron.app.failReady(new Error("app never started"));
        await tick();
        await tick();
        assert.ok(state.errors.some(e => /^csp: .*app never started/.test(e)));
    });
});

describe("the dormant BrowserWindow fallback", () => {
    const makeWindow = (electron, req, options) => new (req("electron").BrowserWindow)(options);

    test("takes over the window's preload only when Vencord's renderer hook never fired", t => {
        const { electron, state, req, logs, tree } = boot(t, { patcher: vencordLike({ answerRenderer: false }) });
        assert.equal(state.vencordLoaded, true);
        const win = makeWindow(electron, req, { title: "Discord", webPreferences: { preload: "C:/vencord/preload.js" } });
        assert.equal(win.options.webPreferences.preload, join(tree.addonDir, "preload.js"), "the loader's own preload.js");
        assert.equal(process.env.TELINHA_VENCORD_PRELOAD, "C:/vencord/preload.js", "Vencord's preload is chained by ours");
        assert.equal(state.preloadFallback, true);
        makeWindow(electron, req, { title: "Second", webPreferences: { preload: "C:/vencord/preload.js" } });
        assert.equal(logs.log.filter(l => /preload fallback active/.test(l)).length, 1, "logged once");
    });

    test("stays dormant with working hooks; the class still behaves like Electron's BrowserWindow", t => {
        const { electron, state, req } = boot(t);
        const Win = req("electron").BrowserWindow;
        assert.equal(Win.name, "BrowserWindow");
        assert.notEqual(Win, electron.BrowserWindow);
        assert.ok(Win.prototype instanceof electron.BrowserWindow);
        const win = new Win({ title: "Discord", webPreferences: { preload: "C:/vencord/preload.js" } });
        assert.equal(win.options.webPreferences.preload, "C:/vencord/preload.js");
        assert.equal(state.preloadFallback, false);
        assert.ok(electron.BrowserWindow.instances.includes(win));
    });

    test("windows that are not Discord's main one are never touched (no preload, no title, no options)", t => {
        const { electron, state, req } = boot(t, { patcher: vencordLike({ answerRenderer: false }) });
        makeWindow(electron, req, { title: "x", webPreferences: {} });
        makeWindow(electron, req, { webPreferences: { preload: "C:/p.js" } });
        makeWindow(electron, req, { title: "x" });
        makeWindow(electron, req, undefined);
        assert.equal(state.preloadFallback, false);
        assert.equal(process.env.TELINHA_VENCORD_PRELOAD, undefined);
    });

    test("not while Vencord has not loaded (vanilla fallback): the window is passed through", t => {
        const { electron, state, req } = boot(t, { patcher: () => { throw new Error("vencord is down"); } });
        assert.equal(state.vencordLoaded, false);
        const win = makeWindow(electron, req, { title: "Discord", webPreferences: { preload: "C:/discord/preload.js" } });
        assert.equal(win.options.webPreferences.preload, "C:/discord/preload.js");
    });

    test("manifest.preloadFallback = false: no BrowserWindow subclass at all", t => {
        const { electron, req } = boot(t, { payload: { manifest: { preloadFallback: false } }, patcher: vencordLike({ answerRenderer: false }) });
        assert.equal(req("electron"), electron, "require.cache still holds the original exports");
    });

    test("electron missing in this process: hooks, natives and fallback each fail on their own, Vencord still loads", t => {
        const { state } = boot(t, { world: { electron: null }, patcher: null });
        assert.equal(state.vencordLoaded, true);
        for (const where of ["ipc hooks", "natives ipc", "addon ipc", "csp", "preload fallback"]) assert.ok(state.errors.some(e => e.startsWith(`${where}: `)), where);
    });
});
