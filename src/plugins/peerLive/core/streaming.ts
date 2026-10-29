/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Transmitir: captura (handler de display media do native.ts) + envio do stream so para quem pediu.

import { STREAM_KIND_SCREEN } from "@plugins/peerLive/protocol";
import { type CodecSetting, settings } from "@plugins/peerLive/settings";
import type { CaptureSource, PeerId, Quality, StreamInfo, StreamOptions } from "@plugins/peerLive/types";

import { chooseCodec, type CodecDecision, getLocalCaps } from "./codec";
import { getPc, type LocalCapture, peerLabel, publish, rt, setLastError } from "./context";
import { errorText, log, logThrottled } from "./log";
import { getNative } from "./nativeApi";
import type { SendPlan } from "./peerConnection";
import { sendPresence } from "./presence";

export interface QualityProfile {
    width: number;
    height: number;
    fps: number;
    /** teto do encoder (RTCRtpSender maxBitrate) e x-google-max-bitrate */
    maxKbps: number;
    /** x-google-start-bitrate: o estimador de banda comeca aqui em vez de ~300 kbps */
    startKbps: number;
}

/** Perfis de qualidade. startKbps ≈ 60% do teto: sobe direto para a resolucao cheia sem estourar links medianos. */
export const QUALITY: Record<Quality, QualityProfile> = {
    "1080p60": { width: 1920, height: 1080, fps: 60, maxKbps: 8000, startKbps: 5000 },
    "720p60": { width: 1280, height: 720, fps: 60, maxKbps: 5000, startKbps: 3000 },
    "1080p30": { width: 1920, height: 1080, fps: 30, maxKbps: 5000, startKbps: 3000 }
};

const SOURCE_ID_RE = /^(screen|window):-?\d{1,20}:-?\d{1,10}$/;

interface ViewerSend {
    decision: CodecDecision;
    /** codec que o encoder realmente usa (lido das estatisticas), para logar uma vez */
    reportedCodec?: string;
}

const sends = new Map<PeerId, ViewerSend>();
let starting = false;

/** Plano de envio consultado pela RTCPeerConnection na negociacao (peerConnection.ts). */
export function sendPlanFor(peerId: PeerId | null): SendPlan | null {
    const { local } = rt;
    if (!peerId || !local || !local.viewers.has(peerId)) return null;
    const send = sends.get(peerId);
    const q = QUALITY[local.quality];
    return {
        codec: send?.decision.codec ?? null,
        bitrate: { startKbps: q.startKbps, maxKbps: q.maxKbps },
        label: peerLabel(peerId)
    };
}

function captureErrorMessage(e: any, handlerCalled: boolean | null): string {
    const name = e?.name ?? "";
    const msg = String(e?.message ?? e ?? "");
    if (/activation|gesture/i.test(msg)) return "O Discord só permite iniciar a captura logo após um clique. Tente de novo.";
    if (handlerCalled === false) return "O pedido de captura não chegou ao PeerLive (outro plugin pode estar interceptando a captura de tela).";
    if (name === "NotAllowedError") return "A captura foi recusada. Se a janela foi fechada, escolha outra.";
    if (name === "NotFoundError" || name === "NotReadableError" || name === "AbortError") return "Não foi possível capturar essa fonte (a janela foi fechada ou está protegida).";
    return "Falha ao capturar: " + errorText(e);
}

function validateOptions(opts: StreamOptions) {
    const source = opts?.source as CaptureSource | undefined;
    if (!source || typeof source.id !== "string" || !SOURCE_ID_RE.test(source.id)) throw new Error("Fonte de captura inválida.");
    if (!QUALITY[opts.quality]) throw new Error("Qualidade inválida.");
    return { source, profile: QUALITY[opts.quality] };
}

