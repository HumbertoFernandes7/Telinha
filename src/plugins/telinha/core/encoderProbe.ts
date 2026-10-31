/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Sonda do H.264 da placa de video fora do WebRTC (Telinha 0.2.9): um VideoEncoder do WebCodecs num Worker proprio,
// avc1.<perfil que a placa codifica> em 1280x720@30 com hardwareAcceleration "prefer-hardware", ~30 quadros de um
// OffscreenCanvas e um prazo duro para os pacotes sairem. Passa pelo mesmo encoder da placa (MediaFoundation no processo
// da GPU), mas nao pelas threads do WebRTC: se travar, so este Worker fica preso. Validado em 31/10/2026 no PC que trava
// (AMD Radeon RX 9070 XT, Edge 156, tools/teste-placa): configure ok, 60 quadros, 0 pacotes e o flush() sem resposta em
// 5 s, com a pagina respondendo; o VP9 no mesmo teste saiu em 41 ms.
//
// Resultado:
// - "broken": a placa aceitou a configuracao (isConfigSupported + configure) e, no prazo, nenhum pacote saiu ou o flush()
//   nao terminou. Quem chama marca o PC como "o H.264 da placa trava" (core/stuckEncoder.ts) antes da 1a transmissao;
// - "unknown": sem Worker/WebCodecs, configuracao recusada (sem H.264 na placa nesse perfil), configure lancou, erro do
//   encoder ou a propria consulta sem resposta: nada muda;
// - "ok": pacotes sairam e o flush terminou.
// Encoder ou Worker presos NUNCA sao fechados nem terminados (o close/terminate desmontaria o encoder preso, o mesmo
// risco do WebRTC): ficam guardados em `leftAlone` ate o Discord fechar. So um que terminou normalmente e terminado.

import { errorText } from "./log";

export type ProbeVerdict = "ok" | "broken" | "unknown";

export interface ProbeResult {
    verdict: ProbeVerdict;
    /** frase curta do que aconteceu (log e diagnostico) */
    detail: string;
    /** o Worker ficou preso e foi deixado como esta (leftAlone) */
    hung?: boolean;
}

/** Limites da sonda (ms). Mutaveis pelos testes. */
export const ENCODER_PROBE_TIMING = {
    /** isConfigSupported + configure sem resposta: inconclusiva */
    configureMs: 3000,
    /** do configure ao fim do flush(): passou disto, a placa travou */
    encodeMs: 4000
};

const PROBE_SIZE = { width: 1280, height: 720, framerate: 30 };
const PROBE_FRAMES = 30;

/** Workers presos (e o encoder dentro deles): guardados para sempre, nunca terminados. */
const leftAlone: unknown[] = [];

export function stuckProbeWorkers(): number {
    return leftAlone.length;
}

/**
 * Codigo do Worker (vai como texto por blob:/data: URL: JS puro, so ASCII). Fases: "phase" isConfigSupported/encode/
 * flush, "chunk" no 1o pacote, "done" com o veredito do lado do Worker.
 */
export const PROBE_WORKER_SOURCE = `"use strict";
self.onmessage = async function (msg) {
    var data = msg.data;
    if (!data || data.cmd !== "run") return;
    var config = data.config, frames = data.frames;
    function post(ev, extra) { self.postMessage(Object.assign({ ev: ev }, extra || {})); }
    function describe(e) { return (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : String(e)); }
    if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function" || typeof OffscreenCanvas !== "function") {
        post("done", { verdict: "nowebcodecs" });
        return;
    }
    post("phase", { phase: "isConfigSupported" });
    var sup;
    try { sup = await VideoEncoder.isConfigSupported(config); } catch (e) { post("done", { verdict: "unsupported", error: describe(e) }); return; }
    if (!sup || !sup.supported) { post("done", { verdict: "unsupported" }); return; }
    var chunks = 0, error = null, enc;
    try {
        enc = new VideoEncoder({
            output: function () { chunks++; if (chunks === 1) post("chunk", {}); },
            error: function (e) { if (!error) { error = describe(e); post("error", { error: error }); } }
        });
        enc.configure(config);
    } catch (e) { post("done", { verdict: "configure", error: describe(e) }); return; }
    post("phase", { phase: "encode" });
    var canvas = new OffscreenCanvas(config.width, config.height);
    var ctx = canvas.getContext("2d");
    var t0 = performance.now();
    for (var i = 0; i < frames && enc.state === "configured"; i++) {
        var wait = t0 + i * 1000 / config.framerate - performance.now();
        if (wait > 1) await new Promise(function (r) { setTimeout(r, wait); });
        if (enc.state !== "configured") break;
        ctx.fillStyle = "hsl(" + ((i * 12) % 360) + " 60% 35%)";
        ctx.fillRect(0, 0, config.width, config.height);
        ctx.fillStyle = "#fff";
        ctx.fillRect((i * 37) % config.width, (i * 23) % config.height, 160, 90);
        var frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / config.framerate), duration: Math.round(1e6 / config.framerate) });
        try { enc.encode(frame, { keyFrame: i === 0 }); } finally { frame.close(); }
    }
    post("phase", { phase: "flush" });
    try { if (enc.state === "configured") await enc.flush(); } catch (e) { if (!error) error = describe(e); }
    post("done", { verdict: "finished", chunks: chunks, error: error });
    try { if (enc.state !== "closed") enc.close(); } catch (e) { }
};
`;

