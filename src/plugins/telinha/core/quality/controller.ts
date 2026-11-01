/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Qualidade automatica de UMA transmissao. A cada ~2 s le as estatisticas do sender de video de
// cada espectador e escolhe o degrau de cada um (levels.ts), aplicado por setParameters.
//
// Malha P2P: o streamer codifica e sobe uma copia POR espectador. Por isso:
// - CPU e upload sao recursos COMPARTILHADOS: limitam um degrau global (vale para todos);
// - a banda de um espectador so limita o degrau DELE.
// Nivel efetivo do espectador = o mais restritivo entre o global e o dele (levels.meet).
//
// Adaptacao propria do WebRTC: desde a 0.2.10 os envios usam degradationPreference "maintain-framerate-and-resolution"
// (streaming.ts → applySenderParams): num soluco da internet o WebRTC nao muda mais a resolucao nem o fps sozinho, so a
// imagem fica mais borrada por um momento. Quem muda o degrau e so este controller, e para a rede so com problema que
// dura (trackNet: perda, RTT, fila do pacer ou banda estimada curta por mais que um soluco). Num Chromium que recusa essa
// preferencia, vale a antiga ("maintain-framerate"): ao sentir CPU ele mesmo reduz a resolucao, e so desfaz depois de
// >=10 s sem sobrecarga. Logo, "qualityLimitationReason = cpu" continua aparecendo depois que nos ja descemos; so conta
// como sinal se a resolucao real estiver abaixo do nosso degrau E ja passou esse tempo.
//
// Placa de video (encoder por hardware, ex.: NVENC): tambem e COMPARTILHADA, uma unidade de codificacao para os
// encoders de todos os espectadores. O tempo de codificacao por quadro de um encoder por hardware e quase todo espera
// por ela, entao e o sinal por PC: uma placa mais fraca chega no limite com menos espectadores, uma mais forte depois,
// sem ninguem configurar nada. Medido em 29/10/2026 numa RTX 3070 (um NVENC; H.264 42001f na placa; um encoder por
// espectador; fonte sintetica 1080p60 com muito movimento), mediana do tempo por quadro / uso do encoder da placa:
//   1 espectador: 4,3 ms / 11%     5: 8,9 ms / 52%     8: 12,4 ms / 84%     9: 14-15 ms / 95%
//   10: 188 ms, saturada: os quadros enfileiram, o WebRTC poe 8 dos 10 em 720p (qualityLimitationReason "cpu", que
//   ate 9 era "none") e os espectadores congelam.
// 720p60 custa ~4,9% do encoder por espectador (10 x 720p60 = 49%, tranquilo). Ate 8 o tempo e quase linear:
// ~3,1 ms fixos + ~1,16 ms por espectador 1080p60 (GPU_FIXED_RATE). Para encoders por hardware este sinal substitui os
// de CPU (o tempo deles nao e processador); encoders por software seguem so a logica de CPU, como antes.

import { log, logThrottled } from "@plugins/telinha/core/log";
import { guardStatsLog, type SenderLevels, SenderLog } from "@plugins/telinha/core/statsLog";
import type { AutoQualityState, AutoQualityViewer, PeerId, Quality, QualityLevel, QualityReason } from "@plugins/telinha/types";

import { inBandwidthGrace, isAtMost, LEVELS, levelText, meet, pixelRate, rank, stepDown, stepUp } from "./levels";
import { diffSamples, readSenderSample, type SenderSample, type WindowMetrics } from "./stats";

/** Motivos que descem o degrau global (de todos): recursos compartilhados do PC de quem transmite. */
type GlobalReason = "cpu" | "gpu" | "upload";

export interface QualityDeps {
    /** qualidade escolhida pelo usuario: teto de todos os degraus */
    ceiling: Quality;
    /** configuracao autoQuality (lida a cada uso) */
    enabled(): boolean;
    sender(peerId: PeerId): RTCRtpSender | null;
    /** aplica o degrau no sender do espectador (setParameters); true = aplicado */
    apply(peerId: PeerId, level: QualityLevel): Promise<boolean>;
    label(peerId: PeerId): string;
    /** tamanho real da captura */
    captureSize(): { width: number; height: number; };
    /** movimento na imagem (0..1, do monitor da captura); null = desconhecido */
    motion(): number | null;
    /** contador de quadros da fonte visto por um sender (alimenta o detector de imagem congelada) */
    sourceFrames(key: string, frames: number): void;
    /** o snapshot publicado (state) mudou */
    changed(): void;
}

// tempos em ms
const WARMUP_MS = 6000; // espectador novo: encoder e estimador de banda ainda subindo
const SETTLE_MS = 4000; // depois de mudar o degrau
const DOWN_COOLDOWN_MS = 6000; // entre dois degraus para baixo
const ADAPTATION_MEMORY_MS = 15_000; // o WebRTC demora >=10 s para desfazer a reducao propria
const BASE_HOLD_MS = 10_000; // estavel por isto antes de subir
const MAX_HOLD_MS = 120_000;
const FAILED_UP_MS = 30_000; // desceu de novo ate 30 s depois de subir: dobra a espera
const HOLD_RESET_MS = 120_000;
const UPLINK_TTL_MS = 60_000;

// janelas de ~2 s seguidas
const FPS_STREAK = 2;
const CPU_STREAK = 2;

// Rede de UM espectador (o degrau dele) e o upload (o de todos). Uma janela de ~2 s mostra a rede no limite quando ha:
// - congestionamento: perda >= NET_LOSS_ALONE_PCT; ou perda >= NET_LOSS_PCT com outro sinal (RTT subindo, recuo do
//   estimador ou banda estimada abaixo do degrau): no Wi-Fi rapido 2-3% de perda cronica e corrigida pelo NACK/RTX e pelo
//   colchao de quem assiste, sem nada na tela; RTT NET_RTT_RISE_MS acima da base (o P15 dos RTTs medidos nos ultimos
//   RTT_BASE_MS: uma leitura baixa solta nao vira base) = a fila do caminho cresceu; pacotes esperando mais de
//   NET_PACER_MS no pacer deste PC;
// - banda curta: a banda estimada abaixo do que o degrau pede (LEVELS.minKbps), com o envio usando >= NET_FULL_RATIO
//   dela (o caminho esta cheio; com menos, e o encoder que pede pouco, ex.: tela parada).
// So desce com o problema seguido por mais que um soluco (log de 31/10: dois soluços de ~10 s, e o WebRTC encolhia a
// imagem de 1080p a 320x180 e levava ~60 s para voltar):
const NET_LOSS_ALONE_PCT = 5;
const NET_LOSS_PCT = 2;
const NET_RTT_RISE_MS = 60;
const NET_PACER_MS = 100;
const NET_FULL_RATIO = 0.85;
/** a base sem fila: este percentil dos RTTs medidos nestes ultimos ms */
const RTT_BASE_MS = 120_000;
const RTT_BASE_PERCENTILE = 0.15;
/**
 * Congestionamento seguido por isto: desce. Um soluco de 10 s cai em no maximo 6 janelas de 2 s (12 s, contando as das
 * pontas), entao nunca chega aqui.
 */
