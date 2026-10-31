/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Assistir: pede o stream ao transmissor, recebe no onPeerStream, detecta o primeiro quadro
// decodificado pelas estatisticas do receiver e publica estatisticas basicas a cada 2 s.
// Transmissao com senha (protocol.ts, passo 7): o transmissor responde { op: "password", nonce }; a UI mostra o
// campo de senha (ViewerSession.passwordPrompt) e submitPassword manda so a prova HMAC. A senha aceita fica
// lembrada para ESTA transmissao desse peer (assistir de novo nao pergunta outra vez) e e esquecida quando ela acaba.

import { type PresenceMessage, STREAM_KIND_SCREEN, type WatchMessage, type WatchReplyMessage } from "@plugins/telinha/protocol";
import type { PeerId, ViewDeniedReason } from "@plugins/telinha/types";
import type { JsonValue } from "trystero";

import { computePasswordProof, isValidPassword, normalizePassword } from "./access";
import { getPc, peerLabel, publish, rt, type ViewerEntry } from "./context";
import { errorText, log, logThrottled } from "./log";
import { me } from "./presence";
import { emptyReceiverCounters, guardStatsLog, readAudioInbound, readVideoInbound, ReceiverLog, type ReceiverSample } from "./statsLog";

const RESPONSE_TIMEOUT_MS = 20_000;
/** o transmissor pediu para esperar a aprovacao dele (60 s do lado dele + folga de rede) */
const APPROVAL_WAIT_MS = 75_000;

/** Frase pronta (pt-BR) para cada recusa do transmissor; vai em ViewerSession.error. */
const DENIED_TEXT: Record<ViewDeniedReason, string> = {
    kicked: "O transmissor encerrou a sua visualização.",
    declined: "O transmissor recusou o seu pedido para assistir.",
    timeout: "O transmissor não respondeu ao pedido a tempo. Você pode pedir de novo.",
    duplicate: "Outra conexão na call diz ser você, então o transmissor bloqueou as duas por segurança. Se você acabou de reabrir o Discord, espere alguns segundos e tente de novo.",
    friendsOnly: "Quem transmite escolheu \"Só meus amigos do Discord\": só amigos dessa pessoa no Discord, com a identidade verificada, assistem.",
    notVerified: "Esta transmissão é só para amigos com a identidade do Discord verificada. Autorize o Telinha no Discord (uma vez só) e tente de novo.",
    tooManyAttempts: "Você errou a senha vezes demais. Só dá para tentar de novo quando esta transmissão acabar (ou se o transmissor liberar você)."
};

/** Senha aceita por transmissor (conexao), so enquanto a transmissao dele durar. */
const rememberedPasswords = new Map<PeerId, string>();

/** Esquece a senha lembrada desse transmissor (a transmissao acabou, ele saiu, ou a senha nao vale mais). */
function forgetPassword(peerId: PeerId) {
    rememberedPasswords.delete(peerId);
}

function clearPasswordState(v: ViewerEntry) {
    v.challenge = null;
    v.proofPassword = null;
    v.proofFromMemory = false;
    v.staleRetried = false;
}
const FIRST_FRAME_TIMEOUT_MS = 45_000;
const FIRST_FRAME_POLL_MS = 150;
/** Stream em H.264 sem nenhum quadro decodificado ate aqui: pede VP9 ao transmissor (askForVp9). */
export const NO_FRAME_HINT_MS = 10_000;

function sendWatch(peerId: PeerId, message: WatchMessage) {
    return rt.watchAction?.send(message, { target: peerId }) ?? Promise.resolve();
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
    clearPasswordState(v);
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
    if (reason === "tooManyAttempts" || v.proofFromMemory) forgetPassword(v.peerId);
    clearPasswordState(v);
    log.warn(`Assistir ${peerLabel(v.peerId)}: ${DENIED_TEXT[reason]}`);
    publish();
}

/** Espera a resposta a um pedido/prova; sem resposta em RESPONSE_TIMEOUT_MS, desiste com `message`. */
function armResponseTimer(v: ViewerEntry, message: string) {
    runCleanup(v.requestCleanup);
    const timer = setTimeout(() => {
        if (v.status === "connecting") fail(v, message);
    }, RESPONSE_TIMEOUT_MS);
    v.requestCleanup.push(() => clearTimeout(timer));
}

