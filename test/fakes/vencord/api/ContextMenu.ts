/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@api/ContextMenu`. The plugin only uses the NavContextMenuPatchCallback type (index.tsx hands the patch to
// Vencord through `contextMenus`); a test calls the patch directly with a children array and renders the result.

import type { ReactElement } from "react";

export type NavContextMenuPatchCallback = (children: Array<ReactElement<any> | null>, ...args: Array<any>) => void;

export const navPatches = new Map<string, Set<NavContextMenuPatchCallback>>();

export function addContextMenuPatch(navId: string | string[], patch: NavContextMenuPatchCallback) {
    for (const id of Array.isArray(navId) ? navId : [navId]) {
        let set = navPatches.get(id);
        if (!set) navPatches.set(id, set = new Set());
        set.add(patch);
    }
}

export function removeContextMenuPatch(navId: string | string[], patch: NavContextMenuPatchCallback) {
    return (Array.isArray(navId) ? navId : [navId]).map(id => navPatches.get(id)?.delete(patch) ?? false);
}

export function resetContextMenus() {
    navPatches.clear();
}
