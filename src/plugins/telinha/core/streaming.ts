/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Transmitir: captura (handler de display media do native.ts) + envio do stream so para quem pediu.
//
// Quem pode receber (refusalFor), nesta ordem:
//   1. admitido (rejectOutsiders: no seu canal de voz) — quem esta fora nao recebe nem resposta;
//   2. nao expulso/recusado (rt.blocked, pelo discordUserId anunciado OU pela conexao);
//   3. sem identidade duplicada (outra conexao viva diz ter o mesmo discordUserId);
//   4. com approveViewers ligado: aprovado nesta transmissao (senao vira um pedido pendente).
// Recusas 2-4 respondem { op: "denied" } na acao "watch" (protocol.ts, passo 5).

import { STREAM_KIND_SCREEN, type WatchDeniedReason, type WatchReplyMessage } from "@plugins/telinha/protocol";
import { type CodecSetting, settings } from "@plugins/telinha/settings";
import type { BlockReason, CaptureSource, PeerId, Quality, QualityLevel, StreamInfo, StreamOptions } from "@plugins/telinha/types";
import type { Room } from "trystero";

import { startScreenAudioCapture } from "./audio/screenAudio";
import { chooseCodec, type CodecDecision, getLocalCaps } from "./codec";
import { blockOf, getPc, type LocalCapture, peerLabel, publish, rt, setLastError } from "./context";
import { errorText, log, logThrottled } from "./log";
import { getNative } from "./nativeApi";
import type { SendPlan } from "./peerConnection";
import { sendPresence } from "./presence";
import { CaptureMonitor } from "./quality/captureMonitor";
import { QualityController } from "./quality/controller";
import { encodingFor, LEVELS, levelText } from "./quality/levels";

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

/** Pedido de aprovacao (approveViewers) sem resposta: recusado sozinho depois disto. */
export const APPROVAL_TIMEOUT_MS = 60_000;

interface ViewerSend {
    decision: CodecDecision;
    /** codec que o encoder realmente usa (lido das estatisticas), para logar uma vez */
    reportedCodec?: string;
    /** parametros de envio ja aplicados uma vez (as mudancas seguintes sao logadas pela qualidade automatica) */
    applied?: boolean;
    /** o Chromium recusou degradationPreference neste sender: nao tenta de novo */
    noDegradation?: boolean;
}

/** Qualidade automatica (core/quality/controller.ts) e monitor de imagem preta/congelada da captura atual. */
interface CaptureExtras {
    local: LocalCapture;
    quality: QualityController;
    monitor: CaptureMonitor | null;
}

const sends = new Map<PeerId, ViewerSend>();
let starting = false;
let extras: CaptureExtras | null = null;
let tickCount = 0;

function qualityOf(local: LocalCapture): QualityController | null {
    return extras?.local === local ? extras.quality : null;
}

/** Plano de envio consultado pela RTCPeerConnection na negociacao (peerConnection.ts). */
export function sendPlanFor(peerId: PeerId | null): SendPlan | null {
    const { local } = rt;
    if (!peerId || !local || !local.viewers.has(peerId)) return null;
    const send = sends.get(peerId);
    const q = QUALITY[local.quality];
    // o x-google-max-bitrate fica no teto (a qualidade automatica pode subir depois sem renegociar);
    // a banda inicial acompanha o degrau atual
    const level = qualityOf(local)?.levelFor(peerId) ?? local.quality;
    const startKbps = level === local.quality ? q.startKbps : Math.min(q.startKbps, Math.round(LEVELS[level].maxKbps * 0.6));
    return {
        codec: send?.decision.codec ?? null,
        bitrate: { startKbps, maxKbps: q.maxKbps },
        label: peerLabel(peerId)
    };
}

