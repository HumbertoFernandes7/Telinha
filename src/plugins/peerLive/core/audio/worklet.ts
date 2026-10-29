/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Codigo do AudioWorkletProcessor que toca o PCM do helper num MediaStreamAudioDestinationNode.
// Vai como texto (carregado via blob:/data: URL), entao precisa ser JS puro e SO ASCII (data: URL usa btoa).
//
// - Buffer circular de ~2,7 s por canal; o renderer manda ArrayBuffers de float32 estereo intercalado.
// - Jitter buffer: so comeca (e recomeca apos um underrun) com `target` ms acumulados. Cada underrun
//   aumenta o alvo em 20 ms (ate maxTargetMs): o renderer do Discord as vezes trava por GC/React.
// - Deriva de relogio (relogio do audio do Windows x relogio do AudioContext): le com taxa
//   1 +- 0,4% (interpolacao linear) puxando a media movel do preenchimento para o alvo; acima de
//   alvo + 300 ms descarta o excesso de uma vez.
// - A cada ~2 s posta { type: "stats" } para diagnostico.

export const PCM_PLAYER_PROCESSOR = "peerlive-pcm-player";

export const PCM_PLAYER_SOURCE = String.raw`
"use strict";
const CAP = 131072;
const MASK = CAP - 1;
const MAX_RATIO = 0.004;
const GAIN = 0.008;

class PeerLivePcmPlayer extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        const ms = v => Math.round(sampleRate * v / 1000);
        this.target = ms(Math.max(20, Math.min(500, Number(o.targetMs) || 80)));
        this.maxTarget = ms(Math.max(40, Math.min(1000, Number(o.maxTargetMs) || 200)));
        this.step = ms(20);
        this.excess = ms(300);
        this.l = new Float32Array(CAP);
        this.r = new Float32Array(CAP);
        this.w = 0;
        this.rd = 0;
        this.count = 0;
        this.frac = 0;
        this.priming = true;
        this.ema = this.target;
        this.alpha = 128 / sampleRate;
        this.ratio = 1;
        this.underruns = 0;
        this.dropped = 0;
        this.received = 0;
        this.nextStats = sampleRate * 2;
        this.alive = true;
        this.port.onmessage = e => this.onMessage(e.data);
    }

    onMessage(d) {
        if (d instanceof ArrayBuffer) this.push(new Float32Array(d));
        else if (d && d.type === "stop") this.alive = false;
    }

    push(f) {
        let frames = f.length >> 1;
        let start = 0;
        if (frames > CAP - 1) {
            start = (frames - (CAP - 1)) * 2;
            frames = CAP - 1;
        }
        const l = this.l, r = this.r;
        let w = this.w;
        for (let i = 0, j = start; i < frames; i++, j += 2) {
            const a = f[j], b = f[j + 1];
            l[w] = a === a ? a : 0;
            r[w] = b === b ? b : 0;
            w = (w + 1) & MASK;
        }
        this.w = w;
        this.count += frames;
        this.received += frames;
        const limit = Math.min(CAP - 1, this.target + this.excess);
        if (this.count > limit) {
            const drop = this.count - this.target;
            this.rd = (this.rd + drop) & MASK;
            this.count -= drop;
            this.dropped += drop;
            this.frac = 0;
            this.ema = this.count;
        }
    }

    stats() {
        this.port.postMessage({
            type: "stats",
            fillMs: Math.round(this.count * 1000 / sampleRate),
            targetMs: Math.round(this.target * 1000 / sampleRate),
            ratio: this.ratio,
            underruns: this.underruns,
            droppedMs: Math.round(this.dropped * 1000 / sampleRate),
            receivedMs: Math.round(this.received * 1000 / sampleRate)
        });
    }

    process(inputs, outputs) {
        const out = outputs[0];
        if (!out || !out.length) return this.alive;
        const L = out[0], R = out.length > 1 ? out[1] : null;
        const n = L.length;

        if (currentFrame >= this.nextStats) {
            this.nextStats = currentFrame + sampleRate * 2;
            this.stats();
        }

        if (this.priming) {
            if (this.count >= this.target) {
                this.priming = false;
                this.ema = this.count;
            } else {
                L.fill(0);
                if (R) R.fill(0);
                return this.alive;
            }
        }

        this.ema += (this.count - this.ema) * this.alpha;
        const err = (this.ema - this.target) / this.target;
        const ratio = 1 + Math.max(-MAX_RATIO, Math.min(MAX_RATIO, err * GAIN));
        this.ratio = ratio;

        if (this.count < Math.ceil(this.frac + n * ratio) + 2) {
            this.underruns++;
            this.priming = true;
            this.target = Math.min(this.maxTarget, this.target + this.step);
            L.fill(0);
            if (R) R.fill(0);
            return this.alive;
        }

        const l = this.l, r = this.r;
        let rd = this.rd, frac = this.frac, used = 0;
        for (let i = 0; i < n; i++) {
            const i1 = (rd + 1) & MASK;
            L[i] = l[rd] + (l[i1] - l[rd]) * frac;
            if (R) R[i] = r[rd] + (r[i1] - r[rd]) * frac;
            frac += ratio;
            const adv = Math.floor(frac);
            frac -= adv;
            rd = (rd + adv) & MASK;
            used += adv;
        }
        this.rd = rd;
        this.frac = frac;
        this.count -= used;
        return this.alive;
    }
}

registerProcessor("${PCM_PLAYER_PROCESSOR}", PeerLivePcmPlayer);
`;
