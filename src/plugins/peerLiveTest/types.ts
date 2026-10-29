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
    /**
     * CPU of every Discord process summed, in % of ONE logical core (100 = one core fully busy).
     * Computed from cumulativeCPUUsage deltas (seconds of CPU time / seconds of wall time).
     */
    totalPercentCPU: number;
    /** totalPercentCPU divided by the number of logical cores (0-100 = whole machine) */
    normalizedPercentCPU: number;
    cpuCount: number;
    /** Same unit as totalPercentCPU (% of one core), per process type */
    byType: Record<string, number>;
    processCount: number;
    workingSetMB: number;
    /** "cumulativeCPUUsage" when every process had it; otherwise percentCPUUsage × núcleos was used for some */
    method: "cumulativeCPUUsage" | "percentCPUUsage×núcleos" | "misto";
    /** Raw sum of Electron's percentCPUUsage. Electron already divides it by the core count, so this is % of the whole machine */
    electronPercentSum: number;
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
    /** How the received video is shown in the pop-out (see strategies.ts) */
    popoutStrategy: PopoutStrategy;
}

/**
 * - direct: main-window received stream set as srcObject of a <video> in the pop-out document
 * - realm: the RECEIVING RTCPeerConnection is created with the pop-out's own constructor; <video> in the pop-out
 * - canvas: hidden <video> in the main window, every new frame (rVFC) drawn into a <canvas> in the pop-out
 * - trackProcessor: MediaStreamTrackProcessor in the main window, each VideoFrame drawn into a <canvas> in the pop-out
 * - control: floating panel inside the main window (same document as the receiver); reference, not a pop-out
 */
export type PopoutStrategy = "direct" | "realm" | "canvas" | "trackProcessor" | "control";

export type ReceiverRealm = "janela principal" | "pop-out";

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

/** What happened to the frames shown by one strategy's sink (rVFC on <video> sinks, draw count on <canvas> sinks) */
export interface SinkMeasurement {
    ok: boolean;
    /** From the sink being attached to its first presented/drawn frame */
    firstFrameMs: number | null;
    measureMs: number;
    frames: number;
    fps: number | null;
    /** rVFC presentedFrames gaps: frames the compositor presented but no callback saw (<video>) or not drawn (canvas) */
    missedFrames: number | null;
    /** getVideoPlaybackQuality().droppedVideoFrames delta (only <video> sinks) */
    sinkDroppedFrames: number | null;
    width: number | null;
    height: number | null;
    /** canvas strategies: average drawImage time */
    avgDrawMs: number | null;
    errors: string[];
    error: string | null;
    /** Why the measurement stopped early (window closed, run stopped, another strategy opened) */
    aborted: string | null;
    /** Seconds since stats start (StatsSample.t) delimiting the measurement window */
    windowStartT: number | null;
    windowEndT: number | null;
}

/** getStats aggregates over the samples taken while one strategy was being measured */
export interface WindowStats {
    samples: number;
    recvAvgFps: number | null;
    recvMinFps: number | null;
    recvStalledSamples: number;
    recvFramesDropped: number;
    recvPliSent: number;
    sendAvgFps: number | null;
    sourceAvgFps: number | null;
    decoders: string[];
    encoders: string[];
    cpuAvgPercentOneCore: number | null;
    cpuMaxPercentOneCore: number | null;
    cpuAvgMachinePercent: number | null;
    cpuAvgByType: Record<string, number>;
}

export interface StrategyResult {
    strategy: PopoutStrategy;
    label: string;
    trigger: string;
    at: string;
    host: PlayerHost | null;
    hostReused: boolean;
    hostAttempts: PopoutAttempt[];
    popoutWindowComponentFound: boolean | null;
    loopbackId: number | null;
    receiverRealm: ReceiverRealm | null;
    /** A new RTCPeerConnection pair had to be created for this strategy (e.g. realm) */
    freshReceiver: boolean;
    setupMs: number | null;
    supported: boolean;
    error: string | null;
    measurement: SinkMeasurement | null;
    window: WindowStats | null;
    /** Decode startup of the receiver this strategy used (null while still waiting) */
    receiverDecode: DecodeStartup | null;
    /** framesDecoded of that receiver when the measurement ended (tells "sink failed" from "nothing decoded yet") */
    receiverFramesDecodedAtEnd: number | null;
    ok: boolean;
    verdict: string;
}

