/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { onAdmissionSettingChanged, onPasswordChanged } from "@plugins/peerLive/core/session";
import { onAutoQualitySettingChanged } from "@plugins/peerLive/core/streaming";
import { OptionType } from "@utils/types";

export type CodecSetting = "auto" | "h264" | "vp8" | "vp9" | "av1";

export const settings = definePluginSettings({
    groupPassword: {
        type: OptionType.STRING,
        description: "Senha do grupo (opcional). Criptografa a sinalização e só deixa entrar quem usa a mesma senha. Todos na call precisam usar a mesma; vazio = sem senha.",
        default: "",
        placeholder: "(sem senha)",
        onChange: () => onPasswordChanged()
    },
    rejectOutsiders: {
        type: OptionType.BOOLEAN,
        description: "Ignorar quem não está no seu canal de voz (recomendado): não vê sua presença nem recebe sua transmissão. Desligado: qualquer pessoa na sala é aceita (útil para testes).",
        default: true,
        onChange: () => onAdmissionSettingChanged()
    },
    defaultQuality: {
        type: OptionType.SELECT,
        description: "Qualidade padrão ao transmitir",
        options: [
            { label: "1080p 60 fps (≈ 8 Mbps)", value: "1080p60", default: true },
            { label: "720p 60 fps (≈ 5 Mbps)", value: "720p60" },
            { label: "1080p 30 fps (≈ 5 Mbps)", value: "1080p30" }
        ]
    },
    autoQuality: {
        type: OptionType.BOOLEAN,
        description: "Qualidade automática (recomendado): a qualidade escolhida vira o máximo, e o PeerLive reduz resolução/fps de quem assiste quando o seu processador, o seu upload ou a conexão do amigo não dão conta (cada espectador é mais uma codificação). Em jogos, mantém 60 fps sempre que possível e volta a subir sozinho quando estabiliza.",
        default: true,
        onChange: () => onAutoQualitySettingChanged()
    },
    shareAudioByDefault: {
        type: OptionType.BOOLEAN,
        description: "Compartilhar o áudio da janela por padrão (só janelas; a tela inteira vai sem áudio nesta versão)",
        default: true
    },
    codec: {
        type: OptionType.SELECT,
        description: "Codec de vídeo ao transmitir. Automático: H.264 quando o seu PC codifica e o do amigo decodifica por hardware; senão VP9.",
        options: [
            { label: "Automático (recomendado)", value: "auto", default: true },
            { label: "H.264", value: "h264" },
            { label: "VP8", value: "vp8" },
            { label: "VP9", value: "vp9" },
            { label: "AV1", value: "av1" }
        ]
    }
});
