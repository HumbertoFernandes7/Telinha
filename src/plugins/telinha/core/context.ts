/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { CodecRequestMessage, DiagMessage, HelloMessage, IdentityMessage, PresenceMessage, WatchActionMessage } from "@plugins/telinha/protocol";
import { setState } from "@plugins/telinha/store";
import type {
    AccessMode, AutoQualityState, BlockedViewer, BlockReason, CaptureSource, DiagShareState, IdentityAlert, PeerId, PendingViewer, Quality, RemotePeer,
    StreamInfo, TelinhaState, ViewDeniedReason, ViewerSession, ViewerStatus
} from "@plugins/telinha/types";
import type { MessageAction, Room } from "trystero";

import { isIdentityConfigured } from "./identity/config";
import type { PeerIdentity } from "./identity/policy";
import type { IdentityFailure } from "./identity/verify";
import { shortId } from "./log";
import type { ReceiverLog } from "./statsLog";

// Estado mutavel do nucleo. A UI nunca ve isto: publish() monta um snapshot imutavel para o store.

export interface PeerEntry {
    peerId: PeerId;
    hello: HelloMessage | null;
    presence: PresenceMessage | null;
    /** o discordUserId do handshake esta no nosso canal de voz agora */
    inVoice: boolean;
    /** handshake com versao/formato incompativel (ou que se diz ser voce): o peer e ignorado */
    incompatible: boolean;
    /**
     * Aceito pela politica de admissao (no canal de voz, ou "recusar quem esta fora" desligado).
     * So peers admitidos recebem nossa presenca e nossa transmissao. Cache de presence.isAdmitted().
     */
    admitted: boolean;
    /** outra conexao viva na sala anuncia o mesmo discordUserId (session.ts → checkIdentities) */
    duplicate: boolean;
    /** duplicate, e o mesmo discordUserId provou a identidade em outra conexao: esta e a impostora */
    impostor: boolean;
    /** o handshake anunciou o SEU discordUserId (e incompatible tambem: nunca e aceito) */
    claimsSelf: boolean;
    /** prova de identidade do Discord (core/identity/policy.ts). Sem Client ID: sempre "unverified" e ignorada */
    identity: PeerIdentity;
    /** por que nao esta verificada (diagnostico) */
    identityReason?: IdentityFailure;
    /** verificacao em andamento (uma por vez por conexao) */
    identityChecking: boolean;
    /** Date.now() da ultima verificacao iniciada (limita a acao "identity") */
    identityCheckedAt: number;
}

/** Expulso/recusado: bloqueia o discordUserId anunciado E as conexoes (peerIds) que foram expulsas. */
export interface BlockEntry {
    discordUserId: string;
    username: string;
    peerIds: Set<PeerId>;
    reason: BlockReason;
}

/** Pedido para assistir esperando aprovacao (Permitir/Recusar). */
export interface PendingEntry {
    peerId: PeerId;
    discordUserId: string;
    username: string;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
}

export interface LocalCapture {
    stream: MediaStream;
    source: CaptureSource;
    quality: Quality;
    info: StreamInfo;
    startedAt: number;
    viewers: Set<PeerId>;
    /** qualidade automatica (core/quality/controller.ts): snapshot imutavel; null = desligada */
    autoQuality?: AutoQualityState | null;
    /** aviso da captura (core/quality/captureMonitor.ts); null = ok */
    captureWarning?: string | null;
    /** quem pode assistir (core/access.ts); muda pela barra do Telinha com a transmissao no ar */
    access: AccessMode;
    /** com access "password": a senha desta transmissao, normalizada. So na memoria; some quando ela acaba */
    password: string | null;
}

export interface ViewerEntry {
    peerId: PeerId;
    status: ViewerStatus;
    error?: string;
    stream: MediaStream | null;
    stats?: ViewerSession["stats"];
    /** o transmissor respondeu "pending": esperando a aprovacao dele */
    awaitingApproval?: boolean;
    /** o transmissor respondeu "denied" */
    denied?: ViewDeniedReason;
    /** transmissao com senha: o ultimo desafio do transmissor, esperando a senha (UI: passwordPrompt) */
    challenge?: { nonce: string; attemptsLeft: number | null; wrong: boolean; } | null;
    /** a senha da prova que esta a caminho (vira a senha lembrada quando o stream chega) */
    proofPassword?: string | null;
    /** a prova a caminho usou a senha lembrada (se estiver errada, ela e esquecida) */
    proofFromMemory?: boolean;
    /** ja reenviou uma vez a mesma senha porque o desafio tinha vencido */
    staleRetried?: boolean;
    /** performance.now() do pedido */
    requestedAt: number;
    /** performance.now() do primeiro quadro decodificado */
    firstFrameAt: number | null;
    /** ultima leitura para calcular kbps/fps */
    meter: { bytes: number; frames: number; at: number; } | null;
    /** log de estatisticas do stream atual (core/statsLog.ts): linhas a cada STATS_LOG_MS e o resumo quando ele acaba */
    statsLog?: ReceiverLog;
    /**
     * ultimo pedido de VP9 ao transmissor neste stream (viewing.ts → askForVp9), em multiplos de NO_FRAME_HINT_MS desde que
     * o stream chegou (1 = o de 10 s, 2 = o de 20 s...); 0 ou ausente = nenhum. Zerado a cada stream novo (attachStream).
     */
    codecAskSlot?: number;
    /** limpeza dos timers do pedido (timeout de resposta) */
    requestCleanup: (() => void)[];
    /** limpeza dos listeners/timers do stream atual */
    streamCleanup: (() => void)[];
}

