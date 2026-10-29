/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Transmitir: captura (handler de display media do native.ts) + envio do stream so para quem pediu.
//
// Quem pode receber: "Quem pode assistir" (core/access.ts → decideWatch), nesta ordem:
//   1. admitido (rejectOutsiders: no seu canal de voz; nunca prova de identidade falsa) — quem esta fora nao
//      recebe nem resposta;
//   2. nao expulso/recusado/bloqueado por errar a senha (rt.blocked, pelo discordUserId anunciado OU pela conexao);
//   3. sem identidade duplicada (outra conexao viva diz ter o mesmo discordUserId; uma conexao com a
//      identidade verificada nunca e a duplicada);
//   4. aprovado nesta transmissao, ou o modo da transmissao deixa: "all" (nao verificado com
//      requireVerifiedIdentity → Permitir/Recusar), "friends" (verificado e amigo no Discord), "approval"
//      (sempre Permitir/Recusar), "password" (prova da senha certa; desafio-resposta em protocol.ts, passo 7).
// Recusas 2-4 respondem { op: "denied" } na acao "watch" (protocol.ts, passos 5 e 7). Mudar o modo com a
// transmissao no ar vale so para pedidos novos: quem ja assiste continua (e fica aprovado).

import { isStreamAccess, STREAM_KIND_SCREEN, type WatchDeniedReason, type WatchMessage, type WatchReplyMessage } from "@plugins/telinha/protocol";
import { type CodecSetting, settings } from "@plugins/telinha/settings";
import type { AccessMode, BlockReason, CaptureSource, PeerId, Quality, QualityLevel, StreamInfo, StreamOptions } from "@plugins/telinha/types";
import { RelationshipStore } from "@webpack/common";
import type { Room } from "trystero";

import {
    ACCESS_LABEL, decideWatch, isValidPassword, MAX_PASSWORD_ATTEMPTS, normalizePassword, PASSWORD_MAX_CHARS, PASSWORD_NONCE_TTL_MS, PasswordChallenges,
    type ProofState, verifyPasswordProof, type WatchAccessInput, type WatchDecision
} from "./access";
import { startScreenAudioCapture } from "./audio/screenAudio";
import {
    chooseCodec, type CodecDecision, type EncoderReport, getLocalCaps, isSoftwareH264, isTransientSoftwareH264, noteH264Fallback, pickNegotiatedCodec, softwareFallback
} from "./codec";
import { blockOf, getPc, type LocalCapture, peerLabel, publish, rt, setLastError } from "./context";
import { isIdentityConfigured } from "./identity/config";
import { type ApprovalInput, identityRequiresApproval } from "./identity/policy";
import { errorText, log, logThrottled } from "./log";
import { getNative } from "./nativeApi";
import type { SendPlan } from "./peerConnection";
import { me, sendPresence } from "./presence";
import { CaptureMonitor } from "./quality/captureMonitor";
import { QualityController } from "./quality/controller";
import { encodingFor, LEVELS, levelText, scaledSize } from "./quality/levels";

export interface QualityProfile {
    width: number;
    height: number;
    fps: number;
    /** teto do encoder (RTCRtpSender maxBitrate) e x-google-max-bitrate */
    maxKbps: number;
    /** x-google-start-bitrate: o estimador de banda comeca aqui em vez de ~300 kbps */
    startKbps: number;
}

/** Perfis de qualidade. startKbps ≈ 50% do teto: sobe direto para a resolucao cheia sem estourar links medianos. */
export const QUALITY: Record<Quality, QualityProfile> = {
    "1080p60": { width: 1920, height: 1080, fps: 60, maxKbps: 20000, startKbps: 10000 },
    "720p60": { width: 1280, height: 720, fps: 60, maxKbps: 12000, startKbps: 6000 },
    "1080p30": { width: 1920, height: 1080, fps: 30, maxKbps: 12000, startKbps: 6000 }
};

const SOURCE_ID_RE = /^(screen|window):-?\d{1,20}:-?\d{1,10}$/;

/** Pedido de aprovacao (Permitir/Recusar) sem resposta: recusado sozinho depois disto. */
export const APPROVAL_TIMEOUT_MS = 60_000;

interface ViewerSend {
    decision: CodecDecision;
    /** codec que o encoder realmente usa (lido das estatisticas), para logar uma vez */
    reportedCodec?: string;
    /** parametros de envio ja aplicados uma vez (as mudancas seguintes sao logadas pela qualidade automatica) */
    applied?: boolean;
    /** o Chromium recusou degradationPreference neste sender: nao tenta de novo */
    noDegradation?: boolean;
    /** a checagem do encoder ja agiu neste espectador (H.264 por software): nunca de novo */
    fellBack?: boolean;
    /** o H.264 esta no OpenH264 de passagem (o WebRTC reduziu a resolucao para um tamanho que a placa nao aceita) */
    transientSoftware?: boolean;
}