function captureErrorMessage(e: any, handlerCalled: boolean | null): string {
    const name = e?.name ?? "";
    const msg = String(e?.message ?? e ?? "");
    if (/activation|gesture/i.test(msg)) return "O Discord só permite iniciar a captura logo após um clique. Tente de novo.";
    if (handlerCalled === false) return "O pedido de captura não chegou ao Telinha (outro plugin pode estar interceptando a captura de tela).";
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
    // janela: audio so do processo da janela (getDisplayMedia); tela inteira: audio do PC sem o Discord (telinha-audio.exe)
    const wantAudio = !!opts.withAudio && kind === "window";
    const wantScreenAudio = !!opts.withAudio && kind === "screen";
    starting = true;

    try {
        const native = getNative();
        log.info(`Iniciando transmissão: ${kind === "screen" ? "tela" : "janela"} "${source.name}" em ${opts.quality}${wantAudio || wantScreenAudio ? " com áudio" : " sem áudio"}`);

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
        if (!video) {
            stream.getTracks().forEach(t => t.stop());
            throw new Error("A captura veio sem vídeo.");
        }
        if (wantScreenAudio) {
            try {
                const screenAudio = await startScreenAudioCapture({
                    onEnded: reason => setLastError(`A transmissão continua, mas sem áudio: ${reason}.`)
                });
                stream.addTrack(screenAudio.track);
            } catch (e) {
                log.warn(`${e instanceof Error ? e.message : String(e)} Transmitindo a tela sem áudio.`);
            }
        }
        if (!rt.room) {
            stream.getTracks().forEach(t => t.stop());
            throw new Error("Você saiu do canal de voz enquanto a transmissão começava.");
        }
        const [audio] = stream.getAudioTracks();

        video.contentHint = "motion";
        if (audio) audio.contentHint = "music";
        if (wantAudio) log.info(`Áudio: ${audio ? "capturando" : "sem faixa de áudio"} — ${report?.audio?.reason ?? "sem decisão do handler"}`);
        else if (wantScreenAudio) log.info(`Áudio da tela: ${audio ? "capturando o PC sem o Discord" : "sem faixa de áudio"}`);

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
        startExtras(local, video);

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

/** Qualidade automatica + monitor de imagem preta/congelada para a captura que acabou de comecar. */
function startExtras(local: LocalCapture, video: MediaStreamTrack) {
    const quality = new QualityController({
        ceiling: local.quality,
        enabled: () => settings.store.autoQuality !== false,
        sender: peerId => videoSender(peerId, local),
        apply: (peerId, level) => applySenderParams(peerId, local, level),
        label: peerLabel,
        captureSize: () => {
            const s = video.getSettings();
            return { width: s.width ?? local.info.width, height: s.height ?? local.info.height };
        },
        motion: () => (extras?.local === local ? extras.monitor?.motion() ?? null : null),
        sourceFrames: (key, frames) => {
            if (extras?.local === local) extras.monitor?.noteSourceFrames(key, frames);
        },
        changed: () => {
            if (rt.local !== local) return;
            local.autoQuality = quality.state;
            publish();
        }
    });
    const monitor = new CaptureMonitor({
        track: video,
        kind: local.info.kind,
        onWarning: message => {
            if (rt.local !== local) return;
            local.captureWarning = message;
            publish();
        }
    });
    local.autoQuality = quality.state;
    local.captureWarning = null;
    extras = { local, quality, monitor: monitor.start() ? monitor : null };
}

function stopExtras(local: LocalCapture) {
    if (extras?.local !== local) return;
    extras.quality.dispose();
    extras.monitor?.stop();
    extras = null;
}

/** A configuracao autoQuality mudou (settings.ts). */
export function onAutoQualitySettingChanged() {
    if (rt.local) qualityOf(rt.local)?.settingChanged();
}

/** Remove o stream de todos os espectadores e para a captura (sem mexer na presenca). */
function stopCapture(local: LocalCapture, reason: string) {
    stopExtras(local);
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
    endOfStreamGuards();
    sendPresence();
    publish();
}

// #region quem pode receber

type Refusal = "outsider" | BlockReason | "duplicate";

const REFUSAL_TEXT: Record<Exclude<Refusal, "outsider">, string> = {
    kicked: "foi expulso por você",
    declined: "foi recusado por você nesta transmissão",
    duplicate: "outra conexão diz ser a mesma pessoa (identidade duplicada)"
};

/** Por que esta conexao nao pode receber a transmissao agora; null = pode. A admissao (rejectOutsiders) vem primeiro. */
function refusalFor(peerId: PeerId): Refusal | null {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible || !entry.admitted) return "outsider";
    const block = blockOf(peerId, entry.hello.discordUserId);
    if (block) return block.reason;
    if (entry.duplicate) return "duplicate";
    return null;
}

/** Resposta ao espectador na acao "watch" (so para peers admitidos: quem esta fora nao recebe nada). */
function reply(peerId: PeerId, message: WatchReplyMessage) {
    if (!rt.peers.get(peerId)?.admitted) return;
    rt.watchAction?.send(message, { target: peerId })
        .catch(e => logThrottled(`watch-reply:${peerId}`, "warn", `Falha ao responder ${peerLabel(peerId)}: ${errorText(e)}`));
}

function deny(peerId: PeerId, reason: WatchDeniedReason) {
    reply(peerId, { op: "denied", reason });
}

function nameOf(peerId: PeerId) {
    const p = rt.peers.get(peerId);
    return p?.presence?.username ?? p?.hello?.username ?? "?";
}

function cancelPending(peerId: PeerId, denyWith: WatchDeniedReason | null) {
    const p = rt.pending.get(peerId);
    if (!p) return false;
    clearTimeout(p.timer);
    rt.pending.delete(peerId);
    if (denyWith) deny(peerId, denyWith);
    publish();
    return true;
}

/** Pedido com approveViewers ligado: fica pendente ate Permitir/Recusar ou 60 s. */
function requestApproval(peerId: PeerId) {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello) return;
    if (rt.pending.has(peerId)) {
        reply(peerId, { op: "pending" });
        return;
    }
    const timer = setTimeout(() => {
        if (!rt.pending.has(peerId)) return;
        log.warn(`Pedido de ${peerLabel(peerId)} para assistir não foi respondido em ${APPROVAL_TIMEOUT_MS / 1000} s: recusado (pode pedir de novo)`);
        cancelPending(peerId, "timeout");
    }, APPROVAL_TIMEOUT_MS);
    rt.pending.set(peerId, {
        peerId,
        discordUserId: entry.hello.discordUserId,
        username: nameOf(peerId),
        expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
        timer
    });
    log.info(`${peerLabel(peerId)} (discord ${entry.hello.discordUserId}) pediu para assistir: esperando a sua aprovação`);
    reply(peerId, { op: "pending" });
    publish();
}

