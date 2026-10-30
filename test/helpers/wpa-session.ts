/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ajudantes da WP-A para os testes da sessao (core/session.ts): mensagens dos peers e leitura do log do nucleo a
// partir de uma marca. A espera "ate que" e o eventually() de @test/fakes/clock (vale tambem com o relogio falso).

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

/** Deixa rodar `n` voltas de setImmediate (promessas e trabalho do crypto em andamento). */
export async function settleImmediates(n = 20): Promise<void> {
    for (let i = 0; i < n; i++) await immediate();
}
