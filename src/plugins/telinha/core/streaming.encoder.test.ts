/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do envio no ar (core/streaming.ts): a checagem do encoder H.264 a cada tick (checkEncoder, com as estatisticas
// de envio que o Chromium mostra: placa de video, OpenH264 de passagem, OpenH264 de verdade), a troca de codec sem
// reconectar (switchSendCodec, por sender.params.codecs + setParameters), os parametros de envio (applySenderParams),
// a captura que muda de tamanho (checkCaptureSize) e o tipo de conexao (connectionInfo). Este PC "codifica H.264 na
// placa" pela sonda falsa (mediaCapabilities.hwEncode, antes de startSession) e o espectador anuncia h264HwDecode na
// presenca. O comportamento real do encoder do Chromium nao da para medir aqui: os casos reproduzem o que foi medido e
// esta descrito no comentario de checkEncoder.
// A queda do H.264 conta por sessao do Discord (codec.ts → noteH264Fallback, estado do processo): a ordem dos testes
// de queda importa (a 1a queda, a 2a que desliga o H.264 automatico, as seguintes).
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.encoder.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { getState } from "@plugins/telinha/store";
import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, EncoderSim, type FakeMediaStreamTrack, type FakeRTCRtpSender, negotiatedCodecs, type StatsEntry, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { rt } from "./context";
import { scaledSize } from "./quality/levels";
import { STATS_LINE_RE } from "./statsLog";
import { connectionInfo, sendPlanFor, startStreaming, stopStreaming } from "./streaming";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";

/** H.264 na placa de video (o que o Chromium mostra com o encoder da NVIDIA). */
const gpuStats = (over: Parameters<typeof videoSenderStats>[0] = {}) =>
    videoSenderStats({ mimeType: "video/H264", encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: 600, ...over });

/** H.264 no OpenH264 (software). */
const softStats = (over: Parameters<typeof videoSenderStats>[0] = {}) =>
    videoSenderStats({ mimeType: "video/H264", encoderImplementation: "OpenH264", powerEfficientEncoder: false, framesEncoded: 600, ...over });

let rig: StreamingRig;
let seq = 0;

interface TestViewer {
    peerId: string;
    label: string;
    sender: FakeRTCRtpSender;
}

/** Um espectador novo que pede para assistir; `hw`: decodifica H.264 por hardware (presenca). */
async function watcher(name: string, opts: { hw?: boolean; stats?: StatsEntry[]; } = {}): Promise<TestViewer> {
    seq++;
    const peerId = `e${name}`;
    const pc = await connectViewer(rig, peerId, String(800_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: opts.hw ?? true });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    const sender = videoSenderOf(pc)!;
    if (opts.stats) sender.stats = opts.stats;
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, sender };
}

/** O codec fixado no encodings[0] do envio (undefined = o negociado). */
const codecOf = (v: TestViewer) => v.sender.encoding.codec;

/** Linhas do log sobre este espectador, sem as de estatisticas a cada 10 s (statsLog.ts, testadas a parte). */
const about = (lines: string[], v: TestViewer) => lines.filter(l => l.includes(v.label) && !STATS_LINE_RE.test(l));

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            // este PC codifica e decodifica H.264 (perfil 42001f) na placa de video
            rtc.mediaCapabilities.hwEncode = ["42001f"];
            rtc.mediaCapabilities.hwDecode = ["42001f"];
        }
    });
    await waitForProbe();
    await enterCall(rig, []);
    // sem a qualidade automatica mexendo nos degraus (ela tem os proprios testes): so o que streaming.ts faz
    pluginSettings.set("autoQuality", false);
    pluginSettings.set("requireVerifiedIdentity", false);
});

async function waitForProbe() {
    for (let i = 0; i < 200 && !getLocalCaps().h264HwEncode; i++) await turns(1);
    assert.equal(getLocalCaps().h264HwProfile, "42001f", "a sonda achou o H.264 na placa");
}

after(() => destroyRig(rig));

