/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describeCodec, LoopbackSession } from "./loopback";
import { sleep, toDb } from "./media";
import { errorText } from "./state";
import type { AppMetricsSnapshot, AudioSample, DecodeStartup, PopoutStrategy, ReceiverRealm, RecvSample, SendSample, StatsSample, StatsSummary, WindowStats } from "./types";

const WARMUP_SEC = 3;
const SIGNAL_DB = -60;
const GET_STATS_TIMEOUT_MS = 2000;

interface Counters {
    ts: number;
    bytes: number;
    frames: number;
    totalTime: number;
    jbDelay: number;
    jbCount: number;
}

interface RecvTotals {
    framesDecoded: number;
    framesDropped: number;
    pliSent: number;
    bytes: number;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
const round1 = (v: number | null) => v == null ? null : Math.round(v * 10) / 10;

function codecOf(report: RTCStatsReport, stat: any) {
    const codec = stat?.codecId ? report.get(stat.codecId) : null;
    return codec ? describeCodec(codec) : null;
}

/**
 * getStats() with a deadline. A receiver created in the pop-out realm can disappear with its window, and its
 * pending getStats() promise then never settles, which would freeze the 1 Hz sampler forever.
 */
export function getStatsSafe(pc: RTCPeerConnection, timeoutMs = GET_STATS_TIMEOUT_MS): Promise<RTCStatsReport> {
    return Promise.race([
        pc.getStats(),
        sleep(timeoutMs).then(() => {
            throw new Error(`getStats não respondeu em ${timeoutMs} ms`);
        })
    ]);
}

function findStat(report: RTCStatsReport, type: string, kind: string): any {
    let found: any = null;
    report.forEach((s: any) => {
        if (!found && s.type === type && s.kind === kind) found = s;
    });
    return found;
}

export interface SampleMeta {
    loopbackId: number | null;
    receiverRealm: ReceiverRealm | null;
    strategy: PopoutStrategy | null;
}

/** Turns cumulative getStats() counters into per-second rates */
export class StatsCollector {
    private prev = new Map<string, Counters>();
    /** Baseline for per-sample deltas; a fresh receiver starts every counter at 0 */
    private prevRecv: RecvTotals = { framesDecoded: 0, framesDropped: 0, pliSent: 0, bytes: 0 };

    /** Call whenever the RTCPeerConnection pair is replaced (counters restart from 0) */
    reset() {
        this.prev.clear();
        this.prevRecv = { framesDecoded: 0, framesDropped: 0, pliSent: 0, bytes: 0 };
    }

    private delta(key: string, now: Counters) {
        const before = this.prev.get(key);
        this.prev.set(key, now);
        if (!before || now.ts <= before.ts) return null;

        const dtSec = (now.ts - before.ts) / 1000;
        const frames = now.frames - before.frames;
        return {
            kbps: round1((now.bytes - before.bytes) * 8 / dtSec / 1000),
            fps: round1(frames / dtSec),
            avgFrameMs: frames > 0 ? round1((now.totalTime - before.totalTime) / frames * 1000) : null,
            jitterBufferMs: now.jbCount > before.jbCount ? round1((now.jbDelay - before.jbDelay) / (now.jbCount - before.jbCount) * 1000) : null
        };
    }

