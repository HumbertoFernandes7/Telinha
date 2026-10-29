/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Contrato entre o nucleo (core/, store.ts, actions.ts) e a UI (index.tsx, ui/**).
// Mudancas aqui quebram a UI: combine antes.

export type PeerId = string;

export interface StreamInfo {
    kind: "screen" | "window";
    title: string;
    hasAudio: boolean;
    width: number;
    height: number;
    fps: number;
}

export interface RemotePeer {
    peerId: PeerId;
    discordUserId: string;
    username: string;
    streaming: boolean;
    stream?: StreamInfo;
    admitted: boolean;
}

export interface CaptureSource {
    id: string;
    name: string;
    kind: "screen" | "window";
    thumbnail?: string;
}

export type Quality = "1080p60" | "720p60" | "1080p30";

export interface StreamOptions {
    source: CaptureSource;
    withAudio: boolean;
    quality: Quality;
}

export type ViewerStatus = "connecting" | "waiting-first-frame" | "playing" | "ended" | "error";

export interface ViewerSession {
    peerId: PeerId;
    stream: MediaStream | null;
    status: ViewerStatus;
    error?: string;
    stats?: { width: number; height: number; fps: number; kbps: number; };
}

export interface LocalStream {
    source: CaptureSource;
    quality: Quality;
    hasAudio: boolean;
    startedAt: number;
    viewers: PeerId[];
}

export interface PeerLiveState {
    inRoom: boolean;
    channelId: string | null;
    peers: RemotePeer[];
    local: LocalStream | null;
    viewing: Record<PeerId, ViewerSession>;
    lastError: string | null;
}
