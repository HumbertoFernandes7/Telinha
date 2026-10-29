/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";

import { shutdown } from "./runner";
import { openTestModal } from "./TestModal";

const settings = definePluginSettings({
    openTest: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button onClick={() => openTestModal()}>
                Abrir autoteste de captura
            </Button>
        )
    }
});

export default definePlugin({
    name: "PeerLiveTest",
    description: "Spike de viabilidade do PeerLive: testa captura de tela/janela com áudio, codificação 1080p60 e janela flutuante no Discord desktop.",
    authors: [{ name: "PeerLive", id: 0n }],
    settings,

    toolboxActions: {
        "PeerLive: autoteste de captura": () => openTestModal()
    },

    stop: shutdown
});