/** Um Worker com o codigo da sonda: blob: e, se o CSP recusar, data:. null = nenhum deu. */
function newProbeWorker(): { worker: Worker; release(): void; } | null {
    const WorkerCtor = (globalThis as { Worker?: typeof Worker; }).Worker;
    if (typeof WorkerCtor !== "function") return null;
    let blobUrl: string | null = null;
    try {
        blobUrl = URL.createObjectURL(new Blob([PROBE_WORKER_SOURCE], { type: "text/javascript" }));
        const url = blobUrl;
        return { worker: new WorkerCtor(url), release: () => URL.revokeObjectURL(url) };
    } catch {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
    try {
        return { worker: new WorkerCtor("data:text/javascript;base64," + btoa(PROBE_WORKER_SOURCE)), release: () => { } };
    } catch {
        return null;
    }
}

/**
 * Roda a sonda para o perfil H.264 `profile` (profile-level-id, ex.: "42001f"). Nunca rejeita. Um Worker preso fica
 * guardado (nunca terminado) e o resultado vem com `hung` (quem chama loga uma linha).
 */
export function runEncoderProbe(profile: string): Promise<ProbeResult> {
    const made = newProbeWorker();
    if (!made) return Promise.resolve({ verdict: "unknown", detail: "sem Worker (ou o Discord recusou criar um)" });
    const { worker, release } = made;
    const config = {
        codec: `avc1.${profile}`, ...PROBE_SIZE, bitrate: 2_000_000, hardwareAcceleration: "prefer-hardware", latencyMode: "realtime",
        avc: { format: "annexb" }
    };
    return new Promise<ProbeResult>(resolve => {
        let phase = "início";
        let chunks = false;
        let encoderError: string | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // chamado uma vez: depois dele os handlers do Worker saem (nada mais chega) e o prazo e cancelado
        const finish = (result: ProbeResult, hung: boolean) => {
            clearTimeout(timer);
            worker.onmessage = null;
            worker.onerror = null;
            // o encoder preso fica la dentro: terminar o Worker desmontaria o encoder (o mesmo risco do WebRTC)
            if (hung) leftAlone.push(worker);
            else worker.terminate();
            release();
            resolve(hung ? { ...result, hung } : result);
        };
        const arm = (ms: number, onTimeout: () => void) => {
            clearTimeout(timer);
            timer = setTimeout(onTimeout, ms);
        };
        // ate o configure: sem resposta e inconclusiva (nao deu para saber se a placa aceita), mas o Worker fica
        arm(ENCODER_PROBE_TIMING.configureMs, () => finish({ verdict: "unknown", detail: `${phase} sem resposta em ${ENCODER_PROBE_TIMING.configureMs / 1000} s` }, true));
        worker.onmessage = ({ data }: MessageEvent) => {
            if (!data || typeof data !== "object") return;
            if (data.ev === "phase") {
                phase = String(data.phase);
                if (data.phase === "encode") {
                    // a placa aceitou: daqui ate o fim do flush, prazo duro
                    arm(ENCODER_PROBE_TIMING.encodeMs, () => finish({
                        verdict: "broken",
                        detail: chunks
                            ? `o flush() não terminou em ${ENCODER_PROBE_TIMING.encodeMs / 1000} s`
                            : `nenhum pacote em ${ENCODER_PROBE_TIMING.encodeMs / 1000} s (${phase === "flush" ? "o flush() não terminou" : "ainda codificando"})`
                    }, true));
                }
            } else if (data.ev === "chunk") {
                chunks = true;
            } else if (data.ev === "error") {
                encoderError ??= String(data.error ?? "erro").slice(0, 200);
            } else if (data.ev === "done") {
                const error = typeof data.error === "string" ? data.error.slice(0, 200) : encoderError;
                if (data.verdict === "nowebcodecs") finish({ verdict: "unknown", detail: "sem WebCodecs" }, false);
                else if (data.verdict === "unsupported") finish({ verdict: "unknown", detail: `sem suporte: a placa não aceita avc1.${profile}${error ? ` (${error})` : ""}` }, false);
                else if (data.verdict === "configure") finish({ verdict: "unknown", detail: `configure falhou${error ? `: ${error}` : ""}` }, false);
                else if (typeof data.chunks === "number" && data.chunks > 0) finish({ verdict: "ok", detail: `${data.chunks} pacotes de ${PROBE_FRAMES} quadros` }, false);
                else if (error) finish({ verdict: "unknown", detail: `erro do encoder sem nenhum pacote: ${error}` }, false);
                else finish({ verdict: "broken", detail: `nenhum pacote de ${PROBE_FRAMES} quadros (o flush terminou vazio)` }, false);
            }
        };
        worker.onerror = (e: ErrorEvent) => {
            finish({ verdict: "unknown", detail: `o Worker falhou: ${e?.message || "erro"}`.slice(0, 200) }, false);
        };
        try {
            worker.postMessage({ cmd: "run", config, frames: PROBE_FRAMES });
        } catch (e) {
            finish({ verdict: "unknown", detail: "o Worker não aceitou a mensagem: " + errorText(e) }, false);
        }
    });
}
