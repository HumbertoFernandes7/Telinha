/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure types shared by the renderer and native.ts. Must not import anything with runtime code.

export type AudioMode = "none" | "auto" | "loopback" | "loopbackWithoutChrome";
export type CodecChoice = "H264" | "VP8" | "VP9" | "AV1" | "H265";
export type ResolutionChoice = "720p" | "1080p" | "1440p";

export interface CaptureSourceInfo {
    /** Electron source id, e.g. `screen:0:0` or `window:<HWND>:0` */
    id: string;
    name: string;
    kind: "screen" | "window";
    displayId?: string;
    /** data: URL */
    thumbnail?: string;
}

export interface SourceListResult {
    via: "electron.desktopCapturer (native.ts)" | "DiscordNative.desktopCapture";
    sources: CaptureSourceInfo[];
    error?: string;
    /** Keys seen on the raw source objects (only for DiscordNative, to document its shape) */
    rawKeys?: string[];
}

export interface WindowProcessInfoResult {
    pid: number;
    processName: string;
    isUwpFrameHost: boolean;
}

export interface AudioResolution {
    mode: AudioMode;
    /** Device id string handed to Chromium through the display media handler, or null for no audio */
    device: string | null;
    /** Human readable explanation of how the device was chosen */
    decision: string;
    windowProcess: WindowProcessInfoResult | null;
    lookupMs: number;
}

export interface PrepareResult {
    handlerInstalledNow: boolean;
    handlerInstalled: boolean;
    sessionIsDefault: boolean;
    senderUrl: string;
}

export interface HandlerEvent {
    at: number;
    securityOrigin: string;
    frameUrl: string | null;
    videoRequested: boolean;
    audioRequested: boolean;
    userGesture: boolean;
    answered: { videoId: string; videoName: string; audio: string | null; } | null;
    error?: string;
}

export interface AppMetricsSnapshot {
    at: number;
    /** Sum of percentCPUUsage of every Discord process. 100 = one logical core fully busy */
    totalPercentCPU: number;
    /** totalPercentCPU divided by the number of logical cores (0-100 = whole machine) */
    normalizedPercentCPU: number;
    cpuCount: number;
    byType: Record<string, number>;
    processCount: number;
    workingSetMB: number;
}

export interface NativeEnvironment {
    versions: Record<string, string | undefined>;
    discordVersion: string;
    appName: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    cpuCount: number;
    totalMemGB: number;
    gpuFeatureStatus: Record<string, string> | string;
    gpuDevices: unknown;
    mainPid: number;
}

export interface WriteResult {
    ok: boolean;
    path?: string;
    error?: string;
}

// #region Renderer-only result shapes (written into the JSON summary)

export interface TestOptions {
    resolution: ResolutionChoice;
    fps: 30 | 60;
    maxBitrateMbps: number;
    audioMode: AudioMode;
    codec: CodecChoice;
    /** 0 = runs until "Parar" */
    durationSec: number;
    /** Munge x-google-start/max-bitrate into the remote answer so the 20 s run is not spent ramping up */
    startBitrateHint: boolean;
    autoPopout: boolean;
}

export interface PlaybackCheck {
    ok: boolean;
    where: string;
    videoWidth: number;
    videoHeight: number;
    waitedForMetadataMs: number;
    rvfcSupported: boolean;
    framesCounted: number;
    measureMs: number;
    measuredFps: number | null;
    presentedFramesDelta: number | null;
    droppedFramesDelta: number | null;
    error: string | null;
}

export interface PathAResult {
    ok: boolean;
    errorName: string | null;
    error: string | null;
    constraint: string | null;
    audioResolution: AudioResolution | null;
    prepare: PrepareResult | null;
    handlerEvent: HandlerEvent | null;
    userActivationActive: boolean | null;
    constraints: unknown;
    getDisplayMediaMs: number | null;
    videoLabel: string | null;
    videoSettings: unknown;
    audioTrackPresent: boolean;
    audioLabel: string | null;
    audioSettings: unknown;
}

export interface PathBResult {
    at: string;
    sourceId: string;
    ok: boolean;
    error: string | null;
    getUserMediaMs: number | null;
    label: string | null;
    settings: unknown;
    playback: PlaybackCheck | null;
}

export type PlayerHost = "popout+PopoutWindow" | "popout (conteúdo cru)" | "painel flutuante no app";

export interface PopoutAttempt {
    host: PlayerHost;
    mounted: boolean;
    error: string | null;
    ms: number;
}

