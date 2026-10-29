/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Estado compartilhado pelas tiles da call. Nada roda no carregamento: a assinatura do store do Telinha so e feita
// quando a primeira tile monta.
//
// - "Assistir na call": quem pediu pela tile e dono da sessao (tileOwned). Se todas as tiles daquele amigo somem
//   (saiu da tela da call) e nenhuma janela do visualizador esta aberta, paramos de assistir depois de um tempo de
//   graca (o Discord remonta tiles ao trocar de layout/foco; nao queremos derrubar o stream nisso).
// - Audio: com o mesmo stream em varias tiles (ex.: call no pop-out do Discord e na janela principal), so a primeira
//   tile montada toca o som; janela do visualizador aberta = o som fica so na janela.
// - Volume por usuario do Discord, enquanto o Discord estiver aberto.

import { unwatch, watch } from "@plugins/telinha/actions";
import { getState, subscribe as subscribeState } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import { logger, runAction } from "@plugins/telinha/ui/common";
import { closeViewer, isViewerOpen } from "@plugins/telinha/ui/viewerWindows";
import { React, showToast } from "@webpack/common";

const UNMOUNT_GRACE_MS = 4000;

interface Owned {
    /** a sessao ja apareceu no estado (watch publica num microtask) */
    sawSession: boolean;
}

const tileOwned = new Map<PeerId, Owned>();
const mounts = new Map<PeerId, symbol[]>();
const graceTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();
const volumes = new Map<string, { volume: number; muted: boolean; }>();

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

export function registerTile(peerId: PeerId): symbol {
    ensureSubscribed();
    const token = Symbol(peerId);
    const list = mounts.get(peerId) ?? [];
    list.push(token);
    mounts.set(peerId, list);

    const timer = graceTimers.get(peerId);
    if (timer) {
        clearTimeout(timer);
        graceTimers.delete(peerId);
    }
    emit();
    return token;
}

export function unregisterTile(peerId: PeerId, token: symbol) {
    const list = (mounts.get(peerId) ?? []).filter(t => t !== token);
    if (list.length) mounts.set(peerId, list);
    else mounts.delete(peerId);
    emit();

    if (list.length || !tileOwned.has(peerId) || graceTimers.has(peerId)) return;
    graceTimers.set(peerId, setTimeout(() => {
        graceTimers.delete(peerId);
        if (mounts.has(peerId) || !tileOwned.has(peerId)) return;
        tileOwned.delete(peerId);
        if (isViewerOpen(peerId)) return;
        logger.info(`Nenhuma tile mostra mais ${peerId}: parando de assistir`);
        runAction("unwatch", () => unwatch(peerId), msg => logger.warn("unwatch falhou", msg));
    }, UNMOUNT_GRACE_MS));
}

/** A primeira tile montada daquele amigo e a que toca o audio */
export function isAudioOwner(peerId: PeerId, token: symbol | null) {
    return token != null && mounts.get(peerId)?.[0] === token;
}

export function getVolume(key: string) {
    return volumes.get(key) ?? { volume: 1, muted: false };
}

export function setVolume(key: string, value: { volume: number; muted: boolean; }) {
    volumes.set(key, value);
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
    for (const t of graceTimers.values()) clearTimeout(t);
    graceTimers.clear();
    tileOwned.clear();
    unsubscribeState?.();
    unsubscribeState = null;
    emit();
}
