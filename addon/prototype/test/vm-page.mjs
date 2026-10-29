/*
 * A node:vm "Discord main world" good enough to evaluate a Vencord renderer bundle (same idea as
 * scripts/peerlive/smokeRenderer.mjs, trimmed): browser globals as stubs, a VencordNative look-alike whose
 * settings store and plugin helpers are supplied by the test.
 */
import { webcrypto } from "crypto";
import vm from "vm";

const STUB_CLASSES = [
    "Node", "Element", "HTMLElement", "HTMLDivElement", "HTMLStyleElement", "HTMLLinkElement", "HTMLScriptElement",
    "HTMLImageElement", "HTMLVideoElement", "HTMLAudioElement", "HTMLMediaElement", "HTMLCanvasElement", "HTMLInputElement",
    "HTMLTextAreaElement", "HTMLAnchorElement", "HTMLIFrameElement", "SVGElement", "Text", "Comment", "DocumentFragment",
    "ShadowRoot", "Range", "Selection", "DOMParser", "XMLSerializer", "Image", "Audio", "OffscreenCanvas", "ImageData",
    "ImageBitmap", "Path2D", "FileReader", "XMLHttpRequest", "WebSocket", "Worker", "SharedWorker", "Notification",
    "MediaStream", "MediaStreamTrack", "MediaRecorder", "AudioContext", "MediaSource", "RTCPeerConnection",
    "RTCSessionDescription", "RTCIceCandidate", "RTCRtpSender", "RTCRtpReceiver", "RTCDataChannel", "VideoFrame",
    "VideoEncoder", "VideoDecoder", "MutationObserver", "ResizeObserver", "IntersectionObserver", "PerformanceObserver",
    "CSSStyleSheet", "StyleSheet", "FontFace", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent",
    "ClipboardEvent", "DragEvent", "MessageEvent", "ErrorEvent", "PromiseRejectionEvent", "UIEvent",
    "SecurityPolicyViolationEvent", "IDBFactory", "IDBDatabase", "IDBKeyRange"
];
const NODE_WEB_GLOBALS = [
    "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "Event", "EventTarget",
    "CustomEvent", "Blob", "File", "FormData", "MessageChannel", "MessagePort", "BroadcastChannel", "ReadableStream",
    "WritableStream", "TransformStream", "DOMException", "atob", "btoa", "structuredClone", "queueMicrotask",
    "performance", "Request", "Response", "Headers"
];

function makeStorage() {
    const data = new Map();
    return {
        get length() { return data.size; },
        key: i => [...data.keys()][i] ?? null,
        getItem: k => data.has(String(k)) ? data.get(String(k)) : null,
        setItem: (k, v) => void data.set(String(k), String(v)),
        removeItem: k => void data.delete(String(k)),
        clear: () => data.clear()
    };
}

function makeElement(tagName, document) {
    const el = new EventTarget();
    const children = [];
    Object.assign(el, {
        tagName: String(tagName).toUpperCase(), nodeName: String(tagName).toUpperCase(), nodeType: 1, ownerDocument: document,
        style: { setProperty() { }, removeProperty() { }, getPropertyValue: () => "" }, dataset: {}, attributes: [],
        children, childNodes: children, textContent: "", innerHTML: "", parentNode: null,
        classList: { add() { }, remove() { }, toggle: () => false, contains: () => false },
        setAttribute() { }, getAttribute: () => null, removeAttribute() { }, hasAttribute: () => false,
        appendChild(c) { children.push(c); c.parentNode = el; return c; },
        append(...cs) { cs.forEach(c => typeof c === "object" && el.appendChild(c)); },
        prepend(...cs) { cs.forEach(c => typeof c === "object" && el.appendChild(c)); },
        insertBefore(c) { return el.appendChild(c); },
        removeChild(c) { const i = children.indexOf(c); if (i !== -1) children.splice(i, 1); return c; },
        remove() { el.parentNode?.removeChild?.(el); },
        querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
        getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        getContext: () => null, attachShadow: () => makeElement("#shadow-root", document)
    });
    return el;
}

function makeDocument() {
    const document = new EventTarget();
    const documentElement = makeElement("html", document);
    const head = makeElement("head", document);
    const body = makeElement("body", document);
    documentElement.appendChild(head);
    documentElement.appendChild(body);
    Object.assign(document, {
        nodeType: 9, readyState: "loading", visibilityState: "visible", hidden: false, title: "Discord", cookie: "",
        documentElement, head, body, fonts: { add() { }, delete() { }, ready: Promise.resolve() }, adoptedStyleSheets: [],
        createElement: tag => makeElement(tag, document), createElementNS: (_ns, tag) => makeElement(tag, document),
        createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
        createDocumentFragment: () => makeElement("#document-fragment", document),
        getElementById: () => null, getElementsByClassName: () => [], getElementsByTagName: () => [],
        querySelector: () => null, querySelectorAll: () => [], hasFocus: () => true
    });
    return document;
}

/**
 * @param {{ storedSettings?: object, pluginHelpers?: object }} opts
 * @returns {{ context: vm.Context, consoleLines: string[], savedSettings: object[] }}
 */
