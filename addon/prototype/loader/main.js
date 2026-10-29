/*
 * PeerLive addon prototype - main-process loader.
 *
 * Required by our resources/app.asar stub, BEFORE the official Vencord patcher.js. Everything here only
 * prepares hooks; Vencord and Discord then load exactly as with Vencord's own stub:
 *
 *   1. ipcMain.on wrapper (removed once both hooks fired):
 *      - "VencordPreloadGetRendererJs"  -> Vencord's renderer (+ PluginMeta entry) + our renderer appended
 *      - "VencordGetPluginIpcMethodMap" -> Vencord's map + our natives, so the renderer gets
 *                                          VencordNative.pluginHelpers.<plugin>.<method>() for free
 *   2. ipcMain.handle for our natives (own channel prefix, so no clash with Vencord's handlers)
 *   3. CSP: wraps webRequest.onHeadersReceived before Vencord's initCsp() runs, chaining our sources after
 *      Vencord's own rewrite (Electron keeps a single listener; Vencord then replaces the method by a noop)
 *   4. Dormant fallback: a BrowserWindow subclass under Vencord's, which swaps in our preload only when
 *      the renderer hook never fired (e.g. a future Vencord renamed the channel)
 *
 * Any failure in our part is logged and Vencord/Discord still load. If Vencord itself fails before
 * Discord was required, Discord is started vanilla instead of not starting at all.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { buildRendererPayload, wrapAddonRenderer, addCspSources } = require("./payload");

// Vencord internals we key on (src/shared/IpcEvents.ts:47,55; registered in src/main/ipcPlugins.ts:40 and
// src/main/ipcMain.ts:178). Both are synchronous ipcMain.on + event.returnValue.
const CH_RENDERER_JS = "VencordPreloadGetRendererJs";
const CH_PLUGIN_IPC_MAP = "VencordGetPluginIpcMethodMap";
// Ours, used only by the fallback preload.
const CH_PRELOAD_INFO = "PeerLiveAddonPreloadInfo";

const state = {
    version: 1,
    bootedAt: null,
    vencordLoaded: false,
    vanillaFallback: false,
    rendererHooked: false,
    ipcMapHooked: false,
    rendererServed: 0,
    metaPatched: null,
    metaReason: null,
    nativeChannels: [],
    cspMode: null, // "chained" (inside Vencord's listener) | "standalone" (our own listener) | null
    cspApplied: 0,
    preloadFallback: false,
    errors: []
};

// Discord's main-process stdout goes nowhere on Windows, so also keep a small log file: %APPDATA%\PeerLive\logs\main.log
const LOG_FILE = path.join(__dirname, "..", "logs", "main.log");
function writeLog(line) {
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, "");
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
    } catch { }
}

const log = (...args) => {
    console.log("[PeerLiveAddon]", ...args);
    writeLog(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
};

function fail(where, err) {
    state.errors.push(`${where}: ${err?.stack ?? err}`);
    console.error(`[PeerLiveAddon] ${where} failed`, err);
    writeLog(`ERROR ${where}: ${err?.stack ?? err}`);
}

function step(where, fn) {
    try {
        fn();
    } catch (err) {
        fail(where, err);
    }
}

const channelFor = (pluginName, method) => `PeerLiveAddon_${pluginName}_${method}`;

function readManifest() {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "addon.json"), "utf8"));
}

/** register.js (the late-registration helper) + the plugin's renderer bundle, read fresh on every window load. */
function readAddonRenderer(manifest) {
    return fs.readFileSync(path.join(__dirname, "register.js"), "utf8") + "\n;\n" + fs.readFileSync(path.join(__dirname, manifest.renderer), "utf8");
}

/** Lets a sync ipcMain listener answer through a stand-in event, then replies with transform(answer). */
function afterSyncReply(listener, transform) {
    return function (event, ...args) {
        let value;
        let answered = false;
        const standIn = Object.create(event, {
            returnValue: {
                configurable: true,
                get: () => value,
                set: v => {
                    value = v;
                    answered = true;
                }
            }
        });

        listener.call(this, standIn, ...args);
        if (!answered) return; // not a sync answer: leave it alone

        let out = value;
        try {
            out = transform(value);
        } catch (err) {
            fail("transform reply", err);
        }
        event.returnValue = out;
    };
}

