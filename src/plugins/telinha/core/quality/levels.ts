/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Degraus da qualidade automatica. A captura continua na qualidade escolhida (teto); cada degrau
// so muda o encoder de UM espectador via RTCRtpSender.setParameters (scaleResolutionDownBy,
// maxFramerate, maxBitrate), sem renegociar.

import type { Quality, QualityLevel } from "@plugins/telinha/types";

export interface LevelSpec {
    height: number;
    fps: number;
    /** teto do encoder neste degrau (os tres primeiros batem com QUALITY em streaming.ts) */
    maxKbps: number;
    /** banda estimada abaixo disto: o degrau fica borrado demais, desce */
    minKbps: number;
}

export const LEVELS: Record<QualityLevel, LevelSpec> = {
    "1080p60": { height: 1080, fps: 60, maxKbps: 8000, minKbps: 4500 },
    "720p60": { height: 720, fps: 60, maxKbps: 5000, minKbps: 2500 },
    "1080p30": { height: 1080, fps: 30, maxKbps: 5000, minKbps: 2500 },
    "720p30": { height: 720, fps: 30, maxKbps: 2500, minKbps: 0 }
};

function levelOf(height: number, fps: number): QualityLevel {
    if (height >= 1080) return fps >= 60 ? "1080p60" : "1080p30";
    return fps >= 60 ? "720p60" : "720p30";
}

/** O mais restritivo dos dois (menor altura e menor fps): ex. 720p60 + 1080p30 = 720p30. */
export function meet(a: QualityLevel, b: QualityLevel): QualityLevel {
    return levelOf(Math.min(LEVELS[a].height, LEVELS[b].height), Math.min(LEVELS[a].fps, LEVELS[b].fps));
}

/** `a` e pior (ou igual) a `b` nas duas dimensoes. */
export function isAtMost(a: QualityLevel, b: QualityLevel): boolean {
    return LEVELS[a].height <= LEVELS[b].height && LEVELS[a].fps <= LEVELS[b].fps;
}

/** Ordem para "o pior entre os espectadores": menor taxa de pixels. */
export function rank(level: QualityLevel): number {
    return LEVELS[level].height * LEVELS[level].height * LEVELS[level].fps;
}

/**
 * Proximo degrau abaixo. De 1080p60: 720p60 para conteudo em movimento (jogos: mantem 60 fps) ou
 * 1080p30 para conteudo parado (texto nitido). Null = ja no piso (720p30).
 */
export function stepDown(level: QualityLevel, preferMotion: boolean): QualityLevel | null {
    switch (level) {
        case "1080p60": return preferMotion ? "720p60" : "1080p30";
        case "720p60":
        case "1080p30": return "720p30";
        default: return null;
    }
}

/** Proximo degrau acima sem passar do teto (a qualidade escolhida). Null = ja no teto. */
export function stepUp(level: QualityLevel, ceiling: Quality, preferMotion: boolean): QualityLevel | null {
    const options: QualityLevel[] = level === "720p30"
        ? (preferMotion ? ["720p60", "1080p30"] : ["1080p30", "720p60"])
        : level === "1080p60" ? [] : ["1080p60"];
    return options.find(l => isAtMost(l, ceiling)) ?? null;
}

export interface EncodingTarget {
    maxBitrate: number;
    maxFramerate: number;
    scaleResolutionDownBy: number;
}

/** Parametros do encoding para o degrau, relativos a altura real da captura. */
export function encodingFor(level: QualityLevel, captureHeight: number): EncodingTarget {
    const spec = LEVELS[level];
    const scale = captureHeight > spec.height * 1.02 ? captureHeight / spec.height : 1;
    return {
        maxBitrate: spec.maxKbps * 1000,
        maxFramerate: spec.fps,
        scaleResolutionDownBy: Math.round(scale * 1000) / 1000
    };
}

/** Pixels por segundo que o encoder processa no degrau (custo de CPU ~ proporcional). */
export function pixelRate(level: QualityLevel, captureWidth: number, captureHeight: number): number {
    const { scaleResolutionDownBy: s, maxFramerate } = encodingFor(level, captureHeight);
    return (captureWidth / s) * (captureHeight / s) * maxFramerate;
}

export function levelText(level: QualityLevel): string {
    return `${LEVELS[level].height}p ${LEVELS[level].fps} fps`;
}
