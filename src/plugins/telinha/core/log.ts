/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
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

export function errorText(e: unknown): string {
    if (e instanceof Error || (e && typeof e === "object" && "message" in e)) {
        const err = e as Error;
        return stripIps(`${err.name ?? "Error"}: ${err.message}`);
    }
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
