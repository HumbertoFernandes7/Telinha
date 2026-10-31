/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Registro do Telinha em arquivo, lado renderer (so com "Compartilhar diagnóstico" ligado; core/diagShare.ts liga e
// desliga): cada linha do log do Telinha vai, em lotes, para %APPDATA%\Telinha\logs\renderer.log pelo processo main
// (native.ts → core/diagLogMain.ts), para o diagnostico compartilhado levar tambem o fim da sessao ANTERIOR (o Discord
// travou e foi reaberto: o buffer da memoria se perdeu). Cada linha: "<ISO UTC> <sessao> <nivel> <texto>"; a sessao (8
// hex, uma por carregamento do Discord) separa esta sessao das anteriores. Nunca segura o renderer: um lote por vez, a
// cada DIAG_LOG_FLUSH_MS ou ao juntar DIAG_LOG_BATCH_LINES, por IPC; o que passa de DIAG_LOG_MAX_PENDING_LINES
// esperando e descartado. Uma gravacao que falha desliga o registro ate a opcao ser ligada de novo (ou a proxima
// sessao). Nada roda no carregamento do modulo.

import { DIAG_MAX_LINE_CHARS, type DiagLevel } from "@plugins/telinha/protocol";
import { getEventLog, subscribeEvents } from "@plugins/telinha/store";

import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";

export const DIAG_LOG_FLUSH_MS = 2000;
export const DIAG_LOG_BATCH_LINES = 100;
export const DIAG_LOG_MAX_PENDING_LINES = 500;
/** o fim da sessao anterior que vai no diagnostico compartilhado: no maximo estas linhas e estes caracteres */
export const DIAG_PREVIOUS_MAX_LINES = 500;
export const DIAG_PREVIOUS_MAX_CHARS = 200 * 1024;

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ([0-9a-f]{8}) (info|warn|error) (.*)$/;

/** Uma linha guardada no arquivo (de uma sessao anterior). */
export interface StoredLine {
    /** Date.now() de quando entrou no log */
    at: number;
    level: DiagLevel;
    text: string;
}

let sessionId = "";
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let writing = false;
let broken = false;
/** o buffer de eventos desta sessao ja foi para o arquivo (uma vez por carregamento) */
let seeded = false;
let off: (() => void) | null = null;

/** Esta sessao (carregamento do Discord): 8 hex aleatorios, criados no primeiro uso. */
export function diagLogSession(): string {
    sessionId ||= Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");
    return sessionId;
}

/** Os natives do registro; null sem a parte nativa ou com um native.ts sem eles. */
function api() {
    const native = getNativeOrNull();
    return typeof native?.appendDiagLog === "function" && typeof native.readDiagLog === "function" ? native : null;
}

/** Uma gravacao falhou (um lote por vez: so uma falha por vez chega aqui). */
function fail(why: string) {
    broken = true;
    pending = [];
    log.warn(`O registro do Telinha em arquivo parou nesta sessão (${why}): o diagnóstico compartilhado vai sem a sessão anterior`);
}

function flush() {
    const native = api();
    if (writing || !native || !pending.length) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = pending.splice(0, DIAG_LOG_BATCH_LINES);
    writing = true;
    native.appendDiagLog(batch.join("\n") + "\n")
        .then(ok => {
            if (ok !== true) fail("o processo principal não gravou");
        }, e => fail(errorText(e)))
        .finally(() => {
            writing = false;
            if (off && pending.length) schedule();
        });
}

function schedule() {
    timer ??= setTimeout(() => {
        timer = null;
        flush();
    }, DIAG_LOG_FLUSH_MS);
}

function add(at: number, level: DiagLevel, msg: string) {
    if (broken) return;
    pending.push(`${new Date(at).toISOString()} ${diagLogSession()} ${level} ${msg.replace(/\r?\n/g, " ⏎ ").slice(0, DIAG_MAX_LINE_CHARS)}`);
    if (pending.length > DIAG_LOG_MAX_PENDING_LINES) pending.splice(0, pending.length - DIAG_LOG_MAX_PENDING_LINES);
    if (pending.length >= DIAG_LOG_BATCH_LINES) flush();
    else schedule();
}

/** Comeca a gravar (a opcao ligou, ou a sessao comecou com ela ligada). A primeira vez, com o que o buffer ja tem. */
export function startDiagLog(): void {
    if (off || !api()) return;
    broken = false;
    off = subscribeEvents(e => add(e.at, e.level, e.msg));
    if (!seeded) {
        seeded = true;
        for (const e of getEventLog()) add(e.at, e.level, e.msg);
    }
    add(Date.now(), "info", `--- registro do Telinha em arquivo ligado (sessão ${diagLogSession()}) ---`);
}

/** Esta gravando (startDiagLog sem stopDiagLog/clearDiagLog depois). */
export function isDiagLogRunning(): boolean {
    return off !== null;
}

/** Para de gravar (o plugin parou); o que esperava vai num ultimo lote, se der. */
export function stopDiagLog(): void {
    if (!off) return;
    off();
    off = null;
    flush();
    if (timer) clearTimeout(timer);
    timer = null;
}

/**
 * A opcao foi desligada (core/diagShare.ts): para de gravar, esquece o que esperava e apaga o arquivo (renderer.log e
 * .1). Um lote a caminho chega antes no main (as operacoes la sao em fila), entao nada sobra. Parar o plugin nao apaga.
 */
export function clearDiagLog(): void {
    off?.();
    off = null;
    pending = [];
    if (timer) clearTimeout(timer);
    timer = null;
    const native = getNativeOrNull();
    if (typeof native?.clearDiagLog !== "function") return;
    const failed = (why: string) => log.warn(`Não deu para apagar o registro do Telinha em arquivo (${why})`);
    native.clearDiagLog().then(ok => {
        if (ok !== true) failed("o processo principal não apagou");
    }, e => failed(errorText(e)));
}

/**
 * O fim das sessoes anteriores guardado no arquivo, mais antigo primeiro: no maximo DIAG_PREVIOUS_MAX_LINES linhas e
 * DIAG_PREVIOUS_MAX_CHARS caracteres (as mais novas). null = nao deu para ler (sem a parte nativa, erro no main).
 */
export async function readPreviousSession(): Promise<StoredLine[] | null> {
    const native = api();
    if (!native) return null;
    let raw: unknown;
    try {
        raw = await native.readDiagLog();
    } catch {
        return null;
    }
    if (!Array.isArray(raw)) return null;
    const current = diagLogSession();
    const lines: StoredLine[] = [];
    for (const line of raw) {
        const m = typeof line === "string" ? LINE_RE.exec(line) : null;
        if (m && m[2] !== current) lines.push({ at: Date.parse(m[1]), level: m[3] as DiagLevel, text: m[4] });
    }
    const out: StoredLine[] = [];
    let chars = 0;
    for (let i = lines.length - 1; i >= 0 && out.length < DIAG_PREVIOUS_MAX_LINES; i--) {
        chars += lines[i].text.length;
        if (chars > DIAG_PREVIOUS_MAX_CHARS) break;
        out.push(lines[i]);
    }
    return out.reverse();
}
