/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake WebRTC and media capture for Node: RTCPeerConnection (+ senders, receivers, transceivers, DTLS transport),
// RTCCertificate, MediaStream/MediaStreamTrack, navigator.mediaDevices (getDisplayMedia/getUserMedia) and
// navigator.mediaCapabilities. Nothing is global until a test calls installWebRtc(); restore() puts the previous
// globals back. Every fake is a plain class with public fields: set them directly, or swap one method with mock.method.
//
//   const rtc = installWebRtc();
//   after(() => rtc.restore());
//
// Stats: an RTCStatsReport is a Map of id -> stats dict. `stats` on a pc/sender/receiver is either the list of dicts
// or a function returning it (called on every getStats). videoSenderStats() builds a realistic outbound set, and
// EncoderSim produces cumulative counters that follow the (fake) clock, like a real encoder.

export interface StatsEntry {
    id: string;
    type: string;
    timestamp?: number;
    [key: string]: unknown;
}

export type StatsSource = StatsEntry[] | (() => StatsEntry[] | Promise<StatsEntry[]>);

/** RTCStatsReport is maplike (forEach/get/has/size/entries): a Map is a faithful stand-in. */
export class FakeStatsReport extends Map<string, StatsEntry> {
    constructor(entries: readonly StatsEntry[] = []) {
        super(entries.map(e => [e.id, { timestamp: performance.now(), ...e }]));
    }
}

async function reportOf(source: StatsSource): Promise<FakeStatsReport> {
    return new FakeStatsReport(typeof source === "function" ? await source() : source);
}

// Event and EventTarget taken together at load: Node's pair, or happy-dom's when @test/fakes/dom was loaded first.
// Mixing them (a Node EventTarget dispatching a happy-dom Event) throws, so the fakes only use this pair.
const BaseEventTarget = globalThis.EventTarget;
const BaseEvent = globalThis.Event;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

// #region media

export interface FakeTrackInit {
    id?: string;
    label?: string;
    settings?: MediaTrackSettings;
}

export class FakeMediaStreamTrack extends BaseEventTarget {
    readonly id: string;
    readonly kind: "audio" | "video";
    label: string;
    enabled = true;
    muted = false;
    readyState: MediaStreamTrackState = "live";
    contentHint = "";
    settings: MediaTrackSettings;
    constraints: MediaTrackConstraints = {};
    onended: ((ev: Event) => void) | null = null;
    onmute: ((ev: Event) => void) | null = null;
    onunmute: ((ev: Event) => void) | null = null;

    constructor(kind: "audio" | "video", init: FakeTrackInit = {}) {
        super();
        this.kind = kind;
        this.id = init.id ?? nextId(`${kind}-track`);
        this.label = init.label ?? `${kind} fake`;
        this.settings = { deviceId: this.id, ...(kind === "video" ? { width: 1920, height: 1080, frameRate: 60 } : { sampleRate: 48000, channelCount: 2 }), ...init.settings };
    }

    getSettings(): MediaTrackSettings {
        return { ...this.settings };
    }

    getConstraints(): MediaTrackConstraints {
        return { ...this.constraints };
    }

    getCapabilities(): MediaTrackCapabilities {
        return {};
    }

    async applyConstraints(constraints?: MediaTrackConstraints) {
        this.constraints = { ...constraints };
    }

    /** Like the real one: readyState "ended", and NO "ended" event (that only fires when the source goes away). */
    stop() {
        this.readyState = "ended";
    }

    clone(): FakeMediaStreamTrack {
        return new FakeMediaStreamTrack(this.kind, { label: this.label, settings: this.getSettings() });
    }

    /** Test helper: the source went away (window closed, capture stopped by the OS): fires "ended". */
    end() {
        if (this.readyState === "ended") return;
        this.readyState = "ended";
        const ev = new BaseEvent("ended");
        this.onended?.(ev);
        this.dispatchEvent(ev);
    }

    /** Test helper: the capture changed (e.g. the window was resized): what getSettings() returns from now on. */
    setSettings(patch: MediaTrackSettings) {
        this.settings = { ...this.settings, ...patch };
    }
}

export class FakeMediaStream extends BaseEventTarget {
    readonly id: string;
    private readonly tracks: FakeMediaStreamTrack[] = [];
    onaddtrack: ((ev: Event) => void) | null = null;
    onremovetrack: ((ev: Event) => void) | null = null;

    constructor(tracks: readonly FakeMediaStreamTrack[] | FakeMediaStream = []) {
        super();
        this.id = nextId("stream");
        for (const t of tracks instanceof FakeMediaStream ? tracks.getTracks() : tracks) this.tracks.push(t);
    }

    get active() {
        return this.tracks.some(t => t.readyState === "live");
    }

    getTracks() {
        return [...this.tracks];
    }

    getVideoTracks() {
        return this.tracks.filter(t => t.kind === "video");
    }

    getAudioTracks() {
        return this.tracks.filter(t => t.kind === "audio");
    }

    getTrackById(id: string) {
        return this.tracks.find(t => t.id === id) ?? null;
    }

    /** No event, like the real one (only tracks added by the remote side fire "addtrack"). */
    addTrack(track: FakeMediaStreamTrack) {
        if (!this.tracks.includes(track)) this.tracks.push(track);
    }