/** Manda a prova da senha para o desafio `nonce` (a senha em si nunca sai daqui). */
function sendProof(v: ViewerEntry, nonce: string, password: string, fromMemory: boolean) {
    const streamerId = rt.peers.get(v.peerId)?.hello?.discordUserId;
    v.challenge = null;
    v.proofPassword = password;
    v.proofFromMemory = fromMemory;
    armResponseTimer(v, "O transmissor não respondeu à senha.");
    publish();
    if (!streamerId) return fail(v, "Esse amigo não está mais na call.");
    computePasswordProof({ password, nonce, streamerId, viewerId: me().id })
        .then(proof => {
            if (rt.viewing.get(v.peerId) !== v || v.status !== "connecting" || v.proofPassword !== password) return;
            return sendWatch(v.peerId, { op: "start", proof });
        })
        .catch(e => fail(v, "Não foi possível enviar a senha: " + errorText(e)));
}

/** { op: "password" }: o transmissor pediu a senha (de novo, se `wrong`). Usa a lembrada; senao mostra o campo. */
function onPasswordChallenge(v: ViewerEntry, reply: Extract<WatchReplyMessage, { op: "password"; }>) {
    if (v.status !== "connecting") return;
    v.awaitingApproval = false;
    runCleanup(v.requestCleanup);
    const { peerId } = v;
    if (reply.wrong) {
        // a senha lembrada nao vale mais (o transmissor trocou a senha): esquece e pergunta
        if (v.proofFromMemory) forgetPassword(peerId);
        log.info(`Assistir ${peerLabel(peerId)}: senha incorreta${reply.attemptsLeft != null ? ` (restam ${reply.attemptsLeft})` : ""}`);
    } else if (v.proofPassword && !v.staleRetried) {
        // desafio novo sem "errada": a prova chegou com o desafio vencido/trocado; manda a mesma senha uma vez
        v.staleRetried = true;
        sendProof(v, reply.nonce, v.proofPassword, !!v.proofFromMemory);
        return;
    } else if (!v.proofPassword) {
        const remembered = rememberedPasswords.get(peerId);
        if (remembered) {
            log.info(`Assistir ${peerLabel(peerId)}: transmissão com senha; usando a senha que já deu certo nela`);
            sendProof(v, reply.nonce, remembered, true);
            return;
        }
        log.info(`Assistir ${peerLabel(peerId)}: a transmissão é com senha`);
    }
    v.proofPassword = null;
    v.proofFromMemory = false;
    v.staleRetried = false;
    v.challenge = { nonce: reply.nonce, attemptsLeft: reply.attemptsLeft ?? null, wrong: !!reply.wrong };
    publish();
}

/**
 * Senha digitada para a transmissao desse peer (responde ao ViewerSession.passwordPrompt). false = nao havia
 * pedido de senha ou a senha e invalida (vazia / longa demais).
 */
export function submitPassword(peerId: PeerId, raw: string): boolean {
    const v = rt.viewing.get(peerId);
    if (!v || v.status !== "connecting" || !v.challenge) return false;
    const password = normalizePassword(raw);
    if (!isValidPassword(password)) return false;
    const { nonce } = v.challenge;
    v.staleRetried = false;
    sendProof(v, nonce, password, false);
    return true;
}

/** Resposta do transmissor a um pedido nosso (protocol.ts, passos 5 e 7). Sem sessao para esse peer: ignorada. */
export function onWatchReply(peerId: PeerId, reply: WatchReplyMessage) {
    const v = rt.viewing.get(peerId);
    if (!v) return;
    if (reply.op === "denied") {
        denied(v, reply.reason);
        return;
    }
    if (reply.op === "password") {
        onPasswordChallenge(v, reply);
        return;
    }
    if (v.status !== "connecting" || v.awaitingApproval) return;
    clearPasswordState(v);
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
    if (entry.identity === "invalid") return fail(v, INVALID_IDENTITY_TEXT);
    if (entry.identity === "pending") return fail(v, "Ainda conferindo a identidade desse amigo no Discord. Tente de novo em instantes.");
    if (!entry.admitted) return fail(v, "Essa pessoa não está no seu canal de voz.");
    if (!entry.presence?.streaming) return fail(v, "Esse amigo não está transmitindo agora.");

    log.info(`Assistir ${peerLabel(peerId)}: pedido enviado`);
    sendWatch(peerId, { op: "start" }).catch(e => fail(v, "Falha ao pedir a transmissão: " + errorText(e)));
    armResponseTimer(v, "O amigo não respondeu ao pedido para assistir.");
}

