/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Renderer: audio da TELA INTEIRA sem o Discord, como um MediaStreamTrack para juntar ao stream da tela.
//
// O main roda o peerlive-audio.exe (process loopback do Windows EXCLUINDO a arvore de processos do Discord,
// entao as vozes da call nao voltam para quem esta na call) e entrega PCM float32 48 kHz estereo por long
// poll de IPC (ver screenAudioMain.ts). Aqui o PCM vira faixa por um AudioWorklet com jitter buffer e
// correcao de deriva (worklet.ts) ligado a um MediaStreamAudioDestinationNode. Se o CSP do Discord barrar o
// modulo do worklet (blob: e data:), cai para MediaStreamTrackGenerator (sem jitter buffer local: o NetEq do
// receptor absorve).
//
// Falha suave: startScreenAudioCapture() rejeita com mensagem em pt-BR e a transmissao segue sem audio; se
// o helper morrer no meio, a faixa continua (em silencio) e onEnded() avisa.
//
// Nada roda no carregamento do modulo.

import { errorText, log } from "@plugins/peerLive/core/log";
import { getNativeOrNull } from "@plugins/peerLive/core/nativeApi";

import {
    SCREEN_AUDIO_BYTES_PER_FRAME,
    SCREEN_AUDIO_CHANNELS,
    SCREEN_AUDIO_MAX_WAIT_MS,
    SCREEN_AUDIO_RATE,
    type ScreenAudioNativeApi,
    type ScreenAudioRead,
    type ScreenAudioStatus
} from "./types";
import { PCM_PLAYER_PROCESSOR, PCM_PLAYER_SOURCE } from "./worklet";

export type { ScreenAudioStatus } from "./types";

export interface ScreenAudioCapture {
    track: MediaStreamTrack;
    /** Para o helper e libera o AudioContext. Idempotente; track.stop() tambem chama isto. */
    stop(): void;
    /** "worklet" (jitter buffer local) ou "generator" (fallback MediaStreamTrackGenerator). */
    readonly output: "worklet" | "generator";
}

export interface ScreenAudioOptions {
    /** Jitter buffer inicial do worklet (padrao 80 ms; sobe sozinho ate 200 ms se houver underruns). */
    targetLatencyMs?: number;
    /** O helper parou no meio da transmissao (a faixa segue em silencio). */
    onEnded?(reason: string): void;
}

interface Output {
    kind: "worklet" | "generator";
    track: MediaStreamTrack;
    push(buf: ArrayBuffer): void;
    close(): void;
}

interface PumpState {
    id: number;
    stopped: boolean;
    /** Outra captura comecou: o main ja encerrou esta. */
    superseded: boolean;
}

const OUTDATED_NATIVE = "a parte nativa do PeerLive está desatualizada (feche o Discord por completo, inclusive da bandeja, e abra de novo)";

let active: PumpState | null = null;

function getApi(): ScreenAudioNativeApi | null {
    const native = getNativeOrNull() as unknown as Partial<ScreenAudioNativeApi> | null;
    if (!native) return null;
    const ok = typeof native.screenAudioStatus === "function"
        && typeof native.startScreenAudio === "function"
        && typeof native.readScreenAudio === "function"
        && typeof native.stopScreenAudio === "function";
    return ok ? native as ScreenAudioNativeApi : null;
}

function hasGenerator() {
    return typeof (globalThis as any).MediaStreamTrackGenerator === "function" && typeof (globalThis as any).AudioData === "function";
}

/** Disponibilidade + motivo em pt-BR (para a UI explicar por que a tela inteira vai sem audio). */
export async function getScreenAudioStatus(): Promise<ScreenAudioStatus> {
    if (!getNativeOrNull()) return { available: false, reason: "a parte nativa do PeerLive não está carregada" };
    const api = getApi();
    if (!api) return { available: false, reason: OUTDATED_NATIVE };
    if (typeof AudioWorkletNode !== "function" && !hasGenerator())
        return { available: false, reason: "este Discord não tem AudioWorklet nem MediaStreamTrackGenerator" };
    try {
        return await api.screenAudioStatus();
    } catch (e) {
        return { available: false, reason: "falha ao consultar o ajudante de áudio: " + errorText(e) };
    }
}