    async sample(
        pcSend: RTCPeerConnection,
        pcRecv: RTCPeerConnection,
        t: number,
        meta: SampleMeta,
        cpu: AppMetricsSnapshot | null,
        captureLevel: { rms: number | null; peak: number | null; },
        receivedLevel: { rms: number | null; peak: number | null; },
        audioTrackPresent: boolean
    ): Promise<StatsSample> {
        const [sendReport, recvReport] = await Promise.all([getStatsSafe(pcSend), getStatsSafe(pcRecv)]);

        let outV: any, outA: any, srcV: any, srcA: any, transport: any;
        sendReport.forEach((s: any) => {
            if (s.type === "outbound-rtp" && s.kind === "video") outV = s;
            else if (s.type === "outbound-rtp" && s.kind === "audio") outA = s;
            else if (s.type === "media-source" && s.kind === "video") srcV = s;
            else if (s.type === "media-source" && s.kind === "audio") srcA = s;
            else if (s.type === "transport") transport = s;
        });

        let inV: any, inA: any;
        recvReport.forEach((s: any) => {
            if (s.type === "inbound-rtp" && s.kind === "video") inV = s;
            else if (s.type === "inbound-rtp" && s.kind === "audio") inA = s;
        });

        const pair: any = transport?.selectedCandidatePairId ? sendReport.get(transport.selectedCandidatePairId) : null;

        let send: SendSample | null = null;
        if (outV) {
            const d = this.delta("outV", {
                ts: outV.timestamp,
                bytes: outV.bytesSent ?? 0,
                frames: outV.framesEncoded ?? 0,
                totalTime: outV.totalEncodeTime ?? 0,
                jbDelay: 0,
                jbCount: 0
            });
            send = {
                width: num(outV.frameWidth),
                height: num(outV.frameHeight),
                fps: num(outV.framesPerSecond) ?? d?.fps ?? null,
                bitrateKbps: d?.kbps ?? null,
                targetBitrateKbps: num(outV.targetBitrate) != null ? round1(outV.targetBitrate / 1000) : null,
                availableOutgoingKbps: num(pair?.availableOutgoingBitrate) != null ? round1(pair.availableOutgoingBitrate / 1000) : null,
                encoderImplementation: outV.encoderImplementation ?? null,
                powerEfficientEncoder: typeof outV.powerEfficientEncoder === "boolean" ? outV.powerEfficientEncoder : null,
                qualityLimitationReason: outV.qualityLimitationReason ?? null,
                avgEncodeMs: d?.avgFrameMs ?? null,
                framesEncoded: num(outV.framesEncoded),
                keyFramesEncoded: num(outV.keyFramesEncoded),
                nackCount: num(outV.nackCount),
                pliCount: num(outV.pliCount),
                codec: codecOf(sendReport, outV)
            };
        }

        let recv: RecvSample | null = null;
        if (inV) {
            const d = this.delta("inV", {
                ts: inV.timestamp,
                bytes: inV.bytesReceived ?? 0,
                frames: inV.framesDecoded ?? 0,
                totalTime: inV.totalDecodeTime ?? 0,
                jbDelay: inV.jitterBufferDelay ?? 0,
                jbCount: inV.jitterBufferEmittedCount ?? 0
            });

            const totals: RecvTotals = {
                framesDecoded: inV.framesDecoded ?? 0,
                framesDropped: inV.framesDropped ?? 0,
                pliSent: inV.pliCount ?? 0,
                bytes: inV.bytesReceived ?? 0
            };
            const before = this.prevRecv;
            this.prevRecv = totals;
            const decodedDelta = totals.framesDecoded - before.framesDecoded;

            recv = {
                width: num(inV.frameWidth),
                height: num(inV.frameHeight),
                // framesPerSecond is only present once frames decode and lags a second; the delta is exact per sample
                fps: d?.fps ?? null,
                fpsReported: num(inV.framesPerSecond),
                bitrateKbps: d?.kbps ?? null,
                decoderImplementation: inV.decoderImplementation ?? null,
                powerEfficientDecoder: typeof inV.powerEfficientDecoder === "boolean" ? inV.powerEfficientDecoder : null,
                framesDecoded: num(inV.framesDecoded),
                framesDecodedDelta: decodedDelta,
                framesReceived: num(inV.framesReceived),
                keyFramesDecoded: num(inV.keyFramesDecoded),
                framesDropped: num(inV.framesDropped),
                framesDroppedDelta: totals.framesDropped - before.framesDropped,
                pliSent: num(inV.pliCount),
                pliSentDelta: totals.pliSent - before.pliSent,
                decodeStalled: totals.bytes > before.bytes ? decodedDelta === 0 : null,
                freezeCount: num(inV.freezeCount),
                avgDecodeMs: d?.avgFrameMs ?? null,
                jitterBufferMs: d?.jitterBufferMs ?? null,
                codec: codecOf(recvReport, inV)
            };
        }

        let sendAudioKbps: number | null = null;
        if (outA) {
            sendAudioKbps = this.delta("outA", { ts: outA.timestamp, bytes: outA.bytesSent ?? 0, frames: 0, totalTime: 0, jbDelay: 0, jbCount: 0 })?.kbps ?? null;
        }

        const audio: AudioSample = {
            trackPresent: audioTrackPresent,
            captureRms: captureLevel.rms,
            captureRmsDb: toDb(captureLevel.rms),
            capturePeak: captureLevel.peak,
            receivedRms: receivedLevel.rms,
            receivedRmsDb: toDb(receivedLevel.rms),
            statsCaptureLevel: num(srcA?.audioLevel),
            statsReceivedLevel: num(inA?.audioLevel),
            sendBitrateKbps: sendAudioKbps,
            codec: outA ? codecOf(sendReport, outA) : null
        };

        return {
            t: Math.round(t * 10) / 10,
            ...meta,
            source: srcV ? { width: num(srcV.width), height: num(srcV.height), fps: num(srcV.framesPerSecond) } : null,
            send,
            recv,
            audio,
            cpu
        };
    }
}

// #region Decode startup probe

const PROBE_INTERVAL_MS = 200;

/**
 * Polls a fresh receiver until its first decoded frame (framesDecoded > 0). libwebrtc decodes independently of any
 * renderer/sink, so this isolates "the decoder produced nothing" from "the sink did not show what was decoded".
 */
export async function probeFirstDecode(lb: LoopbackSession, reason: string, sinkAtStart: string, timeoutMs: number, isCancelled: () => boolean): Promise<DecodeStartup> {
    const result: DecodeStartup = {
        loopbackId: lb.id,
        receiverRealm: lb.realmName,
        codec: lb.info.negotiatedVideoCodec,
        decoderImplementation: null,
        reason,
        sinkAtStart,
        firstDecodedMs: null,
        timedOut: false,
        aborted: false,
        pliSent: null,
        keyFramesEncoded: null,
        framesDropped: null,
        framesReceived: null,
        bytesReceived: null,
        error: null
    };

    let lastError: string | null = null;
    while (true) {
        if (lb.closed || isCancelled()) {
            result.aborted = true;
            break;
        }
        if (performance.now() - lb.connectedAt > timeoutMs) {
            result.timedOut = true;
            break;
        }

        try {
            const [recvReport, sendReport] = await Promise.all([getStatsSafe(lb.pcRecv), getStatsSafe(lb.pcSend)]);
            const inV = findStat(recvReport, "inbound-rtp", "video");
            const outV = findStat(sendReport, "outbound-rtp", "video");
            lastError = null;

            if (inV) {
                result.decoderImplementation = inV.decoderImplementation ?? result.decoderImplementation;
                result.pliSent = num(inV.pliCount);
                result.framesDropped = num(inV.framesDropped);
                result.framesReceived = num(inV.framesReceived);
                result.bytesReceived = num(inV.bytesReceived);
                result.codec = codecOf(recvReport, inV) ?? result.codec;
            }
            if (outV) result.keyFramesEncoded = num(outV.keyFramesEncoded);

            if ((inV?.framesDecoded ?? 0) > 0) {
                result.firstDecodedMs = Math.round(performance.now() - lb.connectedAt);
                break;
            }
        } catch (e) {
            lastError = errorText(e);
        }

        await sleep(PROBE_INTERVAL_MS);
    }

    if (result.firstDecodedMs == null) result.error = lastError;
    return result;
}

// #endregion

// #region Summary

function avg(values: (number | null | undefined)[], decimals = 1) {
    const nums = values.filter((v): v is number => typeof v === "number");
    if (!nums.length) return null;
    const scale = 10 ** decimals;
    return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * scale) / scale;
}

