/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Fixtures for the in-process unit tests of addon/loader/main.js (addon/test/main.*.test.mjs). Not a test file itself.
 *
 * main.js is a CommonJS module that reads its own folder (addon.json, version.json, register.js...), writes a log next to
 * it and requires `electron`. To run it in this process:
 *   - a fake %APPDATA%\Telinha\addon tree under the OS temp dir holds BYTE-IDENTICAL copies of the loader files (that is
 *     what lets scripts/coverage.mjs map their coverage back onto addon/loader/) plus small fake plugin files;
 *   - `<root>/node_modules/electron/index.js` is a real file resolved by the loader's own require("electron") and
 *     re-exporting whichever fake `electron` the test put on globalThis (so require.resolve / require.cache work as
 *     in Electron, which installPreloadFallback relies on);
 *   - process.mainModule is faked (require.main inside the loader), console and process.once are muted/recorded.
 * Nothing here touches the real Discord, %APPDATA% or the network.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeHome, makePayload } from "./update-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOADER_DIR = join(HERE, "..", "..", "loader");
const nodeRequire = createRequire(import.meta.url);

export const realLoaderFile = name => readFileSync(join(LOADER_DIR, name));

export const DEFAULT_MANIFEST = {
    pluginName: "Telinha", renderer: "telinha.renderer.js", main: "telinha.main.js", helperDirEnv: "TELINHA_TEST_HELPER_DIR",
    csp: { "wss://relay.example": ["connect-src"] }, meta: { folderName: "telinha-addon", userPlugin: true }
};

/** The plugin's natives module (telinha.main.js): the functions the renderer calls over IPC. */
export const FAKE_NATIVES = `"use strict";
const calls = globalThis.__telinhaNativeCalls ??= [];
module.exports = {
    listSources: (_event, w, h) => { calls.push(["listSources", w, h]); return { sources: [], w, h }; },
    stopScreenAudio: () => "stopped",
    notAFunction: 42
};
`;

/**
 * A stand-in updater.js (replace it in loaderPayload) that records what main.js asks of it. Behaviour is steered through
 * globalThis.__updStub: { startup, startupThrows, createThrows, rollback, confirm } and read back from { created, calls }.
 */
export const STUB_UPDATER = `"use strict";
const stub = globalThis.__updStub ??= {};
exports.createUpdater = opts => {
    (stub.created ??= []).push(opts);
    if (stub.createThrows) throw stub.createThrows;
    const calls = stub.calls ??= [];
    return {
        startup: a => { calls.push(["startup", a]); if (stub.startupThrows) throw stub.startupThrows; return stub.startup ?? null; },
        rollbackNow: r => { calls.push(["rollbackNow", r]); return stub.rollback ?? null; },
        markServed: () => { calls.push(["markServed"]); },
        confirmBoot: a => { calls.push(["confirmBoot", a]); return stub.confirm ?? { confirmed: !!(a && a.healthy) }; },
        status: () => { calls.push(["status"]); return { phase: "idle" }; },
        check: o => { calls.push(["check", o]); return Promise.resolve({ phase: "checked" }); },
        download: () => { calls.push(["download"]); return Promise.resolve({ phase: "downloaded" }); }
    };
};
`;

/**
 * A payload that is a complete, loadable add-on: the real loader files (except where replaced) + fake plugin files.
 *   replace: { "updater.js": "...", "main.js": "...", "telinha.main.js": "..." }   extra: more files   drop: names to omit
 */
export function loaderPayload({ version = "0.1.0", commit = "base0100", manifest = {}, replace = {}, extra = {}, drop = [] } = {}) {
    const m = { ...DEFAULT_MANIFEST, ...manifest };
    for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
    const files = {
        "main.js": realLoaderFile("main.js"), "stub-template.js": realLoaderFile("stub-template.js"), "addon.json": JSON.stringify(m),
        "payload.js": realLoaderFile("payload.js"), "updater.js": realLoaderFile("updater.js"), "register.js": realLoaderFile("register.js"),
        "preload.js": realLoaderFile("preload.js"), "telinha.renderer.js": "globalThis.__telinhaRenderer = 1;\n", "telinha.main.js": FAKE_NATIVES,
        ...replace, ...extra
    };
    return makePayload({ version, commit, drop, extra: files });
}

/**
 * A scratch folder for loader trees that is emptied when the test FILE starts (not when it ends). scripts/coverage.mjs
 * maps the coverage of a loader copy back onto addon/loader/ only if the copy still exists when the report is made, so
 * these trees stay after the run, like the ones of the scenario scripts under %TEMP%\tl-addon. The name carries a hash of
 * the repo path so two worktrees running the tests at once never share a folder.
 */
