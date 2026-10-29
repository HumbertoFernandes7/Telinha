/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake VencordNative.pluginHelpers: the plugin's natives (native.ts, as the renderer sees them through IPC: no event
// argument, everything async) and the add-on loader's TelinhaAddon natives (update.ts). test/setup.ts installs an
// empty VencordNative (= "the native part is not loaded"); installNative() puts these in.
//
//   const native = installNative({ listSources: async () => ({ sources: [] }) });
//   native.calls  // [{ name: "listSources", args: [320, 180] }, ...]

export interface NativeCall {
    name: string;
    args: unknown[];
}

type AnyFn = (...args: any[]) => any;

/** Defaults: two sources, capture handler ok, no whole-screen audio helper. */
export function defaultTelinhaNatives(): Record<string, AnyFn> {
    return {
        listSources: async () => ({
            sources: [
                { id: "screen:0:0", name: "Tela inteira", kind: "screen" },
                { id: "window:1234:0", name: "Jogo", kind: "window" }
            ]
        }),
        prepareDisplayMedia: async () => true,
        finishDisplayMedia: async () => ({ handlerCalled: true, audioRequested: false, audio: null, error: null }),
        resetDisplayMedia: async () => undefined,
        screenAudioStatus: async () => ({ available: false, reason: "o ajudante de áudio (telinha-audio.exe) não foi instalado" }),
        startScreenAudio: async () => ({ ok: false, reason: "sem ajudante de áudio (fake)" }),
        readScreenAudio: async () => ({ pcm: null, ended: true, reason: "fake" }),
        stopScreenAudio: async () => undefined
    };
}

export interface FakeUpdateStatus {
    supported: boolean;
    installed: { version: string; commit: string | null; } | null;
    phase: string;
    latest: { version: string; tag: string; } | null;
    ready: string | null;
    error: { kind: string; message: string; quiet: boolean; } | null;
    checkedAt: number | null;
    skipped: string | null;
    lastRollback: { version: string; to: string; at: string; reason: string; } | null;
}

export function updateStatus(patch: Partial<FakeUpdateStatus> = {}): FakeUpdateStatus {
    return {
        supported: true, installed: { version: "0.2.3", commit: "abcdef12" }, phase: "up-to-date", latest: { version: "0.2.3", tag: "v0.2.3" },
        ready: null, error: null, checkedAt: Date.now(), skipped: null, lastRollback: null, ...patch
    };
}

export function defaultAddonNatives(): Record<string, AnyFn> {
    return {
        updateStatus: async () => updateStatus(),
        updateCheck: async () => updateStatus(),
        updateDownload: async () => updateStatus({ phase: "ready", ready: "0.2.4", latest: { version: "0.2.4", tag: "v0.2.4" } })
    };
}

export interface NativeEnv {
    /** the plugin natives (VencordNative.pluginHelpers.Telinha): replace a function here or with mock.method */
    telinha: Record<string, AnyFn>;
    /** the loader natives (VencordNative.pluginHelpers.TelinhaAddon), or null when not installed */
    addon: Record<string, AnyFn> | null;
    /** every call to either, oldest first */
    calls: NativeCall[];
    restore(): void;
}

function recorded(name: string, impl: Record<string, AnyFn>, calls: NativeCall[]): AnyFn {
    return (...args: unknown[]) => {
        calls.push({ name, args });
        return impl[name](...args);
    };
}

/**
 * Installs VencordNative.pluginHelpers.Telinha (defaults + `telinha` overrides) and, unless `addon` is null,
 * TelinhaAddon. restore() goes back to the empty VencordNative of test/setup.ts.
 */
export function installNative(telinha: Record<string, AnyFn> = {}, opts: { addon?: Record<string, AnyFn> | null; } = {}): NativeEnv {
    const g = globalThis as { VencordNative?: unknown; };
    const before = g.VencordNative;
    const calls: NativeCall[] = [];
    const env: NativeEnv = {
        telinha: { ...defaultTelinhaNatives(), ...telinha },
        addon: opts.addon === null ? null : { ...defaultAddonNatives(), ...opts.addon },
        calls,
        restore() {
            g.VencordNative = before;
        }
    };
    // a key set to undefined in the overrides is left out (an older native.ts without that function)
    const proxy = (impl: Record<string, AnyFn>) => Object.fromEntries(Object.keys(impl).filter(name => typeof impl[name] === "function").map(name => [name, recorded(name, impl, calls)]));
    g.VencordNative = {
        pluginHelpers: {
            Telinha: proxy(env.telinha),
            ...(env.addon ? { TelinhaAddon: proxy(env.addon) } : {})
        }
    };
    return env;
}
