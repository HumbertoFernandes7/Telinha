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
// chama usa a faixa original, uma linha no log). No meio da transmissao, o Worker morrendo, parando de responder ou os
// quadros parando de chegar ao gerador com a captura andando (o vigia do fluxo, COPY_FLOW_MIN_FRAMES) chama
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
    /** quadros que o gerador aceitou (escrita terminada): o que de fato chega nos envios */
    written: number;
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
    /** ms que a escrita no gerador levou ate terminar (aceita ou recusada): soma, quantas, maximo, quantas passaram de 16,7 ms */
    writeMs?: number;
    writeN?: number;
    /** o maximo desde a resposta de stats anterior (o Worker zera ao responder), nao desde o inicio */
    writeMax?: number;
    writeSlow?: number;
    /** quadros com tamanho diferente do anterior (a captura mudou de resolucao) */
    resized?: number;
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
    /** chamado uma vez se a copia morrer no meio (o Worker caiu, parou de responder ou os quadros pararam de sair) */
    onFail(cb: (reason: string) => void): void;
    /**
     * A ultima resposta do Worker ja viu a captura entregar COPY_FLOW_MIN_FRAMES ou mais desde a ultima vez que o gerador
     * aceitou um quadro: a copia esta parada com a captura andando (core/streaming.ts → checkStall culpa a copia, nao o
     * encoder). Nunca compara com a captura de agora: entre respostas uma copia saudavel pareceria parada
     */
    outputFlat(): boolean;
    /** desiste da copia agora (onFail com `reason`): os envios voltam para a faixa original */
    abandon(reason: string): void;
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
/**
 * Pedidos de contadores seguidos sem resposta, com a transmissao no ar: o Worker parou (onFail). Conta pedidos, nao
 * tempo: com o Discord minimizado o timer atrasa e o relogio andaria sem o Worker ter culpa.
 */
export const COPY_UNANSWERED_POLLS = 3;
/**
 * Fluxo: com a captura entregando COPY_FLOW_MIN_FRAMES ou mais sem o gerador aceitar nenhum quadro, por
 * COPY_FLOW_POLLS respostas seguidas, a copia parou com o Worker vivo (ex.: a escrita no gerador nunca termina, o
 * processador sem entregar nada): onFail, antes de o checkStall culpar o encoder da placa (H264_STALL_MS).
 */
export const COPY_FLOW_MIN_FRAMES = 8;
export const COPY_FLOW_POLLS = 2;
/**
 * Taxa: a copia que entrega pouco ao envio custa mais que o rollback que evita (no ar, o gerador chegou a aceitar so 34 a 66%
 * dos quadros e os amigos viam 18 a 39 fps). Numa janela de COPY_RATE_POLLS respostas (~12 s), se o gerador aceitou menos que
 * COPY_RATE_MIN dos quadros que o Worker leu, em 2 avaliacoes seguidas (um tropeco de 1 a 2 s nao derruba a copia a transmissao
 * inteira): onFail. COPY_RATE_MIN_FRAMES e o minimo de quadros lidos na janela, para a tela parada (quase nenhum quadro) nunca
 * contar. Nos primeiros COPY_RATE_GRACE_MS depois de ligar a copia nada e avaliado (aquecimento da placa e do encoder). Uma mudanca
 * de tamanho da captura recomeca a janela.
 */
export const COPY_RATE_MIN = 0.75;
export const COPY_RATE_POLLS = 6;
export const COPY_RATE_MIN_FRAMES = 60;
export const COPY_RATE_FAILS = 2;
export const COPY_RATE_GRACE_MS = 10_000;
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

