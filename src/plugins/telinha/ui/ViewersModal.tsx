/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Quem está assistindo", opened from the voice bar's "Ao vivo · N assistindo" (and the toolbox). While streaming it
// lists, for each person receiving the stream: Discord avatar/name (resolved from the ANNOUNCED Discord id through
// UserStore), whether that id is in your voice channel right now, the connection type, and "Expulsar". It also shows
// requests waiting for approval (approveViewers), suspicious identities (two connections claiming the same person,
// or someone claiming to be you) and who you kicked/declined, with "Liberar".

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { approveViewer, declineViewer, getConnectionInfo, kickViewer, unblockViewer } from "@plugins/telinha/actions";
import { useTelinhaState } from "@plugins/telinha/store";
import type { PeerId, PendingViewer, RemotePeer } from "@plugins/telinha/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, showToast, useEffect, UserStore, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { Avatar } from "./Avatar";
import { cl, displayName, findPeer, identityAlertText, peerName, runAction, watchersLabel } from "./common";
import { WarningIcon } from "./icons";
import { openSourcePicker } from "./SourcePickerModal";

const CONNECTION_REFRESH_MS = 3000;

/** Connection type per peer, refreshed while the modal is open */
function useConnectionInfo(peerIds: PeerId[]): Record<PeerId, string | null> {
    const [info, setInfo] = useState<Record<PeerId, string | null>>({});
    const key = peerIds.join(",");
    useEffect(() => {
        if (!peerIds.length) return;
        let alive = true;
        const refresh = () => {
            Promise.all(peerIds.map(async id => [id, await getConnectionInfo(id)] as const))
                .then(entries => {
                    if (alive) setInfo(Object.fromEntries(entries));
                })
                .catch(() => { });
        };
        refresh();
        const timer = setInterval(refresh, CONNECTION_REFRESH_MS);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [key]);
    return info;
}

/** Re-renders every second while `active` (approval countdown) */
function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

/** The announced name differs from the Discord account's names: worth showing (a fake may pick another name) */
function announcedNameHint(peer: RemotePeer): string | null {
    const user = UserStore.getUser(peer.discordUserId);
    if (!user) return `Conta do Discord não encontrada (id ${peer.discordUserId})`;
    const names = [user.username, user.globalName].filter(Boolean).map(n => n!.toLowerCase());
    return names.includes(peer.username.toLowerCase()) ? null : `diz se chamar "${peer.username}"`;
}

export function kickWithToast(peerId: PeerId, name: string) {
    runAction("kickViewer", () => {
        if (kickViewer(peerId)) showToast({ text: `${name} foi removido da sua transmissão`, variant: "success" });
        else showToast({ text: `Telinha: ${name} não está mais na call`, variant: "default" });
    });
}

export function approveWithToast(peerId: PeerId, name: string) {
    runAction("approveViewer", () => {
        if (!approveViewer(peerId)) showToast({ text: `Telinha: o pedido de ${name} já expirou`, variant: "default" });
    });
}

export function declineWithToast(peerId: PeerId, name: string) {
    runAction("declineViewer", () => {
        if (declineViewer(peerId)) showToast({ text: `${name} não vai assistir esta transmissão`, variant: "success" });
        else showToast({ text: `Telinha: o pedido de ${name} já expirou`, variant: "default" });
    });
}

function Row({ userId, name, meta, warning, actions }: { userId: string | undefined; name: string; meta: ReactNode; warning?: string | null; actions?: ReactNode; }) {
    return (
        <div className={cl("streamer")}>
            <Avatar userId={userId} />
            <div className={cl("streamer-info")}>
                <span className={cl("streamer-name")}>{name}</span>
                <span className={cl("streamer-meta")}>{meta}</span>
                {warning && (
                    <span className={cl("viewer-warning")} title={warning}>
                        <WarningIcon size={12} /> {warning}
                    </span>
                )}
            </div>
            {actions && <div className={cl("streamer-actions")}>{actions}</div>}
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode; }) {
    return (
        <div className={cl("viewers-section")}>
            <span className={cl("viewers-section-title")}>{title}</span>
            {children}
        </div>
    );
}

function PendingRow({ pending, now }: { pending: PendingViewer; now: number; }) {
    const name = displayName(pending.discordUserId, pending.username);
    const secs = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));
    return (
        <Row
            userId={pending.discordUserId}
            name={name}
            meta={`Quer assistir · recusado sozinho em ${secs} s`}
            actions={<>
                <Button size="small" variant="positive" onClick={() => approveWithToast(pending.peerId, name)}>Permitir</Button>
                <Button size="small" variant="secondary" onClick={() => declineWithToast(pending.peerId, name)}>Recusar</Button>
            </>}
        />
    );
}

function ViewersModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const state = useTelinhaState();
    const { local } = state;
    const viewers = local?.viewers ?? [];
    const pending = local?.pendingViewers ?? [];
    const alerts = state.identityAlerts ?? [];
    const blocked = state.blocked ?? [];
    const suspicious = state.peers.filter(p => p.duplicateIdentity && !viewers.includes(p.peerId));
    const connection = useConnectionInfo([...viewers, ...suspicious.map(p => p.peerId)]);
    const now = useNow(pending.length > 0);

    const viewerRow = (peerId: PeerId) => {
        const peer = findPeer(state, peerId);
        const name = peerName(peer);
        const meta = [
            peer ? (peer.inVoice ? "Na sua call de voz" : "Fora da sua call de voz") : "Saiu da sala",
            connection[peerId] ?? "Conexão: verificando…"
        ];
        const hint = peer && announcedNameHint(peer);
        if (hint) meta.push(hint);
        const alert = peer?.duplicateIdentity ? alerts.find(a => !a.self && a.peerIds.includes(peerId)) : undefined;
        return (
            <Row
                key={peerId}
                userId={peer?.discordUserId}
                name={name}
                meta={meta.join(" · ")}
                warning={alert ? identityAlertText(alert) : null}
                actions={<Button size="small" variant="dangerPrimary" onClick={() => kickWithToast(peerId, name)}>Expulsar</Button>}
            />
        );
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Quem está assistindo"
            subtitle={local
                ? `Sua transmissão pelo Telinha: ${watchersLabel(viewers.length)}. "Expulsar" para de enviar na hora e ignora novos pedidos dessa pessoa até você sair da call.`
                : "Você não está transmitindo pelo Telinha agora."}
            actions={[
                ...(local ? [{
                    text: "Trocar tela ou janela",
                    variant: "secondary" as const,
                    onClick: () => {
                        modalProps.onClose();
                        openSourcePicker();
                    }
                }] : []),
                { text: "Fechar", variant: "secondary", onClick: modalProps.onClose }
            ]}
        >
            <div className={cl("streamers")}>
                {alerts.map(a => (
                    <div key={a.discordUserId + (a.self ? ":self" : "")} className={cl("viewer-alert")} role="status">
                        <WarningIcon size={16} />
                        <span>
                            {identityAlertText(a)}.{" "}
                            {a.self
                                ? "Essa conexão nunca vê sua presença nem recebe sua transmissão."
                                : "Nenhuma delas recebe sua transmissão enquanto isso durar; quando uma sair, a outra precisa pedir de novo."}
                        </span>
                    </div>
                ))}

                {pending.length > 0 && (
                    <Section title="Pedindo para assistir">
                        {pending.map(p => <PendingRow key={p.peerId} pending={p} now={now} />)}
                    </Section>
                )}

                {local && (
                    <Section title="Assistindo agora">
                        {viewers.length
                            ? viewers.map(viewerRow)
                            : <Paragraph className={cl("empty")}>Ninguém abriu a sua transmissão ainda.</Paragraph>}
                    </Section>
                )}

                {suspicious.length > 0 && (
                    <Section title="Conexões suspeitas (não recebem sua transmissão)">
                        {suspicious.map(p => {
                            const name = peerName(p);
                            const alert = alerts.find(a => !a.self && a.peerIds.includes(p.peerId));
                            return (
                                <Row
                                    key={p.peerId}
                                    userId={p.discordUserId}
                                    name={name}
                                    meta={[p.inVoice ? "Na sua call de voz" : "Fora da sua call de voz", connection[p.peerId] ?? "Conexão: verificando…"].join(" · ")}
                                    warning={alert ? identityAlertText(alert) : "Outra conexão diz ser essa pessoa — uma pode ser falsa"}
                                    actions={<Button size="small" variant="dangerPrimary" onClick={() => kickWithToast(p.peerId, name)}>Expulsar</Button>}
                                />
                            );
                        })}
                    </Section>
                )}

                {blocked.length > 0 && (
                    <Section title="Removidos">
                        {blocked.map(b => (
                            <Row
                                key={b.discordUserId}
                                userId={b.discordUserId}
                                name={displayName(b.discordUserId, b.username)}
                                meta={b.reason === "kicked" ? "Expulso até você sair da call" : "Recusado até esta transmissão acabar"}
                                actions={
                                    <Button size="small" variant="secondary" onClick={() => runAction("unblockViewer", () => unblockViewer(b.discordUserId))}>
                                        Liberar
                                    </Button>
                                }
                            />
                        ))}
                    </Section>
                )}
            </div>
        </Modal>
    );
}

export function openViewersModal() {
    openModal(props => (
        <ErrorBoundary>
            <ViewersModal modalProps={props} />
        </ErrorBoundary>
    ));
}
