/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of addon/loader/preload.js, the FALLBACK preload (used only when Vencord's renderer IPC hook did not fire).
 *
 *   node --test addon/test/preload.test.mjs        (also run by `pnpm test:addon`)
 *
 * preload.js is a script Electron runs in the renderer's preload context (`require("electron/renderer")`, `location`,
 * `process.env`). Here it runs in a node:vm context with fakes for those, compiled from the exact file bytes under the
 * file's own URL (so coverage maps onto addon/loader/preload.js). run-main-test.mjs S2 runs it end to end with the real
 * Vencord preload through the fake electron.
 *
 * What needs a real Electron: that contextBridge really exposes the wrapped objects to the page and that
 * webFrame.executeJavaScript runs in order with Discord's own scripts (the fake only records the calls).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "loader", "preload.js");
const SOURCE = readFileSync(FILE, "utf8");

/**
 * Runs the preload once. `info` is what main answers to TelinhaAddonPreloadInfo (or an Error to throw, or null for
 * "no answer"). Returns what the fakes saw.
 */
function runPreload({ info = null, protocol = "https:", env = {}, exposeThrows = false, vencordPreloadModule = null } = {}) {
    const calls = { sendSync: [], invoke: [], executed: [], exposed: [], required: [], errors: [] };
    const fakeElectron = {
        contextBridge: {
            // the real one is a method on an object: the preload replaces it, so `this` and the original matter
            exposeInMainWorld(key, value) {
                if (exposeThrows && key === "TelinhaNative") throw new Error("cannot expose");
                calls.exposed.push([key, value]);
            }
        },
        ipcRenderer: {
            sendSync: channel => {
                calls.sendSync.push(channel);
                if (info instanceof Error) throw info;
                return info;
            },
            invoke: (channel, ...args) => (calls.invoke.push([channel, ...args]), Promise.resolve(`reply:${channel}`))
        },
        webFrame: { executeJavaScript: code => calls.executed.push(code) }
    };
    const sandbox = {
        require: id => {
            calls.required.push(id);
            if (id === "electron/renderer") return fakeElectron;
            if (vencordPreloadModule && id === env.TELINHA_VENCORD_PRELOAD) return vencordPreloadModule();
            throw new Error(`unexpected require(${id})`);
        },
        location: { protocol },
        process: { env },
        console: { error: (...a) => calls.errors.push(a) }
    };
    const context = vm.createContext(sandbox);
    new vm.Script(SOURCE, { filename: pathToFileURL(FILE).href }).runInContext(context);
    return { calls, electron: fakeElectron };
}

const INFO = {
    pluginName: "Telinha", methods: { listSources: "Ch_listSources", stopScreenAudio: "Ch_stop" }, ipcMapHooked: false,
    rendererJs: "/* renderer */", addonHelpers: "TelinhaAddon", addonMethods: { updateStatus: "Ch_updateStatus", bootOk: "Ch_bootOk" }
};

describe("preload.js: asking main what to expose", () => {
    test("asks main once over sendSync with the loader's channel name", () => {
        const { calls } = runPreload({ info: INFO });
        assert.deepEqual(calls.sendSync, ["TelinhaAddonPreloadInfo"]);
    });

    test("a data: page (Discord's about:blank-style frames) is not asked: no info, nothing exposed or executed", () => {
        const { calls } = runPreload({ info: INFO, protocol: "data:" });
        assert.deepEqual(calls.sendSync, []);
        assert.deepEqual(calls.exposed, []);
        assert.deepEqual(calls.executed, []);
    });

    test("main unreachable: logged, and the preload then does nothing (Vencord's preload still chains)", () => {
        const { calls } = runPreload({ info: new Error("no main"), env: { TELINHA_VENCORD_PRELOAD: "C:/v/preload.js" }, vencordPreloadModule: () => ({}) });
        assert.equal(calls.errors.length, 1);
        assert.match(calls.errors[0][0], /^\[Telinha\] addon: fallback preload could not reach main/);
        assert.deepEqual(calls.exposed, []);
        assert.deepEqual(calls.executed, []);
        assert.deepEqual(calls.required, ["electron/renderer", "C:/v/preload.js"]);
    });

    test("main answering nothing (null): same quiet outcome", () => {
        const { calls } = runPreload({ info: null });
        assert.deepEqual(calls.errors, []);
        assert.deepEqual(calls.exposed, []);
    });
});

