/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Peso da live" (lado do renderer; quem mede e o core/liveWeightMain.ts, no processo main): enquanto transmite, quanto
// da placa de video e do processador a live custa (o Discord todo) e quanto o jogo usa, para toda otimizacao poder ser
// provada com numeros. So mede: nenhuma decisao da qualidade automatica usa isto (ela recebe os numeros em
// QualityDeps.liveWeight, para o futuro).
//
// A cada STATS_LOG_MS (o mesmo ritmo das linhas "Envio p/", core/statsLog.ts), le a media desde a leitura anterior e
// escreve uma linha no log, ex.:
//   Peso da live: placa (Discord) 3D 4% · codificar 12% · copiar 2% · processador 6% — jogo Jogo.exe 3D 91% — placa no
//   total 3D 97% · codificar 12%
// Sem mudanca de LOG_CHANGE_POINTS pontos em nenhum numero (nem de jogo), a linha so sai de novo depois de LOG_REPEAT_MS.
// O log vai para o diagnostico compartilhado (core/diagShare.ts) sozinho; o "Copiar diagnóstico" tem a ultima leitura.
// Sem numeros (sem o typeperf, contadores recusados...), uma linha so com o motivo.

import type { LiveWeightReport } from "./liveWeightMain";
import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";
import { STATS_LOG_MS } from "./statsLog";

/** Uma linha nova so quando algum numero mudou pelo menos isto (pontos percentuais)... */
export const LOG_CHANGE_POINTS = 5;
/** ...ou quando a ultima linha ja tem isto. */
export const LOG_REPEAT_MS = 60_000;

/** o ticker da sessao e de 1 s: uma leitura a menos de meio segundo de STATS_LOG_MS ja vale (nao espera mais um tick) */
const TICK_SLACK_MS = 500;

/** Os numeros da ultima leitura com amostras (para a qualidade automatica: so medicao, nenhuma decisao usa ainda). */
export interface LiveWeight {
    /** performance.now() da leitura */
    at: number;
    discord: NonNullable<LiveWeightReport["discord"]>;
    discordCpu: number | null;
    discordGpuMemoryMb: number | null;
    game: LiveWeightReport["game"];
    total: NonNullable<LiveWeightReport["total"]>;
}

/** medindo nesta transmissao (o main respondeu ok) */
let active = false;
let reading = false;
let lastReadAt = -Infinity;
let latest: LiveWeight | null = null;
let latestLine: string | null = null;
let latestWall = 0;
let lastLogged: { at: number; values: number[]; game: string | null; } | null = null;
/** o motivo da ultima falha ja logado (a mesma falha nao ganha outra linha nesta partida) */
let failureLogged: string | null = null;
let failure: string | null = null;
let runs = 0;
/** a fonte capturada desta transmissao (o main acha o jogo pela janela) */
let source: string | null = null;

const pctText = (v: number) => `${Math.round(v)}%`;

/**
 * O jogo e o dono da janela capturada ("window"). Na tela inteira (ou sem achar o processo da janela) o Telinha nao sabe
 * qual e o jogo: cita o processo de fora do Discord com mais 3D, sem chamar de jogo ("top").
 */
function gameText(game: LiveWeightReport["game"]): string {
    if (!game) return "nada usando a placa fora do Discord";
    const name = game.name ?? `processo ${game.pid}`;
    return game.source === "window" ? `jogo ${name} 3D ${pctText(game.load3D)}` : `maior 3D fora do Discord: ${name} 3D ${pctText(game.load3D)}`;
}

/** A linha do log de uma leitura com amostras; null sem amostras. */
export function formatLiveWeightLine(r: Pick<LiveWeightReport, "discord" | "discordCpu" | "game" | "total">): string | null {
    if (!r.discord || !r.total) return null;
    const d = r.discord;
    const discord = [
        `3D ${pctText(d["3D"])}`,
        `codificar ${pctText(d.VideoEncode)}`,
        d.VideoDecode >= 0.5 && `decodificar ${pctText(d.VideoDecode)}`,
        `copiar ${pctText(d.Copy)}`,
        r.discordCpu != null && `processador ${pctText(r.discordCpu)}`
    ].filter(Boolean).join(" · ");
    const total = `3D ${pctText(r.total["3D"])} · codificar ${pctText(r.total.VideoEncode)}`;
    return `Peso da live: placa (Discord) ${discord} — ${gameText(r.game)} — placa no total ${total}`;
}

/** Os numeros que a linha mostra (para saber se mudou o bastante). */
function shownValues(w: LiveWeight): number[] {
    const d = w.discord;
    return [d["3D"], d.VideoEncode, d.VideoDecode, d.Copy, w.discordCpu ?? 0, w.game?.load3D ?? 0, w.total["3D"], w.total.VideoEncode];
}

function shouldLog(w: LiveWeight, game: string | null): boolean {
    const last = lastLogged;
    if (!last || w.at - last.at >= LOG_REPEAT_MS || last.game !== game) return true;
    const now = shownValues(w);
    return now.some((v, i) => Math.abs(Math.round(v) - Math.round(last.values[i])) >= LOG_CHANGE_POINTS);
}

