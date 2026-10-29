/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Electron's main process. Every export is an IPC handler (first arg = IpcMainInvokeEvent).
// This module is loaded at startup even when the plugin is disabled, so it has NO top-level side effects:
// the display media handler is only installed on the first prepareDisplayMedia() call.

import { app, desktopCapturer, IpcMainInvokeEvent, session as electronSession, shell } from "electron";
import { mkdir, writeFile } from "fs/promises";
import { arch, cpus, release, totalmem } from "os";
import { join, normalize } from "path";

import { getWindowProcessInfo } from "./nativeWindowPid";
import type { AppMetricsSnapshot, AudioMode, AudioResolution, CaptureSourceInfo, HandlerEvent, NativeEnvironment, PrepareResult, SourceListResult, WriteResult } from "./types";

const SOURCE_ID_RE = /^(screen|window):-?\d{1,20}:-?\d{1,10}$/;
const APP_LOOPBACK_RE = /^applicationLoopback:([1-9]\d{0,9})$/;
const PENDING_TTL_MS = 15_000;
const MAX_RESULT_CHARS = 50 * 1024 * 1024;

interface PendingRequest {
    sourceId: string;
    sourceName: string;
    audioDevice: string | null;
    createdAt: number;
}

let pending: PendingRequest | null = null;
let lastHandlerEvent: HandlerEvent | null = null;
const sessionsWithHandler = new Set<Electron.Session>();

function errorText(e: unknown) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function resultsDir() {
    return join(app.getPath("appData"), "PeerLive-test");
}

/**
 * Chromium CHECK-crashes on a malformed `applicationLoopback:` id, so only exact, known shapes get through.
 */
function isValidAudioDevice(device: unknown): device is string | null {
    if (device === null) return true;
    if (typeof device !== "string") return false;
    if (device === "loopback" || device === "loopbackWithoutChrome") return true;

    const match = APP_LOOPBACK_RE.exec(device);
    return !!match && Number(match[1]) <= 0xFFFFFFFF;
}

function installHandler(targetSession: Electron.Session) {
    targetSession.setDisplayMediaRequestHandler((request, callback) => {
        const evt: HandlerEvent = {
            at: Date.now(),
            securityOrigin: request.securityOrigin,
            frameUrl: (() => {
                try {
                    return request.frame?.url ?? null;
                } catch {
                    return null;
                }
            })(),
            videoRequested: request.videoRequested,
            audioRequested: request.audioRequested,
            userGesture: request.userGesture,
            answered: null
        };
        lastHandlerEvent = evt;

        // callback({}) rejects the request but ALSO throws a TypeError synchronously
        // ("Video was requested, but no video stream was provided"); never let that escape into the main process.
        const deny = (reason: string) => {
            evt.error = reason;
            try {
                callback({});
            } catch { }
        };

        const req = pending;
        pending = null;

        if (!req) return deny("Nenhum pedido preparado pelo PeerLive Test; pedido negado");
        if (Date.now() - req.createdAt > PENDING_TTL_MS)
            return deny(`Pedido preparado expirou (${Date.now() - req.createdAt} ms); pedido negado`);

        const streams: Electron.Streams = {
            video: { id: req.sourceId, name: req.sourceName }
        };

        if (request.audioRequested && req.audioDevice) {
            // Typed as "loopback" | "loopbackWithMute", but Electron passes any string through to Chromium as the device id
            streams.audio = req.audioDevice as "loopback";
        }

        evt.answered = {
            videoId: req.sourceId,
            videoName: req.sourceName,
            audio: (streams.audio as string | undefined) ?? null
        };

        try {
            callback(streams);
        } catch (e) {
            evt.error = "callback() lançou: " + errorText(e);
        }
    });

    sessionsWithHandler.add(targetSession);
}

export async function listSources(_: IpcMainInvokeEvent, thumbWidth: number, thumbHeight: number): Promise<SourceListResult> {
    const width = Math.max(16, Math.min(640, Math.round(Number(thumbWidth) || 320)));
    const height = Math.max(9, Math.min(360, Math.round(Number(thumbHeight) || 180)));

    try {
        const raw = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width, height },
            fetchWindowIcons: false
        });

        const sources: CaptureSourceInfo[] = raw.map(src => ({
            id: src.id,
            name: src.name,
            kind: src.id.startsWith("screen:") ? "screen" : "window",
            displayId: src.display_id || undefined,
            thumbnail: src.thumbnail && !src.thumbnail.isEmpty()
                ? "data:image/jpeg;base64," + src.thumbnail.toJPEG(70).toString("base64")
                : undefined
        }));

        return { via: "electron.desktopCapturer (native.ts)", sources };
    } catch (e) {
        return { via: "electron.desktopCapturer (native.ts)", sources: [], error: errorText(e) };
    }
}

