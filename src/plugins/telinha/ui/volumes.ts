/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Volume e "mudo" que o usuario escolheu para cada amigo, um so para a tile da call e para a janela do visualizador:
// mexer em um aparece no outro na hora (os dois podem estar montados juntos) e vale ao abrir a janela depois. So em
// memoria, enquanto o Discord estiver aberto. So entra aqui o que o usuario fez: o mudo que o navegador impoe quando
// recusa o autoplay fica no <video>, nunca no que foi escolhido.
// E um modulo proprio (e nao parte de callView/tileState.ts) para a janela nao importar a tile: tileState importa
// viewerWindows, que importa ViewerContent. Nada roda no carregamento.

import type { PeerId } from "@plugins/telinha/types";
import { logger } from "@plugins/telinha/ui/common";
import { React } from "@webpack/common";

export interface VolumeState {
    readonly volume: number;
    readonly muted: boolean;
}

/** Sem registro vale o volume cheio. O mesmo objeto sempre: o useSyncExternalStore compara por referencia */
const DEFAULT_VOLUME: VolumeState = { volume: 1, muted: false };

const volumes = new Map<string, VolumeState>();
const listeners = new Set<() => void>();

function emit() {
    for (const fn of [...listeners]) {
        try {
            fn();
        } catch (e) {
            logger.error("Listener dos volumes falhou", e);
        }
    }
}

export function subscribeVolumes(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** A chave e a mesma na tile e na janela: o usuario do Discord (vale entre sessoes) ou, sem ele, a conexao */
export function volumeKeyFor(peerId: PeerId, discordUserId?: string) {
    return discordUserId || peerId;
}

export function getVolume(key: string): VolumeState {
    return volumes.get(key) ?? DEFAULT_VOLUME;
}

export function setVolume(key: string, next: VolumeState) {
    const current = getVolume(key);
    if (current.volume === next.volume && current.muted === next.muted) return;
    volumes.set(key, { volume: next.volume, muted: next.muted });
    emit();
}

/** O volume de `key` e quem muda: re-renderiza quando a tile ou a janela mexem nele */
export function useVolume(key: string): [VolumeState, (next: VolumeState) => void] {
    const value = React.useSyncExternalStore(subscribeVolumes, () => getVolume(key));
    return [value, next => setVolume(key, next)];
}
