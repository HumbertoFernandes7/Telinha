/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Log de estatisticas, so para diagnostico: nada aqui muda o envio, a recepcao ou as decisoes da qualidade automatica.
// A cada STATS_LOG_MS sai uma linha por envio no PC de quem transmite (com as leituras de ~2 s que a qualidade
// automatica ja faz, quality/controller.ts; mais uma linha a cada troca de degrau) e uma por transmissao assistida no
// PC de quem assiste (viewing.ts → sampleStats, tambem a cada ~2 s), e um resumo quando o envio / a recepcao acaba.
// Contadores entram como diferenca na janela; o que o Chromium nao expoe fica fora da linha (nunca "NaN" nem
// "undefined"). Sem IPs, portas nem SSRC: da conexao, so o tipo dos candidatos (host, srflx, relay).

import type { QualityLevel } from "@plugins/telinha/types";

import { errorText, logThrottled } from "./log";
import { LEVELS } from "./quality/levels";
import { delta, diffSamples, linkWindow, NO_LINK_COUNTERS, ratio, type SenderSample, type WindowMetrics } from "./quality/stats";
import { TEREDO_TEXT, type TeredoSide } from "./teredo";

/** Intervalo das linhas periodicas (por envio e por transmissao assistida). */
export const STATS_LOG_MS = 10_000;
/** Uma falha do log de estatisticas sai no log no maximo uma vez neste intervalo (as repeticoes so contam). */
const STATS_LOG_ERROR_MS = 10 * 60_000;

/**
 * Roda um gancho do log de estatisticas (quality/controller.ts, viewing.ts). O log e so diagnostico: uma excecao dele
 * nunca chega em quem chamou (as decisoes da qualidade automatica, os applies, a recepcao seguem); sai um aviso no log,
 * no maximo um a cada STATS_LOG_ERROR_MS. undefined = o gancho falhou.
 */
export function guardStatsLog<T>(fn: () => T): T | undefined {
    try {
        return fn();
    } catch (e) {
        logThrottled("stats-log", "warn", `O log de estatísticas falhou (só diagnóstico: a transmissão e a recepção continuam): ${errorText(e)}`, STATS_LOG_ERROR_MS);
        return undefined;
    }
}
/** As leituras sao a cada ~2 s e atrasam alguns ms: uma janela a menos de 1 s de STATS_LOG_MS ja fecha. */
const STATS_LOG_SLACK_MS = 1000;
/** Janelas de ~2 s guardadas para as medianas do resumo (~11 h); depois disso as medianas ficam com as primeiras. */
const MAX_MEDIAN_WINDOWS = 20_000;
/** Trocas de nivel listadas no resumo (as primeiras; o resto so conta). */
const MAX_LISTED_CHANGES = 6;
/** Tamanhos e fps medidos listados no resumo (os de mais tempo; o resto vira "outros"). */
const MAX_LISTED_SHARES = 4;

/** As linhas deste modulo (os testes que conferem o log linha a linha as deixam de fora). */
export const STATS_LINE_RE = /^(?:Envio p\/|Recepção de|Resumo do envio p\/|Resumo da recepção de) /;

// #region formatacao

/** Uma casa decimal com virgula, ex.: 29,8. */
const dec = (v: number) => v.toFixed(1).replace(".", ",");
const int = (v: number) => String(Math.round(v));
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** O que esta presente, separado por `sep` (null, "" e false ficam de fora). */
function join(parts: readonly (string | null | false)[], sep = " "): string {
    return parts.filter(Boolean).join(sep);
}

/** `fn(v)` se `v` existe; senao null (o pedaco sai da linha). */
function opt<T, R>(v: T | null | undefined, fn: (v: T) => R): R | null {
    return v == null ? null : fn(v);
}

/**
 * Codec, implementacao e "[hw]" quando roda na placa de video, ex.: "H264 NVIDIA H.264 Encoder MFT [hw]". O invólucro
 * do Media Foundation sai (so o fabricante entre parenteses, ou "MF") para a linha caber em ~300 caracteres.
 */
