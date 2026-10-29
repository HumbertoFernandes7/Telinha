/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { captureViaDisplayMedia, listSources, probeWebCodecs, testLegacyGetUserMedia } from "./capture";
import { createLoopback, getVideoCodecCapabilities, LoopbackSession } from "./loopback";
import { AudioMeter, sleep } from "./media";
import { closePlayer, openPlayer } from "./popout";
import { beginRunLog, endRunLog, errorText, getNative, getState, log, LOG_PREFIX, logError, logWarn, RESOLUTIONS, setState } from "./state";
import { StatsCollector, summarize } from "./stats";
import type { AudioResolution, CaptureSourceInfo, LoopbackInfo, PathAResult, PopoutResult, StatsSample, TestOptions } from "./types";

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
    loopbackInfo: LoopbackInfo | null;
    captureMeter: AudioMeter | null;
    recvMeter: AudioMeter | null;
    collector: StatsCollector;
    samples: StatsSample[];
    timer: number | null;
    sampling: boolean;
    stopping: boolean;
    pathBDone: boolean;
    popoutResults: PopoutResult[];
    popoutPending: Promise<void> | null;
}

let ctx: RunContext | null = null;
let audioSeq = 0;

const audioKey = (sourceId: string, mode: string) => `${sourceId}|${mode}`;

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
            releaseChannel: (window as any).GLOBAL_ENV?.RELEASE_CHANNEL ?? null
        },
        webCodecsEncoderProbe: await probeWebCodecs(width, height, options.fps).catch(e => ({ error: errorText(e) }))
    };
}

function formatSample(s: StatsSample) {
    const hw = (v: boolean | null | undefined) => v == null ? "?" : v ? "HW" : "SW";
    const parts = [`t=${s.t}s`];
    if (s.source) parts.push(`fonte ${s.source.width}x${s.source.height}@${s.source.fps}`);
    if (s.send) parts.push(`envio ${s.send.width}x${s.send.height}@${s.send.fps} ${s.send.bitrateKbps}kbps [${s.send.encoderImplementation} ${hw(s.send.powerEfficientEncoder)}, lim ${s.send.qualityLimitationReason}, enc ${s.send.avgEncodeMs}ms]`);
    if (s.recv) parts.push(`receb ${s.recv.width}x${s.recv.height}@${s.recv.fps} [${s.recv.decoderImplementation} ${hw(s.recv.powerEfficientDecoder)}]`);
    parts.push(s.audio.trackPresent ? `áudio cap ${s.audio.captureRmsDb}dB rec ${s.audio.receivedRmsDb}dB` : "sem áudio");
    if (s.cpu) parts.push(`CPU ${s.cpu.totalPercentCPU}% (${s.cpu.normalizedPercentCPU}% máq)`);
    return parts.join(" | ");
}

async function tick() {
    const c = ctx;
    if (!c?.loopback || c.sampling || c.stopping) return;
    c.sampling = true;

    try {
        const t = (performance.now() - c.statsStartedAt) / 1000;
        const cpu = await getNative().getAppMetrics().catch(() => null);
        const sample = await c.collector.sample(
            c.loopback.pcSend,
            c.loopback.pcRecv,
            t,
            cpu,
            c.captureMeter?.take() ?? { rms: null, peak: null },
            c.recvMeter?.take() ?? { rms: null, peak: null },
            !!c.stream?.getAudioTracks().length
        );

        if (ctx !== c || c.stopping) return;
        c.samples.push(sample);
        setState({ lastSample: sample, elapsedSec: Math.floor(t) });
        log(formatSample(sample));

        if (c.options.durationSec > 0 && t >= c.options.durationSec)
            void stopRun(`duração de ${c.options.durationSec} s concluída`);
    } catch (e) {
        logError("Falha ao coletar estatísticas", errorText(e));
    } finally {
        c.sampling = false;
    }
}

export async function openPopoutForRun() {
    const c = ctx;
    if (!c?.loopback) {
        logWarn("Inicie o teste antes de abrir a janela flutuante");
        return;
    }

    const pending = openPlayer(new MediaStream([c.loopback.receivedVideoTrack])).then(result => {
        c.popoutResults.push(result);
        if (ctx === c && !c.stopping) setState({ popout: result });
    });
    c.popoutPending = pending;
    await pending;
    if (c.popoutPending === pending) c.popoutPending = null;
}