/** Fim da transmissao: aprovacoes, pedidos pendentes e recusas valem so para ela (expulsoes continuam). */
function endOfStreamGuards() {
    for (const p of rt.pending.values()) clearTimeout(p.timer);
    rt.pending.clear();
    rt.approved.clear();
    for (const [id, b] of rt.blocked) if (b.reason === "declined") rt.blocked.delete(id);
}

/** Expulsa (ate sair da call) ou recusa (ate a transmissao acabar) a conexao e o discordUserId que ela anuncia. */
function block(peerId: PeerId, reason: BlockReason): boolean {
    const entry = rt.peers.get(peerId);
    const id = entry?.hello?.discordUserId;
    if (!entry || !id) return false;

    const b = rt.blocked.get(id) ?? { discordUserId: id, username: nameOf(peerId), peerIds: new Set<PeerId>(), reason };
    b.peerIds.add(peerId);
    if (reason === "kicked") b.reason = "kicked";
    rt.blocked.set(id, b);

    const why = reason === "kicked" ? "expulso por você" : "recusado por você";
    for (const p of rt.peers.values()) {
        if (p.peerId !== peerId && p.hello?.discordUserId !== id) continue;
        rt.approved.delete(p.peerId);
        if (cancelPending(p.peerId, reason)) continue;
        if (rt.local?.viewers.has(p.peerId)) {
            deny(p.peerId, reason);
            removeFrom(p.peerId, why);
        }
    }
    log.warn(`${peerLabel(peerId)} (discord ${id}) foi ${why}: não recebe a sua transmissão ${reason === "kicked" ? "até você sair da call" : "até esta transmissão acabar"}`);
    publish();
    return true;
}

