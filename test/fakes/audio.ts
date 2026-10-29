/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake Web Audio for Node: AudioContext (oscillator, gain, AudioWorklet, MediaStreamAudioDestinationNode),
// AudioWorkletNode with a MessagePort-like port, and the WebCodecs path (MediaStreamTrackGenerator + AudioData).
// installWebAudio() puts them on globalThis; restore() takes them back. Uses FakeMediaStream/Track from webrtc.ts.
//
//   const audio = installWebAudio();
//   audio.contexts[0].workletModules   // what addModule received
//   audio.workletNodes[0].port.posted  // PCM buffers the plugin pushed

import { FakeMediaStream, FakeMediaStreamTrack } from "./webrtc";

class FakeAudioParam {
    value: number;
    readonly events: { method: string; value: number; time: number; }[] = [];

    constructor(value = 0) {
        this.value = value;
    }

    setValueAtTime(value: number, time: number) {
        this.events.push({ method: "setValueAtTime", value, time });
        return this;
    }

    linearRampToValueAtTime(value: number, time: number) {
        this.events.push({ method: "linearRampToValueAtTime", value, time });
        return this;
    }

    exponentialRampToValueAtTime(value: number, time: number) {
        this.events.push({ method: "exponentialRampToValueAtTime", value, time });
        return this;
    }

    cancelScheduledValues() {
        return this;
    }
}

export class FakeAudioNode {
    readonly context: FakeAudioContext;
    readonly connections: FakeAudioNode[] = [];
    disconnected = false;

    constructor(context: FakeAudioContext) {
        this.context = context;
    }

    connect<T extends FakeAudioNode>(target: T): T {
        this.connections.push(target);
        return target;
    }

    disconnect() {
        this.disconnected = true;
        this.connections.length = 0;
    }
}

export class FakeOscillatorNode extends FakeAudioNode {
    type = "sine";
    readonly frequency = new FakeAudioParam(440);
    started: number | null = null;
    stopped: number | null = null;
    onended: (() => void) | null = null;

    start(when = 0) {
        this.started = when;
    }

    stop(when = 0) {
        this.stopped = when;
    }
}

export class FakeGainNode extends FakeAudioNode {
    readonly gain = new FakeAudioParam(1);
}

export class FakeMediaStreamAudioDestinationNode extends FakeAudioNode {
    readonly stream = new FakeMediaStream([new FakeMediaStreamTrack("audio", { label: "MediaStreamAudioDestinationNode" })]);
}

/** MessagePort-like: postMessage records (with the transfer list); emit() delivers a message to onmessage. */
export class FakePort {
    readonly posted: { data: unknown; transfer?: unknown[]; }[] = [];
    onmessage: ((e: { data: unknown; }) => void) | null = null;

    postMessage(data: unknown, transfer?: unknown[]) {
        this.posted.push({ data, ...(transfer ? { transfer } : {}) });
    }

    emit(data: unknown) {
        this.onmessage?.({ data });
    }

    close() { }
}

export class FakeAudioWorkletNode extends FakeAudioNode {
    readonly name: string;
    readonly options: unknown;
    readonly port = new FakePort();

    constructor(context: FakeAudioContext, name: string, options?: unknown) {
        super(context);
        if (!context.registeredProcessors.size && !context.workletModules.length) throw new Error(`fake AudioWorkletNode: no module loaded for "${name}"`);
        this.name = name;
        this.options = options;
        audioEnv.workletNodes.push(this);
    }
}

export class FakeAudioContext {
    state: AudioContextState = "suspended";
    readonly sampleRate: number;
    readonly options: unknown;
    currentTime = 0;
    readonly destination: FakeAudioNode;
    /** URLs given to audioWorklet.addModule (accepted ones) */
    readonly workletModules: string[] = [];
    readonly registeredProcessors = new Set<string>();
    readonly oscillators: FakeOscillatorNode[] = [];
    readonly audioWorklet: { addModule(url: string): Promise<void>; };
    /** state resume() leaves the context in ("running" by default; "suspended" = autoplay policy) */
    resumeTo: AudioContextState = "running";

