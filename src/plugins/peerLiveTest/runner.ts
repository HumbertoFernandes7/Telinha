/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { captureViaDisplayMedia, listSources, probeWebCodecs, testLegacyGetUserMedia } from "./capture";
import { createLoopback, getVideoCodecCapabilities, LoopbackSession } from "./loopback";
import { AudioMeter, sleep } from "./media";
import { closeHost, HostHandle, openHost } from "./popout";
import { beginRunLog, endRunLog, errorText, getNative, getState, log, LOG_PREFIX, logError, logWarn, RESOLUTIONS, setState } from "./state";
import { probeFirstDecode, StatsCollector, summarize, windowStats } from "./stats";
import { attachCanvasSink, attachTrackProcessorSink, attachVideoSink, DEFAULT_STRATEGY, measureSink, Sink, STRATEGY_LABELS, STRATEGY_SHORT, TEST_ALL_ORDER, UnsupportedStrategyError } from "./strategies";
import type { AudioResolution, CaptureSourceInfo, CodecChoice, CodecProbeEntry, CodecProbeResult, DecodeStartup, LoopbackInfo, PathAResult, PopoutStrategy, StatsSample, StrategyRanking, StrategyResult, TestAllResult, TestOptions } from "./types";

/** A fresh receiver in software H.264 mode took 14-17 s (37 rejected keyframes) before its first frame */
const FIRST_FRAME_TIMEOUT_MS = 25_000;
const MEASURE_MS = 8_000;
const DECODE_PROBE_TIMEOUT_MS = 30_000;
const CODEC_STEADY_MS = 6_000;
const STOP_WAIT_MS = 15_000;

interface ActiveSink {
    token: number;
    strategy: PopoutStrategy;
    sink: Sink;
    handle: HostHandle;
    loopbackId: number;
    unsubscribe(): void;
    liveFrames: number;
    liveAt: number;
}

interface RunContext {
    startedAt: Date;
    statsStartedAt: number;
    options: TestOptions;
    source: CaptureSourceInfo;
    envPromise: Promise<unknown>;
    codecCaps: ReturnType<typeof getVideoCodecCapabilities> | null;
    audioRes: AudioResolution | null;
    pathA: PathAResult | null;
    stream: MediaStream | null;
    loopback: LoopbackSession | null;
    loopbackInfos: LoopbackInfo[];
    /** Serializes loopback replacements */
    swapChain: Promise<unknown>;
    decodeStartups: DecodeStartup[];
    decodeProbes: Map<number, Promise<DecodeStartup>>;
    captureMeter: AudioMeter | null;
    recvMeter: AudioMeter | null;
    collector: StatsCollector;
    samples: StatsSample[];
    timer: number | null;
    sampling: boolean;
    stopping: boolean;
    pathBDone: boolean;
    /** >0 while a multi-step test runs: the configured duration does not stop the run meanwhile */
    holdDuration: number;
    playerToken: number;
    activeSink: ActiveSink | null;
    strategyResults: StrategyResult[];
    testAll: TestAllResult | null;
    codecProbe: CodecProbeResult | null;
    pending: Set<Promise<unknown>>;
}

let ctx: RunContext | null = null;
let audioSeq = 0;
let loopbackSeq = 0;

const audioKey = (sourceId: string, mode: string) => `${sourceId}|${mode}`;

function isWindowGone(w: Window) {
    try {
        return w.closed;
    } catch {
        return true;
    }
}

function trackPending<T>(c: RunContext, p: Promise<T>): Promise<T> {
    c.pending.add(p);
    const remove = () => void c.pending.delete(p);
    p.then(remove, remove);
    return p;
}

export function getSelectedSource() {
    const { sources, selectedSourceId } = getState();
    return sources.find(s => s.id === selectedSourceId) ?? null;
}

export async function refreshSources() {
    if (getState().loadingSources) return;
    setState({ loadingSources: true });

    try {
        const res = await listSources();
        const { selectedSourceId } = getState();
        setState({
            sources: res.sources,
            sourcesVia: res.via,
            sourcesError: res.error ?? null,
            selectedSourceId: res.sources.some(s => s.id === selectedSourceId) ? selectedSourceId : null
        });
    } catch (e) {
        setState({ sourcesError: errorText(e) });
        logError("Falha ao listar fontes", errorText(e));
    } finally {
        setState({ loadingSources: false });
    }

    try {
        setState({ availableVideoCodecs: getVideoCodecCapabilities().send });
    } catch { }
}

export async function updateAudioResolution(): Promise<AudioResolution | null> {
    const source = getSelectedSource();
    const { audioMode } = getState().options;
    const seq = ++audioSeq;

    if (!source) {
        setState({ audioResolution: null, audioResolutionKey: null, resolvingAudio: false });
        return null;
    }

    setState({ resolvingAudio: true });
    try {
        const res = await getNative().resolveAudioDevice(source.id, audioMode);
        if (seq !== audioSeq) return res;

        setState({ audioResolution: res, audioResolutionKey: audioKey(source.id, audioMode), resolvingAudio: false });
        log(`Áudio para "${source.name}": ${res.decision}${res.lookupMs ? ` (consulta de PID: ${res.lookupMs} ms)` : ""}`);
        return res;
    } catch (e) {
        if (seq === audioSeq) setState({ audioResolution: null, audioResolutionKey: null, resolvingAudio: false });
        logError("Falha ao decidir o dispositivo de áudio", errorText(e));
        return null;
    }
}

