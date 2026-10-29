/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The Telinha bar in the bottom-left panels, right under Discord's voice connection panel (where its camera /
// screen-share buttons are) and above the account panel. Only shown while in a voice channel or streaming.
//
//   [ Transmitir com Telinha ]             idle
//   ● Ao vivo · 2 assistindo                streaming (click: list / switch source)
//   720p60 · menor: processador             auto quality (current level; reason when lowered, full text in tooltip)
//   ⚠ <capture warning>                     black image / frozen window (clears itself)
//   [ Parar transmissão ]
//   ◉ Ana está transmitindo · Assistir      someone else streams (1 → opens it, 2+ → list)
//   ⚠ <last error>  ×                       core reported an error

import ErrorBoundary from "@components/ErrorBoundary";
import { clearLastError, stopStreaming } from "@plugins/telinha/actions";
import { useTelinhaState } from "@plugins/telinha/store";
import type { QualityReason } from "@plugins/telinha/types";
import { SelectedChannelStore, Tooltip, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { cl, findPeer, peerName, runAction, watchersLabel } from "./common";
import { BroadcastIcon, CloseIcon, EyeIcon, StopIcon, WarningIcon } from "./icons";
import { openSourcePicker } from "./SourcePickerModal";
import { openStreamersModal } from "./StreamersModal";
import { openViewer } from "./viewerWindows";

const REASON_SHORT: Record<QualityReason, string> = {
    cpu: "processador",
    upload: "seu upload",
    bandwidth: "conexão de quem assiste"
};

function VoiceBarInner() {
    const inVoice = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() != null);
    const state = useTelinhaState();

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
                title={single ? "Assistir pelo Telinha" : streamers.map(peerName).join(", ")}
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

            {local?.autoQuality && (
                <div
                    className={cl("bar-info", local.autoQuality.reason && "bar-info-lowered")}
                    title={local.autoQuality.reasonText ?? "Qualidade automática: no máximo escolhido"}
                >
                    <span className={cl("bar-row-text")}>
                        {local.autoQuality.current}
                        {local.autoQuality.reason && ` · menor: ${REASON_SHORT[local.autoQuality.reason]}`}
                    </span>
                </div>
            )}

            {local?.captureWarning && (
                <div className={cl("bar-error", "bar-wrap")} role="status" title={local.captureWarning}>
                    <WarningIcon size={14} className={cl("bar-row-icon")} />
                    <span className={cl("bar-row-text")}>{local.captureWarning}</span>
                </div>
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
                        <span className={cl("bar-label")}>Transmitir com Telinha</span>
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

export const VoiceBar = ErrorBoundary.wrap(VoiceBarInner, { noop: true, displayName: "TelinhaVoiceBar" });
