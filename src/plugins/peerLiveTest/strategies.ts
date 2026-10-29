/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ways of putting the received video into a host container (pop-out or floating panel), and how each one is
// measured. Every sink feeds a FrameCounter: <video> sinks count requestVideoFrameCallback callbacks in the
// document that shows the video; <canvas> sinks count frames actually drawn into the pop-out canvas.

import { sleep } from "./media";
import { errorText } from "./state";
import type { PopoutStrategy, SinkMeasurement } from "./types";

export const STRATEGY_LABELS: Record<PopoutStrategy, string> = {
    direct: "Direto: stream da janela principal no <video> do pop-out",
    realm: "Realm: RTCPeerConnection receptor criado no pop-out",
    canvas: "Canvas: <video> oculto na principal → <canvas> no pop-out",
    trackProcessor: "TrackProcessor: VideoFrames → <canvas> no pop-out",
    control: "Controle: painel flutuante no app (mesmo documento do receptor)"
};

export const STRATEGY_SHORT: Record<PopoutStrategy, string> = {
    direct: "Direto",
    realm: "Realm",
    canvas: "Canvas",
    trackProcessor: "TrackProcessor",
    control: "Controle (painel)"
};

/**
 * Default: "direct". With GPU acceleration on it already played at ~49 fps in the pop-out (capture-…03-43-10), and
 * it keeps the RTCPeerConnection in the main window, so closing/reopening the pop-out never touches the connection.
 */
export const DEFAULT_STRATEGY: PopoutStrategy = "direct";

/** Main-window receiver strategies first (they reuse the running receiver); realm last (needs a new receiver) */
export const TEST_ALL_ORDER: PopoutStrategy[] = ["control", "direct", "canvas", "trackProcessor", "realm"];

export class UnsupportedStrategyError extends Error {
    name = "UnsupportedStrategyError";
}

export class FrameCounter {
    frames = 0;
    firstFrameAt: number | null = null;
    width = 0;
    height = 0;
    missed = 0;
    drawMsTotal = 0;
    draws = 0;
    readonly errors: string[] = [];
    private lastPresented: number | null = null;

    onFrame(width: number, height: number, presentedFrames: number | null, drawMs?: number) {
        this.frames++;
        this.firstFrameAt ??= performance.now();
        this.width = width;
        this.height = height;

        if (presentedFrames != null) {
            if (this.lastPresented != null && presentedFrames > this.lastPresented + 1) this.missed += presentedFrames - this.lastPresented - 1;
            this.lastPresented = presentedFrames;
        }

        if (drawMs != null) {
            this.drawMsTotal += drawMs;
            this.draws++;
        }
    }

    error(msg: string) {
        if (this.errors.length < 10) this.errors.push(msg);
    }
}

export interface Sink {
    strategy: PopoutStrategy;
    counter: FrameCounter;
    /** performance.now() when attached */
    attachedAt: number;
    playbackQuality(): VideoPlaybackQuality | null;
    detach(): void;
}

const FILL_STYLE = {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    background: "#000"
};

const HIDDEN_STYLE = {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "64px",
    height: "36px",
    opacity: "0.01",
    pointerEvents: "none",
    zIndex: "-1"
};

/** <video> created by the container's own document, playing `stream` (which may come from any realm) */
export function attachVideoSink(strategy: PopoutStrategy, container: HTMLDivElement, stream: MediaStream): Sink {
    const counter = new FrameCounter();
    const video = container.ownerDocument.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    Object.assign(video.style, FILL_STYLE);
    container.appendChild(video);

    let stopped = false;
    let handle = 0;
    const hasRvfc = typeof video.requestVideoFrameCallback === "function";
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
        if (stopped) return;
        counter.onFrame(meta.width, meta.height, meta.presentedFrames);
        handle = video.requestVideoFrameCallback(onFrame);
    };
    if (hasRvfc) handle = video.requestVideoFrameCallback(onFrame);
    else counter.error("requestVideoFrameCallback indisponível neste <video>");

    video.srcObject = stream;
    video.play().catch(e => counter.error("play(): " + errorText(e)));

    return {
        strategy,
        counter,
        attachedAt: performance.now(),
        playbackQuality: () => video.getVideoPlaybackQuality?.() ?? null,
        detach() {
            stopped = true;
            try {
                if (hasRvfc) video.cancelVideoFrameCallback(handle);
                video.pause();
                video.srcObject = null;
                video.remove();
            } catch { }
        }
    };
}

function createPopoutCanvas(container: HTMLDivElement) {
    const canvas = container.ownerDocument.createElement("canvas");
    Object.assign(canvas.style, FILL_STYLE);
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
        canvas.remove();
        throw new Error("getContext(\"2d\") retornou null no documento do pop-out");
    }
    return { canvas, ctx };
}

function drawInto(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number) {
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    ctx.drawImage(source, 0, 0, width, height);
}

/**
 * Main-window <video> (almost invisible, like Path B's check) plays the received track; on every new frame
 * (rVFC) it is drawn into a <canvas> that lives in the pop-out document.
 * Caveat: rVFC on the hidden video follows the MAIN window's rendering; if that window is minimized, it may throttle.
 */
