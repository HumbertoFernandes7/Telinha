/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The PeerLive bar in the bottom-left panels, right under Discord's voice connection panel (where its camera /
// screen-share buttons are) and above the account panel. Only shown while in a voice channel or streaming.
//
//   [ Transmitir com PeerLive ]             idle
//   ● Ao vivo · 2 assistindo                streaming (click: list / switch source)
//   [ Parar transmissão ]
//   ◉ Ana está transmitindo · Assistir      someone else streams (1 → opens it, 2+ → list)
//   ⚠ <last error>  ×                       core reported an error

import ErrorBoundary from "@components/ErrorBoundary";
import { clearLastError, stopStreaming } from "@plugins/peerLive/actions";
import { usePeerLiveState } from "@plugins/peerLive/store";
import { SelectedChannelStore, Tooltip, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { cl, findPeer, peerName, runAction, watchersLabel } from "./common";
import { BroadcastIcon, CloseIcon, EyeIcon, StopIcon, WarningIcon } from "./icons";
import { openSourcePicker } from "./SourcePickerModal";
import { openStreamersModal } from "./StreamersModal";
import { openViewer } from "./viewerWindows";

function VoiceBarInner() {
    const inVoice = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() != null);
    const state = usePeerLiveState();

    if (!inVoice && !state.local) return null;

    const streamers = state.peers.filter(p => p.streaming);
    const { local } = state;

    let streamersRow: ReactNode = null;
    if (streamers.length) {
        const single = streamers.length === 1 ? streamers[0] : null;
        const text = single
            ? `${peerName(single)} está transmitindo`
            : `${streamers.length} transmissões ao vivo`;
        streamersRow = (
            <button
                className={cl("bar-row")}
                title={single ? "Assistir pelo PeerLive" : streamers.map(peerName).join(", ")}
                onClick={() => single ? openViewer(single.peerId) : openStreamersModal()}
            >
                <BroadcastIcon size={14} className={cl("bar-row-icon")} />
                <span className={cl("bar-row-text")}>{text}</span>
                <span className={cl("bar-row-action")}>{single ? (state.viewing[single.peerId] ? "Abrir" : "Assistir") : "Ver"}</span>
            </button>
        );
    }

    return (
        <div className={cl("bar")}>
            {local && (
                <Tooltip text={local.viewers.length ? `Assistindo: ${local.viewers.map(id => peerName(findPeer(state, id))).join(", ")}` : "Ninguém abriu a sua transmissão ainda"}>
                    {props => (
                        <button
                            {...props}
                            className={cl("bar-row", "bar-status")}
                            onClick={() => {
                                props.onClick();
                                openStreamersModal();
                            }}
                        >
                            <span className={cl("bar-live-dot")} />
                            <span className={cl("bar-row-text")}>Ao vivo · {watchersLabel(local.viewers.length)}</span>
                            <EyeIcon size={14} className={cl("bar-row-icon")} />
                            <span className={cl("bar-row-count")}>{local.viewers.length}</span>
                        </button>
                    )}
                </Tooltip>
            )}

            {local
                ? (
                    <button className={cl("bar-main", "bar-main-live")} onClick={() => runAction("stopStreaming", () => stopStreaming())}>
                        <StopIcon size={14} />
                        <span className={cl("bar-label")}>Parar transmissão</span>
                    </button>
                )
                : (
                    <button className={cl("bar-main")} onClick={openSourcePicker}>
                        <BroadcastIcon size={16} />
                        <span className={cl("bar-label")}>Transmitir com PeerLive</span>
                    </button>
                )}

            {streamersRow}

            {state.lastError && (
                <div className={cl("bar-error")} title={state.lastError}>
                    <WarningIcon size={14} className={cl("bar-row-icon")} />
                    <span className={cl("bar-row-text")}>{state.lastError}</span>
                    <button className={cl("bar-error-close")} aria-label="Dispensar aviso" title="Dispensar aviso" onClick={() => runAction("clearLastError", () => clearLastError())}>
                        <CloseIcon size={12} />
                    </button>
                </div>
            )}
        </div>
    );
}

export const VoiceBar = ErrorBoundary.wrap(VoiceBarInner, { noop: true, displayName: "PeerLiveVoiceBar" });
