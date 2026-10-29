/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { errorText } from "./state";
import type { PlaybackCheck } from "./types";

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function toDb(rms: number | null) {
    if (rms == null) return null;
    return rms > 0 ? Math.max(-100, Math.round(20 * Math.log10(rms) * 10) / 10) : -100;
}

/**
 * Measures the level of an audio track with WebAudio. Never connected to the speakers.
 *
 * Remote WebRTC tracks only deliver samples to WebAudio while they are also attached to a media element
 * (long-standing Chromium quirk), so `attachSink` plays the track through a muted <audio>.
 * That element doubles as the opt-in "ouvir áudio" output.
 */
export class AudioMeter {
    private readonly ctx: AudioContext;
    private readonly analyser: AnalyserNode;
    private readonly buf: Float32Array<ArrayBuffer>;
    private readonly timer: number;
    private readonly sink: HTMLAudioElement | null = null;
    private sumSquares = 0;
    private count = 0;
    private peak = 0;

    constructor(track: MediaStreamTrack, attachSink: boolean) {
        const stream = new MediaStream([track]);

        if (attachSink) {
            this.sink = new Audio();
            this.sink.muted = true;
            this.sink.srcObject = stream;
            this.sink.play().catch(() => { });
        }

        this.ctx = new AudioContext();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.ctx.createMediaStreamSource(stream).connect(this.analyser);
        this.buf = new Float32Array(this.analyser.fftSize);
        this.ctx.resume().catch(() => { });

        this.timer = window.setInterval(() => this.poll(), 100);
    }

    private poll() {
        this.analyser.getFloatTimeDomainData(this.buf);

        let sum = 0;
        let peak = 0;
        for (const v of this.buf) {
            sum += v * v;
            const abs = Math.abs(v);
            if (abs > peak) peak = abs;
        }

        this.sumSquares += sum / this.buf.length;
        this.count++;
        if (peak > this.peak) this.peak = peak;
    }

    /** RMS / peak (linear 0..1) since the previous call */
    take() {
        if (!this.count) return { rms: null, peak: null };

        const result = {
            rms: Math.round(Math.sqrt(this.sumSquares / this.count) * 10000) / 10000,
            peak: Math.round(this.peak * 10000) / 10000
        };
        this.sumSquares = this.count = this.peak = 0;
        return result;
    }

    setListening(listen: boolean) {
        if (this.sink) this.sink.muted = !listen;
    }

    close() {
        clearInterval(this.timer);
        this.ctx.close().catch(() => { });
        if (this.sink) {
            this.sink.pause();
            this.sink.srcObject = null;
        }
    }
}

/**
 * Waits for the first frame (videoWidth > 0), then counts frames handed to the compositor
 * with requestVideoFrameCallback for `measureMs`.
 */
export async function verifyVideoPlayback(video: HTMLVideoElement, where: string, measureMs = 3000): Promise<PlaybackCheck> {
    const result: PlaybackCheck = {
        ok: false,
        where,
        videoWidth: 0,
        videoHeight: 0,
        waitedForMetadataMs: 0,
        rvfcSupported: typeof video.requestVideoFrameCallback === "function",
        framesCounted: 0,
        measureMs,
        measuredFps: null,
        presentedFramesDelta: null,
        droppedFramesDelta: null,
        error: null
    };

    try {
        const t0 = performance.now();
        while (video.videoWidth === 0 && performance.now() - t0 < 6000) await sleep(100);
        result.waitedForMetadataMs = Math.round(performance.now() - t0);
        result.videoWidth = video.videoWidth;
        result.videoHeight = video.videoHeight;

        if (!video.videoWidth) {
            result.error = "videoWidth continuou 0 após 6 s (nenhum quadro chegou ao <video>)";
            return result;
        }

        const quality0 = video.getVideoPlaybackQuality?.();
        let firstPresented: number | null = null;
        let lastPresented: number | null = null;
        let handle = 0;
        let done = false;

        if (result.rvfcSupported) {
            const onFrame: VideoFrameRequestCallback = (_now, meta) => {
                if (done) return;
                result.framesCounted++;
                firstPresented ??= meta.presentedFrames;
                lastPresented = meta.presentedFrames;
                handle = video.requestVideoFrameCallback(onFrame);
            };
            handle = video.requestVideoFrameCallback(onFrame);
        }

        const start = performance.now();
        await sleep(measureMs);
        done = true;
        const elapsed = performance.now() - start;
        if (result.rvfcSupported) video.cancelVideoFrameCallback(handle);

        const quality1 = video.getVideoPlaybackQuality?.();
        if (quality0 && quality1) {
            result.droppedFramesDelta = quality1.droppedVideoFrames - quality0.droppedVideoFrames;
            if (!result.rvfcSupported) result.framesCounted = quality1.totalVideoFrames - quality0.totalVideoFrames;
        }

        if (firstPresented != null && lastPresented != null) result.presentedFramesDelta = lastPresented - firstPresented;
        result.measuredFps = Math.round(result.framesCounted / (elapsed / 1000) * 10) / 10;
        result.videoWidth = video.videoWidth;
        result.videoHeight = video.videoHeight;
        result.ok = result.framesCounted >= 2;
        if (!result.ok) result.error = `Só ${result.framesCounted} quadro(s) em ${measureMs} ms (imagem parada? tente uma fonte com movimento)`;
    } catch (e) {
        result.error = errorText(e);
    }

    return result;
}

/** Plays a stream in a tiny, almost invisible <video> on the main window just long enough to verify frames arrive */
export async function measureStreamPlayback(stream: MediaStream, where: string, measureMs = 2000): Promise<PlaybackCheck> {
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    Object.assign(video.style, {
        position: "fixed",
        right: "0",
        bottom: "0",
        width: "64px",
        height: "36px",
        opacity: "0.01",
        pointerEvents: "none",
        zIndex: "-1"
    });
    document.body.appendChild(video);

    try {
        video.srcObject = stream;
        await video.play().catch(() => { });
        return await verifyVideoPlayback(video, where, measureMs);
    } finally {
        video.srcObject = null;
        video.remove();
    }
}
