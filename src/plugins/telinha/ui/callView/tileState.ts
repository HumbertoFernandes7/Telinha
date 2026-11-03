/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Estado compartilhado pelas tiles da call. Nada roda no carregamento: a assinatura do store do Telinha so e feita
// quando a primeira tile monta.
//
// - "Assistir na call": quem pediu pela tile e dono da sessao (tileOwned). Se todas as tiles daquele amigo somem
//   (saiu da tela da call) e nenhuma janela do visualizador esta aberta, a MESMA sessao passa para a janelinha (PiP,
//   sem reconectar): 200 ms depois se a tela principal ja mostra outro canal, senao ao fim da graca de 4 s (o Discord
//   remonta tiles ao trocar de layout/foco; nao queremos tirar o stream nisso). Voltou para a call (uma tile monta):
//   a janelinha sai e a tile retoma a mesma sessao. Sessao encerrada, ou fora da call de voz: para de assistir.
// - Audio: com o mesmo stream em varias tiles (ex.: call no pop-out do Discord e na janela principal), so a primeira
//   tile montada toca o som; janela do visualizador aberta = o som fica so na janela.
// - O volume por usuario do Discord nao fica aqui: e um so para a tile e para a janela do visualizador (ui/volumes.ts).
// - Etiqueta TELINHA da lista de voz (watchInCall.ts): assiste na tile como o "Assistir"; se nenhuma tile daquele amigo
//   montar logo (expectTile), a sessao vai para o painel flutuante dentro do Discord.

import { unwatch, watch } from "@plugins/telinha/actions";
import { peerLabel } from "@plugins/telinha/core/context";
import { log } from "@plugins/telinha/core/log";
import { getState, subscribe as subscribeState } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import { logger, runAction } from "@plugins/telinha/ui/common";
import { closeViewer, dockPip, isViewerOpen, openPip, openViewer } from "@plugins/telinha/ui/viewerWindows";
import { React, showToast } from "@webpack/common";

import { isActiveSession, isAwayFromCallScreen, returnToCall, voiceChannelId } from "./callNav";

const UNMOUNT_GRACE_MS = 4000;
/** Sumiu a ultima tile e a tela principal ja mostra outro canal: a janelinha abre depois disso (sem esperar a graca) */
export const PIP_DELAY_MS = 200;
/** Quanto a etiqueta espera a tile do amigo aparecer na tela da call antes de cair no painel flutuante */
export const NO_TILE_FALLBACK_MS = 3000;

interface Owned {
    /** a sessao ja apareceu no estado (watch publica num microtask) */
    sawSession: boolean;
}

const tileOwned = new Map<PeerId, Owned>();
const mounts = new Map<PeerId, symbol[]>();
const graceTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();
const pipTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();
const noTileTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

let version = 0;
const listeners = new Set<() => void>();
let unsubscribeState: (() => void) | null = null;

function emit() {
    version++;
    for (const fn of [...listeners]) {
        try {
            fn();
        } catch (e) {
            logger.error("Listener das tiles da call falhou", e);
        }
    }
}

/** Uma sessao que a tile pediu sumiu (parou em outro lugar, ex.: fechou a janela): a tile deixa de ser dona */
function onStateChange() {
    const { viewing } = getState();
    let changed = false;
    for (const [peerId, owned] of tileOwned) {
        if (viewing[peerId]) owned.sawSession = true;
        else if (owned.sawSession) {
            tileOwned.delete(peerId);
            changed = true;
        }
    }
    if (changed) emit();
}

function ensureSubscribed() {
    if (!unsubscribeState) unsubscribeState = subscribeState(onStateChange);
}

function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** Re-renderiza quando o dono do audio/da sessao muda */
export function useTileStateVersion(): number {
    return React.useSyncExternalStore(subscribe, () => version);
}

export function isTileOwned(peerId: PeerId) {
    return tileOwned.has(peerId);
}

/** Clique em "Assistir" na tile */
export function startTileWatch(peerId: PeerId) {
    ensureSubscribed();
    tileOwned.set(peerId, { sawSession: !!getState().viewing[peerId] });
    emit();
    runAction("watch", () => watch(peerId), message => {
        tileOwned.delete(peerId);
        emit();
        showToast({ text: `Telinha: não foi possível assistir — ${message}`, variant: "critical" });
    });
}

/** "Parar de assistir" / "Fechar" na tile: encerra em todo lugar (janela inclusive) */
export function stopTileWatch(peerId: PeerId) {
    tileOwned.delete(peerId);
    emit();
    if (isViewerOpen(peerId)) closeViewer(peerId); // a janela chama unwatch ao fechar
    else runAction("unwatch", () => unwatch(peerId), msg => logger.warn("unwatch falhou", msg));
}

/** "Abrir em janela": a janela passa a cuidar da sessao (fechar a janela para de assistir) */
export function releaseToWindow(peerId: PeerId) {
    if (tileOwned.delete(peerId)) emit();
}

