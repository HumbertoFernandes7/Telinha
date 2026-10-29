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
    /** o discordUserId anunciado esta no seu canal de voz agora */
    inVoice?: boolean;
    /**
     * Outra conexao na sala diz ser a mesma pessoa (mesmo discordUserId): uma pode ser falsa.
     * Enquanto durar, nenhuma das duas recebe a sua transmissao.
     */
    duplicateIdentity?: boolean;
    /** voce expulsou/recusou esta conexao ou esta pessoa: nao recebe a sua transmissao */
    blocked?: BlockReason;
}

/** "kicked" = expulso (vale ate voce sair da call); "declined" = recusado (vale ate a transmissao acabar) */
export type BlockReason = "kicked" | "declined";

/** Pedido para assistir esperando a sua aprovacao (opcao approveViewers). */
export interface PendingViewer {
    peerId: PeerId;
    discordUserId: string;
    username: string;
    /** Date.now() em que o pedido e recusado sozinho */
    expiresAt: number;
}

/** Pessoa que voce expulsou/recusou (pode ser liberada de novo com unblockViewer). */
export interface BlockedViewer {
    discordUserId: string;
    username: string;
    reason: BlockReason;
}

/** Alerta de identidade: duas conexoes dizem ser a mesma pessoa, ou alguem diz ser voce. */
export interface IdentityAlert {
    discordUserId: string;
    username: string;
    peerIds: PeerId[];
    /** a conexao diz ser VOCE (nunca e aceita) */
    self: boolean;
}

/** Por que o transmissor nao manda (ou parou de mandar) a transmissao para voce. */
export type ViewDeniedReason = "kicked" | "declined" | "timeout" | "duplicate";

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
    /** status "connecting": o transmissor ainda precisa aprovar o pedido */
    awaitingApproval?: boolean;
    /** status "error": o transmissor encerrou/recusou a sua visualizacao (error traz a frase pronta) */
    denied?: ViewDeniedReason;
}

/** Degrau da qualidade automatica. A qualidade escolhida e o teto; 720p30 so existe como degrau automatico. */
export type QualityLevel = Quality | "720p30";

/** Por que a qualidade automatica desceu: processador, upload do streamer ou conexao de um espectador. */
export type QualityReason = "cpu" | "upload" | "bandwidth";

export interface AutoQualityViewer {
    level: QualityLevel;
    /** null = recebendo o teto */
    reason: QualityReason | null;
}

export interface AutoQualityState {
    /** pior nivel entre os espectadores agora (o teto, se ninguem assiste) */
    current: QualityLevel;
    /** motivo de `current` estar abaixo da qualidade escolhida; null = no teto */
    reason: QualityReason | null;
    /** frase pronta em pt-BR para a UI (ex.: "720p 60 fps — o processador não dá conta de 3 espectadores"); null = no teto */
    reasonText: string | null;
    viewers: Record<PeerId, AutoQualityViewer>;
}

export interface LocalStream {
    source: CaptureSource;
    quality: Quality;
    hasAudio: boolean;
    startedAt: number;
    viewers: PeerId[];
    /** Qualidade automatica (configuracao autoQuality). Ausente/null = desligada. */
    autoQuality?: AutoQualityState | null;
    /** Aviso sobre a captura em pt-BR (imagem preta / janela congelada). Ausente/null = captura ok. */
    captureWarning?: string | null;
    /** pedidos esperando a sua aprovacao (opcao approveViewers), mais antigo primeiro */
    pendingViewers?: PendingViewer[];
}

export interface TelinhaState {
    inRoom: boolean;
    channelId: string | null;
    peers: RemotePeer[];
    local: LocalStream | null;
    viewing: Record<PeerId, ViewerSession>;
    lastError: string | null;
    /** quem voce expulsou (ate sair da call) ou recusou (ate a transmissao acabar) */
    blocked?: BlockedViewer[];
    /** conexoes com identidade suspeita agora */
    identityAlerts?: IdentityAlert[];
}