export function makePage({ storedSettings = {}, pluginHelpers = {} } = {}) {
    const consoleLines = [];
    const savedSettings = [];
    const page = Object.create(null);

    for (const name of STUB_CLASSES) page[name] = ({ [name]: class { } })[name];
    for (const name of NODE_WEB_GLOBALS) if (globalThis[name] !== undefined) page[name] = globalThis[name];

    // errors come from the vm realm, so `instanceof Error` is false here: duck-type on .stack
    const fmt = a => typeof a === "string" ? a : (() => { try { return typeof a?.stack === "string" ? a.stack : JSON.stringify(a, (_, v) => typeof v === "bigint" ? `${v}n` : v); } catch { return String(a); } })();
    page.console = Object.fromEntries(["log", "info", "warn", "error", "debug", "trace", "group", "groupCollapsed", "groupEnd", "table", "time", "timeEnd", "assert", "dir"]
        .map(l => [l, (...args) => consoleLines.push(`[${l}] ${args.map(fmt).join(" ")}`)]));

    page.setTimeout = (fn, ms, ...a) => setTimeout(fn, ms, ...a).unref();
    page.setInterval = (fn, ms, ...a) => setInterval(fn, ms, ...a).unref();
    page.clearTimeout = t => clearTimeout(t);
    page.clearInterval = t => clearInterval(t);
    page.requestAnimationFrame = fn => page.setTimeout(() => fn(performance.now()), 16);
    page.cancelAnimationFrame = t => clearTimeout(t);
    page.requestIdleCallback = fn => page.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1);
    page.cancelIdleCallback = t => clearTimeout(t);
    page.crypto = webcrypto;
    page.fetch = async () => { throw new TypeError("Failed to fetch (offline test)"); };
    page.localStorage = makeStorage();
    page.sessionStorage = makeStorage();
    page.indexedDB = { open: () => ({}), deleteDatabase: () => ({}) };
    page.document = makeDocument();
    page.location = new URL("https://discord.com/channels/@me");
    page.history = { length: 1, state: null, pushState() { }, replaceState() { }, back() { }, forward() { }, go() { } };
    page.navigator = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9266 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36",
        platform: "Win32", language: "en-US", languages: ["en-US"], onLine: true, hardwareConcurrency: 8,
        clipboard: { writeText: async () => { }, readText: async () => "" },
        mediaDevices: { getUserMedia: async () => { throw new Error("no media"); }, getDisplayMedia: async () => { throw new Error("no media"); }, enumerateDevices: async () => [], addEventListener() { } },
        permissions: { query: async () => ({ state: "prompt" }) }, sendBeacon: () => true
    };
    page.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
    page.matchMedia = query => ({ matches: false, media: query, addEventListener() { }, removeEventListener() { }, addListener() { }, removeListener() { } });
    page.getComputedStyle = () => ({ getPropertyValue: () => "" });
    page.getSelection = () => null;
    page.CSS = { supports: () => false, escape: s => String(s) };
    page.innerWidth = 1920;
    page.innerHeight = 1080;
    page.devicePixelRatio = 1;
    page.isSecureContext = true;
    page.origin = "https://discord.com";
    page.name = "";
    const windowEvents = new EventTarget();
    page.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    page.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    page.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents);
    page.alert = page.confirm = page.prompt = () => undefined;
    page.open = () => null;
    page.close = page.focus = page.blur = page.postMessage = () => undefined;

    const asyncNoop = async () => undefined;
    page.VencordNative = {
        themes: { uploadTheme: asyncNoop, deleteTheme: asyncNoop, getThemesList: async () => [], getThemeData: asyncNoop, getSystemValues: async () => ({}), openFolder: asyncNoop },
        updater: { getUpdates: async () => ({ ok: true, value: [] }), update: async () => ({ ok: true, value: false }), rebuild: async () => ({ ok: true, value: false }), getRepo: async () => ({ ok: true, value: "Vendicated/Vencord" }) },
        settings: {
            get: () => structuredClone(storedSettings),
            set: async (plain, path) => { savedSettings.push({ path, plain: JSON.parse(JSON.stringify(plain)) }); },
            openFolder: asyncNoop
        },
        quickCss: { get: async () => "", set: asyncNoop, addChangeListener() { }, addThemeChangeListener() { }, openFile: asyncNoop, openEditor: asyncNoop, getEditorTheme: () => "vs-dark" },
        native: { getVersions: () => ({ electron: "37.0.0", chrome: "138.0.0.0", node: "22.0.0" }), supportsWindowsMaterial: () => true, openExternal: asyncNoop, getRendererCss: async () => "", onRendererCssUpdate() { } },
        csp: { isDomainAllowed: async () => true, removeOverride: async () => true, requestAddOverride: async () => "conflict" },
        pluginHelpers
    };

    const context = vm.createContext(page, { name: "Discord main world (addon test)" });
    vm.runInContext("globalThis.window = globalThis.self = globalThis.top = globalThis.parent = globalThis.frames = globalThis;", context);
    page.document.defaultView = context;
    return { context, consoleLines, savedSettings };
}

/** Runs `code` as a classic script, like webFrame.executeJavaScript / a <script src>. */
export function runScript(context, code, filename) {
    return new vm.Script(code, { filename }).runInContext(context);
}