export function selectSource(id: string) {
    if (getState().phase !== "idle") return;
    setState({ selectedSourceId: id });
    void updateAudioResolution();
}

export function setOptions(patch: Partial<TestOptions>) {
    if (getState().phase !== "idle") return;
    setState({ options: { ...getState().options, ...patch } });
    if ("audioMode" in patch) void updateAudioResolution();
}

/** Allowed while running: applies the next time the window is (re)opened */
export function setPopoutStrategy(popoutStrategy: PopoutStrategy) {
    if (getState().longTest) return;
    setState({ options: { ...getState().options, popoutStrategy } });
}

export function setListenAudio(listen: boolean) {
    setState({ listenAudio: listen });
    ctx?.recvMeter?.setListening(listen);
    if (listen) logWarn("\"Ouvir áudio\" LIGADO: o áudio recebido sai nos alto-falantes e pode ser recapturado (eco/microfonia). Use fones.");
    else log("\"Ouvir áudio\" desligado");
}

async function collectEnvironment(options: TestOptions) {
    const { width, height } = RESOLUTIONS[options.resolution];
    const native = await getNative().getEnvironment().catch(e => ({ error: errorText(e) }));

    return {
        native,
        renderer: {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            devicePixelRatio: window.devicePixelRatio,
            screen: { width: screen.width, height: screen.height },
            releaseChannel: (window as any).GLOBAL_ENV?.RELEASE_CHANNEL ?? null,
            mediaStreamTrackProcessor: typeof (window as any).MediaStreamTrackProcessor === "function"
        },
        webCodecsEncoderProbe: await probeWebCodecs(width, height, options.fps).catch(e => ({ error: errorText(e) }))
    };
}

// #region Loopback (receiver) management

interface ReceiverOptions {
    reason: string;
    sinkAtStart: string;
    codec?: CodecChoice;
    startBitrateHint?: boolean;
    /** Only replace if this is still the current receiver when the (queued) replacement runs */
    onlyIfCurrent?: LoopbackSession;
}

function startDecodeProbe(c: RunContext, lb: LoopbackSession, o: ReceiverOptions) {
    const probe = probeFirstDecode(lb, o.reason, o.sinkAtStart, DECODE_PROBE_TIMEOUT_MS, () => ctx !== c || c.stopping).then(res => {
        c.decodeStartups.push(res);
        if (ctx === c) setState({ decodeStartups: [...c.decodeStartups] });

        const counters = `${res.pliSent ?? "?"} PLIs enviados, ${res.keyFramesEncoded ?? "?"} keyframes codificados, ${res.framesDropped ?? "?"} descartados`;
        if (res.firstDecodedMs != null) {
            const msg = `Receptor #${lb.id} (${lb.realmName}, ${res.decoderImplementation ?? "?"}): 1º quadro decodificado ${res.firstDecodedMs} ms após conectar (${counters})`;
            if (res.firstDecodedMs > 2000) logWarn(msg + " — o decodificador rejeitou os primeiros keyframes");
            else log(msg);
        } else if (res.aborted) {
            log(`Receptor #${lb.id} substituído/fechado antes do 1º quadro decodificado (${counters})`);
        } else {
            logError(`Receptor #${lb.id} não decodificou nenhum quadro em ${DECODE_PROBE_TIMEOUT_MS / 1000} s (${counters})${res.error ? `; ${res.error}` : ""}`);
        }
        return res;
    });
    c.decodeProbes.set(lb.id, probe);
}

/**
 * Replaces the RTCPeerConnection pair: the receiver is created in `realm` (main window or a pop-out window).
 * The captured stream is reused; only the encoder/decoder pair restarts. Serialized through swapChain.
 */
function replaceLoopback(c: RunContext, realm: Window, o: ReceiverOptions): Promise<LoopbackSession> {
    const run = async () => {
        if (ctx !== c || c.stopping || !c.stream) throw new Error("teste encerrado");
        if (o.onlyIfCurrent && c.loopback && c.loopback !== o.onlyIfCurrent) return c.loopback;

        const prev = c.loopback;
        c.loopback = null;
        c.recvMeter?.close();
        c.recvMeter = null;
        prev?.close();

        const codec = o.codec ?? c.options.codec;
        const startBitrateHint = o.startBitrateHint ?? c.options.startBitrateHint;
        let lb: LoopbackSession;
        try {
            lb = await createLoopback(c.stream, {
                id: ++loopbackSeq,
                reason: o.reason,
                maxBitrateBps: c.options.maxBitrateMbps * 1_000_000,
                maxFramerate: c.options.fps,
                codec,
                startBitrateHint,
                recvRealm: realm
            });
        } catch (e: any) {
            if (e?.loopbackInfo) c.loopbackInfos.push(e.loopbackInfo);
            throw e;
        }
        c.loopbackInfos.push(lb.info);

        if (ctx !== c || c.stopping) {
            lb.close();
            throw new Error("teste encerrado");
        }

        c.loopback = lb;
        c.collector.reset();
        if (lb.receivedAudioTrack) {
            try {
                c.recvMeter = new AudioMeter(lb.receivedAudioTrack, true, realm);
                c.recvMeter.setListening(getState().listenAudio);
            } catch (e) {
                logWarn(`Medidor do áudio recebido não pôde ser criado no realm "${lb.realmName}"`, errorText(e));
            }
        }
        startDecodeProbe(c, lb, o);
        return lb;
    };

    const next = c.swapChain.then(run, run);
    c.swapChain = next.catch(() => { });
    return next;
}

