/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Our two Discord patches don't rewrite the props or children of the element they decorate: they only swap the jsx
// function (`(0,r.jsx)(X,{...})` → `(0,$self.panelJsx.jsx)(X,{...})`) for one of these shims, which renders the
// original element unchanged plus a sibling. Keeping the call's arguments untouched is what lets other plugins'
// patches on the same call sites (SpotifyControls on the account panel, RoleColorEverywhere on voice user names)
// still match, whichever plugin is patched first.

import { React } from "@webpack/common";
import type { ElementType, Key, ReactElement } from "react";

import { VoiceBar } from "./VoiceBar";
import { VoiceUserTag } from "./VoiceUserTag";

type JsxFn = (type: ElementType, props: Record<string, unknown>, key?: Key) => ReactElement;

interface JsxRuntime {
    jsx: JsxFn;
    jsxs: JsxFn;
}

function withSibling(type: ElementType, props: Record<string, unknown>, key: Key | undefined, sibling: ReactElement, siblingFirst: boolean) {
    const original = React.createElement(type, props);
    return React.createElement(
        React.Fragment,
        key == null ? null : { key },
        ...(siblingFirst ? [sibling, original] : [original, sibling])
    );
}

/** Account panel: renders the PeerLive bar right above it (i.e. right under the voice connection panel) */
export const panelJsx: JsxRuntime = {
    jsx: (type, props, key) => withSibling(type, props, key, React.createElement(VoiceBar), true),
    jsxs: (type, props, key) => withSibling(type, props, key, React.createElement(VoiceBar), true)
};

const voiceNameCache = new Map<string, JsxRuntime>();

/** Voice channel user row: renders the PeerLive tag right after the user's name */
export function voiceNameJsx(user: unknown): JsxRuntime {
    const id = (user as { id?: unknown; } | null | undefined)?.id;
    const userId = typeof id === "string" ? id : "";

    let runtime = voiceNameCache.get(userId);
    if (!runtime) {
        const fn: JsxFn = (type, props, key) => withSibling(type, props, key, React.createElement(VoiceUserTag, { userId: userId || undefined }), false);
        runtime = { jsx: fn, jsxs: fn };
        if (voiceNameCache.size > 500) voiceNameCache.clear();
        voiceNameCache.set(userId, runtime);
    }
    return runtime;
}
