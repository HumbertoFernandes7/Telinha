/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { pushEvent, type TelinhaEventLevel } from "@plugins/telinha/store";

const PREFIX = "[Telinha]";

// Nenhum IP pode ir para o console nem para o diagnostico. O nucleo nunca loga candidatos ICE,
// mas erros vindos do Trystero/WebRTC podem trazer enderecos: estes padroes os mascaram.
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\b/gi;

export function stripIps(text: string): string {
    return text.replace(IPV4_RE, "[ip]").replace(IPV6_RE, "[ip]");
}

// O que sai do PC no diagnostico compartilhado (core/diagShare.ts) passa tambem por estes: a pasta do usuario
// (C:\Users\<nome>\..., inclusive com a barra dobrada do JSON, /home/<nome>, /Users/<nome>), os ids numericos do Discord
// (17 a 20 digitos: "discord 1234..." vira "discord [id]"; canal, app...), o nome da janela/tela capturada (a linha
// "Iniciando transmissão: janela "..."" de qualquer sessao, e o nome em qualquer outra linha desta sessao: notePrivateTitle)
// e qualquer coisa com cara de token (JWT como o id_token, token de conta do Discord, "Bearer x", "access_token=x"...). O
// nucleo nunca loga tokens: isto e so a segunda barreira. O console e o log locais ficam como estao; os nomes de quem esta
// na call tambem (sao o que se precisa para depurar).
const WIN_USER_DIR_RE = /\b([a-z]:(?:\\{1,2}|\/)(?:users|documents and settings)(?:\\{1,2}|\/))[^\\/:*?"<>|\r\n]+/gi;
const UNIX_USER_DIR_RE = /(\/(?:home|Users)\/)[^/\s"'<>]+/g;
const JWT_RE = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;
const DISCORD_TOKEN_RE = /\b[\w-]{23,28}\.[\w-]{6}\.[\w-]{27,40}\b/g;
const NAMED_SECRET_RE = /\b(access_token|refresh_token|id_token|client_secret|code_verifier)(["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi;
const BEARER_RE = /\b(bearer\s+)[\w.~+/-]+=*/gi;
const DISCORD_ID_RE = /\b\d{17,20}\b/g;
/** a linha de streaming.ts → startStreaming; o nome vai ate o ultimo `" em <qualidade> com/sem áudio` (pode ter aspas) */
const CAPTURE_LINE_RE = /(Iniciando transmissão: (?:tela|janela) )".*"(?= em \S+ (?:com|sem) áudio)/g;
const PRIVATE_TITLE = "[janela]";
/** nomes mais curtos que isto nao sao mascarados soltos (mascarariam palavras comuns); na linha da captura, sempre */
const MIN_TITLE_CHARS = 4;
const MAX_TITLES = 20;
/** nomes capturados nesta sessao (os mais recentes), como foram e como ficam no log (sem IPs) */
const privateTitles: string[] = [];

/** O nome da janela/tela que vai ser capturada (streaming.ts): sai deste PC como "[janela]" (maskPrivate). */
export function notePrivateTitle(title: string) {
    for (const t of new Set([title.trim(), stripIps(title.trim())])) {
        if (t.length < MIN_TITLE_CHARS || privateTitles.includes(t)) continue;
        privateTitles.push(t);
        if (privateTitles.length > MAX_TITLES) privateTitles.shift();
    }
}

function maskTitles(text: string): string {
    let out = text.replace(CAPTURE_LINE_RE, `$1"${PRIVATE_TITLE}"`);
    // os mais longos primeiro: um nome que contem outro sai inteiro
    for (const t of [...privateTitles].sort((a, b) => b.length - a.length)) out = out.split(t).join(PRIVATE_TITLE);
    return out;
}

/** Sem IPs, pasta do usuario, ids do Discord, nome da janela capturada nem nada com cara de token: o texto que pode sair deste PC. */
export function maskPrivate(text: string): string {
    return stripIps(maskTitles(text))
        .replace(DISCORD_ID_RE, "[id]")
        .replace(WIN_USER_DIR_RE, "$1[usuário]")
        .replace(UNIX_USER_DIR_RE, "$1[usuário]")
        .replace(JWT_RE, "[token]")
        .replace(DISCORD_TOKEN_RE, "[token]")
        .replace(NAMED_SECRET_RE, "$1$2[token]")
        .replace(BEARER_RE, "$1[token]");
}

export function errorText(e: unknown): string {
    if (e instanceof Error || (e && typeof e === "object" && "message" in e)) {
        const err = e as Error;
        return stripIps(`${err.name ?? "Error"}: ${err.message}`);
    }
    return stripIps(String(e));
}

/** So a mensagem, sem o nome tecnico ("Error:", "OAuthError:"): para textos da UI (toasts, avisos). Sem IPs. */
export function errorMessage(e: unknown): string {
    if (e instanceof Error || (e && typeof e === "object" && "message" in e)) return stripIps(String((e as Error).message));
    return stripIps(String(e));
}

function emit(level: TelinhaEventLevel, msg: string) {
    const clean = stripIps(msg);
    pushEvent({ at: Date.now(), level, msg: clean });
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(PREFIX, clean);
}

export const log = {
    info: (msg: string) => emit("info", msg),
    warn: (msg: string) => emit("warn", msg),
    error: (msg: string) => emit("error", msg)
};

export const shortId = (id: string) => id.slice(0, 6);

const lastByKey = new Map<string, { at: number; suppressed: number; }>();

/**
 * Loga no maximo uma vez a cada `intervalMs` por chave (ex.: um peer recusado repetindo o pedido).
 * Na proxima linha permitida, diz quantas repeticoes foram omitidas.
 */
export function logThrottled(key: string, level: TelinhaEventLevel, msg: string, intervalMs = 10_000) {
    const now = Date.now();
    const last = lastByKey.get(key);
    if (last && now - last.at < intervalMs) {
        last.suppressed++;
        return;
    }
    if (lastByKey.size > 500) lastByKey.clear();
    lastByKey.set(key, { at: now, suppressed: 0 });
    emit(level, last?.suppressed ? `${msg} (+${last.suppressed} repetições omitidas)` : msg);
}
