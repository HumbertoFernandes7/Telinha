/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@api/Settings`: definePluginSettings with an in-memory store. Like Vencord after the plugin registers,
// `store` already holds the defaults (SELECT: the option marked default), and writing a value through `store` calls
// the option's onChange(newValue) when it changed. `plain` is the raw object (no onChange), as in Vencord.
// Test controls: pluginSettings in this module (re-exported by @test/fakes/vencord).

import * as React from "react";

const PLUGIN_NAME = "Telinha";
// same numbers as Vencord's const enum OptionType (checked against .vencord by the add-on build)
const SELECT = 4;

interface OptionDef {
    type?: number;
    default?: unknown;
    options?: readonly { value: unknown; default?: boolean; }[];
    onChange?(value: any): void;
    [key: string]: unknown;
}

interface Registered {
    def: Record<string, OptionDef>;
    plain: Record<string, unknown>;
}

const registered: Registered[] = [];
const listeners = new Set<() => void>();
let version = 0;

function changed() {
    version++;
    for (const fn of [...listeners]) fn();
}

function defaultsOf(def: Record<string, OptionDef>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, d] of Object.entries(def)) {
        if ("default" in d) out[key] = d.default;
        else if (d.type === SELECT) out[key] = d.options?.find(o => o.default)?.value;
    }
    return out;
}

function load(r: Registered, values: Record<string, unknown>) {
    for (const key of Object.keys(r.plain)) delete r.plain[key];
    Object.assign(r.plain, defaultsOf(r.def), values);
}

export function definePluginSettings<D extends Record<string, any>>(def: D, checks?: Record<string, object>) {
    if (checks) for (const [name, check] of Object.entries(checks)) Object.assign(def[name], check);
    const r: Registered = { def, plain: {} };
    load(r, {});
    registered.push(r);

    const store = new Proxy(r.plain, {
        set(target, key, value) {
            const before = target[key as string];
            target[key as string] = value;
            if (!Object.is(before, value)) {
                changed();
                r.def[key as string]?.onChange?.(value);
            }
            return true;
        },
        deleteProperty(target, key) {
            delete target[key as string];
            changed();
            return true;
        }
    });

    const defined = {
        get store(): any {
            return store;
        },
        get plain(): any {
            return r.plain;
        },
        use(_keys?: string[]): any {
            React.useSyncExternalStore(subscribe, () => version);
            return store;
        },
        def,
        pluginName: PLUGIN_NAME,
        withPrivateSettings<T extends object>() {
            return defined as typeof defined & { store: T; };
        }
    };
    return defined;
}

function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** Vencord's global settings object (only the plugin part is meaningful here). */
export const Settings = {
    get plugins(): Record<string, Record<string, unknown>> {
        return Object.fromEntries(registered.map(r => [PLUGIN_NAME, r.plain]));
    }
};

export function useSettings() {
    React.useSyncExternalStore(subscribe, () => version);
    return Settings;
}

function only(): Registered {
    const r = registered[registered.length - 1];
    if (!r) throw new Error("fake settings: definePluginSettings was not called yet (import @plugins/telinha/settings first)");
    return r;
}

/** Test controls for the plugin's settings (the last definePluginSettings call). */
export const pluginSettings = {
    /** Replaces every stored value: defaults + `values`, as if Vencord had loaded them from disk. No onChange. */
    load(values: Record<string, unknown> = {}) {
        load(only(), values);
        changed();
    },
    /** Same as `settings.store[key] = value` in the plugin: calls the option's onChange when the value changes. */
    set(key: string, value: unknown) {
        const r = only();
        const before = r.plain[key];
        r.plain[key] = value;
        changed();
        if (!Object.is(before, value)) r.def[key]?.onChange?.(value);
    },
    get(key: string): unknown {
        return only().plain[key];
    },
    defaults(): Record<string, unknown> {
        return defaultsOf(only().def);
    },
    reset() {
        for (const r of registered) load(r, {});
        changed();
    }
};
