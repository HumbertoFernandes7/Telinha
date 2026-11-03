/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Detector de "jogo pesado" para a opcao "Tempo real (teste)" da prioridade da captura na placa de video. Funcao pura (sem
// relogio, sem native, sem log): recebe o estado, a ultima leitura do peso da live (core/liveWeight.ts) e o "agora", e diz
// se a prioridade deve ir para o tempo real ou voltar para alta. Quem chama (core/captureBoost.ts) guarda o estado, pede a
// troca ao main e escreve o log.
//
// Regras:
//   - Pesado: o jogo (dono da janela capturada, ou o maior 3D fora do Discord na tela inteira) com 3D >= HEAVY_GAME_3D e a
//     placa no total com 3D >= HEAVY_TOTAL_3D. Uma leitura ja basta (ela e a media de 10 s).
//   - Leve: sem jogo, ou jogo com 3D < LIGHT_GAME_3D, ou placa no total com 3D < LIGHT_TOTAL_3D. Precisa de LIGHT_READINGS
//     leituras leves seguidas para voltar para alta.
//   - Entre os dois limites (faixa de histerese) fica como esta e a contagem de leves zera. O tempo real tira fatia da placa
//     do jogo (o 3D dele cai um pouco depois da troca), entao os limites de volta ficam bem abaixo dos de ida: a troca nao
//     se desfaz sozinha.
//   - Entre uma troca e a seguinte passam MIN_SWITCH_MS (menos a primeira) e, por transmissao, no maximo MAX_SWITCHES trocas
//     (cada troca e um risco com o HAGS): depois disso fica onde esta ("frozen").
//   - Sem o peso da live por NO_WEIGHT_MS: nao da para saber se um jogo pesa; avisa uma vez e, se estava em tempo real,
//     volta para alta (e o caminho seguro, vale mesmo depois de "frozen").

import type { LiveWeight } from "./liveWeight";

/** jogo (dono da janela, ou o maior 3D fora do Discord na tela inteira): 3D a partir daqui e pesado */
export const HEAVY_GAME_3D = 60;
/** placa no total: 3D a partir daqui e pesado */
export const HEAVY_TOTAL_3D = 90;
/** jogo com 3D abaixo disto e leve */
export const LIGHT_GAME_3D = 40;
/** placa no total com 3D abaixo disto e leve */
export const LIGHT_TOTAL_3D = 75;
/** leituras leves seguidas para voltar para alta: ~30 s (uma leitura = media de 10 s, core/liveWeight.ts STATS_LOG_MS) */
export const LIGHT_READINGS = 3;
export const MIN_SWITCH_MS = 60_000;
/** trocas por transmissao; depois fica onde esta */
export const MAX_SWITCHES = 6;
export const NO_WEIGHT_MS = 30_000;

/** cada leitura vale 10 s (so para o texto do motivo) */
const READING_SECONDS = 10;

export type AutoWant = "high" | "realtime";

export interface AutoState {
    want: AutoWant;
    /** o `at` da ultima leitura ja considerada */
    lastAt: number | null;
    /** leituras leves seguidas (so conta em tempo real) */
    light: number;
    /** quando foi a ultima troca (ou o comeco da transmissao) */
    switchedAt: number;
    switches: number;
    /** desde quando nao ha leitura do peso da live; null = ha */
    noWeightSince: number | null;
    /** o aviso de "sem o peso da live" ja saiu nesta falta de leitura */
    noWeightNoted: boolean;
    /** MAX_SWITCHES atingido: nao troca mais (so o caminho seguro "sem o peso da live" ainda volta para alta) */
    frozen: boolean;
}

export interface AutoDecision {
    state: AutoState;
    /** so quando muda: o novo modo e o motivo (para o log) */
    change: { to: AutoWant; why: string; } | null;
    /** um aviso para o log (sem troca, ou junto dela) */
    note: string | null;
}

export function initialAutoState(now: number): AutoState {
    return { want: "high", lastAt: null, light: 0, switchedAt: now, switches: 0, noWeightSince: null, noWeightNoted: false, frozen: false };
}

const pct = (v: number) => `${Math.round(v)}%`;
const wantText = (w: AutoWant) => (w === "realtime" ? "tempo real" : "alta");

function gameLabel(game: NonNullable<LiveWeight["game"]>): string {
    const name = game.name ?? `processo ${game.pid}`;
    return game.source === "window" ? `jogo ${name}` : `maior 3D fora do Discord: ${name}`;
}

function isHeavy(w: LiveWeight): boolean {
    return !!w.game && w.game.load3D >= HEAVY_GAME_3D && w.total["3D"] >= HEAVY_TOTAL_3D;
}

function isLight(w: LiveWeight): boolean {
    return !w.game || w.game.load3D < LIGHT_GAME_3D || w.total["3D"] < LIGHT_TOTAL_3D;
}

function heavyWhy(w: LiveWeight): string {
    return `${gameLabel(w.game!)} 3D ${pct(w.game!.load3D)}, placa no total ${pct(w.total["3D"])}`;
}

function lightWhy(w: LiveWeight): string {
    const secs = `há ${LIGHT_READINGS * READING_SECONDS} s`;
    if (!w.game) return `nenhum jogo usando a placa ${secs}`;
    if (w.game.load3D < LIGHT_GAME_3D) return `${gameLabel(w.game)} 3D ${pct(w.game.load3D)} ${secs}`;
    return `placa no total ${pct(w.total["3D"])} ${secs}`;
}

/** Aplica uma troca ao estado; no MAX_SWITCHES congela e avisa. */
function switchTo(s: AutoState, to: AutoWant, why: string, now: number, extra: Partial<AutoState> = {}): AutoDecision {
    const switches = s.switches + 1;
    const frozen = s.frozen || switches >= MAX_SWITCHES;
    const state: AutoState = { ...s, ...extra, want: to, light: 0, switchedAt: now, switches, frozen };
    const note = !s.frozen && frozen ? `trocando demais: fica em ${wantText(to)} até o fim da transmissão` : null;
    return { state, change: { to, why }, note };
}

/**
 * Uma leitura nova (w.at diferente de lastAt) ou nenhuma. Devolve o estado novo e, so quando muda, a troca e o motivo.
 * Nunca muda o estado recebido.
 */
export function decide(s: AutoState, w: LiveWeight | null, now: number): AutoDecision {
    if (!w) {
        const since = s.noWeightSince ?? now;
        if (now - since < NO_WEIGHT_MS) return { state: { ...s, noWeightSince: since }, change: null, note: null };
        const note = s.noWeightNoted ? null : "sem o peso da live: não dá para saber se um jogo pesa; fica em alta";
        const base = { noWeightSince: since, noWeightNoted: true };
        if (s.want === "realtime") {
            const d = switchTo(s, "high", "sem o peso da live", now, base);
            return { ...d, note: note ?? d.note };
        }
        return { state: { ...s, ...base }, change: null, note };
    }

    const s1: AutoState = s.noWeightSince === null && !s.noWeightNoted ? s : { ...s, noWeightSince: null, noWeightNoted: false };
    if (w.at === s1.lastAt) return { state: s1, change: null, note: null };

    const seen: AutoState = { ...s1, lastAt: w.at };
    if (seen.frozen) return { state: { ...seen, light: 0 }, change: null, note: null };
    const canSwitch = seen.switches === 0 || now - seen.switchedAt >= MIN_SWITCH_MS;

    if (isHeavy(w)) {
        const kept: AutoState = { ...seen, light: 0 };
        if (seen.want === "high" && canSwitch) return switchTo(kept, "realtime", heavyWhy(w), now);
        return { state: kept, change: null, note: null };
    }
    if (isLight(w)) {
        if (seen.want !== "realtime") return { state: { ...seen, light: 0 }, change: null, note: null };
        const light = seen.light + 1;
        const counted: AutoState = { ...seen, light };
        if (light >= LIGHT_READINGS && canSwitch) return switchTo(counted, "high", lightWhy(w), now);
        return { state: counted, change: null, note: null };
    }
    return { state: { ...seen, light: 0 }, change: null, note: null };
}
