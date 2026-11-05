/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Quem manda no controle de volume da barra da call (canto inferior direito, so aparece com a tile em foco).
// Dois registros pequenos, so em memoria:
// - tiles com som: a tile do amigo que esta tocando o som da live diz aqui qual e a chave do volume (ui/volumes.ts);
// - barra no comando: o TrayVolume (patch em patches.ts) avisa que assumiu o controle daquele amigo, e a tile entao
//   esconde o proprio slider.
// Se o patch do Discord nao aplicar, ninguem registra uma barra e a tile mantem o slider dela (falha segura).
// Nada roda no carregamento do modulo.

import { logger } from "@plugins/telinha/ui/common";
import { React } from "@webpack/common";

const tileAudio = new Map<string, { token: symbol; key: string; }>();
const bars = new Map<string, number>();

let version = 0;
const listeners = new Set<() => void>();

function emit() {
    version++;
    for (const fn of [...listeners]) {
        try {
            fn();
        } catch (e) {
            logger.error("Listener do volume da barra falhou", e);
        }
    }
}

export function subscribeTray(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** Re-renderiza quando muda quem toca o som ou quem comanda a barra */
export function useTrayVersion(): number {
    return React.useSyncExternalStore(subscribeTray, () => version);
}

/**
 * Com `volumeKey`: esta tile toca o som da live desse usuario do Discord. Com null: limpa, mas so se o registro
 * ainda for desta tile (`token`), para uma tile antiga nao apagar o registro de uma nova.
 */
export function setTileAudio(userId: string, token: symbol, volumeKey: string | null) {
    const current = tileAudio.get(userId);
    if (volumeKey === null) {
        if (!current || current.token !== token) return;
        tileAudio.delete(userId);
        emit();
        return;
    }
    if (current && current.token === token && current.key === volumeKey) return;
    tileAudio.set(userId, { token, key: volumeKey });
    emit();
}

export function getTileAudioKey(userId: string): string | null {
    return tileAudio.get(userId)?.key ?? null;
}

/** A barra assumiu o controle deste usuario. Devolve o "desfazer" (idempotente) */
export function registerTrayBar(userId: string): () => void {
    const wasActive = isTrayBarActive(userId);
    bars.set(userId, (bars.get(userId) ?? 0) + 1);
    if (!wasActive) emit();
    let done = false;
    return () => {
        if (done) return;
        done = true;
        const count = bars.get(userId);
        if (!count) return; // o reset ja esqueceu esta barra
        if (count > 1) {
            bars.set(userId, count - 1);
            return;
        }
        bars.delete(userId);
        emit();
    };
}

export function isTrayBarActive(userId: string): boolean {
    return (bars.get(userId) ?? 0) > 0;
}

/** Plugin parado: esquece tudo */
export function resetTrayVolume() {
    tileAudio.clear();
    bars.clear();
    emit();
}
