/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

export type TelinhaNative = PluginNative<typeof import("@plugins/telinha/native")>;

/** Funcoes do native.ts (processo main). Null fora do Discord desktop ou se o main nao carregou o modulo. */
export function getNativeOrNull(): TelinhaNative | null {
    return (VencordNative?.pluginHelpers?.Telinha as TelinhaNative | undefined) ?? null;
}

export function getNative(): TelinhaNative {
    const native = getNativeOrNull();
    if (!native)
        throw new Error("A parte nativa do Telinha não está carregada. Use o Discord desktop e feche o Discord por completo (inclusive da bandeja) antes de abrir de novo.");
    return native;
}