    removeTrack(track: FakeMediaStreamTrack) {
        const i = this.tracks.indexOf(track);
        if (i >= 0) this.tracks.splice(i, 1);
    }

    clone() {
        return new FakeMediaStream(this.tracks.map(t => t.clone()));
    }

    /** Test helper: the remote side removed `track` (fires "removetrack" with event.track). */
    emitRemoveTrack(track: FakeMediaStreamTrack) {
        this.removeTrack(track);
        const ev = Object.assign(new BaseEvent("removetrack"), { track });
        this.onremovetrack?.(ev);
        this.dispatchEvent(ev);
    }

    /** Test helper: the remote side added `track` (fires "addtrack" with event.track). */
    emitAddTrack(track: FakeMediaStreamTrack) {
        this.addTrack(track);
        const ev = Object.assign(new BaseEvent("addtrack"), { track });
        this.onaddtrack?.(ev);
        this.dispatchEvent(ev);
    }
}

export function videoTrack(settings: MediaTrackSettings = {}, init: Omit<FakeTrackInit, "settings"> = {}) {
    return new FakeMediaStreamTrack("video", { ...init, settings });
}

export function audioTrack(settings: MediaTrackSettings = {}, init: Omit<FakeTrackInit, "settings"> = {}) {
    return new FakeMediaStreamTrack("audio", { ...init, settings });
}

/** A stream with one video track (1920x1080@60 unless `video` says otherwise) and, optionally, one audio track. */
export function captureStream(opts: { video?: MediaTrackSettings; audio?: boolean; } = {}) {
    return new FakeMediaStream([videoTrack(opts.video), ...(opts.audio ? [audioTrack()] : [])]);
}

// #endregion

// #region codecs

const vcodec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({ mimeType, clockRate: 90000, ...(sdpFmtpLine ? { sdpFmtpLine } : {}) });