export function loaderScratch(name) {
    const id = createHash("sha1").update(LOADER_DIR).digest("hex").slice(0, 6);
    const dir = join(tmpdir(), "tl-addon", `unit-${name}-${id}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * A fake add-on home: addon\ (a loadable add-on), optional addon.new / addon.prev / state, plus node_modules/electron and a
 * fake Vencord. With `base` (see loaderScratch) the tree is kept after the test; without it, cleanup() removes it.
 */
export function makeLoaderTree({ installed = loaderPayload(), staged = null, prev = null, state = null, record = true, base = null } = {}) {
    const home = makeHome({ installed, staged, prev, state, record, root: base ? mkdtempSync(join(base, "t-")) : undefined });
    if (base) home.cleanup = () => { };
    const electronDir = join(home.root, "node_modules", "electron");
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(join(electronDir, "index.js"), "module.exports = globalThis.__telinhaTestElectron;\n");
    const patcher = join(home.root, "Vencord", "dist", "patcher.js");
    mkdirSync(dirname(patcher), { recursive: true });
    writeFileSync(patcher, "const run = globalThis.__telinhaTestPatcher;\nmodule.exports = {};\nif (run) run(require(\"electron\"));\n");
    return {
        ...home, patcher, mainPath: join(home.addonDir, "main.js"), logFile: join(home.home, "logs", "main.log"),
        mainLog: () => { try { return readFileSync(join(home.home, "logs", "main.log"), "utf8"); } catch { return ""; } },
        /** require() of this tree's main.js, with this tree's own module cache entries */
        load: () => nodeRequire(join(home.addonDir, "main.js"))
    };
}

// ------------------------------------------------------------------------------------------- fake electron

/** A one-listener webRequest, like Electron's: a later onHeadersReceived call replaces the earlier listener. */
function makeWebRequest() {
    const wr = {
        listener: null, installs: 0,
        onHeadersReceived(...args) {
            wr.listener = args.find(a => typeof a === "function") ?? null;
            wr.installs++;
        }
    };
    return wr;
}

/**
 * The parts of electron's main-process API that the loader and a Vencord look-alike touch.
 *   ipcMain.sendSync(channel, frameUrl, ...args)  -> what ipcRenderer.sendSync does (event.returnValue)
 *   ipcMain.invoke(channel, frameUrl, ...args)    -> what ipcRenderer.invoke does
 *   app.becomeReady() / app.failReady(err)        -> resolves / rejects app.whenReady()
 *   ownOn: true gives ipcMain its OWN `on` / `addListener` properties (so the loader restores descriptors, not deletes)
 */
export function makeElectron({ ownOn = false, withNet = true } = {}) {
    const ipcMain = new EventEmitter();
    ipcMain.handlers = new Map();
    ipcMain.handle = (channel, fn) => {
        if (ipcMain.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        ipcMain.handlers.set(channel, fn);
    };
    ipcMain.sendSync = (channel, frameUrl = "https://discord.com/app", ...args) => {
        let reply;
        let replied = false;
        const event = { senderFrame: { url: frameUrl } };
        Object.defineProperty(event, "returnValue", { set: v => { replied = true; reply = v; }, get: () => reply, configurable: true });
        ipcMain.emit(channel, event, ...args);
        return replied ? reply : undefined;
    };
    ipcMain.invoke = async (channel, frameUrl, ...args) => {
        const handler = ipcMain.handlers.get(channel);
        if (!handler) throw new Error(`No handler registered for '${channel}'`);
        return handler({ senderFrame: frameUrl === undefined ? undefined : { url: frameUrl } }, ...args);
    };
    if (ownOn) {
        const { on, addListener } = EventEmitter.prototype;
        Object.defineProperty(ipcMain, "on", { value: on, writable: true, configurable: true });
        Object.defineProperty(ipcMain, "addListener", { value: addListener, writable: true, configurable: true });
    }

    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    readyPromise.catch(() => { }); // a test may reject it before anyone listens
    const app = { whenReady: () => readyPromise, becomeReady: () => resolveReady(), failReady: err => rejectReady(err) };

    const webRequest = makeWebRequest();
    const session = { defaultSession: { webRequest } };

    class BrowserWindow {
        constructor(options) {
            this.options = options;
            BrowserWindow.instances.push(this);
        }
        static getAllWindows() { return BrowserWindow.instances; }
    }
    BrowserWindow.instances = [];
    BrowserWindow.marker = "electron-base";

    const electron = { ipcMain, app, session, BrowserWindow };
    if (withNet) {
        electron.net = { requests: [], fetch: async (url, init) => (electron.net.requests.push([String(url), init]), electron.net.answer?.(String(url), init) ?? new Response("{}", { status: 404 })) };
    }
    return electron;
}

/** What Vencord's patcher.js does to the pieces our loader hooks (src/main/ipcMain.ts, ipcPlugins.ts, csp/index.ts). */
export function vencordLike({ rendererJs = "var Vencord={};//vencord", ipcMap = {}, installCsp = true, onCsp = null, answerRenderer = true, answerMap = true } = {}) {
    return electron => {
        const { ipcMain, app, session } = electron;
        if (answerRenderer) ipcMain.on("VencordPreloadGetRendererJs", e => { e.returnValue = rendererJs; });
        if (answerMap) ipcMain.on("VencordGetPluginIpcMethodMap", e => { e.returnValue = ipcMap; });
        if (installCsp) {
            app.whenReady().then(() => {
                const wr = session.defaultSession.webRequest;
                wr.onHeadersReceived((details, callback) => {
                    onCsp?.(details);
                    callback({ cancel: false, responseHeaders: details.responseHeaders });
                });
                wr.onHeadersReceived = () => { }; // Vencord leaves a noop behind so nobody else replaces its listener
            });
        }
    };
}

// ------------------------------------------------------------------------------------------- the world around the loader

/**
 * Prepares process-wide state for one in-process loader run and puts everything back when the test ends:
 * the fake electron, process.mainModule, console, process.once, the globals the loader writes.
 */
export function useWorld(t, { electron = makeElectron(), patcher = null, stubFilename = join("C:", "Discord", "resources", "app.asar", "index.js"), argv = [] } = {}) {
    const logs = { log: [], error: [], warn: [] };
    for (const level of ["log", "error", "warn"]) t.mock.method(console, level, (...args) => { logs[level].push(args.map(a => (typeof a === "string" ? a : a?.stack ?? JSON.stringify(a))).join(" ")); });
    const onceCalls = [];
    t.mock.method(process, "once", (ev, fn) => (onceCalls.push([ev, fn]), process));

    const saved = {
        electron: globalThis.__telinhaTestElectron, patcher: globalThis.__telinhaTestPatcher, mainModule: process.mainModule, argv: process.argv.slice(),
        addon: globalThis.__TelinhaAddon, csp: globalThis.__TelinhaAddonCsp, marker: globalThis.__TelinhaRunMarker,
        env: { TELINHA_UPDATE_API: process.env.TELINHA_UPDATE_API, TELINHA_TEST_HELPER_DIR: process.env.TELINHA_TEST_HELPER_DIR, TELINHA_VENCORD_PRELOAD: process.env.TELINHA_VENCORD_PRELOAD }
    };
    globalThis.__telinhaTestElectron = electron;
    globalThis.__telinhaTestPatcher = patcher;
    process.mainModule = { filename: stubFilename };
    process.argv.push(...argv);
    delete globalThis.__TelinhaAddon;
    delete globalThis.__TelinhaAddonCsp;
    delete globalThis.__TelinhaRunMarker;
    delete globalThis.__updStub;
    delete process.env.TELINHA_UPDATE_API;
    delete process.env.TELINHA_VENCORD_PRELOAD;
    t.after(() => {
        const marker = globalThis.__TelinhaRunMarker;
        if (marker) clearInterval(marker.timer);
        const restore = (obj, key, value) => (value === undefined ? delete obj[key] : (obj[key] = value));
        restore(globalThis, "__telinhaTestElectron", saved.electron);
        restore(globalThis, "__telinhaTestPatcher", saved.patcher);
        restore(globalThis, "__TelinhaAddon", saved.addon);
        restore(globalThis, "__TelinhaAddonCsp", saved.csp);
        restore(globalThis, "__TelinhaRunMarker", saved.marker);
        restore(process, "mainModule", saved.mainModule);
        for (const [k, v] of Object.entries(saved.env)) restore(process.env, k, v);
        delete globalThis.__telinhaNativeCalls;
        delete globalThis.__handedTo;
        delete globalThis.__updStub;
        process.argv.length = 0;
        process.argv.push(...saved.argv);
    });
    return { electron, logs, onceCalls, mainModule: process.mainModule, setPatcher: fn => { globalThis.__telinhaTestPatcher = fn; } };
}
