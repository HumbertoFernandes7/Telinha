/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Leitura das estatisticas de UM RTCRtpSender de video (outbound-rtp + media-source + par de
// candidatos) e o resumo de uma janela entre duas leituras.

/**
 * O que a mesma leitura traz so para o log de estatisticas (core/statsLog.ts); a qualidade automatica nao usa nada
 * daqui. Contadores acumulados (diferenca entre duas leituras) e valores do momento; null = o Chromium nao expos.
 * Sem enderecos, portas nem SSRC: do par de candidatos, so o tipo.
 */
export interface SenderLogCounters {
    /** mimeType do codec em uso (outbound-rtp → codec), ex.: "video/VP9" */
    mimeType: string | null;
    /** targetBitrate do encoder agora (kbps) */
    targetKbps: number | null;
    packetsSent: number | null;
    retransmittedPacketsSent: number | null;
    retransmittedBytesSent: number | null;
    /** totalPacketSendDelay (segundos): espera dos pacotes no pacer */
    packetSendDelay: number | null;
    nackCount: number | null;
    pliCount: number | null;
    keyFramesEncoded: number | null;
    qpSum: number | null;
    /** remote-inbound-rtp (o que o espectador relata por RTCP): pacotes perdidos */
    packetsLost: number | null;
    /** remote-inbound-rtp: fractionLost do ultimo relatorio (0..1) */
    fractionLost: number | null;
    /** remote-inbound-rtp: roundTripTime do ultimo relatorio (ms) */
    rttMs: number | null;
    /** remote-inbound-rtp: totalRoundTripTime (segundos) e roundTripTimeMeasurements */
    rttTotal: number | null;
    rttCount: number | null;
    /** remote-inbound-rtp: jitter que o espectador mede (ms) */
    jitterMs: number | null;
    /** tipos dos candidatos do par em uso, local/remoto, ex.: "host/srflx" */
    route: string | null;
}

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
    /** powerEfficientEncoder (null = o Chromium nao expos) */
    powerEfficient: boolean | null;
    /** encoderImplementation, ex.: "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)", "libvpx" */
    implementation: string | null;
    /** so para o log (ausente = leitura sem eles) */
    log?: SenderLogCounters;
}

/**
 * Nomes de encoder por hardware no Chromium (encoderImplementation): "ExternalEncoder" (RTCVideoEncoder, nome antigo),
 * "<Plataforma>VideoEncodeAccelerator" (MediaFoundation no Windows, Vaapi/V4L2 no Linux, VideoToolbox no macOS), ou o
 * nome do fabricante entre parenteses. Software: "libvpx", "OpenH264", "libaom"...
 */
const HARDWARE_ENCODER_RE = /VideoEncodeAccelerator|ExternalEncoder|MediaFoundation|VideoToolbox|Vaapi|V4L2|NVIDIA|NVENC|QuickSync|AMF/i;

/**
 * O encoder deste sender roda na placa de video? powerEfficientEncoder decide quando o Chromium o expoe; sem ele, o
 * nome do encoder (HARDWARE_ENCODER_RE).
 */
export function isHardwareEncoder(powerEfficient: boolean | null, implementation: string | null): boolean {
    if (powerEfficient != null) return powerEfficient;
    return HARDWARE_ENCODER_RE.test(implementation ?? "");
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
    /**
     * ms de codificacao por quadro na janela (ΔtotalEncodeTime / ΔframesEncoded); null = nenhum quadro. Num encoder por
     * hardware e quase todo espera pela placa de video, que e compartilhada por todos os espectadores.
     */
    encodeMsPerFrame: number | null;
    /** o encoder roda na placa de video (isHardwareEncoder, na leitura mais recente) */
    hardware: boolean;
    /** pixels codificados por segundo na janela */
    pixelsPerSecond: number;
    frameHeight: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Os contadores so do log (SenderLogCounters) da outbound-rtp `out` e do remote-inbound-rtp dela. */
function logCounters(report: RTCStatsReport, out: any, remote: any, pair: any): SenderLogCounters {
    const target = num(out.targetBitrate);
    const rtt = num(remote?.roundTripTime);
    const jitter = num(remote?.jitter);
    const local = str(report.get(pair?.localCandidateId)?.candidateType);
    const peer = str(report.get(pair?.remoteCandidateId)?.candidateType);
    return {
        mimeType: str(out.codecId ? report.get(out.codecId)?.mimeType : null),
        targetKbps: target != null ? target / 1000 : null,
        packetsSent: num(out.packetsSent),
        retransmittedPacketsSent: num(out.retransmittedPacketsSent),
        retransmittedBytesSent: num(out.retransmittedBytesSent),
        packetSendDelay: num(out.totalPacketSendDelay),
        nackCount: num(out.nackCount),
        pliCount: num(out.pliCount),
        keyFramesEncoded: num(out.keyFramesEncoded),
        qpSum: num(out.qpSum),
        packetsLost: num(remote?.packetsLost),
        fractionLost: num(remote?.fractionLost),
        rttMs: rtt != null ? rtt * 1000 : null,
        rttTotal: num(remote?.totalRoundTripTime),
        rttCount: num(remote?.roundTripTimeMeasurements),
        jitterMs: jitter != null ? jitter * 1000 : null,
        route: local || peer ? `${local ?? "?"}/${peer ?? "?"}` : null
    };
}

export async function readSenderSample(sender: RTCRtpSender): Promise<SenderSample | null> {
    const report = await sender.getStats();
    let out: any = null;
    let source: any = null;
    let transport: any = null;
    const pairs: any[] = [];
    const remotes: any[] = [];
    report.forEach((s: any) => {
        if (s.type === "outbound-rtp" && s.kind === "video") {
            if (!out || (s.bytesSent ?? 0) > (out.bytesSent ?? 0)) out = s;
        } else if (s.type === "media-source" && s.kind === "video") source = s;
        else if (s.type === "transport") transport = s;
        else if (s.type === "candidate-pair") pairs.push(s);
        else if (s.type === "remote-inbound-rtp" && s.kind === "video") remotes.push(s);
    });
    if (!out) return null;

    const pair = (transport?.selectedCandidatePairId && report.get(transport.selectedCandidatePairId))
        || pairs.find(p => p.nominated && p.state === "succeeded" && num(p.availableOutgoingBitrate) != null);
    const available = num(pair?.availableOutgoingBitrate);
    const durations = out.qualityLimitationDurations;
    const remote = remotes.find(r => r.localId === out.id) ?? (remotes.length === 1 ? remotes[0] : null);

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
        availableKbps: available != null ? available / 1000 : null,
        powerEfficient: typeof out.powerEfficientEncoder === "boolean" ? out.powerEfficientEncoder : null,
        implementation: typeof out.encoderImplementation === "string" ? out.encoderImplementation : null,
        log: safeLogCounters(report, out, remote, pair)
    };
}

/** logCounters sem nunca derrubar a leitura: o log e so diagnostico, a qualidade automatica precisa do resto. */
function safeLogCounters(report: RTCStatsReport, out: any, remote: any, pair: any): SenderLogCounters | undefined {
    try {
        return logCounters(report, out, remote, pair);
    } catch {
        return undefined;
    }
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
        encodeMsPerFrame: frames > 0 && encodeTime >= 0 ? encodeTime / frames * 1000 : null,
        hardware: isHardwareEncoder(cur.powerEfficient, cur.implementation),
        pixelsPerSecond: cur.frameWidth * cur.frameHeight * encodedFps,
        frameHeight: cur.frameHeight
    };
}
