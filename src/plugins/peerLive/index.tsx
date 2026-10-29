/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui/styles.css";

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin from "@utils/types";
import { showToast } from "@webpack/common";

import { startSession, stopSession } from "./actions";
import { settings } from "./settings";
import { formatDiagnostics } from "./store";
import { runAction } from "./ui/common";
import { panelJsx, voiceNameJsx } from "./ui/jsxShims";
import { renderToolboxActions, userContextMenuPatch } from "./ui/menus";
import { closeAllViewers } from "./ui/viewerWindows";

function SettingsAbout() {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <Paragraph>
                Numa call de voz, use "Transmitir com PeerLive" logo abaixo do painel da conexão de voz (ou no menu do
                Vencord, na barra de título). Quem transmite pelo PeerLive aparece com a etiqueta PEERLIVE na lista do canal
                de voz: clique nela para assistir numa janela própria. Todos na call precisam ter o PeerLive.
            </Paragraph>
            <Button
                size="small"
                variant="secondary"
                onClick={() => copyToClipboard(formatDiagnostics()).then(
                    () => showToast({ text: "Diagnóstico do PeerLive copiado", variant: "success" }),
                    () => showToast({ text: "Não consegui copiar o diagnóstico", variant: "critical" })
                )}
            >
                Copiar diagnóstico
            </Button>
        </div>
    );
}

export default definePlugin({
    name: "PeerLive",
    description: "Transmita a tela direto entre amigos na call, sem servidor (P2P).",
    authors: [{ name: "PeerLive", id: 0n }],
    settings,
    settingsAboutComponent: SettingsAbout,

    patches: [
        // Voice panel bar: rendered right above the account panel, i.e. right under the voice connection panel
        // (Voz conectada + camera/screen-share buttons). Same call site SpotifyControls wraps
        // (`\i.jsx)(AccountPanel,{...userTag:\i,occluded:`); we only swap the jsx callee, so its match still works
        // after ours, and ours also accepts the call after SpotifyControls' rewrite.
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /\i\.(jsxs?)(?=\)\((?:\i|Vencord\.Plugins\.plugins\["SpotifyControls"\]\.PanelWrapper),{[^}]*?userTag:\i,occluded:)/,
                replace: "$self.panelJsx.$1"
            }
        },
        // "PEERLIVE" tag after the user's name in voice channel rows. Same module RoleColorEverywhere patches: the
        // name element is the nearest jsx call before `GUEST_NAME_SUFFIX...""]`. Only its callee is swapped (the
        // props, the GUEST_NAME_SUFFIX text and the guildId/user destructuring RoleColorEverywhere looks for stay).
        {
            find: "#{intl::GUEST_NAME_SUFFIX})]",
            replacement: {
                match: /\i\.(jsxs?)(?=\)\((?:(?!\.jsxs?\)\()[^;]){0,300}?#{intl::GUEST_NAME_SUFFIX}.{0,50}?""\])(?<=user:(\i).+?)/,
                replace: (_, jsx, user) => `$self.voiceNameJsx(typeof ${user}==="undefined"?void 0:${user}).${jsx}`
            }
        }
    ],

    contextMenus: {
        "user-context": userContextMenuPatch
    },

    toolboxActions: renderToolboxActions,

    start() {
        runAction("startSession", () => startSession(), () => { });
    },

    stop() {
        closeAllViewers();
        runAction("stopSession", () => stopSession(), () => { });
    },

    panelJsx,
    voiceNameJsx
});