function coder(mimeType: string | null, implementation: string | null, hardware: boolean | null): string {
    return join([
        opt(mimeType, m => m.replace(/^[a-z]+\//i, "").toUpperCase()),
        opt(implementation, i => i.replace(/^MediaFoundationVideo(?:En|De)codeAccelerator(?: \((.+)\))?$/, (_, vendor?: string) => vendor ?? "MF")),
        hardware === true && "[hw]"
    ]);
}

const size = (width: number, height: number) => (width && height ? `${width}x${height}` : null);

/** Duracao legivel: "45 s", "12 min 30 s", "1 h 05 min". */
export function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const min = Math.floor(s / 60);
    if (min < 60) return `${min} min ${s % 60} s`;
    return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

function median(values: readonly number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Soma que ignora o que falta (null + null = null). */
const add = (acc: number | null, v: number | null) => (v == null ? acc : (acc ?? 0) + v);

function pushCapped(list: number[], v: number | null) {
    if (v != null && list.length < MAX_MEDIAN_WINDOWS) list.push(v);
}

/** A janela do log comecou ha STATS_LOG_MS (com a folga da amostragem)? */
const logDue = (base: { at: number; }, cur: { at: number; }) => cur.at - base.at >= STATS_LOG_MS - STATS_LOG_SLACK_MS;

/** Soma `ms` na chave `key`. */
function addTime<K>(map: Map<K, number>, key: K, ms: number) {
    map.set(key, (map.get(key) ?? 0) + ms);
}

/** "1920x1080 92%, 1280x720 8%": as chaves de mais tempo primeiro, as demais somadas em "outros". */
function shares<K>(map: Map<K, number>, label: (key: K) => string): string | null {
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    if (!total) return null;
    const sorted = [...map].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, MAX_LISTED_SHARES).map(([k, ms]) => `${label(k)} ${Math.round(ms / total * 100)}%`);
    const rest = sorted.slice(MAX_LISTED_SHARES).reduce((a, [, ms]) => a + ms, 0);
    return [...shown, ...(rest ? [`outros ${Math.round(rest / total * 100)}%`] : [])].join(", ");
}

/** "rota srflx/srflx via Teredo (este PC)": o tipo dos candidatos (se `route`) e o marcador do Teredo (se `teredo`). */
function routeText(route: string | null, teredo: TeredoSide | null | undefined): string | null {
    if (!route && !teredo) return null;
    return `rota ${join([route, !!teredo && TEREDO_TEXT[teredo]])}`;
}

// #endregion

// #region envio (quem transmite)

/** Degraus do espectador na hora da linha (quality/controller.ts). */
export interface SenderLevels {
    /** o efetivo: o mais restritivo entre o global e o da banda dele */
    level: QualityLevel;
    /** teto pela banda dele */
    bw: QualityLevel;
    /** degrau global (CPU, placa de video, upload) */
    global: QualityLevel;
    /** qualidade automatica ligada */
    auto: boolean;
}

/** Uma janela de envio entre duas leituras, com o que so o log usa. */
export interface SenderWindow {
    m: WindowMetrics;
    mimeType: string | null;
    implementation: string | null;
    width: number;
    height: number;
    targetKbps: number | null;
    rtxKbps: number | null;
    /** pacotes perdidos (relatados pelo espectador) e pacotes de midia enviados; so com os dois (perda = um / outro) */
    lost: number | null;
    media: number | null;
    lossPct: number | null;
    rttMs: number | null;
    jitterMs: number | null;
    nacks: number | null;
    plis: number | null;
    keyframes: number | null;
    qp: number | null;
    /** espera media de um pacote no pacer (ΔtotalPacketSendDelay / ΔpacketsSent) */
    pacerMs: number | null;
    route: string | null;
    /** o par em uso passa pelo Teredo (core/teredo.ts) */
    teredo: TeredoSide | null;
    /** trocas de resolucao feitas pelo proprio WebRTC na janela (qualityLimitationResolutionChanges) */
    resChanges: number | null;
}

/** A janela prev → cur (diffSamples + os contadores do log); null = curta demais ou contadores reiniciados. */
export function senderWindow(prev: SenderSample, cur: SenderSample): SenderWindow | null {
    const m = diffSamples(prev, cur);
    if (!m) return null;
    const a = prev.log ?? NO_LINK_COUNTERS;
    const b = cur.log ?? NO_LINK_COUNTERS;
    const link = linkWindow(a, b);
    return {
        m,
        mimeType: b.mimeType,
        implementation: cur.implementation,
        width: cur.frameWidth,
        height: cur.frameHeight,
        targetKbps: b.targetKbps,
        rtxKbps: opt(delta(a.retransmittedBytesSent, b.retransmittedBytesSent), bytes => bytes * 8 / 1000 / m.dt),
        lost: link.lost,
        media: link.media,
        lossPct: link.lossPct,
        rttMs: link.rttMs,
        jitterMs: b.jitterMs,
        nacks: delta(a.nackCount, b.nackCount),
        plis: delta(a.pliCount, b.pliCount),
        keyframes: delta(a.keyFramesEncoded, b.keyFramesEncoded),
        qp: ratio(delta(a.qpSum, b.qpSum), cur.framesEncoded - prev.framesEncoded),
        pacerMs: link.pacerMs,
        route: b.route,
        teredo: b.teredo ?? null,
        resChanges: delta(a.resolutionChanges ?? null, b.resolutionChanges ?? null)
    };
}

function levelsText(l: SenderLevels): string {
    if (!l.auto) return `${l.level} fixo`;
    return l.bw === l.global ? l.level : `${l.level} (banda ${l.bw}, geral ${l.global})`;
}

/**
 * Linha de UM envio, ex.: "Envio p/ leo (abc123): VP9 libvpx 1280x720 29,8 fps (fonte 59) · alvo 1800 enviado 1650 rtx 40
 * est 2100 kbps · perda 0,8% rtt 34 ms jitter 6 ms · nack 12 pli 0 kf 0 · fila 3 ms · lim banda 20% cpu 0% res WebRTC 0 ·
 * 9,2 ms/q qp 34 · nível 720p30". `route`: tipo dos candidatos, so quando muda; o marcador do Teredo sai em toda linha.
 * `change`: a troca de nivel que acabou de acontecer (a linha logo depois da decisao), ex.: "1080p60 (banda: perda)".
 */
export function formatSenderLine(label: string, w: SenderWindow, levels: SenderLevels, route: string | null, change: string | null = null): string {
    const { m } = w;
    return `Envio p/ ${label}: ` + join([
        join([coder(w.mimeType, w.implementation, m.hardware), size(w.width, w.height), `${dec(m.encodedFps)} fps`, opt(m.sourceFps, f => `(fonte ${int(f)})`)]),
        join([opt(w.targetKbps, k => `alvo ${int(k)}`), `enviado ${int(m.sentKbps)}`, opt(w.rtxKbps, k => `rtx ${int(k)}`), opt(m.availableKbps, k => `est ${int(k)}`), "kbps"]),
        join([opt(w.lossPct, p => `perda ${dec(p)}%`), opt(w.rttMs, v => `rtt ${int(v)} ms`), opt(w.jitterMs, v => `jitter ${int(v)} ms`)]),
        join([opt(w.nacks, n => `nack ${n}`), opt(w.plis, n => `pli ${n}`), opt(w.keyframes, n => `kf ${n}`)]),
        opt(w.pacerMs, v => `fila ${int(v)} ms`),
        join([`lim banda ${pct(m.bandwidthFraction)} cpu ${pct(m.cpuFraction)}`, opt(w.resChanges, n => `res WebRTC ${n}`)]),
        join([opt(m.encodeMsPerFrame, v => `${dec(v)} ms/q`), opt(w.qp, v => `qp ${int(v)}`)]),
        `nível ${levelsText(levels)}` + (change ? `, antes ${change}` : ""),
        routeText(route, w.teredo)
    ], " · ");
}

/**
 * O log de UM envio (um espectador): recebe as leituras de ~2 s da qualidade automatica (add), solta a linha
 * periodica / a da troca de degrau (line), soma o tempo em cada degrau (trackLevel) e monta o resumo (summary).
 */
export class SenderLog {
    private readonly startedAt: number;
    /** inicio da janela da proxima linha */
    private base: SenderSample | null = null;
    /** tipo dos candidatos ja logado (so volta a aparecer quando muda) */
    private loggedRoute: string | null = null;
    private level: QualityLevel | null = null;
    private levelSince = 0;
    private readonly levelMs = new Map<QualityLevel, number>();
    private changes = 0;
    /** as trocas de nivel para o resumo, ex.: "1080p60→720p60 (banda: perda) aos 45 s" (as MAX_LISTED_CHANGES primeiras) */
    private readonly changeList: string[] = [];
    /** a troca que a proxima linha forcada mostra, ex.: "1080p60 (banda: perda)" */
    private lastChange: string | null = null;
    /** tempo (ms) em cada tamanho codificado e em cada fps medido (arredondado a 5) */
    private readonly sizeMs = new Map<string, number>();
    private readonly fpsMs = new Map<number, number>();
    /** trocas de resolucao do proprio WebRTC (null = o Chromium nao expos) */
    private resChanges: number | null = null;
    private teredo: TeredoSide | null = null;
    private windows = 0;
    private seconds = 0;
    private frames = 0;
    private readonly estKbps: number[] = [];
    private readonly sentKbps: number[] = [];
    private lost: number | null = null;
    private media: number | null = null;
    private rttSum: number | null = null;
    private rttCount = 0;
    private keyframes: number | null = null;
    private route: string | null = null;

    constructor(now: number) {
        this.startedAt = now;
    }

    /** Leitura nova; a janela desde `prev` (a leitura anterior) entra no resumo. */
    add(prev: SenderSample | null, cur: SenderSample) {
        this.base ??= cur;
        const w = prev && senderWindow(prev, cur);
        if (!w) return;
        this.windows++;
        this.seconds += w.m.dt;
        this.frames += w.m.encodedFps * w.m.dt;
        const sized = size(w.width, w.height);
        if (sized) addTime(this.sizeMs, sized, w.m.dt * 1000);
        addTime(this.fpsMs, Math.round(w.m.encodedFps / 5) * 5, w.m.dt * 1000);
        this.resChanges = add(this.resChanges, w.resChanges);
        this.teredo = w.teredo ?? this.teredo;
        pushCapped(this.estKbps, w.m.availableKbps);
        pushCapped(this.sentKbps, w.m.sentKbps);
        this.lost = add(this.lost, w.lost);
        this.media = add(this.media, w.media);
        this.rttSum = add(this.rttSum, w.rttMs);
        if (w.rttMs != null) this.rttCount++;
        this.keyframes = add(this.keyframes, w.keyframes);
        this.route = w.route ?? this.route;
    }

    /**
     * Linha da janela desde a ultima linha (base → cur): a periodica, quando a janela chegou a STATS_LOG_MS; com
     * `force` (troca de degrau), a que houver. A proxima janela comeca em `cur`. null = nada a dizer.
     */
    line(cur: SenderSample, label: string, levels: SenderLevels, force = false): string | null {
        const { base } = this;
        if (!base || (!force && !logDue(base, cur))) return null;
        this.base = cur;
        const w = senderWindow(base, cur);
        const change = force ? this.lastChange : null;
        if (force) this.lastChange = null;
        if (!w) return null;
        const route = w.route !== this.loggedRoute ? w.route : null;
        if (route) this.loggedRoute = route;
        return formatSenderLine(label, w, levels, route, change);
    }

    /**
     * Degrau atual do espectador; true = mudou (conta a troca, o motivo `why` e o tempo no degrau anterior). `why`: o
     * motivo curto da troca (quality/controller.ts), ex.: "banda: perda", "CPU", "placa de vídeo: estável".
     */
    trackLevel(level: QualityLevel, now: number, why: string | null = null): boolean {
        if (level === this.level) return false;
        const from = this.level;
        this.closeLevel(now);
        this.level = level;
        if (from === null) return false;
        this.changes++;
        this.lastChange = why ? `${from} (${why})` : from;
        if (this.changeList.length < MAX_LISTED_CHANGES)
            this.changeList.push(`${from}→${level}${why ? ` (${why})` : ""} aos ${formatDuration(now - this.startedAt)}`);
        return true;
    }

    private closeLevel(now: number) {
        if (this.level) this.levelMs.set(this.level, (this.levelMs.get(this.level) ?? 0) + now - this.levelSince);
        this.levelSince = now;
    }

    /**
     * Resumo do envio quando o espectador para, ex.: "Resumo do envio p/ leo (abc123): 12 min 30 s · 2 trocas de nível:
     * 1080p60→720p60 (banda: perda) aos 3 min 10 s, 720p60→1080p60 (banda: estável) aos 4 min 2 s · 1080p60 70%, 720p60 30% ·
     * 60 fps 100%, 30 fps 0% · tamanho 1920x1080 70%, 1280x720 30% · fps medido 60 98%, 55 2% · res WebRTC 0 · 58,7 fps em
     * média · est mediana 9500 enviado mediana 8000 kbps · perda média 0,4% rtt médio 35 ms · kf 4 · rota host/srflx". O
     * tempo em 60/30 fps e pelo degrau; "tamanho" e "fps medido", o que o encoder de fato codificou. null = nenhuma janela
     * medida (nada a resumir).
     */
    summary(label: string, now: number): string | null {
        if (!this.windows) return null;
        this.closeLevel(now);
        const levels = (Object.keys(LEVELS) as QualityLevel[]).filter(l => this.levelMs.get(l));
        const total = levels.reduce((acc, l) => acc + this.levelMs.get(l)!, 0);
        const share = (ms: number) => Math.round(ms / total * 100);
        const at60 = share(levels.filter(l => LEVELS[l].fps >= 60).reduce((acc, l) => acc + this.levelMs.get(l)!, 0));
        return `Resumo do envio p/ ${label}: ` + join([
            formatDuration(now - this.startedAt),
            `${this.changes} ${this.changes === 1 ? "troca" : "trocas"} de nível`
            + (this.changes ? `: ${this.changeList.join(", ")}${this.changes > this.changeList.length ? ` (+${this.changes - this.changeList.length})` : ""}` : ""),
            total > 0 && levels.map(l => `${l} ${share(this.levelMs.get(l)!)}%`).join(", "),
            total > 0 && `60 fps ${at60}%, 30 fps ${100 - at60}%`,
            opt(shares(this.sizeMs, k => k), t => `tamanho ${t}`),
            opt(shares(this.fpsMs, k => String(k)), t => `fps medido ${t}`),
            opt(this.resChanges, n => `res WebRTC ${n}`),
            `${dec(this.frames / this.seconds)} fps em média`,
            join([opt(median(this.estKbps), k => `est mediana ${int(k)}`), `enviado mediana ${int(median(this.sentKbps)!)}`, "kbps"]),
            join([opt(ratio(this.lost, this.media), r => `perda média ${dec(r * 100)}%`), opt(ratio(this.rttSum, this.rttCount), v => `rtt médio ${int(v)} ms`)]),
            opt(this.keyframes, k => `kf ${k}`),
            routeText(this.route, this.teredo)
        ], " · ");
    }
}

// #endregion

// #region recepcao (quem assiste)

/** Contadores da recepcao que so o log usa (inbound-rtp de video e de audio); null = o Chromium nao expos. */
export interface ReceiverLogCounters {
    framesReceived: number | null;
    framesDropped: number | null;
    freezeCount: number | null;
    /** totalFreezesDuration (segundos) */
    freezeSeconds: number | null;
    /** jitterBufferDelay (segundos, somado por quadro) e jitterBufferEmittedCount */
    jitterBufferDelay: number | null;
    jitterBufferEmitted: number | null;
    /** jitterBufferTargetDelay (segundos, somado por quadro): o atraso que o jitter buffer mirou */
    jitterBufferTarget: number | null;
    /** totalInterFrameDelay e totalSquaredInterFrameDelay (segundos), entre quadros decodificados */
    interFrameDelay: number | null;
    interFrameDelaySquared: number | null;
    packetsLost: number | null;
    packetsReceived: number | null;
    nackCount: number | null;
    pliCount: number | null;
    /** audio: amostras ocultadas (perda/atraso disfarcados pelo decodificador) e amostras recebidas */
    concealedSamples: number | null;
    audioSamples: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function emptyReceiverCounters(): ReceiverLogCounters {
    return {
        framesReceived: null, framesDropped: null, freezeCount: null, freezeSeconds: null, jitterBufferDelay: null, jitterBufferEmitted: null,
        jitterBufferTarget: null, interFrameDelay: null, interFrameDelaySquared: null, packetsLost: null, packetsReceived: null, nackCount: null, pliCount: null,
        concealedSamples: null, audioSamples: null
    };
}

/** Os contadores de video de um inbound-rtp (os de audio ficam como estao). */
export function readVideoInbound(c: ReceiverLogCounters, s: any) {
    c.framesReceived = num(s.framesReceived);
    c.framesDropped = num(s.framesDropped);
    c.freezeCount = num(s.freezeCount);
    c.freezeSeconds = num(s.totalFreezesDuration);
    c.jitterBufferDelay = num(s.jitterBufferDelay);
    c.jitterBufferEmitted = num(s.jitterBufferEmittedCount);
    c.jitterBufferTarget = num(s.jitterBufferTargetDelay);
    c.interFrameDelay = num(s.totalInterFrameDelay);
    c.interFrameDelaySquared = num(s.totalSquaredInterFrameDelay);
    c.packetsLost = num(s.packetsLost);
    c.packetsReceived = num(s.packetsReceived);
    c.nackCount = num(s.nackCount);
    c.pliCount = num(s.pliCount);
}

/** Soma os contadores de um inbound-rtp de audio. */
export function readAudioInbound(c: ReceiverLogCounters, s: any) {
    c.concealedSamples = add(c.concealedSamples, num(s.concealedSamples));
    c.audioSamples = add(c.audioSamples, num(s.totalSamplesReceived));
}

/** Uma leitura da recepcao de UMA transmissao assistida (viewing.ts → sample). */
export interface ReceiverSample {
    /** performance.now() */
    at: number;
    framesDecoded: number;
    width: number;
    height: number;
    /** bytes recebidos, video e audio somados (o kbps da tela) */
    bytes: number;
    codec: string | null;
    decoder: string | null;
    powerEfficient: boolean | null;
    log: ReceiverLogCounters;
    /** "Colchão contra engasgos": o jitterBufferTarget pedido ao receiver de video (ms); null/ausente = desligado */
    cushionMs?: number | null;
    /** o par em uso passa pelo Teredo (core/teredo.ts) */
    teredo?: TeredoSide | null;
}

/** Uma janela de recepcao entre duas leituras. */
export interface ReceiverWindow {
    dt: number;
    decodedFps: number;
    receivedFps: number | null;
    dropped: number | null;
    freezes: number | null;
    freezeSeconds: number | null;
    /** espera media de um quadro no jitter buffer, e o atraso que ele mirou */
    bufferMs: number | null;
    bufferTargetMs: number | null;
    /** desvio padrao do intervalo entre quadros decodificados */
    interFrameSigmaMs: number | null;
    /** pacotes perdidos e esperados (perdidos + recebidos); so com os dois */
    lost: number | null;
    expected: number | null;
    lossPct: number | null;
    nacks: number | null;
    plis: number | null;
    kbps: number;
    /** audio ocultado e recebido (amostras); so com os dois */
    concealed: number | null;
    audioSamples: number | null;
    concealedPct: number | null;
}

/** A janela prev → cur; null = curta demais ou contadores reiniciados (outro stream). */
export function receiverWindow(prev: ReceiverSample, cur: ReceiverSample): ReceiverWindow | null {
    const dt = (cur.at - prev.at) / 1000;
    const frames = cur.framesDecoded - prev.framesDecoded;
    if (dt < 0.5 || frames < 0 || cur.bytes < prev.bytes) return null;
    const a = prev.log;
    const b = cur.log;
    const lost = delta(a.packetsLost, b.packetsLost);
    const received = delta(a.packetsReceived, b.packetsReceived);
    const expected = lost != null && received != null ? lost + received : null;
    const loss = ratio(lost, expected);
    // variancia = E[d²] - E[d]², com os intervalos da janela (um por quadro decodificado)
    const mean = ratio(delta(a.interFrameDelay, b.interFrameDelay), frames);
    const meanSq = ratio(delta(a.interFrameDelaySquared, b.interFrameDelaySquared), frames);
    const concealed = delta(a.concealedSamples, b.concealedSamples);
    const samples = delta(a.audioSamples, b.audioSamples);
    const concealedRatio = ratio(concealed, samples);
    const emitted = delta(a.jitterBufferEmitted, b.jitterBufferEmitted);
    return {
        dt,
        decodedFps: frames / dt,
        receivedFps: opt(delta(a.framesReceived, b.framesReceived), f => f / dt),
        dropped: delta(a.framesDropped, b.framesDropped),
        freezes: delta(a.freezeCount, b.freezeCount),
        freezeSeconds: delta(a.freezeSeconds, b.freezeSeconds),
        bufferMs: opt(ratio(delta(a.jitterBufferDelay, b.jitterBufferDelay), emitted), s => s * 1000),
        bufferTargetMs: opt(ratio(delta(a.jitterBufferTarget ?? null, b.jitterBufferTarget ?? null), emitted), s => s * 1000),
        interFrameSigmaMs: mean == null || meanSq == null ? null : Math.sqrt(Math.max(0, meanSq - mean * mean)) * 1000,
        lost: loss == null ? null : lost,
        expected: loss == null ? null : expected,
        lossPct: opt(loss, r => r * 100),
        nacks: delta(a.nackCount, b.nackCount),
        plis: delta(a.pliCount, b.pliCount),
        kbps: (cur.bytes - prev.bytes) * 8 / 1000 / dt,
        concealed: concealedRatio == null ? null : concealed,
        audioSamples: concealedRatio == null ? null : samples,
        concealedPct: opt(concealedRatio, r => r * 100)
    };
}

const freezesText = (count: number, seconds: number | null) => `congelou ${count}x` + (count && seconds != null ? ` (${dec(seconds)} s)` : "");

/** "buffer 210 ms alvo 205 ms colchão 200 ms": a espera no jitter buffer, o atraso que ele mirou e o colchão pedido. */
function bufferText(bufferMs: number | null, targetMs: number | null, cushionMs: number | null | undefined): string | null {
    return join([opt(bufferMs, v => `buffer ${int(v)} ms`), opt(targetMs, v => `alvo ${int(v)} ms`), opt(cushionMs, v => `colchão ${int(v)} ms`)]) || null;
}

/**
 * Linha de UMA transmissao assistida, ex.: "Recepção de leo (abc123): VP9 libvpx 1280x720 · 29,8 fps decodificados de
 * 30,0 recebidos, 0 descartados · congelou 1x (0,4 s) · buffer 245 ms alvo 240 ms colchão 200 ms · σ entre quadros 6 ms ·
 * perda 0,8% · nack 3 pli 0 · 1650 kbps · áudio ocultado 0,2%". O marcador do Teredo sai no fim, quando ha.
 */
export function formatReceiverLine(label: string, cur: ReceiverSample, w: ReceiverWindow): string {
    return `Recepção de ${label}: ` + join([
        join([coder(cur.codec, cur.decoder, cur.powerEfficient), size(cur.width, cur.height)]),
        join([`${dec(w.decodedFps)} fps decodificados`, opt(w.receivedFps, f => `de ${dec(f)} recebidos`)]) + (opt(w.dropped, n => `, ${n} descartados`) ?? ""),
        opt(w.freezes, n => freezesText(n, w.freezeSeconds)),
        bufferText(w.bufferMs, w.bufferTargetMs, cur.cushionMs),
        opt(w.interFrameSigmaMs, v => `σ entre quadros ${int(v)} ms`),
        opt(w.lossPct, p => `perda ${dec(p)}%`),
        join([opt(w.nacks, n => `nack ${n}`), opt(w.plis, n => `pli ${n}`)]),
        `${int(w.kbps)} kbps`,
        opt(w.concealedPct, p => `áudio ocultado ${dec(p)}%`),
        routeText(null, cur.teredo)
    ], " · ");
}

/** O log de UMA transmissao assistida: linhas a cada STATS_LOG_MS (add) e o resumo quando ela acaba (summary). */
export class ReceiverLog {
    private readonly startedAt: number;
    private base: ReceiverSample | null = null;
    private last: ReceiverSample | null = null;
    private windows = 0;
    private seconds = 0;
    private frames = 0;
    private freezes: number | null = null;
    private freezeSeconds: number | null = null;
    private dropped: number | null = null;
    private lost: number | null = null;
    private expected: number | null = null;
    private bufferSum: number | null = null;
    private bufferCount = 0;
    private targetSum: number | null = null;
    private targetCount = 0;
    private teredo: TeredoSide | null = null;
    private concealed: number | null = null;
    private audioSamples: number | null = null;
    private readonly kbps: number[] = [];

    constructor(now: number) {
        this.startedAt = now;
    }

    /** Leitura nova (a cada ~2 s): entra no resumo; devolve a linha periodica quando a janela do log fecha. */
    add(cur: ReceiverSample, label: string): string | null {
        const { last } = this;
        this.last = cur;
        const base = this.base ??= cur;
        const w = last && receiverWindow(last, cur);
        if (w) {
            this.windows++;
            this.seconds += w.dt;
            this.frames += w.decodedFps * w.dt;
            this.freezes = add(this.freezes, w.freezes);
            this.freezeSeconds = add(this.freezeSeconds, w.freezeSeconds);
            this.dropped = add(this.dropped, w.dropped);
            this.lost = add(this.lost, w.lost);
            this.expected = add(this.expected, w.expected);
            this.bufferSum = add(this.bufferSum, w.bufferMs);
            if (w.bufferMs != null) this.bufferCount++;
            this.targetSum = add(this.targetSum, w.bufferTargetMs);
            if (w.bufferTargetMs != null) this.targetCount++;
            this.teredo = cur.teredo ?? this.teredo;
            this.concealed = add(this.concealed, w.concealed);
            this.audioSamples = add(this.audioSamples, w.audioSamples);
            pushCapped(this.kbps, w.kbps);
        }
        if (!logDue(base, cur)) return null;
        this.base = cur;
        return opt(receiverWindow(base, cur), window => formatReceiverLine(label, cur, window));
    }

    /**
     * Resumo quando a transmissao assistida acaba, ex.: "Resumo da recepção de leo (abc123): 12 min 30 s · VP9 libvpx
     * 1280x720 · 29,5 fps em média · congelou 3x (1,2 s) · 12 descartados · perda média 0,4% · mediana 1650 kbps · buffer
     * médio 245 ms alvo médio 240 ms colchão 200 ms · áudio ocultado 0,2%". null = nenhuma janela medida.
     */
    summary(label: string, now: number): string | null {
        const { last } = this;
        if (!last || !this.windows) return null;
        return `Resumo da recepção de ${label}: ` + join([
            formatDuration(now - this.startedAt),
            join([coder(last.codec, last.decoder, last.powerEfficient), size(last.width, last.height)]),
            `${dec(this.frames / this.seconds)} fps em média`,
            opt(this.freezes, n => freezesText(n, this.freezeSeconds)),
            opt(this.dropped, n => `${n} descartados`),
            opt(ratio(this.lost, this.expected), r => `perda média ${dec(r * 100)}%`),
            `mediana ${int(median(this.kbps)!)} kbps`,
            join([
                opt(ratio(this.bufferSum, this.bufferCount), v => `buffer médio ${int(v)} ms`),
                opt(ratio(this.targetSum, this.targetCount), v => `alvo médio ${int(v)} ms`),
                opt(last.cushionMs, v => `colchão ${int(v)} ms`)
            ]),
            opt(ratio(this.concealed, this.audioSamples), r => `áudio ocultado ${dec(r * 100)}%`),
            routeText(null, this.teredo)
        ], " · ");
    }
}

// #endregion
