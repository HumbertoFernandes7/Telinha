/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Navegacao da tela da call, compartilhada pela etiqueta TELINHA (watchInCall.ts) e pela janelinha (voltar para a call):
// - openCallScreen: abre a tela da call do canal de voz, se ela ainda nao e a que esta na tela (ChannelRouter.
//   transitionToChannel; se o Vencord nao achar esse modulo, NavigationRouter.transitionTo na rota do canal);
// - focusTile: foca a tile do amigo (acao Flux CHANNEL_RTC_SELECT_PARTICIPANT), so quando ainda nao e a focada;
// - isAwayFromCallScreen: em call de voz e a tela principal mostra outro canal (saiu da tela da call);
// - returnToCall: abre a tela da call e destaca a tile do amigo (clique na janelinha).
// Tudo protegido: se o Discord mudar esses nomes, nada quebra, so nao navega/foca.
// Nao importar viewerWindows nem tileState daqui (tileState importa este modulo: seria um ciclo).

import { peerLabel } from "@plugins/telinha/core/context";
import { log } from "@plugins/telinha/core/log";
import { getState } from "@plugins/telinha/store";
import type { PeerId, ViewerSession } from "@plugins/telinha/types";
import { errorText, findPeer, logger } from "@plugins/telinha/ui/common";
import { ChannelRouter, ChannelRTCStore, ChannelStore, FluxDispatcher, NavigationRouter, SelectedChannelStore } from "@webpack/common";

export function isActiveSession(session: ViewerSession | undefined) {
    return session?.status === "connecting" || session?.status === "waiting-first-frame" || session?.status === "playing";
}

export function voiceChannelId(): string | null {
    try {
        return SelectedChannelStore.getVoiceChannelId() ?? null;
    } catch {
        return null;
    }
}

export function openCallScreen(channelId: string) {
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

export function focusTile(channelId: string, userId: string) {
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


/** Em call de voz e a tela principal mostra outro canal (saiu da tela da call). Falha ao ler o store = false */
export function isAwayFromCallScreen(): boolean {
    try {
        const vc = SelectedChannelStore.getVoiceChannelId();
        return vc != null && SelectedChannelStore.getChannelId() !== vc;
    } catch {
        return false;
    }
}

/** Clique na janelinha: abre a tela da call e destaca a tile do amigo. false se nao ha call para onde voltar */
export function returnToCall(peerId: PeerId): boolean {
    const state = getState();
    const channelId = voiceChannelId() ?? state.channelId;
    if (!channelId) {
        logger.warn("Sem call para onde voltar");
        return false;
    }
    const userId = findPeer(state, peerId)?.discordUserId;
    log.info(`Janelinha: voltando para a call de ${peerLabel(peerId)}`);
    openCallScreen(channelId);
    if (userId) focusTile(channelId, userId);
    return true;
}
