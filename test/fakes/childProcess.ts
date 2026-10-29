/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake child processes for the main-process modules (core/audio/screenAudioMain.ts spawns telinha-audio.exe,
// nativeWindowPid.ts spawns PowerShell). Nothing is ever executed: mockSpawn replaces child_process.spawn (tsx
// compiles the plugin to CommonJS, whose calls read `spawn` from the module object at call time).
//
//   const procs = mockSpawn(t, p => {                 // t = the TestContext: restored when the test ends
//       if (p.args[0] === "--probe") p.exit(0);       // answer as the helper would
//   });
//   procs.spawned[0].writeStdout(Buffer.from(...));    // feed stdout / stderr, then p.exit(code) or p.fail(error)

import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mock, type TestContext } from "node:test";

export class FakeChildProcess extends EventEmitter {
    readonly command: string;
    readonly args: string[];
    readonly options: unknown;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new PassThrough();
    /** everything the parent wrote to stdin */
    readonly stdinData: Buffer[] = [];
    stdinEnded = false;
    pid = 40_000 + Math.floor(Math.random() * 1000);
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;
    readonly killSignals: (NodeJS.Signals | number | undefined)[] = [];
    /** kill() ends the process at once (default) or leaves it running (a hung helper) */
    exitOnKill = true;

    constructor(command: string, args: string[], options: unknown) {
        super();
        this.command = command;
        this.args = args;
        this.options = options;
        this.stdin.on("data", (b: Buffer) => this.stdinData.push(b));
        this.stdin.on("finish", () => {
            this.stdinEnded = true;
        });
    }

    kill(signal?: NodeJS.Signals | number) {
        this.killSignals.push(signal);
        this.killed = true;
        if (this.exitOnKill && this.exitCode === null && this.signalCode === null) this.exit(null, typeof signal === "string" ? signal : "SIGTERM");
        return true;
    }

    writeStdout(data: string | Buffer) {
        this.stdout.write(data);
    }

    writeStderr(data: string | Buffer) {
        this.stderr.write(data);
    }

    /** The process ends: "exit" now, "close" after the streams end (like Node). */
    exit(code: number | null, signal: NodeJS.Signals | null = null) {
        if (this.exitCode !== null || this.signalCode !== null) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.emit("exit", code, signal);
        this.stdout.end();
        this.stderr.end();
        setImmediate(() => this.emit("close", code, signal));
    }

    /** spawn failed (e.g. ENOENT, or Windows blocking the executable): "error" event. */
    fail(error: Error) {
        this.emit("error", error);
    }
}

export interface SpawnEnv {
    readonly spawned: FakeChildProcess[];
    restore(): void;
}

/**
 * Replaces child_process.spawn. `onSpawn` runs synchronously for each new process (before the caller attaches its
 * listeners): schedule exits with setImmediate/timers, or drive the process later from `spawned`.
 */
export function mockSpawn(t: TestContext | undefined, onSpawn?: (proc: FakeChildProcess) => void): SpawnEnv {
    const spawned: FakeChildProcess[] = [];
    const tracker = t ? t.mock : mock;
    const m = tracker.method(childProcess, "spawn", ((command: string, args?: readonly string[], options?: unknown) => {
        const proc = new FakeChildProcess(command, [...(args ?? [])], options);
        spawned.push(proc);
        onSpawn?.(proc);
        return proc;
    }) as unknown as typeof childProcess.spawn);
    return { spawned, restore: () => m.mock.restore() };
}
