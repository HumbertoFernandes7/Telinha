/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "PEERLIVE" pill next to a user in the voice channel member list (left sidebar). Teal, with the broadcast icon,
// reading PEERLIVE: it must not be mistaken for Discord's own red "AO VIVO" tag (both can show at once if a friend
// also uses Go Live), and Discord already uses blurple for its app/bot tags.

import ErrorBoundary from "@components/ErrorBoundary";
import { findPeerByDiscordId } from "@plugins/peerLive/actions";
import { usePeerLiveState } from "@plugins/peerLive/store";
import { Tooltip } from "@webpack/common";
import type { MouseEvent } from "react";

import { cl, currentUserId, watchersLabel } from "./common";
import { BroadcastIcon } from "./icons";
import { openViewer } from "./viewerWindows";

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

function VoiceUserTagInner({ userId }: { userId: string | undefined; }) {
    const state = usePeerLiveState();
    if (!userId) return null;

    if (userId === currentUserId()) {
        if (!state.local) return null;
        return <Pill tooltip={`Você está transmitindo pelo PeerLive — ${watchersLabel(state.local.viewers.length)}`} />;
    }

    const peer = findPeerByDiscordId(userId);
    if (!peer?.streaming) return null;

    return (
        <Pill
            tooltip={state.viewing[peer.peerId] ? "Transmitindo pelo PeerLive — clique para abrir a janela" : "Transmitindo pelo PeerLive — clique para assistir"}
            onClick={() => openViewer(peer.peerId)}
        />
    );
}

export const VoiceUserTag = ErrorBoundary.wrap(VoiceUserTagInner, { noop: true, displayName: "PeerLiveVoiceUserTag" });
