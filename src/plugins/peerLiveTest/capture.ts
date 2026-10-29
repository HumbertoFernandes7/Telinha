/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { measureStreamPlayback, sleep } from "./media";
import { errorText, getNative, log, logError, logWarn, RESOLUTIONS } from "./state";
import type { AudioResolution, CaptureSourceInfo, PathAResult, PathBResult, SourceListResult, TestOptions } from "./types";

const THUMB_W = 320;
const THUMB_H = 180;

function trackSettings(track: MediaStreamTrack | undefined) {
    if (!track) return null;
    try {
        return { ...track.getSettings(), readyState: track.readyState, muted: track.muted, contentHint: track.contentHint };
    } catch (e) {
        return errorText(e);
    }
}

async function listViaDiscordNative(): Promise<SourceListResult> {
    const via = "DiscordNative.desktopCapture" as const;
    const desktopCapture = typeof DiscordNative !== "undefined" ? DiscordNative?.desktopCapture : undefined;
    const getSources = desktopCapture?.getDesktopCaptureSources;
    if (typeof getSources !== "function")
        return { via, sources: [], error: "DiscordNative.desktopCapture.getDesktopCaptureSources não existe" };

    try {
        const raw: any[] = await getSources.call(desktopCapture, {
            types: ["screen", "window"],
            thumbnailSize: { width: THUMB_W, height: THUMB_H }
        });

        const sources = (raw ?? []).map((src): CaptureSourceInfo => {
            const thumb = src.url ?? src.thumbnail;
            return {
                id: String(src.id),
                name: String(src.name ?? src.id),
                kind: String(src.id).startsWith("screen:") ? "screen" : "window",
                displayId: src.display_id || undefined,
                thumbnail: typeof thumb === "string"
                    ? thumb
                    : typeof thumb?.toDataURL === "function" ? thumb.toDataURL() : undefined
            };
        });

        return { via, sources, rawKeys: raw?.[0] ? Object.keys(raw[0]) : [] };
    } catch (e) {
        return { via, sources: [], error: errorText(e) };
    }
}

/** Native desktopCapturer first; DiscordNative.desktopCapture as fallback. Logs which one answered. */
export async function listSources(): Promise<SourceListResult> {
    let nativeResult: SourceListResult | null = null;

    try {
        nativeResult = await getNative().listSources(THUMB_W, THUMB_H);
    } catch (e) {
        logWarn("listSources nativo falhou", errorText(e));
    }

    if (nativeResult?.sources.length) {
        log(`Fontes listadas via ${nativeResult.via}: ${nativeResult.sources.length}`);
        return nativeResult;
    }

    if (nativeResult?.error) logWarn(`desktopCapturer nativo falhou: ${nativeResult.error}`);

    const fallback = await listViaDiscordNative();
    if (fallback.sources.length) {
        log(`Fontes listadas via ${fallback.via}: ${fallback.sources.length} (formato bruto: ${fallback.rawKeys?.join(", ")})`);
        return fallback;
    }

    logError(`Nenhuma fonte encontrada. Nativo: ${nativeResult?.error ?? "0 fontes"}; DiscordNative: ${fallback.error ?? "0 fontes"}`);
    return nativeResult ?? fallback;
}

/**
 * Path A: tell native which source + audio device to answer with, then call getDisplayMedia,
 * which Electron routes to our session.setDisplayMediaRequestHandler.
 */