/** "Expulsar": para de mandar agora e ignora novos pedidos dessa conexao e desse discordUserId ate sair da call. */
export function kickViewer(peerId: PeerId): boolean {
    return block(peerId, "kicked");
}

/** "Permitir" num pedido pendente: vale ate a transmissao acabar. */
export function approveViewer(peerId: PeerId): boolean {
    if (!rt.pending.has(peerId)) return false;
    cancelPending(peerId, null);
    rt.approved.add(peerId);
    log.info(`Você permitiu ${peerLabel(peerId)} assistir`);
    if (rt.local) sendTo(peerId);
    publish();
    return true;
}

/** "Recusar" num pedido pendente: igual a expulsar, mas so ate esta transmissao acabar. */
export function declineViewer(peerId: PeerId): boolean {
    if (!rt.pending.has(peerId)) return false;
    return block(peerId, "declined");
}

/** Libera de novo quem foi expulso/recusado (a pessoa precisa pedir para assistir outra vez). */
export function unblockViewer(discordUserId: string): boolean {
    const b = rt.blocked.get(discordUserId);
    if (!b) return false;
    rt.blocked.delete(discordUserId);
    log.info(`Você liberou de novo ${b.username} (discord ${discordUserId}) para pedir para assistir`);
    publish();
    return true;
}

/** A opcao approveViewers mudou: ligada → quem ja assiste fica aprovado; desligada → pedidos pendentes sao atendidos. */
export function onApproveViewersSettingChanged() {
    if (settings.store.approveViewers) {
        for (const peerId of rt.local?.viewers ?? []) rt.approved.add(peerId);
        return;
    }
    for (const peerId of [...rt.pending.keys()]) approveViewer(peerId);
}

/** Conexoes que passaram a ter identidade duplicada (session.ts): param de receber agora, sem voltar sozinhas. */
export function onIdentityConflict(peerIds: PeerId[]) {
    for (const peerId of peerIds) {
        rt.approved.delete(peerId);
        if (cancelPending(peerId, "duplicate")) continue;
        if (rt.local?.viewers.has(peerId)) {
            deny(peerId, "duplicate");
            removeFrom(peerId, "identidade duplicada: outra conexão diz ser a mesma pessoa");
        }
    }
}

/** Tipo da conexao com o peer (para a lista de quem assiste), sem IPs. null = sem conexao. */
export async function connectionInfo(peerId: PeerId): Promise<string | null> {
    const pc = getPc(peerId);
    if (!pc) return null;
    const report = await pc.getStats();
    let pair: any = null;
    report.forEach((s: any) => {
        if (s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId) ?? pair;
    });
    if (!pair) report.forEach((s: any) => {
        if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
    });
    if (!pair) return "Conectando…";
    const types = [report.get(pair.localCandidateId)?.candidateType, report.get(pair.remoteCandidateId)?.candidateType];
    const kind = types.includes("relay") ? "por servidor intermediário (TURN)"
        : types.every(t => t === "host") ? "direta, na mesma rede"
            : "direta pela internet (P2P)";
    const rtt = typeof pair.currentRoundTripTime === "number" ? ` · ${Math.round(pair.currentRoundTripTime * 1000)} ms` : "";
    return `Conexão ${kind}${rtt}`;
}

// #endregion

/** Tira o stream de um peer cujo addStream terminou depois de ele ter deixado de ser espectador. */
function retract(room: Room, local: LocalCapture, peerId: PeerId) {
    try {
        room.removeStream(local.stream, { target: peerId });
    } catch (e) {
        log.warn("Falha ao remover o stream: " + errorText(e));
    }
    log.info(`Envio para ${peerLabel(peerId)} desfeito (ele deixou de ser espectador enquanto a mídia era preparada)`);
}