function sum(values: (number | null | undefined)[]) {
    return values.reduce<number>((a, v) => a + (typeof v === "number" && v > 0 ? v : 0), 0);
}

function min(values: (number | null | undefined)[]) {
    const nums = values.filter((v): v is number => typeof v === "number");
    return nums.length ? Math.min(...nums) : null;
}

function max(values: (number | null | undefined)[]) {
    const nums = values.filter((v): v is number => typeof v === "number");
    return nums.length ? Math.max(...nums) : null;
}

function countBy(values: (string | null | undefined)[]) {
    const out: Record<string, number> = {};
    for (const v of values) if (v) out[v] = (out[v] ?? 0) + 1;
    return out;
}

function unique<T>(values: T[]) {
    return [...new Set(values)];
}

function resolutionKey(w: number | null | undefined, h: number | null | undefined) {
    return w && h ? `${w}x${h}` : null;
}

function mostCommon(counts: Record<string, number>) {
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function hardwareFrom(flags: (boolean | null)[]) {
    if (flags.includes(true)) return true;
    if (flags.length && flags.every(f => f === false)) return false;
    return null;
}

function avgByType(cpu: (AppMetricsSnapshot | null)[]) {
    const types = unique(cpu.flatMap(c => c ? Object.keys(c.byType) : []));
    const out: Record<string, number> = {};
    for (const type of types) out[type] = avg(cpu.map(c => c?.byType[type] ?? null)) ?? 0;
    return out;
}

/** Compact aggregate of the samples taken while one strategy (or one codec) was being measured */
export function windowStats(samples: StatsSample[]): WindowStats {
    const recv = samples.map(s => s.recv);
    const cpu = samples.map(s => s.cpu);
    return {
        samples: samples.length,
        recvAvgFps: avg(recv.map(r => r?.fps)),
        recvMinFps: min(recv.map(r => r?.fps)),
        recvStalledSamples: recv.filter(r => r?.decodeStalled).length,
        recvFramesDropped: sum(recv.map(r => r?.framesDroppedDelta)),
        recvPliSent: sum(recv.map(r => r?.pliSentDelta)),
        sendAvgFps: avg(samples.map(s => s.send?.fps)),
        sourceAvgFps: avg(samples.map(s => s.source?.fps)),
        decoders: unique(recv.map(r => r?.decoderImplementation).filter((v): v is string => !!v)),
        encoders: unique(samples.map(s => s.send?.encoderImplementation).filter((v): v is string => !!v)),
        cpuAvgPercentOneCore: avg(cpu.map(c => c?.totalPercentCPU)),
        cpuMaxPercentOneCore: max(cpu.map(c => c?.totalPercentCPU)),
        cpuAvgMachinePercent: avg(cpu.map(c => c?.normalizedPercentCPU)),
        cpuAvgByType: avgByType(cpu)
    };
}

export function summarize(samples: StatsSample[], target: { width: number; height: number; fps: number; }): StatsSummary {
    const steadyOnly = samples.filter(s => s.t > WARMUP_SEC);
    const steady = steadyOnly.length ? steadyOnly : samples;

    const send = steady.map(s => s.send);
    const recv = steady.map(s => s.recv);
    const audio = steady.map(s => s.audio);
    const cpu = steady.map(s => s.cpu);

    const sendResolutions = countBy(send.map(s => resolutionKey(s?.width, s?.height)));
    const sourceResolutions = countBy(steady.map(s => resolutionKey(s.source?.width, s.source?.height)));
    const avgSendFps = avg(send.map(s => s?.fps));
    const avgSourceFps = avg(steady.map(s => s.source?.fps));

    const encoderFlags = unique(send.map(s => s?.powerEfficientEncoder ?? null));
    const decoderFlags = unique(recv.map(s => s?.powerEfficientDecoder ?? null));
    const secondsWithSignal = audio.filter(a => (a.captureRmsDb ?? -100) > SIGNAL_DB).length;

    const commonSend = mostCommon(sendResolutions);
    const [sentW, sentH] = commonSend ? commonSend.split("x").map(Number) : [0, 0];
    const reachedTargetResolution = sentW >= target.width * 0.95 || sentH >= target.height * 0.95;
    const reachedTargetFps = (avgSendFps ?? 0) >= target.fps * 0.9;

    const firstLoopback = samples.find(s => s.loopbackId != null)?.loopbackId ?? null;
    const firstDecode = samples.find(s => s.loopbackId === firstLoopback && (s.recv?.framesDecoded ?? 0) > 0);
    const stalledSamples = recv.filter(r => r?.decodeStalled).length;
    const avgFpsWhileDecoding = avg(recv.filter(r => r && r.decodeStalled === false).map(r => r?.fps));

    const notes: string[] = [];
    if (!samples.length) notes.push("Nenhuma amostra coletada.");
    if (!reachedTargetResolution && commonSend) notes.push(`Resolução enviada mais comum: ${commonSend} (alvo ${target.width}x${target.height}). Se a fonte é menor que o alvo, isso é esperado.`);
    if (!reachedTargetFps && avgSourceFps != null && avgSourceFps < target.fps * 0.9)
        notes.push(`A própria captura entregou só ~${avgSourceFps} fps (media-source). A captura de tela só gera quadros quando a imagem muda: teste com vídeo/jogo em movimento.`);
    const limits = countBy(send.map(s => s?.qualityLimitationReason));
    delete limits.none;
    if (Object.keys(limits).length) notes.push(`Encoder limitado por: ${JSON.stringify(limits)} (amostras).`);
    if (stalledSamples)
        notes.push(`Recepção travada em ${stalledSamples} amostra(s): bytes chegando, 0 quadros decodificados, ${sum(recv.map(r => r?.pliSentDelta))} PLIs (pedidos de keyframe). É o decodificador rejeitando keyframes, não falta de sink nem erro de medição. FPS recebido só com decodificação ativa: ${avgFpsWhileDecoding ?? "?"}.`);
    if (samples.length && !samples.some(s => s.audio.trackPresent)) notes.push("Sem faixa de áudio no stream capturado.");
    else if (samples.length && !secondsWithSignal) notes.push(`Faixa de áudio presente, mas sem sinal acima de ${SIGNAL_DB} dBFS: havia algum som tocando?`);

    return {
        sampleCount: samples.length,
        steadySampleCount: steadyOnly.length,
        warmupSec: WARMUP_SEC,
        source: { avgFps: avgSourceFps, resolutions: sourceResolutions },
        send: {
            avgFps: avgSendFps,
            minFps: min(send.map(s => s?.fps)),
            maxFps: max(send.map(s => s?.fps)),
            avgBitrateKbps: avg(send.map(s => s?.bitrateKbps)),
            maxBitrateKbps: max(send.map(s => s?.bitrateKbps)),
            avgEncodeMs: avg(send.map(s => s?.avgEncodeMs)),
            resolutions: sendResolutions,
            encoderImplementations: unique(send.map(s => s?.encoderImplementation).filter((v): v is string => !!v)),
            powerEfficientEncoder: encoderFlags,
            qualityLimitationReasons: countBy(send.map(s => s?.qualityLimitationReason)),
            codecs: unique(send.map(s => s?.codec).filter((v): v is string => !!v))
        },
        recv: {
            avgFps: avg(recv.map(s => s?.fps)),
            avgFpsWhileDecoding,
            minFps: min(recv.map(s => s?.fps)),
            stalledSamples,
            firstDecodeSec: firstDecode?.t ?? null,
            avgBitrateKbps: avg(recv.map(s => s?.bitrateKbps)),
            avgDecodeMs: avg(recv.map(s => s?.avgDecodeMs)),
            avgJitterBufferMs: avg(recv.map(s => s?.jitterBufferMs)),
            resolutions: countBy(recv.map(s => resolutionKey(s?.width, s?.height))),
            decoderImplementations: unique(recv.map(s => s?.decoderImplementation).filter((v): v is string => !!v)),
            powerEfficientDecoder: decoderFlags,
            framesDroppedTotal: sum(samples.map(s => s.recv?.framesDroppedDelta)),
            pliSentTotal: sum(samples.map(s => s.recv?.pliSentDelta)),
            freezeCount: samples.at(-1)?.recv?.freezeCount ?? null
        },
        audio: {
            trackPresent: samples.some(s => s.audio.trackPresent),
            captureRmsAvgDb: avg(audio.map(a => a.captureRmsDb)),
            captureRmsMaxDb: max(audio.map(a => a.captureRmsDb)),
            receivedRmsAvgDb: avg(audio.map(a => a.receivedRmsDb)),
            receivedRmsMaxDb: max(audio.map(a => a.receivedRmsDb)),
            statsCaptureLevelAvg: avg(audio.map(a => a.statsCaptureLevel), 4),
            statsReceivedLevelAvg: avg(audio.map(a => a.statsReceivedLevel), 4),
            secondsWithSignal,
            avgSendBitrateKbps: avg(audio.map(a => a.sendBitrateKbps))
        },
        cpu: {
            avgTotalPercent: avg(cpu.map(c => c?.totalPercentCPU)),
            maxTotalPercent: max(cpu.map(c => c?.totalPercentCPU)),
            avgNormalizedPercent: avg(cpu.map(c => c?.normalizedPercentCPU)),
            maxNormalizedPercent: max(cpu.map(c => c?.normalizedPercentCPU)),
            avgByType: avgByType(cpu),
            methods: unique(cpu.map(c => c?.method).filter((v): v is NonNullable<typeof v> => !!v))
        },
        verdict: {
            reachedTargetResolution,
            reachedTargetFps,
            hardwareEncoder: hardwareFrom(encoderFlags),
            hardwareDecoder: hardwareFrom(decoderFlags),
            audioSignalDetected: secondsWithSignal > 0,
            notes
        }
    };
}

// #endregion
