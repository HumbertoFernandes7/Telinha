/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake dedicated Worker for the WebCodecs probe (core/encoderProbe.ts). Node and happy-dom have no `Worker`: nothing is
// global until installWorker(). The test plays the worker side: `script` runs on every postMessage (after a microtask)
// and answers with `worker.emit(...)`, the messages the real probe worker posts ({ ev: "phase" | "chunk" | "error" |
// "done", ... }). A script that never emits "done" is a stuck encoder.
//
//   const workers = installWorker((w, data) => { w.emit({ ev: "phase", phase: "encode" }); ... });
//   workers.instances[0].terminated   // the probe must never terminate a stuck one

export class FakeWorker {
    readonly url: string;
    onmessage: ((ev: { data: unknown; }) => void) | null = null;
    onerror: ((ev: { message: string; }) => void) | null = null;
    /** every postMessage argument, oldest first */
    readonly posted: unknown[] = [];
    terminated = false;
    private readonly env: WorkerEnv;

    constructor(url: string | URL, env: WorkerEnv) {
        this.url = String(url);
        this.env = env;
        if (env.refuse?.(this.url)) throw new Error(`fake Worker: refused ${this.url.slice(0, 5)}`);
        env.instances.push(this);
    }

    postMessage(data: unknown) {
        this.posted.push(data);
        queueMicrotask(() => this.env.script?.(this, data));
    }

    /** A message from the worker side (ignored after terminate, like the real one). */
    emit(data: unknown) {
        if (!this.terminated) this.onmessage?.({ data });
    }

    /** The worker script failed (an uncaught error: the "error" event). */
    fail(message: string) {
        if (!this.terminated) this.onerror?.({ message });
    }

    terminate() {
        this.terminated = true;
    }

    addEventListener() { }
    removeEventListener() { }
}

export interface WorkerEnv {
    /** every worker created, oldest first */
    instances: FakeWorker[];
    /** the worker side: runs on each postMessage */
    script: ((worker: FakeWorker, data: any) => void) | null;
    /** return true to make `new Worker(url)` throw (a CSP that refuses blob: or data:) */
    refuse: ((url: string) => boolean) | null;
    restore(): void;
}

/** Puts a fake `Worker` on globalThis; restore() puts the previous value back. */
export function installWorker(script: WorkerEnv["script"] = null): WorkerEnv {
    const g = globalThis as { Worker?: unknown; };
    const before = g.Worker;
    const env: WorkerEnv = {
        instances: [],
        script,
        refuse: null,
        restore() {
            g.Worker = before;
        }
    };
    g.Worker = class extends FakeWorker {
        constructor(url: string | URL) {
            super(url, env);
        }
    };
    return env;
}

/** What the real probe worker posts when the GPU encodes fine: the phases, the 1st chunk and "done" with `chunks`. */
export function healthyProbe(chunks = 30): NonNullable<WorkerEnv["script"]> {
    return w => {
        w.emit({ ev: "phase", phase: "isConfigSupported" });
        w.emit({ ev: "phase", phase: "encode" });
        w.emit({ ev: "chunk" });
        w.emit({ ev: "phase", phase: "flush" });
        w.emit({ ev: "done", verdict: "finished", chunks, error: null });
    };
}

/** The friend's AMD on 31/10: config accepted, frames go in, no chunk ever comes out and flush() never settles. */
export function stuckProbe(): NonNullable<WorkerEnv["script"]> {
    return w => {
        w.emit({ ev: "phase", phase: "isConfigSupported" });
        w.emit({ ev: "phase", phase: "encode" });
        w.emit({ ev: "phase", phase: "flush" });
    };
}