export async function isScreenAudioAvailable(): Promise<boolean> {
    return (await getScreenAudioStatus()).available;
}

// #region saidas (PCM -> MediaStreamTrack)

async function loadWorklet(ctx: AudioContext) {
    const blobUrl = URL.createObjectURL(new Blob([PCM_PLAYER_SOURCE], { type: "text/javascript" }));
    try {
        await ctx.audioWorklet.addModule(blobUrl);
        return;
    } catch (e) {
        log.warn("Worklet de áudio via blob: recusado (" + errorText(e) + "); tentando data:");
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
    await ctx.audioWorklet.addModule("data:text/javascript;base64," + btoa(PCM_PLAYER_SOURCE));
}

async function createWorkletOutput(targetLatencyMs: number): Promise<Output> {
    const ctx = new AudioContext({ sampleRate: SCREEN_AUDIO_RATE, latencyHint: "interactive" });
    try {
        await loadWorklet(ctx);
        const node = new AudioWorkletNode(ctx, PCM_PLAYER_PROCESSOR, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [SCREEN_AUDIO_CHANNELS],
            processorOptions: { targetMs: targetLatencyMs, maxTargetMs: Math.max(200, targetLatencyMs) }
        });
        let lastUnderruns = 0;
        node.port.onmessage = e => {
            const s = e.data;
            if (s?.type !== "stats") return;
            if (s.underruns > lastUnderruns)
                log.warn(`Áudio da tela: ${s.underruns - lastUnderruns} falha(s) de buffer; buffer agora ${s.targetMs} ms (preenchido ${s.fillMs} ms)`);
            lastUnderruns = s.underruns;
        };
        // So para a faixa: ligar em ctx.destination tocaria o audio do PC de novo nos alto-falantes.
        const dest = ctx.createMediaStreamDestination();
        node.connect(dest);
        await ctx.resume().catch(() => { });
        if (ctx.state !== "running") log.warn(`Áudio da tela: AudioContext em estado "${ctx.state}"`);

        const [track] = dest.stream.getAudioTracks();
        if (!track) throw new Error("MediaStreamAudioDestinationNode sem faixa");
        return {
            kind: "worklet",
            track,
            push(buf) {
                node.port.postMessage(buf, [buf]);
            },
            close() {
                try {
                    node.port.postMessage({ type: "stop" });
                    node.disconnect();
                } catch { }
                void ctx.close().catch(() => { });
            }
        };
    } catch (e) {
        void ctx.close().catch(() => { });
        throw e;
    }
}

function createGeneratorOutput(): Output {
    const Generator = (globalThis as any).MediaStreamTrackGenerator;
    const AudioDataCtor = (globalThis as any).AudioData;
    const generator: MediaStreamTrack & { writable: WritableStream; } = new Generator({ kind: "audio" });
    const writer = generator.writable.getWriter();
    let timestampUs = 0;
    let closed = false;
    return {
        kind: "generator",
        track: generator,
        push(buf) {
            if (closed) return;
            const data = new Float32Array(buf);
            const frames = data.length / SCREEN_AUDIO_CHANNELS;
            const audioData = new AudioDataCtor({
                format: "f32",
                sampleRate: SCREEN_AUDIO_RATE,
                numberOfFrames: frames,
                numberOfChannels: SCREEN_AUDIO_CHANNELS,
                timestamp: Math.round(timestampUs),
                data
            });
            timestampUs += frames * 1e6 / SCREEN_AUDIO_RATE;
            writer.write(audioData).catch(() => {
                try {
                    audioData.close();
                } catch { }
            });
        },
        close() {
            closed = true;
            void writer.close().catch(() => { });
        }
    };
}

async function createOutput(targetLatencyMs: number): Promise<Output> {
    if (typeof AudioWorkletNode === "function") {
        try {
            return await createWorkletOutput(targetLatencyMs);
        } catch (e) {
            if (!hasGenerator()) throw e;
            log.warn("Áudio da tela: AudioWorklet indisponível (" + errorText(e) + "); usando MediaStreamTrackGenerator");
        }
    }
    if (!hasGenerator()) throw new Error("este Discord não tem AudioWorklet nem MediaStreamTrackGenerator");
    return createGeneratorOutput();
}