/** A trimmed Chromium video capability list: VP8, VP9, H.264 (42001f/42e01f/4d001f, both packetization modes), AV1. */
export const DEFAULT_VIDEO_CODECS: RTCRtpCodec[] = [
    vcodec("video/VP8"),
    vcodec("video/rtx"),
    vcodec("video/H264", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"),
    vcodec("video/H264", "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f"),
    vcodec("video/H264", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"),
    vcodec("video/H264", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f"),
    vcodec("video/AV1", "level-idx=5;profile=0;tier=0"),
    vcodec("video/VP9", "profile-id=0"),
    vcodec("video/red"),
    vcodec("video/ulpfec")
];

export const DEFAULT_AUDIO_CODECS: RTCRtpCodec[] = [{ mimeType: "audio/opus", clockRate: 48000, channels: 2, sdpFmtpLine: "minptime=10;useinbandfec=1" }];

/** What getCapabilities(kind) returns on both RTCRtpSender and RTCRtpReceiver (null = the API returns null). */
export const rtpCapabilities: { sender: Record<string, RTCRtpCodec[] | null>; receiver: Record<string, RTCRtpCodec[] | null>; } = {
    sender: { video: DEFAULT_VIDEO_CODECS, audio: DEFAULT_AUDIO_CODECS },
    receiver: { video: DEFAULT_VIDEO_CODECS, audio: DEFAULT_AUDIO_CODECS }
};

function capabilities(side: "sender" | "receiver", kind: string): RTCRtpCapabilities | null {
    const codecs = rtpCapabilities[side][kind];
    return codecs ? { codecs: codecs.map(c => ({ ...c })), headerExtensions: [] } : null;
}

/** Negotiated codecs as getParameters().codecs lists them (payload types assigned in order). */
export function negotiatedCodecs(codecs: readonly RTCRtpCodec[] = DEFAULT_VIDEO_CODECS): RTCRtpCodecParameters[] {
    return codecs.map((c, i) => ({ ...c, payloadType: 96 + i }) as RTCRtpCodecParameters);
}

// #endregion

// #region RTCRtpSender / RTCRtpReceiver / RTCRtpTransceiver

export class FakeDtlsTransport extends BaseEventTarget {
    state: RTCDtlsTransportState = "connected";
    /** DER certificates getRemoteCertificates() returns (Chromium extension) */
    remoteCertificates: ArrayBuffer[] = [];
    iceTransport = { state: "connected", gatheringState: "complete", component: "rtp", role: "controlling" };
    onstatechange: ((ev: Event) => void) | null = null;

    getRemoteCertificates() {
        return this.remoteCertificates;
    }
}

/** RTCRtpSendParameters (degradationPreference included: the plugin sets it) */
export type FakeSendParameters = RTCRtpSendParameters;

export class FakeRTCRtpSender {
    static getCapabilities(kind: string) {
        return capabilities("sender", kind);
    }

    track: FakeMediaStreamTrack | null;
    transport: FakeDtlsTransport | null = null;
    params: FakeSendParameters;
    /** every setParameters call that went through (copies), oldest first */
    readonly setCalls: FakeSendParameters[] = [];
    /**
     * Runs before a setParameters is accepted (throw / reject to refuse it, like Chromium does for e.g. an unsupported
     * degradationPreference). Refused calls are not stored.
     */
    setParametersImpl: ((params: FakeSendParameters) => void | Promise<void>) | null = null;
    stats: StatsSource = [];
    getStatsCalls = 0;

    constructor(track: FakeMediaStreamTrack | null = null, codecs: RTCRtpCodecParameters[] = negotiatedCodecs()) {
        this.track = track;
        this.params = { transactionId: nextId("tx"), encodings: [{ active: true }], codecs, headerExtensions: [], rtcp: { cname: "fake", reducedSize: true } };
    }

    getParameters(): FakeSendParameters {
        return structuredClone(this.params);
    }

    async setParameters(params: FakeSendParameters): Promise<void> {
        const copy = structuredClone(params);
        if (this.setParametersImpl) await this.setParametersImpl(copy);
        this.setCalls.push(copy);
        this.params = copy;
    }

    async getStats(): Promise<FakeStatsReport> {
        this.getStatsCalls++;
        return reportOf(this.stats);
    }

    async replaceTrack(track: FakeMediaStreamTrack | null) {
        this.track = track;
    }

    setStreams() { }

    /** The last accepted encodings[0] (what the encoder is configured with). */
    get encoding(): RTCRtpEncodingParameters & { codec?: RTCRtpCodec; } {
        return this.params.encodings[0] ?? {};
    }
}

export class FakeRTCRtpReceiver {
    static getCapabilities(kind: string) {
        return capabilities("receiver", kind);
    }

    track: FakeMediaStreamTrack;
    transport: FakeDtlsTransport | null = null;
    stats: StatsSource = [];
    jitterBufferTarget: number | null = null;

    constructor(track: FakeMediaStreamTrack) {
        this.track = track;
    }

    async getStats(): Promise<FakeStatsReport> {
        return reportOf(this.stats);
    }

    getParameters(): RTCRtpReceiveParameters {
        return { codecs: negotiatedCodecs(), headerExtensions: [], rtcp: {} };
    }

    getContributingSources() {
        return [];
    }

    getSynchronizationSources() {
        return [];
    }
}

export class FakeRTCRtpTransceiver {
    mid: string | null;
    direction: RTCRtpTransceiverDirection;
    currentDirection: RTCRtpTransceiverDirection | null = null;
    readonly sender: FakeRTCRtpSender;
    readonly receiver: FakeRTCRtpReceiver;
    /** last setCodecPreferences argument (null = never called) */
    codecPreferences: RTCRtpCodec[] | null = null;

    constructor(sender: FakeRTCRtpSender, receiver: FakeRTCRtpReceiver, mid: string | null, direction: RTCRtpTransceiverDirection = "sendrecv") {
        this.sender = sender;
        this.receiver = receiver;
        this.mid = mid;
        this.direction = direction;
    }

    setCodecPreferences(codecs: RTCRtpCodec[]) {
        this.codecPreferences = codecs.map(c => ({ ...c }));
    }

    stop() {
        this.currentDirection = "stopped";
    }
}

// #endregion

// #region RTCPeerConnection

export class FakeRTCCertificate {
    readonly expires: number;
    readonly fingerprint: string;

    constructor(expires = Date.now() + 30 * 24 * 60 * 60_000, fingerprint?: string) {
        this.expires = expires;
        this.fingerprint = fingerprint ?? Array.from({ length: 32 }, (_, i) => ((seq * 7 + i * 13) & 0xff).toString(16).padStart(2, "0").toUpperCase()).join(":");
        seq++;
    }

    getFingerprints(): RTCDtlsFingerprint[] {
        return [{ algorithm: "sha-256", value: this.fingerprint }];
    }
}

interface DescriptionInit {
    type?: RTCSdpType;
    sdp?: string;
}

export class FakeRTCPeerConnection extends BaseEventTarget {
    /** every connection created since installWebRtc(), oldest first (subclasses included) */
    static instances: FakeRTCPeerConnection[] = [];
    /** what generateCertificate resolves with (default: a new FakeRTCCertificate per call) */
    static generateCertificateImpl: ((keygen: unknown) => Promise<FakeRTCCertificate>) | null = null;

    static generateCertificate(keygen: unknown): Promise<FakeRTCCertificate> {
        if (FakeRTCPeerConnection.generateCertificateImpl) return FakeRTCPeerConnection.generateCertificateImpl(keygen);
        const expires = (keygen as { expires?: number; } | null)?.expires;
        return Promise.resolve(new FakeRTCCertificate(Date.now() + (typeof expires === "number" ? expires : 30 * 24 * 60 * 60_000)));
    }

    readonly config: RTCConfiguration;
    connectionState: RTCPeerConnectionState = "connected";
    iceConnectionState: RTCIceConnectionState = "connected";
    iceGatheringState: RTCIceGatheringState = "complete";
    signalingState: RTCSignalingState = "stable";
    /** backing field of localDescription, an accessor as in Chromium (a subclass can wrap it, like core/peerConnection.ts) */
    private local: DescriptionInit | null = null;
    currentLocalDescription: DescriptionInit | null = null;
    remoteDescription: DescriptionInit | null = null;
    currentRemoteDescription: DescriptionInit | null = null;
    sctp: { transport: FakeDtlsTransport; } | null = { transport: new FakeDtlsTransport() };
    readonly transceivers: FakeRTCRtpTransceiver[] = [];
    stats: StatsSource = [];
    /** addIceCandidate calls as received (the remote candidates applied), oldest first */
    readonly remoteCandidates: (RTCIceCandidateInit | null | undefined)[] = [];
    /** runs before a remote candidate is applied: throw / reject to refuse it */
    addIceCandidateImpl: ((c: RTCIceCandidateInit | null | undefined) => void | Promise<void>) | null = null;
    /** setLocalDescription/setRemoteDescription calls as received (copies), oldest first */
    readonly descriptionCalls: { method: "setLocalDescription" | "setRemoteDescription"; description: DescriptionInit | undefined; }[] = [];
    /** runs before a description is applied: throw / reject to refuse it */
    setRemoteDescriptionImpl: ((d: DescriptionInit) => void | Promise<void>) | null = null;
    setLocalDescriptionImpl: ((d: DescriptionInit | undefined) => void | Promise<void>) | null = null;
    onconnectionstatechange: ((ev: Event) => void) | null = null;
    ontrack: ((ev: Event) => void) | null = null;
    private midSeq = 0;

    constructor(config: RTCConfiguration = {}) {
        super();
        this.config = config;
        FakeRTCPeerConnection.instances.push(this);
    }

    get localDescription(): DescriptionInit | null {
        return this.local;
    }

    set localDescription(d: DescriptionInit | null) {
        this.local = d;
    }

    getConfiguration() {
        return this.config;
    }

    getTransceivers() {
        return [...this.transceivers];
    }

    getSenders() {
        return this.transceivers.map(t => t.sender);
    }

    getReceivers() {
        return this.transceivers.map(t => t.receiver);
    }

    addTransceiver(trackOrKind: FakeMediaStreamTrack | "audio" | "video", init: { direction?: RTCRtpTransceiverDirection; } = {}) {
        const track = typeof trackOrKind === "string" ? null : trackOrKind;
        const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;
        const sender = new FakeRTCRtpSender(track, kind === "video" ? negotiatedCodecs() : negotiatedCodecs(DEFAULT_AUDIO_CODECS));
        const receiver = new FakeRTCRtpReceiver(new FakeMediaStreamTrack(kind));
        sender.transport = receiver.transport = this.sctp?.transport ?? null;
        const t = new FakeRTCRtpTransceiver(sender, receiver, String(this.midSeq++), init.direction ?? "sendrecv");
        this.transceivers.push(t);
        return t;
    }

    addTrack(track: FakeMediaStreamTrack, ..._streams: FakeMediaStream[]) {
        return this.addTransceiver(track).sender;
    }

    removeTrack(sender: FakeRTCRtpSender) {
        sender.track = null;
    }

    async getStats(): Promise<FakeStatsReport> {
        return reportOf(this.stats);
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: "offer", sdp: "v=0\r\n" };
    }

    async createAnswer(): Promise<RTCSessionDescriptionInit> {
        return { type: "answer", sdp: "v=0\r\n" };
    }

    async setLocalDescription(description?: DescriptionInit): Promise<void> {
        this.descriptionCalls.push({ method: "setLocalDescription", description: description && { ...description } });
        if (this.setLocalDescriptionImpl) await this.setLocalDescriptionImpl(description);
        const d = description?.sdp ? description : { type: this.signalingState === "have-remote-offer" ? "answer" as const : "offer" as const, sdp: "v=0\r\n" };
        this.local = this.currentLocalDescription = d;
    }

    async setRemoteDescription(description: DescriptionInit): Promise<void> {
        this.descriptionCalls.push({ method: "setRemoteDescription", description: { ...description } });
        if (this.setRemoteDescriptionImpl) await this.setRemoteDescriptionImpl(description);
        this.remoteDescription = this.currentRemoteDescription = description;
    }

    async addIceCandidate(candidate?: RTCIceCandidateInit | null) {
        if (this.addIceCandidateImpl) await this.addIceCandidateImpl(candidate);
        this.remoteCandidates.push(candidate);
    }

    /** Test helper: a local ICE candidate was gathered (null = gathering complete): fires "icecandidate", as Chromium does. */
    emitIceCandidate(candidate: Partial<RTCIceCandidateInit> | null) {
        this.dispatchEvent(Object.assign(new BaseEvent("icecandidate"), { candidate }));
    }

    createDataChannel(label: string) {
        return Object.assign(new BaseEventTarget(), { label, readyState: "open", send() { }, close() { } });
    }

    close() {
        this.setConnectionState("closed");
        this.signalingState = "closed";
    }

    /** Test helper: connectionState changes (fires "connectionstatechange"). */
    setConnectionState(state: RTCPeerConnectionState) {
        this.connectionState = state;
        const ev = new BaseEvent("connectionstatechange");
        this.onconnectionstatechange?.(ev);
        this.dispatchEvent(ev);
    }

    /**
     * Test helper: a transceiver that SENDS `track` (what Trystero's addStream leaves behind), with its sender
     * ready for getParameters/setParameters/getStats.
     */
    addSendingTrack(track: FakeMediaStreamTrack, opts: { direction?: RTCRtpTransceiverDirection; codecs?: RTCRtpCodecParameters[]; } = {}) {
        const t = this.addTransceiver(track, { direction: opts.direction ?? "sendonly" });
        t.currentDirection = t.direction;
        if (opts.codecs) t.sender.params.codecs = opts.codecs;
        return t;
    }

    /** Test helper: a transceiver that RECEIVES `track` (the viewer side). */
    addReceivingTrack(track: FakeMediaStreamTrack) {
        const t = this.addTransceiver(track.kind, { direction: "recvonly" });
        t.currentDirection = "recvonly";
        t.receiver.track = track;
        return t;
    }
}

// #endregion

// #region stats builders

/** outbound-rtp fields a Chromium may not report (old versions, or no frame encoded yet): see VideoSenderStatsInit.omit */
export type OutboundRtpField = "codecId" | "mediaSourceId" | "framesEncoded" | "totalEncodeTime" | "bytesSent" | "frameWidth" | "frameHeight"
    | "framesPerSecond" | "qualityLimitationReason" | "qualityLimitationDurations" | "encoderImplementation" | "powerEfficientEncoder";

export interface VideoSenderStatsInit {
    /** outbound-rtp fields to leave out of the report (they are not there at all, not undefined), as an old Chromium would */
    omit?: readonly OutboundRtpField[];
    framesEncoded?: number;
    /** seconds */
    totalEncodeTime?: number;
    bytesSent?: number;
    frameWidth?: number;
    frameHeight?: number;
    framesPerSecond?: number;
    qualityLimitationReason?: "none" | "cpu" | "bandwidth" | "other";
    /** seconds per reason (cumulative); omit to leave the field out (old Chromium) */
    qualityLimitationDurations?: { none?: number; cpu?: number; bandwidth?: number; other?: number; } | null;
    mimeType?: string;
    encoderImplementation?: string;
    powerEfficientEncoder?: boolean;
    /** media-source: frames the capture delivered (cumulative) and its fps */
    sourceFrames?: number | null;
    sourceFps?: number | null;
    /** candidate pair (bits per second); null = not reported */
    availableOutgoingBitrate?: number | null;
    currentRoundTripTime?: number;
    localCandidateType?: string;
    remoteCandidateType?: string;
    /** more outbound-rtp counters (the stats log reads them); each one is left out unless given */
    extra?: OutboundRtpExtra;
    /** remote-inbound-rtp of the video (what the viewer reports over RTCP); left out unless given */
    remoteInbound?: RemoteInboundInit;
}

/** outbound-rtp counters only the stats log (core/statsLog.ts) reads. */
export interface OutboundRtpExtra {
    /** bits per second */
    targetBitrate?: number;
    packetsSent?: number;
    retransmittedPacketsSent?: number;
    retransmittedBytesSent?: number;
    /** seconds */
    totalPacketSendDelay?: number;
    nackCount?: number;
    pliCount?: number;
    keyFramesEncoded?: number;
    qpSum?: number;
    /** trocas de resolucao do proprio WebRTC */
    qualityLimitationResolutionChanges?: number;
}

/** remote-inbound-rtp (times in seconds, as Chromium reports them). */
export interface RemoteInboundInit {
    packetsLost?: number;
    fractionLost?: number;
    jitter?: number;
    roundTripTime?: number;
    totalRoundTripTime?: number;
    roundTripTimeMeasurements?: number;
}

/**
 * The stats of one sending video RTCRtpSender, as Chromium reports them: outbound-rtp (+ its codec), media-source,
 * transport with the selected candidate pair, and both candidates (+ remote-inbound-rtp when `remoteInbound` is given).
 */
export function videoSenderStats(init: VideoSenderStatsInit = {}): StatsEntry[] {
    const durations = init.qualityLimitationDurations === undefined
        ? { none: 0, cpu: 0, bandwidth: 0, other: 0 }
        : init.qualityLimitationDurations;
    const out: StatsEntry = {
        id: "OT01V", type: "outbound-rtp", kind: "video", mediaType: "video", ssrc: 1111, codecId: "COT01_96", mediaSourceId: "SV1",
        framesEncoded: init.framesEncoded ?? 0, totalEncodeTime: init.totalEncodeTime ?? 0, bytesSent: init.bytesSent ?? 0,
        frameWidth: init.frameWidth ?? 1920, frameHeight: init.frameHeight ?? 1080, framesPerSecond: init.framesPerSecond ?? 60,
        qualityLimitationReason: init.qualityLimitationReason ?? "none",
        ...(durations ? { qualityLimitationDurations: { none: 0, cpu: 0, bandwidth: 0, other: 0, ...durations } } : {}),
        encoderImplementation: init.encoderImplementation ?? "libvpx", powerEfficientEncoder: init.powerEfficientEncoder ?? false,
        ...init.extra
    };
    for (const field of init.omit ?? []) delete out[field];
    const entries: StatsEntry[] = [
        out,
        { id: "COT01_96", type: "codec", mimeType: init.mimeType ?? "video/VP9", payloadType: 96, clockRate: 90000 },
        {
            id: "SV1", type: "media-source", kind: "video",
            ...(init.sourceFrames != null ? { frames: init.sourceFrames } : {}),
            ...(init.sourceFps != null ? { framesPerSecond: init.sourceFps } : {})
        },
        { id: "T01", type: "transport", selectedCandidatePairId: "CP01", dtlsState: "connected" },
        {
            id: "CP01", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "IL01", remoteCandidateId: "IR01",
            currentRoundTripTime: init.currentRoundTripTime ?? 0.02,
            ...(init.availableOutgoingBitrate != null ? { availableOutgoingBitrate: init.availableOutgoingBitrate } : {})
        },
        { id: "IL01", type: "local-candidate", candidateType: init.localCandidateType ?? "host" },
        { id: "IR01", type: "remote-candidate", candidateType: init.remoteCandidateType ?? "host" }
    ];
    if (init.remoteInbound) entries.push({ id: "RI01V", type: "remote-inbound-rtp", kind: "video", localId: "OT01V", codecId: "COT01_96", ...init.remoteInbound });
    return entries;
}

export interface VideoReceiverStatsInit {
    framesDecoded?: number;
    framesReceived?: number;
    bytesReceived?: number;
    frameWidth?: number;
    frameHeight?: number;
    framesPerSecond?: number;
    mimeType?: string;
    decoderImplementation?: string;
    powerEfficientDecoder?: boolean;
    /** more inbound-rtp counters (the stats log reads them); each one is left out unless given */
    extra?: InboundRtpExtra;
}

/** inbound-rtp video counters only the stats log (core/statsLog.ts) reads (times in seconds). */
export interface InboundRtpExtra {
    framesDropped?: number;
    freezeCount?: number;
    totalFreezesDuration?: number;
    jitterBufferDelay?: number;
    jitterBufferEmittedCount?: number;
    jitterBufferTargetDelay?: number;
    totalInterFrameDelay?: number;
    totalSquaredInterFrameDelay?: number;
    packetsLost?: number;
    packetsReceived?: number;
    nackCount?: number;
    pliCount?: number;
}

/** inbound-rtp (+ codec) of one receiving video track. */
export function videoReceiverStats(init: VideoReceiverStatsInit = {}): StatsEntry[] {
    return [
        {
            id: "IT01V", type: "inbound-rtp", kind: "video", mediaType: "video", codecId: "CIT01_96",
            framesDecoded: init.framesDecoded ?? 0, framesReceived: init.framesReceived ?? init.framesDecoded ?? 0, bytesReceived: init.bytesReceived ?? 0,
            frameWidth: init.frameWidth ?? 1920, frameHeight: init.frameHeight ?? 1080, framesPerSecond: init.framesPerSecond ?? 60,
            decoderImplementation: init.decoderImplementation ?? "libvpx", powerEfficientDecoder: init.powerEfficientDecoder ?? false,
            ...init.extra
        },
        { id: "CIT01_96", type: "codec", mimeType: init.mimeType ?? "video/VP9", payloadType: 96, clockRate: 90000 }
    ];
}

export interface AudioReceiverStatsInit {
    bytesReceived?: number;
    totalSamplesReceived?: number;
    concealedSamples?: number;
}

/** inbound-rtp of one receiving audio track (Opus). */
export function audioReceiverStats(init: AudioReceiverStatsInit = {}): StatsEntry[] {
    return [{
        id: "IT01A", type: "inbound-rtp", kind: "audio", mediaType: "audio", bytesReceived: init.bytesReceived ?? 0,
        totalSamplesReceived: init.totalSamplesReceived ?? 0, concealedSamples: init.concealedSamples ?? 0
    }];
}

/** What the encoder does per second; EncoderSim integrates it over the (fake) clock. */
export interface EncoderRates {
    /** frames encoded per second */
    fps: number;
    /** frames per second the capture delivers (media-source); null = not reported */
    sourceFps: number | null;
    width: number;
    height: number;
    /** sent bitrate */
    kbps: number;
    /** fraction of wall time spent encoding (ΔtotalEncodeTime / Δt) */
    encodeBusy: number;
    /** estimated available bandwidth (candidate pair); null = not reported */
    availableKbps: number | null;
    /** what limits the encoder now (qualityLimitationReason; its duration accumulates) */
    limitation: "none" | "cpu" | "bandwidth";
    mimeType: string;
    implementation: string;
    powerEfficient: boolean;
    /** the network side (RTCP, pacer, retransmissions); null = not reported (as before) */
    link: LinkRates | null;
}

/** What the network does per second (EncoderSim reports it in outbound-rtp extras + remote-inbound-rtp). */
export interface LinkRates {
    targetKbps: number;
    rtxKbps: number;
    /** % of the media packets lost */
    lossPct: number;
    rttMs: number;
    jitterMs: number;
    naksPerSecond: number;
    plisPerSecond: number;
    keyframesPerSecond: number;
    /** average QP of the encoded frames */
    qp: number;
    /** average wait of a packet in the pacer */
    pacerMs: number;
}

/** bytes per RTP packet in the sim */
const SIM_PACKET_BYTES = 1200;

/**
 * A sending encoder whose cumulative counters follow performance.now(): every getStats integrates the current rates
 * since the previous read. Change rates with set() (counters up to "now" use the old rates).
 *
 *   const sim = new EncoderSim({ availableKbps: 500 });
 *   sim.attach(sender);   // sender.getStats() now reports the sim
 */
export class EncoderSim {
    rates: EncoderRates;
    framesEncoded = 0;
    totalEncodeTime = 0;
    bytesSent = 0;
    sourceFrames = 0;
    limited = { none: 0, cpu: 0, bandwidth: 0, other: 0 };
    /** link counters (only reported with rates.link) */
    net = { packets: 0, rtxPackets: 0, rtxBytes: 0, lost: 0, sendDelay: 0, nacks: 0, plis: 0, keyframes: 0, qpSum: 0, rttTotal: 0, rttCount: 0 };
    private lastAt: number;

    constructor(rates: Partial<EncoderRates> = {}) {
        this.rates = {
            fps: 60, sourceFps: 60, width: 1920, height: 1080, kbps: 8000, encodeBusy: 0.2, availableKbps: 20000, limitation: "none",
            mimeType: "video/VP9", implementation: "libvpx", powerEfficient: false, link: null, ...rates
        };
        this.lastAt = performance.now();
    }

    private integrate() {
        const now = performance.now();
        const dt = Math.max(0, (now - this.lastAt) / 1000);
        this.lastAt = now;
        const r = this.rates;
        this.framesEncoded += Math.round(r.fps * dt);
        this.totalEncodeTime += r.encodeBusy * dt;
        this.bytesSent += Math.round(r.kbps * 1000 / 8 * dt);
        if (r.sourceFps != null) this.sourceFrames += Math.round(r.sourceFps * dt);
        this.limited[r.limitation] += dt;
        if (!r.link) return;
        const n = this.net;
        const media = r.kbps * 1000 / 8 / SIM_PACKET_BYTES * dt;
        const rtx = r.link.rtxKbps * 1000 / 8 * dt;
        n.packets += media + rtx / SIM_PACKET_BYTES;
        n.rtxPackets += rtx / SIM_PACKET_BYTES;
        n.rtxBytes += rtx;
        n.lost += media * r.link.lossPct / 100;
        n.sendDelay += (media + rtx / SIM_PACKET_BYTES) * r.link.pacerMs / 1000;
        n.nacks += r.link.naksPerSecond * dt;
        n.plis += r.link.plisPerSecond * dt;
        n.keyframes += r.link.keyframesPerSecond * dt;
        n.qpSum += r.fps * dt * r.link.qp;
        n.rttTotal += r.link.rttMs / 1000 * dt;
        n.rttCount += dt;
    }

    set(patch: Partial<EncoderRates>) {
        this.integrate();
        this.rates = { ...this.rates, ...patch };
    }

    stats(): StatsEntry[] {
        this.integrate();
        const r = this.rates;
        const n = this.net;
        return videoSenderStats({
            framesEncoded: this.framesEncoded, totalEncodeTime: this.totalEncodeTime, bytesSent: this.bytesSent,
            frameWidth: r.width, frameHeight: r.height, framesPerSecond: r.fps,
            qualityLimitationReason: r.limitation, qualityLimitationDurations: { ...this.limited },
            mimeType: r.mimeType, encoderImplementation: r.implementation, powerEfficientEncoder: r.powerEfficient,
            sourceFrames: r.sourceFps != null ? this.sourceFrames : null, sourceFps: r.sourceFps,
            availableOutgoingBitrate: r.availableKbps != null ? r.availableKbps * 1000 : null,
            ...(r.link ? {
                extra: {
                    targetBitrate: r.link.targetKbps * 1000, packetsSent: Math.round(n.packets), retransmittedPacketsSent: Math.round(n.rtxPackets),
                    retransmittedBytesSent: Math.round(n.rtxBytes), totalPacketSendDelay: n.sendDelay, nackCount: Math.round(n.nacks),
                    pliCount: Math.round(n.plis), keyFramesEncoded: Math.round(n.keyframes), qpSum: Math.round(n.qpSum)
                },
                remoteInbound: {
                    packetsLost: Math.round(n.lost), fractionLost: r.link.lossPct / 100, jitter: r.link.jitterMs / 1000, roundTripTime: r.link.rttMs / 1000,
                    totalRoundTripTime: n.rttTotal, roundTripTimeMeasurements: Math.round(n.rttCount)
                }
            } : {})
        });
    }

    attach(sender: FakeRTCRtpSender) {
        sender.stats = () => this.stats();
        return this;
    }
}

// #endregion

// #region navigator.mediaDevices / navigator.mediaCapabilities

export const mediaDevices = {
    /** constraints of every getDisplayMedia call, oldest first */
    displayMediaCalls: [] as MediaStreamConstraints[],
    userMediaCalls: [] as MediaStreamConstraints[],
    /** default: a 1920x1080@60 capture (+ audio when asked) */
    getDisplayMediaImpl: (constraints: MediaStreamConstraints): Promise<FakeMediaStream> => Promise.resolve(captureStream({ audio: !!constraints.audio })),
    getUserMediaImpl: (constraints: MediaStreamConstraints): Promise<FakeMediaStream> => Promise.resolve(new FakeMediaStream([
        ...(constraints.video ? [videoTrack()] : []), ...(constraints.audio ? [audioTrack()] : [])
    ])),
    getDisplayMedia(constraints: MediaStreamConstraints = {}) {
        mediaDevices.displayMediaCalls.push(constraints);
        return mediaDevices.getDisplayMediaImpl(constraints);
    },
    getUserMedia(constraints: MediaStreamConstraints = {}) {
        mediaDevices.userMediaCalls.push(constraints);
        return mediaDevices.getUserMediaImpl(constraints);
    },
    async enumerateDevices(): Promise<MediaDeviceInfo[]> {
        return [];
    },
    addEventListener() { },
    removeEventListener() { }
};

/** H.264 profile-level-ids the fake says are hardware (powerEfficient) for encodingInfo / decodingInfo. */
export const mediaCapabilities = {
    hwEncode: [] as string[],
    hwDecode: [] as string[],
    calls: [] as { kind: "encodingInfo" | "decodingInfo"; config: any; }[],
    answer(kind: "encodingInfo" | "decodingInfo", config: any) {
        mediaCapabilities.calls.push({ kind, config });
        const contentType = String(config?.video?.contentType ?? "");
        const profile = /profile-level-id=([0-9a-f]{6})/i.exec(contentType)?.[1]?.toLowerCase();
        const hw = kind === "encodingInfo" ? mediaCapabilities.hwEncode : mediaCapabilities.hwDecode;
        const powerEfficient = !!profile && hw.includes(profile) && /packetization-mode=1/.test(contentType);
        return Promise.resolve({ supported: true, smooth: true, powerEfficient });
    },
    encodingInfo: (config: any) => mediaCapabilities.answer("encodingInfo", config),
    decodingInfo: (config: any) => mediaCapabilities.answer("decodingInfo", config)
};

// #endregion

// #region install

const GLOBALS = {
    RTCPeerConnection: FakeRTCPeerConnection,
    RTCRtpSender: FakeRTCRtpSender,
    RTCRtpReceiver: FakeRTCRtpReceiver,
    RTCRtpTransceiver: FakeRTCRtpTransceiver,
    RTCCertificate: FakeRTCCertificate,
    RTCDtlsTransport: FakeDtlsTransport,
    MediaStream: FakeMediaStream,
    MediaStreamTrack: FakeMediaStreamTrack
} as const;

export interface WebRtcEnv {
    /** every RTCPeerConnection created since install (FakeRTCPeerConnection.instances) */
    readonly peerConnections: FakeRTCPeerConnection[];
    readonly mediaDevices: typeof mediaDevices;
    readonly mediaCapabilities: typeof mediaCapabilities;
    restore(): void;
}

function defineOn(target: object, key: string, value: unknown, saved: (() => void)[]) {
    const before = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: true });
    saved.push(() => {
        if (before) Object.defineProperty(target, key, before);
        else delete (target as Record<string, unknown>)[key];
    });
}

