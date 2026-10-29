/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Smoke test for the built renderer bundle (dist/renderer.js).
//
// Discord desktop runs renderer.js through webFrame.executeJavaScript (see src/preload.ts), i.e. as a
// classic script in the page's MAIN world: no require/process/Buffer/global, only browser globals plus
// the VencordNative object exposed by the preload. If anything throws while the IIFE is evaluated, the
// `Vencord` global is never assigned and Discord starts without Vencord, with only a vague
// "Script failed to execute" in its logs.
//
// This script evaluates the bundle in a node:vm context that mimics that page closely enough to surface
// such top-level throws, and exits non-zero (printing the error and its source-mapped stack) if evaluation
// throws or `Vencord` is not defined afterwards.
//
// Usage: node scripts/peerlive/smokeRenderer.mjs [path/to/renderer.js ...]   (default: dist/renderer.js)

import { webcrypto } from "crypto";
import { existsSync, readFileSync } from "fs";
import { SourceMap } from "module";
import { basename, resolve } from "path";
import vm from "vm";

const EXPECTED_EXPORTS = ["Api", "Plugins", "Webpack", "WebpackPatcher", "Settings", "PlainSettings"];

// Browser constructors that only need to exist (typeof checks, `class extends X`, instanceof).
const STUB_CLASSES = [
    "Node", "Element", "HTMLElement", "HTMLDivElement", "HTMLStyleElement", "HTMLLinkElement", "HTMLScriptElement",
    "HTMLImageElement", "HTMLVideoElement", "HTMLAudioElement", "HTMLMediaElement", "HTMLCanvasElement",
    "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "HTMLIFrameElement", "SVGElement",
    "Text", "Comment", "DocumentFragment", "ShadowRoot", "Range", "Selection", "DOMParser", "XMLSerializer",
    "Image", "Audio", "OffscreenCanvas", "ImageData", "ImageBitmap", "Path2D", "FileReader", "XMLHttpRequest",
    "WebSocket", "Worker", "SharedWorker", "Notification", "MediaStream", "MediaStreamTrack", "MediaRecorder",
    "AudioContext", "MediaSource", "RTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate",
    "RTCRtpSender", "RTCRtpReceiver", "RTCDataChannel", "VideoFrame", "VideoEncoder", "VideoDecoder",
    "MutationObserver", "ResizeObserver", "IntersectionObserver", "PerformanceObserver", "CSSStyleSheet",
    "StyleSheet", "FontFace", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent",
    "ClipboardEvent", "DragEvent", "MessageEvent", "ErrorEvent", "PromiseRejectionEvent", "UIEvent",
    "SecurityPolicyViolationEvent", "IDBFactory", "IDBDatabase", "IDBKeyRange"
];

// Web APIs that Node implements the same way the browser does; copied by reference into the page.
const NODE_WEB_GLOBALS = [
    "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "Event", "EventTarget",
    "CustomEvent", "Blob", "File", "FormData", "MessageChannel", "MessagePort", "BroadcastChannel", "ReadableStream",
    "WritableStream", "TransformStream", "CompressionStream", "DecompressionStream", "DOMException", "atob", "btoa",
    "structuredClone", "queueMicrotask", "performance", "Request", "Response", "Headers"
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
        tagName: String(tagName).toUpperCase(),
        nodeName: String(tagName).toUpperCase(),
        nodeType: 1,
        ownerDocument: document,
        style: { setProperty() { }, removeProperty() { }, getPropertyValue: () => "" },
        dataset: {},
        attributes: [],
        children,
        childNodes: children,
        classList: { add() { }, remove() { }, toggle: () => false, contains: () => false },
        textContent: "",
        innerHTML: "",
        parentNode: null,
        setAttribute() { },
        getAttribute: () => null,
        removeAttribute() { },
        hasAttribute: () => false,
        appendChild(c) { children.push(c); c.parentNode = el; return c; },
        append(...cs) { cs.forEach(c => typeof c === "object" && el.appendChild(c)); },
        prepend(...cs) { cs.forEach(c => typeof c === "object" && el.appendChild(c)); },
        insertBefore(c) { return el.appendChild(c); },
        removeChild(c) { const i = children.indexOf(c); if (i !== -1) children.splice(i, 1); return c; },
        remove() { el.parentNode?.removeChild?.(el); },
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementsByTagName: () => [],
        getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        getContext: () => null,
        attachShadow: () => makeElement("#shadow-root", document)
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
        nodeType: 9,
        readyState: "loading",
        visibilityState: "visible",
        hidden: false,
        title: "Discord",
        cookie: "",
        documentElement,
        head,
        body,
        fonts: { add() { }, delete() { }, ready: Promise.resolve() },
        adoptedStyleSheets: [],
        createElement: tag => makeElement(tag, document),
        createElementNS: (_ns, tag) => makeElement(tag, document),
        createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
        createDocumentFragment: () => makeElement("#document-fragment", document),
        getElementById: () => null,
        getElementsByClassName: () => [],
        getElementsByTagName: () => [],
        querySelector: () => null,
        querySelectorAll: () => [],
        hasFocus: () => true
    });
    return document;
}

