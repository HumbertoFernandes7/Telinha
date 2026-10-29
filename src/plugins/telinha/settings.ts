/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { onAdmissionSettingChanged, onPasswordChanged } from "@plugins/telinha/core/session";
import { onApproveViewersSettingChanged, onAutoQualitySettingChanged } from "@plugins/telinha/core/streaming";
import { OptionType } from "@utils/types";

export type CodecSetting = "auto" | "h264" | "vp8" | "vp9" | "av1";

// As chaves (groupPassword, rejectOutsiders...) sao o nome salvo nas configuracoes: nao renomear.
// O titulo mostrado na pagina do plugin vem de displayName (sem ele, o Vencord usa a chave em ingles).

export const settings = definePluginSettings({
    groupPassword: {
        type: OptionType.STRING,
        displayName: "Senha do grupo",
        description: "Opcional. Criptografa a sinalização e só deixa entrar quem usa a mesma senha. Todos na call precisam usar a mesma; vazio = sem senha.",
        default: "",
        placeholder: "(sem senha)",
        onChange: () => onPasswordChanged()
    },
    rejectOutsiders: {
        type: OptionType.BOOLEAN,
        displayName: "Recusar quem não está na call",
        description: "Ignorar quem não está no seu canal de voz (recomendado): não vê sua presença nem recebe sua transmissão. Desligado: qualquer pessoa na sala é aceita (útil para testes).",
        default: true,
        onChange: () => onAdmissionSettingChanged()
    },
    approveViewers: {
        type: OptionType.BOOLEAN,
        displayName: "Aprovar quem vai assistir",
        description: "Pedir minha aprovação antes de alguém começar a assistir. Cada pedido aparece na barra do Telinha com Permitir/Recusar e é recusado sozinho depois de 60 segundos; quem você permitir pode assistir até a transmissão acabar.",
        default: false,
        onChange: () => onApproveViewersSettingChanged()
    },
    defaultQuality: {
        type: OptionType.SELECT,
        displayName: "Qualidade padrão",
        description: "Qualidade padrão ao transmitir",
        options: [
            { label: "1080p 60 fps (≈ 8 Mbps)", value: "1080p60", default: true },
            { label: "720p 60 fps (≈ 5 Mbps)", value: "720p60" },
            { label: "1080p 30 fps (≈ 5 Mbps)", value: "1080p30" }
        ]
    },
    autoQuality: {
        type: OptionType.BOOLEAN,
        displayName: "Qualidade automática",
        description: "Recomendado: a qualidade escolhida vira o máximo, e o Telinha reduz resolução/fps de quem assiste quando o seu processador, o seu upload ou a conexão do amigo não dão conta (cada espectador é mais uma codificação). Em jogos, mantém 60 fps sempre que possível e volta a subir sozinho quando estabiliza.",
        default: true,
        onChange: () => onAutoQualitySettingChanged()
    },
    shareAudioByDefault: {
        type: OptionType.BOOLEAN,
        displayName: "Compartilhar som por padrão",
        description: "Compartilhar o som por padrão ao transmitir. Janela: só o som do aplicativo dessa janela. Tela inteira: todo o som do PC, menos o do Discord (Windows 10 versão 2004 ou superior; sem o ajudante de áudio a tela vai só com imagem).",
        default: true
    },
    codec: {
        type: OptionType.SELECT,
        displayName: "Formato de vídeo (codec)",
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