export async function startStreaming(opts: StreamOptions): Promise<void> {
    if (starting) throw new Error("A transmissão já está sendo iniciada.");
    if (!rt.room) {
        const msg = "Entre em um canal de voz para transmitir.";
        setLastError(msg);
        throw new Error(msg);
    }

    const { source, profile } = validateOptions(opts);
    const kind = source.id.startsWith("screen:") ? "screen" : "window";
    // v1: tela inteira nunca leva audio (o audio do PC incluiria as vozes da call)
    const wantAudio = !!opts.withAudio && kind === "window";
    starting = true;

    try {
        const native = getNative();
        log.info(`Iniciando transmissão: ${kind === "screen" ? "tela" : "janela"} "${source.name}" em ${opts.quality}${wantAudio ? " com áudio" : " sem áudio"}`);

        // Nada de await longo entre o clique e o getDisplayMedia: a busca do PID para o audio roda no
        // main em paralelo e o handler espera por ela (ver native.ts).
        await native.prepareDisplayMedia(source.id, source.name, wantAudio);

        let stream: MediaStream;
        let handlerCalled: boolean | null = null;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: profile.width, max: profile.width },
                    height: { ideal: profile.height, max: profile.height },
                    frameRate: { ideal: profile.fps, max: profile.fps }
                },
                audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
            });
        } catch (e) {
            const report = await native.finishDisplayMedia().catch(() => null);
            handlerCalled = report ? report.handlerCalled : false;
            if (report?.error) log.warn("Handler de captura: " + report.error);
            throw new Error(captureErrorMessage(e, handlerCalled));
        }

        const report = await native.finishDisplayMedia().catch(() => null);
        const [video] = stream.getVideoTracks();
        const [audio] = stream.getAudioTracks();
        if (!video) {
            stream.getTracks().forEach(t => t.stop());
            throw new Error("A captura veio sem vídeo.");
        }
        if (!rt.room) {
            stream.getTracks().forEach(t => t.stop());
            throw new Error("Você saiu do canal de voz enquanto a transmissão começava.");
        }

        video.contentHint = "motion";
        if (audio) audio.contentHint = "music";
        if (wantAudio) log.info(`Áudio: ${audio ? "capturando" : "sem faixa de áudio"} — ${report?.audio?.reason ?? "sem decisão do handler"}`);

        const s = video.getSettings();
        const info: StreamInfo = {
            kind,
            title: source.name.slice(0, 200),
            hasAudio: !!audio,
            width: Math.round(s.width ?? profile.width),
            height: Math.round(s.height ?? profile.height),
            fps: Math.round(s.frameRate ?? profile.fps)
        };

        // trocar de fonte com a transmissao no ar: os espectadores atuais recebem a nova
        const previous = rt.local;
        const keepViewers = previous ? [...previous.viewers] : [];
        if (previous) stopCapture(previous, "trocando de fonte");

        const local: LocalCapture = { stream, source: { ...source }, quality: opts.quality, info, startedAt: Date.now(), viewers: new Set() };
        rt.local = local;
        rt.lastError = null;

        video.addEventListener("ended", () => {
            if (rt.local !== local) return;
            log.warn("A captura terminou sozinha (janela fechada ou captura interrompida pelo sistema)");
            stopStreaming("a captura terminou");
            setLastError("A transmissão parou: a janela foi fechada ou a captura foi interrompida.");
        });

        log.info(`Transmitindo ${info.width}x${info.height} @ ${info.fps} fps${info.hasAudio ? " com áudio" : ""}`);
        sendPresence();
        for (const peerId of keepViewers) sendTo(peerId);
        publish();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("Não foi possível transmitir: " + msg);
        setLastError(msg);
        throw e instanceof Error ? e : new Error(msg);
    } finally {
        starting = false;
    }
}

/** Remove o stream de todos os espectadores e para a captura (sem mexer na presenca). */
function stopCapture(local: LocalCapture, reason: string) {
    const viewers = [...local.viewers];
    local.viewers.clear();
    for (const v of viewers) sends.delete(v);
    if (rt.room && viewers.length) {
        try {
            rt.room.removeStream(local.stream, { target: viewers });
        } catch (e) {
            log.warn("Falha ao remover o stream dos espectadores: " + errorText(e));
        }
    }
    local.stream.getTracks().forEach(t => t.stop());
    if (rt.local === local) rt.local = null;
    log.info(`Transmissão encerrada (${reason})`);
}

export function stopStreaming(reason = "parada pelo usuário") {
    const { local } = rt;
    if (!local) return;
    stopCapture(local, reason);
    sendPresence();
    publish();
}

/** Comeca a mandar a captura atual para um espectador. */
function sendTo(peerId: PeerId) {
    const { local, room } = rt;
    const entry = rt.peers.get(peerId);
    if (!local || !room || !entry) return;
    if (!entry.admitted) {
        logThrottled(`watch-refused:${peerId}`, "warn", `${peerLabel(peerId)} pediu para assistir, mas não está no seu canal de voz: recusado`);
        return;
    }
    if (local.viewers.has(peerId)) return;

    const decision = chooseCodec(entry.presence?.caps, settings.store.codec as CodecSetting, getLocalCaps());
    sends.set(peerId, { decision });
    local.viewers.add(peerId);
    log.info(`Enviando para ${peerLabel(peerId)}: codec ${decision.codec.toUpperCase()} (${decision.reason})`);
    if (decision.codec === "h264" && entry.presence?.caps.h264HwDecode !== true)
        log.warn(`${peerLabel(peerId)} não decodifica H.264 por hardware: o início pode travar por 15+ s`);
    publish();

    Promise.all(room.addStream(local.stream, { target: peerId, metadata: { kind: STREAM_KIND_SCREEN } }))
        .then(() => {
            if (rt.local === local && local.viewers.has(peerId)) void applySenderParams(peerId, local, true);
        })
        .catch(e => {
            log.error(`Falha ao enviar o stream para ${peerLabel(peerId)}: ${errorText(e)}`);
            if (local.viewers.delete(peerId)) {
                sends.delete(peerId);
                publish();
            }
        });
}

