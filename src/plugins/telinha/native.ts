/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Processo main do Electron. Cada export e um handler IPC (1o argumento = IpcMainInvokeEvent).
// Este modulo e carregado na inicializacao MESMO com o plugin desligado: o unico efeito de topo
// permitido e liberar os relays no CSP. Todo o resto (handler de display media etc.) e preguicoso.

import { ConnectSrc, CspPolicies } from "@main/csp";
import { desktopCapturer, type IpcMainInvokeEvent } from "electron";

import { readScreenAudioMain, screenAudioStatusMain, startScreenAudioMain, stopScreenAudioMain } from "./core/audio/screenAudioMain";
import type { ScreenAudioRead, ScreenAudioStart, ScreenAudioStatus } from "./core/audio/types";
import { getWindowProcessInfo } from "./nativeWindowPid";
import { RELAY_URLS } from "./protocol";

// O CSP do Discord bloqueia wss:// arbitrario no renderer. So passa a valer depois de FECHAR e
// abrir o Discord de novo (o CSP e aplicado no carregamento da pagina principal).
for (const url of RELAY_URLS) {
    CspPolicies[url] = ConnectSrc;
}

export interface NativeSource {
    id: string;
    name: string;
    kind: "screen" | "window";
    thumbnail?: string;
}

export interface NativeSourceList {
    sources: NativeSource[];
    error?: string;
}

/** Decisao de audio do getDisplayMedia (so janelas; o audio da tela inteira vem do telinha-audio.exe, ver abaixo). */
export interface AudioDecision {
    device: string | null;
    reason: string;
}

/** O que o handler de display media fez no ultimo pedido. */
export interface CaptureReport {
    handlerCalled: boolean;
    audioRequested: boolean;
    audio: AudioDecision | null;
    error: string | null;
}

const SOURCE_ID_RE = /^(screen|window):-?\d{1,20}:-?\d{1,10}$/;
const APP_LOOPBACK_RE = /^applicationLoopback:([1-9]\d{0,9})$/;
const PENDING_TTL_MS = 15_000;
const AUDIO_WAIT_MS = 6_000;

interface PendingRequest {
    sourceId: string;
    sourceName: string;
    /** Resolvida em paralelo com o getDisplayMedia (a busca do PID pode levar segundos). */
    audio: Promise<AudioDecision> | null;
    createdAt: number;
}

let pending: PendingRequest | null = null;
let lastReport: CaptureReport | null = null;
const sessionsWithHandler = new Set<Electron.Session>();

function errorText(e: unknown) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** O Chromium da CHECK-crash com um id `applicationLoopback:` malformado: so passam formatos exatos. */
function isValidLoopbackDevice(device: string) {
    const match = APP_LOOPBACK_RE.exec(device);
    return !!match && Number(match[1]) <= 0xFFFFFFFF;
}

async function resolveWindowAudio(sourceId: string): Promise<AudioDecision> {
    if (!sourceId.startsWith("window:"))
        return { device: null, reason: "tela inteira: o áudio vem do ajudante telinha-audio.exe, não do getDisplayMedia" };

    const info = await getWindowProcessInfo(sourceId);
    if (!info)
        return { device: null, reason: "processo da janela não encontrado; transmitindo sem áudio" };

    if (info.isUwpFrameHost && /^ApplicationFrameHost$/i.test(info.processName))
        return { device: null, reason: "app UWP cujo processo real não foi identificado; transmitindo sem áudio" };

    if (info.pid === process.pid || /discord/i.test(info.processName))
        return { device: null, reason: "janela do próprio Discord: o áudio incluiria as vozes da call; transmitindo sem áudio" };

    const device = `applicationLoopback:${info.pid}`;
    if (!isValidLoopbackDevice(device))
        return { device: null, reason: `PID inválido (${info.pid}); transmitindo sem áudio` };

    return { device, reason: `áudio só do processo ${info.processName}${info.isUwpFrameHost ? " (app UWP)" : ""}` };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            }
        );
    });
}

