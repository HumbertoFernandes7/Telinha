/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Our two Discord patches don't rewrite the props or children of the element they decorate: they only swap the jsx
// function (`(0,r.jsx)(X,{...})` → `(0,$self.panelJsx.jsx)(X,{...})`) for one of these shims, which renders the
// original element unchanged plus a sibling. Keeping the call's arguments untouched is what lets other plugins'
// patches on the same modules (SpotifyControls on the account panel, RoleColorEverywhere on voice user names)
// still match, whichever plugin is patched first.

import { React } from "@webpack/common";
import type { ElementType, Key, ReactElement } from "react";

import { VoiceBar } from "./VoiceBar";
import { noteVoiceRowRender, VoiceUserTag } from "./VoiceUserTag";

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

function voiceUserIcons(type: ElementType, props: Record<string, unknown>, key?: Key) {
    // VoiceUserIcons gets the whole row's props: user (Discord User), collapsed (avatars-only list), ...
    const id = (props?.user as { id?: unknown; } | null | undefined)?.id;
    const userId = typeof id === "string" && id ? id : undefined;
    noteVoiceRowRender(userId);
    if (!userId) return React.createElement(type, key == null ? props : { ...props, key });

    const tag = React.createElement(VoiceUserTag, { userId, collapsed: props.collapsed === true });
    return withSibling(type, props, key, tag, true);
}

/** Voice channel user row: renders the PeerLive tag right before the row's mute/deafen/"AO VIVO" icons */
export const voiceUserIconsJsx: JsxRuntime = {
    jsx: voiceUserIcons,
    jsxs: voiceUserIcons
};
