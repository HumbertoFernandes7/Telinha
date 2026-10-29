/*
 * Telinha add-on - main-process loader (%APPDATA%\Telinha\addon\main.js).
 *
 * Required by our resources/app.asar stub, BEFORE the official Vencord patcher.js. Everything here only prepares
 * hooks; Vencord and Discord then load exactly as with Vencord's own stub:
 *
 *   1. ipcMain.on wrapper (removed once both hooks fired):
 *      - "VencordPreloadGetRendererJs"  -> Vencord's renderer (+ PluginMeta entry) + our renderer appended
 *      - "VencordGetPluginIpcMethodMap" -> Vencord's map + our natives, so the plugin's unchanged
 *                                          VencordNative.pluginHelpers.Telinha.<method>() calls work
 *   2. ipcMain.handle for our natives (own channel prefix, so no clash with Vencord's handlers)
 *   3. CSP: wraps webRequest.onHeadersReceived before Vencord's initCsp() runs, chaining our sources after
 *      Vencord's own rewrite (Electron keeps a single listener; Vencord then replaces the method by a noop)
 *   4. Dormant fallback: a BrowserWindow subclass under Vencord's, which swaps in our preload only when
 *      the renderer hook never fired (e.g. a future Vencord renamed the channel)
 *
 * Any failure in our part is logged and Vencord/Discord still load. If Vencord itself fails before Discord was
 * required, Discord is started vanilla instead of not starting at all. Contract: addon/PAYLOAD.md.
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
const CH_PRELOAD_INFO = "TelinhaAddonPreloadInfo";
const TAG = "[Telinha]";

const state = {
    format: 1,
    version: null,
    commit: null,
    bootedAt: null,
    vencordLoaded: false,
    vanillaFallback: false,
    rendererHooked: false,
    ipcMapHooked: false,
    rendererServed: 0,
    metaPatched: null,
    metaReason: null,
    vencordBundlesPlugin: false,
    nativesLoaded: false,
    nativeChannels: [],
    helperDir: null,
    cspMode: null, // "chained" (inside Vencord's listener) | "standalone" (our own listener) | null
    cspApplied: 0,
    preloadFallback: false,
    errors: []
};

// Discord's main-process stdout goes nowhere on Windows, so also keep a small log file: %APPDATA%\Telinha\logs\main.log
const LOG_FILE = path.join(__dirname, "..", "logs", "main.log");
const LOG_MAX_BYTES = 256 * 1024;
function writeLog(line) {
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + ".1");
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    } catch { }
}

const log = (...args) => {
    console.log(TAG, ...args);
    writeLog(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
};

function fail(where, err) {
    state.errors.push(`${where}: ${err?.stack ?? err}`);
    console.error(`${TAG} addon: ${where} failed`, err);
    writeLog(`ERROR ${where}: ${err?.stack ?? err}`);
}

function step(where, fn) {
    try {
        fn();
        return true;
    } catch (err) {
        fail(where, err);
        return false;
    }
}

const channelFor = (pluginName, method) => `TelinhaAddon_${pluginName}_${method}`;

const readJson = file => JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));

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
                if (state.rendererServed === 1) log("renderer served", { metaPatched: payload.metaPatched, metaReason: payload.metaReason });
                return payload.code;
            });
        }

        if (channel === CH_PLUGIN_IPC_MAP) {
            state.ipcMapHooked = true;
            return afterSyncReply(listener, map => {
                if (map && Object.prototype.hasOwnProperty.call(map, manifest.pluginName)) {
                    // This Vencord build already bundles the plugin (e.g. the Telinha fork): its natives win, ours stay idle.
                    if (!state.vencordBundlesPlugin) log(`Vencord already bundles ${manifest.pluginName}; the add-on stays passive`);
                    state.vencordBundlesPlugin = true;
                    return map;
                }
                // No natives loaded: leave the plugin's entry out, so its own "native part not loaded" message shows
                // instead of calls on an empty object.
                if (!Object.keys(methodMap).length) return map;
                return { ...map, [manifest.pluginName]: methodMap };
            });
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
        event.returnValue = { pluginName: manifest.pluginName, methods: methodMap, ipcMapHooked: state.ipcMapHooked, rendererJs };
    });
}

/** Renderer frames allowed to call our natives (Discord's own pages). */
function assertDiscordSender(event) {
    const url = event?.senderFrame?.url ?? "";
    if (!/^https:\/\/(?:[a-z0-9-]+\.)*discord\.com\//i.test(url))
        throw new Error(`Telinha add-on: refused IPC from ${url || "unknown frame"}`);
}

function registerNatives(natives, methodMap) {
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
    // manifest.csp + whatever the plugin's native module added at load time: Telinha's native.ts does
    // `CspPolicies[url] = ConnectSrc`, and the add-on build shims "@main/csp" to globalThis.__TelinhaAddonCsp.
    const sources = () => ({ ...(manifest.csp ?? {}), ...(globalThis.__TelinhaAddonCsp ?? {}) });
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
                args[i] = (details, callback) => inner(details, response => {
                    let out = response;
                    try {
                        out = patchResponse(details, response);
                    } catch (err) {
                        if (!state.errors.some(e => e.startsWith("csp response"))) fail("csp response", err);
                    }
                    callback(out);
                });
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
    }).catch(err => fail("csp", err));
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
                process.env.TELINHA_VENCORD_PRELOAD = webPreferences.preload;
                webPreferences.preload = path.join(__dirname, "preload.js");
                if (!state.preloadFallback) log("preload fallback active (Vencord's renderer IPC hook did not fire)");
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

