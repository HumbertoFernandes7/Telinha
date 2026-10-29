/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `trystero` (tsconfig.test.json maps the import here): joinRoom returns a FakeRoom that records everything the
// plugin sends and lets the test play the other peers. No relays, no network.
//
//   import { trystero } from "@test/fakes/trystero";
//   const room = trystero.lastRoom!;
//   const { pc } = await room.connectPeer("peerA", { hello: buildHello(FRIEND_ID, "amigo") });  // handshake + onPeerJoin
//   room.receive("watch", { op: "start" }, "peerA");                                           // a message from peerA
//   room.sentOn("presence", "peerA");                                                          // what we sent to peerA
//
// connectPeer creates the peer's RTCPeerConnection with the room's rtcPolyfill (the plugin's TelinhaPeerConnection),
// so installWebRtc() must run first. addStream also puts a sending transceiver for each track on the target peers'
// connections (FakeRTCPeerConnection.addSendingTrack), which is where the plugin then finds the RTCRtpSender.

export const selfId = "fakeselfid0000000000";
export const defaultRelayUrls: string[] = [];

export interface SentMessage {
    namespace: string;
    data: any;
    /** as passed: a peer id, a list, or null/undefined (= everyone) */
    target: string | string[] | null | undefined;
    metadata?: unknown;
}

export interface StreamCall {
    stream: MediaStream;
    target: string | string[] | null | undefined;
    metadata?: unknown;
}

type MessageHandler = (data: any, context: { peerId: string; metadata?: unknown; }) => void | Promise<void>;

export class FakeAction {
    readonly namespace: string;
    private readonly room: FakeRoom;
    onMessage: MessageHandler | null = null;
    onReceiveProgress: unknown = null;
    onReceive: unknown = null;
    /** how send() settles (default: resolves); replace to make sending fail or hang */
    sendImpl: ((data: unknown, opts: { target?: string | string[] | null; metadata?: unknown; } | undefined) => Promise<void>) | null = null;

    constructor(namespace: string, room: FakeRoom) {
        this.namespace = namespace;
        this.room = room;
    }

    send(data: unknown, opts?: { target?: string | string[] | null; metadata?: unknown; }): Promise<void> {
        this.room.sent.push({ namespace: this.namespace, data, target: opts?.target, ...(opts?.metadata !== undefined ? { metadata: opts.metadata } : {}) });
        return this.sendImpl ? this.sendImpl(data, opts) : Promise.resolve();
    }
}

type PeerConnectionLike = RTCPeerConnection & { addSendingTrack?(track: MediaStreamTrack): unknown; };

export interface ConnectPeerOptions {
    /** what the peer sends in the handshake (the plugin's hello); null = an incompatible/garbled peer */
    hello?: unknown;
    /** the peer's connection; default: new rtcPolyfill(rtcConfig) (needs installWebRtc) */
    pc?: PeerConnectionLike;
    isInitiator?: boolean;
    /** false = handshake only (onPeerJoin not called yet: call room.join(peerId) later) */
    join?: boolean;
}

export class FakeRoom {
    readonly config: any;
    readonly roomId: string;
    readonly callbacks: any;
    readonly actions = new Map<string, FakeAction>();
    readonly peers = new Map<string, PeerConnectionLike>();
    /** every message any action sent, oldest first */
    readonly sent: SentMessage[] = [];
    /** what our handshake sent to each peer */
    readonly handshakes = new Map<string, unknown>();
    readonly streamsAdded: StreamCall[] = [];
    readonly streamsRemoved: StreamCall[] = [];
    left = false;
    onPeerJoin: ((peerId: string) => void) | null = null;
    onPeerLeave: ((peerId: string) => void) | null = null;
    onPeerStream: ((stream: MediaStream, peerId: string, metadata?: unknown) => void) | null = null;
    onPeerTrack: ((track: MediaStreamTrack, stream: MediaStream, peerId: string, metadata?: unknown) => void) | null = null;
    /** how the promises addStream returns settle: now ("resolve"/"reject") or when the test calls settleStreams() */
    addStreamMode: "resolve" | "reject" | "manual" = "resolve";
    private readonly pendingStreams: { resolve(): void; reject(e: Error): void; }[] = [];

    constructor(config: any, roomId: string, callbacks: any) {
        this.config = config;
        this.roomId = roomId;
        this.callbacks = callbacks ?? {};
    }

    // #region the Room API the plugin calls

    makeAction(namespace: string): FakeAction {
        let a = this.actions.get(namespace);
        if (!a) this.actions.set(namespace, a = new FakeAction(namespace, this));
        return a;
    }

    getPeers(): Record<string, RTCPeerConnection> {
        return Object.fromEntries(this.peers);
    }

    ping(_peerId: string) {
        return Promise.resolve(20);
    }

    isPassive() {
        return false;
    }

    leave(): Promise<void> {
        this.left = true;
        return Promise.resolve();
    }

    private targets(target: string | string[] | null | undefined): string[] {
        if (target == null) return [...this.peers.keys()];
        return Array.isArray(target) ? target : [target];
    }

    addStream(stream: MediaStream, opts?: { target?: string | string[] | null; metadata?: unknown; }): Promise<void>[] {
        this.streamsAdded.push({ stream, target: opts?.target, metadata: opts?.metadata });
        return this.targets(opts?.target).map(peerId => {
            const pc = this.peers.get(peerId);
            if (pc?.addSendingTrack) for (const t of stream.getTracks()) pc.addSendingTrack(t);
            return this.streamPromise();
        });
    }

