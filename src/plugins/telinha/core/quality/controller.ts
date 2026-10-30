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
// Cuidados com a adaptacao propria do WebRTC (degradationPreference "maintain-framerate"):
// ao sentir CPU/banda ele mesmo reduz a resolucao, e so desfaz depois de >=10 s sem sobrecarga.
// Logo, "qualityLimitationReason = cpu" continua aparecendo depois que nos ja descemos; so conta
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
import type { AutoQualityState, AutoQualityViewer, PeerId, Quality, QualityLevel, QualityReason } from "@plugins/telinha/types";

import { inBandwidthGrace, LEVELS, levelText, meet, pixelRate, rank, stepDown, stepUp } from "./levels";
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
const BW_STREAK = 3;

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

interface Hold {
    holdMs: number;
    lastDownAt: number;
    lastUpAt: number;
    /** sem sinal de problema desde */
    calmSince: number;
}

const newHold = (now: number): Hold => ({ holdMs: BASE_HOLD_MS, lastDownAt: -Infinity, lastUpAt: -Infinity, calmSince: now });

function noteDown(h: Hold, now: number) {
    if (now - h.lastUpAt < FAILED_UP_MS) h.holdMs = Math.min(h.holdMs * 2, MAX_HOLD_MS);
    h.lastDownAt = h.calmSince = now;
}

function noteUp(h: Hold, now: number) {
    h.lastUpAt = h.calmSince = now;
}