/** Qualidade automatica (core/quality/controller.ts) e monitor de imagem preta/congelada da captura atual. */
interface CaptureExtras {
    local: LocalCapture;
    quality: QualityController;
    monitor: CaptureMonitor | null;
    /** tamanho da captura visto no ultimo tick (checkCaptureSize) */
    size: { width: number; height: number; };
    /** performance.now() da ultima mudanca de tamanho vista (checkCaptureSize) */
    resizedAt: number;
}

/** Depois de a janela capturada mudar de tamanho: OpenH264 nesse meio tempo e a reducao antiga, sendo reaplicada (checkEncoder). */
const RESIZE_GRACE_MS = 5000;

const sends = new Map<PeerId, ViewerSend>();
let starting = false;
let extras: CaptureExtras | null = null;
let tickCount = 0;

function qualityOf(local: LocalCapture): QualityController | null {
    return extras?.local === local ? extras.quality : null;
}

/**
 * Tamanho atual da captura, o que vai para os encoders antes da nossa reducao (a janela pode mudar de tamanho no
 * meio). Sempre par: o capturador do Chromium ja entrega a janela em tamanho par (ver checkEncoder).
 */
function captureSizeOf(local: LocalCapture): { width: number; height: number; } {
    const s = local.stream.getVideoTracks()[0]?.getSettings();
    return { width: s?.width ?? local.info.width, height: s?.height ?? local.info.height };
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
    const startKbps = level === local.quality ? q.startKbps : Math.min(q.startKbps, Math.round(LEVELS[level].maxKbps * 0.5));
    return {
        codec: send?.decision.codec ?? null,
        h264Profile: send?.decision.h264Profile ?? null,
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

interface AccessChoice {
    access: AccessMode;
    password: string | null;
}

/** Valida "Quem pode assistir" (e a senha, no modo "password"). Lanca com a frase pronta em pt-BR. */
function validateAccess(mode: unknown, rawPassword: unknown): AccessChoice {
    if (!isStreamAccess(mode)) throw new Error("Opção de \"Quem pode assistir\" inválida.");
    if (mode === "friends" && !isIdentityConfigured()) throw new Error("\"Só meus amigos do Discord\" precisa da prova de identidade do Discord, que esta versão do Telinha não tem.");
    if (mode !== "password") return { access: mode, password: null };
    const password = normalizePassword(typeof rawPassword === "string" ? rawPassword : "");
    if (!password) throw new Error("Digite ou gere uma senha para esta transmissão.");
    if (!isValidPassword(password)) throw new Error(`A senha pode ter no máximo ${PASSWORD_MAX_CHARS} caracteres.`);
    return { access: mode, password };
}

function validateOptions(opts: StreamOptions) {
    const source = opts?.source as CaptureSource | undefined;
    if (!source || typeof source.id !== "string" || !SOURCE_ID_RE.test(source.id)) throw new Error("Fonte de captura inválida.");
    if (!QUALITY[opts.quality]) throw new Error("Qualidade inválida.");
    // sem escolha: trocando de fonte, continua o modo atual; transmissao nova, "Todos da call"
    const access = opts.access === undefined ? null : validateAccess(opts.access, opts.password);
    return { source, profile: QUALITY[opts.quality], access };
}

export async function startStreaming(opts: StreamOptions): Promise<void> {
    if (starting) throw new Error("A transmissão já está sendo iniciada.");
    if (!rt.room) {
        const msg = "Entre em um canal de voz para transmitir.";
        setLastError(msg);
        throw new Error(msg);
    }

    const { source, profile, access: chosenAccess } = validateOptions(opts);
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

        // trocar de fonte com a transmissao no ar: os espectadores atuais recebem a nova (e o modo continua, se nao veio outro)
        const previous = rt.local;
        const keepViewers = previous ? [...previous.viewers] : [];
        const access: AccessChoice = chosenAccess ?? (previous ? { access: previous.access, password: previous.password } : { access: "all", password: null });
        if (previous) stopCapture(previous, "trocando de fonte");

        const local: LocalCapture = {
            stream, source: { ...source }, quality: opts.quality, info, startedAt: Date.now(), viewers: new Set(),
            access: access.access, password: access.password
        };
        rt.local = local;
        rt.lastError = null;
        startExtras(local, video);

        video.addEventListener("ended", () => {
            if (rt.local !== local) return;
            log.warn("A captura terminou sozinha (janela fechada ou captura interrompida pelo sistema)");
            stopStreaming("a captura terminou");
            setLastError("A transmissão parou: a janela foi fechada ou a captura foi interrompida.");
        });

        log.info(`Transmitindo ${info.width}x${info.height} @ ${info.fps} fps${info.hasAudio ? " com áudio" : ""} · quem pode assistir: ${ACCESS_LABEL[local.access]}`);
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
        captureSize: () => captureSizeOf(local),
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
    extras = { local, quality, monitor: monitor.start() ? monitor : null, size: captureSizeOf(local), resizedAt: -Infinity };
}

/** A janela capturada mudou de tamanho ha pouco (ou mudou e o tick ainda nao viu): a reducao ainda esta sendo reaplicada. */
function resizing(local: LocalCapture): boolean {
    if (extras?.local !== local) return false;
    const now = captureSizeOf(local);
    return now.width !== extras.size.width || now.height !== extras.size.height || performance.now() - extras.resizedAt < RESIZE_GRACE_MS;
}

/**
 * A captura mudou de tamanho (janela redimensionada no meio): a reducao de resolucao de cada espectador e relativa ao
 * tamanho (levels.encodingFor) e a antiga pode dar tamanho impar no novo (medido: 1904x1040 com a escala de 1798x1080
 * = 1268x693, OpenH264). Se a escala de algum espectador muda, a qualidade automatica reaplica o degrau de todos.
 */
function checkCaptureSize(ex: CaptureExtras) {
    const { local, quality } = ex;
    const before = ex.size;
    const now = captureSizeOf(local);
    if (now.width === before.width && now.height === before.height) return;
    ex.size = now;
    ex.resizedAt = performance.now();
    const changed = [...local.viewers].some(peerId => {
        const level = quality.levelFor(peerId);
        return encodingFor(level, before.width, before.height).scaleResolutionDownBy !== encodingFor(level, now.width, now.height).scaleResolutionDownBy;
    });
    if (!changed) return;
    logThrottled("capture-resized", "info", `A captura mudou de ${before.width}x${before.height} para ${now.width}x${now.height}: recalculando a redução de resolução `
        + "dos espectadores (em tamanho par, para a placa de vídeo continuar codificando H.264)", 10_000);
    quality.captureResized();
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
    // a senha vale so para esta captura (trocando de fonte, a nova ja recebeu uma copia)
    local.password = null;
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
    tooManyAttempts: `errou a senha ${MAX_PASSWORD_ATTEMPTS} vezes nesta transmissão`,
    duplicate: "outra conexão diz ser a mesma pessoa (identidade duplicada)"
};

/** Por que um pedido foi recusado (log do transmissor). */
const DENY_TEXT: Record<WatchDeniedReason, string> = {
    ...REFUSAL_TEXT,
    timeout: "o pedido de aprovação expirou",
    friendsOnly: "a transmissão é só para amigos e essa pessoa não é sua amiga no Discord",
    notVerified: "a transmissão é só para amigos e essa pessoa não provou a identidade do Discord (não verificado)"
};

const BLOCK_TEXT: Record<BlockReason, { why: string; until: string; rank: number; }> = {
    declined: { why: "recusado por você", until: "até esta transmissão acabar", rank: 1 },
    tooManyAttempts: { why: `bloqueado por errar a senha ${MAX_PASSWORD_ATTEMPTS} vezes`, until: "até esta transmissão acabar", rank: 2 },
    kicked: { why: "expulso por você", until: "até você sair da call", rank: 3 }
};

/** Desafios de senha pendentes (um por conexao, uso unico, ~2 min) e erros de senha por discordUserId, nesta transmissao. */
const challenges = new PasswordChallenges();
const wrongAttempts = new Map<string, number>();
/** muda a cada troca do modo/senha: uma prova conferida durante a troca nao vale (vira um desafio novo) */
let accessGeneration = 0;

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

function approvalInput(peerId: PeerId): ApprovalInput {
    return {
        configured: isIdentityConfigured(),
        identity: rt.peers.get(peerId)?.identity ?? "unverified",
        requireVerified: settings.store.requireVerifiedIdentity !== false
    };
}

/** Amigo no Discord de quem transmite. RelationshipStore so e lido aqui, na hora do pedido (nunca no carregamento). */
function isFriend(discordUserId: string): boolean {
    try {
        return RelationshipStore?.isFriend?.(discordUserId) === true;
    } catch {
        return false;
    }
}

/**
 * Decide o pedido desta conexao com o modo atual (core/access.ts). `proof` "wrong" ja conta mais um erro de senha
 * para o discordUserId anunciado. null = sem transmissao ou peer sumiu.
 */
function decideFor(peerId: PeerId, proof: ProofState): WatchDecision | null {
    const entry = rt.peers.get(peerId);
    const { local } = rt;
    if (!local || !entry?.hello) return null;
    const id = entry.hello.discordUserId;
    let attempts = wrongAttempts.get(id) ?? 0;
    if (proof === "wrong") wrongAttempts.set(id, ++attempts);
    const input: WatchAccessInput = {
        configured: isIdentityConfigured(),
        mode: local.access,
        identity: entry.identity,
        admitted: entry.admitted && !entry.incompatible,
        blocked: blockOf(peerId, id)?.reason ?? null,
        duplicate: entry.duplicate,
        approved: rt.approved.has(peerId),
        requireVerified: settings.store.requireVerifiedIdentity !== false,
        friend: local.access === "friends" && isFriend(id),
        proof,
        wrongAttempts: attempts
    };
    return decideWatch(input);
}

/** Aplica a decisao: manda o stream, abre o pedido de aprovacao, pede a senha ou recusa. */
function applyDecision(peerId: PeerId, d: WatchDecision, proof: ProofState) {
    switch (d.kind) {
        case "ignore":
            logThrottled(`watch-refused:${peerId}`, "warn", `${peerLabel(peerId)} pediu para assistir, mas não está admitido: ignorado`);
            return;
        case "send":
            if (proof === "ok") log.info(`${peerLabel(peerId)} acertou a senha`);
            sendTo(peerId);
            return;
        case "approval":
            requestApproval(peerId);
            return;
        case "password":
            askPassword(peerId, d.wrong, d.attemptsLeft);
            return;
        case "deny":
            if (d.block) {
                block(peerId, "tooManyAttempts");
                return;
            }
            logThrottled(`watch-denied:${peerId}:${d.reason}`, "warn", `${peerLabel(peerId)} pediu para assistir, mas ${DENY_TEXT[d.reason]}: recusado`);
            deny(peerId, d.reason);
    }
}

/** Pede a senha: desafio novo (nonce de uso unico, ~2 min). A senha nunca trafega, so a prova (protocol.ts, passo 7). */
function askPassword(peerId: PeerId, wrong: boolean, attemptsLeft: number) {
    const { nonce } = challenges.issue(peerId);
    const left = attemptsLeft === 1 ? "resta 1 tentativa" : `restam ${attemptsLeft} tentativas`;
    if (wrong) log.warn(`${peerLabel(peerId)} errou a senha (${left})`);
    else logThrottled(`watch-password:${peerId}`, "info", `${peerLabel(peerId)} pediu para assistir: a transmissão é com senha, pedindo a senha (${left}). `
        + "Se ele usa uma versão antiga do Telinha (v0.1.0), ela não entende o pedido de senha: o pedido dele expira sem resposta.", 60_000);
    reply(peerId, { op: "password", nonce, attemptsLeft, ...(wrong ? { wrong: true } : {}) });
}

/**
 * Prova de senha recebida: consome o desafio pendente (uso unico) e confere em tempo constante. Sem desafio valido
 * (vencido, ja usado, senha trocada no meio) a prova nao conta como erro: vai um desafio novo. Nunca lanca.
 */
async function checkPasswordProof(peerId: PeerId, proof: string) {
    const { local } = rt;
    const entry = rt.peers.get(peerId);
    const nonce = challenges.take(peerId);
    const gen = accessGeneration;
    const password = local?.password;
    if (!local || !entry?.hello || !nonce || !password) {
        handleStart(peerId, "stale");
        return;
    }
    let ok = false;
    try {
        ok = await verifyPasswordProof({ password, nonce, streamerId: me().id, viewerId: entry.hello.discordUserId, proof });
    } catch {
        ok = false;
    }
    if (rt.local !== local || accessGeneration !== gen || rt.peers.get(peerId) !== entry) {
        // a transmissao, a regra ou a conexao mudou durante a conta: decide de novo do zero
        if (rt.local && rt.peers.get(peerId)) handleStart(peerId, "stale");
        return;
    }
    handleStart(peerId, ok ? "ok" : "wrong");
}

/** Pedido "start" (com a prova ja conferida, se veio uma). */
function handleStart(peerId: PeerId, proof: ProofState) {
    if (!rt.local || rt.local.viewers.has(peerId)) return;
    const d = decideFor(peerId, proof);
    if (d) applyDecision(peerId, d, proof);
}

/** Pedido que precisa de aprovacao: fica pendente ate Permitir/Recusar ou 60 s. */
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
    const unverified = rt.local?.access === "all" && identityRequiresApproval(approvalInput(peerId));
    log.info(`${peerLabel(peerId)} (discord ${entry.hello.discordUserId}) pediu para assistir${unverified ? " sem identidade verificada" : ""}: esperando a sua aprovação`);
    reply(peerId, { op: "pending" });
    publish();
}

/**
 * Fim da transmissao: aprovacoes, pedidos pendentes, desafios/erros de senha, recusas e bloqueios por senha valem so
 * para ela (expulsoes continuam).
 */
function endOfStreamGuards() {
    for (const p of rt.pending.values()) clearTimeout(p.timer);
    rt.pending.clear();
    rt.approved.clear();
    challenges.clear();
    wrongAttempts.clear();
    for (const [id, b] of rt.blocked) if (b.reason === "declined" || b.reason === "tooManyAttempts") rt.blocked.delete(id);
}

/**
 * Expulsa (ate sair da call), recusa ou bloqueia por errar a senha (ate a transmissao acabar) a conexao e o
 * discordUserId que ela anuncia. O motivo mais forte vence (expulso > senha > recusado).
 */
function block(peerId: PeerId, reason: BlockReason): boolean {
    const entry = rt.peers.get(peerId);
    const id = entry?.hello?.discordUserId;
    if (!entry || !id) return false;

    const b = rt.blocked.get(id) ?? { discordUserId: id, username: nameOf(peerId), peerIds: new Set<PeerId>(), reason };
    b.peerIds.add(peerId);
    if (BLOCK_TEXT[reason].rank > BLOCK_TEXT[b.reason].rank) b.reason = reason;
    rt.blocked.set(id, b);

    const { why, until } = BLOCK_TEXT[reason];
    let told = false;
    for (const p of rt.peers.values()) {
        if (p.peerId !== peerId && p.hello?.discordUserId !== id) continue;
        rt.approved.delete(p.peerId);
        challenges.delete(p.peerId);
        if (cancelPending(p.peerId, reason)) {
            told ||= p.peerId === peerId;
            continue;
        }
        if (rt.local?.viewers.has(p.peerId)) {
            deny(p.peerId, reason);
            told ||= p.peerId === peerId;
            removeFrom(p.peerId, why);
        }
    }
    // errou a senha: quem errou nao esta pendente nem assistindo, mas precisa saber por que nao vai assistir
    if (reason === "tooManyAttempts" && !told) deny(peerId, reason);
    log.warn(`${peerLabel(peerId)} (discord ${id}) foi ${why}: não recebe a sua transmissão ${until}`);
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
    // liberado depois de errar a senha: ganha as tentativas de novo
    wrongAttempts.delete(discordUserId);
    log.info(`Você liberou de novo ${b.username} (discord ${discordUserId}) para pedir para assistir`);
    publish();
    return true;
}

/**
 * Pedidos pendentes decididos de novo com a regra atual (a pessoa provou a identidade, a opcao mudou, o modo
 * mudou): os que nao precisam mais de Permitir sao atendidos, recusados ou recebem o pedido de senha.
 */
export function reviewPendingApprovals() {
    for (const peerId of [...rt.pending.keys()]) {
        const d = decideFor(peerId, "none");
        if (!d || d.kind === "approval") continue;
        cancelPending(peerId, null);
        applyDecision(peerId, d, "none");
    }
}

/**
 * A opcao requireVerifiedIdentity (ou o modo da transmissao) mudou: quem ja assiste fica aprovado (nao cai da
 * transmissao por causa da mudanca) e os pedidos pendentes sao decididos de novo.
 */
export function onApprovalPolicyChanged() {
    for (const peerId of rt.local?.viewers ?? []) rt.approved.add(peerId);
    reviewPendingApprovals();
}

/** Quem pode assistir agora (null = nao esta transmitindo). */
export function getStreamAccess(): AccessMode | null {
    return rt.local?.access ?? null;
}

/** A senha desta transmissao (so com o modo "password"; nunca vai para o estado da UI nem para o diagnostico). */
export function getStreamPassword(): string | null {
    return rt.local?.access === "password" ? rt.local.password : null;
}

/**
 * Troca "Quem pode assistir" com a transmissao no ar. Vale para pedidos novos: quem ja assiste continua (fica
 * aprovado), os pedidos pendentes sao decididos de novo, desafios de senha em andamento deixam de valer e os erros
 * de senha zeram (quem ja foi bloqueado continua bloqueado). Lanca com a frase pronta em pt-BR.
 */
export function setStreamAccess(mode: AccessMode, rawPassword?: string) {
    const { local } = rt;
    if (!local) throw new Error("Você não está transmitindo.");
    const { access, password } = validateAccess(mode, rawPassword);
    if (access === local.access && password === local.password) return;
    const passwordOnly = access === local.access;
    local.access = access;
    local.password = password;
    accessGeneration++;
    challenges.clear();
    wrongAttempts.clear();
    log.info(passwordOnly
        ? "Senha da transmissão trocada (vale para novos pedidos; quem já assiste continua)"
        : `Quem pode assistir agora: ${ACCESS_LABEL[access]} (vale para novos pedidos; quem já assiste continua)`);
    onApprovalPolicyChanged();
    sendPresence();
    publish();
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
    const capture = captureSizeOf(local);
    const target = encodingFor(level, capture.width, capture.height);
    const build = (withDegradation: boolean) => {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        Object.assign(params.encodings[0], { ...target, priority: "high", networkPriority: "high" });
        if (withDegradation) (params as any).degradationPreference = "maintain-framerate";
        return params;
    };
    const scaled = scaledSize(capture.width, capture.height, target.scaleResolutionDownBy);
    const desc = `${levelText(level)}, até ${Math.round(target.maxBitrate / 1000)} kbps`
        + (target.scaleResolutionDownBy > 1 ? ` (captura ${capture.width}x${capture.height} ÷${target.scaleResolutionDownBy} = ${scaled.width}x${scaled.height})` : "");

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

/**
 * Checagem do encoder no ar (tick) de um envio H.264.
 *
 * O que tira o H.264 da placa de video no meio. Medido em 29/10/2026 no Electron 44.9.3 (Chromium 152), RTX 3070 com
 * driver 617.42, loopback com 42001f, quadros de 1080p60, getStats a cada 500 ms:
 * - o RTCVideoEncoder do Chromium so usa a placa para H.264 com largura E altura pares e altura >= 360
 *   (codec.ts → h264HwAcceptsSize); fora disso o WebRTC usa o OpenH264. Ex.: 480x270, 320x180, 853x480 e 1136x639 no
 *   OpenH264; 640x360, 800x450, 768x432 e 714x500 na placa. Volta para a placa sozinho na proxima reconfiguracao com um
 *   tamanho valido;
 * - com a banda baixa (~0,5 Mbps) o proprio WebRTC reduz a resolucao (degradationPreference "maintain-framerate",
 *   qualityLimitationReason "bandwidth"), um degrau a cada ~5 s: de 1920x1080 vai a 1280x720, 960x540, 640x360 (placa)
 *   e 480x270 (OpenH264). Em cima do nosso degrau 720p (scaleResolutionDownBy 1,5 = 1280x720) vai a 853x480 (largura
 *   impar: OpenH264), 640x360 (placa de novo), 427x240 e 320x180 (OpenH264). Foi o que aconteceu no log de 29/10
 *   (banda ~0,5 Mbps + degrau 720p, OpenH264 18 s depois). Isso e de passagem e o espectador nao trava (no loopback:
 *   decodifica a 55+ fps, sem congelar nem pedir PLI). Por isso nao conta como queda (isTransientSoftwareH264): so loga;
 * - nao tiram da placa: o nosso scaleResolutionDownBy 1,5 sozinho (1080p→720p, com ou sem 12 Mbps), reconectar 3 vezes
 *   com 1,5 s de intervalo, 3 envios H.264 ao mesmo tempo;
 * - a captura nunca chega com tamanho impar (medido no mesmo dia com uma janela nossa capturada como o Telinha captura,
 *   getDisplayMedia + id "window:..."): o capturador do Chromium alinha a saida em 2x2 e redimensiona a janela para
 *   caber, ex.: 1001x701 → 1000x700, 1201x801 → 1200x800, 2001x1201 → 1798x1080, 641x361 → 640x360, tambem com a janela
 *   mudando de tamanho no meio, sempre na placa. Por isso nao ha recorte de 1 px: um MediaStreamTrackProcessor/Generator
 *   com visibleRect (num worker, +0,1 ms) passou 993 quadros sem recortar nenhum, e applyConstraints com um tamanho par
 *   fixo reescala e nao acompanha a janela (1200x800 virou 952x634);
 * - o tamanho impar vinha da NOSSA reducao: o degrau 720p com a escala altura/720 dava largura impar em metade das janelas,
 *   ex.: 1798x1080 ÷1,5 = 1199x720 no OpenH264, com qualityLimitationReason "none" (contava como queda). Agora
 *   levels.evenScale escolhe uma escala que da largura e altura pares (÷1,501 = 1198x720, na placa) e checkCaptureSize
 *   reaplica quando a janela muda de tamanho (a escala antiga no tamanho novo: 1904x1040 → 1268x693, OpenH264; a
 *   reaplicada, 1318x720, volta para a placa). Ate RESIZE_GRACE_MS depois da mudanca, OpenH264 e esse meio tempo: so loga.
 *
 * Queda de verdade (OpenH264 num tamanho que a placa aceita, ou com o WebRTC sem reduzir nada, ex.: uma reducao nossa com
 * tamanho impar, que evenScale evita): so ESTE espectador passa para o codec que chooseCodec escolher sem a placa (VP9); os proximos
 * ainda tentam a placa. Na 2a queda da sessao do Discord (noteH264Fallback), o H.264 automatico desliga para os
 * proximos. Uma vez por espectador (send.fellBack): nunca volta e repete. Codec fixado em H.264: continua H.264.
 */
function checkEncoder(peerId: PeerId, local: LocalCapture, send: ViewerSend, enc: EncoderReport) {
    if (send.fellBack) return;
    const label = peerLabel(peerId);
    const size = enc.width && enc.height ? `${enc.width}x${enc.height}` : "tamanho desconhecido";
    if (isTransientSoftwareH264(enc)) {
        send.transientSoftware = true;
        logThrottled(`h264-transient:${peerId}`, "info", `O H.264 para ${label} passou para o OpenH264 (software) em ${size}: o WebRTC reduziu a resolução `
            + `por conta própria (${enc.limitation === "cpu" ? "CPU" : enc.limitation === "bandwidth" ? "banda" : enc.limitation}) e a placa de vídeo só codifica H.264 `
            + "em tamanho par a partir de 360p. Volta para a placa sozinho quando a resolução subir; não é queda.", 60_000);
        return;
    }
    if (isSoftwareH264(enc) && resizing(local)) {
        send.transientSoftware = true;
        logThrottled(`h264-resize:${peerId}`, "info", `O H.264 para ${label} passou para o OpenH264 (software) em ${size} logo depois de a janela capturada `
            + "mudar de tamanho: a redução de resolução está sendo recalculada em tamanho par e ele volta para a placa de vídeo. Não é queda.", 60_000);
        return;
    }
    if (send.transientSoftware && enc.powerEfficient === true) {
        send.transientSoftware = false;
        logThrottled(`h264-back:${peerId}`, "info", `O H.264 para ${label} voltou para a placa de vídeo (${size})`, 60_000);
    }

    const next = softwareFallback(enc, false, rt.peers.get(peerId)?.presence?.caps, settings.store.codec as CodecSetting, getLocalCaps());
    if (!next) return;
    send.fellBack = true;
    const name = next.codec.toUpperCase();
    const { count, disabledNow } = noteH264Fallback();
    const why = `O H.264 para ${label} está sendo codificado por software (${enc.implementation || "sem aceleração"}, ${size}), não pela placa de vídeo, e a imagem pode travar`;
    if (next.codec === send.decision.codec) {
        const session = disabledNow ? ` Foi a ${count}ª queda nesta sessão: o H.264 automático fica desligado.` : "";
        log.warn(`${why}. Continua em H.264 porque o codec está fixado nas configurações.${session}`);
        return;
    }
    const others = disabledNow
        ? ` Foi a ${count}ª queda nesta sessão: os próximos espectadores vão receber ${name}.`
        : getLocalCaps().h264HwEncode ? " Os próximos espectadores ainda tentam a placa de vídeo." : "";
    log.warn(`${why}: trocando para ${name} só para ${label}.${others}`);
    void switchSendCodec(peerId, local, send, next);
}

/**
 * Troca o codec de um envio no ar sem renegociar e sem reconectar o espectador: setParameters com encodings[0].codec,
 * escolhido entre os codecs ja negociados com ele (a negociacao sempre leva todos; so a ordem muda). Conferido num
 * loopback no Chromium 152: H.264 → VP9 na hora, o receiver continua decodificando a mesma faixa e o codec fica nos
 * setParameters seguintes (qualidade automatica). Se o Chromium recusar (ex.: colidiu com um setParameters da
 * qualidade automatica), tenta mais uma vez; falhando de novo, so avisa.
 */
async function switchSendCodec(peerId: PeerId, local: LocalCapture, send: ViewerSend, next: CodecDecision) {
    const label = peerLabel(peerId);
    const name = next.codec.toUpperCase();
    // renegociacoes futuras (sendPlanFor) ja vao com o codec novo
    send.decision = next;
    let error = "";
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
        const sender = videoSender(peerId, local);
        if (sends.get(peerId) !== send || !sender) return;
        try {
            const params = sender.getParameters();
            const codec = pickNegotiatedCodec(params.codecs ?? [], next);
            if (!codec || !params.encodings?.length) {
                error = `${name} não foi negociado com ele`;
                break;
            }
            (params.encodings[0] as RTCRtpEncodingParameters & { codec?: RTCRtpCodec; }).codec = codec;
            await sender.setParameters(params);
            log.info(`${label} agora recebe ${name} (trocado sem reconectar)`);
            // o tick loga o encoder novo (depois de o Chromium trocar de fato)
            setTimeout(() => {
                if (sends.get(peerId) === send) send.reportedCodec = undefined;
            }, 2000);
            return;
        } catch (e) {
            error = errorText(e);
        }
    }
    log.warn(`Não deu para trocar ${label} para ${name} (${error}). Peça para ele parar de assistir e assistir de novo: vai receber ${name}.`);
}

// #region eventos vindos da sessao

export function onWatchRequest(peerId: PeerId, request: WatchMessage) {
    if (request.op === "stop") {
        challenges.delete(peerId);
        if (cancelPending(peerId, null)) log.info(`${peerLabel(peerId)} desistiu do pedido para assistir`);
        removeFrom(peerId, "parou de assistir");
        return;
    }
    // admissao primeiro: quem esta fora do canal de voz (ou com prova de identidade falsa) nao recebe nem resposta
    const entry = rt.peers.get(peerId);
    if (!entry?.admitted) {
        if (entry?.identity === "pending") logThrottled(`watch-pending-id:${peerId}`, "info", `${peerLabel(peerId)} pediu para assistir enquanto a identidade ainda é conferida: ignorado`);
        else if (entry?.identity !== "invalid") logThrottled(`watch-refused:${peerId}`, "warn", `${peerLabel(peerId)} pediu para assistir, mas não está no seu canal de voz: recusado`);
        return;
    }
    if (!rt.local) {
        logThrottled(`watch-idle:${peerId}`, "info", `${peerLabel(peerId)} pediu para assistir, mas você não está transmitindo`);
        sendPresence(peerId);
        return;
    }
    if (rt.local.viewers.has(peerId)) return;
    // prova da senha so conta no modo "password" (num modo que mudou no meio, vale como um pedido comum)
    if (request.proof && rt.local.access === "password") {
        void checkPasswordProof(peerId, request.proof).catch(e => log.warn("Senha: erro ao conferir a prova: " + errorText(e)));
        return;
    }
    handleStart(peerId, "none");
}

export function onPeerGone(peerId: PeerId) {
    sends.delete(peerId);
    rt.approved.delete(peerId);
    challenges.delete(peerId);
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
 * por espectador (uma vez), confere se um envio H.264 caiu no encoder por software (checkEncoder), se a captura mudou
 * de tamanho (checkCaptureSize) e, a cada 2 s, roda a qualidade automatica.
 */
export function tick() {
    const { local } = rt;
    if (!local) return;
    for (const peerId of challenges.sweep()) {
        if (!rt.peers.has(peerId)) continue;
        log.warn(`${peerLabel(peerId)} não respondeu ao pedido de senha em ${PASSWORD_NONCE_TTL_MS / 60_000} min: desistiu, ou usa uma versão antiga do Telinha (v0.1.0), `
            + "que não entende transmissão com senha (do lado dele o pedido expira sem resposta)");
    }
    for (const peerId of [...local.viewers]) {
        const refusal = refusalFor(peerId);
        if (!refusal) continue;
        if (refusal !== "outsider") deny(peerId, refusal);
        removeFrom(peerId, refusal === "outsider" ? "não está mais admitido" : REFUSAL_TEXT[refusal]);
    }
    if (extras?.local === local) checkCaptureSize(extras);
    if (++tickCount % 2 === 0) void qualityOf(local)?.evaluate();
    for (const peerId of local.viewers) {
        const send = sends.get(peerId);
        // depois de logar o codec real, so o envio que esta de fato em H.264 continua sendo conferido (o Chromium pode
        // trocar o encoder da placa de video pelo OpenH264 no meio, ex.: quando o WebRTC reduz a resolucao; ver checkEncoder)
        if (!send || (send.reportedCodec && (!/^video\/h264$/i.test(send.reportedCodec) || send.fellBack))) continue;
        const sender = videoSender(peerId, local);
        if (!sender) continue;
        sender.getStats().then(report => {
            let out: any;
            report.forEach((s: any) => {
                if (s.type === "outbound-rtp" && s.kind === "video") out = s;
            });
            const codec = out?.codecId ? (report.get(out.codecId) as any)?.mimeType : undefined;
            if (!codec || sends.get(peerId) !== send) return;
            const enc: EncoderReport = {
                mimeType: codec, implementation: out.encoderImplementation, powerEfficient: out.powerEfficientEncoder, framesEncoded: out.framesEncoded,
                width: out.frameWidth, height: out.frameHeight, limitation: out.qualityLimitationReason
            };
            if (!send.reportedCodec) {
                send.reportedCodec = codec;
                const expected = `video/${send.decision.codec}`.toLowerCase();
                const msg = `Codificando para ${peerLabel(peerId)}: ${codec}${enc.implementation ? ` (${enc.implementation}${enc.powerEfficient ? ", hardware" : ""})` : ""}`;
                if (codec.toLowerCase() === expected) log.info(msg);
                else log.warn(`${msg} — esperado ${send.decision.codec.toUpperCase()}`);
            }
            checkEncoder(peerId, local, send, enc);
        }).catch(() => { });
    }
}

// #endregion
