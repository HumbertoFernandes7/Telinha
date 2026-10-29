/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Leitura das estatisticas de UM RTCRtpSender de video (outbound-rtp + media-source + par de
// candidatos) e o resumo de uma janela entre duas leituras.

/** Contadores acumulados de uma leitura. */
export interface SenderSample {
    /** performance.now() */
    at: number;
    framesEncoded: number;
    /** segundos */
    totalEncodeTime: number;
    bytesSent: number;
    /** qualityLimitationDurations (segundos acumulados por motivo), se o Chromium expuser */
    limitation: { cpu: number; bandwidth: number; } | null;
    reason: string | null;
    frameWidth: number;
    frameHeight: number;
    /** quadros que a fonte (captura) entregou a ESTE sender */
    sourceFrames: number | null;
    sourceFps: number | null;
    availableKbps: number | null;
}

/** Resumo da janela entre duas leituras do mesmo sender. */
export interface WindowMetrics {
    /** segundos */
    dt: number;
    encodedFps: number;
    sourceFps: number | null;
    /** fracao da janela limitada por CPU / banda (0..1) */
    cpuFraction: number;
    bandwidthFraction: number;
    sentKbps: number;
    availableKbps: number | null;
    /** fracao do tempo de parede codificando (ΔtotalEncodeTime / Δt); ~ uso do detector de sobrecarga do WebRTC */
    encodeBusy: number | null;
    /** pixels codificados por segundo na janela */
    pixelsPerSecond: number;
    frameHeight: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function readSenderSample(sender: RTCRtpSender): Promise<SenderSample | null> {
    const report = await sender.getStats();
    let out: any = null;
    let source: any = null;
    let transport: any = null;
    const pairs: any[] = [];
    report.forEach((s: any) => {
        if (s.type === "outbound-rtp" && s.kind === "video") {
            if (!out || (s.bytesSent ?? 0) > (out.bytesSent ?? 0)) out = s;
        } else if (s.type === "media-source" && s.kind === "video") source = s;
        else if (s.type === "transport") transport = s;
        else if (s.type === "candidate-pair") pairs.push(s);
    });
    if (!out) return null;

    const pair = (transport?.selectedCandidatePairId && report.get(transport.selectedCandidatePairId))
        || pairs.find(p => p.nominated && p.state === "succeeded" && num(p.availableOutgoingBitrate) != null);
    const available = num(pair?.availableOutgoingBitrate);
    const durations = out.qualityLimitationDurations;

    return {
        at: performance.now(),
        framesEncoded: num(out.framesEncoded) ?? 0,
        totalEncodeTime: num(out.totalEncodeTime) ?? 0,
        bytesSent: num(out.bytesSent) ?? 0,
        limitation: durations && typeof durations === "object"
            ? { cpu: num(durations.cpu) ?? 0, bandwidth: num(durations.bandwidth) ?? 0 }
            : null,
        reason: typeof out.qualityLimitationReason === "string" ? out.qualityLimitationReason : null,
        frameWidth: num(out.frameWidth) ?? 0,
        frameHeight: num(out.frameHeight) ?? 0,
        sourceFrames: num(source?.frames),
        sourceFps: num(source?.framesPerSecond),
        availableKbps: available != null ? available / 1000 : null
    };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Null quando a janela e curta demais ou os contadores voltaram (sender trocado). */
export function diffSamples(prev: SenderSample, cur: SenderSample): WindowMetrics | null {
    const dt = (cur.at - prev.at) / 1000;
    const frames = cur.framesEncoded - prev.framesEncoded;
    if (dt < 0.5 || frames < 0 || cur.bytesSent < prev.bytesSent) return null;

    let cpuFraction: number;
    let bandwidthFraction: number;
    if (prev.limitation && cur.limitation) {
        cpuFraction = clamp01((cur.limitation.cpu - prev.limitation.cpu) / dt);
        bandwidthFraction = clamp01((cur.limitation.bandwidth - prev.limitation.bandwidth) / dt);
    } else {
        cpuFraction = cur.reason === "cpu" ? 1 : 0;
        bandwidthFraction = cur.reason === "bandwidth" ? 1 : 0;
    }

    const sourceFps = cur.sourceFrames != null && prev.sourceFrames != null && cur.sourceFrames >= prev.sourceFrames
        ? (cur.sourceFrames - prev.sourceFrames) / dt
        : cur.sourceFps;
    const encodedFps = frames / dt;
    const encodeTime = cur.totalEncodeTime - prev.totalEncodeTime;

    return {
        dt,
        encodedFps,
        sourceFps,
        cpuFraction,
        bandwidthFraction,
        sentKbps: (cur.bytesSent - prev.bytesSent) * 8 / 1000 / dt,
        availableKbps: cur.availableKbps,
        encodeBusy: frames > 0 && encodeTime >= 0 ? encodeTime / dt : null,
        pixelsPerSecond: cur.frameWidth * cur.frameHeight * encodedFps,
        frameHeight: cur.frameHeight
    };
}