function relax(h: Hold, now: number) {
    if (h.holdMs > BASE_HOLD_MS && now - h.lastDownAt >= HOLD_RESET_MS) h.holdMs = BASE_HOLD_MS;
}

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
    bwStreak: number;
    applied: QualityLevel | null;
    applying: boolean;
    /** a captura mudou de tamanho depois do ultimo apply: reaplicar o mesmo degrau (captureResized) */
    resized: boolean;
    /** antes da primeira medida: o encoder dele deve rodar na placa de video? (addViewer; undefined = como os ja medidos) */
    expectGpu: boolean | undefined;
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
    private uploadStreak = 0;
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
        this.globalHold = newHold(performance.now());
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
            bwLevel: this.deps.ceiling, bwHold: newHold(now), bwStreak: 0, applied: null, applying: false, resized: false, expectGpu: gpu
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
        if (this.viewers.delete(peerId)) this.emit();
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

    /** A configuracao autoQuality mudou: volta todos para o teto e recomeca. */
    settingChanged() {
        if (this.disposed) return;
        const now = performance.now();
        this.global = this.deps.ceiling;
        this.globalReason = null;
        this.globalHold = newHold(now);
        this.fpsStreak = this.cpuStreak = this.gpuStreak = this.uploadStreak = 0;
        this.uplink = null;
        for (const v of this.viewers.values()) {
            v.bwLevel = this.deps.ceiling;
            v.bwHold = newHold(now);
            v.bwStreak = 0;
            v.ignoreUntil = Math.max(v.ignoreUntil, now + SETTLE_MS);
            this.applyViewer(v);
        }
        log.info(this.deps.enabled()
            ? `Qualidade automática ligada (teto ${levelText(this.deps.ceiling)})`
            : `Qualidade automática desligada: todos recebem ${levelText(this.deps.ceiling)}`);
        this.emit();
    }

    dispose() {
        this.disposed = true;
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

    private bandwidthProblem(v: Active, now: number): string | null {
        const m = v.metrics;
        const level = this.levelFor(v.peerId);
        const spec = LEVELS[level];
        if (m.availableKbps != null && spec.minKbps > 0 && m.availableKbps < spec.minKbps)
            return `banda estimada ${Math.round(m.availableKbps)} kbps, o degrau pede ${spec.minKbps}`;
        const target = this.targetHeight(level);
        const sinceDown = now - Math.max(v.bwHold.lastDownAt, this.globalHold.lastDownAt);
        if (m.bandwidthFraction >= LIMITED_FRACTION && m.frameHeight > 0 && m.frameHeight < target * BINDING_RATIO && sinceDown >= ADAPTATION_MEMORY_MS)
            return `o WebRTC reduziu para ${m.frameHeight}p por banda (degrau ${target}p)`;
        return null;
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

        // banda: a maioria limitada ao mesmo tempo = o upload do streamer
        // (espectador novo, ainda na carencia de banda, fica de fora: nao entra em bwBad, entao nao soma
        // no upload geral e o bwStreak dele volta a zero no laco por espectador)
        const bwBad = new Map<Active, string>();
        for (const v of active) {
            if (inBandwidthGrace(v.readyAt, now)) continue;
            const why = this.bandwidthProblem(v, now);
            if (why) bwBad.set(v, why);
        }
        const uploadWide = this.viewers.size >= 2 && bwBad.size >= Math.max(2, Math.ceil(active.length / 2));

        this.gpuStreak = gpuOver ? this.gpuStreak + 1 : 0;
        this.fpsStreak = fpsShort ? this.fpsStreak + 1 : 0;
        this.cpuStreak = cpuBinding ? this.cpuStreak + 1 : 0;
        this.uploadStreak = uploadWide ? this.uploadStreak + 1 : 0;
        if (gpuOver || fpsShort || cpuBinding || uploadWide || anyCpu) this.globalHold.calmSince = now;

        const sinceDown = now - this.globalHold.lastDownAt;
        let globalChanged = false;
        if (gpuOver && this.gpuStreak >= GPU_STREAK && sinceDown >= DOWN_COOLDOWN_MS) {
            globalChanged = this.stepGlobalDown("gpu", now, gpuOver);
        } else if (fpsShort && this.fpsStreak >= FPS_STREAK && sinceDown >= DOWN_COOLDOWN_MS) {
            globalChanged = this.stepGlobalDown("cpu", now, fpsShort);
        } else if (cpuBinding && this.cpuStreak >= CPU_STREAK && sinceDown >= ADAPTATION_MEMORY_MS) {
            globalChanged = this.stepGlobalDown("cpu", now, cpuBinding);
        } else if (uploadWide && this.uploadStreak >= BW_STREAK && sinceDown >= DOWN_COOLDOWN_MS) {
            const total = active.reduce((acc, v) => acc + v.metrics.sentKbps, 0);
            this.uplink = { kbps: total, at: now };
            globalChanged = this.stepGlobalDown("upload", now, `${bwBad.size} de ${active.length} espectadores com banda limitada, ${Math.round(total)} kbps enviados no total`);
        } else if (!gpuOver && !fpsShort && !cpuBinding && !uploadWide && this.global !== this.deps.ceiling) {
            globalChanged = this.tryGlobalUp(active, now);
        }

        if (uploadWide || globalChanged) {
            for (const v of active) v.bwStreak = 0;
            return;
        }

        // banda de cada espectador (so o degrau dele)
        const preferMotion = this.preferMotion();
        for (const v of active) {
            relax(v.bwHold, now);
            const why = bwBad.get(v);
            v.bwStreak = why ? v.bwStreak + 1 : 0;
            if (why || v.metrics.bandwidthFraction >= ANY_LIMIT_FRACTION) v.bwHold.calmSince = now;
            const current = this.levelFor(v.peerId);
            if (why) {
                const next = v.bwStreak >= BW_STREAK && now - v.bwHold.lastDownAt >= DOWN_COOLDOWN_MS ? stepDown(current, preferMotion) : null;
                if (next) this.setViewerBw(v, next, now, why, "down");
            } else if (v.bwLevel !== this.deps.ceiling && now - v.bwHold.calmSince >= v.bwHold.holdMs) {
                const next = stepUp(v.bwLevel, this.deps.ceiling, preferMotion);
                const avail = v.metrics.availableKbps;
                if (next && (avail == null || avail >= LEVELS[next].minKbps * UP_HEADROOM))
                    this.setViewerBw(v, next, now, `estável há ${Math.round((now - v.bwHold.calmSince) / 1000)} s`, "up");
            }
        }
    }

    private stepGlobalDown(reason: GlobalReason, now: number, why: string): boolean {
        const next = stepDown(this.global, this.preferMotion());
        if (!next) {
            this.fpsStreak = this.cpuStreak = this.gpuStreak = this.uploadStreak = 0;
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
        if (this.globalReason === "upload" && active.some(v =>
            v.metrics.availableKbps != null && v.metrics.availableKbps < LEVELS[meet(next, v.bwLevel)].minKbps * UP_HEADROOM))
            return false;
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
        this.fpsStreak = this.cpuStreak = this.gpuStreak = this.uploadStreak = 0;
        for (const v of this.viewers.values()) v.ignoreUntil = Math.max(v.ignoreUntil, now + SETTLE_MS);
        const n = this.viewers.size;
        log.info(`Qualidade automática: ${levelText(from)} → ${levelText(level)} para ${n === 1 ? "o espectador" : `os ${n} espectadores`} (${REASON_LABEL[reason]}: ${why})`
            + (dir === "down" ? `; nova subida só após ${Math.round(this.globalHold.holdMs / 1000)} s estável` : ""));
        this.emit();
    }

    private setViewerBw(v: ViewerState, level: QualityLevel, now: number, why: string, dir: "down" | "up") {
        const from = this.levelFor(v.peerId);
        if (dir === "down") noteDown(v.bwHold, now);
        else noteUp(v.bwHold, now);
        v.bwLevel = level;
        v.bwStreak = 0;
        v.ignoreUntil = Math.max(v.ignoreUntil, now + SETTLE_MS);
        const to = this.levelFor(v.peerId);
        if (to !== from) log.info(`Qualidade automática: ${levelText(from)} → ${levelText(to)} para ${this.deps.label(v.peerId)} (banda: ${why})`);
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
        const next = this.buildState();
        const key = JSON.stringify(next);
        if (key === this.publishedKey) return;
        this.published = next;
        this.publishedKey = key;
        this.deps.changed();
    }

    // #endregion
}