let restoreIpcOn = () => { };

function installIpcHooks(manifest, methodMap) {
    const { ipcMain } = require("electron");
    const ownOn = Object.getOwnPropertyDescriptor(ipcMain, "on");
    const ownAdd = Object.getOwnPropertyDescriptor(ipcMain, "addListener");
    const originalOn = ipcMain.on;

    const wrap = (channel, listener) => {
        if (typeof listener !== "function") return listener;

        if (channel === CH_RENDERER_JS) {
            state.rendererHooked = true;
            return afterSyncReply(listener, vencordJs => {
                const payload = buildRendererPayload(String(vencordJs), readAddonRenderer(manifest), manifest);
                state.rendererServed++;
                state.metaPatched = payload.metaPatched;
                state.metaReason = payload.metaReason;
                return payload.code;
            });
        }

        if (channel === CH_PLUGIN_IPC_MAP) {
            state.ipcMapHooked = true;
            return afterSyncReply(listener, map => ({ ...map, [manifest.pluginName]: methodMap }));
        }

        return listener;
    };

    const on = function on(channel, listener) {
        return originalOn.call(this, channel, wrap(channel, listener));
    };
    ipcMain.on = on;
    ipcMain.addListener = on;

    restoreIpcOn = () => {
        for (const [key, desc] of [["on", ownOn], ["addListener", ownAdd]]) {
            if (desc) Object.defineProperty(ipcMain, key, desc);
            else delete ipcMain[key];
        }
        restoreIpcOn = () => { };
    };

    // Only used by the fallback preload (preload.js)
    originalOn.call(ipcMain, CH_PRELOAD_INFO, event => {
        let rendererJs = "";
        try {
            rendererJs = wrapAddonRenderer(readAddonRenderer(manifest), { via: "preload-fallback", metaPatched: false, metaReason: "renderer hook not active" });
        } catch (err) {
            fail("preload info", err);
        }
        event.returnValue = { pluginName: manifest.pluginName, methods: methodMap, rendererJs };
    });
}

