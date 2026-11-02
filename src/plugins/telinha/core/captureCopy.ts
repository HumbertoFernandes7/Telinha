/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Copia na hora" da captura pela placa de video (core/captureBoost.ts → textureCaptureActive). Com o
// WebRtcAllowWgcUsingTexture, o quadro da captura e a propria textura do pool do Windows Graphics Capture: o Chromium 152
// devolve o quadro ao WGC logo depois de embrulha-lo, e ~2 capturas depois o DWM escreve um quadro mais novo nela. Se o
// encoder demora para ler (jogo pesado), o espectador ve quadros velhos ou fora de ordem: o "mini rollback". Aqui cada
// quadro e copiado NA CHEGADA para uma textura nossa, na placa de video (nada volta para o processador), o original e
// fechado na hora, e os envios recebem a copia:
//
//   faixa da captura → MediaStreamTrackProcessor → Worker (canvas 2D acelerado; WebGPU se o 2D for lento) → MediaStreamTrackGenerator
//
// Medido em 02/11 (Edge 156, RTX 3070, janela real capturada pelo WGC com a textura, H.264 no NVENC, 1586x894@57):
// - sem copia, o jogo pesado na janela capturada (3D ~88%) sobe o encoder de 4,1 para 13-17 ms/quadro, e aparecem
//   quadros voltando; pelo processador (sem a textura) fica em ~4 ms. Com a copia: 2,8-3,3 ms/quadro com e sem jogo
//   (o encoder nao espera mais a textura do WGC) e nenhum quadro voltando;
// - canvas 2D: ~0,17 ms/quadro no Worker, +1 ponto de 3D no processo; WebGPU (importExternalTexture + render pass):
//   ~0,25 ms, +3 pontos de 3D e mais processador. Por isso o 2D vem primeiro. new VideoFrame(quadro) nao serve: embrulha
//   a mesma textura, nao copia.
//
// O Worker e o processador/gerador trocam os quadros direto na thread do Worker (streams transferidos), fora do main do
// Discord. Timestamps passam iguais (o sincronismo com o audio nao muda). Contrapressao: o processador guarda so o
// quadro mais novo (maxBufferSize 1), no WebGPU com 3 copias ainda na fila da placa o quadro novo e descartado, e no
// gerador fica no maximo 1 quadro esperando (o mais novo). Nada enfileira.
//
// Tela parada: o capturador de tela so entrega quadro quando a imagem muda, e quem pede um "refresh" a cada ~1 s e o
// envio do WebRTC ligado a faixa. Com a copia o envio esta no gerador e o pedido nao chega na captura (medido: 0 quadros
// por segundo numa janela parada, contra 1 sem a copia; o "Captura congelada" avisaria a toa). Uma RTCPeerConnection
// nunca negociada segurando a faixa ORIGINAL (refreshHolder) devolve esse pedido: 1 quadro por segundo de novo.
//
// Falha mole: sem Worker/processador/gerador, sem WebGPU nem canvas 2D, o Worker recusado pelo CSP ou mudo: null (quem
// chama usa a faixa original, uma linha no log). No meio da transmissao, o Worker morrendo ou parando de responder chama
// onFail (core/streaming.ts volta os envios para a faixa original).
//
// O resto do Telinha continua lendo a faixa ORIGINAL (LocalCapture.captureTrack): getSettings/tamanho, contador de
// quadros (congelada/preta, checkStall), "ended", e qualquer applyConstraints. A copia so alimenta os envios e a previa.

import { COPY_WORKER_SOURCE } from "./captureCopyWorker";
import { errorMessage, errorText, log } from "./log";

export type CopyMethod = "webgpu" | "canvas2d";

/** Contadores acumulados do Worker (captureCopyWorker.ts → st). */
export interface CaptureCopyStats {
    frames: number;
    copied: number;
    /** quadros que seguiram sem copia (a copia falhou nesse quadro, ou desligou) */
    passed: number;
    /** descartados pela contrapressao: dropGpu (fila da placa cheia) + dropWrite (o gerador ainda com um quadro esperando) */
    dropped: number;
    dropGpu: number;
    dropWrite: number;
    refreshed: number;
    /** ms no Worker para pedir a copia (soma e maximo) */
    copyMs: number;
    copyMax: number;
    /** ms da submissao ate a placa terminar a copia (WebGPU): soma, quantos, maximo, quantos passaram de 33 ms */
    gpuMs: number;
    gpuN: number;
    gpuMax: number;
    gpuLate: number;
    width: number;
    height: number;
    method: CopyMethod | "passthrough" | null;
    inflight: number;
}