/** Quem recebe o diagnostico deste PC (core/diagShare.ts, lado de quem manda): uma entrada por conexao que pediu. */
export interface DiagSubscriber {
    peerId: PeerId;
    discordUserId: string;
    username: string;
    /** a primeira parte (sessao anterior + "Copiar diagnóstico") ja esta na fila; antes disso as linhas novas esperam */
    ready: boolean;
    /** numero da ultima linha do log ja enviada (ou coberta pelo texto do "Copiar diagnóstico") */
    sentSeq: number;
    /** envios em ordem: a primeira parte pode ser mais de uma mensagem */
    chain: Promise<void>;
}

/** Uma conexao da qual pedimos o diagnostico (core/diagShare.ts, lado de quem pede). */
export interface DiagSubscription {
    peerId: PeerId;
    discordUserId: string;
    username: string;
    /** ja chegou alguma linha */
    receiving: boolean;
    /** limite de recepcao: linhas que ainda cabem agora (balde que enche com o tempo) */
    tokens: number;
    /** Date.now() da ultima recarga do balde */
    refilledAt: number;
}

export const rt = {
    room: null as Room | null,
    presenceAction: null as MessageAction<PresenceMessage> | null,
    watchAction: null as MessageAction<WatchActionMessage> | null,
    /** acao "identity" (so com Client ID) */
    identityAction: null as MessageAction<IdentityMessage> | null,
    /** acao "codec": o espectador sem quadro em H.264 pede VP9 (protocol.ts, passo 8) */
    codecAction: null as MessageAction<CodecRequestMessage> | null,
    /** fingerprint do certificado DTLS que a sala atual usa (rtcConfig.certificates); null = o do Chromium */
    certFingerprint: null as string | null,
    channelId: null as string | null,
    guildId: null as string | null,
    peers: new Map<PeerId, PeerEntry>(),
    local: null as LocalCapture | null,
    viewing: new Map<PeerId, ViewerEntry>(),
    lastError: null as string | null,
    /** expulsos (ate sair da sala) e recusados (ate a transmissao acabar), por discordUserId anunciado */
    blocked: new Map<string, BlockEntry>(),
    /** conexoes aprovadas nesta transmissao (Permitir, ou ja assistiam quando a regra mudou) */
    approved: new Set<PeerId>(),
    /** pedidos esperando aprovacao */
    pending: new Map<PeerId, PendingEntry>(),
    /** acao "diag": diagnostico compartilhado (protocol.ts, passo 9; so com Client ID) */
    diagAction: null as MessageAction<DiagMessage> | null,
    /** conexoes que estao recebendo o diagnostico deste PC */
    diagSending: new Map<PeerId, DiagSubscriber>(),
    /** de quem pedimos o diagnostico ("Receber diagnóstico" ligado): discordUserId → nome */
    diagRequested: new Map<string, string>(),
    /** conexoes as quais mandamos "subscribe" */
    diagReceiving: new Map<PeerId, DiagSubscription>()
};

/** Bloqueio que vale para esta conexao: pelo discordUserId anunciado ou pela propria conexao. */
export function blockOf(peerId: PeerId, discordUserId: string | undefined): BlockEntry | null {
    if (discordUserId) {
        const byUser = rt.blocked.get(discordUserId);
        if (byUser) return byUser;
    }
    for (const b of rt.blocked.values()) if (b.peerIds.has(peerId)) return b;
    return null;
}

export function peerLabel(peerId: PeerId) {
    const p = rt.peers.get(peerId);
    const name = p?.presence?.username ?? p?.hello?.username;
    return name ? `${name} (${shortId(peerId)})` : shortId(peerId);
}

export function getPc(peerId: PeerId): RTCPeerConnection | null {
    try {
        return rt.room?.getPeers()[peerId] ?? null;
    } catch {
        return null;
    }
}

export function setLastError(message: string | null) {
    rt.lastError = message;
    publish();
}

// #region snapshot

let scheduled = false;