    constructor(options?: { sampleRate?: number; latencyHint?: unknown; }) {
        this.options = options;
        this.sampleRate = options?.sampleRate ?? 48000;
        this.destination = new FakeAudioNode(this);
        this.audioWorklet = {
            addModule: async (url: string) => {
                if (audioEnv.addModuleImpl) await audioEnv.addModuleImpl(url);
                this.workletModules.push(url);
            }
        };
        audioEnv.contexts.push(this);
    }

    createOscillator() {
        const o = new FakeOscillatorNode(this);
        this.oscillators.push(o);
        return o;
    }

    createGain() {
        return new FakeGainNode(this);
    }

    createMediaStreamDestination() {
        return new FakeMediaStreamAudioDestinationNode(this);
    }

    async resume() {
        this.state = this.resumeTo;
    }

    async suspend() {
        this.state = "suspended";
    }

    async close() {
        this.state = "closed";
    }
}

/** WebCodecs AudioData: keeps what it was built with. */
export class FakeAudioData {
    readonly init: { format: string; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array; };
    closed = false;

    constructor(init: FakeAudioData["init"]) {
        this.init = init;
    }

    close() {
        this.closed = true;
    }
}

/** MediaStreamTrackGenerator({ kind }): a track with a writable that records the frames written to it. */
export class FakeMediaStreamTrackGenerator extends FakeMediaStreamTrack {
    readonly written: unknown[] = [];
    writerClosed = false;
    readonly writable: { getWriter(): { write(chunk: unknown): Promise<void>; close(): Promise<void>; }; };

    constructor(init: { kind: "audio" | "video"; }) {
        super(init.kind, { label: "MediaStreamTrackGenerator" });
        this.writable = {
            getWriter: () => ({
                write: async (chunk: unknown) => {
                    if (this.writerClosed) throw new TypeError("writer closed");
                    this.written.push(chunk);
                },
                close: async () => {
                    this.writerClosed = true;
                }
            })
        };
        audioEnv.generators.push(this);
    }
}

export const audioEnv = {
    contexts: [] as FakeAudioContext[],
    workletNodes: [] as FakeAudioWorkletNode[],
    generators: [] as FakeMediaStreamTrackGenerator[],
    /** runs before addModule accepts a URL: throw to refuse (e.g. blob: blocked by the CSP) */
    addModuleImpl: null as ((url: string) => void | Promise<void>) | null
};

export interface WebAudioEnv {
    readonly contexts: FakeAudioContext[];
    readonly workletNodes: FakeAudioWorkletNode[];
    readonly generators: FakeMediaStreamTrackGenerator[];
    restore(): void;
}

/**
 * Installs AudioContext and AudioWorkletNode; `generator: true` also MediaStreamTrackGenerator + AudioData (the
 * fallback path); `worklet: false` leaves AudioWorkletNode out (an Electron without it). URL.createObjectURL /
 * revokeObjectURL and btoa are Node's own.
 */
export function installWebAudio(opts: { worklet?: boolean; generator?: boolean; } = {}): WebAudioEnv {
    audioEnv.contexts = [];
    audioEnv.workletNodes = [];
    audioEnv.generators = [];
    audioEnv.addModuleImpl = null;
    const globals: Record<string, unknown> = {
        AudioContext: FakeAudioContext,
        ...(opts.worklet === false ? {} : { AudioWorkletNode: FakeAudioWorkletNode }),
        ...(opts.generator ? { MediaStreamTrackGenerator: FakeMediaStreamTrackGenerator, AudioData: FakeAudioData } : {})
    };
    const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    return {
        get contexts() {
            return audioEnv.contexts;
        },
        get workletNodes() {
            return audioEnv.workletNodes;
        },
        get generators() {
            return audioEnv.generators;
        },
        restore() {
            for (const [key, before] of saved) {
                if (before) Object.defineProperty(globalThis, key, before);
                else delete (globalThis as Record<string, unknown>)[key];
            }
        }
    };
}
