/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A browser-like DOM for tests (happy-dom on globalThis: window, document, HTMLElement, events, ...). Load it with
//   import "@test/fakes/dom";            (or a named import of the helpers below; @test/fakes/render loads it too)
// Its position among the imports does not matter: no plugin module touches the DOM at load, and react-dom (which
// checks for a DOM when it loads) is only loaded by @test/fakes/render, after this.
//
// happy-dom has no media pipeline and no canvas, so:
// - <video>/<audio>: play() resolves and records the element (media.played), srcObject keeps what was assigned (a
//   FakeMediaStream), media.setFrame() gives a video a decoded frame size (videoWidth/videoHeight/readyState);
// - <canvas>.getContext("2d") is a fake whose getImageData returns canvas2d.pixels(w, h) (default: mid gray).
// No layout either: layout.setSize(el, ...) gives an element a size (clientWidth, getBoundingClientRect...) and
// resizeObservers.resize(el, ...) also fires the ResizeObservers watching it. Fullscreen: requestFullscreen() /
// document.exitFullscreen() set document.fullscreenElement and fire "fullscreenchange" (fullscreen.refuse = reject).
// happy-dom's own fetch would reach the network: it is replaced by the blocking one (@test/fakes/fetch).

import type * as Registrator from "@happy-dom/global-registrator";

import { blockNetwork } from "./fetch";
import { requireBundled } from "./vendor";

const { GlobalRegistrator } = requireBundled<typeof Registrator>("happy-dom", "@happy-dom/global-registrator");

if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "https://discord.com/channels/@me", width: 1920, height: 1080 });
}

blockNetwork();

// React: we drive updates with act() (testing-library does it for render/fireEvent)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom comes pre-bundled (vendor.ts), and esbuild renamed its classes to avoid clashes: Text is "Text2", Comment
// "Comment2", Event "_Event", Node "_Node"... Anything that reads constructor.name sees those: testing-library's
// pretty-format only prints Text/Comment/DocumentFragment nodes and <select>/<form> when the class has the browser's
// name, and a failed query dies with a PrettyFormatPluginError instead of printing the DOM. Give them the real names.
for (const key of Object.getOwnPropertyNames(globalThis)) {
    const ctor = Object.getOwnPropertyDescriptor(globalThis, key)?.value as { name?: unknown; } | undefined;
    if (typeof ctor !== "function" || typeof ctor.name !== "string" || ctor.name === key) continue;
    // only esbuild's renames ("_Node", "Text2"): an alias of another class ("AudioProcessingEvent" -> "_Event") stays
    if (ctor.name.replace(/^_/, "").replace(/\d+$/, "") !== key) continue;
    Object.defineProperty(ctor, "name", { configurable: true, value: key });
}

// Animation.cancel() rejects animation.finished with an AbortError. A browser marks that promise as handled, happy-dom
// leaves it alone, so Node reports an unhandled rejection the moment a component cancels an animation it never awaited
// (the spinners' cleanup). Handle it first: whoever awaits `finished` still gets the rejection.
{
    const animationProto = (globalThis as { Animation?: { prototype: Animation; }; }).Animation?.prototype;
    if (animationProto) {
        const { cancel } = animationProto;
        animationProto.cancel = function (this: Animation) {
            this.finished.catch(() => { });
            cancel.call(this);
        };
    }
}

/** <video>/<audio> elements play() was called on, oldest first; set `playImpl` to make play() reject (autoplay). */
export const media = {
    played: [] as HTMLMediaElement[],
    playImpl: null as ((el: HTMLMediaElement) => Promise<void>) | null,
    /** A <video> now has a decoded frame of this size (readyState 4 = HAVE_ENOUGH_DATA unless given). */
    setFrame(el: HTMLMediaElement, frame: { width: number; height: number; readyState?: number; }) {
        Object.defineProperty(el, "videoWidth", { configurable: true, value: frame.width });
        Object.defineProperty(el, "videoHeight", { configurable: true, value: frame.height });
        Object.defineProperty(el, "readyState", { configurable: true, value: frame.readyState ?? 4 });
    }
};

const proto = (globalThis as { HTMLMediaElement?: { prototype: HTMLMediaElement; }; }).HTMLMediaElement?.prototype;
if (proto) {
    const srcObjects = new WeakMap<HTMLMediaElement, unknown>();
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(proto, "srcObject", {
        configurable: true,
        get(this: HTMLMediaElement) {
            return srcObjects.get(this) ?? null;
        },
        set(this: HTMLMediaElement, value: unknown) {
            srcObjects.set(this, value);
        }
    });
    Object.defineProperty(proto, "paused", {
        configurable: true,
        get(this: HTMLMediaElement) {
            return paused.get(this) ?? true;
        }
    });
    proto.play = function (this: HTMLMediaElement) {
        media.played.push(this);
        const result = media.playImpl ? media.playImpl(this) : Promise.resolve();
        return result.then(() => void paused.set(this, false));
    };
    proto.pause = function (this: HTMLMediaElement) {
        paused.set(this, true);
    };
}