function installHandler(targetSession: Electron.Session) {
    targetSession.setDisplayMediaRequestHandler(async (request, callback) => {
        const report: CaptureReport = { handlerCalled: true, audioRequested: !!request.audioRequested, audio: null, error: null };
        lastReport = report;

        // callback({}) recusa o pedido mas TAMBEM lanca TypeError sincrono; nunca deixar escapar no main.
        const deny = (reason: string) => {
            report.error = reason;
            try {
                callback({});
            } catch { }
        };

        const req = pending;
        pending = null;
        if (!req) return deny("nenhum pedido preparado pelo Telinha");
        if (Date.now() - req.createdAt > PENDING_TTL_MS) return deny("pedido preparado expirou");

        const streams: Electron.Streams = { video: { id: req.sourceId, name: req.sourceName } };

        if (request.audioRequested && req.audio) {
            const decision = await withTimeout(req.audio, AUDIO_WAIT_MS, { device: null, reason: "busca do processo da janela demorou demais; transmitindo sem áudio" });
            report.audio = decision;
            // Tipado como "loopback" | "loopbackWithMute", mas o Electron repassa qualquer string ao Chromium como id do dispositivo
            if (decision.device) streams.audio = decision.device as "loopback";
        }

        try {
            callback(streams);
        } catch (e) {
            report.error = "callback() lançou: " + errorText(e);
        }
    });
    sessionsWithHandler.add(targetSession);
}

function uninstallHandlers() {
    pending = null;
    for (const s of sessionsWithHandler) {
        try {
            s.setDisplayMediaRequestHandler(null);
        } catch { }
    }
    sessionsWithHandler.clear();
}

export async function listSources(_: IpcMainInvokeEvent, thumbWidth: number, thumbHeight: number): Promise<NativeSourceList> {
    const width = Math.max(16, Math.min(640, Math.round(Number(thumbWidth) || 320)));
    const height = Math.max(9, Math.min(360, Math.round(Number(thumbHeight) || 180)));

    try {
        const raw = await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width, height },
            fetchWindowIcons: false
        });

        const sources: NativeSource[] = raw
            .filter(src => SOURCE_ID_RE.test(src.id) && src.name)
            .map(src => ({
                id: src.id,
                name: src.name,
                kind: src.id.startsWith("screen:") ? "screen" : "window",
                thumbnail: src.thumbnail && !src.thumbnail.isEmpty()
                    ? "data:image/jpeg;base64," + src.thumbnail.toJPEG(70).toString("base64")
                    : undefined
            }));

        return { sources };
    } catch (e) {
        return { sources: [], error: errorText(e) };
    }
}

/**
 * Prepara o proximo getDisplayMedia(): guarda fonte + pedido de audio e (re)instala o handler de
 * display media na sessao de quem chamou. Reinstala SEMPRE, porque outro plugin pode ter trocado o
 * handler. A busca do PID da janela comeca aqui e termina dentro do handler, para o renderer chamar
 * getDisplayMedia logo em seguida (sem gastar a ativacao do clique esperando o PowerShell).
 */
export function prepareDisplayMedia(event: IpcMainInvokeEvent, sourceId: string, sourceName: string, wantAudio: boolean) {
    if (typeof sourceId !== "string" || !SOURCE_ID_RE.test(sourceId))
        throw new Error(`Id de fonte inválido: ${String(sourceId)}`);

    const targetSession = event.sender.session;
    installHandler(targetSession);

    pending = {
        sourceId,
        sourceName: typeof sourceName === "string" && sourceName ? sourceName.slice(0, 200) : sourceId,
        audio: wantAudio === true && sourceId.startsWith("window:") ? resolveWindowAudio(sourceId) : null,
        createdAt: Date.now()
    };
    lastReport = null;
    return true;
}

/**
 * Chamado logo depois do getDisplayMedia (com sucesso ou nao): descarta o pedido e remove o handler,
 * voltando ao comportamento padrao (o Discord nao instala handler proprio). Devolve o relatorio.
 */
export function finishDisplayMedia(_: IpcMainInvokeEvent): CaptureReport | null {
    const report = lastReport;
    lastReport = null;
    uninstallHandlers();
    return report;
}

/** Limpeza ao parar o plugin. */
export function resetDisplayMedia(_: IpcMainInvokeEvent) {
    lastReport = null;
    uninstallHandlers();
    stopScreenAudioMain();
}

// #region audio da tela inteira (telinha-audio.exe; ver core/audio/)

export function screenAudioStatus(_: IpcMainInvokeEvent): Promise<ScreenAudioStatus> {
    return screenAudioStatusMain();
}

/** Excludes this process tree: Discord main + renderer (discord_voice) + Chromium audio service. */
export function startScreenAudio(_: IpcMainInvokeEvent): Promise<ScreenAudioStart> {
    return startScreenAudioMain(process.pid);
}

export function readScreenAudio(_: IpcMainInvokeEvent, id: number, maxWaitMs: number): Promise<ScreenAudioRead> {
    return readScreenAudioMain(Number(id), Number(maxWaitMs));
}

export function stopScreenAudio(_: IpcMainInvokeEvent, id?: number): void {
    stopScreenAudioMain(typeof id === "number" ? id : undefined);
}

// #endregion
