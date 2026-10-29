/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ============================================================================
// PROTOCOLO DO SPIKE P2P DO PEERLIVE
//
// ATENCAO: estas constantes estao DUPLICADAS em tools/p2p-test/p2p-test.js
// (pagina de teste no navegador). As duas copias PRECISAM ficar em sincronia:
// app id, prefixo/derivacao da sala, relays, servidores ICE, nomes das acoes,
// formato das mensagens e versao. Se mudar algo aqui, mude la tambem.
//
// Este arquivo tambem e importado pelo native.ts (processo main do Electron),
// entao nao pode depender de nada do navegador/Discord em tempo de carga.
// ============================================================================

/** Versao do protocolo do spike; vai na presenca e no handshake. */
export const PROTOCOL_VERSION = 1;

/** appId do Trystero. Peers com appId diferente nunca se encontram. */
export const APP_ID = "peerlive-p2p-test-v1";

/** Prefixo da derivacao da sala: SHA-256("peerlive-test-v1|" + (guildId ?? "dm") + "|" + voiceChannelId). */
export const ROOM_PREFIX = "peerlive-test-v1";

/**
 * Relays Nostr publicos fixos (medidos com tools/p2p-test/measure-relays.mjs em 2026-10-28:
 * todos aceitaram E entregaram o evento efemero do Trystero em 3/3 tentativas).
 * O native.ts libera exatamente estes hosts no connect-src do CSP do Discord.
 */
export const RELAY_URLS = [
    "wss://relay.nostr.dev.br",
    "wss://cdn.satellite.earth",
    "wss://nostr.red5d.dev",
    "wss://nostrcity-club.fly.dev",
    "wss://relay.snort.social",
    "wss://nostr-pub.wellorder.net",
    "wss://nos.lol",
    "wss://relay.primal.net"
];

/** STUN gratuito. Sem TURN neste spike: se nao der P2P direto, falha (e isso e dado do teste). */
export const ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
];

/** Nomes das acoes do Trystero (maximo 32 bytes cada). */
export const ACTION_PRESENCE = "presence";
export const ACTION_WATCH = "watch";

/** Marcador da mensagem de handshake (onPeerHandshake). */
export const HELLO_TYPE = "peerlive-hello";

/** Metadado enviado junto com o stream do padrao de teste. */
export const STREAM_KIND_TEST_PATTERN = "test-pattern";

/** Mensagem de presenca: enviada ao entrar (para cada peer novo) e a cada mudanca. */
export type PresenceMessage = {
    discordUserId: string;
    username: string;
    streaming: boolean;
    version: number;
};

/** Primeira mensagem trocada no handshake, antes do peer ficar ativo. */
export type HelloMessage = {
    type: typeof HELLO_TYPE;
    discordUserId: string;
    username: string;
    version: number;
};

/** Pedido do espectador para o transmissor: comecar/parar de mandar o stream para ele. */
export type WatchMessage = {
    op: "start" | "stop";
};

/** Deriva o roomId (hex minusculo) a partir do servidor e do canal de voz. */
export async function deriveRoomId(guildId: string | null | undefined, voiceChannelId: string): Promise<string> {
    const input = `${ROOM_PREFIX}|${guildId ?? "dm"}|${voiceChannelId}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function isHelloMessage(data: unknown): data is HelloMessage {
    const d = data as HelloMessage | null;
    return !!d && typeof d === "object" && d.type === HELLO_TYPE && typeof d.discordUserId === "string";
}

export function isPresenceMessage(data: unknown): data is PresenceMessage {
    const d = data as PresenceMessage | null;
    return !!d && typeof d === "object" && typeof d.discordUserId === "string" && typeof d.streaming === "boolean";
}

export function isWatchMessage(data: unknown): data is WatchMessage {
    const d = data as WatchMessage | null;
    return !!d && typeof d === "object" && (d.op === "start" || d.op === "stop");
}
