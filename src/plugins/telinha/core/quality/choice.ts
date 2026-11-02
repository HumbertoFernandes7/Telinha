/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A qualidade escolhida, como no Discord: resolucao (720p, 1080p ou 2K = 1440p) x fps (30 ou 60), as 6 combinacoes. Os
// seletores Resolução e FPS (seletor de fonte e barra do Telinha), as opcoes padrao (settings.ts) e a migracao da opcao
// antiga "Qualidade padrão" (3 combinacoes juntas, ate a v0.3.x). Puro: nada roda no carregamento.
//
// Versoes misturadas: a qualidade so existe neste PC. A presenca leva o tamanho e o fps da captura (protocol.ts →
// PresenceStream: width, height, fps, numeros quaisquer >= 0), nunca o nome, entao uma versao antiga ve uma transmissao
// 2K como qualquer outra (2560x1440).

import type { FrameRate, Quality, Resolution } from "@plugins/telinha/types";

import { fitToSource } from "./levels";

export const RESOLUTIONS: readonly Resolution[] = [720, 1080, 1440];
export const FRAME_RATES: readonly FrameRate[] = [30, 60];

/** O que vem marcado sem escolha (as opcoes padrao em settings.ts tem o mesmo): 1080p a 60 fps. */
export const DEFAULT_RESOLUTION: Resolution = 1080;
export const DEFAULT_FPS: FrameRate = 60;

/** Largura 16:9 de cada resolucao: o maximo que a captura pede (getDisplayMedia), junto com a altura. */
export const RESOLUTION_WIDTH: Record<Resolution, number> = { 720: 1280, 1080: 1920, 1440: 2560 };

/** O nome nos seletores. */
export const RESOLUTION_LABEL: Record<Resolution, string> = { 720: "720p", 1080: "1080p", 1440: "2K" };

/** O que o 2K precisa (dica do seletor de fonte, tooltip do botao 2K da barra). */
export const HINT_2K = "2K (1440p) precisa de uma tela 2K: numa tela ou janela menor, vai no tamanho dela.";

export function qualityOf(resolution: Resolution, fps: FrameRate): Quality {
    return `${resolution}p${fps}`;
}

/** As 6 combinacoes, da menor resolucao para a maior. */
export const QUALITIES: readonly Quality[] = RESOLUTIONS.flatMap(r => FRAME_RATES.map(f => qualityOf(r, f)));

export function isResolution(value: unknown): value is Resolution {
    return RESOLUTIONS.some(r => r === value);
}

export function isFrameRate(value: unknown): value is FrameRate {
    return FRAME_RATES.some(f => f === value);
}

export function isQuality(value: unknown): value is Quality {
    return QUALITIES.some(q => q === value);
}

export function splitQuality(quality: Quality): { resolution: Resolution; fps: FrameRate; } {
    const [resolution, fps] = quality.split("p").map(Number);
    return { resolution: resolution as Resolution, fps: fps as FrameRate };
}

/** "2K · 60 fps", "1080p · 30 fps". */
export function qualityLabel(quality: Quality): string {
    const { resolution, fps } = splitQuality(quality);
    return `${RESOLUTION_LABEL[resolution]} · ${fps} fps`;
}

/** A qualidade das opcoes "Resolução padrão" e "FPS padrão"; cada valor invalido ou ausente vira o padrao (1080p, 60). */
export function qualityFromSettings(resolution: unknown, fps: unknown): Quality {
    return qualityOf(isResolution(resolution) ? resolution : DEFAULT_RESOLUTION, isFrameRate(fps) ? fps : DEFAULT_FPS);
}

export interface StoredQualitySettings {
    /** opcao antiga (ate a v0.3.x): "Qualidade padrão", "1080p60" | "720p60" | "1080p30" */
    defaultQuality?: unknown;
    /** opcoes novas: "Resolução padrão" e "FPS padrão" */
    defaultResolution?: unknown;
    defaultFps?: unknown;
}

/**
 * Migracao de "Qualidade padrão" para "Resolução padrão" + "FPS padrão": o par da escolha antiga ("1080p30" → 1080p e 30).
 * `resolution`/`fps` = o valor a gravar (null = nao mexer); `dropOld` = apagar a chave antiga. Uma escolha nova ja gravada
 * vence (como em access.ts → migrateAccessSetting); valor antigo desconhecido nao grava nada (valem os padroes).
 */
export function migrateQualitySetting(stored: StoredQualitySettings | null | undefined): { resolution: Resolution | null; fps: FrameRate | null; dropOld: boolean; } {
    const s = stored ?? {};
    const dropOld = Object.prototype.hasOwnProperty.call(s, "defaultQuality");
    if (!isQuality(s.defaultQuality)) return { resolution: null, fps: null, dropOld };
    const old = splitQuality(s.defaultQuality);
    return {
        resolution: isResolution(s.defaultResolution) ? null : old.resolution,
        fps: isFrameRate(s.defaultFps) ? null : old.fps,
        dropOld
    };
}

/**
 * 2K escolhido numa captura de 1080p ou menos (levels.fitToSource: nao amplia, vai no tamanho dela), para o log e a
 * barra: "2K escolhido, a tela tem 1080p: enviando 1080p". null = a captura comporta a resolucao escolhida.
 */
export function sourceSizeNote(quality: Quality, kind: "screen" | "window", sourceHeight: number): string | null {
    if (fitToSource(quality, sourceHeight) === quality) return null;
    const size = `${Math.round(sourceHeight)}p`;
    return `${RESOLUTION_LABEL[splitQuality(quality).resolution]} escolhido, a ${kind === "screen" ? "tela" : "janela"} tem ${size}: enviando ${size}`;
}
