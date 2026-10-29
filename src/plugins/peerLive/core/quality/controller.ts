/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
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

import { log, logThrottled } from "@plugins/peerLive/core/log";
import type { AutoQualityState, AutoQualityViewer, PeerId, Quality, QualityLevel, QualityReason } from "@plugins/peerLive/types";

import { LEVELS, levelText, meet, pixelRate, rank, stepDown, stepUp } from "./levels";
import { diffSamples, readSenderSample, type SenderSample, type WindowMetrics } from "./stats";

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
const STATIC_SOURCE_FPS = 15;
const MOTION_THRESHOLD = 0.35;

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
}

type Active = ViewerState & { metrics: WindowMetrics; };

function cpuBudget() {
    const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
    return Math.max(1, cores * 0.5);
}

function reasonText(level: QualityLevel, reason: QualityReason | null, viewers: number): string | null {
    if (!reason) return null;
    const why = reason === "cpu"
        ? (viewers > 1 ? `o processador não dá conta de ${viewers} espectadores` : "o processador está sobrecarregado")
        : reason === "upload"
            ? "o seu upload está no limite"
            : (viewers > 1 ? "a conexão de um espectador está limitada" : "a conexão com o espectador está limitada");
    return `${levelText(level)} — ${why}`;
}

const REASON_LABEL: Record<QualityReason, string> = { cpu: "CPU", upload: "upload", bandwidth: "banda" };

export class QualityController {
    private readonly deps: QualityDeps;
    private readonly viewers = new Map<PeerId, ViewerState>();
    private global: QualityLevel;
    private globalReason: "cpu" | "upload" | null = null;
    private globalHold: Hold;
    private fpsStreak = 0;
    private cpuStreak = 0;
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

    /** Antes de negociar: ja entra no degrau atual (e desce todos se mais um encode nao cabe). */
    addViewer(peerId: PeerId) {
        if (this.disposed || this.viewers.has(peerId)) return;
        const now = performance.now();
        this.viewers.set(peerId, {
            peerId, ready: false, ignoreUntil: now + WARMUP_MS, prev: null, metrics: null, fresh: false,
            bwLevel: this.deps.ceiling, bwHold: newHold(now), bwStreak: 0, applied: null, applying: false
        });
        if (this.deps.enabled()) this.preempt(now);
        this.emit();
    }

    /** O sender do espectador existe: aplica o degrau. */
    markReady(peerId: PeerId) {
        const v = this.viewers.get(peerId);
        if (!v || this.disposed) return;
        v.ready = true;
        v.ignoreUntil = Math.max(v.ignoreUntil, performance.now() + WARMUP_MS);
        this.applyViewer(v);
    }

    removeViewer(peerId: PeerId) {
        if (this.viewers.delete(peerId)) this.emit();
    }

