/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "PEERLIVE" pill next to a user in the voice channel member list (left sidebar). Teal, with the broadcast icon,
// reading PEERLIVE: it must not be mistaken for Discord's own red "AO VIVO" tag (both can show at once if a friend
// also uses Go Live), and Discord already uses blurple for its app/bot tags.

import ErrorBoundary from "@components/ErrorBoundary";
import { usePeerLiveState } from "@plugins/peerLive/store";
import { Tooltip } from "@webpack/common";
import type { MouseEvent } from "react";

import { cl, currentUserId, watchersLabel } from "./common";
import { BroadcastIcon } from "./icons";
import { openViewer } from "./viewerWindows";

// #region Diagnostics: is the voice row patch running, and did we ever draw a tag?

const stats = {
    rowCalls: 0,
    rowCallsWithoutUser: 0,
    ownTags: 0,
    peerTags: 0,
    lastRowAt: 0,
    lastTagAt: 0
};

/** Called by the patched voice row (jsxShims) on every render of a voice channel user row */
export function noteVoiceRowRender(userId: string | undefined) {
    stats.rowCalls++;
    stats.lastRowAt = Date.now();
    if (!userId) stats.rowCallsWithoutUser++;
}

function noteTagRender(own: boolean) {
    if (own) stats.ownTags++;
    else stats.peerTags++;
    stats.lastTagAt = Date.now();
}

/** One line for the "Copiar diagnóstico" text. rowCalls 0 after opening a voice channel = the patch didn't apply */
export function formatVoiceTagDiagnostics(): string {
    const at = (t: number) => t ? new Date(t).toISOString().slice(11, 23) : "nunca";
    return `etiqueta PEERLIVE (lista de voz): linhas desenhadas ${stats.rowCalls}x (sem usuário: ${stats.rowCallsWithoutUser}), última ${at(stats.lastRowAt)}; `
        + `etiqueta desenhada ${stats.ownTags}x a sua, ${stats.peerTags}x de amigos, última ${at(stats.lastTagAt)}`;
}

// #endregion

function Pill({ tooltip, onClick }: { tooltip: string; onClick?(): void; }) {
    return (
        <Tooltip text={tooltip}>
            {props => (
                <span
                    {...props}
                    role={onClick ? "button" : undefined}
                    tabIndex={onClick ? 0 : undefined}
                    aria-label={tooltip}
                    className={cl("tag", !onClick && "tag-self")}
                    onClick={(e: MouseEvent) => {
                        // The row itself opens the user popout / joins the channel on click
                        e.stopPropagation();
                        e.preventDefault();
                        props.onClick();
                        onClick?.();
                    }}
                    onKeyDown={e => {
                        if (onClick && (e.key === "Enter" || e.key === " ")) {
                            e.stopPropagation();
                            e.preventDefault();
                            onClick();
                        }
                    }}
                >
                    <BroadcastIcon size={10} />
                    PEERLIVE
                </span>
            )}
        </Tooltip>
    );
}

function VoiceUserTagInner({ userId, collapsed }: { userId: string; collapsed?: boolean; }) {
    const state = usePeerLiveState();
    // Collapsed voice lists only show overlapping avatars (Discord hides names and icons there too)
    if (collapsed) return null;

    // We are never in state.peers: our own tag comes from the local stream
    if (userId === currentUserId()) {
        if (!state.local) return null;
        noteTagRender(true);
        return <Pill tooltip={`Você está transmitindo pelo PeerLive — ${watchersLabel(state.local.viewers.length)}`} />;
    }

    const peer = state.peers.find(p => p.discordUserId === userId);
    if (!peer?.streaming) return null;

    noteTagRender(false);
    return (
        <Pill
            tooltip={state.viewing[peer.peerId] ? "Transmitindo pelo PeerLive — clique para abrir a janela" : "Transmitindo pelo PeerLive — clique para assistir"}
            onClick={() => openViewer(peer.peerId)}
        />
    );
}

export const VoiceUserTag = ErrorBoundary.wrap(VoiceUserTagInner, { noop: true, displayName: "PeerLiveVoiceUserTag" });