export async function resolveAudioDevice(_: IpcMainInvokeEvent, sourceId: string, mode: AudioMode): Promise<AudioResolution> {
    const started = Date.now();
    const base = { mode, windowProcess: null, lookupMs: 0 };

    switch (mode) {
        case "none":
            return { ...base, device: null, decision: "Modo Nenhum: sem áudio" };
        case "loopback":
            return { ...base, device: "loopback", decision: "Forçado: loopback (todo o áudio do sistema)" };
        case "loopbackWithoutChrome":
            return { ...base, device: "loopbackWithoutChrome", decision: "Forçado: loopbackWithoutChrome (sistema menos o serviço de áudio do Chromium)" };
        case "auto":
            break;
        default:
            return { ...base, mode: "none", device: null, decision: `Modo de áudio desconhecido (${String(mode)}); sem áudio` };
    }

    if (typeof sourceId !== "string" || !sourceId.startsWith("window:")) {
        return { ...base, device: "loopbackWithoutChrome", decision: "Automático + tela: loopbackWithoutChrome" };
    }

    const info = await getWindowProcessInfo(sourceId);
    const lookupMs = Date.now() - started;

    if (!info) {
        return { ...base, lookupMs, device: "loopbackWithoutChrome", decision: "Automático + janela, mas o PID da janela não foi encontrado: caiu para loopbackWithoutChrome" };
    }

    if (info.isUwpFrameHost && /^ApplicationFrameHost$/i.test(info.processName)) {
        return {
            ...base,
            lookupMs,
            windowProcess: info,
            device: "loopbackWithoutChrome",
            decision: "Automático + janela UWP cujo processo real não foi identificado (só ApplicationFrameHost): caiu para loopbackWithoutChrome"
        };
    }

    const device = `applicationLoopback:${info.pid}`;
    if (!isValidAudioDevice(device)) {
        return { ...base, lookupMs, windowProcess: info, device: "loopbackWithoutChrome", decision: `PID inválido (${info.pid}): caiu para loopbackWithoutChrome` };
    }

    const own = info.pid === process.pid ? " (atenção: é o processo principal do próprio Discord)" : "";
    return {
        ...base,
        lookupMs,
        windowProcess: info,
        device,
        decision: `Automático + janela: ${device} (${info.processName}${info.isUwpFrameHost ? ", app UWP" : ""})${own}`
    };
}

/**
 * Remembers which source + audio device the next getDisplayMedia() call must get,
 * installing the display media handler on the caller's session the first time.
 */
export function prepareDisplayMedia(event: IpcMainInvokeEvent, sourceId: string, sourceName: string, audioDevice: string | null): PrepareResult {
    if (typeof sourceId !== "string" || !SOURCE_ID_RE.test(sourceId))
        throw new Error(`Id de fonte inválido: ${String(sourceId)}`);
    if (!isValidAudioDevice(audioDevice))
        throw new Error(`Dispositivo de áudio inválido: ${String(audioDevice)}`);

    const targetSession = event.sender.session;
    let handlerInstalledNow = false;
    if (!sessionsWithHandler.has(targetSession)) {
        installHandler(targetSession);
        handlerInstalledNow = true;
    }

    pending = {
        sourceId,
        sourceName: typeof sourceName === "string" && sourceName ? sourceName : sourceId,
        audioDevice,
        createdAt: Date.now()
    };
    lastHandlerEvent = null;

    return {
        handlerInstalledNow,
        handlerInstalled: true,
        sessionIsDefault: targetSession === electronSession.defaultSession,
        senderUrl: event.sender.getURL()
    };
}

export function cancelPendingDisplayMedia() {
    pending = null;
}

export function getLastHandlerEvent(): HandlerEvent | null {
    return lastHandlerEvent;
}

/** Called when the plugin stops. Discord itself never installs a handler, so clearing it restores the stock behaviour. */
export function uninstallDisplayMediaHandler() {
    pending = null;
    for (const s of sessionsWithHandler) {
        try {
            s.setDisplayMediaRequestHandler(null);
        } catch { }
    }
    const count = sessionsWithHandler.size;
    sessionsWithHandler.clear();
    return count;
}

/** pid -> last cumulativeCPUUsage reading, to turn CPU seconds into a rate */
const lastCpuTime = new Map<number, { cpuSec: number; at: number; }>();