/** Ensures a receiver in `realm`, creating one only when the current one lives elsewhere (or `fresh`) */
async function ensureReceiver(c: RunContext, realm: Window, fresh: boolean, o: ReceiverOptions) {
    await c.swapChain;
    const lb = c.loopback;
    if (!fresh && lb && !lb.closed && lb.realm === realm) return { lb, created: false };
    return { lb: await replaceLoopback(c, realm, o), created: true };
}

const recovering = new WeakSet<LoopbackSession>();

/** The pop-out that hosted the receiving RTCPeerConnection is gone: move the receiver back to the main window */
function onReceiverRealmGone(c: RunContext, lb: LoopbackSession) {
    if (ctx !== c || c.stopping || c.loopback !== lb || lb.realm === window || recovering.has(lb)) return;
    recovering.add(lb);
    logWarn(`O pop-out que hospedava o receptor #${lb.id} fechou; recriando o receptor na janela principal para as estatísticas continuarem`);
    replaceLoopback(c, window, { reason: "pop-out do receptor (realm) fechado", sinkAtStart: "nenhum", onlyIfCurrent: lb })
        .catch(e => logError("Falha ao recriar o receptor na janela principal", errorText(e)));
}

async function waitProbe(c: RunContext, loopbackId: number, timeoutMs: number) {
    const probe = c.decodeProbes.get(loopbackId);
    if (!probe) return null;
    return Promise.race([probe, sleep(timeoutMs).then(() => null)]);
}

// #endregion

// #region Sampling

function formatSample(s: StatsSample) {
    const hw = (v: boolean | null | undefined) => v == null ? "?" : v ? "HW" : "SW";
    const parts = [`t=${s.t}s #${s.loopbackId ?? "?"}${s.strategy ? ` [${s.strategy}]` : ""}`];
    if (s.source) parts.push(`fonte ${s.source.width}x${s.source.height}@${s.source.fps}`);
    if (s.send) parts.push(`envio ${s.send.width}x${s.send.height}@${s.send.fps} ${s.send.bitrateKbps}kbps [${s.send.encoderImplementation} ${hw(s.send.powerEfficientEncoder)}, lim ${s.send.qualityLimitationReason}, enc ${s.send.avgEncodeMs}ms]`);
    if (s.recv) parts.push(`receb ${s.recv.width}x${s.recv.height}@${s.recv.fps}${s.recv.decodeStalled ? " SEM DECODIFICAR" : ""} [${s.recv.decoderImplementation} ${hw(s.recv.powerEfficientDecoder)}, PLI +${s.recv.pliSentDelta ?? "?"}, desc +${s.recv.framesDroppedDelta ?? "?"}]`);
    parts.push(s.audio.trackPresent ? `áudio cap ${s.audio.captureRmsDb}dB rec ${s.audio.receivedRmsDb}dB` : "sem áudio");
    if (s.cpu) parts.push(`CPU ${s.cpu.totalPercentCPU}% de 1 núcleo (${s.cpu.normalizedPercentCPU}% máq)`);
    return parts.join(" | ");
}

function updateSinkLive(c: RunContext) {
    const a = c.activeSink;
    if (!a) return;
    const now = performance.now();
    const { counter } = a.sink;
    const dt = (now - a.liveAt) / 1000;
    const fps = dt > 0 ? Math.round((counter.frames - a.liveFrames) / dt * 10) / 10 : null;
    a.liveFrames = counter.frames;
    a.liveAt = now;
    setState({ sinkLive: { strategy: a.strategy, fps, frames: counter.frames, width: counter.width, height: counter.height } });
}

async function tick() {
    const c = ctx;
    const lb = c?.loopback;
    if (!c || !lb || c.sampling || c.stopping) return;

    if (lb.realm !== window && isWindowGone(lb.realm)) {
        onReceiverRealmGone(c, lb);
        return;
    }

    c.sampling = true;
    try {
        const t = (performance.now() - c.statsStartedAt) / 1000;
        const cpu = await getNative().getAppMetrics().catch(() => null);
        const sample = await c.collector.sample(
            lb.pcSend,
            lb.pcRecv,
            t,
            { loopbackId: lb.id, receiverRealm: lb.realmName, strategy: c.activeSink?.strategy ?? null },
            cpu,
            c.captureMeter?.take() ?? { rms: null, peak: null },
            c.recvMeter?.take() ?? { rms: null, peak: null },
            !!c.stream?.getAudioTracks().length
        );

        if (ctx !== c || c.stopping || c.loopback !== lb) return;
        c.samples.push(sample);
        updateSinkLive(c);
        setState({ lastSample: sample, elapsedSec: Math.floor(t) });
        log(formatSample(sample));

        if (!c.holdDuration && c.options.durationSec > 0 && t >= c.options.durationSec)
            void stopRun(`duração de ${c.options.durationSec} s concluída`);
    } catch (e) {
        if (ctx === c && c.loopback === lb) logError("Falha ao coletar estatísticas", errorText(e));
    } finally {
        c.sampling = false;
    }
}

// #endregion

// #region Pop-out strategies

function detachSink(c: RunContext) {
    const a = c.activeSink;
    if (!a) return;
    c.activeSink = null;
    a.unsubscribe();
    a.sink.detach();
    if (ctx === c) setState({ activeStrategy: null, sinkLive: null });
}

/** Detaches the strategy's sink and closes the pop-out / floating panel */
function closePlayerFor(c: RunContext | null) {
    if (c) {
        c.playerToken++;
        detachSink(c);
    }
    closeHost();
}

