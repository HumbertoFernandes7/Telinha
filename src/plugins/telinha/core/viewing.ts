/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Assistir: pede o stream ao transmissor, recebe no onPeerStream, detecta o primeiro quadro
// decodificado pelas estatisticas do receiver e publica estatisticas basicas a cada 2 s.

import { type PresenceMessage, STREAM_KIND_SCREEN, type WatchReplyMessage } from "@plugins/telinha/protocol";
import type { PeerId, ViewDeniedReason } from "@plugins/telinha/types";
import type { JsonValue } from "trystero";

import { getPc, peerLabel, publish, rt, type ViewerEntry } from "./context";
import { errorText, log, logThrottled } from "./log";

const RESPONSE_TIMEOUT_MS = 20_000;
/** o transmissor pediu para esperar a aprovacao dele (60 s do lado dele + folga de rede) */
const APPROVAL_WAIT_MS = 75_000;

/** Frase pronta (pt-BR) para cada recusa do transmissor; vai em ViewerSession.error. */
const DENIED_TEXT: Record<ViewDeniedReason, string> = {
    kicked: "O transmissor encerrou a sua visualização.",
    declined: "O transmissor recusou o seu pedido para assistir.",
    timeout: "O transmissor não respondeu ao pedido a tempo. Você pode pedir de novo.",
    duplicate: "Outra conexão na call diz ser você, então o transmissor bloqueou as duas por segurança. Se você acabou de reabrir o Discord, espere alguns segundos e tente de novo."
};
const FIRST_FRAME_TIMEOUT_MS = 45_000;
const FIRST_FRAME_POLL_MS = 150;

function sendWatch(peerId: PeerId, op: "start" | "stop") {
    return rt.watchAction?.send({ op }, { target: peerId }) ?? Promise.resolve();
}

function runCleanup(list: (() => void)[]) {
    for (const fn of list.splice(0)) {
        try {
            fn();
        } catch { }
    }
}

function fail(v: ViewerEntry, message: string, keepStream = false) {
    if (rt.viewing.get(v.peerId) !== v) return;
    runCleanup(v.requestCleanup);
    if (!keepStream) {
        runCleanup(v.streamCleanup);
        v.stream = null;
    }
    v.status = "error";
    v.error = message;
    v.awaitingApproval = false;
    log.warn(`Assistir ${peerLabel(v.peerId)}: ${message}`);
    publish();
}

/** O transmissor encerrou/recusou a nossa visualizacao: para de esperar e mostra o motivo. */
function denied(v: ViewerEntry, reason: ViewDeniedReason) {
    if (rt.viewing.get(v.peerId) !== v) return;
    runCleanup(v.requestCleanup);
    runCleanup(v.streamCleanup);
    v.stream = null;
    v.stats = undefined;
    v.status = "error";
    v.error = DENIED_TEXT[reason];
    v.denied = reason;
    v.awaitingApproval = false;
    log.warn(`Assistir ${peerLabel(v.peerId)}: ${DENIED_TEXT[reason]}`);
    publish();
}

/** Resposta do transmissor a um pedido nosso (protocol.ts, passo 5). Sem sessao para esse peer: ignorada. */
export function onWatchReply(peerId: PeerId, reply: WatchReplyMessage) {
    const v = rt.viewing.get(peerId);
    if (!v) return;
    if (reply.op === "denied") {
        denied(v, reply.reason);
        return;
    }
    if (v.status !== "connecting" || v.awaitingApproval) return;
    v.awaitingApproval = true;
    runCleanup(v.requestCleanup);
    const timer = setTimeout(() => {
        if (v.status === "connecting") fail(v, "O transmissor não respondeu ao pedido a tempo.");
    }, APPROVAL_WAIT_MS);
    v.requestCleanup.push(() => clearTimeout(timer));
    log.info(`Assistir ${peerLabel(peerId)}: esperando o transmissor aprovar o pedido`);
    publish();
}

function end(v: ViewerEntry, reason: string) {
    if (rt.viewing.get(v.peerId) !== v || v.status === "ended") return;
    runCleanup(v.requestCleanup);
    runCleanup(v.streamCleanup);
    v.stream = null;
    v.status = "ended";
    v.error = undefined;
    v.stats = undefined;
    log.info(`Assistir ${peerLabel(v.peerId)}: ${reason}`);
    publish();
}

