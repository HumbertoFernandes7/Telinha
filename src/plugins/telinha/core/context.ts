/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { HelloMessage, PresenceMessage, WatchMessage } from "@plugins/telinha/protocol";
import { setState } from "@plugins/telinha/store";
import type { AutoQualityState, CaptureSource, PeerId, Quality, RemotePeer, StreamInfo, TelinhaState, ViewerSession, ViewerStatus } from "@plugins/telinha/types";
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
    watchAction: null as MessageAction<WatchMessage> | null,
    channelId: null as string | null,
    guildId: null as string | null,
    peers: new Map<PeerId, PeerEntry>(),
    local: null as LocalCapture | null,
    viewing: new Map<PeerId, ViewerEntry>(),
    lastError: null as string | null
};

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
    for (const p of rt.peers.values()) {
        if (p.incompatible || !p.hello) continue;
        const pres = p.presence;
        peers.push({
            peerId: p.peerId,
            discordUserId: p.hello.discordUserId,
            username: pres?.username ?? p.hello.username,
            streaming: !!pres?.streaming,
            ...(pres?.streaming && pres.stream ? { stream: { ...pres.stream } } : {}),
            admitted: p.admitted
        });
    }
    peers.sort((a, b) => a.username.localeCompare(b.username) || a.peerId.localeCompare(b.peerId));

    const viewing: Record<PeerId, ViewerSession> = {};
    for (const v of rt.viewing.values()) {
        viewing[v.peerId] = {
            peerId: v.peerId,
            stream: v.stream,
            status: v.status,
            ...(v.error ? { error: v.error } : {}),
            ...(v.stats ? { stats: { ...v.stats } } : {})
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
                captureWarning: local.captureWarning ?? null
            }
            : null,
        viewing,
        lastError: rt.lastError
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