describe("preload.js: chaining Vencord's preload", () => {
    test("requires Vencord's preload (path from TELINHA_VENCORD_PRELOAD) when main swapped ours in", () => {
        let ran = false;
        const { calls } = runPreload({ info: INFO, env: { TELINHA_VENCORD_PRELOAD: "C:/v/preload.js" }, vencordPreloadModule: () => { ran = true; return {}; } });
        assert.equal(ran, true);
        assert.deepEqual(calls.required, ["electron/renderer", "C:/v/preload.js"]);
    });

    test("no TELINHA_VENCORD_PRELOAD: nothing to chain", () => {
        const { calls } = runPreload({ info: INFO });
        assert.deepEqual(calls.required, ["electron/renderer"]);
    });

});

describe("preload.js: the natives when the IPC-map hook did not fire", () => {
    /**
     * Runs the preload with a Vencord preload that does what the real one does through the (maybe wrapped) bridge:
     * exposeInMainWorld("VencordNative", { pluginHelpers }) and some other exposure.
     */
    function play(info, pluginHelpers = {}, { nativeValue } = {}) {
        const vencordNative = nativeValue ?? { pluginHelpers };
        const exposed = [];
        const calls = { invoke: [], executed: [], errors: [] };
        const contextBridge = {
            exposeInMainWorld(key, value) {
                exposed.push({ key, value, self: this });
            }
        };
        const originalExpose = contextBridge.exposeInMainWorld;
        const electron = {
            contextBridge,
            ipcRenderer: { sendSync: () => info, invoke: (channel, ...args) => (calls.invoke.push([channel, ...args]), Promise.resolve(`reply:${channel}`)) },
            webFrame: { executeJavaScript: code => calls.executed.push(code) }
        };
        const sandbox = {
            require: id => {
                if (id === "electron/renderer") return electron;
                if (id === "V") {
                    contextBridge.exposeInMainWorld("VencordNative", vencordNative);
                    contextBridge.exposeInMainWorld("Other", { x: 1 });
                    return {};
                }
                throw new Error(`unexpected require(${id})`);
            },
            location: { protocol: "https:" },
            process: { env: { TELINHA_VENCORD_PRELOAD: "V" } },
            console: { error: (...a) => calls.errors.push(a) }
        };
        new vm.Script(SOURCE, { filename: pathToFileURL(FILE).href }).runInContext(vm.createContext(sandbox));
        return { exposed, vencordNative, calls, contextBridge, originalExpose };
    }

    test("adds the plugin's natives and the loader's own to VencordNative.pluginHelpers, as invokers of the channels", async () => {
        const { vencordNative, calls, exposed } = play(INFO);
        const helpers = vencordNative.pluginHelpers;
        assert.deepEqual(Object.keys(helpers).sort(), ["Telinha", "TelinhaAddon"]);
        assert.deepEqual(Object.keys(helpers.Telinha), ["listSources", "stopScreenAudio"]);
        assert.deepEqual(Object.keys(helpers.TelinhaAddon), ["updateStatus", "bootOk"]);
        assert.equal(await helpers.Telinha.listSources(320, 180), "reply:Ch_listSources");
        assert.equal(await helpers.TelinhaAddon.bootOk({ enabled: true }), "reply:Ch_bootOk");
        assert.deepEqual(calls.invoke, [["Ch_listSources", 320, 180], ["Ch_bootOk", { enabled: true }]]);
        const vencordExposure = exposed.find(e => e.key === "VencordNative");
        assert.equal(vencordExposure.value, vencordNative, "the same object Vencord built, extended in place");
    });

    test("other exposures pass through unchanged, with the original `this`", () => {
        const { exposed, contextBridge } = play(INFO);
        const other = exposed.find(e => e.key === "Other");
        assert.deepEqual(other.value, { x: 1 });
        assert.equal(other.self, contextBridge);
    });

    test("never replaces natives Vencord (or a bundled copy of the plugin) already provides", () => {
        const mine = { listSources: () => "bundled" };
        const addon = { updateStatus: () => "bundled-addon" };
        const { vencordNative } = play(INFO, { Telinha: mine, TelinhaAddon: addon });
        assert.equal(vencordNative.pluginHelpers.Telinha, mine);
        assert.equal(vencordNative.pluginHelpers.TelinhaAddon, addon);
    });

    test("only the loader's natives available (the plugin's natives failed to load): just those are added", () => {
        const { vencordNative } = play({ ...INFO, methods: {} });
        assert.deepEqual(Object.keys(vencordNative.pluginHelpers), ["TelinhaAddon"]);
    });

    test("only the plugin's natives (loader natives off): just those are added", () => {
        const { vencordNative } = play({ ...INFO, addonMethods: {} });
        assert.deepEqual(Object.keys(vencordNative.pluginHelpers), ["Telinha"]);
    });

    test("no addonHelpers name in the info: the loader's natives are not added", () => {
        const { vencordNative } = play({ ...INFO, addonHelpers: undefined });
        assert.deepEqual(Object.keys(vencordNative.pluginHelpers), ["Telinha"]);
    });

    test("a VencordNative without pluginHelpers is left alone", () => {
        const { vencordNative } = play(INFO, undefined, { nativeValue: { other: 1 } });
        assert.deepEqual(vencordNative, { other: 1 });
    });

    test("the IPC-map hook DID fire (ipcMapHooked): Vencord's own map has our natives, the bridge is not wrapped", () => {
        const { vencordNative, contextBridge, originalExpose } = play({ ...INFO, ipcMapHooked: true });
        assert.deepEqual(vencordNative.pluginHelpers, {});
        assert.equal(contextBridge.exposeInMainWorld, originalExpose);
    });

    test("nothing to add (no plugin natives and no loader natives): the bridge is not wrapped", () => {
        const { vencordNative, contextBridge, originalExpose } = play({ ...INFO, methods: {}, addonMethods: {} });
        assert.deepEqual(vencordNative.pluginHelpers, {});
        assert.equal(contextBridge.exposeInMainWorld, originalExpose);
    });

    test("when it does add natives the bridge is wrapped (so Vencord's own exposure is the one extended)", () => {
        const { contextBridge, originalExpose } = play(INFO);
        assert.notEqual(contextBridge.exposeInMainWorld, originalExpose);
    });

    test("main answering without method tables at all: treated as empty", () => {
        const { vencordNative } = play({ pluginName: "Telinha", ipcMapHooked: false, rendererJs: "" });
        assert.deepEqual(vencordNative.pluginHelpers, {});
    });
});

