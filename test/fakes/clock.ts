/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake time for tests: node:test's mock timers (setTimeout, setInterval, Date) plus performance.now(), which the
// mock timers do not cover and the plugin uses for every interval it measures (quality, first frame, resize grace).
// performance.now() follows the mocked Date.now(), so one tick moves both.
//
//   test("...", async t => {
//       const clock = useFakeClock(t);     // restored when the test ends
//       await clock.tickAsync(20_000);      // advances in steps, running timers and the promises they start
//   });
//
// queueMicrotask, setImmediate and promises stay real: core/context.ts publish() runs in a microtask.

import { mock, type TestContext } from "node:test";

type MockTracker = typeof mock;

export interface FakeClock {
    /** performance.now() right now (starts at `startPerf`) */
    now(): number;
    /** Date.now() right now (starts at `startEpoch`) */
    epoch(): number;
    /** Advances synchronously: due timers run, their promises do not settle until the next await. */
    tick(ms: number): void;
    /** Advances in `stepMs` slices, flushing promises between them (timers that await, then set more timers). */
    tickAsync(ms: number, stepMs?: number): Promise<void>;
    /** Runs every pending timer (a setInterval would loop forever: avoid with intervals). */
    runAll(): void;
    restore(): void;
}

/** Lets every pending promise reaction (and the ones they queue) run: a real macrotask turn. */
export function flushPromises(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

/**
 * Turns on fake time. With a TestContext `t` everything is undone when that test ends; without it, call restore().
 * `startPerf`: initial performance.now() (default 1_000_000, so "-Infinity / 0 means never" checks behave).
 */
export function useFakeClock(t?: TestContext, opts: { startEpoch?: number; startPerf?: number; } = {}): FakeClock {
    const tracker: MockTracker = t ? t.mock : mock;
    const startEpoch = opts.startEpoch ?? Date.UTC(2026, 9, 29, 12, 0, 0);
    const startPerf = opts.startPerf ?? 1_000_000;
    tracker.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: startEpoch });
    const perf = tracker.method(performance, "now", () => Date.now() - startEpoch + startPerf);

    let restored = false;
    const clock: FakeClock = {
        now: () => performance.now(),
        epoch: () => Date.now(),
        tick(ms) {
            tracker.timers.tick(ms);
        },
        async tickAsync(ms, stepMs = 100) {
            let left = ms;
            await flushPromises();
            while (left > 0) {
                const step = Math.min(stepMs, left);
                tracker.timers.tick(step);
                left -= step;
                await flushPromises();
            }
        },
        runAll() {
            tracker.timers.runAll();
        },
        restore() {
            if (restored) return;
            restored = true;
            perf.mock.restore();
            tracker.timers.reset();
        }
    };
    return clock;
}

/**
 * Waits (real time, one macrotask at a time) until `check()` returns something truthy, and returns it. For flows that
 * hop through promises and setTimeout(0) with REAL timers (with the fake clock, tick instead). Rejects after
 * `timeoutMs` of wall time (measured with hrtime, so a mocked Date cannot stall it).
 */
export async function eventually<T>(check: () => T | null | undefined | false | 0 | "", { timeoutMs = 3000 }: { timeoutMs?: number; } = {}): Promise<T> {
    const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
    for (;;) {
        const value = check();
        if (value) return value;
        if (process.hrtime.bigint() > deadline) throw new Error(`eventually: condition still false after ${timeoutMs} ms: ${check.toString().slice(0, 200)}`);
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}