export interface PopoutResult {
    at: string;
    popoutWindowComponentFound: boolean;
    attempts: PopoutAttempt[];
    /** Where the player finally rendered, null when nothing rendered */
    host: PlayerHost | null;
    playback: PlaybackCheck | null;
    fullscreen: { ok: boolean; error: string | null; } | null;
    /** closePlayer() ran (run stopped / player reopened) before this finished */
    cancelled: boolean;
}

export interface LoopbackInfo {
    ok: boolean;
    error: string | null;
    connectMs: number | null;
    iceCandidates: string[];
    codecPreference: string;
    offeredVideoCodecs: string[];
    negotiatedVideoCodec: string | null;
    sdpMunging: string | null;
    senderParametersApplied: string;
    senderParameters: unknown;
    contentHint: string;
}

export interface SendSample {
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrateKbps: number | null;
    targetBitrateKbps: number | null;
    availableOutgoingKbps: number | null;
    encoderImplementation: string | null;
    powerEfficientEncoder: boolean | null;
    qualityLimitationReason: string | null;
    avgEncodeMs: number | null;
    framesEncoded: number | null;
    keyFramesEncoded: number | null;
    nackCount: number | null;
    pliCount: number | null;
    codec: string | null;
}

export interface RecvSample {
    width: number | null;
    height: number | null;
    fps: number | null;
    bitrateKbps: number | null;
    decoderImplementation: string | null;
    powerEfficientDecoder: boolean | null;
    framesDecoded: number | null;
    framesDropped: number | null;
    freezeCount: number | null;
    avgDecodeMs: number | null;
    jitterBufferMs: number | null;
    codec: string | null;
}

export interface AudioSample {
    trackPresent: boolean;
    /** WebAudio RMS (linear 0..1) of the captured track over the last second */
    captureRms: number | null;
    captureRmsDb: number | null;
    capturePeak: number | null;
    /** WebAudio RMS of the track that came out of the local RTCPeerConnection */
    receivedRms: number | null;
    receivedRmsDb: number | null;
    /** audioLevel from media-source / inbound-rtp stats (0..1) */
    statsCaptureLevel: number | null;
    statsReceivedLevel: number | null;
    sendBitrateKbps: number | null;
    codec: string | null;
}

export interface StatsSample {
    t: number;
    source: { width: number | null; height: number | null; fps: number | null; } | null;
    send: SendSample | null;
    recv: RecvSample | null;
    audio: AudioSample;
    cpu: AppMetricsSnapshot | null;
}

export interface StatsSummary {
    sampleCount: number;
    steadySampleCount: number;
    warmupSec: number;
    source: { avgFps: number | null; resolutions: Record<string, number>; };
    send: {
        avgFps: number | null;
        minFps: number | null;
        maxFps: number | null;
        avgBitrateKbps: number | null;
        maxBitrateKbps: number | null;
        avgEncodeMs: number | null;
        resolutions: Record<string, number>;
        encoderImplementations: string[];
        powerEfficientEncoder: (boolean | null)[];
        qualityLimitationReasons: Record<string, number>;
        codecs: string[];
    };
    recv: {
        avgFps: number | null;
        minFps: number | null;
        avgBitrateKbps: number | null;
        avgDecodeMs: number | null;
        avgJitterBufferMs: number | null;
        resolutions: Record<string, number>;
        decoderImplementations: string[];
        powerEfficientDecoder: (boolean | null)[];
        framesDroppedTotal: number | null;
        freezeCount: number | null;
    };
    audio: {
        trackPresent: boolean;
        captureRmsAvgDb: number | null;
        captureRmsMaxDb: number | null;
        receivedRmsAvgDb: number | null;
        receivedRmsMaxDb: number | null;
        statsCaptureLevelAvg: number | null;
        statsReceivedLevelAvg: number | null;
        secondsWithSignal: number;
        avgSendBitrateKbps: number | null;
    };
    cpu: {
        avgTotalPercent: number | null;
        maxTotalPercent: number | null;
        avgNormalizedPercent: number | null;
        maxNormalizedPercent: number | null;
        avgByType: Record<string, number>;
    };
    verdict: {
        reachedTargetResolution: boolean;
        reachedTargetFps: boolean;
        hardwareEncoder: boolean | null;
        hardwareDecoder: boolean | null;
        audioSignalDetected: boolean;
        notes: string[];
    };
}

// #endregion
