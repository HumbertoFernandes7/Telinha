/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { migrateAccessSetting } from "@plugins/telinha/core/access";
import { onAv1SettingChanged } from "@plugins/telinha/core/av1Flag";
import { migrateGpuPrioritySetting, onGpuCaptureSettingChanged, onGpuPrioritySettingChanged } from "@plugins/telinha/core/captureBoost";
import { onShareDiagnosticsChanged } from "@plugins/telinha/core/diagShare";
import { isIdentityConfigured } from "@plugins/telinha/core/identity/config";
import { migrateQualitySetting } from "@plugins/telinha/core/quality/choice";
import { onAdmissionSettingChanged, onPasswordChanged } from "@plugins/telinha/core/session";
import { onApprovalPolicyChanged, onAutoQualitySettingChanged } from "@plugins/telinha/core/streaming";
import { onCodecSettingChanged } from "@plugins/telinha/core/stuckEncoder";
import { onJitterCushionChanged } from "@plugins/telinha/core/viewing";
import { captureBoostStatusElement } from "@plugins/telinha/ui/CaptureBoostStatus";
import { codecStatusElement } from "@plugins/telinha/ui/CodecStatus";
import { OptionType } from "@utils/types";

export type CodecSetting = "auto" | "h264" | "h265" | "vp8" | "vp9" | "av1";

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
    // as duas substituem "Qualidade padrão" (defaultQuality: "1080p60", "720p60" ou "1080p30" ate a v0.3.x), migrada em
    // migrateQualitySettings; juntas dao a qualidade (core/quality/choice.ts)
    defaultResolution: {
        type: OptionType.SELECT,
        displayName: "Resolução padrão",
        description: "A resolução que já vem marcada ao transmitir (dá para trocar a cada transmissão e também durante ela, na barra do Telinha). 2K precisa de uma tela 2K: numa tela ou janela menor, vai no tamanho dela. Por pessoa assistindo, até 20 Mbps (720p a 30 fps: até 6 Mbps; 720p a 60 fps e 1080p a 30 fps: até 12 Mbps).",
        options: [
            { label: "720p", value: 720 },
            { label: "1080p", value: 1080, default: true },
            { label: "2K (1440p)", value: 1440 }
        ]
    },
    defaultFps: {
        type: OptionType.SELECT,
        displayName: "FPS padrão",
        description: "Os quadros por segundo que já vêm marcados ao transmitir. 60: jogos e movimento mais fluidos; 30: gasta menos processador e menos internet.",
        options: [
            { label: "30 fps", value: 30 },
            { label: "60 fps", value: 60, default: true }
        ]
    },
    autoQuality: {
        type: OptionType.BOOLEAN,
        displayName: "Qualidade automática",
        description: "Recomendado: a resolução e o fps escolhidos viram o máximo, e o Telinha reduz resolução/fps de quem assiste quando o seu processador, o seu upload ou a conexão do amigo não dão conta (cada espectador é mais uma codificação). Em jogos, mantém 60 fps sempre que possível e volta a subir sozinho quando estabiliza.",
        default: true,
        onChange: () => onAutoQualitySettingChanged()
    },
    // core/viewing.ts → applyCushion: jitterBufferTarget (ms) nos receivers de video e de audio do que voce assiste
    jitterCushion: {
        type: OptionType.SELECT,
        displayName: "Colchão contra engasgos",
        description: "Ao assistir: a imagem chega um pouco atrasada, mas não engasga em soluços da internet.",
        options: [
            { label: "Desligado", value: 0 },
            { label: "0,2 s (padrão)", value: 200, default: true },
            { label: "0,4 s", value: 400 }
        ],
        onChange: () => onJitterCushionChanged()
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
        description: "Codec de vídeo ao transmitir. Automático: H.264 quando o seu PC codifica e o do amigo decodifica por hardware; senão VP9. "
            + "H.265 só ajuda com internet boa; com internet fraca pode perder fps. "
            + "AV1: só com placa RTX 40/50 (ou Radeon RX 7000, Intel Arc) de quem transmite e RTX 30 ou mais nova de quem assiste; depois de escolher, reinicie o Discord. "
            + "Os dois só vão com a placa de vídeo dos dois lados; senão, vai o do automático. "
            + "Escolhido durante uma transmissão, o teste da placa roda quando ela acabar.",
        options: [
            { label: "Automático (recomendado)", value: "auto", default: true },
            { label: "H.265", value: "h265" },
            { label: "H.264", value: "h264" },
            { label: "VP8", value: "vp8" },
            { label: "VP9", value: "vp9" },
            { label: "AV1", value: "av1" }
        ],
        // fixado em H.265 ou AV1: a sonda dele roda agora (so com ele fixado); AV1: o pedido do WebRtcAV1HWEncode para a
        // proxima partida do Discord (core/av1Flag.ts)
        onChange: () => {
            void onCodecSettingChanged();
            void onAv1SettingChanged();
        }
    },
    // o que falta para o AV1 fixado ir (ui/CodecStatus.tsx); nada fica salvo nesta chave
    codecStatus: {
        type: OptionType.COMPONENT,
        component: () => codecStatusElement()
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
        description: "Quem também ligou esta opção e está na mesma call pode pedir o registro do Telinha deste PC; vai só o registro do Telinha (com os nomes de quem está na call), sem IP; enquanto quem pediu mantiver o pedido, o envio recomeça sozinho quando você reabrir o Discord.",
        default: false,
        hidden: () => !isIdentityConfigured(),
        onChange: () => onShareDiagnosticsChanged()
    },
    // core/captureBoost.ts: a live com um jogo que usa a placa de video toda (experimental, desligado por padrao)
    gpuCapture: {
        type: OptionType.BOOLEAN,
        displayName: "Captura pela placa de vídeo (experimental; Windows 11 atualizado; reinicie o Discord)",
        description: "Deixa a live mais fluida quando um jogo usa a placa de vídeo toda: a imagem da tela fica na placa de vídeo, sem passar pelo processador. Se a placa de vídeo reiniciar, a transmissão para; é só transmitir de novo.",
        default: false,
        onChange: () => void onGpuCaptureSettingChanged()
    },
    // substitui a opcao booleana gpuPriority (migrada em migrateGpuPrioritySettings: true → "high"); a chave e nova porque
    // um true salvo nao e um valor valido do seletor
    gpuPriorityMode: {
        type: OptionType.SELECT,
        displayName: "Prioridade da captura na placa de vídeo (experimental)",
        description: "Deixa a live mais fluida quando um jogo usa a placa de vídeo toda. Alta: enquanto você transmite, a captura passa na frente na fila da placa de vídeo. Tempo real (teste): alta, e quando um jogo pesado ocupa a placa, a captura passa na frente de tudo (o jogo pode perder alguns fps); se a placa travar, volta sozinho para alta e lembra neste PC.",
        options: [
            { label: "Desligada", value: "off", default: true },
            { label: "Alta", value: "high" },
            { label: "Tempo real (teste)", value: "realtime" }
        ],
        onChange: () => onGpuPrioritySettingChanged()
    },
    // o que as opcoes acima fazem agora (ui/CaptureBoostStatus.tsx); nada fica salvo nesta chave
    captureBoostStatus: {
        type: OptionType.COMPONENT,
        component: () => captureBoostStatusElement()
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

/**
 * Ate a v0.3.x: "Qualidade padrão" (defaultQuality: "1080p60", "720p60" ou "1080p30") vira "Resolução padrão" + "FPS
 * padrão" com o par dela; valor desconhecido: valem os padroes (1080p, 60). A chave antiga sai. Chamado no start() do
 * plugin. Nunca lanca.
 */
export function migrateQualitySettings(): void {
    try {
        const plain = settings.plain as Record<string, unknown> | undefined;
        if (!plain) return;
        const { resolution, fps, dropOld } = migrateQualitySetting(plain);
        // apagar primeiro: a gravacao abaixo salva o objeto inteiro (ja sem a chave antiga)
        if (dropOld) delete plain.defaultQuality;
        if (resolution) settings.store.defaultResolution = resolution;
        if (fps) settings.store.defaultFps = fps;
    } catch (e) {
        console.warn("[Telinha] migração de \"Qualidade padrão\" falhou", e);
    }
}

/**
 * A opcao booleana "Prioridade da captura na placa de vídeo" (gpuPriority: true) virou o seletor gpuPriorityMode:
 * true → "Alta"; a chave antiga sai. Chamado no start() do plugin. Nunca lanca.
 */
export function migrateGpuPrioritySettings(): void {
    try {
        const plain = settings.plain as Record<string, unknown> | undefined;
        if (!plain) return;
        const { mode, dropOld } = migrateGpuPrioritySetting(plain);
        // apagar primeiro: a gravacao abaixo salva o objeto inteiro (ja sem a chave antiga)
        if (dropOld) delete plain.gpuPriority;
        if (mode) settings.store.gpuPriorityMode = mode;
    } catch (e) {
        console.warn("[Telinha] migração de \"Prioridade da captura na placa de vídeo\" falhou", e);
    }
}