/** A linha de custo de uma janela (dois contadores acumulados). `writeMax` = o maior tempo de escrita da janela (padrao: o da resposta). null = nada passou. */
export function copyStatsLine(prev: CaptureCopyStats | null, cur: CaptureCopyStats, seconds: number, writeMax = cur.writeMax ?? 0): string | null {
    const d = (k: keyof CaptureCopyStats) => (cur[k] as number) - ((prev?.[k] as number | undefined) ?? 0);
    const frames = d("frames");
    if (frames <= 0) return null;
    const copied = d("copied");
    const gpu = avg(d("gpuMs"), d("gpuN"));
    const parts = [`${frames} quadros em ${Math.round(seconds)} s`, `${ms1(avg(d("copyMs"), copied))} ms/quadro no Worker`];
    if (gpu != null) parts.push(`placa termina a cópia em ${ms1(gpu)} ms (máx. ${ms1(cur.gpuMax)}${d("gpuLate") ? `, ${d("gpuLate")} acima de 33 ms` : ""})`);
    const write = avg(d("writeMs"), d("writeN"));
    if (d("writeN") > 0) parts.push(`escrita no gerador ${ms1(write)} ms (máx. ${ms1(writeMax)}${d("writeSlow") > 0 ? `, ${d("writeSlow")} acima de 16,7 ms` : ""})`);
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
    /** pedidos de contadores do vigia ainda sem resposta (COPY_UNANSWERED_POLLS) */
    let unanswered = 0;
    let logged: { stats: CaptureCopyStats; at: number; } | null = null;
    /** o maior writeMax das respostas desde a ultima linha de custo (cada resposta traz so o da sua janela) */
    let windowWriteMax = 0;
    /** a ultima resposta julgada: uma resposta resolve todos os pedidos pendentes de uma vez, e cada uma e julgada so uma vez */
    let lastSeen: CaptureCopyStats | null = null;
    const startedAt = performance.now();
    /** fluxo: `written` e o contador da captura na ultima vez que o gerador aceitou um quadro; respostas sem andar desde ela */
    let flow: { written: number; src: number; flat: number; } | null = null;
    let lastSrc = 0;
    /** MediaStreamTrack.stats.totalFrames da captura (Chromium); null = nao relatado */
    const trackFrames = (): number | null => {
        let total: unknown;
        try {
            total = (source as any).stats?.totalFrames;
        } catch { }
        return typeof total === "number" && Number.isFinite(total) ? total : null;
    };
    /** quadros que a captura entregou: os da faixa, sem eles os lidos pelo Worker */
    const sourceFrames = (s: CaptureCopyStats) => trackFrames() ?? s.frames;
    const sourceNow = () => trackFrames() ?? lastSrc;
    const watchFlow = (s: CaptureCopyStats) => {
        const src = sourceFrames(s);
        const written = s.written ?? 0;
        lastSrc = src;
        if (!flow || written > flow.written || src < flow.src) {
            flow = { written, src, flat: 0 };
            return;
        }
        if (src - flow.src < COPY_FLOW_MIN_FRAMES) return;
        if (++flow.flat >= COPY_FLOW_POLLS)
            fail(`os quadros não saem da cópia: ${src - flow.src} quadros da captura sem nenhum chegar aos envios`);
    };

    /** taxa: as ultimas COPY_RATE_POLLS + 1 respostas (contadores do Worker, tamanho e a hora em que chegaram) */
    let rate: { frames: number; written: number; resized: number; width: number; height: number; at: number; }[] = [];
    /** avaliacoes ruins seguidas (COPY_RATE_FAILS) */
    let rateFails = 0;
    const watchRate = (s: CaptureCopyStats) => {
        const cur = { frames: s.frames, written: s.written ?? 0, resized: s.resized ?? 0, width: s.width, height: s.height, at: performance.now() };
        const last = rate[rate.length - 1];
        // um contador que volta (Worker reiniciado) ou uma mudanca de tamanho da captura invalida a janela
        if (last && (cur.frames < last.frames || cur.written < last.written || cur.resized !== last.resized || cur.width !== last.width || cur.height !== last.height)) {
            rate = [];
            rateFails = 0;
        }
        rate.push(cur);
        if (rate.length > COPY_RATE_POLLS + 1) rate.shift();
        if (rate.length <= COPY_RATE_POLLS || cur.at - startedAt < COPY_RATE_GRACE_MS) return;
        const first = rate[0];
        const df = cur.frames - first.frames;
        const dw = cur.written - first.written;
        if (df < COPY_RATE_MIN_FRAMES || dw / df >= COPY_RATE_MIN) {
            rateFails = 0;
            return;
        }
        if (++rateFails < COPY_RATE_FAILS) return;
        const secs = Math.round((cur.at - first.at) / 1000);
        fail(`a cópia entrega só ${Math.round(dw / df * 100)}% dos quadros ao envio (${dw} de ${df} em ${secs} s)`);
    };

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
            unanswered = 0;
            report.stats = d as CaptureCopyStats;
            windowWriteMax = Math.max(windowWriteMax, (d as CaptureCopyStats).writeMax ?? 0);
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
        if (unanswered >= COPY_UNANSWERED_POLLS) {
            fail(`o Worker não respondeu a ${unanswered} pedidos seguidos`);
            return;
        }
        unanswered++;
        void askStats().then(s => {
            if (!s || stopped || s === lastSeen) return;
            lastSeen = s;
            watchFlow(s);
            if (stopped) return;
            watchRate(s);
            if (stopped) return;
            const now = performance.now();
            if (!logged) {
                logged = { stats: s, at: now };
                windowWriteMax = 0;
            } else if (now - logged.at >= COPY_LOG_MS) {
                const line = copyStatsLine(logged.stats, s, (now - logged.at) / 1000, windowWriteMax);
                if (line) log.info(line);
                logged = { stats: s, at: now };
                windowWriteMax = 0;
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
        outputFlat() {
            // so o que uma resposta ja viu: entre respostas (2 s) a captura anda e o gerador ainda nao foi lido de novo
            return !stopped && flow != null && flow.flat >= 1;
        },
        abandon(reason) {
            fail(reason);
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
