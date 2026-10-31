/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import type { RemotePeer, TelinhaState } from "./types";

// Estado observavel do Telinha para a UI. O nucleo (core/) monta um snapshot imutavel novo a
// cada mudanca (core/context.ts → publish) e chama setState; a UI le com useTelinhaState().

const INITIAL_STATE: TelinhaState = Object.freeze({
    inRoom: false,
    channelId: null,
    peers: [],
    local: null,
    viewing: {},
    lastError: null,
    blocked: [],
    identityAlerts: []
});

let state: TelinhaState = INITIAL_STATE;
const listeners = new Set<() => void>();

export function getState(): TelinhaState {
    return state;
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** Hook React: re-renderiza quando o estado muda. React vem de @webpack/common so na hora da chamada. */
export function useTelinhaState(): TelinhaState {
    return React.useSyncExternalStore(subscribe, getState);
}

/** Uso interno do nucleo. */
export function setState(next: TelinhaState) {
    if (next === state) return;
    state = next;
    for (const fn of [...listeners]) {
        try {
            fn();
        } catch (e) {
            console.error("[Telinha] listener do estado falhou", e);
        }
    }
}

/** Uso interno do nucleo (stopSession). */
export function resetState() {
    setState(INITIAL_STATE);
}

// #region Diagnostico: buffer circular de eventos recentes (para um futuro botao "copiar diagnóstico")

export type TelinhaEventLevel = "info" | "warn" | "error";

export interface TelinhaEvent {
    /** Date.now() */
    at: number;
    level: TelinhaEventLevel;
    msg: string;
}

const MAX_EVENTS = 400;
const events: TelinhaEvent[] = [];
const eventListeners = new Set<(event: TelinhaEvent) => void>();

/** Uso interno do nucleo (core/log.ts). A mensagem ja chega sem enderecos IP. */
export function pushEvent(event: TelinhaEvent) {
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    for (const fn of eventListeners) {
        try {
            fn(event);
        } catch (e) {
            console.error("[Telinha] listener do log falhou", e);
        }
    }
}

/**
 * Uso interno do nucleo (diagnostico compartilhado e o registro em arquivo, core/diagShare.ts e core/diagLog.ts):
 * cada evento novo, logo depois de entrar no buffer. O listener nao pode logar (seria chamado de novo).
 */
export function subscribeEvents(fn: (event: TelinhaEvent) => void): () => void {
    eventListeners.add(fn);
    return () => void eventListeners.delete(fn);
}

/** Copia dos eventos recentes (mais antigo primeiro). */
export function getEventLog(): TelinhaEvent[] {
    return events.slice();
}

const IDENTITY_SHORT: Record<NonNullable<RemotePeer["identity"]>, string> = {
    pending: "conferindo",
    verified: "verificado",
    unverified: "não verificado",
    invalid: "identidade falsa"
};

const BLOCK_SHORT: Record<NonNullable<RemotePeer["blocked"]>, string> = {
    kicked: "expulso",
    declined: "recusado",
    tooManyAttempts: "errou a senha"
};

/** Texto pronto para colar (diagnostico): resumo do estado + eventos recentes. Nao contem IPs, tokens nem a senha. */
export function formatDiagnostics(): string {
    const s = state;
    const time = (at: number) => new Date(at).toISOString().slice(11, 23);
    const lines = [
        "Telinha — diagnóstico",
        `gerado: ${new Date().toISOString()}`,
        `agente: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`,
        `na sala: ${s.inRoom ? "sim" : "não"}; canal: ${s.channelId ?? "—"}; erro: ${s.lastError ?? "—"}`,
        `peers: ${s.peers.map(p => `${p.username}${p.admitted ? "" : " (fora do canal)"}${p.duplicateIdentity ? " (identidade duplicada)" : ""}${p.identity ? ` <${IDENTITY_SHORT[p.identity]}>` : ""}${p.blocked ? ` [${BLOCK_SHORT[p.blocked]}]` : ""}${p.streaming ? ` [transmitindo${p.stream?.access ? `, acesso ${p.stream.access}` : ""}]` : ""}`).join(", ") || "nenhum"}`,
        `transmitindo: ${s.local ? `${s.local.source.kind} ${s.local.quality}${s.local.hasAudio ? " com áudio" : ""}, quem pode assistir: ${s.local.access}, espectadores: ${s.local.viewers.length}, pedidos pendentes: ${s.local.pendingViewers?.length ?? 0}` : "não"}`,
        `alertas de identidade: ${(s.identityAlerts ?? []).map(a => `${a.self ? "diz ser você" : a.username}${a.kind && a.kind !== "duplicate" ? ` [${a.kind === "fake" ? "prova falsa" : "não verificada x verificada"}]` : ""} (${a.peerIds.length} conexões)`).join(", ") || "nenhum"}`,
        `bloqueados: ${(s.blocked ?? []).map(b => `${b.username} (${BLOCK_SHORT[b.reason]})`).join(", ") || "ninguém"}`,
        `assistindo: ${Object.values(s.viewing).map(v => `${v.peerId.slice(0, 6)}=${v.status}${v.passwordPrompt ? " (pedindo senha)" : v.checkingPassword ? " (conferindo senha)" : ""}${v.denied ? ` [${v.denied}]` : ""}${v.stats ? ` ${v.stats.width}x${v.stats.height}@${v.stats.fps} ${v.stats.kbps} kbps` : ""}`).join(", ") || "nada"}`,
        ...(s.diag ? [`diagnóstico compartilhado: enviando para ${s.diag.sendingTo.join(", ") || "ninguém"}; pedido a ${s.diag.requested.length}, recebendo de ${s.diag.receivingFrom.length}`] : []),
        "",
        "eventos:",
        ...events.map(e => `${time(e.at)} ${e.level === "error" ? "ERRO " : e.level === "warn" ? "AVISO " : ""}${e.msg}`)
    ];
    return lines.join("\n");
}

// #endregion
