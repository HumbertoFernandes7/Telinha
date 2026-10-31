/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { migrateAccessSetting } from "@plugins/telinha/core/access";
import { onShareDiagnosticsChanged } from "@plugins/telinha/core/diagShare";
import { isIdentityConfigured } from "@plugins/telinha/core/identity/config";
import { onAdmissionSettingChanged, onPasswordChanged } from "@plugins/telinha/core/session";
import { onApprovalPolicyChanged, onAutoQualitySettingChanged } from "@plugins/telinha/core/streaming";
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
    // substitui a opcao booleana approveViewers da v0.1.0 (migrada em migrateAccessSettings: true → "approval")
    defaultAccess: {
        type: OptionType.SELECT,
        displayName: "Quem pode assistir (padrão)",
        description: "O que já vem marcado em \"Quem pode assistir\" quando você transmite (dá para trocar a cada transmissão e também durante ela, na barra do Telinha). Todos da call: quem está no seu canal de voz. Só meus amigos do Discord: entra direto quem é seu amigo e provou a identidade; os outros não assistem. Só quem eu aprovar: cada pedido espera você clicar em Permitir ou Recusar (recusado sozinho em 60 segundos). Com senha: você cria uma senha a cada transmissão, que nunca fica salva.",
        options: [
            { label: "Todos da call", value: "all", default: true },
            { label: "Só meus amigos do Discord", value: "friends" },
            { label: "Só quem eu aprovar", value: "approval" },
            { label: "Com senha", value: "password" }
        ]
    },
    requireVerifiedIdentity: {
        type: OptionType.BOOLEAN,
        displayName: "Exigir identidade verificada",
        description: "Recomendado. Vale para \"Todos da call\": quem não provou ser a conta do Discord que diz ser (aparece como \"não verificado\": não autorizou o Telinha ou usa uma versão antiga) continua vendo que você está na call, mas só assiste à sua transmissão depois que você clicar em Permitir. Desligado: quem não está verificado assiste como antes. (\"Só meus amigos do Discord\" sempre exige a identidade verificada; \"Com senha\" aceita quem acertar a senha.) Uma identidade falsa nunca é aceita.",
        default: true,
        // sem Client ID o recurso esta desligado e a opcao nao faria nada
        hidden: () => !isIdentityConfigured(),
        onChange: () => onApprovalPolicyChanged()
    },
    defaultQuality: {
        type: OptionType.SELECT,
        displayName: "Qualidade padrão",
        description: "Qualidade padrão ao transmitir",
        options: [
            { label: "1080p 60 fps (até 20 Mbps)", value: "1080p60", default: true },
            { label: "720p 60 fps (até 12 Mbps)", value: "720p60" },
            { label: "1080p 30 fps (até 12 Mbps)", value: "1080p30" }
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
    playSounds: {
        type: OptionType.BOOLEAN,
        displayName: "Sons de entrar e sair",
        description: "Toca um som quando alguém começa ou para de assistir a sua transmissão, e quando alguém da call começa ou para de transmitir pelo Telinha.",
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
    },
    autoUpdate: {
        type: OptionType.BOOLEAN,
        displayName: "Atualizar automaticamente",
        description: "Recomendado: ao abrir o Discord (e a cada 6 horas), o Telinha procura uma versão nova, baixa em segundo plano e confere o SHA-256 publicado no GitHub. A versão nova só entra quando o Discord reiniciar, nunca no meio de uma transmissão. Desligado: só avisa que há versão nova, com o botão Atualizar.",
        default: true
    },
    // protocol.ts, passo 9 (core/diagShare.ts); sem Client ID ninguem e verificado e a opcao nao faria nada
    shareDiagnostics: {
        type: OptionType.BOOLEAN,
        displayName: "Compartilhar diagnóstico para ajudar a depurar",
        description: "Quem também ligou esta opção e está na mesma call pode pedir o registro do Telinha deste PC; vai só o registro do Telinha, sem IP.",
        default: false,
        hidden: () => !isIdentityConfigured(),
        onChange: () => onShareDiagnosticsChanged()
    }
});

/**
 * v0.1.0 → v0.2.0: "Aprovar quem vai assistir" (approveViewers: true) vira "Quem pode assistir (padrão)" = "Só quem
 * eu aprovar"; a chave antiga sai. Chamado no start() do plugin (as configuracoes so existem depois do registro).
 * Nunca lanca.
 */
export function migrateAccessSettings(): void {
    try {
        const plain = settings.plain as Record<string, unknown> | undefined;
        if (!plain) return;
        const { defaultAccess, dropApproveViewers } = migrateAccessSetting(plain);
        // apagar primeiro: a gravacao abaixo salva o objeto inteiro (ja sem a chave antiga)
        if (dropApproveViewers) delete plain.approveViewers;
        if (defaultAccess) settings.store.defaultAccess = defaultAccess;
    } catch (e) {
        console.warn("[Telinha] migração de \"Aprovar quem vai assistir\" falhou", e);
    }
}