const CONGESTED_MS = 14_000;
/**
 * So a banda curta, num degrau em que a estimativa ja deu o que ele pede: desce depois disto. Depois de um soluco o
 * estimador do WebRTC (GCC) sobe devagar: no log de 31/10 levou ~20-25 s para voltar acima dos 4,5 Mbps do 1080p60. Num
 * degrau em que a estimativa nunca deu o que ele pede (caminho estreito), vale o CONGESTED_MS.
 */
const SHORT_MS = 30_000;
/** recuo do estimador: a banda estimada caiu para isto da janela anterior, ou menos (o GCC recua para 0,85 do entregue) */
const BACKOFF_RATIO = 0.85;
/**
 * Recuo de quem sondou o caminho (trackNet): a banda estimada nova ficou em pelo menos isto do que enviamos na janela
 * anterior. Ao passar do que o caminho leva, o GCC recua para ~0,85 do que foi entregue (~ o que enviamos); cair bem
 * abaixo disso e congestionamento.
 */
const PROBE_LANDING = 0.8;
/**
 * Upload (o degrau de todos): algum espectador ja com problema que dura (vai descer) e a maioria com algum problema ha
 * pelo menos isto. Os periodos de cada um comecam em janelas diferentes, entao exigir que todos completem o deles junto
 * quase nunca acontecia (e cada um descia sozinho, por "banda").
 */
const UPLOAD_TROUBLE_MS = 10_000;
/**
 * Subir (a banda de um espectador, ou o degrau de todos depois de descer pelo upload): estavel por BW_UP_STABLE_MS, sem
 * problema, sem recuo (fora o de sondar o caminho: PROBE_LANDING) e com a banda estimada >= UP_HEADROOM x o piso
 * do degrau de cima em pelo menos CALM_SHARE do tempo (uma janela ruim solta, como um soluco do Wi-Fi, nao zera a conta),
 * e na ultima janela. Desceu de novo ate BW_UNDONE_MS depois de subir: a espera dobra, ate BW_MAX_HOLD_MS; volta para
 * BW_UP_STABLE_MS depois de BW_HOLD_RESET_MS sem descer.
 */
const CALM_SHARE = 0.9;
const BW_UP_STABLE_MS = 30_000;
const BW_UNDONE_MS = 60_000;
const BW_MAX_HOLD_MS = 600_000;
const BW_HOLD_RESET_MS = 900_000;

const FPS_SHORT_RATIO = 0.8;
const MIN_SOURCE_FPS = 20;
const LIMITED_FRACTION = 0.5;
const ANY_LIMIT_FRACTION = 0.1;
const BINDING_RATIO = 0.85;
const BUSY_FOR_CPU = 0.5;
const NET_SATURATED = 0.85;
const UP_MAX_BUSY = 0.75; // o detector de sobrecarga do WebRTC dispara por volta de 0,85
const UP_AVAILABLE_RATIO = 0.9;
const UP_HEADROOM = 1.5; // subir para um degrau exige banda estimada >= piso dele x isto (histerese com o minKbps da descida)
const STATIC_SOURCE_FPS = 15;
const MOTION_THRESHOLD = 0.35;
/** abaixo disto a janela tem poucos quadros para medir custo de codificacao */
const MIN_ENCODED_FPS = 5;

// placa de video (encoders por hardware), em fracao do intervalo entre quadros (16,7 ms a 60 fps)
/**
 * Mediana do tempo por quadro acima disto: a placa nao da conta. Na RTX 3070: 8 espectadores 1080p60 = 12,4 ms (0,74)
 * ficam; o 9o, previsto em 13,6 ms (0,81; medido 14-15 ms), desce o degrau antes de comecar. Placa 2x mais lenta
 * (todos os tempos x2): 3 espectadores = 13,2 ms ficam, o 4o (15,5 ms previstos) desce.
 */
const GPU_LIMIT = 0.8;
/** subir de degrau so com o tempo previsto no degrau de cima ate isto (folga para nao oscilar com o GPU_LIMIT) */
const GPU_UP_LIMIT = 0.6;
const GPU_STREAK = 2;
/**
 * Parte fixa do tempo por quadro (copia, sincronizacao, a propria codificacao do quadro), como taxa de pixels
 * equivalente: medido ~3,1 ms fixos + ~1,16 ms por espectador 1080p60 = o tempo de 2,7 espectadores 1080p60. A previsao
 * escala o tempo medido pela taxa de pixels total depois/antes com esta parte somada nos dois lados (so proporcional,
 * 1 espectador → 2 dobraria os 4,3 ms, e a placa x2 desceria ja no 2o espectador).
 */
const GPU_FIXED_RATE = 2.7 * 1920 * 1080 * 60;

/** Quanto esperar estavel antes de subir e como a espera cresce quando a subida e desfeita. */
interface HoldRules {
    baseMs: number;
    maxMs: number;
    /** desceu de novo ate isto depois de subir: a subida foi desfeita e a espera dobra */
    undoneMs: number;
    /** sem descer por isto: a espera volta para baseMs */
    resetMs: number;
}

/** O degrau global (CPU, placa de video, upload): como sempre foi. */
const GLOBAL_HOLD: HoldRules = { baseMs: BASE_HOLD_MS, maxMs: MAX_HOLD_MS, undoneMs: FAILED_UP_MS, resetMs: HOLD_RESET_MS };
/** A banda de um espectador. */
const BW_HOLD: HoldRules = { baseMs: BW_UP_STABLE_MS, maxMs: BW_MAX_HOLD_MS, undoneMs: BW_UNDONE_MS, resetMs: BW_HOLD_RESET_MS };