export function unwatch(peerId: PeerId) {
    const v = rt.viewing.get(peerId);
    if (!v) return;
    runCleanup(v.requestCleanup);
    runCleanup(v.streamCleanup);
    rt.viewing.delete(peerId);
    if (rt.peers.has(peerId)) sendWatch(peerId, { op: "stop" }).catch(() => { });
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
    rememberedPasswords.clear();
    publish();
}

// #region recepcao

function videoReceiver(v: ViewerEntry) {
    const track = v.stream?.getVideoTracks()[0];
    if (!track) return null;
    return getPc(v.peerId)?.getReceivers().find(r => r.track === track) ?? null;
}

/** Uma leitura do receiver (statsLog.ts → ReceiverSample, com os contadores do log) e o fps relatado. */
interface InboundSample extends ReceiverSample {
    fps: number | null;
}

async function sample(v: ViewerEntry): Promise<InboundSample | null> {
    const pc = getPc(v.peerId);
    const tracks = v.stream?.getTracks() ?? [];
    if (!pc || !tracks.length) return null;
    const receivers = pc.getReceivers().filter(r => tracks.includes(r.track));
    const video = videoReceiver(v);
    if (!video) return null;

    const out: InboundSample = {
        at: 0, framesDecoded: 0, width: 0, height: 0, fps: null, bytes: 0, codec: null, decoder: null, powerEfficient: null, log: emptyReceiverCounters()
    };
    for (const r of receivers) {
        const report = await r.getStats();
        report.forEach((s: any) => {
            if (s.type !== "inbound-rtp") return;
            out.bytes += s.bytesReceived ?? 0;
            if (s.kind === "audio") guardStatsLog(() => readAudioInbound(out.log, s));
            if (r !== video || s.kind !== "video") return;
            out.framesDecoded = s.framesDecoded ?? 0;
            out.width = s.frameWidth ?? 0;
            out.height = s.frameHeight ?? 0;
            out.fps = typeof s.framesPerSecond === "number" ? s.framesPerSecond : null;
            out.decoder = s.decoderImplementation ?? null;
            out.powerEfficient = typeof s.powerEfficientDecoder === "boolean" ? s.powerEfficientDecoder : null;
            if (s.codecId) out.codec = (report.get(s.codecId) as any)?.mimeType ?? null;
            guardStatsLog(() => readVideoInbound(out.log, s));
        });
    }
    out.at = performance.now();
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

/**
 * O stream chegou ha NO_FRAME_HINT_MS e nenhum quadro foi decodificado, com o video em H.264 (codec do inbound-rtp) ou
 * sem codec conhecido (nenhum pacote de video chegou): pede ao transmissor para mandar VP9 so para nos (acao "codec",
 * protocol.ts passo 8). Visto em 31/10, nos dois casos com o H.264 de um PC com placa AMD: o video chegava e nunca virou
 * imagem; e, as 02:54, nenhum pacote de video chegou (so o audio), com o encoder dele no ar. Em VP9 o 1o quadro chegou
 * em menos de 1 s. Video em outro codec (ex.: VP9), nao pede. Um pedido por "assistir" (v.codecRequested). Quem decide e
 * o transmissor (so troca um envio em H.264, com o codec dele no automatico); versoes sem a acao a ignoram. O aviso de
 * 45 s e a espera continuam como estao. O transmissor tambem confere sozinho se o H.264 sai (streaming.ts → checkStall).
 */
function askForVp9(v: ViewerEntry, s: InboundSample, streamAt: number) {
    if (v.codecRequested || performance.now() - streamAt < NO_FRAME_HINT_MS || (s.codec && !/^video\/h264$/i.test(s.codec))) return;
    const action = rt.codecAction;
    if (!action) return;
    v.codecRequested = true;
    const received = s.log.framesReceived != null ? `${s.log.framesReceived} quadros recebidos` : `${Math.round(s.bytes / 1000)} kB recebidos`;
    const secs = Math.round((performance.now() - streamAt) / 1000);
    const detail = `${received}${s.decoder ? `, decodificador ${s.decoder}` : ""}`;
    const what = s.codec
        ? `nenhum quadro do vídeo em H.264 decodificado em ${secs} s (${detail})`
        : `nenhum quadro de vídeo decodificado em ${secs} s e nenhum pacote de vídeo identificado (codec desconhecido, ${detail})`;
    log.warn(`Assistir ${peerLabel(v.peerId)}: ${what}; pedindo ao transmissor para mandar VP9`);
    action.send({ codec: "vp9" }, { target: v.peerId })
        .catch(e => logThrottled(`codec-send:${v.peerId}`, "warn", `Falha ao pedir VP9 a ${peerLabel(v.peerId)}: ${errorText(e)}`));
}

function attachStream(v: ViewerEntry, stream: MediaStream) {
    runCleanup(v.streamCleanup);
    v.stream = stream;
    v.status = "waiting-first-frame";
    v.error = undefined;
    v.denied = undefined;
    v.awaitingApproval = false;
    // a senha enviada deu certo: lembrada so para esta transmissao desse peer
    if (v.proofPassword) rememberedPasswords.set(v.peerId, v.proofPassword);
    clearPasswordState(v);
    v.stats = undefined;
    v.firstFrameAt = null;
    v.meter = null;
    log.info(`Assistir ${peerLabel(v.peerId)}: stream recebido em ${Math.round(performance.now() - v.requestedAt)} ms (${stream.getVideoTracks().length} vídeo, ${stream.getAudioTracks().length} áudio)`);

    // log de estatisticas deste stream: as linhas saem em sampleStats; o resumo, quando o stream sai (fim, parar, recusa...)
    const statsLog = new ReceiverLog(performance.now());
    v.statsLog = statsLog;
    v.streamCleanup.push(() => guardStatsLog(() => {
        const line = statsLog.summary(peerLabel(v.peerId), performance.now());
        if (line) log.info(line);
    }));

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
            if (!s || v.stream !== stream || v.firstFrameAt != null) return;
            if (s.framesDecoded > 0) {
                clearInterval(poll);
                onFirstFrame(v, s);
                return;
            }
            askForVp9(v, s, startedAt);
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
        sendWatch(peerId, { op: "stop" }).catch(() => { });
        return;
    }
    if (v.stream === stream) return;
    attachStream(v, stream);
}

