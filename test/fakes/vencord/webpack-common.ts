/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@webpack/common` (tsconfig.test.json maps the import here). React is the real `react` package; stores,
// FluxDispatcher and the Discord components are the fakes in stores.ts and ui.tsx. Tests import the controls from
// "@test/fakes/vencord" (same module instances).

import { createRequire } from "node:module";

import * as React from "react";

export { React };
export const { useState, useEffect, useLayoutEffect, useMemo, useRef, useReducer, useCallback } = React;

const requireLazy = createRequire(__filename);

/**
 * react-dom/client's createRoot, loaded on first use: react-dom decides at load time whether there is a DOM, so it
 * must come after @test/fakes/dom (a test that only imports plugin modules never loads it).
 */
export function createRoot(container: Element | DocumentFragment, options?: unknown) {
    return (requireLazy("react-dom/client") as typeof import("react-dom/client")).createRoot(container, options as any);
}

export {
    ChannelStore, FluxDispatcher, PopoutActions, PopoutWindowStore, RelationshipStore, SelectedChannelStore, UserStore, VoiceStateStore
} from "./stores";
export { closeAllModals, closeModal, Menu, Modal, OAuth2AuthorizeModal, openModal, openModalLazy, Select, showToast, Tooltip } from "./ui";

type AnyStore = { addChangeListener(fn: () => void): void; removeChangeListener(fn: () => void): void; };

/** Discord's useStateFromStores: re-renders when any of `stores` emits a change, returns getter(). */
export function useStateFromStores<T>(stores: AnyStore[], getter: () => T, _deps?: unknown[]): T {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const fn = () => force();
        for (const s of stores) s.addChangeListener(fn);
        return () => {
            for (const s of stores) s.removeChangeListener(fn);
        };
    }, stores);
    return getter();
}