export function closePlayer() {
    closePlayerFor(ctx);
}

function attachSinkFor(strategy: PopoutStrategy, handle: HostHandle, lb: LoopbackSession): Sink {
    switch (strategy) {
        case "control":
        case "direct":
            // main-window MediaStream; for "direct" the <video> lives in another document
            return attachVideoSink(strategy, handle.container, new MediaStream([lb.receivedVideoTrack]));
        case "realm": {
            // track, MediaStream and <video> all from the pop-out's realm
            const W = handle.win as Window & typeof globalThis;
            return attachVideoSink(strategy, handle.container, new W.MediaStream([lb.receivedVideoTrack]));
        }
        case "canvas":
            return attachCanvasSink(handle.container, lb.receivedVideoTrack);
        case "trackProcessor":
            return attachTrackProcessorSink(handle.container, lb.receivedVideoTrack);
    }
}

function strategyVerdict(r: StrategyResult) {
    const m = r.measurement;
    if (!r.supported) return `NÃO SUPORTADO: ${r.error}`;
    if (r.error) return `ERRO: ${r.error}`;
    if (!m) return "sem medição";
    if (m.aborted) return `INTERROMPIDO: ${m.aborted}`;
    if (m.ok) return `OK: ${m.fps} fps exibidos, 1º quadro em ${m.firstFrameMs} ms`;
    if (m.firstFrameMs == null) {
        return (r.receiverFramesDecodedAtEnd ?? 0) > 0
            ? `FALHA DO SINK: o receptor decodificou ${r.receiverFramesDecodedAtEnd} quadros, mas nenhum chegou ao sink`
            : "RECEPTOR SEM DECODIFICAR: nenhum quadro decodificado ainda (não é problema da janela; veja receiver.decodeStartups)";
    }
    return `FALHOU: ${m.error}`;
}

interface ShowOptions {
    fresh: boolean;
    trigger: string;
}

/** Opens the host the strategy needs, makes sure the receiver lives in the right realm, attaches the sink and measures it */
async function showStrategy(c: RunContext, strategy: PopoutStrategy, o: ShowOptions): Promise<StrategyResult> {
    c.playerToken++;
    const token = c.playerToken;
    const cancelled = () => ctx !== c || c.stopping || c.playerToken !== token;
    detachSink(c);

    const result: StrategyResult = {
        strategy,
        label: STRATEGY_LABELS[strategy],
        trigger: o.trigger,
        at: new Date().toISOString(),
        host: null,
        hostReused: false,
        hostAttempts: [],
        popoutWindowComponentFound: null,
        loopbackId: null,
        receiverRealm: null,
        freshReceiver: false,
        setupMs: null,
        supported: true,
        error: null,
        measurement: null,
        window: null,
        receiverDecode: null,
        receiverFramesDecodedAtEnd: null,
        ok: false,
        verdict: ""
    };

    log(`Estratégia "${strategy}" (${STRATEGY_LABELS[strategy]}) — ${o.trigger}`);
    setState({ activeStrategy: strategy, sinkLive: null });
    const t0 = performance.now();

    try {
        const hostRes = await openHost(strategy === "control" ? "floating" : "popout", cancelled);
        result.hostAttempts = hostRes.attempts;
        result.hostReused = hostRes.reused;
        result.popoutWindowComponentFound = hostRes.popoutWindowComponentFound;
        if (cancelled()) throw new Error("cancelado antes de abrir a janela");
        const { handle } = hostRes;
        if (!handle) throw new Error("nem o pop-out nem o painel flutuante renderizaram");
        result.host = handle.host;
        if (strategy !== "control" && handle.kind !== "popout") logWarn(`"${strategy}" está rodando no painel flutuante (o pop-out falhou); o resultado não vale para o pop-out`);

        const realm = strategy === "realm" ? handle.win : window;
        const { lb, created } = await ensureReceiver(c, realm, o.fresh, {
            reason: `estratégia ${strategy}`,
            sinkAtStart: `${strategy} em "${handle.host}"`
        });
        result.freshReceiver = created;
        result.loopbackId = lb.id;
        result.receiverRealm = lb.realmName;
        if (cancelled()) throw new Error("cancelado durante a preparação do receptor");
        if (handle.closed) throw new Error("a janela fechou durante a preparação");

        let sink: Sink;
        try {
            sink = attachSinkFor(strategy, handle, lb);
        } catch (e) {
            if (e instanceof UnsupportedStrategyError) result.supported = false;
            throw e;
        }

        const active: ActiveSink = {
            token,
            strategy,
            sink,
            handle,
            loopbackId: lb.id,
            liveFrames: 0,
            liveAt: performance.now(),
            unsubscribe: handle.onClose(() => {
                if (c.activeSink?.token === token) detachSink(c);
                // realm: the receiving RTCPeerConnection died with this window
                if (c.loopback && c.loopback.realm === handle.win && handle.win !== window) onReceiverRealmGone(c, c.loopback);
            })
        };
        c.activeSink = active;
        result.setupMs = Math.round(performance.now() - t0);

        result.measurement = await measureSink(sink, {
            firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
            measureMs: MEASURE_MS,
            stopReason: () => {
                if (ctx !== c || c.stopping) return "teste parado";
                if (c.playerToken !== token) return "outra estratégia foi aberta";
                if (handle.closed) return "a janela foi fechada";
                if (c.loopback !== lb) return "o receptor foi substituído";
                return null;
            },
            toStatsT: perf => Math.round((perf - c.statsStartedAt) / 100) / 10
        });

        // let the 1 Hz sampler cover the end of the window before aggregating it
        await sleep(1100);
        const m = result.measurement;
        if (m.windowStartT != null && m.windowEndT != null) {
            // a sample at t covers (t-1, t]
            result.window = windowStats(c.samples.filter(s => s.loopbackId === lb.id && s.t >= m.windowStartT! + 0.5 && s.t <= m.windowEndT! + 0.5));
        }
        result.receiverFramesDecodedAtEnd = c.samples.filter(s => s.loopbackId === lb.id).at(-1)?.recv?.framesDecoded ?? null;
        result.receiverDecode = c.decodeStartups.find(d => d.loopbackId === lb.id) ?? null;
        result.ok = m.ok;
    } catch (e) {
        result.error = errorText(e);
    }

    result.verdict = strategyVerdict(result);
    const w = result.window;
    const line = `Estratégia "${strategy}" em "${result.host ?? "?"}": ${result.verdict}${w ? ` · recebido ${w.recvAvgFps ?? "?"} fps · CPU ${w.cpuAvgPercentOneCore ?? "?"}% de 1 núcleo` : ""}`;
    if (result.ok) log(line);
    else logError(line);
    return result;
}