export interface InstallWebRtcOptions {
    /** navigator.hardwareConcurrency (the auto quality's CPU budget); default: leave Node's value */
    hardwareConcurrency?: number;
    /** false = no navigator.mediaCapabilities (old Chromium) */
    mediaCapabilities?: boolean;
}

/**
 * Installs the fakes on globalThis (and navigator), resetting their shared state (instances, capabilities, calls).
 * Install after @test/fakes/dom when a test also needs a DOM (happy-dom brings its own navigator).
 */
export function installWebRtc(opts: InstallWebRtcOptions = {}): WebRtcEnv {
    const saved: (() => void)[] = [];
    for (const [key, value] of Object.entries(GLOBALS)) defineOn(globalThis, key, value, saved);

    FakeRTCPeerConnection.instances = [];
    FakeRTCPeerConnection.generateCertificateImpl = null;
    rtpCapabilities.sender = { video: DEFAULT_VIDEO_CODECS, audio: DEFAULT_AUDIO_CODECS };
    rtpCapabilities.receiver = { video: DEFAULT_VIDEO_CODECS, audio: DEFAULT_AUDIO_CODECS };
    mediaDevices.displayMediaCalls.length = 0;
    mediaDevices.userMediaCalls.length = 0;
    mediaDevices.getDisplayMediaImpl = constraints => Promise.resolve(captureStream({ audio: !!constraints.audio }));
    mediaDevices.getUserMediaImpl = constraints => Promise.resolve(new FakeMediaStream([
        ...(constraints.video ? [videoTrack()] : []), ...(constraints.audio ? [audioTrack()] : [])
    ]));
    mediaCapabilities.hwEncode = [];
    mediaCapabilities.hwDecode = [];
    mediaCapabilities.calls.length = 0;

    const nav = globalThis.navigator as object;
    defineOn(nav, "mediaDevices", mediaDevices, saved);
    defineOn(nav, "mediaCapabilities", opts.mediaCapabilities === false ? undefined : mediaCapabilities, saved);
    if (opts.hardwareConcurrency != null) defineOn(nav, "hardwareConcurrency", opts.hardwareConcurrency, saved);

    return {
        get peerConnections() {
            return FakeRTCPeerConnection.instances;
        },
        mediaDevices,
        mediaCapabilities,
        restore() {
            for (const undo of saved.splice(0).reverse()) undo();
        }
    };
}

// #endregion