export interface CaptureCopy {
    /** a faixa que os envios (e a previa) usam */
    readonly track: MediaStreamTrack;
    readonly method: CopyMethod;
    /** reenvia o ultimo quadro copiado (espectador novo numa tela parada: o encoder precisa de um quadro) */
    refresh(): void;
    /** contadores do Worker; null = sem resposta */
    stats(): Promise<CaptureCopyStats | null>;
    /** chamado uma vez se a copia morrer no meio (o Worker caiu ou parou de responder) */
    onFail(cb: (reason: string) => void): void;
    stop(): void;
}

/** O que a copia usa do navegador (injetavel nos testes). */
export interface CaptureCopyEnv {
    Worker?: typeof Worker;
    MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack; maxBufferSize?: number; }) => { readable: ReadableStream; };
    MediaStreamTrackGenerator?: new (init: { kind: "video"; }) => MediaStreamTrack & { writable: WritableStream; };
    createObjectURL?(blob: Blob): string;
    revokeObjectURL?(url: string): void;
    /** para o refreshHolder (sem ela, a copia funciona, so a tela parada nao recebe o quadro de 1 s) */
    RTCPeerConnection?: new () => Pick<RTCPeerConnection, "addTrack" | "close">;
}

/**
 * Uma RTCPeerConnection nunca negociada com a faixa ORIGINAL: o envio do WebRTC criado no addTrack pede um quadro novo ao
 * capturador quando a tela fica parada (ver o topo). Nao codifica nem manda nada (nunca ha oferta). null = indisponivel.
 */
function refreshHolder(env: CaptureCopyEnv, source: MediaStreamTrack): { close(): void; } | null {
    if (typeof env.RTCPeerConnection !== "function") return null;
    try {
        const pc = new env.RTCPeerConnection();
        pc.addTrack(source);
        return { close: () => { try { pc.close(); } catch { } } };
    } catch (e) {
        log.warn(`Captura pela placa: sem o quadro de 1 s numa tela parada (${errorText(e)})`);
        return null;
    }
}

/** Tempo para o Worker dizer "hello" (carregou) e "ready" (WebGPU ou canvas pronto). */
export const COPY_START_TIMEOUT_MS = 3000;
/** O Worker sem responder aos contadores por este tempo, com a transmissao no ar: parou (onFail). */
export const COPY_STALL_MS = 6000;
/** Uma linha de custo no log a cada este tempo. */
export const COPY_LOG_MS = 30_000;
const POLL_MS = 2000;

const METHOD_TEXT: Record<CopyMethod, string> = { webgpu: "WebGPU", canvas2d: "canvas 2D" };

/** A ultima leitura dos contadores (para o "Copiar diagnóstico"). */
let lastReport: { method: CopyMethod; adapter: string | null; stats: CaptureCopyStats | null; failed: string | null; } | null = null;
let lastUnavailable: string | null = null;

let envOverride: CaptureCopyEnv | null = null;

function browserEnv(): CaptureCopyEnv {
    if (envOverride) return envOverride;
    const g = globalThis as any;
    return {
        Worker: g.Worker,
        MediaStreamTrackProcessor: g.MediaStreamTrackProcessor,
        MediaStreamTrackGenerator: g.MediaStreamTrackGenerator,
        createObjectURL: typeof URL.createObjectURL === "function" ? URL.createObjectURL.bind(URL) : undefined,
        revokeObjectURL: typeof URL.revokeObjectURL === "function" ? URL.revokeObjectURL.bind(URL) : undefined,
        RTCPeerConnection: g.RTCPeerConnection
    };
}

/** base64 do texto em UTF-8 (o btoa sozinho so aceita Latin-1 e o data: e lido como UTF-8). */
function utf8Base64(text: string): string {
    let bin = "";
    for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
    return btoa(bin);
}

/** O Worker com o codigo da copia: blob: e, se o CSP recusar, data:. Lanca se nenhum der. */
function newWorker(env: CaptureCopyEnv): { worker: Worker; release(): void; } {
    const W = env.Worker!;
    let url: string | null = null;
    try {
        if (env.createObjectURL) {
            url = env.createObjectURL(new Blob([COPY_WORKER_SOURCE], { type: "text/javascript;charset=utf-8" }));
            const u = url;
            return { worker: new W(u), release: () => env.revokeObjectURL?.(u) };
        }
    } catch {
        if (url) env.revokeObjectURL?.(url);
    }
    return { worker: new W("data:text/javascript;base64," + utf8Base64(COPY_WORKER_SOURCE)), release: () => { } };
}