export function watch(peerId: PeerId) {
    const existing = rt.viewing.get(peerId);
    if (existing && (existing.status === "connecting" || existing.status === "waiting-first-frame" || existing.status === "playing")) return;
    if (existing) {
        runCleanup(existing.requestCleanup);
        runCleanup(existing.streamCleanup);
    }

    const v: ViewerEntry = {
        peerId,
        status: "connecting",
        stream: null,
        requestedAt: performance.now(),
        firstFrameAt: null,
        meter: null,
        requestCleanup: [],
        streamCleanup: []
    };
    rt.viewing.set(peerId, v);
    publish();

    const entry = rt.peers.get(peerId);
    if (!rt.room || !rt.watchAction) return fail(v, "Você não está em um canal de voz com o Telinha ativo.");
    if (!entry || entry.incompatible) return fail(v, "Esse amigo não está mais na call.");
    if (!entry.admitted) return fail(v, "Essa pessoa não está no seu canal de voz.");
    if (!entry.presence?.streaming) return fail(v, "Esse amigo não está transmitindo agora.");

    log.info(`Assistir ${peerLabel(peerId)}: pedido enviado`);
    sendWatch(peerId, "start").catch(e => fail(v, "Falha ao pedir a transmissão: " + errorText(e)));

    const timer = setTimeout(() => {
        if (v.status === "connecting") fail(v, "O amigo não respondeu ao pedido para assistir.");
    }, RESPONSE_TIMEOUT_MS);
    v.requestCleanup.push(() => clearTimeout(timer));
}

export function unwatch(peerId: PeerId) {
    const v = rt.viewing.get(peerId);
    if (!v) return;
    runCleanup(v.requestCleanup);
    runCleanup(v.streamCleanup);
    rt.viewing.delete(peerId);
    if (rt.peers.has(peerId)) sendWatch(peerId, "stop").catch(() => { });
    log.info(`Parou de assistir ${peerLabel(peerId)}`);
    publish();
}

/** Sai da sala / plugin parado: descarta tudo sem avisar ninguem. */
export function clearAll() {
    for (const v of rt.viewing.values()) {
        runCleanup(v.requestCleanup);
        runCleanup(v.streamCleanup);
    }
    rt.viewing.clear();
    publish();
}

// #region recepcao

function videoReceiver(v: ViewerEntry) {
    const track = v.stream?.getVideoTracks()[0];
    if (!track) return null;
    return getPc(v.peerId)?.getReceivers().find(r => r.track === track) ?? null;
}

interface InboundSample {
    framesDecoded: number;
    width: number;
    height: number;
    fps: number | null;
    bytes: number;
    codec: string | null;
    decoder: string | null;
    powerEfficient: boolean | null;
}

async function sample(v: ViewerEntry): Promise<InboundSample | null> {
    const pc = getPc(v.peerId);
    const tracks = v.stream?.getTracks() ?? [];
    if (!pc || !tracks.length) return null;
    const receivers = pc.getReceivers().filter(r => tracks.includes(r.track));
    const video = videoReceiver(v);
    if (!video) return null;

    const out: InboundSample = { framesDecoded: 0, width: 0, height: 0, fps: null, bytes: 0, codec: null, decoder: null, powerEfficient: null };
    for (const r of receivers) {
        const report = await r.getStats();
        report.forEach((s: any) => {
            if (s.type !== "inbound-rtp") return;
            out.bytes += s.bytesReceived ?? 0;
            if (r !== video || s.kind !== "video") return;
            out.framesDecoded = s.framesDecoded ?? 0;
            out.width = s.frameWidth ?? 0;
            out.height = s.frameHeight ?? 0;
            out.fps = typeof s.framesPerSecond === "number" ? s.framesPerSecond : null;
            out.decoder = s.decoderImplementation ?? null;
            out.powerEfficient = typeof s.powerEfficientDecoder === "boolean" ? s.powerEfficientDecoder : null;
            if (s.codecId) out.codec = (report.get(s.codecId) as any)?.mimeType ?? null;
        });
    }
    return out;
}

function onFirstFrame(v: ViewerEntry, s: InboundSample) {
    v.firstFrameAt = performance.now();
    runCleanup(v.requestCleanup);
    v.status = "playing";
    v.error = undefined;
    const ms = Math.round(v.firstFrameAt - v.requestedAt);
    const dec = s.decoder ? `, decodificador ${s.decoder}${s.powerEfficient ? " (hardware)" : ""}` : "";
    log.info(`Assistir ${peerLabel(v.peerId)}: primeiro quadro em ${ms} ms (${s.codec ?? "codec ?"}, ${s.width}x${s.height}${dec})`);
    publish();
}

