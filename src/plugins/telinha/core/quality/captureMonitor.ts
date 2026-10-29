/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Detector de captura preta/congelada. A cada 500 ms desenha a faixa de video (num <video> fora do
// DOM) num canvas 64x36 e mede o brilho medio e a diferenca para a amostra anterior. Nada por
// quadro no main thread alem dessa amostra.
//
// - preta: brilho ~0 em toda a imagem por >=2 s (jogo em tela cheia exclusiva, conteudo protegido).
// - congelada: SO para janelas, e SO quando a fonte parou de entregar quadros (contador de quadros
//   da faixa, ou do media-source de um sender) por >=3 s com a imagem identica. Imagem parada com
//   quadros chegando e conteudo estatico legitimo (desktop, menu pausado): nao avisa.

import { errorText, log } from "@plugins/telinha/core/log";

export const BLACK_WARNING = "A imagem está preta: se for um jogo em tela cheia exclusiva, mude para 'Sem bordas' (janela sem bordas) nas opções de vídeo do jogo.";
export const FROZEN_WARNING = "A janela parece minimizada — seus amigos estão vendo a imagem congelada. Restaure a janela do jogo.";

const SAMPLE_MS = 500;
const W = 64;
const H = 36;
const N = W * H;
const BLACK_MS = 2000;
const FROZEN_MS = 3000;
/** brilho medio (0..255) e brilho maximo de uma imagem "preta" */
const BLACK_MEAN = 6;
const BLACK_MAX = 24;
/** diferenca media de brilho entre amostras: abaixo = identica; acima = movimento */
const SAME_DIFF = 0.5;
const MOTION_DIFF = 2;
/** contador de quadros mais velho que isto nao serve para dizer que a fonte parou */
const FRAMES_FRESH_MS = 6000;

export interface CaptureMonitorOptions {
    track: MediaStreamTrack;
    kind: "screen" | "window";
    /** mensagem pt-BR, ou null quando o problema some */
    onWarning(message: string | null): void;
}

export class CaptureMonitor {
    private readonly opts: CaptureMonitorOptions;
    private video: HTMLVideoElement | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private prev: Uint8Array | null = null;
    private spare: Uint8Array | null = null;
    private blackSince: number | null = null;
    private sameSince: number | null = null;
    private frames: { key: string; count: number; changedAt: number; seenAt: number; } | null = null;
    private motionEma: number | null = null;
    private warning: string | null = null;
    private errors = 0;

    constructor(opts: CaptureMonitorOptions) {
        this.opts = opts;
    }

    start(): boolean {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
            if (!ctx) return false;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "low";

            const video = document.createElement("video");
            video.muted = true;
            video.playsInline = true;
            video.srcObject = new MediaStream([this.opts.track]);
            video.play().catch(() => { });

            this.video = video;
            this.ctx = ctx;
            this.timer = setInterval(() => this.sample(), SAMPLE_MS);
            return true;
        } catch (e) {
            log.warn("Monitor da captura indisponível: " + errorText(e));
            this.stop();
            return false;
        }
    }

    /** Nao para a faixa (ela e da transmissao): so solta o <video> e o timer. */
    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.video) {
            this.video.pause();
            this.video.srcObject = null;
        }
        this.video = null;
        this.ctx = null;
        this.prev = this.spare = null;
    }

    /** Movimento recente na imagem (0..1, ~5 s de memoria); null = sem amostras ainda. */
    motion(): number | null {
        return this.motionEma;
    }

    /** Contador de quadros do media-source de um sender; so usado se a faixa nao tiver `stats`. */
    noteSourceFrames(key: string, count: number) {
        if (this.trackFrames() != null) return;
        this.noteFrames(key, count, performance.now());
    }

    /** MediaStreamTrack.stats.totalFrames (Chromium recente): quadros que a fonte entregou. */
    private trackFrames(): number | null {
        try {
            const total = (this.opts.track as any).stats?.totalFrames;
            return typeof total === "number" && Number.isFinite(total) ? total : null;
        } catch {
            return null;
        }
    }

    private noteFrames(key: string, count: number, now: number) {
        const f = this.frames;
        if (!f || f.key !== key || f.count !== count) this.frames = { key, count, changedAt: now, seenAt: now };
        else f.seenAt = now;
    }

    private sample() {
        const { video, ctx } = this;
        if (!video || !ctx) return;
        const now = performance.now();
        const total = this.trackFrames();
        if (total != null) this.noteFrames("track", total, now);
        if (video.readyState < 2 || !video.videoWidth) return; // HAVE_CURRENT_DATA

        let data: Uint8ClampedArray;
        try {
            ctx.drawImage(video, 0, 0, W, H);
            ({ data } = ctx.getImageData(0, 0, W, H));
        } catch (e) {
            if (++this.errors === 3) {
                log.warn("Monitor da captura parou: " + errorText(e));
                this.stop();
            }
            return;
        }

        const { prev } = this;
        const cur = this.spare ?? new Uint8Array(N);
        let sum = 0;
        let max = 0;
        let diff = 0;
        for (let i = 0, p = 0; i < N; i++, p += 4) {
            const y = (data[p] * 54 + data[p + 1] * 183 + data[p + 2] * 19) >> 8;
            cur[i] = y;
            sum += y;
            if (y > max) max = y;
            if (prev) diff += Math.abs(y - prev[i]);
        }
        this.spare = prev;
        this.prev = cur;

        const black = sum / N <= BLACK_MEAN && max <= BLACK_MAX;
        this.blackSince = black ? (this.blackSince ?? now) : null;
        if (prev) {
            const meanDiff = diff / N;
            this.sameSince = meanDiff < SAME_DIFF ? (this.sameSince ?? now) : null;
            const moving = meanDiff >= MOTION_DIFF ? 1 : 0;
            this.motionEma = this.motionEma == null ? moving : this.motionEma * 0.9 + moving * 0.1;
        }
        this.update(now);
    }

    private update(now: number) {
        const f = this.frames;
        const stalledFor = this.opts.kind === "window" && f && now - f.seenAt < FRAMES_FRESH_MS ? now - f.changedAt : 0;
        const frozen = stalledFor >= FROZEN_MS && this.sameSince != null && now - this.sameSince >= FROZEN_MS;
        const black = this.blackSince != null && now - this.blackSince >= BLACK_MS;
        const next = frozen ? FROZEN_WARNING : black ? BLACK_WARNING : null;
        if (next === this.warning) return;

        const was = this.warning;
        this.warning = next;
        if (next === FROZEN_WARNING)
            log.warn(`Captura congelada: a janela não manda quadros novos há ${Math.round(stalledFor / 1000)} s (minimizada?)`);
        else if (next === BLACK_WARNING)
            log.warn(`Captura preta há ${Math.round((now - (this.blackSince ?? now)) / 1000)} s (tela cheia exclusiva ou conteúdo protegido?)`);
        else
            log.info(`Captura normal de novo (${was === FROZEN_WARNING ? "quadros voltaram a chegar" : "a imagem não está mais preta"})`);
        this.opts.onWarning(next);
    }
}