export interface StrategyRanking {
    strategy: PopoutStrategy;
    ok: boolean;
    sinkFps: number | null;
    firstFrameMs: number | null;
    cpuAvgPercentOneCore: number | null;
}

export interface TestAllResult {
    startedAt: string;
    finishedAt: string | null;
    order: PopoutStrategy[];
    completed: boolean;
    firstFrameTimeoutMs: number;
    measureMs: number;
    /** First decoded frame of the main receiver before the strategies started (the sequence waits for it) */
    initialDecode: DecodeStartup | null;
    results: StrategyResult[];
    ranking: StrategyRanking[];
    /** Best pop-out strategy (control excluded): playback OK, highest fps, then lowest CPU */
    best: PopoutStrategy | null;
}

/** How long a freshly created receiver took to output its first decoded frame */
export interface DecodeStartup {
    loopbackId: number;
    receiverRealm: ReceiverRealm;
    codec: string | null;
    decoderImplementation: string | null;
    reason: string;
    /** What was attached to the received track when it started */
    sinkAtStart: string;
    /** From ICE connected to framesDecoded > 0 */
    firstDecodedMs: number | null;
    timedOut: boolean;
    /** The loopback was replaced/closed before anything decoded */
    aborted: boolean;
    /** Counters when the first frame decoded (or when giving up) */
    pliSent: number | null;
    keyFramesEncoded: number | null;
    framesDropped: number | null;
    framesReceived: number | null;
    bytesReceived: number | null;
    error: string | null;
}

export interface CodecProbeEntry {
    codec: CodecChoice;
    startBitrateHint: boolean;
    negotiated: string | null;
    error: string | null;
    startup: DecodeStartup | null;
    window: WindowStats | null;
}

export interface CodecProbeResult {
    startedAt: string;
    finishedAt: string | null;
    completed: boolean;
    sink: string;
    steadyMs: number;
    entries: CodecProbeEntry[];
}

export interface LoopbackInfo {
    id: number;
    reason: string;
    receiverRealm: ReceiverRealm;
    codec: CodecChoice;
    startBitrateHint: boolean;
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
    /** Decoded fps from the framesDecoded delta since the previous sample (null on the first sample of a receiver) */
    fps: number | null;
    /** inbound-rtp framesPerSecond exactly as reported (kept to compare with the delta-based fps) */
    fpsReported: number | null;
    bitrateKbps: number | null;
    decoderImplementation: string | null;
    powerEfficientDecoder: boolean | null;
    framesDecoded: number | null;
    framesDecodedDelta: number | null;
    framesReceived: number | null;
    keyFramesDecoded: number | null;
    framesDropped: number | null;
    framesDroppedDelta: number | null;
    /** PLIs this receiver sent (keyframe requests) */
    pliSent: number | null;
    pliSentDelta: number | null;
    /** Bytes arrived since the previous sample but no frame was decoded */
    decodeStalled: boolean | null;
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
    loopbackId: number | null;
    receiverRealm: ReceiverRealm | null;
    /** Strategy whose sink was attached when the sample was taken */
    strategy: PopoutStrategy | null;
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
        /** Average over every steady sample, stalls (0 fps) included */
        avgFps: number | null;
        /** Average over the samples where the receiver was actually decoding (stalled samples excluded) */
        avgFpsWhileDecoding: number | null;
        minFps: number | null;
        /** Steady samples with bytes arriving but nothing decoded */
        stalledSamples: number;
        /** t (s) of the first sample with a decoded frame on the first receiver, null if it never decoded */
        firstDecodeSec: number | null;
        avgBitrateKbps: number | null;
        avgDecodeMs: number | null;
        avgJitterBufferMs: number | null;
        resolutions: Record<string, number>;
        decoderImplementations: string[];
        powerEfficientDecoder: (boolean | null)[];
        /** Sum over all receivers of the framesDropped deltas */
        framesDroppedTotal: number;
        pliSentTotal: number;
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
        methods: string[];
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
