/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Contrato entre o processo main (screenAudioMain.ts, via native.ts) e o renderer (screenAudio.ts) para o
// audio da tela inteira. So tipos e constantes: seguro de importar dos dois lados.

/** Formato fixo do PCM que o peerlive-audio.exe escreve: 48 kHz, estereo, float32 LE intercalado. */
export const SCREEN_AUDIO_RATE = 48000;
export const SCREEN_AUDIO_CHANNELS = 2;
export const SCREEN_AUDIO_BYTES_PER_FRAME = 8;

/** Espera maxima de uma leitura (long poll) no main. */
export const SCREEN_AUDIO_MAX_WAIT_MS = 250;

export interface ScreenAudioStatus {
    available: boolean;
    /** Motivo em pt-BR (para a UI) quando indisponivel; descricao curta quando disponivel. */
    reason: string;
}

export type ScreenAudioStart =
    | { ok: true; id: number; sampleRate: number; channels: number; }
    | { ok: false; reason: string; };

export interface ScreenAudioRead {
    /** Frames inteiros de float32 estereo intercalado; null se nada chegou dentro da espera. */
    pcm: Uint8Array | null;
    /** A captura acabou (helper saiu, foi parada ou o id e antigo): pare de ler. */
    ended: boolean;
    /** Motivo em pt-BR quando ended. */
    reason?: string;
}

/** Funcoes que o native.ts precisa exportar (mesmos nomes); o renderer confere se existem. */
export interface ScreenAudioNativeApi {
    screenAudioStatus(): Promise<ScreenAudioStatus>;
    startScreenAudio(): Promise<ScreenAudioStart>;
    readScreenAudio(id: number, maxWaitMs: number): Promise<ScreenAudioRead>;
    stopScreenAudio(id?: number): Promise<void>;
}
