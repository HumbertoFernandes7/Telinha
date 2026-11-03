/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Etiqueta TELINHA da lista de voz (ui/VoiceUserTag.tsx): assistir DENTRO do Discord, na tela da call, como o
// "Assistir" da tile do amigo. O clique:
// 1. abre a tela da call do canal de voz, se ela ainda nao e a que esta na tela (callNav.openCallScreen: o mesmo que
//    clicar no canal na lista; num canal de voz o Discord mostra a call);
// 2. foca a tile do amigo (callNav.focusTile), so quando ela ainda nao e a focada: nao desfocar o que ja esta certo;
// 3. assiste na tile (tileState.startTileWatch, a mesma dona da sessao do "Assistir"). Se nenhuma tile do amigo montar
//    logo (expectTile), a sessao passa para o painel flutuante dentro do Discord. A janela separada continua no
//    "Abrir em janela" da tile.
// A navegacao esta em callNav.ts. Tudo protegido: se o Discord mudar esses nomes, nada quebra, so nao navega/foca (e o
// painel flutuante cobre).

import { getState } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import { findPeer } from "@plugins/telinha/ui/common";
import { isViewerOpen, openViewer } from "@plugins/telinha/ui/viewerWindows";

import { focusTile, isActiveSession, openCallScreen, voiceChannelId } from "./callNav";
import { expectTile, isTileOwned, startTileWatch } from "./tileState";

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
    if (!isTileOwned(peerId) || !isActiveSession(state.viewing[peerId])) startTileWatch(peerId);
    expectTile(peerId);
}
