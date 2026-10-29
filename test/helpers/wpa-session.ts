/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ajudantes da WP-A para os testes da sessao (core/session.ts): mensagens dos peers, leitura do log do nucleo a
// partir de uma marca e espera "ate que" que funciona com timers falsos (so setImmediate, que o relogio falso nao
// substitui).

import { buildHello, type HelloMessage, type PresenceMessage, PROTOCOL_VERSION } from "@plugins/telinha/protocol";
import { getEventLog, type TelinhaEvent } from "@plugins/telinha/store";

export function hello(discordUserId: string, username: string, idToken?: string): HelloMessage {
    return buildHello(discordUserId, username, idToken);
}

export function presence(discordUserId: string, username: string, patch: Partial<PresenceMessage> = {}): PresenceMessage {
    return { v: PROTOCOL_VERSION, discordUserId, username, streaming: false, caps: { h264HwDecode: false }, ...patch };
}

/** Marca no log do nucleo: logSince(marca) devolve so o que veio depois. */
export function logMark(): TelinhaEvent | null {
    return getEventLog().at(-1) ?? null;
}

export function logSince(mark: TelinhaEvent | null): TelinhaEvent[] {
    const log = getEventLog();
    // marca que ja saiu do buffer circular (400 eventos): devolve tudo
    const i = mark ? log.indexOf(mark) : -1;
    return i < 0 ? log : log.slice(i + 1);
}

/** Mensagens do log (depois de `mark`, se dada) que casam com `re`. */
export function logged(re: RegExp, mark: TelinhaEvent | null = null): TelinhaEvent[] {
    return logSince(mark).filter(e => re.test(e.msg));
}

/** Uma volta completa do event loop (timers reais). */
export function macrotask(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

const immediate = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Espera (so com setImmediate: vale com o relogio falso ligado) ate `check()` ser verdadeiro. Para promessas que
 * dependem de trabalho fora do JS (crypto.subtle) e nao de timers.
 */
export async function untilTrue<T>(check: () => T | null | undefined | false | 0 | "", maxMs = 2000): Promise<T> {
    const deadline = process.hrtime.bigint() + BigInt(maxMs) * 1_000_000n;
    for (;;) {
        const value = check();
        if (value) return value;
        if (process.hrtime.bigint() > deadline) throw new Error(`untilTrue: ainda falso depois de ${maxMs} ms: ${check.toString().slice(0, 200)}`);
        await immediate();
    }
}

/** Deixa rodar `n` voltas de setImmediate (promessas e trabalho do crypto em andamento). */
export async function settleImmediates(n = 20): Promise<void> {
    for (let i = 0; i < n; i++) await immediate();
}
