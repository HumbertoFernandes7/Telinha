/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Vencord toolbox entries (always-available fallback for the voice panel bar) and the user context menu item
// (right-click a friend in the voice channel → watch their Telinha stream).

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { findPeerByDiscordId, stopStreaming } from "@plugins/telinha/actions";
import { getState, useTelinhaState } from "@plugins/telinha/store";
import type { User } from "@vencord/discord-types";
import { Menu, SelectedChannelStore, useStateFromStores } from "@webpack/common";

import { currentUserId, runAction, watchersLabel } from "./common";
import { BroadcastIcon } from "./icons";
import { openSourcePicker } from "./SourcePickerModal";
import { openStreamersModal } from "./StreamersModal";
import { openViewer } from "./viewerWindows";

const MenuBroadcastIcon = () => <BroadcastIcon size={18} />;

/** plugin.toolboxActions: called by VencordToolbox while rendering its menu, so hooks are fine here */
export function renderToolboxActions() {
    const state = useTelinhaState();
    const inVoice = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() != null);
    const streamers = state.peers.filter(p => p.streaming).length;

    const items = state.local
        ? [
            <Menu.MenuItem
                id="vc-telinha-stop"
                key="vc-telinha-stop"
                label={`Parar transmissão (${watchersLabel(state.local.viewers.length)})`}
                action={() => runAction("stopStreaming", () => stopStreaming())}
            />,
            <Menu.MenuItem
                id="vc-telinha-switch"
                key="vc-telinha-switch"
                label="Trocar tela ou janela"
                action={openSourcePicker}
            />
        ]
        : [
            <Menu.MenuItem
                id="vc-telinha-start"
                key="vc-telinha-start"
                label={inVoice ? "Transmitir com Telinha" : "Transmitir com Telinha (entre numa call)"}
                action={openSourcePicker}
            />
        ];

    items.push(
        <Menu.MenuItem
            id="vc-telinha-streamers"
            key="vc-telinha-streamers"
            label={streamers ? `Quem está transmitindo (${streamers})` : "Quem está transmitindo"}
            action={openStreamersModal}
        />
    );
    return items;
}

export const userContextMenuPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    const state = getState();
    if (user.id === currentUserId()) {
        if (!state.local) return;
        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem
                    id="vc-telinha-stop"
                    label="Parar transmissão Telinha"
                    icon={MenuBroadcastIcon}
                    action={() => runAction("stopStreaming", () => stopStreaming())}
                />
            </Menu.MenuGroup>
        );
        return;
    }

    const peer = findPeerByDiscordId(user.id);
    if (!peer?.streaming) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-telinha-watch"
                label={state.viewing[peer.peerId] ? "Abrir transmissão Telinha" : "Assistir transmissão Telinha"}
                icon={MenuBroadcastIcon}
                action={() => openViewer(peer.peerId)}
            />
        </Menu.MenuGroup>
    );
};