/** Comeca a mandar a captura atual para um espectador. */
function sendTo(peerId: PeerId) {
    const { local, room } = rt;
    const entry = rt.peers.get(peerId);
    if (!local || !room || !entry) return;
    const refusal = refusalFor(peerId);
    if (refusal === "outsider") {
        logThrottled(`watch-refused:${peerId}`, "warn", `${peerLabel(peerId)} pediu para assistir, mas não está no seu canal de voz: recusado`);
        return;
    }
    if (refusal) {
        logThrottled(`watch-blocked:${peerId}`, "warn", `${peerLabel(peerId)} pediu para assistir, mas ${REFUSAL_TEXT[refusal]}: recusado`);
        deny(peerId, refusal);
        return;
    }
    if (local.viewers.has(peerId)) return;

    const decision = chooseCodec(entry.presence?.caps, settings.store.codec as CodecSetting, getLocalCaps());
    const send: ViewerSend = { decision };
    sends.set(peerId, send);
    local.viewers.add(peerId);
    qualityOf(local)?.addViewer(peerId);
    log.info(`Enviando para ${peerLabel(peerId)}: codec ${decision.codec.toUpperCase()} (${decision.reason})`);
    if (decision.codec === "h264" && entry.presence?.caps.h264HwDecode !== true)
        log.warn(`${peerLabel(peerId)} não decodifica H.264 por hardware: o início pode travar por 15+ s`);
    publish();

    // o addStream e assincrono: se o peer for expulso/parar no meio, o removeStream de removeFrom chega antes
    // das faixas; ao terminar, confere de novo e tira o que chegou atrasado
    Promise.all(room.addStream(local.stream, { target: peerId, metadata: { kind: STREAM_KIND_SCREEN } }))
        .then(() => {
            if (rt.local !== local || !local.viewers.has(peerId)) {
                retract(room, local, peerId);
                return;
            }
            if (sends.get(peerId) !== send) return;
            const quality = qualityOf(local);
            if (quality) quality.markReady(peerId);
            else void applySenderParams(peerId, local, local.quality);
        })
        .catch(e => {
            log.error(`Falha ao enviar o stream para ${peerLabel(peerId)}: ${errorText(e)}`);
            if (rt.local !== local || !local.viewers.has(peerId)) {
                retract(room, local, peerId);
                return;
            }
            if (sends.get(peerId) === send && local.viewers.delete(peerId)) {
                sends.delete(peerId);
                qualityOf(local)?.removeViewer(peerId);
                publish();
            }
        });
}

function removeFrom(peerId: PeerId, reason: string) {
    const { local } = rt;
    sends.delete(peerId);
    if (!local?.viewers.delete(peerId)) return;
    qualityOf(local)?.removeViewer(peerId);
    try {
        rt.room?.removeStream(local.stream, { target: peerId });
    } catch (e) {
        log.warn("Falha ao remover o stream: " + errorText(e));
    }
    log.info(`${peerLabel(peerId)} deixou de receber a transmissão (${reason})`);
    publish();
}

function videoSender(peerId: PeerId, local: LocalCapture): RTCRtpSender | null {
    const tracks = local.stream.getVideoTracks();
    return getPc(peerId)?.getSenders().find(s => s.track && tracks.includes(s.track)) ?? null;
}

/**
 * Parametros do sender de video para um espectador no degrau `level` (qualidade automatica; sem ela,
 * a qualidade escolhida): resolucao (scaleResolutionDownBy), fps e bitrate maximos, prioridade alta e
 * degradationPreference "maintain-framerate" (cai resolucao antes de fps). Sem renegociar.
 * Devolve false se nao aplicou (a qualidade automatica tenta de novo na proxima avaliacao).
 */