function removeFrom(peerId: PeerId, reason: string) {
    const { local } = rt;
    sends.delete(peerId);
    if (!local?.viewers.delete(peerId)) return;
    try {
        rt.room?.removeStream(local.stream, { target: peerId });
    } catch (e) {
        log.warn("Falha ao remover o stream: " + errorText(e));
    }
    log.info(`${peerLabel(peerId)} deixou de receber a transmissão (${reason})`);
    publish();
}

/**
 * Parametros do sender de video para um espectador: teto de bitrate/fps da qualidade, prioridade alta
 * e degradationPreference "maintain-framerate" (cai resolucao antes de fps). Tenta de novo uma vez.
 */
async function applySenderParams(peerId: PeerId, local: LocalCapture, retry: boolean) {
    const pc = getPc(peerId);
    const tracks = local.stream.getVideoTracks();
    const sender = pc?.getSenders().find(s => s.track && tracks.includes(s.track));
    if (!sender) {
        log.warn(`Sem RTCRtpSender de vídeo para ${peerLabel(peerId)}; parâmetros de envio não aplicados`);
        return;
    }

    const q = QUALITY[local.quality];
    const build = (withDegradation: boolean) => {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        Object.assign(params.encodings[0], {
            maxBitrate: q.maxKbps * 1000,
            maxFramerate: q.fps,
            priority: "high",
            networkPriority: "high"
        });
        if (withDegradation) (params as any).degradationPreference = "maintain-framerate";
        return params;
    };

    try {
        await sender.setParameters(build(true));
        log.info(`Envio para ${peerLabel(peerId)}: até ${q.maxKbps} kbps @ ${q.fps} fps, prioriza fps`);
    } catch (e) {
        try {
            await sender.setParameters(build(false));
            log.warn(`Envio para ${peerLabel(peerId)}: degradationPreference recusado (${errorText(e)}); teto ${q.maxKbps} kbps @ ${q.fps} fps aplicado`);
        } catch (e2) {
            if (retry) {
                setTimeout(() => {
                    if (rt.local === local && local.viewers.has(peerId)) void applySenderParams(peerId, local, false);
                }, 1500);
            } else {
                log.error(`setParameters falhou para ${peerLabel(peerId)}: ${errorText(e2)}`);
            }
        }
    }
}

// #region eventos vindos da sessao

export function onWatchRequest(peerId: PeerId, op: "start" | "stop") {
    if (op === "stop") {
        removeFrom(peerId, "parou de assistir");
        return;
    }
    if (!rt.local) {
        logThrottled(`watch-idle:${peerId}`, "info", `${peerLabel(peerId)} pediu para assistir, mas você não está transmitindo`);
        sendPresence(peerId);
        return;
    }
    sendTo(peerId);
}

export function onPeerGone(peerId: PeerId) {
    sends.delete(peerId);
    if (rt.local?.viewers.delete(peerId)) publish();
}

/** O peer deixou de ser admitido (saiu do canal de voz): para de mandar a transmissao para ele. */
export function onAdmissionLost(peerId: PeerId) {
    removeFrom(peerId, "saiu do seu canal de voz");
}

/** A sala vai ser fechada: encerra a transmissao antes (a captura nao sobrevive a troca de canal). */
export function onRoomClosing(reason: string) {
    if (!rt.local) return;
    stopStreaming(reason);
}

/** Uma vez por segundo: loga o codec que o encoder realmente usa por espectador (uma vez). */
export function tick() {
    const { local } = rt;
    if (!local) return;
    for (const peerId of local.viewers) {
        const send = sends.get(peerId);
        if (!send || send.reportedCodec) continue;
        const pc = getPc(peerId);
        const tracks = local.stream.getVideoTracks();
        const sender = pc?.getSenders().find(s => s.track && tracks.includes(s.track));
        if (!sender) continue;
        sender.getStats().then(report => {
            let codecId: string | undefined;
            let encoder: string | undefined;
            let powerEfficient: boolean | undefined;
            report.forEach((s: any) => {
                if (s.type === "outbound-rtp" && s.kind === "video") {
                    codecId = s.codecId;
                    encoder = s.encoderImplementation;
                    powerEfficient = s.powerEfficientEncoder;
                }
            });
            const codec = codecId ? (report.get(codecId) as any)?.mimeType : undefined;
            if (!codec || send.reportedCodec || sends.get(peerId) !== send) return;
            send.reportedCodec = codec;
            const expected = `video/${send.decision.codec}`.toLowerCase();
            const msg = `Codificando para ${peerLabel(peerId)}: ${codec}${encoder ? ` (${encoder}${powerEfficient ? ", hardware" : ""})` : ""}`;
            if (codec.toLowerCase() === expected) log.info(msg);
            else log.warn(`${msg} — esperado ${send.decision.codec.toUpperCase()}`);
        }).catch(() => { });
    }
}

// #endregion
