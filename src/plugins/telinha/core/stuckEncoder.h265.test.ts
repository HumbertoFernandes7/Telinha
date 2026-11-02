/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A rede de seguranca do H.265 (core/stuckEncoder.ts → settleH265 / runH265Probe / noteH265Failed), num PC com NVIDIA
// que codifica e decodifica 42001f, 640032 e H.265 Main na placa (a sonda de codecs falsa, com o fmtp do Chrome 156). A
// sonda WebCodecs do H.265 (hvc1.1.6.L123.B0, sobre um Worker falso) so roda depois das do Baseline e do High, segura o
// H.264 da placa enquanto roda, confirma um "travou" com uma 2a rodada (um Worker preso conta como travou), e o resultado
// fica salvo por ambiente (hwH265Probe). Um envio em H.265 que falha marca o H.265, nunca o H.264. Estado do modulo e do
// processo: a ordem importa.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.h265.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getEventLog, type TelinhaEvent } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities, type WebRtcEnv } from "@test/fakes/webrtc";
import { type FakeWorker, healthyProbe, installWorker, stuckProbe, type WorkerEnv } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps, setH264HwStuck } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import {
    type EncoderEnv, forgetStuckEncoder, h265ProbeCodec, h265ProbeRecord, noteH265Failed, noteStreamStarting, noteStuckEncoder, onCodecSettingChanged, onStreamStopped, PROBE_START, probeRecord,
    runH265Probe, settleH265, startLocalCaps, stuckEncoderDiagnostics, stuckRecord
} from "./stuckEncoder";

