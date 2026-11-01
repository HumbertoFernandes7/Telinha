/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-B: harness of the auto quality (core/quality/controller.ts) shared by its test files, plus a model of ONE shared
// hardware video encoder (NVENC) built from the times measured on a RTX 3070. The controller tests drive the
// controller directly: a FakeRTCRtpSender per viewer reports an EncoderSim, and evaluate() runs every 2 s of fake
// time, as streaming.ts → tick does.

import { QualityController, type QualityDeps } from "@plugins/telinha/core/quality/controller";
import { encodingFor, scaledSize } from "@plugins/telinha/core/quality/levels";
import { getEventLog, type TelinhaEvent } from "@plugins/telinha/store";
import type { QualityLevel } from "@plugins/telinha/types";
import type { FakeClock } from "@test/fakes/clock";
import { type EncoderRates, EncoderSim, FakeRTCRtpSender, videoTrack } from "@test/fakes/webrtc";

export const EVAL_MS = 2000;

/** The Telinha log lines written while `fn` runs. */
export async function logsDuring(fn: () => Promise<unknown> | unknown): Promise<string[]> {
    const seen = new Set<TelinhaEvent>(getEventLog());
    await fn();
    return getEventLog().filter(e => !seen.has(e)).map(e => e.msg);
}

/** Only the auto quality's decisions ("Qualidade automática: ..."). */
export const qualityLines = (lines: string[]) => lines.filter(l => l.startsWith("Qualidade automática:"));

export interface AppliedLevel {
    peerId: string;
    level: QualityLevel;
    /** ms since the harness was created */
    atMs: number;
}

export interface QualityHarness {
    controller: QualityController;
    /** every apply (setParameters) the controller asked for, oldest first */
    applied: AppliedLevel[];
    /** deps.changed() calls */
    changes: number;
    readonly senders: Map<string, FakeRTCRtpSender>;
    /** what apply answers (default: true); throw/reject to make it fail */
    applyImpl: (peerId: string, level: QualityLevel) => boolean | Promise<boolean>;
    /** called synchronously on every apply, before applyImpl (the GPU model follows the levels here) */
    onApply: ((peerId: string, level: QualityLevel) => void) | null;
    /** a sender for `peerId` whose stats come from `sim` */
    attach(peerId: string, sim: EncoderSim): FakeRTCRtpSender;
    /** ms since the harness was created */
    elapsed(): number;
    /** advances the clock to `atMs` (since creation) and runs one evaluation */
    evaluateAt(atMs: number): Promise<void>;
    /** one evaluation every EVAL_MS (on the 2 s grid) after the current time, up to `atMs` inclusive */
    runUntil(atMs: number): Promise<void>;
    /** addViewer + markReady, then lets the apply promise settle */
    join(peerId: string, gpu?: boolean): Promise<void>;
    /** the last level applied to `peerId` (undefined = never) */
    lastApplied(peerId: string): QualityLevel | undefined;
}

export function qualityHarness(clock: FakeClock, sims: Record<string, EncoderSim> = {}, deps: Partial<QualityDeps> = {}): QualityHarness {
    const start = clock.now();
    const senders = new Map<string, FakeRTCRtpSender>();
    const h: QualityHarness = {
        controller: null as unknown as QualityController,
        applied: [],
        changes: 0,
        senders,
        applyImpl: () => true,
        onApply: null,
        attach(peerId, sim) {
            const sender = new FakeRTCRtpSender(videoTrack());
            sim.attach(sender);
            senders.set(peerId, sender);
            return sender;
        },
        elapsed: () => clock.now() - start,
        async evaluateAt(atMs) {
            clock.tick(Math.max(0, atMs - h.elapsed()));
            await h.controller.evaluate();
        },
        async runUntil(atMs) {
            for (let at = (Math.floor(h.elapsed() / EVAL_MS) + 1) * EVAL_MS; at <= atMs; at += EVAL_MS) await h.evaluateAt(at);
        },
        async join(peerId, gpu) {
            h.controller.addViewer(peerId, gpu);
            h.controller.markReady(peerId);
            await Promise.resolve();
        },
        lastApplied: peerId => h.applied.filter(a => a.peerId === peerId).at(-1)?.level
    };
    for (const [peerId, sim] of Object.entries(sims)) h.attach(peerId, sim);
    h.controller = new QualityController({
        ceiling: "1080p60",
        enabled: () => true,
        sender: peerId => (senders.get(peerId) ?? null) as unknown as RTCRtpSender | null,
        apply: async (peerId, level) => {
            h.applied.push({ peerId, level, atMs: h.elapsed() });
            h.onApply?.(peerId, level);
            return h.applyImpl(peerId, level);
        },
        label: peerId => peerId,
        captureSize: () => ({ width: 1920, height: 1080 }),
        motion: () => null,
        sourceFrames: () => { },
        changed: () => {
            h.changes++;
        },
        ...deps
    });
    return h;
}

// #region the bandwidth estimator probing a level's ceiling

/** Where PROBE_SAWTOOTH lands after each backoff. */
export const PROBE_LOW_KBPS = 9600;

