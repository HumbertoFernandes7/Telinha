/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

export type PeerLiveNative = PluginNative<typeof import("@plugins/peerLive/native")>;

/** Funcoes do native.ts (processo main). Null fora do Discord desktop ou se o main nao carregou o modulo. */
export function getNativeOrNull(): PeerLiveNative | null {
    return (VencordNative?.pluginHelpers?.PeerLive as PeerLiveNative | undefined) ?? null;
}

export function getNative(): PeerLiveNative {
    const native = getNativeOrNull();
    if (!native)
        throw new Error("A parte nativa do PeerLive não está carregada. Use o Discord desktop e feche o Discord por completo (inclusive da bandeja) antes de abrir de novo.");
    return native;
}
