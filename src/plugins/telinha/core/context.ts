/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { HelloMessage, PresenceMessage, WatchActionMessage } from "@plugins/telinha/protocol";
import { setState } from "@plugins/telinha/store";
import type {
    AutoQualityState, BlockedViewer, BlockReason, CaptureSource, IdentityAlert, PeerId, PendingViewer, Quality, RemotePeer, StreamInfo,
    TelinhaState, ViewDeniedReason, ViewerSession, ViewerStatus
} from "@plugins/telinha/types";
import type { MessageAction, Room } from "trystero";

import { shortId } from "./log";

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
    /** o handshake anunciou o SEU discordUserId (e incompatible tambem: nunca e aceito) */
    claimsSelf: boolean;
}

/** Expulso/recusado: bloqueia o discordUserId anunciado E as conexoes (peerIds) que foram expulsas. */
export interface BlockEntry {
    discordUserId: string;
    username: string;
    peerIds: Set<PeerId>;
    reason: BlockReason;
}

/** Pedido para assistir esperando aprovacao (opcao approveViewers). */
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
    /** performance.now() do pedido */
    requestedAt: number;
    /** performance.now() do primeiro quadro decodificado */
    firstFrameAt: number | null;
    /** ultima leitura para calcular kbps/fps */
    meter: { bytes: number; frames: number; at: number; } | null;
    /** limpeza dos timers do pedido (timeout de resposta) */
    requestCleanup: (() => void)[];
    /** limpeza dos listeners/timers do stream atual */
    streamCleanup: (() => void)[];
}

export const rt = {
    room: null as Room | null,
    presenceAction: null as MessageAction<PresenceMessage> | null,
    watchAction: null as MessageAction<WatchActionMessage> | null,
    channelId: null as string | null,
    guildId: null as string | null,
    peers: new Map<PeerId, PeerEntry>(),
    local: null as LocalCapture | null,
    viewing: new Map<PeerId, ViewerEntry>(),
    lastError: null as string | null,
    /** expulsos (ate sair da sala) e recusados (ate a transmissao acabar), por discordUserId anunciado */
    blocked: new Map<string, BlockEntry>(),
    /** conexoes aprovadas nesta transmissao (opcao approveViewers) */
    approved: new Set<PeerId>(),
    /** pedidos esperando aprovacao */
    pending: new Map<PeerId, PendingEntry>()
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
    const peers: RemotePeer[] = [];
    const alerts = new Map<string, IdentityAlert>();
    for (const p of rt.peers.values()) {
        if (p.claimsSelf && p.hello) {
            const a = alerts.get(p.hello.discordUserId) ?? { discordUserId: p.hello.discordUserId, username: p.hello.username, peerIds: [], self: true };
            a.peerIds.push(p.peerId);
            alerts.set(p.hello.discordUserId, a);
        }
        if (p.incompatible || !p.hello) continue;
        const pres = p.presence;
        const username = pres?.username ?? p.hello.username;
        const block = blockOf(p.peerId, p.hello.discordUserId);
        peers.push({
            peerId: p.peerId,
            discordUserId: p.hello.discordUserId,
            username,
            streaming: !!pres?.streaming,
            ...(pres?.streaming && pres.stream ? { stream: { ...pres.stream } } : {}),
            admitted: p.admitted,
            inVoice: p.inVoice,
            ...(p.duplicate ? { duplicateIdentity: true } : {}),
            ...(block ? { blocked: block.reason } : {})
        });
        if (p.duplicate) {
            const a = alerts.get(p.hello.discordUserId) ?? { discordUserId: p.hello.discordUserId, username, peerIds: [], self: false };
            a.peerIds.push(p.peerId);
            alerts.set(p.hello.discordUserId, a);
        }
    }
    peers.sort((a, b) => a.username.localeCompare(b.username) || a.peerId.localeCompare(b.peerId));

    const blocked: BlockedViewer[] = [...rt.blocked.values()].map(b => ({ discordUserId: b.discordUserId, username: b.username, reason: b.reason }));
    const pendingViewers: PendingViewer[] = [...rt.pending.values()].map(p => ({ peerId: p.peerId, discordUserId: p.discordUserId, username: p.username, expiresAt: p.expiresAt }));

    const viewing: Record<PeerId, ViewerSession> = {};
    for (const v of rt.viewing.values()) {
        viewing[v.peerId] = {
            peerId: v.peerId,
            stream: v.stream,
            status: v.status,
            ...(v.error ? { error: v.error } : {}),
            ...(v.stats ? { stats: { ...v.stats } } : {}),
            ...(v.awaitingApproval && v.status === "connecting" ? { awaitingApproval: true } : {}),
            ...(v.denied && v.status === "error" ? { denied: v.denied } : {})
        };
    }

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
                pendingViewers
            }
            : null,
        viewing,
        lastError: rt.lastError,
        blocked,
        identityAlerts: [...alerts.values()]
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