function recordStrategyResult(c: RunContext, r: StrategyResult) {
    c.strategyResults.push(r);
    if (ctx === c) setState({ popout: r, strategyResults: [...c.strategyResults] });
}

export async function openPopoutForRun(trigger = "botão \"Abrir janela\"") {
    const c = ctx;
    if (!c?.loopback || getState().phase !== "running") {
        logWarn("Inicie o teste antes de abrir a janela flutuante");
        return;
    }
    if (getState().longTest) {
        logWarn("Há um teste em sequência rodando; aguarde ele terminar");
        return;
    }

    const strategy = getState().options.popoutStrategy;
    await trackPending(c, showStrategy(c, strategy, { fresh: false, trigger }).then(r => recordStrategyResult(c, r)));
}

function rankStrategies(results: StrategyResult[]): StrategyRanking[] {
    return results
        .map(r => ({
            strategy: r.strategy,
            ok: r.ok,
            sinkFps: r.measurement?.fps ?? null,
            firstFrameMs: r.measurement?.firstFrameMs ?? null,
            cpuAvgPercentOneCore: r.window?.cpuAvgPercentOneCore ?? null
        }))
        .sort((a, b) =>
            Number(b.ok) - Number(a.ok)
            || (b.sinkFps ?? 0) - (a.sinkFps ?? 0)
            || (a.cpuAvgPercentOneCore ?? Infinity) - (b.cpuAvgPercentOneCore ?? Infinity));
}

/** Starts a continuous run (no auto pop-out) when idle; returns whether it did */
async function ensureRunning(): Promise<boolean | null> {
    const { phase } = getState();
    if (phase === "running") return false;
    if (phase !== "idle") return null;
    if (!getSelectedSource()) {
        logWarn("Selecione uma tela ou janela primeiro");
        return null;
    }
    await startRun({ durationSec: 0, autoPopout: false });
    return getState().phase === "running" ? true : null;
}

async function runAllStrategies(c: RunContext): Promise<void> {
    const t: TestAllResult = {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        order: [...TEST_ALL_ORDER],
        completed: false,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
        measureMs: MEASURE_MS,
        initialDecode: null,
        results: [],
        ranking: [],
        best: null
    };
    c.testAll = t;
    c.holdDuration++;

    try {
        log(`Testando todas as estratégias de janela: ${TEST_ALL_ORDER.join(" → ")} (${MEASURE_MS / 1000} s cada, após o 1º quadro)`);

        // Every main-window strategy reuses the running receiver; wait until it decodes, or each would wait the same stall
        const lb = c.loopback;
        if (lb && lb.realm === window) {
            setState({ longTest: { kind: "estratégias", step: "aguardando o receptor decodificar o 1º quadro" } });
            log("Aguardando o receptor da janela principal decodificar o primeiro quadro…");
            t.initialDecode = await waitProbe(c, lb.id, DECODE_PROBE_TIMEOUT_MS + 2000);
        }

        for (const strategy of TEST_ALL_ORDER) {
            if (ctx !== c || c.stopping) break;
            setState({ longTest: { kind: "estratégias", step: `${STRATEGY_SHORT[strategy]} (${t.results.length + 1}/${TEST_ALL_ORDER.length})` } });
            const r = await showStrategy(c, strategy, { fresh: false, trigger: "Testar todas as estratégias" });
            recordStrategyResult(c, r);
            t.results.push(r);
        }

        t.completed = t.results.length === TEST_ALL_ORDER.length && !t.results.some(r => r.measurement?.aborted === "teste parado");
        t.ranking = rankStrategies(t.results);
        t.best = t.ranking.find(r => r.ok && r.strategy !== "control")?.strategy ?? null;

        log(`Ranking das estratégias: ${t.ranking.map(r => `${r.strategy} ${r.ok ? `${r.sinkFps} fps` : "falhou"}${r.cpuAvgPercentOneCore != null ? ` / CPU ${r.cpuAvgPercentOneCore}%` : ""}`).join(" · ")}`);
        if (t.best) log(`Melhor estratégia de pop-out: ${t.best}`);
        else logError("Nenhuma estratégia de pop-out confirmou reprodução");
    } finally {
        t.finishedAt = new Date().toISOString();
        c.holdDuration--;
        if (ctx === c) setState({ longTest: null, testAll: t });
    }
}