    /** A configuracao autoQuality mudou: volta todos para o teto e recomeca. */
    settingChanged() {
        if (this.disposed) return;
        const now = performance.now();
        this.global = this.deps.ceiling;
        this.globalReason = null;
        this.globalHold = newHold(now);
        this.fpsStreak = this.cpuStreak = this.uploadStreak = 0;
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

    /**
     * Custo de codificacao previsto no degrau `level` com `n` espectadores, extrapolado do custo por
     * pixel medido agora (fracao do tempo de parede codificando; somada entre os encoders).
     */
    private predictLoad(level: QualityLevel, n: number): { total: number; perEncoder: number; } | null {
        let sum = 0;
        let count = 0;
        let max = 0;
        for (const v of this.viewers.values()) {
            const m = v.metrics;
            if (!m || m.encodeBusy == null || m.pixelsPerSecond <= 0 || m.encodedFps < 5) continue;
            const cost = m.encodeBusy / m.pixelsPerSecond;
            sum += cost;
            count++;
            max = Math.max(max, cost);
        }
        if (!count) return null;
        const { width, height } = this.deps.captureSize();
        const { fps } = LEVELS[level];
        const rate = pixelRate(level, width || 1920, height || 1080) / fps * Math.min(fps, this.sourceFpsEma ?? fps);
        return { total: (sum / count) * rate * n, perEncoder: max * rate };
    }

    /** Mais um espectador = mais um encode e mais upload: desce antes se a previsao ja nao cabe. */
    private preempt(now: number) {
        const n = this.viewers.size;
        let level = this.global;
        let reason: "cpu" | "upload" | null = null;
        let why = "";
        for (let i = 0; i < 2; i++) {
            const load = this.predictLoad(level, n);
            const up = this.uplinkFresh(now);
            let r: "cpu" | "upload" | null = null;
            if (load && load.total > cpuBudget()) {
                r = "cpu";
                why = `previsão de ${load.total.toFixed(1)} núcleos codificando para ${n} espectadores`;
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

        // CPU (compartilhada): o encoder nao mantem o fps da fonte, ou o WebRTC corta resolucao por CPU
        let fpsShort: string | null = null;
        let cpuBinding: string | null = null;
        let anyCpu = false;
        for (const v of active) {
            const m = v.metrics;
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
        const bwBad = new Map<Active, string>();
        for (const v of active) {
            const why = this.bandwidthProblem(v, now);
            if (why) bwBad.set(v, why);
        }
        const uploadWide = this.viewers.size >= 2 && bwBad.size >= Math.max(2, Math.ceil(active.length / 2));

        this.fpsStreak = fpsShort ? this.fpsStreak + 1 : 0;
        this.cpuStreak = cpuBinding ? this.cpuStreak + 1 : 0;
        this.uploadStreak = uploadWide ? this.uploadStreak + 1 : 0;
        if (fpsShort || cpuBinding || uploadWide || anyCpu) this.globalHold.calmSince = now;

        const sinceDown = now - this.globalHold.lastDownAt;
        let globalChanged = false;
        if (fpsShort && this.fpsStreak >= FPS_STREAK && sinceDown >= DOWN_COOLDOWN_MS) {
            globalChanged = this.stepGlobalDown("cpu", now, fpsShort);
        } else if (cpuBinding && this.cpuStreak >= CPU_STREAK && sinceDown >= ADAPTATION_MEMORY_MS) {
            globalChanged = this.stepGlobalDown("cpu", now, cpuBinding);
        } else if (uploadWide && this.uploadStreak >= BW_STREAK && sinceDown >= DOWN_COOLDOWN_MS) {
            const total = active.reduce((acc, v) => acc + v.metrics.sentKbps, 0);
            this.uplink = { kbps: total, at: now };
            globalChanged = this.stepGlobalDown("upload", now, `${bwBad.size} de ${active.length} espectadores com banda limitada, ${Math.round(total)} kbps enviados no total`);
        } else if (!fpsShort && !cpuBinding && !uploadWide && this.global !== this.deps.ceiling) {
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
                if (next && (avail == null || avail >= LEVELS[current].maxKbps * UP_AVAILABLE_RATIO))
                    this.setViewerBw(v, next, now, `estável há ${Math.round((now - v.bwHold.calmSince) / 1000)} s`, "up");
            }
        }
    }

    private stepGlobalDown(reason: "cpu" | "upload", now: number, why: string): boolean {
        const next = stepDown(this.global, this.preferMotion());
        if (!next) {
            this.fpsStreak = this.cpuStreak = this.uploadStreak = 0;
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
        const load = this.predictLoad(next, n);
        if (load && (load.perEncoder > UP_MAX_BUSY || load.total > cpuBudget() * 0.8)) return false;
        const up = this.uplinkFresh(now);
        if (up && n * LEVELS[next].minKbps > up.kbps) return false;
        if (this.globalReason === "upload" && active.some(v =>
            v.metrics.availableKbps != null && v.metrics.availableKbps < LEVELS[this.levelFor(v.peerId)].maxKbps * UP_AVAILABLE_RATIO))
            return false;
        this.setGlobal(next, this.globalReason ?? "cpu", now, `estável há ${Math.round((now - this.globalHold.calmSince) / 1000)} s`, "up");
        return true;
    }

    private setGlobal(level: QualityLevel, reason: "cpu" | "upload", now: number, why: string, dir: "down" | "up") {
        const from = this.global;
        if (dir === "down") noteDown(this.globalHold, now);
        else noteUp(this.globalHold, now);
        this.global = level;
        this.globalReason = level === this.deps.ceiling ? null : reason;
        this.fpsStreak = this.cpuStreak = this.uploadStreak = 0;
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
        if (v.applied === level) return;
        v.applying = true;
        this.deps.apply(v.peerId, level).then(ok => {
            v.applying = false;
            if (!ok || this.disposed || this.viewers.get(v.peerId) !== v) return;
            v.applied = level;
            if (this.levelFor(v.peerId) !== level) this.applyViewer(v);
        }, () => {
            v.applying = false;
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
