/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describeCodec } from "./loopback";
import { toDb } from "./media";
import type { AppMetricsSnapshot, AudioSample, RecvSample, SendSample, StatsSample, StatsSummary } from "./types";

const WARMUP_SEC = 3;
const SIGNAL_DB = -60;

interface Counters {
    ts: number;
    bytes: number;
    frames: number;
    totalTime: number;
    jbDelay: number;
    jbCount: number;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
const round1 = (v: number | null) => v == null ? null : Math.round(v * 10) / 10;

function codecOf(report: RTCStatsReport, stat: any) {
    const codec = stat?.codecId ? report.get(stat.codecId) : null;
    return codec ? describeCodec(codec) : null;
}

/** Turns cumulative getStats() counters into per-second rates */
export class StatsCollector {
    private prev = new Map<string, Counters>();

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
        cpu: AppMetricsSnapshot | null,
        captureLevel: { rms: number | null; peak: number | null; },
        receivedLevel: { rms: number | null; peak: number | null; },
        audioTrackPresent: boolean
    ): Promise<StatsSample> {
        const [sendReport, recvReport] = await Promise.all([pcSend.getStats(), pcRecv.getStats()]);

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
            recv = {
                width: num(inV.frameWidth),
                height: num(inV.frameHeight),
                fps: num(inV.framesPerSecond) ?? d?.fps ?? null,
                bitrateKbps: d?.kbps ?? null,
                decoderImplementation: inV.decoderImplementation ?? null,
                powerEfficientDecoder: typeof inV.powerEfficientDecoder === "boolean" ? inV.powerEfficientDecoder : null,
                framesDecoded: num(inV.framesDecoded),
                framesDropped: num(inV.framesDropped),
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
            source: srcV ? { width: num(srcV.width), height: num(srcV.height), fps: num(srcV.framesPerSecond) } : null,
            send,
            recv,
            audio,
            cpu
        };
    }
}

// #region Summary

function avg(values: (number | null | undefined)[], decimals = 1) {
    const nums = values.filter((v): v is number => typeof v === "number");
    if (!nums.length) return null;
    const scale = 10 ** decimals;
    return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * scale) / scale;
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

    const cpuTypes = unique(cpu.flatMap(c => c ? Object.keys(c.byType) : []));
    const avgByType: Record<string, number> = {};
    for (const type of cpuTypes) avgByType[type] = avg(cpu.map(c => c?.byType[type] ?? null)) ?? 0;

    const encoderFlags = unique(send.map(s => s?.powerEfficientEncoder ?? null));
    const decoderFlags = unique(recv.map(s => s?.powerEfficientDecoder ?? null));
    const secondsWithSignal = audio.filter(a => (a.captureRmsDb ?? -100) > SIGNAL_DB).length;

    const commonSend = mostCommon(sendResolutions);
    const [sentW, sentH] = commonSend ? commonSend.split("x").map(Number) : [0, 0];
    const reachedTargetResolution = sentW >= target.width * 0.95 || sentH >= target.height * 0.95;
    const reachedTargetFps = (avgSendFps ?? 0) >= target.fps * 0.9;
    const lastRecv = samples.at(-1)?.recv;

    const notes: string[] = [];
    if (!samples.length) notes.push("Nenhuma amostra coletada.");
    if (!reachedTargetResolution && commonSend) notes.push(`Resolução enviada mais comum: ${commonSend} (alvo ${target.width}x${target.height}). Se a fonte é menor que o alvo, isso é esperado.`);
    if (!reachedTargetFps && avgSourceFps != null && avgSourceFps < target.fps * 0.9)
        notes.push(`A própria captura entregou só ~${avgSourceFps} fps (media-source). A captura de tela só gera quadros quando a imagem muda: teste com vídeo/jogo em movimento.`);
    const limits = countBy(send.map(s => s?.qualityLimitationReason));
    delete limits.none;
    if (Object.keys(limits).length) notes.push(`Encoder limitado por: ${JSON.stringify(limits)} (amostras).`);
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
            minFps: min(recv.map(s => s?.fps)),
            avgBitrateKbps: avg(recv.map(s => s?.bitrateKbps)),
            avgDecodeMs: avg(recv.map(s => s?.avgDecodeMs)),
            avgJitterBufferMs: avg(recv.map(s => s?.jitterBufferMs)),
            resolutions: countBy(recv.map(s => resolutionKey(s?.width, s?.height))),
            decoderImplementations: unique(recv.map(s => s?.decoderImplementation).filter((v): v is string => !!v)),
            powerEfficientDecoder: decoderFlags,
            framesDroppedTotal: lastRecv?.framesDropped ?? null,
            freezeCount: lastRecv?.freezeCount ?? null
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
            avgByType
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