/** Runs every strategy for MEASURE_MS on the current capture (starting a run first if needed) and records them */
export async function testAllStrategies() {
    if (getState().longTest) return;
    const startedHere = await ensureRunning();
    const c = ctx;
    if (startedHere == null || !c) return;

    setState({ longTest: { kind: "estratégias", step: "preparando" } });
    try {
        await trackPending(c, runAllStrategies(c));
    } catch (e) {
        logError("Teste de estratégias falhou", errorText(e));
    } finally {
        if (getState().longTest?.kind === "estratégias") setState({ longTest: null });
    }

    if (ctx !== c || c.stopping) return;
    if (startedHere) {
        await stopRun("teste de todas as estratégias concluído");
    } else if (c.activeSink?.strategy !== getState().options.popoutStrategy) {
        void openPopoutForRun("estratégia selecionada, após testar todas");
    }
}

// #endregion

// #region Codec decode-startup test

function codecVariants(c: RunContext): { codec: CodecChoice; startBitrateHint: boolean; }[] {
    const caps = c.codecCaps;
    const has: Record<CodecChoice, boolean> = {
        VP8: true,
        VP9: caps?.hasVP9 ?? true,
        AV1: caps?.hasAV1 ?? true,
        H264: caps?.hasH264 ?? true,
        H265: false
    };
    const hint = c.options.startBitrateHint;
    const list: { codec: CodecChoice; startBitrateHint: boolean; }[] = [
        { codec: "VP8", startBitrateHint: hint },
        { codec: "VP9", startBitrateHint: hint },
        { codec: "AV1", startBitrateHint: hint },
        { codec: "H264", startBitrateHint: true },
        { codec: "H264", startBitrateHint: false }
    ];
    return list.filter(v => has[v.codec]);
}

async function runCodecProbe(c: RunContext) {
    const p: CodecProbeResult = {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        completed: false,
        sink: "nenhum (player fechado: mede só o decodificador)",
        steadyMs: CODEC_STEADY_MS,
        entries: []
    };
    c.codecProbe = p;
    c.holdDuration++;
    closePlayerFor(c);

    try {
        const variants = codecVariants(c);
        log(`Teste de início da decodificação: ${variants.map(v => `${v.codec}${v.startBitrateHint ? "" : " (sem bitrate inicial alto)"}`).join(", ")}; receptor novo para cada um, sem sink`);

        for (const v of variants) {
            if (ctx !== c || c.stopping) break;
            const label = `${v.codec}${v.startBitrateHint ? "" : " sem x-google-start-bitrate"}`;
            setState({ longTest: { kind: "codecs", step: `${label} (${p.entries.length + 1}/${variants.length})` } });

            const entry: CodecProbeEntry = { codec: v.codec, startBitrateHint: v.startBitrateHint, negotiated: null, error: null, startup: null, window: null };
            p.entries.push(entry);
            try {
                const lb = await replaceLoopback(c, window, { reason: `teste de codec ${label}`, sinkAtStart: "nenhum (teste de codec)", codec: v.codec, startBitrateHint: v.startBitrateHint });
                entry.negotiated = lb.info.negotiatedVideoCodec;
                entry.startup = await waitProbe(c, lb.id, DECODE_PROBE_TIMEOUT_MS + 2000);
                if (ctx !== c || c.stopping) break;

                const tStart = (performance.now() - c.statsStartedAt) / 1000;
                const end = performance.now() + CODEC_STEADY_MS;
                while (performance.now() < end && ctx === c && !c.stopping) await sleep(200);
                await sleep(1100);
                const tEnd = (performance.now() - c.statsStartedAt) / 1000;
                entry.window = windowStats(c.samples.filter(s => s.loopbackId === lb.id && s.t > tStart && s.t <= tEnd));

                log(`Codec ${label}: 1º quadro decodificado ${entry.startup?.firstDecodedMs ?? "nunca"} ms (${entry.startup?.pliSent ?? "?"} PLIs) · depois ${entry.window.recvAvgFps ?? "?"} fps recebidos / ${entry.window.sendAvgFps ?? "?"} enviados · ${entry.window.encoders.join(", ")} → ${entry.window.decoders.join(", ")} · CPU ${entry.window.cpuAvgPercentOneCore ?? "?"}% de 1 núcleo`);
            } catch (e) {
                entry.error = errorText(e);
                logError(`Codec ${label} falhou`, entry.error);
            }
        }
        p.completed = p.entries.length === variants.length && ctx === c && !c.stopping;
    } finally {
        p.finishedAt = new Date().toISOString();
        c.holdDuration--;
        if (ctx === c) setState({ longTest: null, codecProbe: p });

        if (ctx === c && !c.stopping) {
            await replaceLoopback(c, window, { reason: "fim do teste de codecs (volta ao codec escolhido)", sinkAtStart: "nenhum" })
                .catch(e => logError("Falha ao restaurar o receptor após o teste de codecs", errorText(e)));
        }
    }
}

/** Fresh receiver per codec, no sink at all: how long until the first decoded frame, and steady fps/CPU after it */
export async function testDecodeStartupByCodec() {
    if (getState().longTest) return;
    const startedHere = await ensureRunning();
    const c = ctx;
    if (startedHere == null || !c) return;

    setState({ longTest: { kind: "codecs", step: "preparando" } });
    try {
        await trackPending(c, runCodecProbe(c));
    } catch (e) {
        logError("Teste de codecs falhou", errorText(e));
    } finally {
        if (getState().longTest?.kind === "codecs") setState({ longTest: null });
    }

    if (startedHere && ctx === c && !c.stopping) await stopRun("teste de início da decodificação por codec concluído");
}

