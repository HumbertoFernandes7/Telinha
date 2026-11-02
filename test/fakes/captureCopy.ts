/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake browser side of the "cópia na hora" (core/captureCopy.ts): a scriptable Worker (with addEventListener, unlike
// test/fakes/worker.ts), MediaStreamTrackProcessor and MediaStreamTrackGenerator. By default the worker side behaves
// like captureCopyWorker.ts: "hello" on load, "ready" on init, the counters on "stats". Pass the env to
// startCaptureCopy(track, env.env) or to setCaptureCopyEnvForTests(env.env).
//
//   const copy = fakeCopyEnv({ method: "webgpu" });
//   copy.stats = { frames: 120, copied: 120, ... };   // what the next "stats" answer carries
//   copy.worker.fail("boom");                          // an uncaught error in the worker

import type { CaptureCopyEnv, CaptureCopyStats } from "@plugins/telinha/core/captureCopy";

import { FakeMediaStreamTrack } from "./webrtc";

type Listener = (ev: any) => void;

export class FakeCopyWorker {
    readonly url: string;
    readonly posted: any[] = [];
    /** the transfer list of every postMessage that had one */
    readonly transfers: unknown[][] = [];
    terminated = false;
    private readonly listeners = { message: new Set<Listener>(), error: new Set<Listener>() };
    private readonly env: FakeCopyEnv;

    constructor(url: string | URL, env: FakeCopyEnv) {
        this.url = String(url);
        this.env = env;
        if (env.refuse?.(this.url)) throw new Error(`fake Worker: refused ${this.url.slice(0, 5)}`);
        env.workers.push(this);
        queueMicrotask(() => { if (env.hello) this.emit({ type: "hello" }); });
    }

    addEventListener(type: "message" | "error", fn: Listener) {
        this.listeners[type]?.add(fn);
    }

    removeEventListener(type: "message" | "error", fn: Listener) {
        this.listeners[type]?.delete(fn);
    }

    postMessage(data: any, transfer?: unknown[]) {
        if (transfer?.length) {
            if (this.env.transferThrows) throw new Error("DataCloneError: fake");
            this.transfers.push(transfer);
        }
        this.posted.push(data);
        queueMicrotask(() => this.env.script(this, data));
    }

    emit(data: unknown) {
        if (this.terminated) return;
        for (const fn of [...this.listeners.message]) fn({ data });
    }

    fail(message: string) {
        if (this.terminated) return;
        for (const fn of [...this.listeners.error]) fn({ message });
    }

    terminate() {
        this.terminated = true;
    }

    /** the ops the main side sent, oldest first */
    ops(): string[] {
        return this.posted.map(p => p?.op);
    }
}

export class FakeGenerator extends FakeMediaStreamTrack {
    readonly writable = { fake: "writable" };
    constructor() {
        super("video", { label: "generator" });
    }
}

export interface FakeCopyEnv {
    env: CaptureCopyEnv;
    workers: FakeCopyWorker[];
    /** the last worker created */
    readonly worker: FakeCopyWorker;
    processors: { track: MediaStreamTrack; maxBufferSize?: number; readable: unknown; }[];
    generators: FakeGenerator[];
    /** the worker says "hello" when it loads (false = a worker that never runs, e.g. refused by the CSP) */
    hello: boolean;
    /** answer to "init": a method, or a failure text */
    method: "webgpu" | "canvas2d";
    adapter: string | null;
    initFails: string | null;
    /** the worker stops answering "stats" (hung) */
    mute: boolean;
    stats: Partial<CaptureCopyStats>;
    transferThrows: boolean;
    /** the never-negotiated RTCPeerConnections (refreshHolder): the tracks added and whether each was closed */
    holders: { tracks: unknown[]; closed: boolean; }[];
    refuse: ((url: string) => boolean) | null;
    script(worker: FakeCopyWorker, data: any): void;
}

export function fakeCopyEnv(over: Partial<Pick<FakeCopyEnv, "hello" | "method" | "adapter" | "initFails" | "mute" | "transferThrows">> = {}): FakeCopyEnv {
    const workers: FakeCopyWorker[] = [];
    const processors: FakeCopyEnv["processors"] = [];
    const generators: FakeGenerator[] = [];
    const env: FakeCopyEnv = {
        workers,
        get worker() { return workers[workers.length - 1]; },
        processors,
        generators,
        hello: true,
        method: "webgpu",
        adapter: "nvidia ampere",
        initFails: null,
        mute: false,
        stats: {},
        transferThrows: false,
        holders: [],
        refuse: null,
        script(worker, data) {
            if (data?.op === "init") {
                if (env.initFails) worker.emit({ type: "failed", error: env.initFails });
                else worker.emit({ type: "ready", method: env.method, adapter: env.adapter });
            } else if (data?.op === "stats" && !env.mute) {
                worker.emit({ type: "stats", ...zeroStats(env.method), ...env.stats });
            }
        },
        ...over,
        env: undefined as unknown as CaptureCopyEnv
    };
    env.env = {
        Worker: class extends FakeCopyWorker {
            constructor(url: string | URL) {
                super(url, env);
            }
        } as unknown as typeof Worker,
        MediaStreamTrackProcessor: class {
            readonly readable = { fake: "readable" };
            constructor(init: { track: MediaStreamTrack; maxBufferSize?: number; }) {
                processors.push({ ...init, readable: this.readable });
            }
        } as unknown as CaptureCopyEnv["MediaStreamTrackProcessor"],
        MediaStreamTrackGenerator: class extends FakeGenerator {
            constructor() {
                super();
                generators.push(this);
            }
        } as unknown as CaptureCopyEnv["MediaStreamTrackGenerator"],
        createObjectURL: () => "blob:fake-copy",
        revokeObjectURL: () => { },
        RTCPeerConnection: class {
            private readonly h = { tracks: [] as unknown[], closed: false };
            constructor() { env.holders.push(this.h); }
            addTrack(track: unknown) { this.h.tracks.push(track); return {} as RTCRtpSender; }
            close() { this.h.closed = true; }
        } as unknown as CaptureCopyEnv["RTCPeerConnection"]
    };
    return env;
}

export function zeroStats(method: CaptureCopyStats["method"] = "webgpu"): CaptureCopyStats {
    return {
        frames: 0, copied: 0, passed: 0, dropped: 0, dropGpu: 0, dropWrite: 0, refreshed: 0, copyMs: 0, copyMax: 0,
        gpuMs: 0, gpuN: 0, gpuMax: 0, gpuLate: 0, width: 0, height: 0, method, inflight: 0
    };
}