export function onPresence(peerId: PeerId, presence: PresenceMessage) {
    // a transmissao acabou: a senha dela nao serve para a proxima
    if (!presence.streaming) forgetPassword(peerId);
    const v = rt.viewing.get(peerId);
    if (v && !presence.streaming && v.status !== "ended") end(v, "o amigo parou de transmitir");
}

export function onPeerGone(peerId: PeerId) {
    forgetPassword(peerId);
    const v = rt.viewing.get(peerId);
    if (v) end(v, "o amigo saiu da call");
}

const INVALID_IDENTITY_TEXT = "Essa conexão apresentou uma prova de identidade falsa (pode ser alguém se passando pelo seu amigo). A transmissão dela foi bloqueada.";

/** A conexao apresentou prova de identidade falsa (session.ts): para de assistir, sem avisar o outro lado. */
export function onIdentityInvalid(peerId: PeerId) {
    const v = rt.viewing.get(peerId);
    if (v) fail(v, INVALID_IDENTITY_TEXT);
}

/**
 * A cada 2 s: largura, altura, fps e kbps de cada stream assistido; tambem recupera de um timeout de 1o quadro. A mesma
 * leitura alimenta o log de estatisticas (uma linha a cada STATS_LOG_MS por stream, core/statsLog.ts).
 */
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
            guardStatsLog(() => {
                const line = v.statsLog?.add(s, peerLabel(v.peerId));
                if (line) log.info(line);
            });
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
