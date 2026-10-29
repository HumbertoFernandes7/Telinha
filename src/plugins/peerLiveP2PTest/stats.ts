/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Leitura de RTCStatsReport. REGRA: nunca copiar endereco IP para fora daqui; so o
// tipo do candidato, o protocolo e a familia do endereco (IPv4/IPv6/mDNS).
// A pagina tools/p2p-test/p2p-test.js tem uma copia desta logica.

export type AddressFamily = "IPv4" | "IPv6" | "mDNS" | "desconhecido";

export type CandidatePairInfo = {
    localType: string;
    remoteType: string;
    protocol: string;
    localFamily: AddressFamily;
    remoteFamily: AddressFamily;
    /** protocolo ate o TURN (so existe para candidato relay) */
    relayProtocol?: string;
    /** ex.: wifi, ethernet (nem sempre disponivel) */
    networkType?: string;
    /** RTT STUN do par selecionado, em ms */
    rttMs?: number;
};

export type InboundSample = {
    dir: "in";
    rttMs?: number;
    fps?: number;
    width?: number;
    height?: number;
    kbps?: number;
    audioKbps?: number;
    packetsLost?: number;
    lossPct?: number;
    jitterMs?: number;
    framesDecoded?: number;
    framesDropped?: number;
    freezeCount?: number;
    decoder?: string;
};

export type OutboundSample = {
    dir: "out";
    rttMs?: number;
    fps?: number;
    width?: number;
    height?: number;
    kbps?: number;
    qualityLimitation?: string;
    remoteLossPct?: number;
    nackCount?: number;
    pliCount?: number;
    encoder?: string;
};

export function addressFamily(address: unknown): AddressFamily {
    if (typeof address !== "string" || !address) return "desconhecido";
    if (address.endsWith(".local")) return "mDNS";
    if (address.includes(":")) return "IPv6";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return "IPv4";
    return "desconhecido";
}