interface Hold {
    rules: HoldRules;
    holdMs: number;
    lastDownAt: number;
    lastUpAt: number;
    /** sem sinal de problema desde */
    calmSince: number;
}

const newHold = (now: number, rules: HoldRules): Hold => ({ rules, holdMs: rules.baseMs, lastDownAt: -Infinity, lastUpAt: -Infinity, calmSince: now });

function noteDown(h: Hold, now: number) {
    if (now - h.lastUpAt < h.rules.undoneMs) h.holdMs = Math.min(h.holdMs * 2, h.rules.maxMs);
    h.lastDownAt = h.calmSince = now;
}

function noteUp(h: Hold, now: number) {
    h.lastUpAt = h.calmSince = now;
}

function relax(h: Hold, now: number) {
    if (h.holdMs > h.rules.baseMs && now - h.lastDownAt >= h.rules.resetMs) h.holdMs = h.rules.baseMs;
}

/** A rede de UM espectador ao longo das janelas (trackNet). */
interface NetState {
    /** degrau a que os periodos abaixo se referem (mudou: recomecam) */
    level: QualityLevel | null;
    /** inicio das janelas seguidas com congestionamento (perda, RTT, fila); null = a ultima nao tinha */
    congestedSince: number | null;
    /** inicio das janelas seguidas com algum problema (congestionamento ou banda curta) */
    troubleSince: number | null;
    /** degrau em que a banda estimada ja deu o que ele pede */
    enoughFor: QualityLevel | null;
    /** a ultima janela: algum problema / o estimador recuou */
    trouble: boolean;
    backoff: boolean;
    /** banda estimada e envio (kbps) da janela anterior */
    lastEst: number | null;
    lastSent: number | null;
    /** RTTs medidos nas janelas recentes (a base sem fila e o P15 deles) */
    rtts: { at: number; ms: number; }[];
    /** as janelas recentes, para a subida (calmShare) */
    windows: NetWindow[];
}

/** Uma janela de ~2 s da rede de um espectador, para a subida. */
interface NetWindow {
    /** fim da janela e duracao (ms) */
    at: number;
    ms: number;
    /** sem problema, sem recuo do estimador (a nao ser sondando o caminho: PROBE_LANDING) e sem limitacao do WebRTC */
    quiet: boolean;
    est: number | null;
}

const newNet = (): NetState => ({
    level: null, congestedSince: null, troubleSince: null, enoughFor: null, trouble: false, backoff: false, lastEst: null, lastSent: null, rtts: [],
    windows: []
});

/** O valor no percentil `p` (0..1) de `values`; null sem valores. */
function percentile(values: number[], p: number): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(p * (sorted.length - 1))];
}

/**
 * Fracao do tempo dos ultimos `ms` em que as janelas de `n` estavam calmas (`calm`); null se elas ainda nao cobrem esse
 * tempo inteiro depois de `since` (ex.: a ultima troca de degrau) ou se a ultima (a de agora) nao esta calma.
 */
function calmShare(n: NetState, now: number, since: number, ms: number, calm: (w: NetWindow) => boolean): number | null {
    const from = now - ms;
    const last = n.windows.at(-1);
    const first = n.windows[0];
    if (!last || last.at !== now || !calm(last) || since > from || first.at - first.ms > from) return null;
    let total = 0;
    let ok = 0;
    for (const w of n.windows) {
        if (w.at <= from) continue;
        total += w.ms;
        if (calm(w)) ok += w.ms;
    }
    return ok / total;
}

/** Uma casa decimal com virgula. */
const dec = (v: number) => v.toFixed(1).replace(".", ",");

interface ViewerState {
    peerId: PeerId;
    /** o sender ja existe (addStream resolveu) */
    ready: boolean;
    /** performance.now() em que ficou pronto (Infinity = ainda nao); carencia de banda: levels.inBandwidthGrace */
    readyAt: number;
    ignoreUntil: number;
    prev: SenderSample | null;
    metrics: WindowMetrics | null;
    /** metrics e desta avaliacao */
    fresh: boolean;
    /** teto deste espectador por causa da banda dele */
    bwLevel: QualityLevel;
    bwHold: Hold;
    net: NetState;
    applied: QualityLevel | null;
    applying: boolean;
    /** reaplicar o mesmo degrau: a captura mudou de tamanho (captureResized) ou o encoder mudou de tipo (reapply) */
    resized: boolean;
    /** antes da primeira medida: o encoder dele deve rodar na placa de video? (addViewer; undefined = como os ja medidos) */
    expectGpu: boolean | undefined;
    /** log de estatisticas deste envio (core/statsLog.ts): linhas a cada STATS_LOG_MS e o resumo quando ele para */
    log: SenderLog;
    /** motivo da proxima troca de degrau que o log anota (setGlobal / setViewerBw → noteLevels) */
    changeWhy: string | null;
}

type Active = ViewerState & { metrics: WindowMetrics; };

