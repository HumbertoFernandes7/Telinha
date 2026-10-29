/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

import { APP_ID, ICE_SERVERS, PROTOCOL_VERSION, RELAY_URLS } from "./protocol";
import type { CandidatePairInfo, InboundSample, OutboundSample } from "./stats";

// Diagnostico do spike: console com prefixo, estado ao vivo para a UI e um JSON em
// %APPDATA%\PeerLive-test\p2p-<timestamp>.json gravado pelo native.ts.
// REGRA: nada de IP no log. Mensagens de erro passam por scrubIps() antes de entrar.

export const LOG_PREFIX = "[PeerLive P2P]";

const Native = (VencordNative.pluginHelpers.PeerLiveP2PTest ?? null) as PluginNative<typeof import("./native")> | null;

export type Level = "info" | "warn" | "error";

export type LogEvent = { t: number; at: string; level: Level; type: string; msg: string; data?: unknown; };
export type RelaySample = { t: number; relay: string; state: string; };
export type Timing = { t: number; name: string; ms: number | null; peer?: string; note?: string; };
export type ConnectionRecord = { t: number; peer: string; reason: string; } & CandidatePairInfo;
export type StatsRecord = { t: number; peer: string; } & (InboundSample | OutboundSample);

type P2PLog = {
    tool: string;
    protocolVersion: number;
    appId: string;
    relays: string[];
    iceServers: string[];
    startedAt: string;
    client: Record<string, unknown>;
    events: LogEvent[];
    relayTimeline: RelaySample[];
    timings: Timing[];
    connections: ConnectionRecord[];
    stats: StatsRecord[];
};

const MAX_STATS = 7200; // ~2h de amostras de 1s por peer ja e mais que suficiente
const MAX_EVENTS = 5000;

let log: P2PLog | null = null;
let t0 = 0;
let fileName = "";
let filePath: string | null = null;
let fileError: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writing = false;
let pendingWrite = false;

const listeners = new Set<() => void>();
export function onDiagChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
function emit() {
    listeners.forEach(fn => {
        try { fn(); } catch { }
    });
}

/** ms desde o inicio do log (todas as marcas de tempo do JSON usam esta base). */
export const since = () => Math.round(performance.now() - t0);

export function scrubIps(s: string) {
    return s
        .replace(/a=candidate:[^\r\n"]*/g, "a=candidate:[removido]")
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]")
        .replace(/\b(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}\b/gi, "[ip]");
}

function scrubData(data: unknown): unknown {
    if (data == null) return data;
    try {
        return JSON.parse(scrubIps(JSON.stringify(data)));
    } catch {
        return String(data);
    }
}

export function newLog(client: Record<string, unknown>) {
    const now = new Date();
    t0 = performance.now();
    const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    fileName = `p2p-${stamp}.json`;
    filePath = null;
    fileError = null;
    log = {
        tool: "PeerLive P2P spike",
        protocolVersion: PROTOCOL_VERSION,
        appId: APP_ID,
        relays: RELAY_URLS,
        iceServers: ICE_SERVERS.map(s => String(s.urls)),
        startedAt: now.toISOString(),
        client,
        events: [],
        relayTimeline: [],
        timings: [],
        connections: [],
        stats: []
    };
    console.info(LOG_PREFIX, "novo log", fileName);
    scheduleFlush(0);
    emit();
}

/** Garante que existe um log (eventos antes do start() nao quebram). */
function cur(): P2PLog {
    if (!log) newLog({});
    return log!;
}

export function logEvent(level: Level, type: string, msg: string, data?: unknown) {
    const cleanMsg = scrubIps(msg);
    const cleanData = data === undefined ? undefined : scrubData(data);
    const ev: LogEvent = { t: since(), at: new Date().toISOString(), level, type, msg: cleanMsg };
    if (cleanData !== undefined) ev.data = cleanData;
    const { events } = cur();
    events.push(ev);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    if (cleanData !== undefined) fn(LOG_PREFIX, `[${type}]`, cleanMsg, cleanData);
    else fn(LOG_PREFIX, `[${type}]`, cleanMsg);

    scheduleFlush(level === "info" ? 3000 : 500);
    emit();
}

export function recordRelayState(relay: string, state: string) {
    cur().relayTimeline.push({ t: since(), relay, state });
    scheduleFlush(3000);
}

export function recordTiming(name: string, ms: number | null, peer?: string, note?: string) {
    const rounded = ms == null ? null : Math.round(ms);
    const timing: Timing = { t: since(), name, ms: rounded };
    if (peer) timing.peer = peer;
    if (note) timing.note = note;
    cur().timings.push(timing);
    logEvent("info", "tempo", `${name}: ${rounded == null ? "n/d" : rounded + " ms"}${note ? ` (${note})` : ""}`, peer ? { peer } : undefined);
}

export function recordConnection(peer: string, reason: string, info: CandidatePairInfo) {
    cur().connections.push({ t: since(), peer, reason, ...info });
    scheduleFlush(500);
}

export function recordStats(peer: string, sample: InboundSample | OutboundSample) {
    const { stats } = cur();
    stats.push({ t: since(), peer, ...sample });
    if (stats.length > MAX_STATS) stats.splice(0, stats.length - MAX_STATS);
    scheduleFlush(5000);
}

export function getRecentEvents(n = 60) {
    return log ? log.events.slice(-n) : [];
}

export function getTimings() {
    return log ? log.timings : [];
}

export function getLogFileInfo() {
    return { fileName, filePath, fileError, nativeAvailable: !!Native };
}

function scheduleFlush(delay: number) {
    if (flushTimer) {
        // ja tem um agendado; so antecipa se o novo for mais urgente
        if (delay >= 1000) return;
        clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushNow();
    }, delay);
}

export async function flushNow() {
    if (!Native || !log) return;
    if (writing) {
        pendingWrite = true;
        return;
    }
    writing = true;
    try {
        const path = await Native.writeLog(fileName, JSON.stringify(log, null, 1));
        if (path !== filePath) {
            filePath = path;
            console.info(LOG_PREFIX, "log em", path);
            emit();
        }
        fileError = null;
    } catch (e) {
        fileError = String(e);
        console.error(LOG_PREFIX, "falha ao gravar log", e);
        emit();
    } finally {
        writing = false;
        if (pendingWrite) {
            pendingWrite = false;
            scheduleFlush(500);
        }
    }
}

export async function openLogFolder() {
    await Native?.openLogDir();
}

export async function getCspRelays() {
    try {
        return Native ? await Native.getCspRelays() : null;
    } catch {
        return null;
    }
}

export function stopDiagnostics() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    return flushNow();
}