const NV_ENV: EncoderEnv = { vendorId: "10de", deviceId: "2484", driver: "32.0.16.2101", chrome: "152.0.7977.167", discord: "1.0.9266" };
const H265_SEND = "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST";
const CODEC = "hvc1.1.6.L123.B0";
const h264 = (profile: string): RTCRtpCodec => ({ mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}` });
/** Espectadores: com H.265 e High na placa, e um da v0.3.3 (so High). */
const BOTH = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };
const V033 = { h264HwDecode: true, hwDecode: { v: 1, h264High: true } };
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
const h265Line = () => stuckEncoderDiagnostics().split("\n").find(l => l.startsWith("H.265: "));

before(() => {
    rtc = installWebRtc();
    const video = [...DEFAULT_VIDEO_CODECS, h264("640032"), { mimeType: "video/H265", clockRate: 90000, sdpFmtpLine: H265_SEND }];
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video };
    rtc.mediaCapabilities.hwEncode = ["42001f", "640032", "h265"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "640032", "h265"];
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x10de, deviceId: 0x2484, driverVersion: NV_ENV.driver, chrome: NV_ENV.chrome, discord: NV_ENV.discord, error: null })
    });
    // o H.265 e so manual: a sonda dele so roda com ele fixado
    pluginSettings.load({ codec: "h265" });
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
    test("Baseline, High e H.265 (hvc1.1.6.L123.B0, Main, annexb), uma depois da outra: ok as tres, H.265 so com quem anuncia H.265", async () => {
        workers = installWorker(healthyProbe());
        const lines: string[] = [];
        const since = logMark();
        await startLocalCaps(line => lines.push(line));
        await eventually(() => lines.length === 1);
        assert.deepEqual(workers.instances.map(w => configOf(w).codec), ["avc1.42001f", "avc1.640032", CODEC]);
        assert.deepEqual(configOf(workers.instances[2]), {
            codec: CODEC, width: 1280, height: 720, framerate: 30, bitrate: 2_000_000, hardwareAcceleration: "prefer-hardware", latencyMode: "realtime", hevc: { format: "annexb" }
        });
        assert.ok(workers.instances.every(w => w.terminated));
        assert.match(lines[0], new RegExp(`H\\.265 por hardware — decodifica: sim, codifica: sim \\(${H265_SEND}\\); placa de vídeo 10de:2484, `));
        assert.ok(lines[0].endsWith(`; sonda WebCodecs H.264 High: ok (${OK_DETAIL}); sonda WebCodecs H.265: ok (${OK_DETAIL})`), lines[0]);
        assert.deepEqual({ ...h265ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "ok", detail: OK_DETAIL, codec: CODEC });
        assert.ok(since().includes(`info: Sonda WebCodecs do H.265 (${CODEC}) da placa de vídeo: ok (${OK_DETAIL}); com o H.265 fixado, vai H.265 para quem também decodifica H.265 por hardware`));

        assert.equal(getLocalCaps().h265ProbeOk, true);
        assert.deepEqual({ ...chooseCodec(BOTH, "h265"), reason: "" }, { codec: "h265", h264Profile: "640032", h264Backup: "42001f", reason: "" });
        assert.equal(chooseCodec(V033, "auto").h264Profile, "640032", "espectador na v0.3.3: o High de antes");
        assert.match(h265Line()!, new RegExp(`^H\\.265: codifica na placa sim \\(${H265_SEND}\\), decodifica na placa sim, envia sim; sonda WebCodecs H\\.265: ok \\(${OK_DETAIL}\\); `
            + `salva: ok em \\S+ \\(${CODEC}: ${OK_DETAIL}\\); H\\.265 fixado ligado \\(só com quem anuncia H\\.265 por hardware\\)$`));
        workers.restore();
        workers = null;
    });
});

describe("settleH265: o resultado salvo deste ambiente, ou por que a sonda nao roda", () => {
    test("salvo neste ambiente: vale sem rodar; de outro driver ou de outro nivel: roda de novo", async () => {
        workers = installWorker(healthyProbe());
        assert.equal(settleH265(NV_ENV, 0), null);
        assert.equal(getLocalCaps().h265ProbeOk, true);
        pluginSettings.set("hwH265Probe", { at: AT, env: NV_ENV, verdict: "broken", detail: "x", codec: CODEC, source: "stream" });
        assert.equal(settleH265(NV_ENV, 0), null);
        assert.equal(getLocalCaps().h265ProbeOk, false);
        assert.match(h265Line()!, /sonda WebCodecs H\.265: travou \(feita em 02\/11 neste ambiente: x\) \[visto numa transmissão\]; salva: travou .* H\.265 fixado desligado$/);
        assert.equal(chooseCodec(BOTH, "auto").codec, "h264", "o H.265 travado: o High");
        assert.equal(workers.instances.length, 0);

        pluginSettings.set("hwH265Probe", { at: 1, env: { ...NV_ENV, driver: "31.0.1" }, verdict: "broken", detail: "x", codec: CODEC });
        await settleH265(NV_ENV, 0);
        assert.equal(workers.instances.length, 1, "outro driver: testa de novo");
        pluginSettings.set("hwH265Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: "x", codec: "hvc1.1.6.L120.B0" });
        await settleH265(NV_ENV, 0);
        assert.equal(workers.instances.length, 2, "outro nivel: testa de novo");
        assert.equal(h265ProbeRecord()?.codec, CODEC);
        workers.restore();
    });

    test("nao roda: o H.264 da placa desligado (a placa AMD que trava nunca cria um encoder H.265), Baseline sem ok, sem Worker", () => {
        pluginSettings.set("hwH265Probe", null);
        workers = installWorker(healthyProbe());
        setH264HwStuck(true);
        assert.equal(settleH265(NV_ENV, 0), null);
        assert.match(h265Line()!, /não feita \(o H\.264 da placa está desligado neste PC, e o H\.265 vai junto\)/);
        assert.equal(chooseCodec(BOTH, "auto").codec, "vp9", "a placa travada: nem H.265 nem H.264");
        assert.equal(chooseCodec(BOTH, "h265").codec, "vp9", "nem fixado em H.265");
        setH264HwStuck(false);
        const baseline = pluginSettings.get("hwH264Probe");
        pluginSettings.set("hwH264Probe", { at: 1, env: NV_ENV, verdict: "unknown", detail: "x" });
        assert.equal(settleH265(NV_ENV, 0), null);
        assert.match(h265Line()!, /não feita \(a sonda do H\.264 Baseline não deu ok neste ambiente; sem H\.265 nesta sessão\)/);
        pluginSettings.set("hwH264Probe", baseline);
        assert.equal(workers.instances.length, 0);
        workers.restore();
        assert.equal(settleH265(NV_ENV, 0), null);
        assert.match(h265Line()!, /não feita \(sem Worker\)/);
    });

    test("no automatico (o H.265 nao fixado) a sonda nunca roda; fixar o H.265 depois do inicio roda ela na hora", async () => {
        pluginSettings.set("hwH265Probe", null);
        pluginSettings.set("codec", "auto");
        workers = installWorker(healthyProbe());
        try {
            assert.equal(settleH265(NV_ENV, 0), null);
            assert.match(h265Line()!, /sonda WebCodecs H\.265: não feita \(só roda com o H\.265 fixado no formato de vídeo\)/);
            assert.equal(onCodecSettingChanged(), null, "o automatico: nada");
            assert.equal(workers.instances.length, 0, "nenhum encoder H.265 criado");
            // o onChange da opcao (settings.ts) chama onCodecSettingChanged: a sonda roda na hora
            pluginSettings.set("codec", "h265");
            assert.equal(onCodecSettingChanged(), null, "ja rodando: nao abre outra");
            await eventually(() => h265ProbeRecord()?.verdict === "ok");
            assert.equal(workers.instances.length, 1);
            assert.equal(h265ProbeRecord()?.verdict, "ok");
            assert.equal(chooseCodec(BOTH, "h265").codec, "h265");
            assert.equal(chooseCodec(BOTH, "auto").codec, "h264", "o automatico nunca usa H.265, nem com a sonda ok");
        } finally {
            pluginSettings.set("codec", "h265");
            workers.restore();
        }
    });

    test("fixado com uma transmissao no ar: a sonda espera e roda quando ela acabar (onStreamStopped)", async () => {
        pluginSettings.set("hwH265Probe", null);
        pluginSettings.set("codec", "auto");
        workers = installWorker(healthyProbe());
        try {
            noteStreamStarting(true);
            pluginSettings.set("codec", "h265");
            await eventually(() => /não feita \(uma transmissão estava começando ou no ar/.test(h265Line()!));
            assert.equal(workers.instances.length, 0, "nada com a transmissao no ar");
            noteStreamStarting(false);
            const run = onStreamStopped();
            assert.ok(run, "a transmissao acabou: roda");
            await run;
            assert.equal(workers.instances.length, 1);
            assert.equal(h265ProbeRecord()?.verdict, "ok");
            assert.equal(onStreamStopped(), null, "com resultado salvo: nada");
            pluginSettings.set("codec", "auto");
            pluginSettings.set("hwH265Probe", null);
            assert.equal(onStreamStopped(), null, "sem o H.265 fixado: nada");
        } finally {
            noteStreamStarting(false);
            // um ok salvo antes de voltar ao H.265: o onChange nao abre outra sonda (o proximo teste conta os Workers)
            pluginSettings.set("hwH265Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: OK_DETAIL, codec: CODEC });
            pluginSettings.set("codec", "h265");
            workers.restore();
        }
    });

    test("h265ProbeCodec: o nivel do level-id do Chromium; sem ele, L120", () => {
        assert.equal(h265ProbeCodec(H265_SEND), CODEC);
        assert.equal(h265ProbeCodec("profile-id=1"), "hvc1.1.6.L120.B0");
        assert.equal(h265ProbeCodec(null), "hvc1.1.6.L120.B0");
    });
});

describe("runH265Probe", () => {
    test("enquanto roda, segura o H.264 da placa (VP9: nenhum encoder da placa no WebRTC ao lado do dela); uma segunda chamada nao abre outra", async () => {
        pluginSettings.set("hwH265Probe", null);
        let held: FakeWorker | null = null;
        workers = installWorker(w => {
            held = w;
        });
        const run = runH265Probe(NV_ENV, CODEC, 0);
        await eventually(() => held);
        assert.equal(getLocalCaps().h264HwEncode, false, "segurado");
        assert.equal(chooseCodec(BOTH, "auto").codec, "vp9");
        assert.match(h265Line()!, /sonda WebCodecs H\.265: rodando/);
        await runH265Probe(NV_ENV, CODEC, 0);
        assert.equal(workers.instances.length, 1);
        healthyProbe()(held!, null);
        await run;
        assert.equal(getLocalCaps().h264HwEncode, true, "solto");
        assert.equal(chooseCodec(BOTH, "h265").codec, "h265");
        workers.restore();
    });

    test("uma transmissao comecando: nao roda (nunca no inicio de uma transmissao)", async () => {
        pluginSettings.set("hwH265Probe", null);
        workers = installWorker(healthyProbe());
        noteStreamStarting(true);
        try {
            await runH265Probe(NV_ENV, CODEC, 0);
        } finally {
            noteStreamStarting(false);
        }
        assert.equal(workers.instances.length, 0);
        assert.match(h265Line()!, /não feita \(uma transmissão estava começando ou no ar; tenta de novo na próxima vez que o Discord abrir\)/);
        assert.equal(h265ProbeRecord(), null);
        workers.restore();
    });

    test("o H.264 da placa desligado na hora de rodar: nao roda", async () => {
        pluginSettings.set("hwH265Probe", null);
        workers = installWorker(healthyProbe());
        setH264HwStuck(true);
        await runH265Probe(NV_ENV, CODEC, 0);
        setH264HwStuck(false);
        assert.equal(workers.instances.length, 0);
        assert.match(h265Line()!, /não feita \(o H\.264 da placa está desligado neste PC, e o H\.265 vai junto\)/);
        workers.restore();
    });

    test("travou uma vez e uma transmissao comecou antes da confirmacao: nada salvo, VP9 nesta sessao", async () => {
        pluginSettings.set("hwH265Probe", null);
        workers = installWorker((w, data) => {
            stuckProbe()(w, data);
            noteStreamStarting(true);
        });
        try {
            await runH265Probe(NV_ENV, CODEC, 0);
        } finally {
            noteStreamStarting(false);
        }
        assert.equal(workers.instances.length, 1);
        assert.equal(h265ProbeRecord(), null);
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.ok(h265Line()!.includes(`travou uma vez (${STUCK}), sem confirmar (uma transmissão começou): VP9 nesta sessão`));
        workers.restore();
        setH264HwStuck(false);
    });

    test("inconclusiva sem nada preso (a placa nao aceita o hvc1): nada salvo, sem H.265 nesta sessao, o H.264 continua", async () => {
        workers = installWorker(w => w.emit({ ev: "done", verdict: "unsupported" }));
        await runH265Probe(NV_ENV, CODEC, 0);
        assert.equal(h265ProbeRecord(), null);
        assert.equal(getLocalCaps().h265ProbeOk, false);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.match(h265Line()!, new RegExp(`inconclusiva \\(sem suporte: a placa não aceita ${CODEC.replace(/\./g, "\\.")}\\)`));
        assert.equal(chooseCodec(BOTH, "auto").h264Profile, "640032");
        workers.restore();
    });

    test("travou na 1a e passou na 2a: ok, salvo; o preso da 1a fica", async () => {
        workers = workersFor(stuckProbe(), healthyProbe());
        await runH265Probe(NV_ENV, CODEC, 0);
        assert.equal(workers.instances.length, 2, "a 2a rodada confirma");
        assert.equal(workers.instances[0].terminated, false);
        assert.deepEqual({ ...h265ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "ok", detail: `${OK_DETAIL} (a 1ª rodada tinha travado: ${STUCK})`, codec: CODEC });
        assert.equal(chooseCodec(BOTH, "h265").codec, "h265");
        workers.restore();
    });

    test("travou duas vezes: salvo por ambiente, H.265 desligado, VP9 so nesta sessao; o H.264 nao fica marcado", async () => {
        pluginSettings.set("hwH265Probe", null);
        workers = installWorker(stuckProbe());
        const since = logMark();
        await runH265Probe(NV_ENV, CODEC, 0);
        const detail = `${STUCK}; confirmado na 2ª rodada`;
        assert.deepEqual({ ...h265ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "broken", detail, codec: CODEC });
        assert.deepEqual(workers.instances.map(w => w.terminated), [false, false], "nunca terminados");
        assert.equal(stuckRecord(), null, "o H.264 nao fica marcado como travado");
        assert.equal(probeRecord()?.verdict, "ok");
        assert.equal(getLocalCaps().h264HwEncode, false, "nesta sessao: VP9");
        assert.ok(since().includes(`warn: A sonda WebCodecs do H.265 (${CODEC}) travou neste PC (${detail}): o H.265 fica desligado neste ambiente (só o H.264) e, `
            + "com um encoder preso na placa de vídeo, o automático vai em VP9 nesta sessão"));
        workers.restore();
        setH264HwStuck(false);
        assert.equal(settleH265(NV_ENV, 0), null, "na proxima abertura: vale sem rodar");
        assert.equal(chooseCodec(BOTH, "auto").h264Profile, "640032", "o High de antes");
    });

    test("Worker preso (um passo sem resposta) duas vezes: vale como travou", async () => {
        pluginSettings.set("hwH265Probe", null);
        workers = installWorker(w => w.emit({ ev: "phase", phase: "isConfigSupported" }));
        await runH265Probe(NV_ENV, CODEC, 0);
        assert.equal(h265ProbeRecord()?.verdict, "broken");
        assert.equal(h265ProbeRecord()?.detail, "isConfigSupported sem resposta em 0.04 s; confirmado na 2ª rodada");
        assert.deepEqual(workers.instances.map(w => w.terminated), [false, false]);
        workers.restore();
        setH264HwStuck(false);
    });

    test("travou e a 2a e inconclusiva sem nada preso: nada salvo, VP9 nesta sessao", async () => {
        pluginSettings.set("hwH265Probe", null);
        workers = workersFor(stuckProbe(), w => w.emit({ ev: "done", verdict: "unsupported" }));
        await runH265Probe(NV_ENV, CODEC, 0);
        assert.equal(h265ProbeRecord(), null);
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.ok(h265Line()!.includes(`travou uma vez (${STUCK}); a 2ª rodada não conseguiu dizer`));
        workers.restore();
        setH264HwStuck(false);
    });
});

describe("falhas no ar e o botao", () => {
    test("noteH265Failed: travou salvo para o H.265 (source stream), o H.265 sai agora; nada do H.264", async () => {
        pluginSettings.set("hwH265Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: "x", codec: CODEC });
        settleH265(NV_ENV, 0);
        assert.equal(chooseCodec(BOTH, "h265").codec, "h265");
        noteH265Failed("o WebRTC trocou o H.265 por H264");
        assert.equal(chooseCodec(BOTH, "auto").codec, "h264");
        await eventually(() => h265ProbeRecord()?.verdict === "broken");
        assert.deepEqual({ ...h265ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "broken", detail: "o WebRTC trocou o H.265 por H264", codec: CODEC, source: "stream" });
        assert.equal(stuckRecord(), null);
        assert.equal(getLocalCaps().h264HwEncode, true, "o H.264 da placa continua");
    });

    test("noteStuckEncoder de um envio em H.265: VP9 nesta sessao, o H.265 marcado, sem o registro permanente do H.264", async () => {
        pluginSettings.set("hwH265Probe", null);
        noteStuckEncoder(null, "h265");
        assert.equal(getLocalCaps().h264HwEncode, false);
        await eventually(() => h265ProbeRecord()?.verdict === "broken");
        assert.equal(h265ProbeRecord()?.detail, "o encoder da placa de vídeo travou numa transmissão em H.265");
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(stuckRecord(), null, "o H.264 nao leva a culpa");
    });

    test("\"Tentar a placa de vídeo de novo\" nunca esquece o travou do H.265; esquece um ok", async () => {
        assert.equal(forgetStuckEncoder(), "restart", "travou nesta sessao: so depois de reiniciar");
        assert.equal(h265ProbeRecord()?.verdict, "broken", "o travou do H.265 fica");
        pluginSettings.set("hwH265Probe", { at: AT, env: NV_ENV, verdict: "ok", detail: "x", codec: CODEC });
        forgetStuckEncoder();
        assert.equal(h265ProbeRecord(), null, "o ok e esquecido (a sonda roda de novo depois da do Baseline)");
        assert.equal(getLocalCaps().h265ProbeOk, false);
    });
});