/** A proxima mensagem do Worker de um destes tipos (ou o erro dele), ate `ms`. */
function nextMessage(worker: Worker, types: string[], ms: number): Promise<any> {
    return new Promise((resolve, reject) => {
        const done = (fn: () => void) => {
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            worker.removeEventListener("error", onError);
            fn();
        };
        const onMessage = (e: MessageEvent) => {
            const type = e.data?.type;
            if (type === "failed") done(() => reject(new Error(String(e.data.error ?? "falhou"))));
            else if (types.includes(type)) done(() => resolve(e.data));
        };
        const onError = (e: Event) => done(() => reject(new Error((e as ErrorEvent).message || "o Worker não carregou (CSP?)")));
        const timer = setTimeout(() => done(() => reject(new Error(`o Worker não respondeu em ${ms / 1000} s`))), ms);
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
    });
}

const avg = (sum: number, n: number) => n > 0 ? sum / n : null;
const ms1 = (v: number | null) => v == null ? "?" : v.toFixed(v < 10 ? 2 : 0).replace(".", ",");

/** A linha de custo de uma janela (dois contadores acumulados). null = nada passou. */
export function copyStatsLine(prev: CaptureCopyStats | null, cur: CaptureCopyStats, seconds: number): string | null {
    const d = (k: keyof CaptureCopyStats) => (cur[k] as number) - ((prev?.[k] as number | undefined) ?? 0);
    const frames = d("frames");
    if (frames <= 0) return null;
    const copied = d("copied");
    const gpu = avg(d("gpuMs"), d("gpuN"));
    const parts = [`${frames} quadros em ${Math.round(seconds)} s`, `${ms1(avg(d("copyMs"), copied))} ms/quadro no Worker`];
    if (gpu != null) parts.push(`placa termina a cópia em ${ms1(gpu)} ms (máx. ${ms1(cur.gpuMax)}${d("gpuLate") ? `, ${d("gpuLate")} acima de 33 ms` : ""})`);
    const dropped = d("dropped");
    parts.push(dropped ? `${dropped} descartados pela fila (placa ${d("dropGpu")}, envio ${d("dropWrite")})` : "nenhum descartado");
    if (d("passed")) parts.push(`${d("passed")} sem cópia`);
    return `Cópia na hora (${cur.method === "passthrough" ? "desligada, direto" : METHOD_TEXT[cur.method as CopyMethod] ?? "?"}): ${parts.join(" · ")}`;
}

/**
 * Liga a copia na hora sobre `source` (a faixa de video da captura). null = indisponivel (ja logou uma linha): use a
 * faixa original. Nunca lanca.
 */
