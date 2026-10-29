/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// SPIKE DESCARTAVEL do PeerLive: testa se instancias do plugin no mesmo canal de voz se
// acham via relays Nostr publicos (Trystero), conectam por WebRTC e trocam um video de
// teste entre casas. Prioriza diagnostico, nao acabamento.

import definePlugin from "@utils/types";
import { Menu, UserStore } from "@webpack/common";

import { getCspRelays, logEvent, newLog, openLogFolder, stopDiagnostics } from "./diagnostics";
import { RELAY_URLS } from "./protocol";
import { isStreaming, reevaluateAdmission, shutdown, syncVoiceRoom, toggleTestStream } from "./session";
import { settings } from "./settings";
import { openP2PPanel } from "./ui";

const TRYSTERO_VERSION = "0.26.0";

function onCspViolation(e: SecurityPolicyViolationEvent) {
    if (!/^wss?:/.test(e.blockedURI) && !RELAY_URLS.some(url => e.blockedURI.startsWith(url))) return;
    logEvent("error", "csp", `CSP bloqueou ${e.blockedURI} (${e.effectiveDirective}). Feche o Discord POR COMPLETO (inclusive da bandeja) e abra de novo para o native.ts liberar os relays.`);
}

interface VoiceStateUpdate {
    userId: string;
    channelId?: string | null;
}

export default definePlugin({
    name: "PeerLiveP2PTest",
    description: "SPIKE de teste: descoberta P2P via Nostr (Trystero) entre pessoas do mesmo canal de voz + stream de teste por WebRTC, com diagnóstico.",
    authors: [{ name: "PeerLive", id: 0n }],
    tags: ["Voice"],
    settings,

    toolboxActions() {
        return [
            <Menu.MenuItem key="peerlive-p2p-panel" id="peerlive-p2p-panel" label="Abrir painel P2P" action={openP2PPanel} />,
            <Menu.MenuItem
                key="peerlive-p2p-stream"
                id="peerlive-p2p-stream"
                label={isStreaming() ? "Parar padrão de teste" : "Transmitir padrão de teste"}
                action={toggleTestStream}
            />,
            <Menu.MenuItem key="peerlive-p2p-logs" id="peerlive-p2p-logs" label="Abrir pasta de logs P2P" action={() => void openLogFolder()} />
        ];
    },

    flux: {
        VOICE_CHANNEL_SELECT() {
            // deixa o SelectedChannelStore processar a acao antes de ler o canal
            setTimeout(() => syncVoiceRoom("VOICE_CHANNEL_SELECT"), 0);
        },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceStateUpdate[]; }) {
            const myId = UserStore.getCurrentUser()?.id;
            if (voiceStates.some(s => s.userId === myId)) setTimeout(() => syncVoiceRoom("VOICE_STATE_UPDATES"), 0);
            reevaluateAdmission();
        }
    },

    start() {
        const user = UserStore.getCurrentUser();
        newLog({
            app: "discord",
            plugin: "PeerLiveP2PTest",
            trystero: TRYSTERO_VERSION,
            userAgent: navigator.userAgent,
            discordUserId: user?.id,
            username: user?.username
        });

        if (!VencordNative.pluginHelpers.PeerLiveP2PTest) {
            logEvent("error", "native", "A parte nativa do plugin não está carregada: o CSP não libera os relays e o log não vai para o disco. Feche o Discord por completo e abra de novo.");
        } else {
            void getCspRelays().then(list => {
                if (list) logEvent("info", "csp", `native.ts adicionou ${list.length}/${RELAY_URLS.length} relays ao connect-src (vale desde a última abertura do Discord)`);
            });
        }

        document.addEventListener("securitypolicyviolation", onCspViolation);
        syncVoiceRoom("plugin iniciado");
    },

    async stop() {
        document.removeEventListener("securitypolicyviolation", onCspViolation);
        await shutdown();
        await stopDiagnostics();
    }
});