export function attachCanvasSink(container: HTMLDivElement, track: MediaStreamTrack): Sink {
    const counter = new FrameCounter();
    const { canvas, ctx } = createPopoutCanvas(container);

    const hidden = document.createElement("video");
    hidden.muted = true;
    hidden.autoplay = true;
    hidden.playsInline = true;
    Object.assign(hidden.style, HIDDEN_STYLE);
    document.body.appendChild(hidden);

    let stopped = false;
    let handle = 0;
    const onFrame: VideoFrameRequestCallback = (_now, meta) => {
        if (stopped) return;
        const t0 = performance.now();
        try {
            drawInto(canvas, ctx, hidden, meta.width, meta.height);
            counter.onFrame(meta.width, meta.height, meta.presentedFrames, performance.now() - t0);
        } catch (e) {
            counter.error("drawImage: " + errorText(e));
        }
        handle = hidden.requestVideoFrameCallback(onFrame);
    };
    handle = hidden.requestVideoFrameCallback(onFrame);

    hidden.srcObject = new MediaStream([track]);
    hidden.play().catch(e => counter.error("play() do vídeo oculto: " + errorText(e)));

    return {
        strategy: "canvas",
        counter,
        attachedAt: performance.now(),
        playbackQuality: () => null,
        detach() {
            stopped = true;
            try {
                hidden.cancelVideoFrameCallback(handle);
                hidden.pause();
                hidden.srcObject = null;
                hidden.remove();
                canvas.remove();
            } catch { }
        }
    };
}

/** MediaStreamTrackProcessor (main window) → VideoFrame → drawImage into a <canvas> in the pop-out. No hidden <video>. */
export function attachTrackProcessorSink(container: HTMLDivElement, track: MediaStreamTrack): Sink {
    const Processor = (window as any).MediaStreamTrackProcessor;
    if (typeof Processor !== "function") throw new UnsupportedStrategyError("MediaStreamTrackProcessor não existe na janela principal");

    const counter = new FrameCounter();
    const { canvas, ctx } = createPopoutCanvas(container);
    // a clone, so cancelling the reader / stopping it never ends the receiver's own track
    const clone = track.clone();
    let reader: ReadableStreamDefaultReader<VideoFrame>;
    try {
        reader = new Processor({ track: clone }).readable.getReader();
    } catch (e) {
        clone.stop();
        canvas.remove();
        throw e;
    }

    let stopped = false;
    void (async () => {
        while (!stopped) {
            let res: ReadableStreamReadResult<VideoFrame>;
            try {
                res = await reader.read();
            } catch (e) {
                if (!stopped) counter.error("read(): " + errorText(e));
                return;
            }
            if (res.done) return;

            const frame = res.value;
            const t0 = performance.now();
            try {
                if (!stopped) {
                    drawInto(canvas, ctx, frame, frame.displayWidth, frame.displayHeight);
                    counter.onFrame(frame.displayWidth, frame.displayHeight, null, performance.now() - t0);
                }
            } catch (e) {
                counter.error("drawImage(VideoFrame): " + errorText(e));
            } finally {
                frame.close();
            }
        }
    })();

    return {
        strategy: "trackProcessor",
        counter,
        attachedAt: performance.now(),
        playbackQuality: () => null,
        detach() {
            stopped = true;
            reader.cancel().catch(() => { });
            clone.stop();
            canvas.remove();
        }
    };
}

export interface MeasureOptions {
    firstFrameTimeoutMs: number;
    measureMs: number;
    /** Returns why to stop early, or null to keep going */
    stopReason(): string | null;
    /** Converts performance.now() into StatsSample.t */
    toStatsT(perf: number): number;
}

/** Waits for the sink's first frame, then counts frames for `measureMs` */
export async function measureSink(sink: Sink, o: MeasureOptions): Promise<SinkMeasurement> {
    const { counter } = sink;
    const m: SinkMeasurement = {
        ok: false,
        firstFrameMs: null,
        measureMs: 0,
        frames: 0,
        fps: null,
        missedFrames: null,
        sinkDroppedFrames: null,
        width: null,
        height: null,
        avgDrawMs: null,
        errors: [],
        error: null,
        aborted: null,
        windowStartT: null,
        windowEndT: null
    };

    while (!counter.frames) {
        const reason = o.stopReason();
        if (reason) {
            m.aborted = reason;
            m.errors = [...counter.errors];
            return m;
        }
        if (performance.now() - sink.attachedAt > o.firstFrameTimeoutMs) {
            m.error = `nenhum quadro chegou ao sink em ${o.firstFrameTimeoutMs / 1000} s`;
            m.errors = [...counter.errors];
            return m;
        }
        await sleep(100);
    }

    m.firstFrameMs = Math.round(counter.firstFrameAt! - sink.attachedAt);

    const frames0 = counter.frames;
    const missed0 = counter.missed;
    const drawMs0 = counter.drawMsTotal;
    const draws0 = counter.draws;
    const quality0 = sink.playbackQuality();
    const start = performance.now();

    while (performance.now() - start < o.measureMs) {
        const reason = o.stopReason();
        if (reason) {
            m.aborted = reason;
            break;
        }
        await sleep(100);
    }

    const end = performance.now();
    const quality1 = sink.playbackQuality();
    m.measureMs = Math.round(end - start);
    m.frames = counter.frames - frames0;
    m.fps = Math.round(m.frames / ((end - start) / 1000) * 10) / 10;
    m.missedFrames = sink.strategy === "trackProcessor" ? null : counter.missed - missed0;
    if (quality0 && quality1) m.sinkDroppedFrames = quality1.droppedVideoFrames - quality0.droppedVideoFrames;
    m.width = counter.width || null;
    m.height = counter.height || null;
    const draws = counter.draws - draws0;
    m.avgDrawMs = draws ? Math.round((counter.drawMsTotal - drawMs0) / draws * 100) / 100 : null;
    m.errors = [...counter.errors];
    m.windowStartT = o.toStatsT(start);
    m.windowEndT = o.toStatsT(end);
    m.ok = !m.aborted && m.frames >= 2;
    if (!m.ok && !m.aborted) m.error = `só ${m.frames} quadro(s) em ${m.measureMs} ms`;

    return m;
}
