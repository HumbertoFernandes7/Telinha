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
//
// One tick moves the clock first and then runs every due timer: inside tick(2000) the timers due at 500, 1000 and 1500
// all read Date.now() / performance.now() = the END of the tick (+2000). Code that measures with the clock from inside a
// timer (an interval's elapsed time, a deadline check) needs tick(ms, { stepwise: true }), or tickAsync(ms, 1).

import { mock, type TestContext } from "node:test";

type MockTracker = typeof mock;

// the real setTimeout, taken before any useFakeClock replaces it: how eventually() tells that the fake clock is on
const realSetTimeout = globalThis.setTimeout;

export interface FakeClock {
    /** performance.now() right now (starts at `startPerf`) */
    now(): number;
    /** Date.now() right now (starts at `startEpoch`) */
    epoch(): number;
    /**
     * Advances synchronously: due timers run, their promises do not settle until the next await. Every timer due in
     * the tick sees the clock at the end of it; `stepwise` advances 1 ms at a time instead, so each one sees the
     * instant it was due (the same for setTimeout(0) chains: a timer set by a timer runs in its own ms).
     */
    tick(ms: number, opts?: { stepwise?: boolean; }): void;
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
        tick(ms, { stepwise = false } = {}) {
            if (!stepwise || ms <= 1) return tracker.timers.tick(ms);
            for (let left = ms; left > 0; left--) tracker.timers.tick(Math.min(1, left));
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
 * hop through promises, crypto.subtle and (real) setTimeout(0): it lets the event loop turn. It also works with the
 * fake clock on: the code's timers are fake and only a tick runs them, so it polls with setImmediate alone (waiting on
 * a timer would hang) and the test ticks the clock itself. Rejects after `timeoutMs` of wall time (measured with
 * hrtime, so a mocked Date cannot stall it).
 */
export async function eventually<T>(check: () => T | null | undefined | false | 0 | "", { timeoutMs = 3000 }: { timeoutMs?: number; } = {}): Promise<T> {
    const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
    for (;;) {
        const value = check();
        if (value) return value;
        if (process.hrtime.bigint() > deadline) throw new Error(`eventually: condition still false after ${timeoutMs} ms: ${check.toString().slice(0, 200)}`);
        await new Promise(resolve => setImmediate(resolve));
        // the REAL setTimeout (a fake one never fires by itself); only while no fake clock is replacing it
        if (globalThis.setTimeout === realSetTimeout) await new Promise(resolve => realSetTimeout(resolve, 1));
    }
}
