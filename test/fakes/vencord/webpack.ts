/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@webpack` (Vencord's webpack finders). There is no Discord bundle in the tests: a test provides the modules a
// finder should "find" with webpackModules.provideByCode / provideStore / provideByProps. A finder with nothing
// provided behaves like the real one when the module is missing: find() returns null, the lazy finders throw on use.

type Filter = ((m: unknown) => boolean) & { $$kind?: "code" | "props" | "store"; $$keys?: string[]; };

interface Provided {
    kind: "code" | "props" | "store";
    keys: string[];
    value: unknown;
}

const provided: Provided[] = [];

function sameKeys(a: string[], b: string[]) {
    return a.length === b.length && a.every((k, i) => k === b[i]);
}

function lookup(kind: Provided["kind"], keys: string[]): unknown {
    for (let i = provided.length - 1; i >= 0; i--) {
        const p = provided[i];
        if (p.kind === kind && sameKeys(p.keys, keys)) return p.value;
    }
    return undefined;
}

function makeFilter(kind: Provided["kind"], keys: string[]): Filter {
    const f: Filter = m => provided.some(p => p.kind === kind && sameKeys(p.keys, keys) && p.value === m);
    f.$$kind = kind;
    f.$$keys = keys;
    return f;
}

export const filters = {
    byCode: (...code: string[]) => makeFilter("code", code),
    componentByCode: (...code: string[]) => makeFilter("code", code),
    byProps: (...props: string[]) => makeFilter("props", props),
    byStoreName: (name: string) => makeFilter("store", [name])
};

/** find(filter): the provided module for that filter, or null (the real one also logs; the fake stays quiet). */
export function find(filter: Filter, _opts?: { isIndirect?: boolean; isWaitFor?: boolean; }): any {
    if (filter.$$kind && filter.$$keys) return lookup(filter.$$kind, filter.$$keys) ?? null;
    for (const p of provided) if (filter(p.value)) return p.value;
    return null;
}

function missing(what: string): Error {
    return new Error(`fake webpack: nothing provided for ${what} (use webpackModules.provide* in the test)`);
}

function lazyFunction(kind: Provided["kind"], keys: string[]): any {
    return (...args: unknown[]) => {
        const fn = lookup(kind, keys);
        if (typeof fn !== "function") throw missing(`${kind} ${JSON.stringify(keys)}`);
        return fn(...args);
    };
}

function lazyObject(kind: Provided["kind"], keys: string[]): any {
    return new Proxy({}, {
        get(_, prop) {
            const value = lookup(kind, keys) as Record<PropertyKey, unknown> | undefined;
            if (value == null) throw missing(`${kind} ${JSON.stringify(keys)}`);
            const v = value[prop];
            return typeof v === "function" ? v.bind(value) : v;
        },
        has(_, prop) {
            const value = lookup(kind, keys) as object | undefined;
            return value != null && prop in value;
        }
    });
}

export const findByCodeLazy = (...code: string[]) => lazyFunction("code", code);
export const findComponentByCodeLazy = (...code: string[]) => lazyFunction("code", code);
export const findByPropsLazy = (...props: string[]) => lazyObject("props", props);
export const findStoreLazy = (name: string) => lazyObject("store", [name]);
export const findByCode = (...code: string[]) => lookup("code", code) ?? null;
export const findByProps = (...props: string[]) => lookup("props", props) ?? null;
export const findStore = (name: string) => lookup("store", [name]) ?? null;

/** Test controls: what the finders return. Later provides win over earlier ones with the same keys. */
export const webpackModules = {
    provideByCode(code: string | string[], value: unknown) {
        provided.push({ kind: "code", keys: Array.isArray(code) ? code : [code], value });
    },
    provideByProps(props: string[], value: unknown) {
        provided.push({ kind: "props", keys: props, value });
    },
    provideStore(name: string, value: unknown) {
        provided.push({ kind: "store", keys: [name], value });
    },
    reset() {
        provided.length = 0;
    }
};
