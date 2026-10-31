/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
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
// 5. Resposta do transmissor (opcional, adicionada sem mudar PROTOCOL_VERSION), na MESMA acao
//    "watch", transmissor → espectador (WatchReplyMessage):
//      { op: "pending" }            o pedido espera a aprovacao do transmissor (opcao "aprovar
//                                   quem vai assistir"); o espectador estende o prazo de resposta
//                                   (ate ~60 s + folga) e mostra "aguardando aprovacao".
//      { op: "denied", reason }     o transmissor nao vai mandar (ou parou de mandar) o stream:
//                                   reason = "kicked" (expulso), "declined" (recusado),
//                                   "timeout" (pedido de aprovacao expirou; pode pedir de novo) ou
//                                   "duplicate" (outra conexao na sala diz ter o mesmo discordUserId).
//                                   O espectador para de esperar e mostra o motivo.
//    So e enviado a peers admitidos (quem esta fora do canal de voz continua sem resposta).
//    Compatibilidade: isWatchMessage so aceita "start"/"stop", entao versoes antigas ignoram essas
//    mensagens (o amigo virtual em tools/telinha-peer/ ja trata pending/denied); o lado novo ignora
//    "reason" desconhecido tratando como "declined".
// 6. Prova de identidade do Discord (opcional, adicionada sem mudar PROTOCOL_VERSION; docs/identity.md):
//    - o hello pode trazer `idToken`: id_token OIDC do Discord (JWT RS256, escopo openid) cujo `nonce`
//      amarra o token ao certificado DTLS persistente de quem o envia (rtcConfig.certificates);
//    - acao ACTION_IDENTITY ("identity") { idToken }: token novo/renovado durante a sala, enviado uma vez
//      a cada peer compativel (quem autoriza no meio da call nao precisa reconectar);
//    - quem recebe confere assinatura (JWKS do Discord), aud = nosso client id, sub = discordUserId
//      anunciado e nonce = hash do fingerprint DTLS que o peer usou NESTA conexao, so depois do DTLS
//      conectado. Peer sem token = "nao verificado"; prova falsa = ignorado (nunca admitido).
//    Compatibilidade: versoes sem a prova (v0.1.0, amigo virtual) ignoram o campo; mensagens da acao
//    "identity" para quem nao a registrou expiram sozinhas no Trystero (por isso sao raras: uma por
//    token novo por peer). Hellos sem `idToken` continuam validos.
// 7. "Quem pode assistir" (v0.2.0, adicionado sem mudar PROTOCOL_VERSION; regras em core/access.ts):
//    - a presenca anuncia o modo da transmissao em `stream.access`: "all" (todos da call), "friends" (so
//      amigos do Discord com identidade verificada), "approval" (cada pedido espera Permitir/Recusar) ou
//      "password" (com senha). Ausente = "all" (v0.1.0); valor desconhecido e descartado.
//    - com senha, desafio-resposta na propria acao "watch" (a senha nunca trafega):
//        espectador → { op: "start" }
//        transmissor → { op: "password", nonce, attemptsLeft?, wrong? }   nonce aleatorio (16 bytes,
//                     base64url), de uso unico, vale ~2 min; wrong = a ultima prova estava errada
//        espectador → { op: "start", proof }
//          proof = base64url(HMAC-SHA256(chave = UTF-8 da senha (NFC, sem espacos nas pontas),
//                  msg = "telinha-pw-v1|" + nonce + "|" + discordUserId do transmissor + "|" + discordUserId do espectador))
//        prova certa → o stream vem; errada → novo { op: "password", wrong: true, attemptsLeft }; nonce
//        vencido/ja usado → novo { op: "password" } (nao conta como erro); 5 erros → { op: "denied",
//        reason: "tooManyAttempts" } e a conexao e o discordUserId ficam bloqueados ate a transmissao acabar.
//    - novos motivos de "denied": "friendsOnly" (verificado, mas nao e amigo), "notVerified" (modo
//      "friends" e o espectador nao provou a identidade), "tooManyAttempts".
//    Compatibilidade: a v0.1.0 ignora `stream.access` e { op: "password" } (parseWatchReply dela so conhece
//    pending/denied): como espectadora de uma transmissao com senha, o pedido dela expira sem resposta; os
//    motivos novos viram "declined" nela.
// 8. Pedido de codec (depois da v0.2.6, adicionado sem mudar PROTOCOL_VERSION): acao ACTION_CODEC ("codec"),
//    espectador → transmissor, { codec: "vp9" } (CodecRequestMessage): o stream chegou, o video vem em H.264 e
//    nenhum quadro foi decodificado em ~10 s (core/viewing.ts → NO_FRAME_HINT_MS). No maximo um por "assistir".
//    O transmissor atende so se o codec dele estiver no automatico e o peer estiver recebendo a transmissao em
//    H.264: troca so o envio para ele (sem renegociar, como a queda do H.264 por software; core/streaming.ts →
//    onCodecRequest), sem contar como falha do encoder deste PC (pode ser o decodificador de quem pediu).
//    Compatibilidade: versoes sem o pedido (a v0.2.6 e anteriores, o amigo virtual) nao registram a acao e a
//    mensagem expira sozinha no Trystero; codec diferente de "vp9" e ignorado.
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
export const ACTION_IDENTITY = "identity";
export const ACTION_CODEC = "codec";