describe("checagem do encoder H.264 no ar (tick)", () => {
    // espectadores H.264 que ja estao no ar antes de o H.264 automatico desligar (2a queda da sessao)
    const early: Record<string, TestViewer> = {};

    before(async () => {
        await startStreaming(screenOptions());
        for (const name of ["gpu", "band", "cpu", "other", "resize", "retry", "twice", "nocodec", "gone"]) early[name] = await watcher(name, { stats: gpuStats() });
    });

    after(() => stopStreaming());

    test("H.264 na placa de video: decidido pelos dois lados, o codec real e logado uma vez e nada muda", async () => {
        const v = early.gpu;
        assert.deepEqual({ ...sendPlanFor(v.peerId), bitrate: undefined, label: undefined }, { codec: "h264", h264Profile: "42001f", bitrate: undefined, label: undefined });
        const since = logMark();
        await seconds(rig, 3);
        assert.deepEqual(about(since(), v), [`Codificando para ${v.label}: video/H264 (${NVENC}, hardware)`]);
        assert.equal(v.sender.encoding.codec, undefined, "sem troca de codec");
    });

    test("OpenH264 de passagem (o WebRTC reduziu para um tamanho que a placa nao aceita): so loga, com o motivo", async () => {
        const { band, cpu, other } = early;
        band.sender.stats = softStats({ frameWidth: 480, frameHeight: 270, qualityLimitationReason: "bandwidth" });
        cpu.sender.stats = softStats({ frameWidth: 427, frameHeight: 240, qualityLimitationReason: "cpu" });
        other.sender.stats = softStats({ frameWidth: 853, frameHeight: 480, qualityLimitationReason: "other" });
        const since = logMark();
        await seconds(rig, 2);
        const lines = since();
        const transient = (v: TestViewer, size: string, why: string) => `O H.264 para ${v.label} passou para o OpenH264 (software) em ${size}: o WebRTC reduziu a resolução `
            + `por conta própria (${why}) e a placa de vídeo só codifica H.264 em tamanho par a partir de 360p. Volta para a placa sozinho quando a resolução subir; não é queda.`;
        assert.deepEqual(about(lines, band), [transient(band, "480x270", "banda")], "uma vez (repeticoes no mesmo minuto sao omitidas)");
        assert.deepEqual(about(lines, cpu), [transient(cpu, "427x240", "CPU")]);
        assert.deepEqual(about(lines, other), [transient(other, "853x480", "other")]);
        for (const v of [band, cpu, other]) {
            assert.equal(v.sender.encoding.codec, undefined, "continua em H.264");
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        }

        // a resolucao subiu de novo: voltou para a placa (loga uma vez)
        band.sender.stats = gpuStats({ frameWidth: 1280, frameHeight: 720 });
        await seconds(rig, 2);
        assert.deepEqual(about(since(), band).slice(1), [`O H.264 para ${band.label} voltou para a placa de vídeo (1280x720)`]);
    });

    test("OpenH264 logo depois de a janela mudar de tamanho: so loga; passado o tempo de reaplicar, e queda: troca para VP9 sem reconectar", async () => {
        const v = early.resize;
        const track = rt.local!.stream.getVideoTracks()[0] as FakeMediaStreamTrack;
        track.setSettings({ width: 1904, height: 1040 });
        v.sender.stats = softStats({ frameWidth: 1904, frameHeight: 1040 });
        const since = logMark();
        await seconds(rig, 4);
        assert.deepEqual(about(since(), v), [
            `O H.264 para ${v.label} passou para o OpenH264 (software) em 1904x1040 logo depois de a janela capturada `
            + "mudar de tamanho: a redução de resolução está sendo recalculada em tamanho par e ele volta para a placa de vídeo. Não é queda."
        ]);
        assert.equal(v.sender.encoding.codec, undefined);

        // 5 s depois da mudanca, ainda no OpenH264 num tamanho que a placa aceita: queda de verdade (a 1a da sessao)
        await seconds(rig, 2);
        assert.deepEqual(v.sender.encoding.codec, { mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=0" });
        assert.equal(sendPlanFor(v.peerId)?.codec, "vp9", "renegociacoes futuras ja vao com VP9");
        assert.equal(getLocalCaps().h264HwEncode, true, "uma queda so nao desliga o H.264 automatico");
        assert.deepEqual(about(since(), v).slice(1), [
            `O H.264 para ${v.label} está sendo codificado por software (OpenH264, 1904x1040), não pela placa de vídeo, e a imagem pode travar: `
            + `trocando para VP9 só para ${v.label}. Os próximos espectadores ainda tentam a placa de vídeo.`,
            `${v.label} agora recebe VP9 (trocado sem reconectar)`
        ]);

        // o Chromium trocou: 2 s depois o codec real e logado de novo, e o VP9 nao e mais conferido
        v.sender.stats = videoSenderStats();
        await seconds(rig, 3);
        assert.deepEqual(about(since(), v).slice(3), [`Codificando para ${v.label}: video/VP9 (libvpx)`]);
        const calls = v.sender.getStatsCalls;
        await seconds(rig, 2);
        assert.ok(v.sender.getStatsCalls - calls <= 1, "so a leitura da qualidade automatica (1 a cada 2 s)");
        // a captura volta ao tamanho de antes (e o tempo de reaplicar passa) para os proximos testes
        track.setSettings({ width: 1920, height: 1080 });
        await seconds(rig, 6);
    });

    test("2a queda da sessao (com o setParameters recusado uma vez): troca na 2a tentativa e desliga o H.264 automatico para os proximos", async () => {
        const v = early.retry;
        let refusals = 0;
        v.sender.setParametersImpl = params => {
            if ((params.encodings[0] as { codec?: unknown; }).codec && refusals++ === 0) throw new DOMException("colidiu com outro setParameters", "InvalidStateError");
        };
        v.sender.stats = softStats();
        const since = logMark();
        await seconds(rig, 1);
        assert.equal(v.sender.encoding.codec, undefined, "a 1a tentativa foi recusada");
        rig.clock.tick(500);
        await turns();
        assert.equal(codecOf(v)?.mimeType, "video/VP9", "a 2a tentativa, 500 ms depois, passou");
        assert.deepEqual(about(since(), v), [
            `O H.264 para ${v.label} está sendo codificado por software (OpenH264, 1920x1080), não pela placa de vídeo, e a imagem pode travar: `
            + `trocando para VP9 só para ${v.label}. Foi a 2ª queda nesta sessão: os próximos espectadores vão receber VP9.`,
            `${v.label} agora recebe VP9 (trocado sem reconectar)`
        ]);
        assert.equal(getLocalCaps().h264HwEncode, false);

        // o Chromium ainda nao trocou (as estatisticas seguem em H.264): avisa a diferenca, sem cair de novo
        await seconds(rig, 3);
        assert.deepEqual(about(since(), v).slice(2), [`Codificando para ${v.label}: video/H264 (OpenH264) — esperado VP9`]);

        // os proximos espectadores ja recebem VP9, mesmo decodificando H.264 por hardware
        const next = await watcher("next");
        assert.equal(sendPlanFor(next.peerId)?.codec, "vp9");
        assert.ok(since().includes(`Enviando para ${next.label}: codec VP9 (automático: este PC não codifica H.264 por hardware → VP9)`));
    });

    test("troca recusada duas vezes: avisa o que fazer (parar e assistir de novo) e nao tenta mais", async () => {
        const v = early.twice;
        v.sender.setParametersImpl = params => {
            if ((params.encodings[0] as { codec?: unknown; }).codec) throw new DOMException("recusado", "InvalidModificationError");
        };
        v.sender.stats = softStats({ omit: ["frameWidth", "frameHeight"] });
        const since = logMark();
        await seconds(rig, 1);
        rig.clock.tick(500);
        await turns();
        assert.equal(v.sender.encoding.codec, undefined);
        assert.deepEqual(about(since(), v), [
            `O H.264 para ${v.label} está sendo codificado por software (OpenH264, tamanho desconhecido), não pela placa de vídeo, e a imagem pode travar: `
            + `trocando para VP9 só para ${v.label}.`,
            `Não deu para trocar ${v.label} para VP9 (InvalidModificationError: recusado). Peça para ele parar de assistir e assistir de novo: vai receber VP9.`
        ]);
        await seconds(rig, 3);
        assert.equal(about(since(), v).filter(l => l.includes("trocando para")).length, 1, "uma vez por espectador");
    });

    test("VP9 nao negociado com o espectador: nao da para trocar sem renegociar, e o aviso diz isso", async () => {
        const v = early.nocodec;
        v.sender.params.codecs = negotiatedCodecs(DEFAULT_VIDEO_CODECS.filter(c => c.mimeType !== "video/VP9"));
        v.sender.stats = softStats({ omit: ["encoderImplementation"] });
        const since = logMark();
        await seconds(rig, 1);
        assert.equal(v.sender.encoding.codec, undefined);
        assert.deepEqual(about(since(), v).slice(-1), [
            `Não deu para trocar ${v.label} para VP9 (VP9 não foi negociado com ele). Peça para ele parar de assistir e assistir de novo: vai receber VP9.`
        ]);
        assert.ok(about(since(), v)[0].includes("(sem aceleração, 1920x1080)"), "sem nome do encoder");
    });

    test("espectador que para de assistir enquanto a troca espera a 2a tentativa: nada mais e tentado", async () => {
        const v = early.gone;
        let attempts = 0;
        v.sender.setParametersImpl = params => {
            if (!(params.encodings[0] as { codec?: unknown; }).codec) return;
            attempts++;
            throw new DOMException("recusado", "InvalidStateError");
        };
        v.sender.stats = softStats();
        const since = logMark();
        await seconds(rig, 1);
        assert.equal(attempts, 1);
        rig.room.receive("watch", { op: "stop" }, v.peerId);
        rig.clock.tick(500);
        await turns();
        assert.equal(attempts, 1, "sem 2a tentativa");
        assert.deepEqual(about(since(), v).filter(l => l.startsWith("Não deu")), []);
    });

    test("codec fixado em H.264: quem cai para software continua em H.264 (e quem nao decodifica por hardware e avisado)", async () => {
        pluginSettings.set("codec", "h264");
        try {
            const joined = logMark();
            const v = await watcher("fixed", { hw: false, stats: softStats() });
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            const lines = joined();
            assert.ok(lines.includes(`Enviando para ${v.label}: codec H264 (fixado nas configurações)`));
            assert.ok(lines.includes(`${v.label} não decodifica H.264 por hardware: o início pode travar por 15+ s`));
            const since = logMark();
            await seconds(rig, 1);
            assert.equal(v.sender.encoding.codec, undefined, "sem troca");
            assert.deepEqual(about(since(), v), [
                `Codificando para ${v.label}: video/H264 (OpenH264)`,
                `O H.264 para ${v.label} está sendo codificado por software (OpenH264, 1920x1080), não pela placa de vídeo, e a imagem pode travar. `
                + "Continua em H.264 porque o codec está fixado nas configurações."
            ]);
            // uma vez por espectador: nao avisa de novo
            await seconds(rig, 2);
            assert.equal(about(since(), v).length, 2);
        } finally {
            pluginSettings.set("codec", "auto");
        }
    });

    test("estatisticas incompletas ou outro codec: o que da para logar, sem quebrar o tick", async () => {
        const vp8 = await watcher("vp8", { hw: false, stats: videoSenderStats({ mimeType: "video/VP8" }) });
        const bare = await watcher("bare", { hw: false, stats: videoSenderStats({ omit: ["encoderImplementation"] }) });
        const none = await watcher("none", { hw: false, stats: [] });
        const nocid = await watcher("nocid", { hw: false, stats: videoSenderStats({ omit: ["codecId"] }) });
        const broken = await watcher("broken", { hw: false });
        broken.sender.stats = () => Promise.reject(new Error("pc fechado"));
        const since = logMark();
        await seconds(rig, 2);
        const lines = since();
        assert.deepEqual(about(lines, vp8), [`Codificando para ${vp8.label}: video/VP8 (libvpx) — esperado VP9`]);
        assert.deepEqual(about(lines, bare), [`Codificando para ${bare.label}: video/VP9`]);
        for (const v of [none, nocid, broken]) assert.deepEqual(about(lines, v), [], "sem codec conhecido: nada a logar");
        // sem codec conhecido, continua conferindo a cada tick
        const calls = none.sender.getStatsCalls;
        await seconds(rig, 2);
        assert.ok(none.sender.getStatsCalls - calls >= 2);
    });

    test("espectador sem sender de video (a faixa saiu do transceiver): o tick pula ele", async () => {
        const v = await watcher("nosender", { hw: false, stats: videoSenderStats() });
        v.sender.track = null;
        const calls = v.sender.getStatsCalls;
        await seconds(rig, 2);
        assert.equal(v.sender.getStatsCalls, calls);
    });
});

describe("parametros de envio (applySenderParams)", () => {
    afterEach(() => {
        stopStreaming();
        rig.room.addStreamMode = "resolve";
    });

    /** Pede para assistir com o addStream segurado: o sender ja existe, os parametros so vao quando ele terminar. */
    async function held(name: string) {
        rig.room.addStreamMode = "manual";
        const v = await watcher(name, { hw: false });
        return v;
    }

    test("degrau abaixo da captura: o log diz a reducao (em tamanho par)", async () => {
        await startStreaming(screenOptions({ quality: "720p60" }));
        const since = logMark();
        const v = await watcher("p720", { hw: false });
        assert.deepEqual(v.sender.encoding, { active: true, maxBitrate: 12_000_000, maxFramerate: 60, scaleResolutionDownBy: 1.5, priority: "high", networkPriority: "high" });
        assert.ok(about(since(), v).includes(`Envio para ${v.label}: 720p 60 fps, até 12000 kbps (captura 1920x1080 ÷1.5 = 1280x720), prioriza fps`));
    });

    test("degradationPreference recusado: aplica sem ele e nao tenta de novo nas proximas vezes", async () => {
        await startStreaming(screenOptions({ quality: "720p60" }));
        const v = await held("nodeg");
        const tried: boolean[] = [];
        v.sender.setParametersImpl = params => {
            tried.push("degradationPreference" in params);
            if ("degradationPreference" in params) throw new DOMException("degradationPreference not supported", "InvalidModificationError");
        };
        const since = logMark();
        rig.room.settleStreams(true);
        await turns();
        assert.deepEqual(tried, [true, false]);
        assert.equal(v.sender.encoding.maxBitrate, 12_000_000);
        assert.deepEqual(about(since(), v), [
            `Envio para ${v.label}: degradationPreference recusado (InvalidModificationError: degradationPreference not supported); `
            + "720p 60 fps, até 12000 kbps (captura 1920x1080 ÷1.5 = 1280x720) aplicado"
        ]);

        // a captura mudou de tamanho: reaplica direto sem degradationPreference
        const track = rt.local!.stream.getVideoTracks()[0] as FakeMediaStreamTrack;
        track.setSettings({ width: 1904, height: 1040 });
        await seconds(rig, 1);
        assert.deepEqual(tried, [true, false, false]);

        // e se agora falhar, so avisa (sem tentar com/sem de novo)
        v.sender.setParametersImpl = () => {
            throw new DOMException("closed", "InvalidStateError");
        };
        track.setSettings({ width: 1920, height: 1080 });
        await seconds(rig, 1);
        assert.ok(about(since(), v).includes(`setParameters falhou para ${v.label}: InvalidStateError: closed`));
    });

    test("setParameters recusado com e sem degradationPreference: avisa, e a proxima avaliacao tenta de novo", async () => {
        await startStreaming(screenOptions());
        const v = await held("noparams");
        let refuse = true;
        v.sender.setParametersImpl = () => {
            if (refuse) throw new DOMException("busy", "InvalidStateError");
        };
        const since = logMark();
        rig.room.settleStreams(true);
        await turns();
        assert.equal(v.sender.setCalls.length, 0);
        assert.deepEqual(about(since(), v), [`setParameters falhou para ${v.label}: InvalidStateError: busy`]);

        refuse = false;
        await seconds(rig, 2);
        assert.equal(v.sender.setCalls.length, 1);
        assert.ok(about(since(), v).includes(`Envio para ${v.label}: 1080p 60 fps, até 20000 kbps, prioriza fps`));
    });

    test("sender ainda sem encodings: o encodings[0] e criado com os parametros do degrau", async () => {
        await startStreaming(screenOptions());
        const v = await held("noenc");
        v.sender.params.encodings = [];
        rig.room.settleStreams(true);
        await turns();
        assert.deepEqual(v.sender.encoding, { maxBitrate: 20_000_000, maxFramerate: 60, scaleResolutionDownBy: 1, priority: "high", networkPriority: "high" });
    });

    test("sem sender de video quando a midia fica pronta: avisa que os parametros nao foram aplicados", async () => {
        await startStreaming(screenOptions());
        const v = await held("lost");
        v.sender.track = null;
        const since = logMark();
        rig.room.settleStreams(true);
        await turns();
        assert.deepEqual(about(since(), v), [`Sem RTCRtpSender de vídeo para ${v.label}; parâmetros de envio não aplicados`]);
    });
});

describe("captura que muda de tamanho (checkCaptureSize)", () => {
    afterEach(() => stopStreaming());

    test("a escala de algum espectador muda: reaplica em tamanho par; o log sai no maximo 1x a cada 10 s", async () => {
        await seconds(rig, 10); // a linha "A captura mudou" de um teste anterior ja saiu do intervalo de 10 s
        await startStreaming(screenOptions({ quality: "720p60" }));
        const v = await watcher("rs", { hw: false });
        const track = rt.local!.stream.getVideoTracks()[0] as FakeMediaStreamTrack;
        assert.equal(v.sender.encoding.scaleResolutionDownBy, 1.5);
        const since = logMark();

        track.setSettings({ width: 1904, height: 1040 });
        await seconds(rig, 1);
        const scale = v.sender.encoding.scaleResolutionDownBy!;
        const size = scaledSize(1904, 1040, scale);
        assert.notEqual(scale, 1.5);
        assert.deepEqual([size.height, size.width % 2, size.height % 2], [720, 0, 0], `1904x1040 ÷${scale} = ${size.width}x${size.height}`);
        const resized = "A captura mudou de 1920x1080 para 1904x1040: recalculando a redução de resolução dos espectadores "
            + "(em tamanho par, para a placa de vídeo continuar codificando H.264)";
        // (o teste anterior teve uma mudanca omitida pelo limite de 10 s: a linha diz quantas)
        const lines = since().filter(l => l.startsWith("A captura mudou"));
        assert.equal(lines.length, 1);
        assert.ok(lines[0].startsWith(resized), lines[0]);

        // de volta ao tamanho anterior em menos de 10 s: reaplica, sem outra linha no log
        track.setSettings({ width: 1920, height: 1080 });
        await seconds(rig, 1);
        assert.equal(v.sender.encoding.scaleResolutionDownBy, 1.5);
        assert.equal(since().filter(l => l.startsWith("A captura mudou")).length, 1);

        // mesmo tamanho no tick seguinte: nada
        const calls = v.sender.setCalls.length;
        await seconds(rig, 1);
        assert.equal(v.sender.setCalls.length, calls);
    });

    test("a escala nao muda (degrau na resolucao da captura) ou ninguem assiste: nada a reaplicar", async () => {
        await startStreaming(screenOptions());
        const track = rt.local!.stream.getVideoTracks()[0] as FakeMediaStreamTrack;
        const since = logMark();
        track.setSettings({ width: 1600, height: 900 });
        await seconds(rig, 1);

        const v = await watcher("rs2", { hw: false });
        const calls = v.sender.setCalls.length;
        track.setSettings({ width: 1904, height: 1040 });
        await seconds(rig, 1);
        assert.equal(v.sender.setCalls.length, calls, "1080p60 numa captura menor que 1080p: sempre escala 1");
        assert.deepEqual(since().filter(l => l.startsWith("A captura mudou")), []);
    });
});

describe("qualidade automatica: o plano de envio de quem desceu de degrau", () => {
    before(() => {
        pluginSettings.set("autoQuality", true);
    });

    after(() => {
        stopStreaming();
        pluginSettings.set("autoQuality", false);
    });

    test("banda curta por mais que a carencia: o espectador desce para 720p e a renegociacao comeca na banda do degrau", async () => {
        await startStreaming(screenOptions());
        const v = await watcher("bw", { hw: false });
        new EncoderSim({ availableKbps: 500 }).attach(v.sender);
        assert.deepEqual(sendPlanFor(v.peerId)?.bitrate, { startKbps: 10_000, maxKbps: 20_000 });
        await seconds(rig, 30);
        assert.equal(getState().local?.autoQuality?.viewers[v.peerId]?.level, "720p60");
        assert.deepEqual(sendPlanFor(v.peerId)?.bitrate, { startKbps: 6000, maxKbps: 20_000 }, "o teto continua (pode subir sem renegociar); o inicio acompanha o degrau");
        assert.equal(v.sender.encoding.scaleResolutionDownBy, 1.5);
    });
});

describe("tipo de conexao com o espectador (connectionInfo)", () => {
    test("par de candidatos escolhido: mesma rede, internet direta ou servidor TURN, com o RTT", async () => {
        const pc = await connectViewer(rig, "cinfo", "810000000000000081", "cinfo");
        assert.equal(await connectionInfo("ninguem"), null, "sem conexao");

        pc.stats = videoSenderStats({ currentRoundTripTime: 0.0123 });
        assert.equal(await connectionInfo("cinfo"), "Conexão direta, na mesma rede · 12 ms");
        pc.stats = videoSenderStats({ localCandidateType: "srflx" });
        assert.equal(await connectionInfo("cinfo"), "Conexão direta pela internet (P2P) · 20 ms");
        pc.stats = videoSenderStats({ localCandidateType: "srflx", remoteCandidateType: "relay" });
        assert.equal(await connectionInfo("cinfo"), "Conexão por servidor intermediário (TURN) · 20 ms");
    });

    test("sem par escolhido no transporte: usa o par nomeado que deu certo; sem nenhum, 'Conectando…'", async () => {
        const stats = (patch: (s: StatsEntry[]) => void) => {
            const s = videoSenderStats();
            patch(s);
            return s;
        };
        const entry = (s: StatsEntry[], id: string) => s.find(e => e.id === id)!;
        const pc = rig.room.peers.get("cinfo") as unknown as { stats: StatsEntry[]; };

        pc.stats = stats(s => delete entry(s, "T01").selectedCandidatePairId);
        assert.equal(await connectionInfo("cinfo"), "Conexão direta, na mesma rede · 20 ms");
        pc.stats = stats(s => entry(s, "T01").selectedCandidatePairId = "CP99");
        assert.equal(await connectionInfo("cinfo"), "Conexão direta, na mesma rede · 20 ms", "id do par que nao esta no relatorio");
        pc.stats = stats(s => delete entry(s, "CP01").currentRoundTripTime);
        assert.equal(await connectionInfo("cinfo"), "Conexão direta, na mesma rede", "sem RTT");
        pc.stats = stats(s => {
            delete entry(s, "T01").selectedCandidatePairId;
            entry(s, "CP01").state = "in-progress";
        });
        assert.equal(await connectionInfo("cinfo"), "Conectando…");
        pc.stats = [];
        assert.equal(await connectionInfo("cinfo"), "Conectando…");
    });
});