export async function startCaptureCopy(source: MediaStreamTrack, env: CaptureCopyEnv = browserEnv()): Promise<CaptureCopy | null> {
    const unavailable = (why: string) => {
        lastUnavailable = why;
        lastReport = null;
        log.warn(`Captura pela placa: cópia na hora indisponível (${why}); a captura vai direto para os envios`);
        return null;
    };
    if (typeof env.Worker !== "function") return unavailable("sem Worker");
    if (typeof env.MediaStreamTrackProcessor !== "function" || typeof env.MediaStreamTrackGenerator !== "function")
        return unavailable("sem MediaStreamTrackProcessor/Generator");

    let made: { worker: Worker; release(): void; };
    try {
        made = newWorker(env);
    } catch (e) {
        return unavailable(`o Discord recusou o Worker: ${errorText(e)}`);
    }
    const { worker, release } = made;
    let generator: (MediaStreamTrack & { writable: WritableStream; }) | null = null;
    const kill = () => {
        try { worker.terminate(); } catch { }
        release();
        try { generator?.stop(); } catch { }
    };

    let ready: { method: CopyMethod; adapter: string | null; };
    try {
        const hello = nextMessage(worker, ["hello"], COPY_START_TIMEOUT_MS);
        await hello;
        const answer = nextMessage(worker, ["ready"], COPY_START_TIMEOUT_MS);
        worker.postMessage({ op: "init", methods: ["canvas2d", "webgpu"] });
        ready = await answer;
    } catch (e) {
        kill();
        return unavailable(errorMessage(e));
    }

    try {
        const processor = new env.MediaStreamTrackProcessor({ track: source, maxBufferSize: 1 });
        generator = new env.MediaStreamTrackGenerator({ kind: "video" });
        worker.postMessage({ op: "run", readable: processor.readable, writable: generator.writable }, [processor.readable as any, generator.writable as any]);
    } catch (e) {
        kill();
        return unavailable(`não deu para ligar a captura ao Worker: ${errorText(e)}`);
    }
    const track = generator;
    const { method } = ready;
    const holder = refreshHolder(env, source);
    lastUnavailable = null;
    lastReport = { method, adapter: ready.adapter ?? null, stats: null, failed: null };
    const report = lastReport;
    log.info(`Captura pela placa: cópia na hora ligada (${METHOD_TEXT[method]}${ready.adapter ? `, ${ready.adapter}` : ""}): cada quadro é copiado na placa de vídeo `
        + "assim que chega, para o encoder nunca ler uma textura que o Windows já reaproveitou");

    let stopped = false;
    let failCb: ((reason: string) => void) | null = null;
    let failed: string | null = null;
    const pending: ((s: CaptureCopyStats | null) => void)[] = [];
    let answeredAt = performance.now();
    let logged: { stats: CaptureCopyStats; at: number; } | null = null;

    const fail = (reason: string) => {
        if (stopped || failed) return;
        failed = reason;
        report.failed = reason;
        log.warn(`Captura pela placa: a cópia na hora parou (${reason}); os envios voltam para a captura direta`);
        cleanup();
        failCb?.(reason);
    };
    worker.addEventListener("message", (e: MessageEvent) => {
        const d = e.data ?? {};
        if (d.type === "stats") {
            answeredAt = performance.now();
            report.stats = d as CaptureCopyStats;
            for (const r of pending.splice(0)) r(d as CaptureCopyStats);
        } else if (d.type === "warn") {
            log.warn(`Captura pela placa: ${String(d.message)}`);
        } else if (d.type === "info") {
            log.info(`Captura pela placa: ${String(d.message)}`);
        } else if (d.type === "ended" && d.error && source.readyState === "live") {
            fail(`a leitura da captura falhou: ${String(d.error)}`);
        }
    });
    worker.addEventListener("error", (e: Event) => fail(`o Worker caiu: ${(e as ErrorEvent).message || "erro"}`));

    const askStats = () => new Promise<CaptureCopyStats | null>(resolve => {
        if (stopped) return resolve(report.stats);
        pending.push(resolve);
        try { worker.postMessage({ op: "stats" }); } catch { resolve(null); }
    });
    const poll = setInterval(() => {
        if (stopped) return;
        if (source.readyState !== "live") return;
        if (performance.now() - answeredAt > COPY_STALL_MS) {
            fail(`o Worker não responde há ${Math.round(COPY_STALL_MS / 1000)} s`);
            return;
        }
        void askStats().then(s => {
            if (!s || stopped) return;
            const now = performance.now();
            if (!logged) logged = { stats: s, at: now };
            else if (now - logged.at >= COPY_LOG_MS) {
                const line = copyStatsLine(logged.stats, s, (now - logged.at) / 1000);
                if (line) log.info(line);
                logged = { stats: s, at: now };
            }
        });
    }, POLL_MS);

    function cleanup() {
        if (stopped) return;
        stopped = true;
        clearInterval(poll);
        holder?.close();
        for (const r of pending.splice(0)) r(report.stats);
        try { worker.postMessage({ op: "stop" }); } catch { }
        // o Worker solta o gerador e a placa; depois disso, termina de vez
        setTimeout(() => { try { worker.terminate(); } catch { } release(); }, 1000);
    }

    return {
        track,
        method,
        refresh() {
            if (!stopped) try { worker.postMessage({ op: "refresh" }); } catch { }
        },
        stats: askStats,
        onFail(cb) {
            failCb = cb;
        },
        stop() {
            cleanup();
            try { track.stop(); } catch { }
        }
    };
}

/** Para o "Copiar diagnóstico" (core/captureBoost.ts → captureBoostDiagnostics). null = a copia nao rodou nesta partida. */
export function captureCopyDiagnostics(): string | null {
    if (lastUnavailable) return `cópia na hora: indisponível na última transmissão (${lastUnavailable})`;
    const r = lastReport;
    if (!r) return null;
    const s = r.stats;
    const base = `cópia na hora: ${METHOD_TEXT[r.method]}${r.adapter ? ` (${r.adapter})` : ""}${r.failed ? `, parou: ${r.failed}` : ""}`;
    if (!s) return base;
    const line = copyStatsLine(null, s, 0)?.replace(/^Cópia na hora \([^)]*\): /, "").replace(/ em 0 s/, "");
    return `${base}; desde o início: ${line ?? "nenhum quadro"}`;
}

/** So para testes: o navegador falso (null = o de verdade). */
export function setCaptureCopyEnvForTests(env: CaptureCopyEnv | null) {
    envOverride = env;
}

/** So para testes. */
export function resetCaptureCopyForTests() {
    lastReport = null;
    lastUnavailable = null;
    envOverride = null;
}
