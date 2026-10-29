/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { useEffect, useReducer } from "@webpack/common";

import type { AudioResolution, CaptureSourceInfo, PathAResult, PathBResult, PopoutResult, ResolutionChoice, StatsSample, StatsSummary, TestOptions } from "./types";

export const LOG_PREFIX = "[PeerLive Test]";
const MAX_LOG_LINES = 300;

export const RESOLUTIONS: Record<ResolutionChoice, { width: number; height: number; }> = {
    "720p": { width: 1280, height: 720 },
    "1080p": { width: 1920, height: 1080 },
    "1440p": { width: 2560, height: 1440 }
};

export type NativeApi = PluginNative<typeof import("./native")>;

export function getNative(): NativeApi {
    const native = VencordNative?.pluginHelpers?.PeerLiveTest as NativeApi | undefined;
    if (!native)
        throw new Error("Funções nativas do PeerLive Test indisponíveis. Use o Discord desktop e reinicie o Discord por completo depois do build (o native.ts roda no processo principal).");
    return native;
}

export function errorText(e: unknown): string {
    if (e instanceof Error || (e && typeof e === "object" && "name" in e && "message" in e)) {
        const err = e as Error & { constraint?: string; };
        return `${err.name}: ${err.message}${err.constraint ? ` (constraint: ${err.constraint})` : ""}`;
    }
    return String(e);
}

export type Phase = "idle" | "starting" | "running" | "stopping";

export interface TestState {
    phase: Phase;
    sources: CaptureSourceInfo[];
    sourcesVia: string | null;
    sourcesError: string | null;
    loadingSources: boolean;
    selectedSourceId: string | null;
    audioResolution: AudioResolution | null;
    /** `${sourceId}|${audioMode}` the audioResolution belongs to */
    audioResolutionKey: string | null;
    resolvingAudio: boolean;
    options: TestOptions;
    listenAudio: boolean;
    elapsedSec: number;
    lastSample: StatsSample | null;
    pathA: PathAResult | null;
    pathB: PathBResult | null;
    pathBRunning: boolean;
    popout: PopoutResult | null;
    summary: StatsSummary | null;
    resultPath: string | null;
    resultError: string | null;
    availableVideoCodecs: string[];
    logs: string[];
}

let state: TestState = {
    phase: "idle",
    sources: [],
    sourcesVia: null,
    sourcesError: null,
    loadingSources: false,
    selectedSourceId: null,
    audioResolution: null,
    audioResolutionKey: null,
    resolvingAudio: false,
    options: {
        resolution: "1080p",
        fps: 60,
        maxBitrateMbps: 10,
        audioMode: "auto",
        codec: "H264",
        durationSec: 20,
        startBitrateHint: true,
        autoPopout: true
    },
    listenAudio: false,
    elapsedSec: 0,
    lastSample: null,
    pathA: null,
    pathB: null,
    pathBRunning: false,
    popout: null,
    summary: null,
    resultPath: null,
    resultError: null,
    availableVideoCodecs: [],
    logs: []
};

const listeners = new Set<() => void>();

export function getState() {
    return state;
}

export function setState(patch: Partial<TestState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
}

export function useTestState(): TestState {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

    useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    return state;
}

// #region Logging

let runLog: string[] | null = null;
let runErrors: string[] | null = null;

/** Starts collecting every log line (and errors separately) for the JSON of the current run */
export function beginRunLog() {
    runLog = [];
    runErrors = [];
}

export function endRunLog() {
    const result = { log: runLog ?? [], errors: runErrors ?? [] };
    runLog = runErrors = null;
    return result;
}

function shortJson(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const text = JSON.stringify(value);
        return text.length > 400 ? text.slice(0, 400) + "…" : text;
    } catch {
        return String(value);
    }
}

function pushLine(level: "info" | "warn" | "error", msg: string, data: unknown[]) {
    const time = new Date().toLocaleTimeString("pt-BR", { hour12: false });
    const tag = level === "error" ? "ERRO: " : level === "warn" ? "AVISO: " : "";
    const extra = data.length ? " " + data.map(shortJson).join(" ") : "";
    const line = `${time} ${tag}${msg}${extra}`;

    runLog?.push(line);
    if (level === "error") runErrors?.push(msg + extra);

    const logs = state.logs.length >= MAX_LOG_LINES
        ? [...state.logs.slice(-(MAX_LOG_LINES - 1)), line]
        : [...state.logs, line];
    setState({ logs });
}

export function log(msg: string, ...data: unknown[]) {
    console.log(LOG_PREFIX, msg, ...data);
    pushLine("info", msg, data);
}

export function logWarn(msg: string, ...data: unknown[]) {
    console.warn(LOG_PREFIX, msg, ...data);
    pushLine("warn", msg, data);
}

export function logError(msg: string, ...data: unknown[]) {
    console.error(LOG_PREFIX, msg, ...data);
    pushLine("error", msg, data);
}

// #endregion