/** Renderer frames allowed to call our natives (Discord's own pages). */
function assertDiscordSender(event) {
    const url = event?.senderFrame?.url ?? "";
    if (!/^https:\/\/(?:[a-z0-9-]+\.)*discord\.com\//i.test(url))
        throw new Error(`PeerLive addon: refused IPC from ${url || "unknown frame"}`);
}

function registerNatives(manifest, natives, methodMap) {
    const { ipcMain } = require("electron");
    for (const [method, channel] of Object.entries(methodMap)) {
        ipcMain.handle(channel, (event, ...args) => {
            assertDiscordSender(event);
            return natives[method](event, ...args);
        });
        state.nativeChannels.push(channel);
    }
}

function installCspChain(manifest) {
    // manifest.csp + whatever the plugin's native module added at load time: a Vencord-style native.ts does
    // `CspPolicies[url] = ConnectSrc`, and the addon build shims "@main/csp" to globalThis.__PeerLiveAddonCsp.
    const sources = () => ({ ...(manifest.csp ?? {}), ...(globalThis.__PeerLiveAddonCsp ?? {}) });
    if (!Object.keys(sources()).length) return;

    const { app, session } = require("electron");

    const patchResponse = (details, response) => {
        response ??= { cancel: false, responseHeaders: details.responseHeaders };
        if (details.resourceType === "mainFrame") {
            const headers = response.responseHeaders ?? details.responseHeaders;
            if (headers && addCspSources(headers, sources())) {
                response.responseHeaders = headers;
                if (++state.cspApplied === 1) log(`CSP: added ${Object.keys(sources()).length} sources (${state.cspMode})`);
            }
        }
        return response;
    };

    // Registered before Vencord's app.whenReady().then(... initCsp()) (src/main/index.ts:33-79), so it runs first.
    app.whenReady().then(() => {
        const webRequest = session.defaultSession.webRequest;
        const original = webRequest.onHeadersReceived;

        webRequest.onHeadersReceived = function onHeadersReceived(...args) {
            const i = args.findIndex(a => typeof a === "function");
            if (i !== -1) {
                const inner = args[i];
                args[i] = (details, callback) => inner(details, response => callback(patchResponse(details, response)));
                state.cspMode = "chained";
            }
            return original.apply(this, args);
        };

        // Vencord's then() callback is the next reaction on the same promise; a macrotask later it has run.
        setImmediate(() => {
            if (state.cspMode || !state.vencordLoaded) return;
            original.call(webRequest, (details, callback) => callback(patchResponse(details, null)));
            state.cspMode = "standalone";
            log("Vencord did not install a CSP listener; installed our own");
        });
    });
}

function installPreloadFallback() {
    const electron = require("electron");
    const Base = electron.BrowserWindow;

    // Vencord's subclass (src/main/patcher.ts:71-121) extends whatever require("electron").BrowserWindow is when
    // patcher.js loads, i.e. this class. Its constructor has already put Vencord's preload in options by the time
    // it calls super(options) into ours.
    class BrowserWindow extends Base {
        constructor(options) {
            const webPreferences = options?.webPreferences;
            if (webPreferences?.preload && options.title && state.vencordLoaded && !state.rendererHooked) {
                process.env.PEERLIVE_VENCORD_PRELOAD = webPreferences.preload;
                webPreferences.preload = path.join(__dirname, "preload.js");
                state.preloadFallback = true;
            }
            super(options);
        }
    }
    Object.assign(BrowserWindow, Base);
    Object.defineProperty(BrowserWindow, "name", { value: "BrowserWindow", configurable: true });

    // Same technique Vencord uses (src/main/patcher.ts:123-128)
    const electronPath = require.resolve("electron");
    const exportsWithOurs = { ...electron, BrowserWindow };
    delete require.cache[electronPath].exports;
    require.cache[electronPath].exports = exportsWithOurs;
}

function boot({ vencordPatcher, vanilla }) {
    globalThis.__PeerLiveAddon = state;
    state.bootedAt = Date.now();
    log("boot", { vencordPatcher, execPath: process.execPath });

    if (process.argv.includes("--vanilla")) {
        require(vencordPatcher); // Vencord handles --vanilla itself
        return;
    }

    let manifest = null;
    let natives = {};
    let methodMap = {};
    step("manifest", () => {
        manifest = readManifest();
        natives = manifest.main ? require(path.join(__dirname, manifest.main)) : {};
        methodMap = Object.fromEntries(
            Object.keys(natives).filter(k => typeof natives[k] === "function").map(k => [k, channelFor(manifest.pluginName, k)])
        );
    });

    if (manifest) {
        step("ipc hooks", () => installIpcHooks(manifest, methodMap));
        step("natives", () => registerNatives(manifest, natives, methodMap));
        step("csp", () => installCspChain(manifest));
        if (manifest.preloadFallback !== false) step("preload fallback", installPreloadFallback);
    }

    const stubFilename = require.main.filename;
    try {
        require(vencordPatcher);
        state.vencordLoaded = true;
    } catch (err) {
        restoreIpcOn();
        // Vencord's patcher re-points require.main.filename right before requiring Discord (src/main/patcher.ts:36).
        if (require.main.filename !== stubFilename) throw err; // Discord itself threw: not ours to hide
        fail("vencord", err);
        state.vanillaFallback = true;
        log("Vencord failed to load, starting Discord without mods");
        vanilla();
        return;
    }

    if (state.rendererHooked && state.ipcMapHooked) restoreIpcOn();
    else log("Vencord IPC hooks not seen", { rendererHooked: state.rendererHooked, ipcMapHooked: state.ipcMapHooked });

    log("loaded", { rendererHooked: state.rendererHooked, ipcMapHooked: state.ipcMapHooked, natives: state.nativeChannels.length });
}

module.exports = { boot, state, CH_RENDERER_JS, CH_PLUGIN_IPC_MAP, CH_PRELOAD_INFO };