/** A VencordNative look-alike. Its IPC calls resolve to nothing, so plugins behave as on a fresh install. */
function makeVencordNative() {
    const asyncNoop = async () => undefined;
    return {
        themes: { uploadTheme: asyncNoop, deleteTheme: asyncNoop, getThemesList: async () => [], getThemeData: asyncNoop, getSystemValues: async () => ({}), openFolder: asyncNoop },
        updater: { getUpdates: async () => ({ ok: true, value: [] }), update: async () => ({ ok: true, value: false }), rebuild: async () => ({ ok: true, value: false }), getRepo: async () => ({ ok: true, value: "Vendicated/Vencord" }) },
        settings: { get: () => ({}), set: asyncNoop, openFolder: asyncNoop },
        quickCss: { get: async () => "", set: asyncNoop, addChangeListener() { }, addThemeChangeListener() { }, openFile: asyncNoop, openEditor: asyncNoop, getEditorTheme: () => "vs-dark" },
        native: { getVersions: () => ({ electron: "44.9.3", chrome: "152.0.0.0", node: "24.0.0" }), supportsWindowsMaterial: () => true, openExternal: asyncNoop, getRendererCss: async () => "", onRendererCssUpdate() { } },
        csp: { isDomainAllowed: async () => true, removeOverride: async () => true, requestAddOverride: async () => "conflict" },
        pluginHelpers: {}
    };
}

function makePageContext(consoleLines) {
    const page = Object.create(null);
    const stubClass = name => ({ [name]: class { } })[name];

    for (const name of STUB_CLASSES) page[name] = stubClass(name);
    for (const name of NODE_WEB_GLOBALS) if (globalThis[name] !== undefined) page[name] = globalThis[name];

    const logTo = level => (...args) => consoleLines.push(`[console.${level}] ${args.map(a => typeof a === "string" ? a : (() => { try { return String(a?.stack ?? a); } catch { return "<unprintable>"; } })()).join(" ")}`);
    page.console = Object.fromEntries(["log", "info", "warn", "error", "debug", "trace", "group", "groupCollapsed", "groupEnd", "table", "time", "timeEnd", "assert", "dir"].map(l => [l, logTo(l)]));

    // Timers are unref'd so a pending interval in the bundle never keeps this script alive.
    page.setTimeout = (fn, ms, ...args) => setTimeout(fn, ms, ...args).unref();
    page.setInterval = (fn, ms, ...args) => setInterval(fn, ms, ...args).unref();
    page.clearTimeout = t => clearTimeout(t);
    page.clearInterval = t => clearInterval(t);
    page.requestAnimationFrame = fn => page.setTimeout(() => fn(performance.now()), 16);
    page.cancelAnimationFrame = t => clearTimeout(t);
    page.requestIdleCallback = fn => page.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1);
    page.cancelIdleCallback = t => clearTimeout(t);

    page.crypto = webcrypto;
    page.fetch = async () => { throw new TypeError("Failed to fetch (smokeRenderer: network is disabled)"); };
    page.localStorage = makeStorage();
    page.sessionStorage = makeStorage();
    page.indexedDB = { open: () => ({}), deleteDatabase: () => ({}) };
    page.document = makeDocument();
    page.location = new URL("https://discord.com/channels/@me");
    page.history = { length: 1, state: null, pushState() { }, replaceState() { }, back() { }, forward() { }, go() { } };
    page.navigator = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9266 Chrome/152.0.0.0 Electron/44.9.3 Safari/537.36",
        platform: "Win32",
        language: "en-US",
        languages: ["en-US"],
        onLine: true,
        hardwareConcurrency: 8,
        clipboard: { writeText: async () => { }, readText: async () => "" },
        mediaDevices: { getUserMedia: async () => { throw new Error("no media"); }, getDisplayMedia: async () => { throw new Error("no media"); }, enumerateDevices: async () => [], addEventListener() { } },
        permissions: { query: async () => ({ state: "prompt" }) },
        sendBeacon: () => true
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

    // window/self/globalThis all point at the page; EventTarget methods for window.addEventListener etc.
    const windowEvents = new EventTarget();
    page.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    page.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    page.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents);
    page.alert = page.confirm = page.prompt = () => undefined;
    page.open = () => null;
    page.close = page.focus = page.blur = page.postMessage = () => undefined;

    page.VencordNative = makeVencordNative();

    const context = vm.createContext(page, { name: "Discord main world (smokeRenderer)" });
    vm.runInContext("globalThis.window = globalThis.self = globalThis.top = globalThis.parent = globalThis.frames = globalThis;", context);
    page.document.defaultView = context;
    return context;
}

