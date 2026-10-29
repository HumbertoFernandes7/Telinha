/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { stopStreaming } from "@plugins/telinha/actions";
import { useTelinhaState } from "@plugins/telinha/store";
import type { IdentityAlert, RemotePeer } from "@plugins/telinha/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal } from "@webpack/common";

import { Avatar } from "./Avatar";
import { cl, currentUserId, displayName, identityAlertText, inVoiceChannel, peerName, runAction, streamSummary, watchersLabel } from "./common";
import { WarningIcon } from "./icons";
import { openSourcePicker } from "./SourcePickerModal";
import { openViewersModal } from "./ViewersModal";
import { openViewer } from "./viewerWindows";

function StreamerRow({ peer, alert, watching, onWatch }: { peer: RemotePeer; alert: IdentityAlert | undefined; watching: boolean; onWatch(): void; }) {
    return (
        <div className={cl("streamer")}>
            <Avatar userId={peer.discordUserId} />
            <div className={cl("streamer-info")}>
                <span className={cl("streamer-name")}>{peerName(peer)}</span>
                <span className={cl("streamer-meta")}>
                    {streamSummary(peer.stream)}
                    {!peer.admitted && " · fora do seu canal de voz"}
                </span>
                {peer.duplicateIdentity && (
                    <span className={cl("viewer-warning")}>
                        <WarningIcon size={12} /> {alert ? identityAlertText(alert) : "Outra conexão diz ser essa pessoa — uma pode ser falsa"}
                    </span>
                )}
            </div>
            <Button size="small" variant={watching ? "secondary" : "primary"} onClick={onWatch}>
                {watching ? "Abrir janela" : "Assistir"}
            </Button>
        </div>
    );
}

function StreamersModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const state = useTelinhaState();
    const streamers = state.peers.filter(p => p.streaming);
    const alerts = state.identityAlerts ?? [];
    const me = currentUserId();

    let empty: string | null = null;
    if (!streamers.length && !state.local) {
        empty = state.inRoom || inVoiceChannel()
            ? "Ninguém está transmitindo pelo Telinha nesta call agora."
            : "Entre num canal de voz para ver quem está transmitindo pelo Telinha.";
    }

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Quem está transmitindo"
            subtitle="Transmissões pelo Telinha na sua call de voz. Cada uma abre numa janela própria."
            actions={[{ text: "Fechar", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div className={cl("streamers")}>
                {alerts.map(a => (
                    <div key={a.discordUserId + (a.self ? ":self" : "")} className={cl("viewer-alert")} role="status">
                        <WarningIcon size={16} />
                        <span>{identityAlertText(a)}.</span>
                    </div>
                ))}
                {state.local && (
                    <div className={cl("streamer")}>
                        <Avatar userId={me} />
                        <div className={cl("streamer-info")}>
                            <span className={cl("streamer-name")}>{displayName(me, "Você")} (você)</span>
                            <span className={cl("streamer-meta")}>
                                {state.local.source.kind === "screen" ? "Tela inteira" : `Janela: ${state.local.source.name}`} · {watchersLabel(state.local.viewers.length)}
                            </span>
                        </div>
                        <div className={cl("streamer-actions")}>
                            <Button
                                size="small"
                                variant="secondary"
                                onClick={() => {
                                    modalProps.onClose();
                                    openViewersModal();
                                }}
                            >
                                Quem assiste
                            </Button>
                            <Button
                                size="small"
                                variant="secondary"
                                onClick={() => {
                                    modalProps.onClose();
                                    openSourcePicker();
                                }}
                            >
                                Trocar
                            </Button>
                            <Button size="small" variant="dangerPrimary" onClick={() => runAction("stopStreaming", () => stopStreaming())}>
                                Parar
                            </Button>
                        </div>
                    </div>
                )}
                {streamers.map(peer => (
                    <StreamerRow
                        key={peer.peerId}
                        peer={peer}
                        alert={alerts.find(a => !a.self && a.peerIds.includes(peer.peerId))}
                        watching={!!state.viewing[peer.peerId]}
                        onWatch={() => {
                            openViewer(peer.peerId);
                            modalProps.onClose();
                        }}
                    />
                ))}
                {empty && <Paragraph className={cl("empty")}>{empty}</Paragraph>}
            </div>
        </Modal>
    );
}

export function openStreamersModal() {
    openModal(props => (
        <ErrorBoundary>
            <StreamersModal modalProps={props} />
        </ErrorBoundary>
    ));
}
