/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui/styles.css";

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin from "@utils/types";
import { showToast } from "@webpack/common";

import { startSession, stopSession } from "./actions";
import { captureBoostDiagnostics, refreshGpuCapture, startCaptureBoost } from "./core/captureBoost";
import { setDiagnosticsSource } from "./core/diagShare";
import { localIdentityDiagnostics } from "./core/identity";
import { peerIdentityDiagnostics } from "./core/session";
import { stuckEncoderDiagnostics } from "./core/stuckEncoder";
import { refreshUpdateLog, refreshUpdateStatus, startUpdateChecks, stopUpdateChecks, updateDiagnostics } from "./core/update";
import { migrateAccessSettings, settings } from "./settings";
import { formatDiagnostics } from "./store";
import { callViewPatches, renderCallTileStream, stopCallView } from "./ui/callView";
import { runAction } from "./ui/common";
import { DiagShareSection } from "./ui/DiagShareUI";
import { IdentitySection } from "./ui/IdentityUI";
import { panelJsx, voiceUserIconsJsx } from "./ui/jsxShims";
import { renderToolboxActions, userContextMenuPatch } from "./ui/menus";
import { startNotices, stopNotices } from "./ui/notices";
import { startSounds, stopSounds } from "./ui/sounds";
import { StuckEncoderSection } from "./ui/StuckEncoderSection";
import { startUpdateNotices, stopUpdateNotices } from "./ui/updateNotice";
import { UpdateSection } from "./ui/UpdateSection";
import { closeAllViewers } from "./ui/viewerWindows";
import { formatVoiceTagDiagnostics } from "./ui/VoiceUserTag";

/** Identity state for the diagnostics (configured, authorized, per-peer verdicts and recent failures). Never tokens or IPs. */
function identityDiagnostics(): string {
    try {
        return [localIdentityDiagnostics(), peerIdentityDiagnostics()].filter(Boolean).join("\n");
    } catch (e) {
        return `identidade: diagnóstico indisponível (${e instanceof Error ? e.message : String(e)})`;
    }
}

/**
 * The "Copiar diagnóstico" text, in two steps: refresh (fresh version/update status and the last update lines of
 * main.log, asked from the main process), then format. Also what core/diagShare.ts sends to a friend who asked for it.
 */
const diagnostics = {
    refresh: () => Promise.all([refreshUpdateStatus(), refreshUpdateLog(), refreshGpuCapture()]).catch(() => null),
    format: () => `${formatDiagnostics()}\n${updateDiagnostics()}\n${identityDiagnostics()}\n${stuckEncoderDiagnostics()}\n${captureBoostDiagnostics()}\n\n${formatVoiceTagDiagnostics()}`
};

function copyDiagnostics() {
    diagnostics.refresh()
        .then(() => copyToClipboard(diagnostics.format()))
        .then(
            () => showToast({ text: "Diagnóstico do Telinha copiado", variant: "success" }),
            () => showToast({ text: "Não consegui copiar o diagnóstico", variant: "critical" })
        );
}

function SettingsAbout() {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <Paragraph>
                Numa call de voz, use "Transmitir com Telinha" logo abaixo do painel da conexão de voz (ou no menu do
                Vencord, na barra de título). Quem transmite pelo Telinha aparece com a etiqueta TELINHA na lista do canal
                de voz: clique nela para assistir aqui dentro do Discord, na tela da call (o botão "Abrir em janela" leva
                para uma janela própria). Todos na call precisam ter o Telinha.
            </Paragraph>
            <Button size="small" variant="secondary" onClick={copyDiagnostics}>
                Copiar diagnóstico
            </Button>
            <StuckEncoderSection />
            <DiagShareSection />
            <IdentitySection />
            <UpdateSection />
        </div>
    );
}

export default definePlugin({
    name: "Telinha",
    description: "Telinha: transmita a tela direto entre amigos na call, sem servidor (P2P).",
    authors: [{ name: "Telinha", id: 0n }],
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
        // "TELINHA" tag in the voice channel member list (left sidebar), right before the mute/deafen/"AO VIVO"
        // icons. The find is Discord's VoiceUser row module (the same one RoleColorEverywhere patches). The row ends
        // with `(0,r.jsx)(VoiceUserIcons,{disabled:…,...rowProps,isHovered:…})`, the only call that gets isHovered;
        // we swap that call's jsx callee for a shim that reads user/collapsed from the props it already receives and
        // renders the tag before the icons. Props and children stay untouched, so RoleColorEverywhere's name patch
        // matches whichever plugin is patched first.
        // (The previous match grabbed the nearest jsx call before GUEST_NAME_SUFFIX, which in real Discord code is
        // the guest suffix <span> itself, rendered only for guest users: the tag never showed for anyone else.)
        {
            find: "#{intl::GUEST_NAME_SUFFIX})]",
            replacement: {
                match: /\i\.(jsxs?)(?=\)\(\i,{[^{}]{0,120}?isHovered:)/,
                replace: "$self.voiceUserIconsJsx.$1"
            }
        },
        // Assistir dentro da tela da call (tiles dos participantes); detalhes em ui/callView/patches.ts
        ...callViewPatches
    ],

    contextMenus: {
        "user-context": userContextMenuPatch
    },

    toolboxActions: renderToolboxActions,

    start() {
        // v0.1.0 → v0.2.0: "Aprovar quem vai assistir" vira "Quem pode assistir (padrão)"
        migrateAccessSettings();
        // "Compartilhar diagnóstico": a friend who asks gets the same text as "Copiar diagnóstico"
        setDiagnosticsSource(diagnostics);
        startNotices();
        startSounds();
        startUpdateNotices();
        startUpdateChecks();
        // "Captura pela placa de vídeo": o arquivo que o loader le na proxima partida volta a bater com a opcao
        void startCaptureBoost();
        runAction("startSession", () => startSession(), () => { });
    },

    stop() {
        stopUpdateChecks();
        stopUpdateNotices();
        stopNotices();
        stopSounds();
        closeAllViewers();
        stopCallView();
        runAction("stopSession", () => stopSession(), () => { });
    },

    panelJsx,
    voiceUserIconsJsx,
    renderCallTileStream
});