describe("preload.js: window.TelinhaNative and our renderer", () => {
    test("exposes TelinhaNative (the plugin's invokers) and queues our renderer after Vencord's", async () => {
        const { calls } = runPreload({ info: INFO });
        const native = calls.exposed.find(([key]) => key === "TelinhaNative");
        assert.deepEqual(Object.keys(native[1]), ["listSources", "stopScreenAudio"]);
        assert.equal(await native[1].listSources(1, 2), "reply:Ch_listSources");
        assert.deepEqual(calls.executed, ["/* renderer */"]);
        assert.deepEqual(calls.invoke, [["Ch_listSources", 1, 2]]);
    });

    test("no renderer JS in the answer (renderer could not be built): nothing is executed", () => {
        const { calls } = runPreload({ info: { ...INFO, rendererJs: "" } });
        assert.deepEqual(calls.executed, []);
        assert.ok(calls.exposed.some(([key]) => key === "TelinhaNative"));
    });

    test("exposure failing (e.g. a frame that cannot be bridged): logged, our renderer is not run", () => {
        const { calls } = runPreload({ info: INFO, exposeThrows: true });
        assert.equal(calls.errors.length, 1);
        assert.match(calls.errors[0][0], /^\[Telinha\] addon: fallback preload failed/);
        assert.deepEqual(calls.executed, []);
    });

    test("main answered but with no natives: TelinhaNative is exposed as an empty object", () => {
        const { calls } = runPreload({ info: { pluginName: "Telinha", ipcMapHooked: true, rendererJs: "x" } });
        assert.deepEqual(Object.keys(calls.exposed.find(([key]) => key === "TelinhaNative")[1]), []);
        assert.deepEqual(calls.executed, ["x"]);
    });
});
