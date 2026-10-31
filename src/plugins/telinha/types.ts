/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Contrato entre o nucleo (core/, store.ts, actions.ts) e a UI (index.tsx, ui/**).
// Mudancas aqui quebram a UI: combine antes.

import type { StreamAccess } from "./protocol";

export type PeerId = string;

/**
 * "Quem pode assistir" a uma transmissao (core/access.ts): "all" = todos da call (regra do canal de voz; com
 * "Exigir identidade verificada", quem nao esta verificado precisa de Permitir); "friends" = so amigos do Discord
 * com identidade verificada; "approval" = cada pedido espera Permitir/Recusar; "password" = com senha.
 */
export type AccessMode = StreamAccess;

/**
 * Prova de identidade do Discord desta conexao (docs/identity.md):
 * "verified" = provou ser a conta do Discord que anuncia; "unverified" = nao provou (nao autorizou o Telinha,
 * versao antiga...); "invalid" = prova falsa (nunca e aceita); "pending" = conferindo (~100 ms).
 */
export type PeerIdentityStatus = "pending" | "verified" | "unverified" | "invalid";

export interface StreamInfo {
    kind: "screen" | "window";
    title: string;
    hasAudio: boolean;
    width: number;
    height: number;
    fps: number;
    /** so em RemotePeer.stream: o modo que o transmissor anuncia (ausente = "all" ou versao antiga) */
    access?: AccessMode;
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
    /**
     * Prova de identidade do Discord. Ausente = recurso desligado (sem Client ID): a UI nao mostra selo.
     * Conexoes "invalid" nao aparecem em `peers` (so em identityAlerts, kind "fake").
     */
    identity?: PeerIdentityStatus;
    /** esta pessoa ligou "Compartilhar diagnóstico" (presenca caps.diag); ausente = desligado ou versao antiga */
    diagShare?: boolean;
}

/** Diagnostico compartilhado (core/diagShare.ts). Ausente em TelinhaState = nada acontecendo. */
export interface DiagShareState {
    /** nomes de quem esta recebendo o diagnostico deste PC agora */
    sendingTo: string[];
    /** discordUserIds com "Receber diagnóstico" ligado */
    requested: string[];
    /** discordUserIds de quem o diagnostico ja esta chegando */
    receivingFrom: string[];
}

/**
 * "kicked" = expulso (vale ate voce sair da call); "declined" = recusado (vale ate a transmissao acabar);
 * "tooManyAttempts" = errou a senha 5 vezes (vale ate a transmissao acabar)
 */
export type BlockReason = "kicked" | "declined" | "tooManyAttempts";

/** Pedido para assistir esperando a sua aprovacao (modo "Só quem eu aprovar", ou não verificado em "Todos da call"). */
export interface PendingViewer {
    peerId: PeerId;
    discordUserId: string;
    username: string;
    /** Date.now() em que o pedido e recusado sozinho */
    expiresAt: number;
    /** identidade de quem pede (ausente = recurso desligado). "unverified" com a opcao requireVerifiedIdentity = aprovacao obrigatoria */
    identity?: PeerIdentityStatus;
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
    /** as conexoes suspeitas (as que ficam bloqueadas) */
    peerIds: PeerId[];
    /** a conexao diz ser VOCE (nunca e aceita) */
    self: boolean;
    /**
     * Sem `self`: "duplicate" (padrao) = varias conexoes nao verificadas com o mesmo id, todas bloqueadas;
     * "impostor" = conexoes NAO verificadas dizem ser alguem que provou a identidade em outra conexao (so elas
     * ficam bloqueadas); "fake" = conexao com prova de identidade falsa (ignorada por completo).
     */
    kind?: "duplicate" | "impostor" | "fake";
}

/** Por que o transmissor nao manda (ou parou de mandar) a transmissao para voce. */
export type ViewDeniedReason = "kicked" | "declined" | "timeout" | "duplicate" | "friendsOnly" | "notVerified" | "tooManyAttempts";

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
    /** quem pode assistir; ausente = "all" (trocando de fonte com a transmissao no ar: mantem o atual) */
    access?: AccessMode;
    /** com access "password": a senha desta transmissao (so na memoria; esquecida quando ela acaba) */
    password?: string;
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
    /**
     * status "connecting": a transmissao e com senha e o transmissor pediu a senha (responda com
     * submitWatchPassword). wrong = a ultima senha estava errada; attemptsLeft = tentativas que ainda restam.
     */
    passwordPrompt?: { attemptsLeft: number | null; wrong: boolean; };
    /** status "connecting": a senha foi enviada e o transmissor esta conferindo */
    checkingPassword?: boolean;
}

/** Degrau da qualidade automatica. A qualidade escolhida e o teto; 720p30 so existe como degrau automatico. */
export type QualityLevel = Quality | "720p30";

/** Por que a qualidade automatica desceu: processador, placa de video (encoder por hardware), upload do streamer ou conexao de um espectador. */
export type QualityReason = "cpu" | "gpu" | "upload" | "bandwidth";

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
    /** pedidos esperando a sua aprovacao (Permitir/Recusar), mais antigo primeiro */
    pendingViewers?: PendingViewer[];
    /** quem pode assistir agora (a senha nunca vem aqui: getStreamPassword) */
    access: AccessMode;
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
    /** diagnostico compartilhado; ausente = ninguem recebendo o seu nem pedido a ninguem */
    diag?: DiagShareState;
}
