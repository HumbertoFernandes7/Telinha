/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { onPasswordChanged } from "./session";
import { P2PPanel } from "./ui";

export const settings = definePluginSettings({
    groupPassword: {
        type: OptionType.STRING,
        displayName: "Senha do grupo",
        description: "Segredo compartilhado com os amigos (vira o `password` do Trystero e criptografa a sinalização). Vazio = sem senha. Todos na call precisam usar a mesma.",
        default: "",
        placeholder: "(sem senha)",
        onChange: () => onPasswordChanged()
    },
    enforceAdmission: {
        type: OptionType.BOOLEAN,
        displayName: "Rejeitar peers fora do canal de voz",
        description: "Desligado (padrão do spike): peers cujo ID do Discord não está no seu canal de voz são aceitos, mas marcados e registrados no log. Ligado: o handshake é recusado.",
        default: false
    },
    panel: {
        type: OptionType.COMPONENT,
        component: () => <P2PPanel inSettings />
    }
});