// #endregion

function exactBuffer(pcm: Uint8Array): ArrayBuffer | null {
    const usable = pcm.byteLength - (pcm.byteLength % SCREEN_AUDIO_BYTES_PER_FRAME);
    if (usable <= 0) return null;
    if (pcm.byteOffset === 0 && usable === pcm.buffer.byteLength && pcm.buffer instanceof ArrayBuffer) return pcm.buffer;
    return pcm.slice(0, usable).buffer as ArrayBuffer;
}

async function pump(api: ScreenAudioNativeApi, state: PumpState, output: Output, onEnded: (reason: string) => void) {
    while (!state.stopped && !state.superseded) {
        let r: ScreenAudioRead;
        try {
            r = await api.readScreenAudio(state.id, SCREEN_AUDIO_MAX_WAIT_MS);
        } catch (e) {
            if (!state.stopped && !state.superseded) onEnded("falha ao ler o áudio do ajudante: " + errorText(e));
            return;
        }
        if (state.stopped || state.superseded) return;
        const buf = r.pcm ? exactBuffer(r.pcm) : null;
        if (buf) output.push(buf);
        if (r.ended) {
            onEnded(r.reason ?? "a captura de áudio terminou");
            return;
        }
    }
}

/**
 * Comeca a capturar o audio do PC inteiro MENOS o Discord e devolve uma faixa de audio para juntar ao stream
 * da tela (stream.addTrack). Rejeita com Error em pt-BR se nao der (a transmissao deve seguir sem audio).
 * Parar: capture.stop() ou track.stop() (o stopCapture do streaming.ts ja para todas as faixas).
 */
export async function startScreenAudioCapture(opts: ScreenAudioOptions = {}): Promise<ScreenAudioCapture> {
    if (!getNativeOrNull()) throw new Error("A parte nativa do PeerLive não está carregada.");
    const api = getApi();
    if (!api) throw new Error("Sem áudio da tela: " + OUTDATED_NATIVE + ".");

    const targetLatencyMs = Math.max(20, Math.min(500, Math.round(opts.targetLatencyMs ?? 80)));

    // helper e AudioContext em paralelo; se um falhar, desfaz o outro
    const [startResult, outputResult] = await Promise.allSettled([api.startScreenAudio(), createOutput(targetLatencyMs)]);
    const started = startResult.status === "fulfilled" ? startResult.value : null;
    const output = outputResult.status === "fulfilled" ? outputResult.value : null;

    if (!started?.ok || !output) {
        if (started?.ok) void api.stopScreenAudio(started.id).catch(() => { });
        output?.close();
        output?.track.stop();
        if (startResult.status === "rejected") throw new Error("Sem áudio da tela: " + errorText(startResult.reason));
        if (started && !started.ok) throw new Error("Sem áudio da tela: " + started.reason + ".");
        throw new Error("Sem áudio da tela: não foi possível criar a faixa de áudio (" + errorText((outputResult as PromiseRejectedResult).reason) + ").");
    }

    if (active) active.superseded = true;
    const state: PumpState = { id: started.id, stopped: false, superseded: false };
    active = state;

    const { track } = output;
    const nativeStop = track.stop.bind(track);
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        state.stopped = true;
        if (active === state) active = null;
        if (!state.superseded) void api.stopScreenAudio(state.id).catch(() => { });
        output.close();
        nativeStop();
    };
    // stopCapture() do streaming.ts faz stream.getTracks().forEach(t => t.stop()): isso tambem encerra o helper
    track.stop = stop;
    try {
        track.contentHint = "music";
    } catch { }

    const onEnded = (reason: string) => {
        if (state.stopped || state.superseded) return;
        log.warn("Áudio da tela parou: " + reason + " (a transmissão segue sem áudio)");
        try {
            opts.onEnded?.(reason);
        } catch { }
    };
    void pump(api, state, output, onEnded);

    log.info(`Áudio da tela: capturando o PC sem o Discord (${output.kind === "worklet" ? `AudioWorklet, buffer ${targetLatencyMs} ms` : "MediaStreamTrackGenerator"})`);
    return { track, stop, output: output.kind };
}
