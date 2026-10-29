/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { stopStreaming } from "@plugins/peerLive/actions";
import { usePeerLiveState } from "@plugins/peerLive/store";
import type { RemotePeer } from "@plugins/peerLive/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal } from "@webpack/common";

import { avatarUrl, cl, currentUserId, displayName, inVoiceChannel, peerName, runAction, streamSummary, watchersLabel } from "./common";
import { BroadcastIcon } from "./icons";
import { openSourcePicker } from "./SourcePickerModal";
import { openViewer } from "./viewerWindows";

function Avatar({ userId }: { userId: string | undefined; }) {
    const url = avatarUrl(userId, 64);
    return url
        ? <img className={cl("avatar")} src={url} alt="" />
        : <span className={cl("avatar", "avatar-empty")}><BroadcastIcon size={18} /></span>;
}

function StreamerRow({ peer, watching, onWatch }: { peer: RemotePeer; watching: boolean; onWatch(): void; }) {
    return (
        <div className={cl("streamer")}>
            <Avatar userId={peer.discordUserId} />
            <div className={cl("streamer-info")}>
                <span className={cl("streamer-name")}>{peerName(peer)}</span>
                <span className={cl("streamer-meta")}>
                    {streamSummary(peer.stream)}
                    {!peer.admitted && " · fora do seu canal de voz"}
                </span>
            </div>
            <Button size="small" variant={watching ? "secondary" : "primary"} onClick={onWatch}>
                {watching ? "Abrir janela" : "Assistir"}
            </Button>
        </div>
    );
}

function StreamersModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const state = usePeerLiveState();
    const streamers = state.peers.filter(p => p.streaming);
    const me = currentUserId();

    let empty: string | null = null;
    if (!streamers.length && !state.local) {
        empty = state.inRoom || inVoiceChannel()
            ? "Ninguém está transmitindo pelo PeerLive nesta call agora."
            : "Entre num canal de voz para ver quem está transmitindo pelo PeerLive.";
    }

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Quem está transmitindo"
            subtitle="Transmissões pelo PeerLive na sua call de voz. Cada uma abre numa janela própria."
            actions={[{ text: "Fechar", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div className={cl("streamers")}>
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
