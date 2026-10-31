/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "TELINHA" pill next to a user in the voice channel member list (left sidebar). Teal, with the broadcast icon,
// reading TELINHA: it must not be mistaken for Discord's own red "AO VIVO" tag (both can show at once if a friend
// also uses Go Live), and Discord already uses blurple for its app/bot tags.
// A friend's tag watches inside Discord, on the call screen (callView/watchInCall.ts), like the tile's "Assistir".

import ErrorBoundary from "@components/ErrorBoundary";
import { useTelinhaState } from "@plugins/telinha/store";
import { Tooltip } from "@webpack/common";
import type { MouseEvent } from "react";

import { watchInCall } from "./callView/watchInCall";
import { accessBadge, cl, currentUserId, watchersLabel } from "./common";
import { BroadcastIcon } from "./icons";
import { identityHint } from "./IdentityUI";

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
    return `etiqueta TELINHA (lista de voz): linhas desenhadas ${stats.rowCalls}x (sem usuário: ${stats.rowCallsWithoutUser}), última ${at(stats.lastRowAt)}; `
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
                        // the 2nd click of a double click is the same gesture: one action only
                        if (e.detail > 1) return;
                        onClick?.();
                    }}
                    onDoubleClick={(e: MouseEvent) => {
                        // nor Discord's own double click on the row
                        e.stopPropagation();
                        e.preventDefault();
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
                    TELINHA
                </span>
            )}
        </Tooltip>
    );
}

function VoiceUserTagInner({ userId, collapsed }: { userId: string; collapsed?: boolean; }) {
    const state = useTelinhaState();
    // Collapsed voice lists only show overlapping avatars (Discord hides names and icons there too)
    if (collapsed) return null;

    // We are never in state.peers: our own tag comes from the local stream
    if (userId === currentUserId()) {
        if (!state.local) return null;
        noteTagRender(true);
        return <Pill tooltip={`Você está transmitindo pelo Telinha — ${watchersLabel(state.local.viewers.length)}`} />;
    }

    // more than one connection with this id: the one that proved the Discord identity wins (never a fake: those
    // aren't in state.peers)
    const peers = state.peers.filter(p => p.discordUserId === userId);
    const peer = peers.find(p => p.identity === "verified" && p.streaming) ?? peers[0];
    if (!peer?.streaming) return null;

    noteTagRender(false);
    const hint = identityHint(peer.identity);
    const badge = accessBadge(peer.stream?.access);
    const what = `Transmitindo pelo Telinha${hint ? ` (${hint})` : ""}${badge ? ` · ${badge}` : ""}`;
    return (
        <Pill
            tooltip={state.viewing[peer.peerId] ? `${what} — clique para ver na tela da call` : `${what} — clique para assistir aqui no Discord, na tela da call`}
            onClick={() => watchInCall(peer.peerId)}
        />
    );
}

export const VoiceUserTag = ErrorBoundary.wrap(VoiceUserTagInner, { noop: true, displayName: "TelinhaVoiceUserTag" });