/** Rewrites `file:///VencordRenderer:line:col` frames to their original sources using the sibling .map file. */
function mapStack(stack, rendererPath, scriptName) {
    const mapPath = rendererPath + ".map";
    if (!stack || !existsSync(mapPath)) return stack;

    let sourceMap;
    try {
        sourceMap = new SourceMap(JSON.parse(readFileSync(mapPath, "utf-8")));
    } catch {
        return stack;
    }

    const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return stack.replace(new RegExp(`${escaped}:(\\d+):(\\d+)`, "g"), (whole, line, col) => {
        const entry = sourceMap.findEntry(Number(line) - 1, Number(col) - 1);
        if (!entry?.originalSource) return whole;
        const src = entry.originalSource.replace(/^(\.\.\/)+/, "");
        return `${src}:${entry.originalLine + 1}:${entry.originalColumn + 1} (${whole})`;
    });
}

async function smoke(rendererPath) {
    const label = `[smokeRenderer] ${rendererPath}`;
    if (!existsSync(rendererPath)) {
        console.error(`${label}: FAIL - file not found (build first)`);
        return false;
    }

    const code = readFileSync(rendererPath, "utf-8");
    // The bundle footer sets the script name; the bundle also contains other sourceURL strings, so take the last one.
    const scriptName = [...code.matchAll(/\/\/# sourceURL=(\S+)/g)].at(-1)?.[1] ?? basename(rendererPath);
    const consoleLines = [];
    const asyncErrors = [];
    const onAsyncError = err => asyncErrors.push(err);
    process.on("unhandledRejection", onAsyncError);
    process.on("uncaughtException", onAsyncError);

    const context = makePageContext(consoleLines);
    let thrown = null;
    try {
        new vm.Script(code, { filename: scriptName }).runInContext(context, { displayErrors: false });
    } catch (err) {
        thrown = err;
    }

    // Let microtasks / immediate timers scheduled during evaluation run, like the page would.
    await new Promise(r => setTimeout(r, 50));
    process.off("unhandledRejection", onAsyncError);
    process.off("uncaughtException", onAsyncError);

    const vencord = vm.runInContext("typeof Vencord === 'undefined' ? undefined : Vencord", context);
    const missing = vencord && typeof vencord === "object"
        ? EXPECTED_EXPORTS.filter(k => !(k in vencord))
        : EXPECTED_EXPORTS;

    if (consoleLines.length && (thrown || missing.length)) {
        console.error(`${label}: console output during evaluation:`);
        for (const line of consoleLines.slice(-30)) console.error("    " + line);
    }
    for (const err of asyncErrors) {
        console.warn(`${label}: warning - async error after evaluation (not fatal):\n    ${mapStack(String(err?.stack ?? err), rendererPath, scriptName)}`);
    }

    if (thrown) {
        console.error(`${label}: FAIL - the bundle threw while being evaluated, so the Vencord global is never assigned.`);
        console.error(mapStack(String(thrown?.stack ?? thrown), rendererPath, scriptName));
        return false;
    }
    if (!vencord) {
        console.error(`${label}: FAIL - evaluation finished but the Vencord global is not defined.`);
        return false;
    }
    if (missing.length) {
        console.error(`${label}: FAIL - Vencord global is missing expected exports: ${missing.join(", ")}`);
        return false;
    }

    const pluginCount = Object.keys(vencord.Plugins?.plugins ?? {}).length;
    console.log(`${label}: OK - Vencord global defined (${pluginCount} plugins registered)`);
    return true;
}

const targets = process.argv.slice(2).filter(a => !a.startsWith("--"));
if (!targets.length) targets.push("dist/renderer.js");

let ok = true;
for (const target of targets) {
    ok = await smoke(resolve(target)) && ok;
}
process.exit(ok ? 0 : 1);
