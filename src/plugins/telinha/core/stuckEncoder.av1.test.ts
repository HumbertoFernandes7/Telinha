/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A rede de seguranca do AV1 (core/stuckEncoder.ts → settleAv1 / runAv1Probe / noteAv1Failed), num PC com NVIDIA RTX 40
// que codifica e decodifica 42001f, 640032 e AV1 Main na placa (a sonda de codecs falsa, com o fmtp do Chromium 152), com
// o WebRtcAV1HWEncode ligado nesta partida. A sonda WebCodecs do AV1 (av01.0.05M.08 em prefer-hardware, sobre um Worker
// falso) so roda com o AV1 fixado, depois das do Baseline e do High, segura o H.264 da placa enquanto roda, confirma um
// "travou" com uma 2a rodada, e o resultado fica salvo por ambiente (hwAv1Probe). Sem o recurso nesta partida, ela nunca
// roda. Um envio em AV1 que falha marca o AV1, nunca o H.264. Estado do modulo e do processo: a ordem importa.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.av1.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getEventLog, type TelinhaEvent } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities, type WebRtcEnv } from "@test/fakes/webrtc";
import { type FakeWorker, healthyProbe, installWorker, stuckProbe, type WorkerEnv } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps, setAv1HwFeature, setH264HwStuck } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import {
    av1ProbeCodec, av1ProbeRecord, type EncoderEnv, forgetStuckEncoder, h265ProbeRecord, noteAv1Failed, noteStreamStarting, noteStuckEncoder, onCodecSettingChanged,
    onStreamStopped, PROBE_START, runAv1Probe, settleAv1, startLocalCaps, stuckEncoderDiagnostics, stuckRecord
} from "./stuckEncoder";