/** Marcador da mensagem de handshake (onPeerHandshake). */
export const HELLO_TYPE = "telinha-hello";

/** Metadado do addStream: `{ kind: STREAM_KIND_SCREEN }`. */
export const STREAM_KIND_SCREEN = "telinha-screen";

/**
 * Sonda de `caps.h264HwDecode`: navigator.mediaCapabilities.decodingInfo(H264_PROBE).powerEfficient
 * (false em erro). A mesma configuracao com encodingInfo diz se o envio em H.264 e por hardware.
 * Desde a v0.2.1 o contentType vai com o perfil: "video/H264;" + sdpFmtpLine de uma variante packetization-mode=1
 * (core/codec.ts). O "video/h264" puro abaixo o Chromium le como 42e01f, perfil que a placa de video pode nao codificar.
 * So muda a sonda local: o campo da presenca continua o mesmo booleano.
 */
export const H264_PROBE = {
    type: "webrtc",
    video: { contentType: "video/h264", width: 1920, height: 1080, bitrate: 8e6, framerate: 60 }
} as const;

/** Maior id_token aceito da rede (um do Discord tem ~1 KB); = MAX_ID_TOKEN_LENGTH em core/identity/config.ts. */
export const MAX_ID_TOKEN_CHARS = 8192;

/** Handshake (primeira e unica mensagem de cada lado no onPeerHandshake). */
export type HelloMessage = {
    type: typeof HELLO_TYPE;
    v: number;
    discordUserId: string;
    username: string;
    /** prova de identidade do Discord (passo 6); ausente em quem nao autorizou o Telinha e na v0.1.0 */
    idToken?: string;
};

/** Acao "identity": id_token novo/renovado durante a sala (passo 6). */
export type IdentityMessage = {
    idToken: string;
};

/** Quem pode assistir a uma transmissao (passo 7). */
export const STREAM_ACCESS_MODES = ["all", "friends", "approval", "password"] as const;
export type StreamAccess = typeof STREAM_ACCESS_MODES[number];

export function isStreamAccess(value: unknown): value is StreamAccess {
    return STREAM_ACCESS_MODES.some(m => m === value);
}