function noteFailure(reason: string) {
    failure = reason;
    active = false;
    if (failureLogged === reason) return;
    failureLogged = reason;
    log.warn(`Peso da live: sem números nesta transmissão (${reason}); a transmissão continua normal`);
}

function isReport(v: unknown): v is LiveWeightReport {
    return !!v && typeof v === "object" && typeof (v as LiveWeightReport).state === "string" && typeof (v as LiveWeightReport).samples === "number";
}

/**
 * Uma transmissao comecou (core/streaming.ts), com a fonte capturada: o main comeca a medir. Trocar de fonte no ar continua
 * a mesma medicao, so com a fonte nova (o jogo e o dono da janela). Nunca lanca.
 */
export async function startLiveWeight(sourceId: string | null = source): Promise<void> {
    const native = getNativeOrNull();
    if (typeof native?.startLiveWeight !== "function") return;
    source = sourceId;
    if (active) {
        Promise.resolve(native.startLiveWeight(sourceId)).catch(() => { });
        return;
    }
    active = true;
    failure = null;
    latest = null;
    latestLine = null;
    lastLogged = null;
    lastReadAt = performance.now();
    try {
        const res = await native.startLiveWeight(sourceId);
        if (!active) return;
        if (!res?.ok) noteFailure(res?.reason ?? "o processo main não respondeu");
    } catch (e) {
        if (active) noteFailure(`o pedido falhou: ${errorText(e)}`);
    }
}

/** Uma vez por segundo enquanto transmite (core/streaming.ts → tick): a cada STATS_LOG_MS, le e loga. Nunca lanca. */
export function liveWeightTick(): void {
    if (!active || reading) return;
    const now = performance.now();
    if (now - lastReadAt < STATS_LOG_MS - TICK_SLACK_MS) return;
    lastReadAt = now;
    void read();
}

async function read(): Promise<void> {
    const native = getNativeOrNull();
    if (typeof native?.readLiveWeight !== "function") return;
    reading = true;
    try {
        const r = await native.readLiveWeight();
        if (!active || !isReport(r)) return;
        runs = r.runs;
        if (r.state === "unavailable") return noteFailure(r.reason ?? "o typeperf.exe parou");
        // a medicao parou sozinha no main (o renderer demorou demais a ler): comeca de novo
        if (r.state === "off") {
            active = false;
            void startLiveWeight();
            return;
        }
        const line = formatLiveWeightLine(r);
        if (!line || !r.discord || !r.total) return;
        const w: LiveWeight = { at: performance.now(), discord: r.discord, discordCpu: r.discordCpu, discordGpuMemoryMb: r.discordGpuMemoryMb, game: r.game, total: r.total };
        latest = w;
        latestLine = line;
        latestWall = Date.now();
        const game = r.game ? `${r.game.source} ${r.game.name ?? r.game.pid}` : null;
        if (shouldLog(w, game)) {
            lastLogged = { at: w.at, values: shownValues(w), game };
            log.info(line);
        }
    } catch (e) {
        if (active) noteFailure(`a leitura falhou: ${errorText(e)}`);
    } finally {
        reading = false;
    }
}

/**
 * A transmissao acabou (core/streaming.ts → stopStreaming): o main para de medir. Pede SEMPRE, mesmo sem medicao ativa aqui
 * (uma leitura que falhou desliga o lado do renderer, mas o typeperf pode seguir no main). Nunca lanca.
 */
export function stopLiveWeight(): void {
    active = false;
    source = null;
    const native = getNativeOrNull();
    if (typeof native?.stopLiveWeight !== "function") return;
    native.stopLiveWeight().catch(() => { });
}

/** A ultima leitura com numeros desta transmissao (QualityDeps.liveWeight); null = nenhuma ainda, ou sem medicao. */
export function currentLiveWeight(): LiveWeight | null {
    return active ? latest : null;
}

/** Para o "Copiar diagnóstico". */
export function liveWeightDiagnostics(): string {
    const native = getNativeOrNull();
    if (typeof native?.startLiveWeight !== "function") return "peso da live: a parte nativa não tem a medição";
    const state = active ? "medindo nesta transmissão (typeperf.exe a cada 5 s)" : failure ? `sem números (${failure})` : "parado (só mede transmitindo)";
    const runText = runs ? `; execuções do typeperf: ${runs}` : "";
    if (!latestLine || !latest) return `peso da live: ${state}${runText}; nenhuma leitura ainda`;
    const mem = latest.discordGpuMemoryMb != null ? `; memória da placa (Discord) ${Math.round(latest.discordGpuMemoryMb)} MB` : "";
    const d = latest.discord;
    return `peso da live: ${state}${runText}; última leitura às ${new Date(latestWall).toISOString().slice(11, 19)} UTC: ${latestLine.replace(/^Peso da live: /, "")}`
        + `${d.VideoDecode < 0.5 ? " (decodificar 0%)" : ""}${mem}`;
}

/** So para testes: esquece tudo. */
export function resetLiveWeightRendererForTests() {
    active = false;
    reading = false;
    lastReadAt = -Infinity;
    latest = null;
    latestLine = null;
    latestWall = 0;
    lastLogged = null;
    failureLogged = null;
    failure = null;
    runs = 0;
    source = null;
}