// #region canvas 2D

/** What the fake 2D contexts do: pixels getImageData returns (RGBA), and how many drawImage calls they got. */
export const canvas2d = {
    pixels: null as ((width: number, height: number) => Uint8ClampedArray) | null,
    drawImageCalls: 0,
    /** false = getContext("2d") returns null (a context that cannot be created) */
    available: true
};

function grayPixels(width: number, height: number) {
    return new Uint8ClampedArray(width * height * 4).fill(128);
}

function fake2dContext(canvas: HTMLCanvasElement) {
    const noop = () => { };
    return {
        canvas,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "low",
        fillStyle: "#000",
        drawImage() {
            canvas2d.drawImageCalls++;
        },
        getImageData(_x: number, _y: number, width: number, height: number) {
            return { data: (canvas2d.pixels ?? grayPixels)(width, height), width, height };
        },
        putImageData: noop, fillRect: noop, clearRect: noop, save: noop, restore: noop, scale: noop, translate: noop
    };
}

const canvasProto = (globalThis as { HTMLCanvasElement?: { prototype: HTMLCanvasElement; }; }).HTMLCanvasElement?.prototype;
if (canvasProto) {
    const contexts = new WeakMap<HTMLCanvasElement, ReturnType<typeof fake2dContext>>();
    (canvasProto as { getContext: unknown; }).getContext = function (this: HTMLCanvasElement, kind: string) {
        if (kind !== "2d" || !canvas2d.available) return null;
        let ctx = contexts.get(this);
        if (!ctx) contexts.set(this, ctx = fake2dContext(this));
        return ctx;
    };
}

// #endregion

// #region layout, ResizeObserver, fullscreen

export const layout = {
    /** An element now measures `size` (clientWidth/Height, offsetWidth/Height, getBoundingClientRect). */
    setSize(el: Element, size: { width: number; height: number; top?: number; left?: number; }) {
        const { width, height, top = 0, left = 0 } = size;
        for (const [key, value] of [["clientWidth", width], ["clientHeight", height], ["offsetWidth", width], ["offsetHeight", height]] as const)
            Object.defineProperty(el, key, { configurable: true, value });
        Object.defineProperty(el, "getBoundingClientRect", {
            configurable: true,
            value: () => ({ x: left, y: top, top, left, width, height, right: left + width, bottom: top + height, toJSON() { } })
        });
    }
};

type ResizeCallback = (entries: { target: Element; contentRect: { width: number; height: number; }; }[], observer: FakeResizeObserver) => void;

export class FakeResizeObserver {
    readonly callback: ResizeCallback;
    readonly targets = new Set<Element>();

    constructor(callback: ResizeCallback) {
        this.callback = callback;
        resizeObservers.list.push(this);
    }

    observe(el: Element) {
        this.targets.add(el);
    }

    unobserve(el: Element) {
        this.targets.delete(el);
    }

    disconnect() {
        this.targets.clear();
    }
}

export const resizeObservers = {
    /** every ResizeObserver created, oldest first */
    list: [] as FakeResizeObserver[],
    /** `el` changes size: layout.setSize + every observer watching it is called (wrap in act() for components) */
    resize(el: Element, size: { width: number; height: number; }) {
        layout.setSize(el, size);
        for (const ro of resizeObservers.list) {
            if (ro.targets.has(el)) ro.callback([{ target: el, contentRect: { width: size.width, height: size.height } }], ro);
        }
    }
};

(globalThis as { ResizeObserver?: unknown; }).ResizeObserver = FakeResizeObserver;

export const fullscreen = {
    /** requestFullscreen() rejects (e.g. not allowed in this frame) */
    refuse: false
};

{
    const doc = globalThis.document as Document & { fullscreenElement: Element | null; };
    let current: Element | null = null;
    const changed = () => doc.dispatchEvent(new Event("fullscreenchange"));
    Object.defineProperty(doc, "fullscreenElement", { configurable: true, get: () => current });
    Object.defineProperty(doc, "exitFullscreen", {
        configurable: true,
        value: async () => {
            current = null;
            changed();
        }
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
        configurable: true,
        value(this: Element) {
            if (fullscreen.refuse) return Promise.reject(new TypeError("fullscreen refused (fake)"));
            current = this;
            changed();
            return Promise.resolve();
        }
    });
}

// #endregion

/** Puts the media, canvas, observer and fullscreen fakes back to their defaults (the DOM itself: RTL's cleanup). */
export function resetMedia() {
    media.played.length = 0;
    media.playImpl = null;
    canvas2d.pixels = null;
    canvas2d.drawImageCalls = 0;
    canvas2d.available = true;
    resizeObservers.list.length = 0;
    fullscreen.refuse = false;
    if (document.fullscreenElement) void document.exitFullscreen();
}