function findSelectedPair(report: RTCStatsReport): any {
    let pair: any;
    report.forEach((s: any) => {
        if (pair) return;
        if (s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
    });
    if (pair) return pair;
    report.forEach((s: any) => {
        if (s.type !== "candidate-pair") return;
        if (s.selected || (s.nominated && s.state === "succeeded")) pair ??= s;
    });
    return pair;
}

/**
 * O Chromium esconde o endereco de candidatos host nas stats (vem ""). Nesse caso procura a
 * linha a=candidate com a mesma porta/protocolo/tipo no SDP so para descobrir a familia.
 */
function familyFromSdp(sdp: string | null | undefined, cand: any): AddressFamily {
    if (!sdp || typeof cand?.port !== "number") return "desconhecido";
    for (const line of sdp.split(/\r?\n/)) {
        // a=candidate:<foundation> <componente> <protocolo> <prioridade> <endereco> <porta> typ <tipo>
        const m = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/i.exec(line);
        if (!m || Number(m[3]) !== cand.port) continue;
        if (cand.protocol && m[1].toLowerCase() !== String(cand.protocol).toLowerCase()) continue;
        if (cand.candidateType && m[4] !== cand.candidateType) continue;
        return addressFamily(m[2]);
    }
    return "desconhecido";
}

function candidateFamily(cand: any, sdp: string | null | undefined): AddressFamily {
    const fromStats = addressFamily(cand.address ?? cand.ip);
    return fromStats !== "desconhecido" ? fromStats : familyFromSdp(sdp, cand);
}

export function describeSelectedPair(report: RTCStatsReport, pc?: RTCPeerConnection): CandidatePairInfo | null {
    const pair = findSelectedPair(report);
    if (!pair) return null;
    const local: any = report.get(pair.localCandidateId) ?? {};
    const remote: any = report.get(pair.remoteCandidateId) ?? {};
    return {
        localType: local.candidateType ?? "?",
        remoteType: remote.candidateType ?? "?",
        protocol: local.protocol ?? remote.protocol ?? "?",
        localFamily: candidateFamily(local, pc?.localDescription?.sdp),
        remoteFamily: candidateFamily(remote, pc?.remoteDescription?.sdp),
        relayProtocol: local.relayProtocol,
        networkType: local.networkType,
        rttMs: typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : undefined
    };
}

export function samePair(a: CandidatePairInfo | null | undefined, b: CandidatePairInfo | null | undefined) {
    if (!a || !b) return a === b;
    return a.localType === b.localType && a.remoteType === b.remoteType && a.protocol === b.protocol
        && a.localFamily === b.localFamily && a.remoteFamily === b.remoteFamily;
}

export function pairLabel(p: CandidatePairInfo | null | undefined) {
    if (!p) return "—";
    const relay = p.relayProtocol ? ` via TURN/${p.relayProtocol}` : "";
    return `${p.localType} ↔ ${p.remoteType} · ${p.protocol.toUpperCase()} · ${p.localFamily}/${p.remoteFamily}${relay}`;
}

const round = (n: number | undefined, d = 0) => (typeof n === "number" && isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : undefined);

/** Calcula taxas (kbps) a partir de amostras consecutivas; uma instancia por conexao/direcao. */
export class StatsSampler {
    private prev = new Map<string, { bytes: number; ts: number; }>();

    private rate(key: string, bytes: number | undefined, ts: number) {
        if (typeof bytes !== "number") return undefined;
        const prev = this.prev.get(key);
        this.prev.set(key, { bytes, ts });
        if (!prev || ts <= prev.ts || bytes < prev.bytes) return undefined;
        return ((bytes - prev.bytes) * 8) / (ts - prev.ts); // bits/ms == kbps
    }

    inbound(report: RTCStatsReport): InboundSample {
        const out: InboundSample = { dir: "in" };
        let video: any, audio: any;
        report.forEach((s: any) => {
            if (s.type !== "inbound-rtp") return;
            if (s.kind === "video" && (!video || (s.bytesReceived ?? 0) > (video.bytesReceived ?? 0))) video = s;
            if (s.kind === "audio" && !audio) audio = s;
        });
        const pair = findSelectedPair(report);
        if (pair && typeof pair.currentRoundTripTime === "number") out.rttMs = round(pair.currentRoundTripTime * 1000, 1);
        if (video) {
            out.fps = round(video.framesPerSecond, 1);
            out.width = video.frameWidth;
            out.height = video.frameHeight;
            out.kbps = round(this.rate("in-video", video.bytesReceived, video.timestamp));
            out.packetsLost = video.packetsLost;
            const total = (video.packetsReceived ?? 0) + (video.packetsLost ?? 0);
            out.lossPct = total > 0 ? round(((video.packetsLost ?? 0) / total) * 100, 2) : undefined;
            out.jitterMs = typeof video.jitter === "number" ? round(video.jitter * 1000, 1) : undefined;
            out.framesDecoded = video.framesDecoded;
            out.framesDropped = video.framesDropped;
            out.freezeCount = video.freezeCount;
            out.decoder = video.decoderImplementation;
        }
        if (audio) out.audioKbps = round(this.rate("in-audio", audio.bytesReceived, audio.timestamp));
        return out;
    }

    outbound(report: RTCStatsReport): OutboundSample {
        const out: OutboundSample = { dir: "out" };
        let video: any, remoteIn: any;
        report.forEach((s: any) => {
            if (s.type === "outbound-rtp" && s.kind === "video" && (!video || (s.bytesSent ?? 0) > (video.bytesSent ?? 0))) video = s;
            if (s.type === "remote-inbound-rtp" && s.kind === "video") remoteIn = s;
        });
        const pair = findSelectedPair(report);
        if (pair && typeof pair.currentRoundTripTime === "number") out.rttMs = round(pair.currentRoundTripTime * 1000, 1);
        if (video) {
            out.fps = round(video.framesPerSecond, 1);
            out.width = video.frameWidth;
            out.height = video.frameHeight;
            out.kbps = round(this.rate("out-video", video.bytesSent, video.timestamp));
            out.qualityLimitation = video.qualityLimitationReason;
            out.nackCount = video.nackCount;
            out.pliCount = video.pliCount;
            out.encoder = video.encoderImplementation;
        }
        if (remoteIn && typeof remoteIn.fractionLost === "number") out.remoteLossPct = round(remoteIn.fractionLost * 100, 2);
        return out;
    }
}