export async function startRun() {
    const state = getState();
    if (state.phase !== "idle") return;

    const source = getSelectedSource();
    if (!source) {
        logWarn("Selecione uma tela ou janela primeiro");
        return;
    }

    const options = { ...state.options };
    const { width, height } = RESOLUTIONS[options.resolution];

    beginRunLog();
    setState({ phase: "starting", lastSample: null, elapsedSec: 0, pathA: null, pathB: null, popout: null, summary: null, resultPath: null, resultError: null });

    const c: RunContext = ctx = {
        startedAt: new Date(),
        statsStartedAt: 0,
        options,
        source,
        envPromise: collectEnvironment(options).catch(e => ({ error: errorText(e) })),
        codecCaps: null,
        audioRes: null,
        pathA: null,
        stream: null,
        loopback: null,
        loopbackInfo: null,
        captureMeter: null,
        recvMeter: null,
        collector: new StatsCollector(),
        samples: [],
        timer: null,
        sampling: false,
        stopping: false,
        pathBDone: false,
        popoutResults: [],
        popoutPending: null
    };

    try {
        log(`Iniciando: ${source.kind === "screen" ? "tela" : "janela"} "${source.name}" (${source.id}), ${width}x${height} @ ${options.fps} fps, máx ${options.maxBitrateMbps} Mbps, áudio ${options.audioMode}, codec ${options.codec}, duração ${options.durationSec || "contínua"}`);

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
            c.loopback = await createLoopback(stream, {
                maxBitrateBps: options.maxBitrateMbps * 1_000_000,
                maxFramerate: options.fps,
                codec: options.codec,
                startBitrateHint: options.startBitrateHint
            });
            c.loopbackInfo = c.loopback.info;
        } catch (e: any) {
            c.loopbackInfo = e?.loopbackInfo ?? null;
            throw new Error(`Loopback WebRTC falhou: ${errorText(e)}`);
        }

        if (c.loopback.receivedAudioTrack) {
            c.recvMeter = new AudioMeter(c.loopback.receivedAudioTrack, true);
            c.recvMeter.setListening(getState().listenAudio);
        }

        if (ctx !== c || c.stopping) {
            // stopped while the loopback was connecting: stopRun's teardown already ran, release what was created since
            teardown(c);
            return;
        }

        await getNative().getAppMetrics().catch(() => null); // primes percentCPUUsage (first call is always 0)
        c.statsStartedAt = performance.now();
        c.timer = window.setInterval(tick, 1000);
        setState({ phase: "running" });
        log("Rodando. Deixe algo em movimento (vídeo/jogo) e com som na fonte escolhida.");

        if (options.autoPopout) void openPopoutForRun();
    } catch (e) {
        logError(errorText(e));
        await stopRun("erro ao iniciar");
    }
}

function teardown(c: RunContext) {
    if (c.timer != null) clearInterval(c.timer);
    c.timer = null;

    closePlayer();
    c.recvMeter?.close();
    c.captureMeter?.close();
    c.loopback?.close();
    c.stream?.getTracks().forEach(t => t.stop());
    getNative().cancelPendingDisplayMedia().catch(() => { });
}

export async function stopRun(reason = "parado pelo usuário") {
    const c = ctx;
    if (!c || c.stopping) return;
    c.stopping = true;
    setState({ phase: "stopping" });
    log(`Encerrando: ${reason}`);

    if (c.popoutPending) {
        log("Aguardando a verificação da janela flutuante terminar antes de encerrar…");
        await Promise.race([c.popoutPending, sleep(30_000)]);
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

    log(`Resumo: envio ${summary.send.avgFps ?? "?"} fps / ${summary.send.avgBitrateKbps ?? "?"} kbps, encoder ${summary.send.encoderImplementations.join(", ") || "?"} (HW: ${summary.verdict.hardwareEncoder}), recebido ${summary.recv.avgFps ?? "?"} fps, áudio com sinal em ${summary.audio.secondsWithSignal} s, CPU média ${summary.cpu.avgTotalPercent ?? "?"}%`);
    for (const note of summary.verdict.notes) logWarn(note);

    const { log: runLog, errors } = endRunLog();
    const popout = c.popoutResults.at(-1) ?? null;
    const popoutState = getState().popout;
    if (popout && popoutState?.at === popout.at) popout.fullscreen = popoutState.fullscreen;

    const json = {
        schema: "peerlive-capture-test/1",
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
            preference: c.loopbackInfo?.codecPreference ?? null,
            negotiatedFromSdp: c.loopbackInfo?.negotiatedVideoCodec ?? null,
            usedPerStats: summary.send.codecs
        },
        loopback: c.loopbackInfo,
        stats: { summary, samples: c.samples },
        popout: { latest: popout, all: c.popoutResults },
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
    setState({ phase: "idle", summary, popout, resultPath, resultError });
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
