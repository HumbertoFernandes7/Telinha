/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ============================================================================
// PROTOCOLO TELINHA v1
//
// ATENCAO: o "amigo virtual" no navegador (tools/telinha-peer/) implementa este
// MESMO protocolo. As duas copias PRECISAM ficar em sincronia: app id, derivacao
// da sala, relays, servidores ICE, handshake, nomes das acoes, formato das
// mensagens, metadado do stream e versao. Mudou aqui, mude la (e vice-versa).
//
// Este arquivo tambem e importado pelo native.ts (processo main do Electron):
// nada aqui pode depender do navegador/Discord em tempo de carga.
//
// Fluxo (Trystero 0.26, estrategia Nostr):
// 1. joinRoom({ appId: APP_ID, password?, relayConfig: { urls: RELAY_URLS }, rtcConfig: { iceServers: ICE_SERVERS } }, roomId)
// 2. onPeerHandshake: cada lado envia HelloMessage e le o do outro. O handshake NUNCA rejeita
//    (rejeitar faz o Trystero repetir o peer em loop, ~100x/s): peer com hello invalido/versao
//    diferente e ignorado; peer cujo discordUserId nao esta no nosso canal de voz (com
//    rejectOutsiders ligado) nao recebe presenca nem stream e seus pedidos sao ignorados.
// 3. "presence": para cada peer novo admitido ao entrar e para todos a cada mudanca.
// 4. "watch" { op: "start" }: o transmissor faz room.addStream(stream, { target: peerId,
//    metadata: { kind: STREAM_KIND_SCREEN } }) so para esse peer; { op: "stop" } →
//    room.removeStream(stream, { target: peerId }). Ao parar de transmitir: presenca com
//    streaming:false e removeStream para todos. O espectador recebe em onPeerStream.
// ============================================================================

/** Versao do protocolo; vai no handshake (`v`) e na presenca (`v`). */
export const PROTOCOL_VERSION = 1;

/** appId do Trystero (estrategia Nostr). Peers com appId diferente nunca se encontram. */
export const APP_ID = "telinha-v1";

/** Prefixo da sala: hex minusculo de SHA-256("telinha-v1|" + (guildId ?? "dm") + "|" + voiceChannelId). */
export const ROOM_PREFIX = "telinha-v1";

/**
 * Relays Nostr publicos (medidos no spike em 2026-10-28: todos aceitaram E entregaram o evento
 * efemero do Trystero em 3/3 tentativas). O native.ts libera exatamente estes hosts no connect-src.
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

/** STUN gratuito. Sem TURN na v1: se nao houver caminho P2P direto, a conexao falha. */
export const ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
];

/** Nomes das acoes do Trystero (maximo 32 bytes cada). */
export const ACTION_PRESENCE = "presence";
export const ACTION_WATCH = "watch";

/** Marcador da mensagem de handshake (onPeerHandshake). */
export const HELLO_TYPE = "telinha-hello";

/** Metadado do addStream: `{ kind: STREAM_KIND_SCREEN }`. */
export const STREAM_KIND_SCREEN = "telinha-screen";

/**
 * Sonda de `caps.h264HwDecode`: navigator.mediaCapabilities.decodingInfo(H264_PROBE).powerEfficient
 * (false em erro). A mesma configuracao com encodingInfo diz se o envio em H.264 e por hardware.
 */
export const H264_PROBE = {
    type: "webrtc",
    video: { contentType: "video/h264", width: 1920, height: 1080, bitrate: 8e6, framerate: 60 }
} as const;

/** Handshake (primeira e unica mensagem de cada lado no onPeerHandshake). */
export type HelloMessage = {
    type: typeof HELLO_TYPE;
    v: number;
    discordUserId: string;
    username: string;
};

export type PresenceStream = {
    kind: "screen" | "window";
    title: string;
    hasAudio: boolean;
    width: number;
    height: number;
    fps: number;
};

/** Presenca: enviada a cada peer novo ao entrar e a todos em qualquer mudanca. */
export type PresenceMessage = {
    v: number;
    discordUserId: string;
    username: string;
    streaming: boolean;
    stream?: PresenceStream;
    caps: { h264HwDecode: boolean; };
};

/** Pedido do espectador para o transmissor: comecar/parar de mandar o stream so para ele. */
export type WatchMessage = {
    op: "start" | "stop";
};

const SNOWFLAKE_RE = /^\d{1,25}$/;
const MAX_NAME = 64;
const MAX_TITLE = 200;

const isObject = (d: unknown): d is Record<string, unknown> => !!d && typeof d === "object" && !Array.isArray(d);
const finiteNonNeg = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Deriva o roomId (hex minusculo de 64 caracteres) a partir do servidor e do canal de voz. */
export async function deriveRoomId(guildId: string | null | undefined, voiceChannelId: string): Promise<string> {
    const input = `${ROOM_PREFIX}|${guildId ?? "dm"}|${voiceChannelId}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function isHelloMessage(data: unknown): data is HelloMessage {
    return isObject(data)
        && data.type === HELLO_TYPE
        && typeof data.v === "number"
        && typeof data.discordUserId === "string" && SNOWFLAKE_RE.test(data.discordUserId)
        && typeof data.username === "string";
}

function isPresenceStream(data: unknown): data is PresenceStream {
    return isObject(data)
        && (data.kind === "screen" || data.kind === "window")
        && typeof data.title === "string"
        && typeof data.hasAudio === "boolean"
        && finiteNonNeg(data.width) && finiteNonNeg(data.height) && finiteNonNeg(data.fps);
}

/** Valida a presenca. Campos opcionais malformados (stream/caps) sao tolerados e normalizados por sanitizePresence. */
export function isPresenceMessage(data: unknown): data is PresenceMessage {
    return isObject(data)
        && typeof data.v === "number"
        && typeof data.discordUserId === "string" && SNOWFLAKE_RE.test(data.discordUserId)
        && typeof data.username === "string"
        && typeof data.streaming === "boolean";
}

/** Copia so os campos conhecidos, com limites de tamanho (o peer remoto nao e confiavel). */
export function sanitizePresence(data: PresenceMessage): PresenceMessage {
    const caps: Record<string, unknown> = isObject(data.caps) ? data.caps : {};
    const stream = data.streaming && isPresenceStream(data.stream)
        ? {
            kind: data.stream.kind,
            title: data.stream.title.slice(0, MAX_TITLE),
            hasAudio: data.stream.hasAudio,
            width: Math.round(data.stream.width),
            height: Math.round(data.stream.height),
            fps: Math.round(data.stream.fps)
        }
        : undefined;
    return {
        v: data.v,
        discordUserId: data.discordUserId,
        username: data.username.slice(0, MAX_NAME),
        streaming: data.streaming,
        ...(stream ? { stream } : {}),
        caps: { h264HwDecode: caps.h264HwDecode === true }
    };
}

export function isWatchMessage(data: unknown): data is WatchMessage {
    return isObject(data) && (data.op === "start" || data.op === "stop");
}

export function truncateName(name: string) {
    return name.slice(0, MAX_NAME);
}