/** Everything that happens before Vencord loads. Never throws. */
function prepare() {
    step("version", () => {
        const v = readJson("version.json");
        state.version = v.version ?? null;
        state.commit = v.commit ?? null;
    });

    let manifest = null;
    if (!step("manifest", () => { manifest = readJson("addon.json"); }) || !manifest?.pluginName || !manifest.renderer) {
        if (manifest) fail("manifest", new Error("addon.json has no pluginName/renderer"));
        return;
    }

    let natives = {};
    step("natives", () => {
        if (manifest.helperDirEnv) {
            // Where the plugin's native code looks for its helper executables (telinha-audio.exe): this folder.
            process.env[manifest.helperDirEnv] = __dirname;
            state.helperDir = __dirname;
        }
        if (manifest.main) natives = require(path.join(__dirname, manifest.main));
        state.nativesLoaded = true;
    });
    const methodMap = Object.fromEntries(
        Object.keys(natives).filter(k => typeof natives[k] === "function").map(k => [k, channelFor(manifest.pluginName, k)])
    );

    step("ipc hooks", () => installIpcHooks(manifest, methodMap));
    step("natives ipc", () => registerNatives(natives, methodMap));
    step("csp", () => installCspChain(manifest));
    if (manifest.preloadFallback !== false) step("preload fallback", installPreloadFallback);
}

function boot({ vencordPatcher, vanilla }) {
    try {
        globalThis.__TelinhaAddon = state;
        state.bootedAt = Date.now();
        log("boot", { vencordPatcher, execPath: process.execPath, argv: process.argv.slice(1) });
        if (!process.argv.includes("--vanilla")) prepare(); // with --vanilla Vencord itself stays out of the way
    } catch (err) {
        fail("boot", err);
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

    log("loaded", {
        version: state.version,
        commit: state.commit,
        rendererHooked: state.rendererHooked,
        ipcMapHooked: state.ipcMapHooked,
        natives: state.nativeChannels.length,
        helperDir: state.helperDir,
        errors: state.errors.length
    });
}

module.exports = { boot, state, CH_RENDERER_JS, CH_PLUGIN_IPC_MAP, CH_PRELOAD_INFO };