const NV_ENV: EncoderEnv = { vendorId: "10de", deviceId: "2786", driver: "32.0.16.2101", chrome: "152.0.7977.167", discord: "1.0.9266" };
const AV1_SEND = "level-idx=5;profile=0;tier=0";
const CODEC = "av01.0.05M.08";
const h264 = (profile: string): RTCRtpCodec => ({ mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}` });
/** Espectadores: com AV1 e High na placa (uma RTX 30 nesta versao), e um da versao do H.265 (sem av1). */
const BOTH = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, av1: true } };
const OLD = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };
const OK_DETAIL = "30 pacotes de 30 quadros";
const STUCK = "nenhum pacote em 0.06 s desde o 1º quadro (o flush() não terminou)";
const AT = new Date(2026, 10, 2, 10, 0).getTime();

let rtc: WebRtcEnv;
let native: NativeEnv;
let workers: WorkerEnv | null = null;
const timing = { ...ENCODER_PROBE_TIMING };

function logMark() {
    const seen = new Set<TelinhaEvent>(getEventLog());
    return () => getEventLog().filter(e => !seen.has(e)).map(e => `${e.level}: ${e.msg}`);
}

function workersFor(...scripts: NonNullable<WorkerEnv["script"]>[]) {
    let n = 0;
    return installWorker((w, data) => scripts[Math.min(n++, scripts.length - 1)](w, data));
}

const configOf = (w: FakeWorker) => (w.posted[0] as { config: Record<string, unknown>; }).config;
const av1Line = () => stuckEncoderDiagnostics().split("\n").find(l => l.startsWith("AV1: "));

before(() => {
    rtc = installWebRtc();
    const video = [...DEFAULT_VIDEO_CODECS, h264("640032")];
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video };
    rtc.mediaCapabilities.hwEncode = ["42001f", "640032", "av1"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "640032", "av1"];
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x10de, deviceId: 0x2786, driverVersion: NV_ENV.driver, chrome: NV_ENV.chrome, discord: NV_ENV.discord, error: null })
    });
    // o AV1 e so manual: a sonda dele so roda com ele fixado, e com o WebRtcAV1HWEncode ligado nesta partida
    pluginSettings.load({ codec: "av1" });
    setAv1HwFeature(true);
    Object.assign(PROBE_START, { delayMs: 0, confirmMs: 0 });
    Object.assign(ENCODER_PROBE_TIMING, { configureMs: 40, noChunkMs: 60, flushMs: 60 });
});

after(() => {
    workers?.restore();
    Object.assign(ENCODER_PROBE_TIMING, timing);
    native.restore();
    rtc.restore();
});

describe("inicio da sessao num ambiente novo", () => {
    test("Baseline, High e AV1 (av01.0.05M.08, prefer-hardware, sem formato), uma depois da outra: AV1 so com quem anuncia AV1", async () => {
        workers = installWorker(healthyProbe());
        const lines: string[] = [];
        const since = logMark();
        await startLocalCaps(line => lines.push(line));
        await eventually(() => lines.length === 1);
        assert.deepEqual(workers.instances.map(w => configOf(w).codec), ["avc1.42001f", "avc1.640032", CODEC], "o H.265 (nao fixado) nem roda");
        assert.deepEqual(configOf(workers.instances[2]), {
            codec: CODEC, width: 1280, height: 720, framerate: 30, bitrate: 2_000_000, hardwareAcceleration: "prefer-hardware", latencyMode: "realtime"
        });
        assert.match(lines[0], new RegExp(`AV1 por hardware — decodifica: sim, codifica: sim \\(${AV1_SEND}\\); WebRtcAV1HWEncode ligado nesta partida; placa de vídeo 10de:2786, `));
        assert.ok(lines[0].endsWith(`; sonda WebCodecs H.264 High: ok (${OK_DETAIL}); sonda WebCodecs AV1: ok (${OK_DETAIL})`), lines[0]);
        assert.deepEqual({ ...av1ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "ok", detail: OK_DETAIL, codec: CODEC });
        assert.equal(h265ProbeRecord(), null);
        assert.ok(since().includes(`info: Sonda WebCodecs do AV1 (${CODEC}) da placa de vídeo: ok (${OK_DETAIL}); com o AV1 fixado, vai AV1 para quem também decodifica AV1 por hardware`));

        assert.equal(getLocalCaps().av1ProbeOk, true);
        assert.deepEqual({ ...chooseCodec(BOTH, "av1"), reason: "" }, { codec: "av1", h264Profile: "640032", h264Backup: "42001f", reason: "" });
        assert.equal(chooseCodec(OLD, "av1").codec, "h264", "espectador de antes: o H.264 do automatico");
        assert.equal(chooseCodec(BOTH, "auto").codec, "h264", "o automatico nunca usa AV1");
        assert.match(av1Line()!, new RegExp(`^AV1: codifica na placa sim \\(${AV1_SEND}\\), decodifica na placa sim, WebRtcAV1HWEncode nesta partida ligado; `
            + `sonda WebCodecs AV1: ok \\(${OK_DETAIL}\\); salva: ok em \\S+ \\(${CODEC}: ${OK_DETAIL}\\); AV1 fixado ligado \\(só com quem anuncia AV1 por hardware\\)$`));
        workers.restore();
        workers = null;
    });
});

describe("settleAv1: o resultado salvo deste ambiente, ou por que a sonda nao roda", () => {
    test("o WebRtcAV1HWEncode desligado nesta partida: nunca roda (nem com resultado salvo ok vale), e diz para reiniciar", () => {
        workers = installWorker(healthyProbe());
        setAv1HwFeature(false);
        try {
            assert.equal(settleAv1(NV_ENV, 0), null);
            assert.equal(getLocalCaps().av1ProbeOk, false);
            assert.match(av1Line()!, /WebRtcAV1HWEncode nesta partida desligado; sonda WebCodecs AV1: não feita \(o WebRtcAV1HWEncode não está ligado nesta partida do Discord; liga quando o Discord abrir com o AV1 fixado\)/);
            assert.match(av1Line()!, /AV1 fixado desligado \(vai o do automático\)$/);
            assert.equal(onCodecSettingChanged(), null);
            assert.equal(workers.instances.length, 0, "nenhum encoder AV1 criado");
            assert.equal(chooseCodec(BOTH, "av1").codec, "h264");
        } finally {
            setAv1HwFeature(true);
            workers.restore();
        }
        assert.equal(settleAv1(NV_ENV, 0), null, "de volta: o ok salvo vale sem rodar");
        assert.equal(getLocalCaps().av1ProbeOk, true);
    });

    test("salvo neste ambiente: vale sem rodar; de outro driver ou de outro nivel: roda de novo", async () => {
        workers = installWorker(healthyProbe());
        pluginSettings.set("hwAv1Probe", { at: AT, env: NV_ENV, verdict: "broken", detail: "x", codec: CODEC, source: "stream" });
        assert.equal(settleAv1(NV_ENV, 0), null);
        assert.equal(getLocalCaps().av1ProbeOk, false);
        assert.match(av1Line()!, /sonda WebCodecs AV1: travou \(feita em 02\/11 neste ambiente: x\) \[visto numa transmissão\]; salva: travou .* \[visto numa transmissão\]; AV1 fixado desligado/);
        assert.equal(workers.instances.length, 0);
        pluginSettings.set("hwAv1Probe", { at: 1, env: { ...NV_ENV, driver: "31.0.1" }, verdict: "broken", detail: "x", codec: CODEC });
        await settleAv1(NV_ENV, 0);
        assert.equal(workers.instances.length, 1, "outro driver: testa de novo");
        pluginSettings.set("hwAv1Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: "x", codec: "av01.0.08M.08" });
        await settleAv1(NV_ENV, 0);
        assert.equal(workers.instances.length, 2, "outro nivel: testa de novo");
        pluginSettings.set("hwAv1Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: "x", codec: "hvc1.1.6.L123.B0" });
        assert.equal(av1ProbeRecord()?.codec, null, "um codec que nao e AV1 (editado a mao): desconhecido");
        await settleAv1(NV_ENV, 0);
        assert.equal(av1ProbeRecord()?.codec, CODEC);
        workers.restore();
    });

    test("nao roda: o H.264 da placa desligado (a placa que trava nunca cria um encoder AV1), Baseline sem ok, sem Worker", () => {
        pluginSettings.set("hwAv1Probe", null);
        workers = installWorker(healthyProbe());
        setH264HwStuck(true);
        assert.equal(settleAv1(NV_ENV, 0), null);
        assert.match(av1Line()!, /não feita \(o H\.264 da placa está desligado neste PC, e o AV1 vai junto\)/);
        assert.equal(chooseCodec(BOTH, "av1").codec, "vp9", "nem fixado em AV1: a placa travada");
        setH264HwStuck(false);
        const baseline = pluginSettings.get("hwH264Probe");
        pluginSettings.set("hwH264Probe", { at: 1, env: NV_ENV, verdict: "unknown", detail: "x" });
        assert.equal(settleAv1(NV_ENV, 0), null);
        assert.match(av1Line()!, /não feita \(a sonda do H\.264 Baseline não deu ok neste ambiente; sem AV1 nesta sessão\)/);
        pluginSettings.set("hwH264Probe", baseline);
        assert.equal(workers.instances.length, 0);
        workers.restore();
        assert.equal(settleAv1(NV_ENV, 0), null);
        assert.match(av1Line()!, /não feita \(sem Worker\)/);
    });

    test("no automatico a sonda nunca roda; fixar o AV1 depois do inicio roda ela na hora; com uma transmissao no ar, quando ela acabar", async () => {
        pluginSettings.set("hwAv1Probe", null);
        pluginSettings.set("codec", "auto");
        workers = installWorker(healthyProbe());
        try {
            assert.equal(settleAv1(NV_ENV, 0), null);
            assert.match(av1Line()!, /sonda WebCodecs AV1: não feita \(só roda com o AV1 fixado no formato de vídeo\); AV1 fixado desligado \(o formato de vídeo não está em AV1\)$/);
            assert.equal(onCodecSettingChanged(), null, "o automatico: nada");
            pluginSettings.set("codec", "av1");
            await eventually(() => av1ProbeRecord()?.verdict === "ok");
            assert.equal(workers.instances.length, 1);

            pluginSettings.set("hwAv1Probe", null);
            noteStreamStarting(true);
            await onCodecSettingChanged();
            assert.match(av1Line()!, /não feita \(uma transmissão estava começando ou no ar/);
            noteStreamStarting(false);
            const run = onStreamStopped();
            assert.ok(run, "a transmissao acabou: roda");
            await run;
            assert.equal(workers.instances.length, 2);
            assert.equal(onStreamStopped(), null, "com resultado salvo: nada (nem roda)");
        } finally {
            noteStreamStarting(false);
            pluginSettings.set("codec", "av1");
            workers.restore();
        }
    });

    test("av1ProbeCodec: o nivel do level-idx do Chromium (dois digitos); sem ele, 08", () => {
        assert.equal(av1ProbeCodec(AV1_SEND), CODEC);
        assert.equal(av1ProbeCodec("level-idx=13;profile=0"), "av01.0.13M.08");
        assert.equal(av1ProbeCodec("profile=0"), "av01.0.08M.08");
        assert.equal(av1ProbeCodec(null), "av01.0.08M.08");
    });
});

describe("runAv1Probe", () => {
    test("enquanto roda, segura o H.264 da placa (VP9: nenhum encoder da placa no WebRTC ao lado do dela); uma segunda chamada nao abre outra", async () => {
        pluginSettings.set("hwAv1Probe", null);
        let held: FakeWorker | null = null;
        workers = installWorker(w => {
            held = w;
        });
        const run = runAv1Probe(NV_ENV, CODEC, 0);
        await eventually(() => held);
        assert.equal(getLocalCaps().h264HwEncode, false, "segurado");
        assert.equal(chooseCodec(BOTH, "auto").codec, "vp9");
        assert.match(av1Line()!, /sonda WebCodecs AV1: rodando/);
        await runAv1Probe(NV_ENV, CODEC, 0);
        assert.equal(workers.instances.length, 1);
        healthyProbe()(held!, null);
        await run;
        assert.equal(getLocalCaps().h264HwEncode, true, "solto");
        workers.restore();
    });

    test("o H.264 da placa desligado na hora de rodar, ou uma transmissao comecando: nao roda", async () => {
        pluginSettings.set("hwAv1Probe", null);
        workers = installWorker(healthyProbe());
        setH264HwStuck(true);
        await runAv1Probe(NV_ENV, CODEC, 0);
        setH264HwStuck(false);
        assert.match(av1Line()!, /não feita \(o H\.264 da placa está desligado neste PC, e o AV1 vai junto\)/);
        noteStreamStarting(true);
        try {
            await runAv1Probe(NV_ENV, CODEC, 0);
        } finally {
            noteStreamStarting(false);
        }
        assert.equal(workers.instances.length, 0);
        workers.restore();
    });

    test("a placa sem AV1 (o libaom nao passa em prefer-hardware): inconclusiva, nada salvo, sem AV1 nesta sessao, o H.264 continua", async () => {
        workers = installWorker(w => w.emit({ ev: "done", verdict: "unsupported" }));
        await runAv1Probe(NV_ENV, CODEC, 0);
        assert.equal(av1ProbeRecord(), null);
        assert.equal(getLocalCaps().av1ProbeOk, false);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.match(av1Line()!, /inconclusiva \(sem suporte: a placa não aceita av01\.0\.05M\.08\)/);
        assert.equal(chooseCodec(BOTH, "av1").codec, "h264");
        workers.restore();
    });

    test("travou na 1a e passou na 2a: ok, salvo", async () => {
        workers = workersFor(stuckProbe(), healthyProbe());
        await runAv1Probe(NV_ENV, CODEC, 0);
        assert.equal(workers.instances.length, 2, "a 2a rodada confirma");
        assert.equal(av1ProbeRecord()?.verdict, "ok");
        assert.equal(chooseCodec(BOTH, "av1").codec, "av1");
        workers.restore();
    });

    test("travou duas vezes: salvo por ambiente, AV1 desligado, VP9 so nesta sessao; o H.264 nao fica marcado", async () => {
        pluginSettings.set("hwAv1Probe", null);
        workers = installWorker(stuckProbe());
        const since = logMark();
        await runAv1Probe(NV_ENV, CODEC, 0);
        const detail = `${STUCK}; confirmado na 2ª rodada`;
        assert.deepEqual({ ...av1ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "broken", detail, codec: CODEC });
        assert.equal(stuckRecord(), null);
        assert.equal(getLocalCaps().h264HwEncode, false, "nesta sessao: VP9");
        assert.ok(since().includes(`warn: A sonda WebCodecs do AV1 (${CODEC}) travou neste PC (${detail}): o AV1 fica desligado neste ambiente (só o H.264) e, `
            + "com um encoder preso na placa de vídeo, o automático vai em VP9 nesta sessão"));
        workers.restore();
        setH264HwStuck(false);
        assert.equal(settleAv1(NV_ENV, 0), null, "na proxima abertura: vale sem rodar");
        assert.equal(chooseCodec(BOTH, "av1").h264Profile, "640032", "o High do automatico");
    });

    test("travou e uma transmissao comecou antes da confirmacao, ou a 2a inconclusiva: nada salvo, VP9 nesta sessao", async () => {
        pluginSettings.set("hwAv1Probe", null);
        workers = installWorker((w, data) => {
            stuckProbe()(w, data);
            noteStreamStarting(true);
        });
        try {
            await runAv1Probe(NV_ENV, CODEC, 0);
        } finally {
            noteStreamStarting(false);
        }
        assert.equal(av1ProbeRecord(), null);
        assert.ok(av1Line()!.includes("sem confirmar (uma transmissão começou): VP9 nesta sessão"));
        workers.restore();
        setH264HwStuck(false);
        workers = workersFor(stuckProbe(), w => w.emit({ ev: "done", verdict: "unsupported" }));
        await runAv1Probe(NV_ENV, CODEC, 0);
        assert.equal(av1ProbeRecord(), null);
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.ok(av1Line()!.includes("a 2ª rodada não conseguiu dizer"));
        workers.restore();
        setH264HwStuck(false);
    });
});

describe("falhas no ar e o botao", () => {
    test("noteAv1Failed (o libaom assumiu, ou o WebRTC trocou): travou salvo para o AV1 (source stream), o AV1 sai agora; nada do H.264", async () => {
        pluginSettings.set("hwAv1Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: "x", codec: CODEC });
        settleAv1(NV_ENV, 0);
        assert.equal(chooseCodec(BOTH, "av1").codec, "av1");
        noteAv1Failed("o AV1 para X saiu da placa (libaom)");
        assert.equal(chooseCodec(BOTH, "av1").codec, "h264");
        await eventually(() => av1ProbeRecord()?.verdict === "broken");
        assert.deepEqual({ ...av1ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "broken", detail: "o AV1 para X saiu da placa (libaom)", codec: CODEC, source: "stream" });
        assert.equal(stuckRecord(), null);
        assert.equal(getLocalCaps().h264HwEncode, true, "o H.264 da placa continua");
    });

    test("noteStuckEncoder de um envio em AV1: VP9 nesta sessao, o AV1 marcado, sem o registro permanente do H.264", async () => {
        pluginSettings.set("hwAv1Probe", null);
        noteStuckEncoder(null, "av1");
        assert.equal(getLocalCaps().h264HwEncode, false);
        await eventually(() => av1ProbeRecord()?.verdict === "broken");
        assert.equal(av1ProbeRecord()?.detail, "o encoder da placa de vídeo travou numa transmissão em AV1");
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(stuckRecord(), null, "o H.264 nao leva a culpa");
    });

    test("\"Tentar a placa de vídeo de novo\" nunca esquece o travou do AV1; esquece um ok", () => {
        assert.equal(forgetStuckEncoder(), "restart");
        assert.equal(av1ProbeRecord()?.verdict, "broken", "o travou do AV1 fica");
        pluginSettings.set("hwAv1Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: "x", codec: CODEC });
        forgetStuckEncoder();
        assert.equal(av1ProbeRecord(), null, "o ok e esquecido");
        assert.equal(getLocalCaps().av1ProbeOk, false);
    });
});