/**
 * Electron's percentCPUUsage is already divided by the number of logical cores
 * (electron_api_app.cc: `cpu_dict.Set("percentCPUUsage", usagePercent / processor_count)`), i.e. % of the whole
 * machine. Here every process is measured from cumulativeCPUUsage deltas instead, giving % of ONE core.
 */
export function getAppMetrics(): AppMetricsSnapshot {
    const metrics = app.getAppMetrics();
    const cpuCount = cpus().length || 1;
    const now = performance.now();
    const byType: Record<string, number> = {};
    const seen = new Set<number>();
    let total = 0;
    let electronSum = 0;
    let workingSetKB = 0;
    let viaCumulative = 0;
    let viaPercent = 0;

    for (const m of metrics) {
        seen.add(m.pid);
        const reported = m.cpu?.percentCPUUsage ?? 0;
        electronSum += reported;

        let pct: number;
        const cumulative = m.cpu?.cumulativeCPUUsage;
        const prev = lastCpuTime.get(m.pid);
        if (typeof cumulative === "number" && Number.isFinite(cumulative)) {
            lastCpuTime.set(m.pid, { cpuSec: cumulative, at: now });
            if (prev && now > prev.at && cumulative >= prev.cpuSec) {
                pct = (cumulative - prev.cpuSec) / ((now - prev.at) / 1000) * 100;
                viaCumulative++;
            } else {
                pct = reported * cpuCount;
                viaPercent++;
            }
        } else {
            pct = reported * cpuCount;
            viaPercent++;
        }

        total += pct;
        byType[m.type] = (byType[m.type] ?? 0) + pct;
        workingSetKB += m.memory?.workingSetSize ?? 0;
    }

    for (const pid of lastCpuTime.keys()) if (!seen.has(pid)) lastCpuTime.delete(pid);
    for (const type in byType) byType[type] = Math.round(byType[type] * 10) / 10;

    return {
        at: Date.now(),
        totalPercentCPU: Math.round(total * 10) / 10,
        normalizedPercentCPU: Math.round((total / cpuCount) * 10) / 10,
        cpuCount,
        byType,
        processCount: metrics.length,
        workingSetMB: Math.round(workingSetKB / 1024),
        method: !viaPercent ? "cumulativeCPUUsage" : !viaCumulative ? "percentCPUUsage×núcleos" : "misto",
        electronPercentSum: Math.round(electronSum * 10) / 10
    };
}

export async function getEnvironment(): Promise<NativeEnvironment> {
    let gpuFeatureStatus: NativeEnvironment["gpuFeatureStatus"];
    try {
        gpuFeatureStatus = { ...app.getGPUFeatureStatus() } as unknown as Record<string, string>;
    } catch (e) {
        gpuFeatureStatus = errorText(e);
    }

    let gpuDevices: unknown = null;
    try {
        const info: any = await Promise.race([
            app.getGPUInfo("basic"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
        ]);
        gpuDevices = info?.gpuDevice ?? null;
    } catch (e) {
        gpuDevices = errorText(e);
    }

    const cpuList = cpus();
    return {
        versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            v8: process.versions.v8
        },
        discordVersion: app.getVersion(),
        appName: app.getName(),
        platform: process.platform,
        arch: arch(),
        osRelease: release(),
        cpuModel: cpuList[0]?.model ?? "?",
        cpuCount: cpuList.length,
        totalMemGB: Math.round(totalmem() / 1024 ** 3 * 10) / 10,
        gpuFeatureStatus,
        gpuDevices,
        mainPid: process.pid
    };
}

export async function writeResults(_: IpcMainInvokeEvent, json: string): Promise<WriteResult> {
    if (typeof json !== "string" || json.length > MAX_RESULT_CHARS)
        return { ok: false, error: "Conteúdo inválido ou grande demais" };

    try {
        const dir = resultsDir();
        await mkdir(dir, { recursive: true });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const path = join(dir, `capture-${stamp}.json`);
        await writeFile(path, json, "utf-8");

        return { ok: true, path };
    } catch (e) {
        return { ok: false, error: errorText(e) };
    }
}

export function showResultInFolder(_: IpcMainInvokeEvent, filePath: string) {
    if (typeof filePath !== "string") return false;

    const target = normalize(filePath);
    const dir = normalize(resultsDir() + "/");
    if (!target.startsWith(dir) || !target.endsWith(".json")) return false;

    shell.showItemInFolder(target);
    return true;
}