function buildSnapshot(): TelinhaState {
    const configured = isIdentityConfigured();
    const peers: RemotePeer[] = [];
    const alerts = new Map<string, IdentityAlert>();
    const alert = (key: string, init: () => IdentityAlert, peerId: PeerId) => {
        const a = alerts.get(key) ?? init();
        a.peerIds.push(peerId);
        alerts.set(key, a);
    };
    for (const p of rt.peers.values()) {
        const { hello } = p;
        if (p.claimsSelf && hello) {
            alert(hello.discordUserId, () => ({ discordUserId: hello.discordUserId, username: hello.username, peerIds: [], self: true }), p.peerId);
        }
        if (p.incompatible || !hello) continue;
        if (configured && p.identity === "invalid") {
            // prova falsa: fora da lista de peers (nao ve nada, nao assiste, nao e assistido), so o alerta
            alert(`fake:${hello.discordUserId}`, () => ({ discordUserId: hello.discordUserId, username: hello.username, peerIds: [], self: false, kind: "fake" }), p.peerId);
            continue;
        }
        const pres = p.presence;
        const username = pres?.username ?? hello.username;
        const block = blockOf(p.peerId, hello.discordUserId);
        peers.push({
            peerId: p.peerId,
            discordUserId: hello.discordUserId,
            username,
            streaming: !!pres?.streaming,
            ...(pres?.streaming && pres.stream ? { stream: { ...pres.stream } } : {}),
            admitted: p.admitted,
            inVoice: p.inVoice,
            ...(p.duplicate ? { duplicateIdentity: true } : {}),
            ...(block ? { blocked: block.reason } : {}),
            ...(configured ? { identity: p.identity } : {}),
            ...(pres?.caps.diag === true ? { diagShare: true } : {})
        });
        if (p.duplicate) {
            const kind = p.impostor ? "impostor" : "duplicate";
            alert(`${kind}:${hello.discordUserId}`, () => ({ discordUserId: hello.discordUserId, username, peerIds: [], self: false, ...(p.impostor ? { kind } : {}) }), p.peerId);
        }
    }
    peers.sort((a, b) => a.username.localeCompare(b.username) || a.peerId.localeCompare(b.peerId));

    const blocked: BlockedViewer[] = [...rt.blocked.values()].map(b => ({ discordUserId: b.discordUserId, username: b.username, reason: b.reason }));
    const pendingViewers: PendingViewer[] = [...rt.pending.values()].map(p => {
        const identity = configured ? rt.peers.get(p.peerId)?.identity : undefined;
        return { peerId: p.peerId, discordUserId: p.discordUserId, username: p.username, expiresAt: p.expiresAt, ...(identity ? { identity } : {}) };
    });

    const viewing: Record<PeerId, ViewerSession> = {};
    for (const v of rt.viewing.values()) {
        viewing[v.peerId] = {
            peerId: v.peerId,
            stream: v.stream,
            status: v.status,
            ...(v.error ? { error: v.error } : {}),
            ...(v.stats ? { stats: { ...v.stats } } : {}),
            ...(v.awaitingApproval && v.status === "connecting" ? { awaitingApproval: true } : {}),
            ...(v.denied && v.status === "error" ? { denied: v.denied } : {}),
            ...(v.status === "connecting" && v.challenge ? { passwordPrompt: { attemptsLeft: v.challenge.attemptsLeft, wrong: v.challenge.wrong } } : {}),
            ...(v.status === "connecting" && !v.challenge && v.proofPassword ? { checkingPassword: true } : {})
        };
    }

    const diag: DiagShareState = {
        sendingTo: [...rt.diagSending.values()].map(s => s.username),
        requested: [...rt.diagRequested.keys()],
        receivingFrom: [...new Set([...rt.diagReceiving.values()].filter(s => s.receiving).map(s => s.discordUserId))]
    };
    const hasDiag = diag.sendingTo.length > 0 || diag.requested.length > 0 || diag.receivingFrom.length > 0;

    const { local } = rt;
    return {
        inRoom: !!rt.room,
        channelId: rt.channelId,
        peers,
        local: local
            ? {
                source: local.source,
                quality: local.quality,
                hasAudio: local.info.hasAudio,
                startedAt: local.startedAt,
                viewers: [...local.viewers],
                autoQuality: local.autoQuality ?? null,
                captureWarning: local.captureWarning ?? null,
                pendingViewers,
                access: local.access
            }
            : null,
        viewing,
        lastError: rt.lastError,
        blocked,
        identityAlerts: [...alerts.values()],
        ...(hasDiag ? { diag } : {})
    };
}

/** Agenda a publicacao de um snapshot novo (agrupa varias mudancas na mesma volta do event loop). */
export function publish() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
        scheduled = false;
        setState(buildSnapshot());
    });
}

// #endregion