// #endregion

// #region Run lifecycle

export async function startRun(overrides: Partial<TestOptions> = {}) {
    const state = getState();
    if (state.phase !== "idle") return;

    const source = getSelectedSource();
    if (!source) {
        logWarn("Selecione uma tela ou janela primeiro");
        return;
    }

    const options = { ...state.options, ...overrides };
    const { width, height } = RESOLUTIONS[options.resolution];

    beginRunLog();
    setState({
        phase: "starting", lastSample: null, elapsedSec: 0, pathA: null, pathB: null, popout: null, summary: null, resultPath: null, resultError: null,
        strategyResults: [], activeStrategy: null, sinkLive: null, fullscreen: null, decodeStartups: [], testAll: null, codecProbe: null
    });

    const c: RunContext = ctx = {
        startedAt: new Date(),
        statsStartedAt: performance.now(),
        options,
        source,
        envPromise: collectEnvironment(options).catch(e => ({ error: errorText(e) })),
        codecCaps: null,
        audioRes: null,
        pathA: null,
        stream: null,
        loopback: null,
        loopbackInfos: [],
        swapChain: Promise.resolve(),
        decodeStartups: [],
        decodeProbes: new Map(),
        captureMeter: null,
        recvMeter: null,
        collector: new StatsCollector(),
        samples: [],
        timer: null,
        sampling: false,
        stopping: false,
        pathBDone: false,
        holdDuration: 0,
        playerToken: 0,
        activeSink: null,
        strategyResults: [],
        testAll: null,
        codecProbe: null,
        pending: new Set()
    };

    try {
        log(`Iniciando: ${source.kind === "screen" ? "tela" : "janela"} "${source.name}" (${source.id}), ${width}x${height} @ ${options.fps} fps, máx ${options.maxBitrateMbps} Mbps, áudio ${options.audioMode}, codec ${options.codec}, duração ${options.durationSec || "contínua"}, estratégia de janela ${options.popoutStrategy}`);

        try {
            c.codecCaps = getVideoCodecCapabilities();
            log(`Codecs de vídeo (RTCRtpSender.getCapabilities): ${c.codecCaps.send.join(" | ")}`);
            log(`H.264: ${c.codecCaps.hasH264} · H.265: ${c.codecCaps.hasH265} · AV1: ${c.codecCaps.hasAV1} · VP9: ${c.codecCaps.hasVP9}`);
        } catch (e) {
            logError("getCapabilities falhou", errorText(e));
        }

        const cached = state.audioResolutionKey === audioKey(source.id, options.audioMode) ? state.audioResolution : null;
        c.audioRes = cached ?? await updateAudioResolution();

        const { result, stream } = await captureViaDisplayMedia(source, options, c.audioRes);
        c.pathA = result;
        setState({ pathA: result });
        if (!stream) throw new Error(`Caminho A (getDisplayMedia) falhou: ${result.error}`);
        if (ctx !== c || c.stopping) {
            stream.getTracks().forEach(t => t.stop());
            return;
        }

        c.stream = stream;
        stream.getVideoTracks()[0]?.addEventListener("ended", () => void stopRun("a faixa de vídeo capturada terminou (fonte fechada?)"));

        const [audioTrack] = stream.getAudioTracks();
        if (audioTrack) c.captureMeter = new AudioMeter(audioTrack, false);

        try {
            await replaceLoopback(c, window, {
                reason: "início do teste",
                sinkAtStart: options.autoPopout ? `nenhum (o pop-out "${options.popoutStrategy}" abre logo em seguida)` : "nenhum"
            });
        } catch (e) {
            if (ctx !== c || c.stopping) return;
            throw new Error(`Loopback WebRTC falhou: ${errorText(e)}`);
        }

        await getNative().getAppMetrics().catch(() => null); // primes the CPU counters (first reading has no previous value)
        c.statsStartedAt = performance.now();
        c.timer = window.setInterval(tick, 1000);
        setState({ phase: "running" });
        log("Rodando. Deixe algo em movimento (vídeo/jogo) e com som na fonte escolhida.");

        if (options.autoPopout) void openPopoutForRun("abertura automática ao iniciar");
    } catch (e) {
        logError(errorText(e));
        await stopRun("erro ao iniciar");
    }
}

function teardown(c: RunContext) {
    if (c.timer != null) clearInterval(c.timer);
    c.timer = null;

    closePlayerFor(c);
    c.recvMeter?.close();
    c.captureMeter?.close();
    c.loopback?.close();
    c.loopback = null;
    c.stream?.getTracks().forEach(t => t.stop());
    getNative().cancelPendingDisplayMedia().catch(() => { });
}