/**
 * A etiqueta da lista de voz acabou de abrir a tela da call para assistir na tile desse amigo. Se nenhuma tile dele
 * montar em NO_TILE_FALLBACK_MS (o patch da tile nao aplicou, o Discord esconde quem esta sem camera, a tela da call
 * nao abriu...), a sessao passa para o painel flutuante dentro do Discord. Uma tile que monta antes cancela; sem
 * sessao da tile (parou, falhou ao pedir, foi para uma janela) nao ha o que mover.
 */
export function expectTile(peerId: PeerId) {
    if (mounts.has(peerId) || noTileTimers.has(peerId)) return;
    noTileTimers.set(peerId, setTimeout(() => {
        noTileTimers.delete(peerId);
        if (mounts.has(peerId) || !tileOwned.has(peerId) || isViewerOpen(peerId)) return;
        logger.warn(`Nenhuma tile de ${peerId} apareceu na tela da call em ${NO_TILE_FALLBACK_MS / 1000} s: usando o painel flutuante`);
        releaseToWindow(peerId);
        openViewer(peerId, { inApp: true });
    }, NO_TILE_FALLBACK_MS));
}

export function registerTile(peerId: PeerId): symbol {
    ensureSubscribed();
    const token = Symbol(peerId);
    const list = mounts.get(peerId) ?? [];
    list.push(token);
    mounts.set(peerId, list);

    for (const timers of [graceTimers, pipTimers, noTileTimers]) {
        const timer = timers.get(peerId);
        if (timer) {
            clearTimeout(timer);
            timers.delete(peerId);
        }
    }
    if (dockPip(peerId)) {
        // a tile volta a ser dona da mesma sessao (a janelinha saiu sem unwatch)
        tileOwned.set(peerId, { sawSession: !!getState().viewing[peerId] });
        log.info(`Voltou para a call: ${peerLabel(peerId)} de volta na tile (sem reconectar)`);
    }
    emit();
    return token;
}

/** Fim da espera: a sessao ativa vai para a janelinha; senao (acabou, ou saiu da call de voz) para de assistir */
function handOff(peerId: PeerId) {
    tileOwned.delete(peerId);
    emit();
    if (isViewerOpen(peerId)) return;
    if (isActiveSession(getState().viewing[peerId]) && voiceChannelId()) {
        log.info(`Saiu da tela da call: ${peerLabel(peerId)} segue na janelinha (sem reconectar)`);
        openPip(peerId, { onReturn: () => void returnToCall(peerId) });
        return;
    }
    logger.info(`Nenhuma tile mostra mais ${peerId}: parando de assistir`);
    runAction("unwatch", () => unwatch(peerId), msg => logger.warn("unwatch falhou", msg));
}

export function unregisterTile(peerId: PeerId, token: symbol) {
    const list = (mounts.get(peerId) ?? []).filter(t => t !== token);
    if (list.length) mounts.set(peerId, list);
    else mounts.delete(peerId);
    emit();

    if (list.length || !tileOwned.has(peerId) || graceTimers.has(peerId)) return;
    // fase 1 (PIP_DELAY_MS): se a tela principal ja mostra outro canal, e saida da tela da call: vai logo para a
    // janelinha. Fase 2 (fim da graca, os dois timers saem juntos e um cancela o outro): remontagem de layout do Discord
    // ja teria voltado; decide do mesmo jeito
    graceTimers.set(peerId, setTimeout(() => {
        clearTimeout(pipTimers.get(peerId));
        graceTimers.delete(peerId);
        pipTimers.delete(peerId);
        if (mounts.has(peerId) || !tileOwned.has(peerId)) return;
        handOff(peerId);
    }, UNMOUNT_GRACE_MS));
    pipTimers.set(peerId, setTimeout(() => {
        pipTimers.delete(peerId);
        if (mounts.has(peerId) || !tileOwned.has(peerId) || !isAwayFromCallScreen()) return;
        clearTimeout(graceTimers.get(peerId));
        graceTimers.delete(peerId);
        handOff(peerId);
    }, PIP_DELAY_MS));
}

/** A primeira tile montada daquele amigo e a que toca o audio */
export function isAudioOwner(peerId: PeerId, token: symbol | null) {
    return token != null && mounts.get(peerId)?.[0] === token;
}

/** Preferencia "ocultar a previa da propria transmissao" (vale ate fechar o Discord) */
let localPreviewHidden = false;

export function isLocalPreviewHidden() {
    return localPreviewHidden;
}

export function setLocalPreviewHidden(hidden: boolean) {
    localPreviewHidden = hidden;
    emit();
}

/** Plugin parado: esquece tudo (stopSession ja encerrou as sessoes) */
export function resetTileState() {
    for (const t of [...graceTimers.values(), ...pipTimers.values(), ...noTileTimers.values()]) clearTimeout(t);
    graceTimers.clear();
    pipTimers.clear();
    noTileTimers.clear();
    tileOwned.clear();
    unsubscribeState?.();
    unsubscribeState = null;
    emit();
}