export type PresenceStream = {
    kind: "screen" | "window";
    title: string;
    hasAudio: boolean;
    width: number;
    height: number;
    fps: number;
    /** quem pode assistir (passo 7); ausente = "all" (v0.1.0) */
    access?: StreamAccess;
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

/**
 * Pedido do espectador para o transmissor: comecar/parar de mandar o stream so para ele. `proof` responde a um
 * { op: "password" } (passo 7).
 */
export type WatchMessage =
    | { op: "start"; proof?: string; }
    | { op: "stop"; };

/** Motivo de uma recusa do transmissor (WatchReplyMessage "denied"). */
export type WatchDeniedReason = "kicked" | "declined" | "timeout" | "duplicate" | "friendsOnly" | "notVerified" | "tooManyAttempts";

/** Resposta do transmissor para o espectador, na mesma acao "watch" (ver os passos 5 e 7 no topo). */
export type WatchReplyMessage =
    | { op: "pending"; }
    | { op: "denied"; reason: WatchDeniedReason; }
    | { op: "password"; nonce: string; attemptsLeft?: number; wrong?: boolean; };

/** Tudo o que trafega na acao "watch". */
export type WatchActionMessage = WatchMessage | WatchReplyMessage;

/** Acao "codec" (passo 8): o espectador nao decodificou nenhum quadro em H.264 e pede para receber em `codec`. */
export type CodecRequestMessage = {
    codec: "vp9";
};

const SNOWFLAKE_RE = /^\d{1,25}$/;
const MAX_NAME = 64;
const MAX_TITLE = 200;
/** nonce do desafio de senha: base64url, 16 bytes = 22 caracteres (aceita ate 64) */
export const PASSWORD_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** prova da senha: HMAC-SHA256 em base64url sem padding = 43 caracteres */
export const PASSWORD_PROOF_RE = /^[A-Za-z0-9_-]{43}$/;
/** maior numero de tentativas que um { op: "password" } pode anunciar */
const MAX_ATTEMPTS_FIELD = 99;

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

const isIdTokenField = (t: unknown): t is string => typeof t === "string" && t.length > 0 && t.length <= MAX_ID_TOKEN_CHARS;

/**
 * Hello recebido no handshake, so com os campos conhecidos (o peer remoto nao e confiavel): nome truncado e
 * `idToken` so se for texto de tamanho razoavel (senao fica de fora: "nao verificado"). null se invalido.
 * A versao (`v`) e conferida por quem chama. Nunca lanca.
 */
export function parseHello(data: unknown): HelloMessage | null {
    if (!isHelloMessage(data)) return null;
    const { idToken } = data as Record<string, unknown>;
    return {
        type: HELLO_TYPE,
        v: data.v,
        discordUserId: data.discordUserId,
        username: truncateName(data.username),
        ...(isIdTokenField(idToken) ? { idToken } : {})
    };
}

/** O nosso hello. Sem token (nao autorizou / recurso desligado) e exatamente o hello da v0.1.0. */
export function buildHello(discordUserId: string, username: string, idToken?: string | null): HelloMessage {
    return { type: HELLO_TYPE, v: PROTOCOL_VERSION, discordUserId, username, ...(idToken ? { idToken } : {}) };
}

export function isIdentityMessage(data: unknown): data is IdentityMessage {
    return isObject(data) && isIdTokenField(data.idToken);
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
            fps: Math.round(data.stream.fps),
            // modo desconhecido (versao futura) fica de fora: sem etiqueta
            ...(isStreamAccess(data.stream.access) ? { access: data.stream.access } : {})
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

/**
 * Pedido do espectador, so com os campos conhecidos (o peer remoto nao e confiavel). `proof` so passa no formato
 * exato (43 caracteres base64url); fora dele e descartado e o pedido vira um "start" simples (recebe um desafio
 * novo). null se nao for start/stop. Nunca lanca.
 */
export function parseWatchRequest(data: unknown): WatchMessage | null {
    if (!isWatchMessage(data)) return null;
    if (data.op === "stop") return { op: "stop" };
    const { proof } = data as Record<string, unknown>;
    return typeof proof === "string" && PASSWORD_PROOF_RE.test(proof) ? { op: "start", proof } : { op: "start" };
}

const DENIED_REASONS: readonly WatchDeniedReason[] = ["kicked", "declined", "timeout", "duplicate", "friendsOnly", "notVerified", "tooManyAttempts"];

/**
 * Valida a resposta do transmissor; motivo desconhecido (versao futura) vira "declined". { op: "password" } sem
 * nonce valido e ignorado (null); attemptsLeft fora de 0..99 ou nao inteiro e descartado.
 */
export function parseWatchReply(data: unknown): WatchReplyMessage | null {
    if (!isObject(data)) return null;
    if (data.op === "pending") return { op: "pending" };
    if (data.op === "password") {
        if (typeof data.nonce !== "string" || !PASSWORD_NONCE_RE.test(data.nonce)) return null;
        const left = data.attemptsLeft;
        return {
            op: "password",
            nonce: data.nonce,
            ...(Number.isInteger(left) && (left as number) >= 0 && (left as number) <= MAX_ATTEMPTS_FIELD ? { attemptsLeft: left as number } : {}),
            ...(data.wrong === true ? { wrong: true } : {})
        };
    }
    if (data.op !== "denied") return null;
    const reason = DENIED_REASONS.find(r => r === data.reason) ?? "declined";
    return { op: "denied", reason };
}

/** Pedido de codec do espectador (passo 8), so com o campo conhecido. null se nao for um objeto com codec "vp9". Nunca lanca. */
export function parseCodecRequest(data: unknown): CodecRequestMessage | null {
    return isObject(data) && data.codec === "vp9" ? { codec: "vp9" } : null;
}

export function truncateName(name: string) {
    return name.slice(0, MAX_NAME);
}
