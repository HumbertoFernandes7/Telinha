/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
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

// espectador novo: a estimativa de banda oscila nos primeiros segundos (cai para ~0,5 Mbps e volta); nao desce por banda antes disto
export const BW_GRACE_MS = 20_000;

/**
 * O espectador ainda esta na carencia de banda: `readyAt` e o instante (ms) em que o sender dele ficou
 * pronto (Infinity = ainda nao ficou). Problemas de banda dele sao ignorados enquanto isto for true.
 */
export function inBandwidthGrace(readyAt: number, now: number): boolean {
    return now - readyAt < BW_GRACE_MS;
}

export const LEVELS: Record<QualityLevel, LevelSpec> = {
    "1080p60": { height: 1080, fps: 60, maxKbps: 20000, minKbps: 4500 },
    "720p60": { height: 720, fps: 60, maxKbps: 12000, minKbps: 2500 },
    "1080p30": { height: 1080, fps: 30, maxKbps: 12000, minKbps: 2500 },
    "720p30": { height: 720, fps: 30, maxKbps: 6000, minKbps: 0 }
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

/**
 * Lado (largura ou altura) que o WebRTC codifica com scaleResolutionDownBy `scale`: o inteiro mais proximo
 * (EncoderStreamFactory: static_cast<int>(lado / escala + 0.5)). Conferido no Electron 44.9.3 (Chromium 152) com
 * captura de janela: 1798x1080 ÷1,5 = 1199x720, 1904x1040 ÷1,501 = 1268x693, 1798x1080 ÷1,501 = 1198x720.
 */
export function scaledSide(side: number, scale: number): number {
    return scale > 1 ? Math.floor(side / scale + 0.5) : side;
}

/** Tamanho que o encoder recebe com a escala `scale` (scaledSide nos dois lados). */
export function scaledSize(width: number, height: number, scale: number): { width: number; height: number; } {
    return { width: scaledSide(width, scale), height: scaledSide(height, scale) };
}

function roundTo(value: number, decimals: number): number {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
}

function evenAt(width: number, height: number, scale: number): boolean {
    return scaledSide(width, scale) % 2 === 0 && scaledSide(height, scale) % 2 === 0;
}

/** Ate quantas alturas pares abaixo do degrau (2 px cada) a busca por um tamanho par desce. Na pratica 0 ou 1 bastam. */
const EVEN_SEARCH_STEPS = 8;

/** A escala com menos casas decimais (3 a 6) em (lo, hi]; senao o meio da faixa. */
function shortestIn(lo: number, hi: number): number {
    const mid = (lo + hi) / 2;
    for (let d = 3; d <= 6; d++) {
        const s = roundTo(mid, d);
        if (s > lo && s <= hi) return s;
    }
    return mid;
}

/**
 * scaleResolutionDownBy que leva a captura `width`x`height` para a altura `targetHeight` (ou ate 16 px abaixo) com
 * largura E altura PARES. O RTCVideoEncoder do Chromium so codifica H.264 na placa de video em tamanho par
 * (codec.ts → h264HwAcceptsSize); fora disso o WebRTC usa o OpenH264 (por software) e, como a reducao e nossa, o
 * tamanho nao muda sozinho: o espectador ficaria no OpenH264 ate o degrau mudar (nao conta como queda). A escala
 * simples (altura / alvo, 3 casas) da tamanho impar em metade das capturas de janela entre 736 e 1080 de altura, ex.:
 * 1798x1080 ÷1,5 = 1199x720 (OpenH264, medido); aqui sai ÷1,501 = 1198x720 (placa de video, medido).
 * Mantem a escala simples quando ela ja da par (ex.: 1920x1080 ÷1,5 = 1280x720) ou quando nao precisa reduzir (<= 1).
 */
export function evenScale(width: number, height: number, targetHeight: number): number {
    const plain = roundTo(height / targetHeight, 3);
    if (plain <= 1 || evenAt(width, height, plain)) return plain;
    let h = targetHeight - (targetHeight % 2);
    for (let step = 0; step < EVEN_SEARCH_STEPS && h > 0; step++, h -= 2) {
        // escalas que dao a altura h: height / (h + 0,5) < s <= height / (h - 0,5)
        const hLo = height / (h + 0.5);
        const hHi = height / (h - 0.5);
        // larguras pares possiveis nessa faixa, a mais perto da proporcao da captura primeiro
        const near = 2 * Math.round((width * h) / height / 2);
        for (const w of [near, near - 2, near + 2]) {
            if (w <= 0) continue;
            const lo = Math.max(hLo, width / (w + 0.5));
            const hi = Math.min(hHi, width / (w - 0.5));
            if (hi <= lo) continue;
            const s = shortestIn(lo, hi);
            if (s > 1 && scaledSide(width, s) === w && scaledSide(height, s) === h) return s;
        }
    }
    return plain;
}

/**
 * Parametros do encoding para o degrau, relativos ao tamanho real da captura. A reducao (scaleResolutionDownBy) sai
 * em tamanho par sempre que possivel (evenScale), para o H.264 continuar na placa de video.
 */
export function encodingFor(level: QualityLevel, captureWidth: number, captureHeight: number): EncodingTarget {
    const spec = LEVELS[level];
    const scale = captureHeight > spec.height * 1.02 ? evenScale(captureWidth, captureHeight, spec.height) : 1;
    return {
        maxBitrate: spec.maxKbps * 1000,
        maxFramerate: spec.fps,
        scaleResolutionDownBy: scale
    };
}

/** Pixels por segundo que o encoder processa no degrau (custo de CPU ~ proporcional). */
export function pixelRate(level: QualityLevel, captureWidth: number, captureHeight: number): number {
    const { scaleResolutionDownBy: s, maxFramerate } = encodingFor(level, captureWidth, captureHeight);
    return (captureWidth / s) * (captureHeight / s) * maxFramerate;
}

export function levelText(level: QualityLevel): string {
    return `${LEVELS[level].height}p ${LEVELS[level].fps} fps`;
}
