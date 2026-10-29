/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import type { PeerLiveState } from "./types";

// Estado observavel do PeerLive para a UI. O nucleo (core/) monta um snapshot imutavel novo a
// cada mudanca (core/context.ts → publish) e chama setState; a UI le com usePeerLiveState().

const INITIAL_STATE: PeerLiveState = Object.freeze({
    inRoom: false,
    channelId: null,
    peers: [],
    local: null,
    viewing: {},
    lastError: null
});

let state: PeerLiveState = INITIAL_STATE;
const listeners = new Set<() => void>();

export function getState(): PeerLiveState {
    return state;
}

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** Hook React: re-renderiza quando o estado muda. React vem de @webpack/common so na hora da chamada. */
export function usePeerLiveState(): PeerLiveState {
    return React.useSyncExternalStore(subscribe, getState);
}

/** Uso interno do nucleo. */
export function setState(next: PeerLiveState) {
    if (next === state) return;
    state = next;
    for (const fn of [...listeners]) {
        try {
            fn();
        } catch (e) {
            console.error("[PeerLive] listener do estado falhou", e);
        }
    }
}

/** Uso interno do nucleo (stopSession). */
export function resetState() {
    setState(INITIAL_STATE);
}

// #region Diagnostico: buffer circular de eventos recentes (para um futuro botao "copiar diagnóstico")

export type PeerLiveEventLevel = "info" | "warn" | "error";

export interface PeerLiveEvent {
    /** Date.now() */
    at: number;
    level: PeerLiveEventLevel;
    msg: string;
}

const MAX_EVENTS = 400;
const events: PeerLiveEvent[] = [];

/** Uso interno do nucleo (core/log.ts). A mensagem ja chega sem enderecos IP. */
export function pushEvent(event: PeerLiveEvent) {
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** Copia dos eventos recentes (mais antigo primeiro). */
export function getEventLog(): PeerLiveEvent[] {
    return events.slice();
}

/** Texto pronto para colar (diagnostico): resumo do estado + eventos recentes. Nao contem IPs. */
export function formatDiagnostics(): string {
    const s = state;
    const time = (at: number) => new Date(at).toISOString().slice(11, 23);
    const lines = [
        "PeerLive — diagnóstico",
        `gerado: ${new Date().toISOString()}`,
        `agente: ${typeof navigator !== "undefined" ? navigator.userAgent : "?"}`,
        `na sala: ${s.inRoom ? "sim" : "não"}; canal: ${s.channelId ?? "—"}; erro: ${s.lastError ?? "—"}`,
        `peers: ${s.peers.map(p => `${p.username}${p.admitted ? "" : " (fora do canal)"}${p.streaming ? " [transmitindo]" : ""}`).join(", ") || "nenhum"}`,
        `transmitindo: ${s.local ? `${s.local.source.kind} ${s.local.quality}${s.local.hasAudio ? " com áudio" : ""}, espectadores: ${s.local.viewers.length}` : "não"}`,
        `assistindo: ${Object.values(s.viewing).map(v => `${v.peerId.slice(0, 6)}=${v.status}${v.stats ? ` ${v.stats.width}x${v.stats.height}@${v.stats.fps} ${v.stats.kbps} kbps` : ""}`).join(", ") || "nada"}`,
        "",
        "eventos:",
        ...events.map(e => `${time(e.at)} ${e.level === "error" ? "ERRO " : e.level === "warn" ? "AVISO " : ""}${e.msg}`)
    ];
    return lines.join("\n");
}

// #endregion
