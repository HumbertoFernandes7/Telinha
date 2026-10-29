/*
 * Fake `electron` (main process) for the offline loader test. Only what Vencord's patcher.js, our loader and
 * the fake Discord bootstrap touch, with Electron's observable semantics where they matter:
 *   - session.defaultSession throws before app ready
 *   - webRequest keeps ONE onHeadersReceived listener (a later call replaces it)
 *   - ipcMain.handle refuses a second handler for the same channel
 *   - sync IPC: event.returnValue is a setter that sends the reply (getter returns undefined)
 *   - BrowserWindow.getAllWindows() filters on constructor.name === "BrowserWindow"
 */
"use strict";

const EventEmitter = require("events");
const path = require("path");

const ROOT = process.env.FAKE_ROOT;
const USER_DATA = path.join(ROOT, "Roaming", "discord");

class FakeApp extends EventEmitter {
    constructor() {
        super();
        this.ready = false;
        this.appPath = null;
        this.readyPromise = new Promise(r => (this.resolveReady = r));
        this.commandLine = { appendSwitch() { }, appendArgument() { }, hasSwitch: () => false, getSwitchValue: () => "" };
    }
    whenReady() { return this.readyPromise; }
    isReady() { return this.ready; }
    getPath(name) { return name === "userData" ? USER_DATA : path.join(ROOT, "paths", name); }
    setAppPath(p) { this.appPath = p; }
    getAppPath() { return this.appPath; }
    getVersion() { return "1.0.9002"; }
    getName() { return "discord"; }
    quit() { this.emit("before-quit"); }
    relaunch() { }
    exit() { }
    /** test helper: Electron emits "ready" synchronously, then resolves whenReady() */
    becomeReady() {
        this.ready = true;
        this.emit("ready");
        this.resolveReady();
    }
}
const app = new FakeApp();

class FakeIpcMain extends EventEmitter {
    constructor() {
        super();
        this.handlers = new Map();
    }
    handle(channel, fn) {
        if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        this.handlers.set(channel, fn);
    }
    handleOnce(channel, fn) { this.handle(channel, fn); }
    removeHandler(channel) { this.handlers.delete(channel); }

    /** test helper: what ipcRenderer.sendSync does */
    sendSync(channel, sender, ...args) {
        let reply;
        let replied = false;
        const event = { sender, senderFrame: { url: "https://discord.com/app" }, frameId: 1, processId: 1, reply() { } };
        Object.defineProperty(event, "returnValue", {
            set: v => {
                if (replied) throw new Error(`sync reply for ${channel} sent twice`);
                replied = true;
                reply = v;
            },
            get: () => undefined
        });
        this.emit(channel, event, ...args);
        return replied ? structuredClone(reply) : undefined;
    }

    /** test helper: what ipcRenderer.invoke does */
    async invoke(channel, sender, frameUrl, ...args) {
        const handler = this.handlers.get(channel);
        if (!handler) throw new Error(`No handler registered for '${channel}'`);
        const result = await handler({ sender, senderFrame: { url: frameUrl }, frameId: 1, processId: 1 }, ...structuredClone(args));
        return structuredClone(result);
    }
}
const ipcMain = new FakeIpcMain();

class FakeWebRequest {
    constructor() {
        this.listener = null;
        this.installs = 0;
    }
    onHeadersReceived(...args) {
        this.listener = args.find(a => typeof a === "function") ?? null;
        this.installs++;
    }
    onBeforeRequest() { }
    onBeforeSendHeaders() { }
    onSendHeaders() { }
    onResponseStarted() { }
    onBeforeRedirect() { }
    onCompleted() { }
    onErrorOccurred() { }
}

const defaultSession = {
    webRequest: new FakeWebRequest(),
    displayMediaHandler: undefined,
    displayMediaCalls: 0,
    setDisplayMediaRequestHandler(handler) {
        this.displayMediaHandler = handler;
        this.displayMediaCalls++;
    },
    setPermissionRequestHandler() { },
    setPermissionCheckHandler() { },
    getPreloads: () => [],
    setPreloads() { },
    on() { },
    protocol: { handle() { } }
};

const session = {
    get defaultSession() {
        if (!app.ready) throw new Error("Session can only be received when app is ready");
        return defaultSession;
    },
    fromPartition: () => defaultSession
};

const webContents = { id: 1, get session() { return session.defaultSession; }, send() { }, on() { }, once() { }, executeJavaScript: async () => undefined };

class BrowserWindow extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.webContents = webContents;
        BrowserWindow.all.push(this);
        app.emit("browser-window-created", {}, this);
    }
    static getAllWindows() { return BrowserWindow.all.filter(w => w.constructor.name === "BrowserWindow"); }
    static getFocusedWindow() { return null; }
    static fromWebContents() { return null; }
    loadURL() { return Promise.resolve(); }
    setMinimumSize() { }
    show() { }
    focus() { }
}
BrowserWindow.all = [];

const protocolHandlers = {};

module.exports = {
    app,
    ipcMain,
    session,
    BrowserWindow,
    webContents: { getAllWebContents: () => [webContents], fromId: () => webContents, getFocusedWebContents: () => webContents },
    Menu: { buildFromTemplate: template => ({ template }), setApplicationMenu() { }, getApplicationMenu: () => null },
    protocol: { handle(scheme, fn) { protocolHandlers[scheme] = fn; }, registerSchemesAsPrivileged() { }, registerFileProtocol() { }, handlers: protocolHandlers },
    net: { fetch: async () => new Response("") },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: "system" }),
    shell: { openExternal: async () => { }, openPath: async () => "", showItemInFolder() { } },
    systemPreferences: { getAccentColor: () => "5865f2ff", getColor: () => "#000000", on() { } },
    dialog: { showMessageBox: async () => ({ response: 0, checkboxChecked: false }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox() { } },
    desktopCapturer: { getSources: async () => [] },
    powerMonitor: new EventEmitter(),
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }), getAllDisplays: () => [] },
    nativeImage: { createEmpty: () => ({ isEmpty: () => true }), createFromPath: () => ({ isEmpty: () => true }) },
    clipboard: { writeText() { }, readText: () => "" },
    crashReporter: { start() { } },
    globalShortcut: { register() { }, unregisterAll() { } }
};