/**
 * The bandwidth estimator (GCC) probing the 12 Mbps ceiling of 720p60 on a ~10 Mbps path: it climbs to 12 Mbps,
 * overshoots the path and backs off to 9.6 Mbps (0.8x: a backoff for the controller) after 6, 10 and 14 s, over and
 * over. One estimate per 2 s window, indexed by the window's start / EVAL_MS.
 */
export const PROBE_SAWTOOTH: readonly number[] = [3, 5, 7].flatMap(n => Array.from({ length: n }, (_, k) => PROBE_LOW_KBPS + 2400 * k / (n - 1)));

/**
 * Window by window from now up to `to`: `each` sets the sims for the window that ends EVAL_MS later, with its estimate
 * from PROBE_SAWTOOTH and whether that estimate is one of the backoffs.
 */
export async function probeSawtooth(h: QualityHarness, to: number, each: (estKbps: number, backoff: boolean) => void) {
    for (let at = h.elapsed(); at < to; at += EVAL_MS) {
        const est = PROBE_SAWTOOTH[Math.floor(at / EVAL_MS) % PROBE_SAWTOOTH.length];
        each(est, est === PROBE_LOW_KBPS);
        await h.runUntil(at + EVAL_MS);
    }
}

// #endregion

// #region one shared hardware encoder

/** encoderImplementation of Chromium's hardware H.264 encoder on Windows with an NVIDIA card */
export const NVENC_IMPLEMENTATION = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";

/** What the GPU sim measured on the RTX 3070 (29/10/2026): median ms per frame by load in 1080p60-viewer units. */
export const RTX3070_MS: readonly (readonly [load: number, ms: number])[] = [[1, 4.3], [5, 8.9], [8, 12.4], [9, 14.5], [10, 188]];

const RATE_1080P60 = 1920 * 1080 * 60;

/** Linear between the measured points, extrapolated from the first segment below it, flat above the last one. */
export function measuredFrameMs(load: number, table: readonly (readonly [number, number])[] = RTX3070_MS): number {
    const [first, second] = table;
    if (load <= first[0]) return first[1] + (load - first[0]) * (second[1] - first[1]) / (second[0] - first[0]);
    for (let i = 1; i < table.length; i++) {
        const [l0, m0] = table[i - 1];
        const [l1, m1] = table[i];
        if (load <= l1) return m0 + (load - l0) * (m1 - m0) / (l1 - l0);
    }
    return table[table.length - 1][1];
}

interface GpuViewer {
    sim: EncoderSim;
    /** what the controller applied last; null = the encoder has not started */
    level: QualityLevel | null;
}

/**
 * One hardware video encoder shared by every viewer's encoder: each sim reports the same per-frame time, read from the
 * measured table at the total load (sum of the encoded pixel rates, in 1080p60 viewers), times `factor` (2 = a GPU
 * twice as slow). Follows the levels the controller applies (harness.onApply).
 */
export class GpuSim {
    readonly viewers = new Map<string, GpuViewer>();
    factor: number;
    readonly capture: { width: number; height: number; };

    constructor(readonly h: QualityHarness, opts: { factor?: number; capture?: { width: number; height: number; }; } = {}) {
        this.factor = opts.factor ?? 1;
        this.capture = opts.capture ?? { width: 1920, height: 1080 };
        h.onApply = (peerId, level) => {
            const v = this.viewers.get(peerId);
            if (!v) return;
            v.level = level;
            this.recompute();
        };
    }

    /** A viewer whose encoder will run on this GPU: its sender reports a hardware H.264 encoder. */
    add(peerId: string, rates: Partial<EncoderRates> = {}): EncoderSim {
        const sim = new EncoderSim({
            mimeType: "video/H264", implementation: NVENC_IMPLEMENTATION, powerEfficient: true, ...this.capture, ...rates
        });
        this.h.attach(peerId, sim);
        this.viewers.set(peerId, { sim, level: null });
        this.recompute();
        return sim;
    }

    /** add + controller.addViewer(peerId, true) + markReady (the controller applies its level: the encoder starts). */
    async join(peerId: string) {
        this.add(peerId);
        await this.h.join(peerId, true);
    }

    leave(peerId: string) {
        this.viewers.delete(peerId);
        this.h.controller.removeViewer(peerId);
        this.recompute();
    }

    /** Load now, in 1080p60 viewers. */
    load(): number {
        let rate = 0;
        for (const v of this.viewers.values()) {
            if (!v.level) continue;
            const s = this.size(v.level);
            rate += s.width * s.height * Math.min(v.sim.rates.fps, s.fps);
        }
        return rate / RATE_1080P60;
    }

    frameMs(): number {
        return measuredFrameMs(this.load()) * this.factor;
    }

    private size(level: QualityLevel) {
        const e = encodingFor(level, this.capture.width, this.capture.height);
        return { ...scaledSize(this.capture.width, this.capture.height, e.scaleResolutionDownBy), fps: e.maxFramerate };
    }

    private recompute() {
        const ms = this.frameMs();
        for (const v of this.viewers.values()) {
            const s = v.level ? this.size(v.level) : { ...this.capture, fps: 60 };
            v.sim.set({ width: s.width, height: s.height, fps: s.fps, encodeBusy: ms * s.fps / 1000 });
        }
    }
}

// #endregion