export async function stopRun(reason = "parado pelo usuário") {
    const c = ctx;
    if (!c || c.stopping) return;
    c.stopping = true;
    setState({ phase: "stopping" });
    log(`Encerrando: ${reason}`);

    if (c.pending.size) {
        log("Aguardando as medições em andamento terminarem…");
        await Promise.race([Promise.allSettled([...c.pending]), sleep(STOP_WAIT_MS)]);
    }

    try {
        teardown(c);
    } catch (e) {
        logError("Falha ao liberar recursos", errorText(e));
    }

    let { pathB } = getState();
    if (!c.pathBDone) {
        try {
            pathB = await testLegacyGetUserMedia(c.source, c.options);
            setState({ pathB });
        } catch (e) {
            logError("Caminho B lançou", errorText(e));
        }
    }

    const { width, height } = RESOLUTIONS[c.options.resolution];
    const summary = summarize(c.samples, { width, height, fps: c.options.fps });
    const environment = await c.envPromise;

    log(`Resumo: envio ${summary.send.avgFps ?? "?"} fps / ${summary.send.avgBitrateKbps ?? "?"} kbps, encoder ${summary.send.encoderImplementations.join(", ") || "?"} (HW: ${summary.verdict.hardwareEncoder}), recebido ${summary.recv.avgFps ?? "?"} fps (${summary.recv.avgFpsWhileDecoding ?? "?"} fps decodificando; ${summary.recv.stalledSamples} amostras travadas), áudio com sinal em ${summary.audio.secondsWithSignal} s, CPU média ${summary.cpu.avgTotalPercent ?? "?"}% de 1 núcleo (${summary.cpu.avgNormalizedPercent ?? "?"}% da máquina)`);
    for (const note of summary.verdict.notes) logWarn(note);

    const { log: runLog, errors } = endRunLog();

    const json = {
        schema: "peerlive-capture-test/2",
        createdAt: new Date().toISOString(),
        run: {
            startedAt: c.startedAt.toISOString(),
            endReason: reason,
            statsSeconds: c.samples.at(-1)?.t ?? 0
        },
        environment,
        options: { ...c.options, width, height, maxBitrateKbps: c.options.maxBitrateMbps * 1000 },
        source: { kind: c.source.kind, name: c.source.name, id: c.source.id, listedVia: getState().sourcesVia },
        audio: {
            mode: c.options.audioMode,
            device: c.audioRes?.device ?? null,
            decision: c.audioRes?.decision ?? null,
            windowProcess: c.audioRes?.windowProcess ?? null,
            trackPresent: c.pathA?.audioTrackPresent ?? false
        },
        capturePaths: {
            worked: { A_getDisplayMedia: c.pathA?.ok ?? false, B_legacyGetUserMedia: pathB?.ok ?? null },
            A_getDisplayMedia: c.pathA,
            B_legacyGetUserMedia: pathB
        },
        codecs: {
            ...c.codecCaps,
            requested: c.options.codec,
            preference: c.loopbackInfos[0]?.codecPreference ?? null,
            negotiatedFromSdp: c.loopbackInfos[0]?.negotiatedVideoCodec ?? null,
            usedPerStats: summary.send.codecs
        },
        loopback: { initial: c.loopbackInfos[0] ?? null, all: c.loopbackInfos },
        receiver: {
            decodeStartups: c.decodeStartups,
            codecStartupTest: c.codecProbe,
            notes: [
                "decodeStartups: para cada RTCPeerConnection receptor criado, quanto tempo (desde o ICE conectar) até framesDecoded > 0, e os contadores de PLI/keyframes/descartes nesse momento.",
                "recv.fps nas amostras agora vem do delta de framesDecoded (exato por amostra); recv.fpsReported é o framesPerSecond do getStats. decodeStalled = bytes chegaram mas nada foi decodificado.",
                "CPU: totalPercentCPU agora é % de UM núcleo, via deltas de cumulativeCPUUsage. Nos JSONs anteriores (schema /1) o mesmo campo vinha do percentCPUUsage do Electron, que já é dividido pelo nº de núcleos (era % da máquina)."
            ]
        },
        stats: { summary, samples: c.samples },
        popoutStrategies: {
            defaultStrategy: DEFAULT_STRATEGY,
            selectedStrategy: c.options.popoutStrategy,
            labels: STRATEGY_LABELS,
            firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
            measureMs: MEASURE_MS,
            fullscreen: getState().fullscreen,
            testAll: c.testAll,
            results: c.strategyResults
        },
        errors,
        log: runLog
    };

    console.log(LOG_PREFIX, "Resultado completo", json);

    let resultPath: string | null = null;
    let resultError: string | null = null;
    try {
        const res = await getNative().writeResults(JSON.stringify(json, null, 2));
        if (res.ok && res.path) resultPath = res.path;
        else resultError = res.error ?? "erro desconhecido";
    } catch (e) {
        resultError = errorText(e);
    }

    if (resultPath) log(`Resultado salvo em ${resultPath}`);
    else logError(`Não foi possível salvar o JSON: ${resultError}`);

    if (ctx === c) ctx = null;
    setState({ phase: "idle", summary, resultPath, resultError, longTest: null, activeStrategy: null, sinkLive: null });
}

export async function runPathBTest() {
    const source = ctx?.source ?? getSelectedSource();
    if (!source) {
        logWarn("Selecione uma tela ou janela primeiro");
        return;
    }
    if (getState().pathBRunning) return;
    if (ctx) logWarn("Caminho B durante o teste: a segunda captura simultânea pode afetar as estatísticas");

    const c = ctx;
    setState({ pathBRunning: true });
    try {
        const result = await testLegacyGetUserMedia(source, getState().options);
        setState({ pathB: result });
        if (c && ctx === c) c.pathBDone = true;
    } finally {
        setState({ pathBRunning: false });
    }
}

export function shutdown() {
    void stopRun("plugin desativado");
    closePlayer();
    try {
        getNative().uninstallDisplayMediaHandler().catch(() => { });
    } catch { }
}

// #endregion