    removeStream(stream: MediaStream, opts?: { target?: string | string[] | null; }) {
        this.streamsRemoved.push({ stream, target: opts?.target });
        const tracks = stream.getTracks();
        for (const peerId of this.targets(opts?.target)) {
            for (const s of this.peers.get(peerId)?.getSenders?.() ?? []) if (s.track && tracks.includes(s.track)) (s as { track: unknown; }).track = null;
        }
    }

    addTrack(track: MediaStreamTrack, stream: MediaStream, opts?: { target?: string | string[] | null; metadata?: unknown; }) {
        this.streamsAdded.push({ stream, target: opts?.target, metadata: opts?.metadata });
        return this.targets(opts?.target).map(peerId => {
            this.peers.get(peerId)?.addSendingTrack?.(track);
            return this.streamPromise();
        });
    }

    removeTrack(_track: MediaStreamTrack, _opts?: unknown) { }

    replaceTrack(_old: MediaStreamTrack, _next: MediaStreamTrack, opts?: { target?: string | string[] | null; }) {
        return this.targets(opts?.target).map(() => Promise.resolve());
    }

    private streamPromise(): Promise<void> {
        if (this.addStreamMode === "resolve") return Promise.resolve();
        if (this.addStreamMode === "reject") return Promise.reject(new Error("fake addStream falhou"));
        return new Promise<void>((resolve, reject) => this.pendingStreams.push({ resolve, reject }));
    }

    // #endregion

    // #region test drivers

    /**
     * A peer arrives: runs the plugin's onPeerHandshake (our hello goes to `handshakes`, the peer answers `hello`),
     * registers its connection and calls onPeerJoin. Resolves with the connection and what we sent.
     */
    async connectPeer(peerId: string, opts: ConnectPeerOptions = {}): Promise<{ pc: PeerConnectionLike; sentHello: unknown; }> {
        const Pc = this.config?.rtcPolyfill ?? globalThis.RTCPeerConnection;
        const pc = opts.pc ?? (Pc ? new Pc(this.config?.rtcConfig ?? {}) : ({} as PeerConnectionLike));
        const send = async (data: unknown) => {
            this.handshakes.set(peerId, data);
        };
        const receive = async () => ({ data: (opts.hello ?? null) as any });
        if (this.callbacks.onPeerHandshake) await this.callbacks.onPeerHandshake(peerId, send, receive, opts.isInitiator ?? true);
        this.peers.set(peerId, pc);
        if (opts.join !== false) this.onPeerJoin?.(peerId);
        return { pc, sentHello: this.handshakes.get(peerId) };
    }

    /** onPeerJoin for a peer connected with { join: false }. */
    join(peerId: string) {
        this.onPeerJoin?.(peerId);
    }

    /** The peer leaves the room (onPeerLeave). */
    disconnectPeer(peerId: string) {
        this.peers.delete(peerId);
        this.onPeerLeave?.(peerId);
    }

    /** A message from `peerId` on an action (calls the plugin's onMessage; returns what it returns). */
    receive(namespace: string, data: unknown, peerId: string, metadata?: unknown) {
        const a = this.actions.get(namespace);
        if (!a?.onMessage) throw new Error(`fake trystero: no onMessage for action "${namespace}"`);
        return a.onMessage(data, { peerId, ...(metadata !== undefined ? { metadata } : {}) });
    }

    /** The peer's stream arrives (onPeerStream). */
    emitStream(peerId: string, stream: MediaStream, metadata?: unknown) {
        this.onPeerStream?.(stream, peerId, metadata);
    }

    /** Trystero's onJoinError callback. */
    joinError(peerId: string, error: string) {
        this.callbacks.onJoinError?.({ error, appId: this.config?.appId ?? "", roomId: this.roomId, peerId });
    }

    /** Messages sent on `namespace` that reach `peerId` (a target of null/undefined reaches everyone). */
    sentOn(namespace: string, peerId?: string): SentMessage[] {
        return this.sent.filter(m => m.namespace === namespace
            && (peerId === undefined || m.target == null || m.target === peerId || (Array.isArray(m.target) && m.target.includes(peerId))));
    }

    /** Settles the promises of addStream calls made in "manual" mode, oldest first. */
    settleStreams(ok = true, count = Infinity) {
        for (const p of this.pendingStreams.splice(0, count)) ok ? p.resolve() : p.reject(new Error("fake addStream falhou"));
    }

    // #endregion
}

export interface RelaySocketLike {
    readyState: number;
}

/** Test controls. */
export const trystero = {
    /** every room joined, oldest first */
    rooms: [] as FakeRoom[],
    get lastRoom(): FakeRoom | undefined {
        return trystero.rooms[trystero.rooms.length - 1];
    },
    /** what getRelaySockets() returns; default: one open relay */
    relaySockets: { "wss://relay.fake": { readyState: 1 } } as Record<string, RelaySocketLike>,
    /** replace to make joinRoom throw */
    joinRoomImpl: null as ((config: any, roomId: string, callbacks: any) => FakeRoom) | null,
    reset() {
        trystero.rooms.length = 0;
        trystero.relaySockets = { "wss://relay.fake": { readyState: 1 } };
        trystero.joinRoomImpl = null;
    }
};

export function joinRoom(config: any, roomId: string, callbacks?: any): FakeRoom {
    const room = trystero.joinRoomImpl ? trystero.joinRoomImpl(config, roomId, callbacks) : new FakeRoom(config, roomId, callbacks);
    trystero.rooms.push(room);
    return room;
}

export function getRelaySockets(): Record<string, RelaySocketLike> {
    return trystero.relaySockets;
}

export function pauseRelayReconnection() { }

export function resumeRelayReconnection() { }
