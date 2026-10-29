/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The Telinha bar in the bottom-left panels, right under Discord's voice connection panel (where its camera /
// screen-share buttons are) and above the account panel. Only shown while in a voice channel or streaming.
//
//   [ Transmitir com Telinha ]             idle
//   ● Ao vivo · 2 assistindo                streaming (click: who is watching → kick / switch source)
//   🔒 Com senha · Mudar  Copiar senha      "Quem pode assistir" of the live stream (click: change it)
//   Ana quer assistir  Permitir  Recusar    request waiting for approval ("Só quem eu aprovar", or unverified)
//   ⚠ Duas conexões dizem ser Ana…          suspicious identity (click: details)
//   720p60 · menor: processador             auto quality (current level; reason when lowered, full text in tooltip)
//   ⚠ <capture warning>                     black image / frozen window (clears itself)
//   [ Parar transmissão ]
//   ◉ Ana está transmitindo · Assistir      someone else streams (1 → opens it, 2+ → list)
//   Autorize o Telinha no Discord…  Autorizar ×   Discord identity not authorized (only with a Client ID)
//   ⚠ <last error>  ×                       core reported an error

import ErrorBoundary from "@components/ErrorBoundary";
import { clearLastError, stopStreaming } from "@plugins/telinha/actions";
import { ACCESS_LABEL } from "@plugins/telinha/core/access";
import { useTelinhaState } from "@plugins/telinha/store";
import type { QualityReason } from "@plugins/telinha/types";
import { SelectedChannelStore, Tooltip, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { copyStreamPassword, openAccessModal } from "./AccessPicker";
import { accessBadge, cl, displayName, findPeer, identityAlertBlocksAll, identityAlertText, peerName, runAction, watchersLabel } from "./common";
import { BroadcastIcon, CloseIcon, EyeIcon, StopIcon, WarningIcon } from "./icons";
import { IdentityBadge, IdentityBanner } from "./IdentityUI";
import { openSourcePicker } from "./SourcePickerModal";
import { openStreamersModal } from "./StreamersModal";
import { approveWithToast, declineWithToast, openViewersModal } from "./ViewersModal";
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
                title={single
                    ? `Assistir pelo Telinha${accessBadge(single.stream?.access) ? ` (${accessBadge(single.stream?.access)})` : ""}`
                    : streamers.map(p => `${peerName(p)}${accessBadge(p.stream?.access) ? ` (${accessBadge(p.stream?.access)})` : ""}`).join(", ")}
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
                                openViewersModal();
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

            {local && (
                <div className={cl("bar-access")}>
                    <button
                        className={cl("bar-row", "bar-access-row")}
                        title={`Quem pode assistir: ${ACCESS_LABEL[local.access]}. Clique para mudar (vale para os próximos pedidos; quem já assiste continua).`}
                        onClick={openAccessModal}
                    >
                        <span className={cl("bar-row-text")}>
                            {accessBadge(local.access)?.split(" ")[0] ?? "👥"} {ACCESS_LABEL[local.access]}
                        </span>
                        <span className={cl("bar-row-action")}>Mudar</span>
                    </button>
                    {local.access === "password" && (
                        <button className={cl("bar-request-btn")} title="Copiar a senha desta transmissão" onClick={copyStreamPassword}>Copiar senha</button>
                    )}
                </div>
            )}

            {local?.pendingViewers?.map(p => {
                const name = displayName(p.discordUserId, p.username);
                const unverified = p.identity === "unverified" ? " Não verificado: não provou ser essa conta do Discord." : "";
                return (
                    <div key={p.peerId} className={cl("bar-request")} role="alert" title={`${name} quer assistir sua transmissão (recusado sozinho em 60 s).${unverified}`}>
                        <span className={cl("bar-row-text")}>{name} quer assistir</span>
                        <IdentityBadge identity={p.identity} compact />
                        <button className={cl("bar-request-btn", "bar-request-allow")} onClick={() => approveWithToast(p.peerId, name)}>Permitir</button>
                        <button className={cl("bar-request-btn")} onClick={() => declineWithToast(p.peerId, name)}>Recusar</button>
                    </div>
                );
            })}

            {state.identityAlerts?.map(a => {
                const text = `${identityAlertText(a)}${local && identityAlertBlocksAll(a) ? ". Nenhuma recebe sua transmissão." : ""}`;
                return (
                    <button
                        key={a.discordUserId + (a.self ? ":self" : a.kind ? `:${a.kind}` : "")}
                        className={cl("bar-row", "bar-error", "bar-wrap")}
                        role="alert"
                        title={text}
                        onClick={() => local ? openViewersModal() : openStreamersModal()}
                    >
                        <WarningIcon size={14} className={cl("bar-row-icon")} />
                        <span className={cl("bar-row-text")}>{text}</span>
                    </button>
                );
            })}

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

            <IdentityBanner />

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