function cpuBudget() {
    const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
    return Math.max(1, cores * 0.5);
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function reasonText(level: QualityLevel, reason: QualityReason | null, viewers: number): string | null {
    if (!reason) return null;
    const why = reason === "cpu"
        ? (viewers > 1 ? `o processador não dá conta de ${viewers} espectadores` : "o processador está sobrecarregado")
        : reason === "gpu"
            ? (viewers > 1 ? `a placa de vídeo não dá conta de ${viewers} espectadores` : "a placa de vídeo está sobrecarregada")
            : reason === "upload"
                ? "o seu upload está no limite"
                : (viewers > 1 ? "a conexão de um espectador está limitada" : "a conexão com o espectador está limitada");
    return `${levelText(level)} — ${why}`;
}

const REASON_LABEL: Record<QualityReason, string> = { cpu: "CPU", gpu: "placa de vídeo", upload: "upload", bandwidth: "banda" };

/** Janela calma para subir para `next`: sem problema nem recuo e com folga de UP_HEADROOM x o piso dele. */
const readyFor = (next: QualityLevel) => (w: NetWindow) => w.quiet && (w.est == null || w.est >= LEVELS[next].minKbps * UP_HEADROOM);

/** Tempo por quadro medido agora nos encoders da placa de video. */
interface GpuSample {
    /** mediana entre os encoders (ms) */
    ms: number;
    /** pixels por segundo somados desses encoders */
    rate: number;
    count: number;
}

export class QualityController {
    private readonly deps: QualityDeps;
    private readonly viewers = new Map<PeerId, ViewerState>();
    private global: QualityLevel;
    private globalReason: GlobalReason | null = null;
    private globalHold: Hold;
    private fpsStreak = 0;
    private cpuStreak = 0;
    private gpuStreak = 0;
    /** upload total medido quando a maioria dos espectadores estava limitada por banda */
    private uplink: { kbps: number; at: number; } | null = null;
    private sourceFpsEma: number | null = null;
    private evaluating = false;
    private disposed = false;
    private published: AutoQualityState | null = null;
    private publishedKey = "";

    constructor(deps: QualityDeps) {
        this.deps = deps;
        this.global = deps.ceiling;
        this.globalHold = newHold(performance.now(), GLOBAL_HOLD);
        this.published = this.buildState();
        this.publishedKey = JSON.stringify(this.published);
    }

    /** Snapshot imutavel para o store; null = qualidade automatica desligada. */
    get state(): AutoQualityState | null {
        return this.published;
    }

    /** Degrau que o espectador deve receber agora. */
    levelFor(peerId: PeerId): QualityLevel {
        if (!this.deps.enabled()) return this.deps.ceiling;
        const v = this.viewers.get(peerId);
        return v ? meet(this.global, v.bwLevel) : this.global;
    }

    /**
     * Antes de negociar: ja entra no degrau atual (e desce todos se mais um encode nao cabe). `gpu`: o encoder dele deve
     * rodar na placa de video (ex.: H.264 com este PC codificando por hardware); undefined = como os espectadores ja
     * medidos. Vale ate a primeira medida dele.
     */
    addViewer(peerId: PeerId, gpu?: boolean) {
        if (this.disposed || this.viewers.has(peerId)) return;
        const now = performance.now();
        this.viewers.set(peerId, {
            peerId, ready: false, readyAt: Infinity, ignoreUntil: now + WARMUP_MS, prev: null, metrics: null, fresh: false,
            bwLevel: this.deps.ceiling, bwHold: newHold(now, BW_HOLD), net: newNet(), applied: null, applying: false, resized: false, expectGpu: gpu,
            log: new SenderLog(now), changeWhy: null
        });
        if (this.deps.enabled()) {
            const before = this.global;
            this.preempt(now);
            // desceu: os encoders que ja estao no ar descem agora, antes de o novo comecar
            if (this.global !== before) for (const v of this.viewers.values()) this.applyViewer(v);
        }
        this.emit();
    }

    /** O sender do espectador existe: aplica o degrau. */
    markReady(peerId: PeerId) {
        const v = this.viewers.get(peerId);
        if (!v || this.disposed) return;
        const now = performance.now();
        v.ready = true;
        if (v.readyAt === Infinity) v.readyAt = now; // so a primeira vez: nao reinicia a carencia
        v.ignoreUntil = Math.max(v.ignoreUntil, now + WARMUP_MS);
        this.applyViewer(v);
    }

    removeViewer(peerId: PeerId) {
        const v = this.viewers.get(peerId);
        if (!v) return;
        this.viewers.delete(peerId);
        this.logSummary(v);
        this.emit();
    }

    /**
     * A captura mudou de tamanho (janela redimensionada): reaplica o degrau de todos, porque a reducao de resolucao e
     * relativa ao tamanho (levels.encodingFor) e a antiga pode dar tamanho impar (H.264 fora da placa de video).
     */
    captureResized() {
        if (this.disposed) return;
        for (const v of this.viewers.values()) {
            v.resized = true;
            this.applyViewer(v);
        }
    }

    /** Reaplica o degrau atual deste espectador (ex.: o encoder dele mudou de tipo e a degradationPreference tambem). */
    reapply(peerId: PeerId) {
        const v = this.viewers.get(peerId);
        if (!v || this.disposed) return;
        v.resized = true;
        this.applyViewer(v);
    }

    /** A configuracao autoQuality mudou: volta todos para o teto e recomeca. */
    settingChanged() {
        if (this.disposed) return;
        const now = performance.now();
        this.global = this.deps.ceiling;
        this.globalReason = null;
        this.globalHold = newHold(now, GLOBAL_HOLD);
        this.fpsStreak = this.cpuStreak = this.gpuStreak = 0;
        this.uplink = null;
        for (const v of this.viewers.values()) {
            v.bwLevel = this.deps.ceiling;
            v.bwHold = newHold(now, BW_HOLD);
            v.net = newNet();
            v.ignoreUntil = Math.max(v.ignoreUntil, now + SETTLE_MS);
            this.applyViewer(v);
        }
        log.info(this.deps.enabled()
            ? `Qualidade automática ligada (teto ${levelText(this.deps.ceiling)})`
            : `Qualidade automática desligada: todos recebem ${levelText(this.deps.ceiling)}`);
        this.emit();
    }

    /** A transmissao acabou (ou trocou de fonte): o resumo de cada envio vai para o log. */
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const v of this.viewers.values()) this.logSummary(v);
        this.viewers.clear();
    }

    /** Chamado a cada ~2 s enquanto transmite. */
    async evaluate() {
        if (this.evaluating || this.disposed) return;
        this.evaluating = true;
        try {
            await this.sample();
            if (this.disposed) return;
            if (this.deps.enabled()) this.decide(performance.now());
            this.logStats();
            for (const v of this.viewers.values()) this.applyViewer(v);
        } finally {
            this.evaluating = false;
        }
    }

    // #region amostragem

    private async sample() {
        const list = [...this.viewers.values()].filter(v => v.ready);
        const samples = await Promise.all(list.map(async v => {
            const sender = this.deps.sender(v.peerId);
            if (!sender) return null;
            try {
                return await readSenderSample(sender);
            } catch {
                return null;
            }
        }));

        let fedFrames = false;
        let maxSourceFps: number | null = null;
        list.forEach((v, i) => {
            const s = samples[i];
            v.fresh = false;
            if (!s) return;
            const m = v.prev ? diffSamples(v.prev, s) : null;
            guardStatsLog(() => v.log.add(v.prev, s));
            v.prev = s;
            if (m) {
                v.metrics = m;
                v.fresh = true;
                if (m.sourceFps != null) maxSourceFps = Math.max(maxSourceFps ?? 0, m.sourceFps);
            }
            if (!fedFrames && s.sourceFrames != null) {
                fedFrames = true;
                this.deps.sourceFrames(v.peerId, s.sourceFrames);
            }
        });
        if (maxSourceFps != null)
            this.sourceFpsEma = this.sourceFpsEma == null ? maxSourceFps : this.sourceFpsEma * 0.7 + maxSourceFps * 0.3;
    }

    // #endregion

    // #region log de estatisticas (so diagnostico: nada aqui entra nas decisoes, e uma excecao daqui nao sai: guardStatsLog)

    private levelsOf(v: ViewerState): SenderLevels {
        return { level: this.levelFor(v.peerId), bw: v.bwLevel, global: this.global, auto: this.deps.enabled() };
    }

    /** Depois de cada avaliacao: a linha periodica de quem completou a janela do log (core/statsLog.ts → STATS_LOG_MS). */
    private logStats() {
        for (const v of this.viewers.values()) {
            guardStatsLog(() => {
                const line = v.fresh && v.prev && v.log.line(v.prev, this.deps.label(v.peerId), this.levelsOf(v));
                if (line) log.info(line);
            });
        }
    }

    /**
     * Degrau de cada espectador para o log (tempo em cada um, no resumo) e, se mudou, mais uma linha de estatisticas
     * dele: a janela desde a ultima linha, logo depois da linha da decisao. Chamado em toda mudanca de estado (emit).
     */
    private noteLevels() {
        const now = performance.now();
        for (const v of this.viewers.values()) {
            guardStatsLog(() => {
                const changed = v.log.trackLevel(this.levelFor(v.peerId), now, v.changeWhy);
                v.changeWhy = null;
                const line = changed && v.prev && v.log.line(v.prev, this.deps.label(v.peerId), this.levelsOf(v), true);
                if (line) log.info(line);
            });
        }
    }

    private logSummary(v: ViewerState) {
        guardStatsLog(() => {
            const line = v.log.summary(this.deps.label(v.peerId), performance.now());
            if (line) log.info(line);
        });
    }

    // #endregion

    // #region decisao

    /** Conteudo em movimento (jogo): ao descer de 1080p60, manter 60 fps (720p60) em vez de 1080p30. */
    private preferMotion(): boolean {
        if (this.sourceFpsEma != null && this.sourceFpsEma < STATIC_SOURCE_FPS) return false;
        const motion = this.deps.motion();
        return motion == null || motion >= MOTION_THRESHOLD;
    }

    private targetHeight(level: QualityLevel) {
        return Math.min(LEVELS[level].height, this.deps.captureSize().height || LEVELS[level].height);
    }

    private uplinkFresh(now: number) {
        return this.uplink && now - this.uplink.at < UPLINK_TTL_MS ? this.uplink : null;
    }

    /** Pixels por segundo que UM encoder processa no degrau (fps limitado pelo da fonte). */
    private nominalRate(level: QualityLevel) {
        const { width, height } = this.deps.captureSize();
        const { fps } = LEVELS[level];
        return pixelRate(level, width || 1920, height || 1080) / fps * Math.min(fps, this.sourceFpsEma ?? fps);
    }

    /** Intervalo entre quadros (ms) no degrau: o fps dele, ou o da fonte quando ela entrega menos. */
    private frameMs(level: QualityLevel) {
        const { fps } = LEVELS[level];
        return 1000 / Math.max(1, Math.min(fps, this.sourceFpsEma ?? fps));
    }

    /** Algum espectador ja medido codifica na placa de video. */
    private gpuMeasured() {
        for (const v of this.viewers.values()) if (v.metrics?.hardware) return true;
        return false;
    }

    /** O encoder deste espectador roda na placa de video: o medido; antes da 1a medida, o palpite do addViewer. */
    private onGpu(v: ViewerState, gpuMeasured: boolean) {
        return v.metrics ? v.metrics.hardware : v.expectGpu ?? gpuMeasured;
    }

    /**
     * Custo de codificacao previsto no degrau `level`, extrapolado do custo por pixel medido agora (fracao do tempo de
     * parede codificando; somada entre os encoders). So os encoders por software (CPU): o tempo dos por hardware e
     * espera pela placa de video (predictGpu). Sem nenhum na placa de video: todos os espectadores, como sempre foi.
     */
    private predictLoad(level: QualityLevel): { total: number; perEncoder: number; n: number; } | null {
        const gpuMeasured = this.gpuMeasured();
        let sum = 0;
        let count = 0;
        let max = 0;
        let n = 0;
        for (const v of this.viewers.values()) {
            if (this.onGpu(v, gpuMeasured)) continue;
            n++;
            const m = v.metrics;
            if (!m || m.encodeBusy == null || m.pixelsPerSecond <= 0 || m.encodedFps < MIN_ENCODED_FPS) continue;
            const cost = m.encodeBusy / m.pixelsPerSecond;
            sum += cost;
            count++;
            max = Math.max(max, cost);
        }
        if (!count) return null;
        const rate = this.nominalRate(level);
        return { total: (sum / count) * rate * n, perEncoder: max * rate, n };
    }

    /** Mediana do tempo por quadro dos encoders por hardware de `list` com medida. */
    private gpuNow(list: Iterable<ViewerState>): GpuSample | null {
        const times: number[] = [];
        let rate = 0;
        for (const v of list) {
            const m = v.metrics;
            if (!m?.hardware || m.encodeMsPerFrame == null || m.encodedFps < MIN_ENCODED_FPS) continue;
            times.push(m.encodeMsPerFrame);
            rate += m.pixelsPerSecond;
        }
        return times.length ? { ms: median(times), rate, count: times.length } : null;
    }

    /**
     * Tempo por quadro previsto na placa de video com os encoders dela no degrau `level` (cada um limitado pela banda
     * dele), contando os espectadores ainda sem medida que vao codificar nela (o novo, no addViewer): o tempo medido
     * escalado pela taxa de pixels depois/antes, com a parte fixa (GPU_FIXED_RATE) dos dois lados. null = nada medido.
     */
    private predictGpu(level: QualityLevel): { ms: number; n: number; } | null {
        const now = this.gpuNow(this.viewers.values());
        if (!now) return null;
        let after = 0;
        let n = 0;
        for (const v of this.viewers.values()) {
            if (!this.onGpu(v, true)) continue;
            after += this.nominalRate(meet(level, v.bwLevel));
            n++;
        }
        return { ms: now.ms * (after + GPU_FIXED_RATE) / (now.rate + GPU_FIXED_RATE), n };
    }

    /** Mais um espectador = mais um encode e mais upload: desce antes se a previsao ja nao cabe. */
    private preempt(now: number) {
        const n = this.viewers.size;
        let level = this.global;
        let reason: GlobalReason | null = null;
        let why = "";
        for (let i = 0; i < 2; i++) {
            const gpu = this.predictGpu(level);
            const gpuLimit = GPU_LIMIT * this.frameMs(level);
            const load = this.predictLoad(level);
            const up = this.uplinkFresh(now);
            let r: GlobalReason | null = null;
            if (gpu && gpu.ms > gpuLimit) {
                r = "gpu";
                why = `previsão de ${gpu.ms.toFixed(1)} ms por quadro com ${gpu.n} espectadores em ${levelText(level)}, o limite é ${gpuLimit.toFixed(1)} ms`;
            } else if (load && load.total > cpuBudget()) {
                r = "cpu";
                why = `previsão de ${load.total.toFixed(1)} núcleos codificando para ${load.n} espectadores`;
            } else if (up && n * LEVELS[level].minKbps > up.kbps) {
                r = "upload";
                why = `upload medido de ${Math.round(up.kbps)} kbps para ${n} espectadores`;
            }
            const next = r && stepDown(level, this.preferMotion());
            if (!r || !next) break;
            level = next;
            reason = r;
        }
        if (reason && level !== this.global) this.setGlobal(level, reason, now, `mais um espectador: ${why}`, "down");
    }

    /**
     * A janela nova da rede de UM espectador (ver NET_* no topo): atualiza os periodos seguidos de problema e devolve o
     * motivo para descer o degrau dele quando o problema ja durou mais que um soluco (CONGESTED_MS; so a banda curta,
     * SHORT_MS); null = nao desce. Na carencia de banda do espectador novo (levels.inBandwidthGrace), nada conta.
     */
    private trackNet(v: Active, now: number): { why: string; tag: string; } | null {
        const m = v.metrics;
        const n = v.net;
        const level = this.levelFor(v.peerId);
        if (n.level !== level) {
            n.level = level;
            n.congestedSince = n.troubleSince = null;
        }
        const need = LEVELS[level].minKbps;
        const est = m.availableKbps;
        if (m.rttFreshMs != null) n.rtts.push({ at: now, ms: m.rttFreshMs });
        while (n.rtts.length && now - n.rtts[0].at > RTT_BASE_MS) n.rtts.shift();
        const base = percentile(n.rtts.map(r => r.ms), RTT_BASE_PERCENTILE);
        n.backoff = n.lastEst != null && est != null && est <= n.lastEst * BACKOFF_RATIO;
        n.lastEst = est;
        const estBelow = est != null && need > 0 && est < need;

        const rtt = m.rttMs != null && base != null && m.rttMs - base >= NET_RTT_RISE_MS ? `RTT de ${Math.round(m.rttMs)} ms (${Math.round(base)} ms sem fila)` : null;
        // perda: sozinha so a partir de NET_LOSS_ALONE_PCT; de NET_LOSS_PCT para cima, com outro sinal de que o caminho encheu
        const loss = m.lossPct != null && (m.lossPct >= NET_LOSS_ALONE_PCT || (m.lossPct >= NET_LOSS_PCT && (!!rtt || n.backoff || estBelow)))
            ? `perda de ${dec(m.lossPct)}%` : null;
        const queue = m.pacerMs != null && m.pacerMs > NET_PACER_MS ? `fila de ${Math.round(m.pacerMs)} ms no envio` : null;
        const congestion = loss ?? rtt ?? queue;
        const short = estBelow && m.sentKbps >= est! * NET_FULL_RATIO ? `banda estimada ${Math.round(est!)} kbps, o degrau pede ${need}` : null;
        if (est != null && est >= need) n.enoughFor = level;
        n.trouble = !!(congestion || short);
        // recuo de quem sondou o caminho: o estimador (GCC) sobe ate passar do que o caminho leva e recua um pouco, de novo a
        // cada 5-15 s (ex.: 720p60 num caminho de ~10 Mbps, que leva o 1080p60 com folga). Sem outro sinal (problema ou banda
        // estimada abaixo do degrau) e caindo para perto do que enviavamos (PROBE_LANDING), esse recuo nao tira a calma da
        // janela, senao a subida nunca completa; queda maior conta, como antes. Corrida aceita: um congestionamento que
        // comeca com o recuo uma janela antes da perda ou do RTT aparecerem deixa essa janela calma; uma subida que dai da
        // errado e desfeita e a espera dobra (BW_UNDONE_MS)
        const probed = n.lastSent != null && est != null && !estBelow && est >= n.lastSent * PROBE_LANDING;
        n.lastSent = m.sentKbps;
        n.windows.push({ at: now, ms: m.dt * 1000, quiet: !n.trouble && (!n.backoff || probed) && m.bandwidthFraction < ANY_LIMIT_FRACTION, est });
        while (now - n.windows[0].at > BW_MAX_HOLD_MS + BW_UP_STABLE_MS) n.windows.shift();

        const start = now - m.dt * 1000;
        const counts = !inBandwidthGrace(v.readyAt, now);
        n.congestedSince = counts && congestion ? n.congestedSince ?? start : null;
        n.troubleSince = counts && n.trouble ? n.troubleSince ?? start : null;
        // so a banda curta: depois de um soluco o estimador demora a voltar (SHORT_MS), se ela ja deu o que este degrau pede
        // (aqui ou num degrau que pede mais); senao e caminho estreito (CONGESTED_MS)
        const limit = n.enoughFor && LEVELS[n.enoughFor].minKbps >= need ? SHORT_MS : CONGESTED_MS;
        const since = n.congestedSince != null && now - n.congestedSince >= CONGESTED_MS ? n.congestedSince
            : n.troubleSince != null && now - n.troubleSince >= limit ? n.troubleSince : null;
        if (since == null) return null;
        return { why: `${congestion ?? short} há ${Math.round((now - since) / 1000)} s`, tag: loss ? "perda" : rtt ? "RTT" : queue ? "fila" : "banda estimada" };
    }

    private decide(now: number) {
        relax(this.globalHold, now);
        const active = [...this.viewers.values()].filter((v): v is Active => v.fresh && !!v.metrics && now >= v.ignoreUntil);
        if (!active.length) return;

        // placa de video (compartilhada): a mediana do tempo por quadro dos encoders por hardware passa do limite
        const gpu = this.gpuNow(active);
        const gpuLimit = GPU_LIMIT * this.frameMs(this.global);
        const gpuOver = gpu && gpu.ms > gpuLimit
            ? `mediana de ${gpu.ms.toFixed(1)} ms por quadro em ${gpu.count} ${gpu.count === 1 ? "encoder" : "encoders"} da placa, o limite é ${gpuLimit.toFixed(1)} ms`
            : null;

        // CPU (compartilhada): o encoder nao mantem o fps da fonte, ou o WebRTC corta resolucao por CPU. So encoders por
        // software: num por hardware, quadros atrasados e o "cpu" do WebRTC sao a placa de video (gpuOver)
        let fpsShort: string | null = null;
        let cpuBinding: string | null = null;
        let anyCpu = false;
        for (const v of active) {
            const m = v.metrics;
            if (m.hardware) continue;
            const level = this.levelFor(v.peerId);
            const spec = LEVELS[level];
            const expected = Math.min(spec.fps, m.sourceFps ?? spec.fps);
            // a rede e o gargalo (estimativa abaixo do teto do degrau e enviando quase tudo): quadros
            // descartados pelo controle de taxa nao sao CPU
            const netSaturated = m.availableKbps != null && m.availableKbps < spec.maxKbps * UP_AVAILABLE_RATIO
                && m.sentKbps >= m.availableKbps * NET_SATURATED;
            if (m.cpuFraction >= ANY_LIMIT_FRACTION) anyCpu = true;
            if (!fpsShort && m.sourceFps != null && m.sourceFps >= MIN_SOURCE_FPS && m.encodedFps < expected * FPS_SHORT_RATIO
                && m.bandwidthFraction < LIMITED_FRACTION && !netSaturated && (m.encodeBusy == null || m.encodeBusy >= BUSY_FOR_CPU))
                fpsShort = `${this.deps.label(v.peerId)} codificado a ${Math.round(m.encodedFps)} de ${Math.round(expected)} fps`;
            const target = this.targetHeight(level);
            if (!cpuBinding && m.cpuFraction >= LIMITED_FRACTION && m.frameHeight > 0 && m.frameHeight < target * BINDING_RATIO)
                cpuBinding = `o WebRTC reduziu ${this.deps.label(v.peerId)} para ${m.frameHeight}p por CPU (degrau ${target}p)`;
        }

        // rede: cada espectador com problema que dura (trackNet). Upload do streamer: alguem ja vai descer e a maioria esta
        // com problema agora ha UPLOAD_TROUBLE_MS (espectador novo, ainda na carencia de banda, nunca conta)
        const bwBad = new Map<Active, { why: string; tag: string; }>();
        for (const v of active) {
            const bad = this.trackNet(v, now);
            if (bad) bwBad.set(v, bad);
        }
        const troubled = active.filter(v => v.net.troubleSince != null && now - v.net.troubleSince >= UPLOAD_TROUBLE_MS);
        const uploadWide = this.viewers.size >= 2 && bwBad.size > 0 && troubled.length >= Math.max(2, Math.ceil(active.length / 2));

        this.gpuStreak = gpuOver ? this.gpuStreak + 1 : 0;
        this.fpsStreak = fpsShort ? this.fpsStreak + 1 : 0;
        this.cpuStreak = cpuBinding ? this.cpuStreak + 1 : 0;
        if (gpuOver || fpsShort || cpuBinding || uploadWide || anyCpu) this.globalHold.calmSince = now;

        const sinceDown = now - this.globalHold.lastDownAt;
        let globalChanged = false;
        if (gpuOver && this.gpuStreak >= GPU_STREAK && sinceDown >= DOWN_COOLDOWN_MS) {
            globalChanged = this.stepGlobalDown("gpu", now, gpuOver);
        } else if (fpsShort && this.fpsStreak >= FPS_STREAK && sinceDown >= DOWN_COOLDOWN_MS) {
            globalChanged = this.stepGlobalDown("cpu", now, fpsShort);
        } else if (cpuBinding && this.cpuStreak >= CPU_STREAK && sinceDown >= ADAPTATION_MEMORY_MS) {
            globalChanged = this.stepGlobalDown("cpu", now, cpuBinding);
        } else if (uploadWide && sinceDown >= DOWN_COOLDOWN_MS) {
            const total = active.reduce((acc, v) => acc + v.metrics.sentKbps, 0);
            this.uplink = { kbps: total, at: now };
            globalChanged = this.stepGlobalDown("upload", now, `${troubled.length} de ${active.length} espectadores com banda limitada, ${Math.round(total)} kbps enviados no total`);
        } else if (!gpuOver && !fpsShort && !cpuBinding && !uploadWide && this.global !== this.deps.ceiling) {
            globalChanged = this.tryGlobalUp(active, now);
        }

        if (uploadWide || globalChanged) {
            // o problema de rede de cada um era o upload (ou o degrau de todos mudou): os periodos recomecam
            for (const v of active) v.net.congestedSince = v.net.troubleSince = null;
            return;
        }

        // banda de cada espectador (so o degrau dele)
        const preferMotion = this.preferMotion();
        for (const v of active) {
            relax(v.bwHold, now);
            const bad = bwBad.get(v);
            const next = v.bwLevel !== this.deps.ceiling ? stepUp(v.bwLevel, this.deps.ceiling, preferMotion) : null;
            if (bad) {
                // sem espera entre duas descidas: depois de uma, o problema precisa durar de novo (trackNet recomeca a conta)
                const down = stepDown(this.levelFor(v.peerId), preferMotion);
                if (down) this.setViewerBw(v, down, now, bad.why, "down", `banda: ${bad.tag}`);
            } else if (next) {
                const share = calmShare(v.net, now, Math.max(v.bwHold.lastDownAt, v.bwHold.lastUpAt), v.bwHold.holdMs, readyFor(next));
                if (share != null && share >= CALM_SHARE)
                    this.setViewerBw(v, next, now, `estável em ${Math.round(share * 100)}% dos últimos ${Math.round(v.bwHold.holdMs / 1000)} s`, "up", "banda: estável");
            }
        }
    }

    private stepGlobalDown(reason: GlobalReason, now: number, why: string): boolean {
        const next = stepDown(this.global, this.preferMotion());
        if (!next) {
            this.fpsStreak = this.cpuStreak = this.gpuStreak = 0;
            this.globalHold.lastDownAt = now; // nao tenta de novo a cada janela
            logThrottled("auto-quality-floor", "warn", `Qualidade automática: já no mínimo (${levelText(this.global)}) e ainda limitado por ${REASON_LABEL[reason]} — ${why}`, 60_000);
            return false;
        }
        this.setGlobal(next, reason, now, why, "down");
        return true;
    }

    private tryGlobalUp(active: Active[], now: number): boolean {
        if (now - this.globalHold.calmSince < this.globalHold.holdMs) return false;
        const next = stepUp(this.global, this.deps.ceiling, this.preferMotion());
        if (!next) return false;
        const n = this.viewers.size;
        const gpu = this.predictGpu(next);
        if (gpu && gpu.ms > GPU_UP_LIMIT * this.frameMs(next)) return false;
        const load = this.predictLoad(next);
        if (load && (load.perEncoder > UP_MAX_BUSY || load.total > cpuBudget() * 0.8)) return false;
        const up = this.uplinkFresh(now);
        if (up && n * LEVELS[next].minKbps > up.kbps) return false;
        // desceu pelo upload: sobe a menos que a maioria (a mesma conta da descida) ainda nao esteja estavel ha
        // BW_UP_STABLE_MS com folga para `next`. So conta quem nao esta limitado pela propria rede abaixo de `next`; um Wi-Fi
        // instavel ou um espectador que acabou de entrar nao segura todos
        if (this.globalReason === "upload") {
            const considered = active.filter(v => isAtMost(next, v.bwLevel));
            const unsettled = considered.filter(v => (calmShare(v.net, now, -Infinity, BW_UP_STABLE_MS, readyFor(next)) ?? 0) < CALM_SHARE);
            if (unsettled.length >= Math.max(2, Math.ceil(considered.length / 2))) return false;
        }
        const stable = `estável há ${Math.round((now - this.globalHold.calmSince) / 1000)} s`;
        this.setGlobal(next, this.globalReason ?? "cpu", now, gpu ? `${stable}, previsão de ${gpu.ms.toFixed(1)} ms por quadro na placa` : stable, "up");
        return true;
    }

    private setGlobal(level: QualityLevel, reason: GlobalReason, now: number, why: string, dir: "down" | "up") {
        const from = this.global;
        if (dir === "down") noteDown(this.globalHold, now);
        else noteUp(this.globalHold, now);
        this.global = level;
        this.globalReason = level === this.deps.ceiling ? null : reason;
        this.fpsStreak = this.cpuStreak = this.gpuStreak = 0;
        for (const v of this.viewers.values()) {
            v.ignoreUntil = Math.max(v.ignoreUntil, now + SETTLE_MS);
            v.changeWhy = dir === "up" ? `${REASON_LABEL[reason]}: estável` : REASON_LABEL[reason];
        }
        const n = this.viewers.size;
        log.info(`Qualidade automática: ${levelText(from)} → ${levelText(level)} para ${n === 1 ? "o espectador" : `os ${n} espectadores`} (${REASON_LABEL[reason]}: ${why})`
            + (dir === "down" ? `; nova subida só após ${Math.round(this.globalHold.holdMs / 1000)} s estável` : ""));
        this.emit();
    }

    private setViewerBw(v: ViewerState, level: QualityLevel, now: number, why: string, dir: "down" | "up", tag: string) {
        const from = this.levelFor(v.peerId);
        if (dir === "down") noteDown(v.bwHold, now);
        else noteUp(v.bwHold, now);
        v.bwLevel = level;
        v.net.congestedSince = v.net.troubleSince = null;
        v.ignoreUntil = Math.max(v.ignoreUntil, now + SETTLE_MS);
        v.changeWhy = tag;
        const to = this.levelFor(v.peerId);
        if (to !== from) log.info(`Qualidade automática: ${levelText(from)} → ${levelText(to)} para ${this.deps.label(v.peerId)} (banda: ${why})`
            + (dir === "down" ? `; nova subida só após ${Math.round(v.bwHold.holdMs / 1000)} s estável` : ""));
        this.emit();
    }

    // #endregion

    // #region aplicacao e estado

    private applyViewer(v: ViewerState) {
        if (!v.ready || v.applying || this.disposed) return;
        const level = this.levelFor(v.peerId);
        if (v.applied === level && !v.resized) return;
        // falhou: o resized volta, para tentar de novo na proxima avaliacao
        const { resized } = v;
        v.resized = false;
        v.applying = true;
        this.deps.apply(v.peerId, level).then(ok => {
            v.applying = false;
            if (!ok) v.resized ||= resized;
            if (!ok || this.disposed || this.viewers.get(v.peerId) !== v) return;
            v.applied = level;
            if (this.levelFor(v.peerId) !== level || v.resized) this.applyViewer(v);
        }, () => {
            v.applying = false;
            v.resized ||= resized;
        });
    }

    private buildState(): AutoQualityState | null {
        if (!this.deps.enabled()) return null;
        const { ceiling } = this.deps;
        const viewers: Record<PeerId, AutoQualityViewer> = {};
        let current: QualityLevel = this.viewers.size ? ceiling : this.global;
        let reason: QualityReason | null = this.viewers.size ? null : this.globalReason;
        for (const v of this.viewers.values()) {
            const level = this.levelFor(v.peerId);
            const r: QualityReason | null = level === ceiling ? null : level === this.global ? this.globalReason : "bandwidth";
            viewers[v.peerId] = { level, reason: r };
            if (rank(level) < rank(current) || (rank(level) === rank(current) && r && !reason)) {
                current = level;
                reason = r;
            }
        }
        return { current, reason, reasonText: reasonText(current, reason, this.viewers.size), viewers };
    }

    private emit() {
        this.noteLevels();
        const next = this.buildState();
        const key = JSON.stringify(next);
        if (key === this.publishedKey) return;
        this.published = next;
        this.publishedKey = key;
        this.deps.changed();
    }

    // #endregion
}