export async function captureViaDisplayMedia(source: CaptureSourceInfo, opts: TestOptions, audio: AudioResolution | null) {
    const { width, height } = RESOLUTIONS[opts.resolution];
    const wantAudio = !!audio?.device;

    const constraints: DisplayMediaStreamOptions = {
        video: {
            width: { ideal: width, max: width },
            height: { ideal: height, max: height },
            frameRate: { ideal: opts.fps, max: opts.fps }
        },
        audio: wantAudio
            ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            : false
    };

    const result: PathAResult = {
        ok: false,
        errorName: null,
        error: null,
        constraint: null,
        audioResolution: audio,
        prepare: null,
        handlerEvent: null,
        userActivationActive: navigator.userActivation?.isActive ?? null,
        constraints,
        getDisplayMediaMs: null,
        videoLabel: null,
        videoSettings: null,
        audioTrackPresent: false,
        audioLabel: null,
        audioSettings: null
    };

    const native = getNative();

    try {
        result.prepare = await native.prepareDisplayMedia(source.id, source.name, audio?.device ?? null);
        log(`Caminho A: handler ${result.prepare.handlerInstalledNow ? "instalado agora" : "já instalado"} (sessão padrão: ${result.prepare.sessionIsDefault}); áudio pedido: ${audio?.device ?? "nenhum"}`);
    } catch (e) {
        result.errorName = "prepareDisplayMedia";
        result.error = errorText(e);
        logError("Caminho A: prepareDisplayMedia falhou", result.error);
        return { result, stream: null };
    }

    log(`Caminho A: chamando getDisplayMedia (userActivation ativa: ${result.userActivationActive})`, constraints);
    const t0 = performance.now();
    let stream: MediaStream | null = null;

    try {
        stream = await navigator.mediaDevices.getDisplayMedia(constraints);
        result.getDisplayMediaMs = Math.round(performance.now() - t0);
    } catch (e: any) {
        result.getDisplayMediaMs = Math.round(performance.now() - t0);
        result.errorName = e?.name ?? null;
        result.error = errorText(e);
        result.constraint = e?.constraint ?? null;
    }

    try {
        result.handlerEvent = await native.getLastHandlerEvent();
    } catch { }
    native.cancelPendingDisplayMedia().catch(() => { });

    const handlerText = result.handlerEvent
        ? `handler chamado (vídeo pedido: ${result.handlerEvent.videoRequested}, áudio pedido: ${result.handlerEvent.audioRequested}, gesto: ${result.handlerEvent.userGesture}, respondeu áudio: ${result.handlerEvent.answered?.audio ?? "nenhum"}${result.handlerEvent.error ? `, erro: ${result.handlerEvent.error}` : ""})`
        : "handler NÃO foi chamado (o pedido foi barrado antes, provavelmente pelo permission handler do Discord, ou o handler não está instalado nesta sessão)";

    if (!stream) {
        logError(`Caminho A falhou após ${result.getDisplayMediaMs} ms: ${result.error}; ${handlerText}`);
        return { result, stream: null };
    }

    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    result.ok = !!videoTrack;
    result.videoLabel = videoTrack?.label ?? null;
    result.videoSettings = trackSettings(videoTrack);
    result.audioTrackPresent = !!audioTrack;
    result.audioLabel = audioTrack?.label ?? null;
    result.audioSettings = trackSettings(audioTrack);

    log(`Caminho A OK em ${result.getDisplayMediaMs} ms; ${handlerText}`);
    log("Caminho A: vídeo", result.videoSettings);
    if (audioTrack) log("Caminho A: áudio", result.audioSettings);
    else if (wantAudio) logWarn("Caminho A: áudio foi pedido mas o stream veio sem faixa de áudio");

    return { result, stream };
}

/** Path B: legacy chromeMediaSource getUserMedia, video only. Only checks whether it works. */
export async function testLegacyGetUserMedia(source: CaptureSourceInfo, opts: TestOptions): Promise<PathBResult> {
    const { width, height } = RESOLUTIONS[opts.resolution];
    const result: PathBResult = {
        at: new Date().toISOString(),
        sourceId: source.id,
        ok: false,
        error: null,
        getUserMediaMs: null,
        label: null,
        settings: null,
        playback: null
    };

    log(`Caminho B: getUserMedia legado (chromeMediaSource=desktop) para ${source.id}`);
    const t0 = performance.now();
    let stream: MediaStream | null = null;

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: "desktop",
                    chromeMediaSourceId: source.id,
                    maxWidth: width,
                    maxHeight: height,
                    maxFrameRate: opts.fps
                }
            }
        } as any);
        result.getUserMediaMs = Math.round(performance.now() - t0);

        const [track] = stream.getVideoTracks();
        result.label = track?.label ?? null;
        result.settings = trackSettings(track);
        result.playback = await measureStreamPlayback(stream, "caminho B (vídeo oculto)", 2000);
        result.ok = !!track && result.playback.ok;
        if (!result.playback.ok) result.error = result.playback.error;

        log(`Caminho B ${result.ok ? "OK" : "obteve stream, mas sem quadros"} em ${result.getUserMediaMs} ms`, result.settings, result.playback);
    } catch (e) {
        result.getUserMediaMs = Math.round(performance.now() - t0);
        result.error = errorText(e);
        logError(`Caminho B falhou após ${result.getUserMediaMs} ms: ${result.error}`);
    } finally {
        stream?.getTracks().forEach(t => t.stop());
    }

    return result;
}

const WEBCODECS_PROBES = [
    { name: "H.264 High L4.2", codec: "avc1.64002A" },
    { name: "H.265 Main L4.1", codec: "hev1.1.6.L123.B0" },
    { name: "AV1 Main L4.1", codec: "av01.0.09M.08" },
    { name: "VP9 P0 L4.1", codec: "vp09.00.41.08" }
] as const;

/** Extra diagnostic: does WebCodecs report a hardware/software encoder for 1080p60 per codec? */
export async function probeWebCodecs(width: number, height: number, fps: number) {
    if (typeof VideoEncoder === "undefined") return { error: "VideoEncoder indisponível" };

    const out: Record<string, Record<string, boolean | string>> = {};
    for (const { name, codec } of WEBCODECS_PROBES) {
        out[name] = {};
        for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"] as const) {
            try {
                const res = await Promise.race([
                    VideoEncoder.isConfigSupported({ codec, width, height, framerate: fps, bitrate: 10_000_000, hardwareAcceleration }),
                    sleep(3000).then(() => null)
                ]);
                out[name][hardwareAcceleration] = res ? !!res.supported : "timeout";
            } catch (e) {
                out[name][hardwareAcceleration] = errorText(e);
            }
        }
    }
    return out;
}