async function applySenderParams(peerId: PeerId, local: LocalCapture, level: QualityLevel): Promise<boolean> {
    const sender = videoSender(peerId, local);
    if (!sender) {
        logThrottled(`no-sender:${peerId}`, "warn", `Sem RTCRtpSender de vídeo para ${peerLabel(peerId)}; parâmetros de envio não aplicados`);
        return false;
    }

    const send = sends.get(peerId);
    const height = local.stream.getVideoTracks()[0]?.getSettings().height ?? local.info.height;
    const target = encodingFor(level, height);
    const build = (withDegradation: boolean) => {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        Object.assign(params.encodings[0], { ...target, priority: "high", networkPriority: "high" });
        if (withDegradation) (params as any).degradationPreference = "maintain-framerate";
        return params;
    };
    const desc = `${levelText(level)}, até ${Math.round(target.maxBitrate / 1000)} kbps${target.scaleResolutionDownBy > 1 ? ` (captura ÷${target.scaleResolutionDownBy})` : ""}`;

    try {
        await sender.setParameters(build(!send?.noDegradation));
        if (!send?.applied) log.info(`Envio para ${peerLabel(peerId)}: ${desc}, prioriza fps`);
    } catch (e) {
        if (send?.noDegradation) {
            logThrottled(`set-params:${peerId}`, "warn", `setParameters falhou para ${peerLabel(peerId)}: ${errorText(e)}`);
            return false;
        }
        try {
            await sender.setParameters(build(false));
            if (send) send.noDegradation = true;
            log.warn(`Envio para ${peerLabel(peerId)}: degradationPreference recusado (${errorText(e)}); ${desc} aplicado`);
        } catch (e2) {
            logThrottled(`set-params:${peerId}`, "warn", `setParameters falhou para ${peerLabel(peerId)}: ${errorText(e2)}`);
            return false;
        }
    }
    if (send) send.applied = true;
    return true;
}

// #region eventos vindos da sessao

export function onWatchRequest(peerId: PeerId, op: "start" | "stop") {
    if (op === "stop") {
        if (cancelPending(peerId, null)) log.info(`${peerLabel(peerId)} desistiu do pedido para assistir`);
        removeFrom(peerId, "parou de assistir");
        return;
    }
    // rejectOutsiders primeiro: quem esta fora do canal de voz nao recebe nem resposta
    if (!rt.peers.get(peerId)?.admitted) {
        logThrottled(`watch-refused:${peerId}`, "warn", `${peerLabel(peerId)} pediu para assistir, mas não está no seu canal de voz: recusado`);
        return;
    }
    if (!rt.local) {
        logThrottled(`watch-idle:${peerId}`, "info", `${peerLabel(peerId)} pediu para assistir, mas você não está transmitindo`);
        sendPresence(peerId);
        return;
    }
    if (rt.local.viewers.has(peerId)) return;
    const refusal = refusalFor(peerId);
    if (!refusal && settings.store.approveViewers && !rt.approved.has(peerId)) {
        requestApproval(peerId);
        return;
    }
    sendTo(peerId);
}

export function onPeerGone(peerId: PeerId) {
    sends.delete(peerId);
    rt.approved.delete(peerId);
    cancelPending(peerId, null);
    const { local } = rt;
    if (!local?.viewers.delete(peerId)) return;
    qualityOf(local)?.removeViewer(peerId);
    publish();
}

/** O peer deixou de ser admitido (saiu do canal de voz): para de mandar a transmissao para ele. */
export function onAdmissionLost(peerId: PeerId) {
    cancelPending(peerId, null);
    removeFrom(peerId, "saiu do seu canal de voz");
}

/** A sala vai ser fechada: encerra a transmissao antes (a captura nao sobrevive a troca de canal) e esquece as expulsoes. */
export function onRoomClosing(reason: string) {
    if (rt.local) stopStreaming(reason);
    endOfStreamGuards();
    rt.blocked.clear();
}

/**
 * Uma vez por segundo: confere que todo espectador ainda pode receber (defesa extra: expulso, recusado,
 * identidade duplicada ou fora da call nunca fica recebendo), loga o codec que o encoder realmente usa
 * por espectador (uma vez) e, a cada 2 s, roda a qualidade automatica.
 */
export function tick() {
    const { local } = rt;
    if (!local) return;
    for (const peerId of [...local.viewers]) {
        const refusal = refusalFor(peerId);
        if (!refusal) continue;
        if (refusal !== "outsider") deny(peerId, refusal);
        removeFrom(peerId, refusal === "outsider" ? "não está mais admitido" : REFUSAL_TEXT[refusal]);
    }
    if (++tickCount % 2 === 0) void qualityOf(local)?.evaluate();
    for (const peerId of local.viewers) {
        const send = sends.get(peerId);
        if (!send || send.reportedCodec) continue;
        const sender = videoSender(peerId, local);
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
