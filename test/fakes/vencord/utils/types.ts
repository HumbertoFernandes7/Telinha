/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@utils/types`: the same runtime values the add-on build inlines (addon/build/build-addon.mjs →
// UTILS_TYPES_SHIM, checked there against .vencord/src/utils/types.ts). Types come from the real file at type-check.

export default function definePlugin<P>(p: P): P {
    return p;
}

export const OptionType = { STRING: 0, NUMBER: 1, BIGINT: 2, BOOLEAN: 3, SELECT: 4, SLIDER: 5, COMPONENT: 6, CUSTOM: 7 } as const;
export const StartAt = { Init: "Init", DOMContentLoaded: "DOMContentLoaded", WebpackReady: "WebpackReady" } as const;
export const ReporterTestable = { None: 2, Start: 4, Patches: 8, FluxEvents: 16 } as const;
