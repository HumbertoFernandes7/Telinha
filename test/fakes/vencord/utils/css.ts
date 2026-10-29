/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@utils/css`: classNameFactory with the same behaviour as Vencord's (strings, arrays and {name: bool}).

export type ClassNameFactoryArg = string | string[] | Record<string, unknown> | false | null | undefined | 0 | "";

export const classNameFactory = (prefix = "") => (...args: ClassNameFactoryArg[]) => {
    const names = new Set<string>();
    for (const arg of args) {
        if (arg && typeof arg === "string") names.add(arg);
        else if (Array.isArray(arg)) arg.forEach(n => names.add(n));
        else if (arg && typeof arg === "object") Object.entries(arg).forEach(([n, v]) => v && names.add(n));
    }
    return Array.from(names, n => prefix + n).join(" ");
};

export const classNameToSelector = (name: string, prefix = "") => name.split(" ").map(n => `.${prefix}${n}`).join("");