function attachStream(v: ViewerEntry, stream: MediaStream) {
    runCleanup(v.streamCleanup);
    v.stream = stream;
    v.status = "waiting-first-frame";
    v.error = undefined;
    v.denied = undefined;
    v.awaitingApproval = false;
    v.stats = undefined;
    v.firstFrameAt = null;
    v.meter = null;
    log.info(`Assistir ${peerLabel(v.peerId)}: stream recebido em ${Math.round(performance.now() - v.requestedAt)} ms (${stream.getVideoTracks().length} vídeo, ${stream.getAudioTracks().length} áudio)`);

    const onRemoveTrack = () => {
        if (v.stream === stream && !stream.getVideoTracks().some(t => t.readyState === "live")) end(v, "a transmissão foi encerrada");
    };
    stream.addEventListener("removetrack", onRemoveTrack);
    v.streamCleanup.push(() => stream.removeEventListener("removetrack", onRemoveTrack));

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
        const onEnded = () => {
            if (v.stream === stream) end(v, "a transmissão foi encerrada");
        };
        videoTrack.addEventListener("ended", onEnded);
        v.streamCleanup.push(() => videoTrack.removeEventListener("ended", onEnded));
    }

    // primeiro quadro: consulta rapida as estatisticas do receiver ate framesDecoded > 0
    const startedAt = performance.now();
    let busy = false;
    const poll = setInterval(async () => {
        if (busy || v.stream !== stream || v.firstFrameAt != null) return;
        if (performance.now() - startedAt > FIRST_FRAME_TIMEOUT_MS) {
            clearInterval(poll);
            fail(v, "Nenhum quadro de vídeo chegou em 45 s (rede ou decodificador travado). Continua tentando.", true);
            return;
        }
        busy = true;
        try {
            const s = await sample(v);
            if (s && s.framesDecoded > 0 && v.stream === stream && v.firstFrameAt == null) {
                clearInterval(poll);
                onFirstFrame(v, s);
            }
        } catch { } finally {
            busy = false;
        }
    }, FIRST_FRAME_POLL_MS);
    v.streamCleanup.push(() => clearInterval(poll));
    publish();
}

export function onPeerStream(peerId: PeerId, stream: MediaStream, metadata: JsonValue | undefined) {
    const kind = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.kind : undefined;
    if (kind !== undefined && kind !== STREAM_KIND_SCREEN) {
        logThrottled(`stream-kind:${peerId}`, "warn", `Stream de ${peerLabel(peerId)} com tipo desconhecido (${String(kind)}); ignorado`);
        return;
    }
    const v = rt.viewing.get(peerId);
    if (!v) {
        // chegou sem pedido (ou depois de parar de assistir): pede para o transmissor parar
        logThrottled(`stream-unsolicited:${peerId}`, "warn", `Stream de ${peerLabel(peerId)} sem pedido; pedindo para parar`);
        sendWatch(peerId, "stop").catch(() => { });
        return;
    }
    if (v.stream === stream) return;
    attachStream(v, stream);
}

export function onPresence(peerId: PeerId, presence: PresenceMessage) {
    const v = rt.viewing.get(peerId);
    if (v && !presence.streaming && v.status !== "ended") end(v, "o amigo parou de transmitir");
}

export function onPeerGone(peerId: PeerId) {
    const v = rt.viewing.get(peerId);
    if (v) end(v, "o amigo saiu da call");
}

/** A cada 2 s: largura, altura, fps e kbps de cada stream assistido; tambem recupera de um timeout de 1o quadro. */
export function sampleStats() {
    for (const v of rt.viewing.values()) {
        if (!v.stream || (v.status !== "playing" && v.status !== "waiting-first-frame" && v.status !== "error")) continue;
        const { stream } = v;
        sample(v).then(s => {
            if (!s || v.stream !== stream || rt.viewing.get(v.peerId) !== v) return;
            const now = performance.now();
            const prev = v.meter;
            v.meter = { bytes: s.bytes, frames: s.framesDecoded, at: now };
            if (s.framesDecoded > 0 && v.firstFrameAt == null) onFirstFrame(v, s);
            if (!prev || now <= prev.at) return;
            const dt = (now - prev.at) / 1000;
            const fps = s.fps ?? Math.max(0, (s.framesDecoded - prev.frames) / dt);
            v.stats = {
                width: s.width,
                height: s.height,
                fps: Math.round(fps),
                kbps: Math.max(0, Math.round((s.bytes - prev.bytes) * 8 / 1000 / dt))
            };
            publish();
        }).catch(() => { });
    }
}

// #endregion
