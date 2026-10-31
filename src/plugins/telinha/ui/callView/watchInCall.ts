/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Etiqueta TELINHA da lista de voz (ui/VoiceUserTag.tsx): assistir DENTRO do Discord, na tela da call, como o
// "Assistir" da tile do amigo. O clique:
// 1. abre a tela da call do canal de voz, se ela ainda nao e a que esta na tela: ChannelRouter.transitionToChannel (o
//    mesmo que clicar no canal na lista; num canal de voz o Discord mostra a call). Se o Vencord nao achar esse modulo
//    (o lazy lanca), NavigationRouter.transitionTo na rota /channels/<servidor ou @me>/<canal>;
// 2. foca a tile do amigo: a acao Flux CHANNEL_RTC_SELECT_PARTICIPANT { channelId, id } e a que a tile do Discord
//    manda ao ser clicada (o id de um participante USER e o id do usuario). So quando ela ainda nao e a focada
//    (ChannelRTCStore.getSelectedParticipantId): nao desfocar o que ja esta certo;
// 3. assiste na tile (tileState.startTileWatch, a mesma dona da sessao do "Assistir"). Se nenhuma tile do amigo montar
//    logo (expectTile), a sessao passa para o painel flutuante dentro do Discord. A janela separada continua no
//    "Abrir em janela" da tile.
// Tudo protegido: se o Discord mudar esses nomes, nada quebra, so nao navega/foca (e o painel flutuante cobre).

import { getState } from "@plugins/telinha/store";
import type { PeerId, ViewerSession } from "@plugins/telinha/types";
import { errorText, findPeer, logger } from "@plugins/telinha/ui/common";
import { isViewerOpen, openViewer } from "@plugins/telinha/ui/viewerWindows";
import { ChannelRouter, ChannelRTCStore, ChannelStore, FluxDispatcher, NavigationRouter, SelectedChannelStore } from "@webpack/common";

import { expectTile, isTileOwned, startTileWatch } from "./tileState";

function isActive(session: ViewerSession | undefined) {
    return session?.status === "connecting" || session?.status === "waiting-first-frame" || session?.status === "playing";
}

function voiceChannelId(): string | null {
    try {
        return SelectedChannelStore.getVoiceChannelId() ?? null;
    } catch {
        return null;
    }
}

function openCallScreen(channelId: string) {
    try {
        if (SelectedChannelStore.getChannelId() === channelId) return;
    } catch { }
    try {
        ChannelRouter.transitionToChannel(channelId);
        return;
    } catch (e) {
        logger.warn("ChannelRouter.transitionToChannel falhou; abrindo a call pela rota", errorText(e));
    }
    try {
        const guildId = ChannelStore.getChannel(channelId)?.guild_id || "@me";
        NavigationRouter.transitionTo(`/channels/${guildId}/${channelId}`);
    } catch (e) {
        logger.warn("Não consegui abrir a tela da call", errorText(e));
    }
}

function focusTile(channelId: string, userId: string) {
    try {
        if (ChannelRTCStore?.getSelectedParticipantId(channelId) === userId) return;
    } catch { }
    const failed = (e: unknown) => logger.warn("Não consegui destacar a tile na call", errorText(e));
    try {
        Promise.resolve(FluxDispatcher.dispatch({ type: "CHANNEL_RTC_SELECT_PARTICIPANT", channelId, id: userId })).catch(failed);
    } catch (e) {
        failed(e);
    }
}

/** Clique (ou Enter/espaco) na etiqueta TELINHA de um amigo na lista de voz */
export function watchInCall(peerId: PeerId) {
    const state = getState();
    const userId = findPeer(state, peerId)?.discordUserId;
    const channelId = voiceChannelId() ?? state.channelId;
    if (!channelId || !userId) {
        // sem canal de voz nao ha tela da call: direto no painel flutuante
        openViewer(peerId, { inApp: true });
        return;
    }

    openCallScreen(channelId);
    focusTile(channelId, userId);

    // ja numa janela ou no painel flutuante: a tile mostra a mesma transmissao (o som fica na janela)
    if (isViewerOpen(peerId)) return;
    if (!isTileOwned(peerId) || !isActive(state.viewing[peerId])) startTileWatch(peerId);
    expectTile(peerId);
}
