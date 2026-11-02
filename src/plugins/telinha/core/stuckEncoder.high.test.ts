/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da rede de seguranca do H.264 High (core/stuckEncoder.ts → settleHigh / runHighProbe), num PC com NVIDIA que
// codifica e decodifica 42001f e 640032 na placa (a sonda de codecs falsa). A sonda WebCodecs do High (avc1.640032, sobre
// um Worker falso) so roda depois da do Baseline dizer "ok" neste ambiente, uma rodada so, e o resultado fica salvo
// (hwH264HighProbe) como o do Baseline: ok liga o High; inconclusiva nao salva nada e fica sem High na sessao; travou
// salva, desliga o High neste ambiente e manda VP9 nesta sessao (um encoder H.264 ficou preso na placa). Com o H.264 da
// placa desligado (travou, sonda rodando, quedas) o High nunca vai. Estado do modulo e do processo: a ordem importa.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.high.test.ts  (todos: pnpm test:unit)

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
    type EncoderEnv, forgetStuckEncoder, highProbeRecord, noteStreamStarting, PROBE_START, probeRecord, runHighProbe, settleHigh, startLocalCaps,
    stuckEncoderDiagnostics, stuckRecord
} from "./stuckEncoder";

/** Uma RTX 3070 com o driver de 31/10. */
const NV_ENV: EncoderEnv = { vendorId: "10de", deviceId: "2484", driver: "32.0.15.6094", chrome: "152.0.7977.167", discord: "1.0.9266" };
const h264 = (mode: 0 | 1, profile: string): RTCRtpCodec => ({
    mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`
});
/** Espectador com High na placa (presenca caps.hwDecode) e um da v0.3.1 (so o booleano). */
const HIGH_VIEWER = { h264HwDecode: true, hwDecode: { v: 1, h264High: true } };
const OLD_VIEWER = { h264HwDecode: true };
const OK_DETAIL = "30 pacotes de 30 quadros";
/** 02/11 (hora local) */
const AT = new Date(2026, 10, 2, 10, 0).getTime();

let rtc: WebRtcEnv;
let native: NativeEnv;
let workers: WorkerEnv | null = null;
const timing = { ...ENCODER_PROBE_TIMING };

function logMark() {
    const seen = new Set<TelinhaEvent>(getEventLog());
    return () => getEventLog().filter(e => !seen.has(e)).map(e => `${e.level}: ${e.msg}`);
}

/** Um Worker por rodada: o roteiro `scripts[n]` na n-esima (o ultimo vale para as seguintes). */
function workersFor(...scripts: NonNullable<WorkerEnv["script"]>[]) {
    let n = 0;
    return installWorker((w, data) => scripts[Math.min(n++, scripts.length - 1)](w, data));
}

const codecOf = (w: FakeWorker) => (w.posted[0] as { config: { codec: string; }; }).config.codec;
const highLine = () => stuckEncoderDiagnostics().split("\n").find(l => l.startsWith("H.264 High: "));

before(() => {
    rtc = installWebRtc();
    const video = [...DEFAULT_VIDEO_CODECS, h264(1, "640032"), h264(0, "640032")];
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video };
    rtc.mediaCapabilities.hwEncode = ["42001f", "640032"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "640032"];
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x10de, deviceId: 0x2484, driverVersion: NV_ENV.driver, chrome: NV_ENV.chrome, discord: NV_ENV.discord, error: null })
    });
    pluginSettings.load({});
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
    test("a sonda do Baseline e, logo depois, a do High (avc1.640032): ok as duas, High ligado so com quem anuncia High", async () => {
        workers = installWorker(healthyProbe());
        const lines: string[] = [];
        const since = logMark();
        await startLocalCaps(line => lines.push(line));
        await eventually(() => lines.length === 1);
        assert.deepEqual(workers.instances.map(codecOf), ["avc1.42001f", "avc1.640032"]);
        assert.ok(workers.instances.every(w => w.terminated), "terminaram normalmente");
        assert.match(lines[0], /; envia: .*; H\.264 High por hardware — decodifica: sim, codifica: sim \(perfil 640032\); placa de vídeo 10de:2484, /);
        assert.ok(lines[0].endsWith(`; sonda WebCodecs H.264 placa: ok (${OK_DETAIL}); sonda WebCodecs H.264 High: ok (${OK_DETAIL})`), lines[0]);
        assert.equal(probeRecord()?.verdict, "ok");
        assert.deepEqual({ ...highProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "ok", detail: OK_DETAIL, profile: "640032" });
        assert.ok(since().includes(`info: Sonda WebCodecs do H.264 High (perfil 640032) da placa de vídeo: ok (${OK_DETAIL}); o automático manda High para quem também decodifica High por hardware`));

        const caps = getLocalCaps();
        assert.equal(caps.h264HwEncode, true);
        assert.equal(caps.h264HighProbeOk, true);
        assert.deepEqual(chooseCodec(HIGH_VIEWER, "auto"), {
            codec: "h264", h264Profile: "640032", h264Backup: "42001f",
            reason: "automático: H.264 High por hardware nos dois lados (perfil 640032: este PC codifica High na placa, com a sonda do High ok, e o espectador decodifica High na placa; reserva 42001f)"
        });
        assert.equal(chooseCodec(OLD_VIEWER, "auto").h264Profile, "42001f", "espectador na v0.3.1: o Baseline de sempre");
        assert.equal(chooseCodec(HIGH_VIEWER, "h264").h264Profile, "42001f", "fixado em H.264: o Baseline de sempre");
        assert.equal(chooseCodec(HIGH_VIEWER, "vp9").codec, "vp9");
        assert.match(highLine()!, new RegExp(`^H\\.264 High: codifica na placa sim \\(perfil 640032\\), decodifica na placa sim; sonda WebCodecs High: ok \\(${OK_DETAIL}\\); `
            + `salva: ok em \\S+ \\(perfil 640032: ${OK_DETAIL}\\); High automático ligado \\(só com quem anuncia High por hardware\\)$`));
        workers.restore();
        workers = null;
    });
});

describe("settleHigh: o resultado salvo deste ambiente, ou por que a sonda nao roda", () => {
    test("salvo neste ambiente: vale sem rodar (ok liga, travou desliga); de outro driver: roda de novo", async () => {
        workers = installWorker(healthyProbe());
        assert.equal(settleHigh(NV_ENV, 0), null, "ok salvo neste ambiente");
        assert.equal(getLocalCaps().h264HighProbeOk, true);
        pluginSettings.set("hwH264HighProbe", { at: AT, env: NV_ENV, verdict: "broken", detail: "x", profile: "640032" });
        assert.equal(settleHigh(NV_ENV, 0), null);
        assert.equal(getLocalCaps().h264HighProbeOk, false);
        assert.match(highLine()!, /sonda WebCodecs High: travou \(feita em 02\/11 neste ambiente: x\); salva: travou em .* High automático desligado$/);
        assert.equal(workers.instances.length, 0);

        // o High salvo e de outro driver (o Baseline ok e deste): a sonda do High roda de novo
        pluginSettings.set("hwH264HighProbe", { at: 1, env: { ...NV_ENV, driver: "31.0.1" }, verdict: "ok", detail: "x", profile: "640032" });
        await settleHigh(NV_ENV, 0);
        assert.equal(workers.instances.length, 1);
        assert.equal(getLocalCaps().h264HighProbeOk, true);
        assert.deepEqual(highProbeRecord()?.env, NV_ENV);
        workers.restore();
    });

    test("nao roda: H.264 da placa desligado (a placa travou neste PC), Baseline sem ok neste ambiente, sem Worker", async () => {
        pluginSettings.set("hwH264HighProbe", null);
        workers = installWorker(healthyProbe());
        setH264HwStuck(true);
        assert.equal(settleHigh(NV_ENV, 0), null);
        assert.equal(getLocalCaps().h264HighProbeOk, false);
        assert.match(highLine()!, /sonda WebCodecs High: não feita \(o H\.264 da placa está desligado neste PC\)/);
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").codec, "vp9", "a placa travada: nem High nem Baseline");
        setH264HwStuck(false);

        const baseline = pluginSettings.get("hwH264Probe");
        pluginSettings.set("hwH264Probe", { at: 1, env: NV_ENV, verdict: "unknown", detail: "x" });
        assert.equal(settleHigh(NV_ENV, 0), null);
        assert.match(highLine()!, /não feita \(a sonda do H\.264 Baseline não deu ok neste ambiente; sem High nesta sessão\)/);
        pluginSettings.set("hwH264Probe", { at: 1, env: { ...NV_ENV, driver: "31.0.1" }, verdict: "ok", detail: "x" });
        assert.equal(settleHigh(NV_ENV, 0), null, "o ok do Baseline e de outro driver");
        pluginSettings.set("hwH264Probe", baseline);
        assert.equal(workers.instances.length, 0);
        workers.restore();

        assert.equal(settleHigh(NV_ENV, 0), null);
        assert.match(highLine()!, /não feita \(sem Worker\)/);
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").h264Profile, "42001f", "sem a sonda do High: o Baseline");
    });
});

describe("runHighProbe", () => {
    test("enquanto roda: o Baseline vale (nunca espera pela do High), o High nao; uma segunda chamada nao abre outra", async () => {
        let held: FakeWorker | null = null;
        workers = installWorker(w => {
            held = w;
        });
        const run = runHighProbe(NV_ENV, "640032", 0);
        await eventually(() => held);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(getLocalCaps().h264HighProbeOk, false);
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").reason, "automático: H.264 por hardware nos dois lados (perfil 42001f; High não: a sonda WebCodecs do High não passou neste PC)");
        assert.match(highLine()!, /sonda WebCodecs High: rodando/);
        await runHighProbe(NV_ENV, "640032", 0);
        assert.equal(workers.instances.length, 1);
        healthyProbe()(held!, null);
        await run;
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").h264Profile, "640032");
        workers.restore();
    });

    test("inconclusiva (a placa nao aceita avc1.640032): nada salvo, sem High nesta sessao, o Baseline continua", async () => {
        pluginSettings.set("hwH264HighProbe", null);
        workers = installWorker(w => w.emit({ ev: "done", verdict: "unsupported" }));
        const since = logMark();
        await runHighProbe(NV_ENV, "640032", 0);
        assert.equal(highProbeRecord(), null, "inconclusiva nunca e salva");
        assert.equal(getLocalCaps().h264HighProbeOk, false);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").h264Profile, "42001f");
        assert.deepEqual(since(), ["info: Sonda WebCodecs do H.264 High (perfil 640032) da placa de vídeo: inconclusiva (sem suporte: a placa não aceita avc1.640032); "
            + "sem High nesta sessão (o Baseline continua), e ela roda de novo na próxima vez que o Discord abrir"]);
        workers.restore();
    });

    test("uma transmissao comecando, ou o H.264 da placa desligado: nao roda", async () => {
        workers = installWorker(healthyProbe());
        noteStreamStarting(true);
        try {
            await runHighProbe(NV_ENV, "640032", 0);
        } finally {
            noteStreamStarting(false);
        }
        assert.match(highLine()!, /não feita \(uma transmissão estava começando ou no ar; tenta de novo na próxima vez que o Discord abrir\)/);
        setH264HwStuck(true);
        await runHighProbe(NV_ENV, "640032", 0);
        setH264HwStuck(false);
        assert.match(highLine()!, /não feita \(o H\.264 da placa está desligado neste PC\)/);
        assert.equal(workers.instances.length, 0);
        assert.equal(highProbeRecord(), null);
        workers.restore();
    });

    test("travou (Baseline ok, High trava): salvo, High desligado neste ambiente, VP9 so nesta sessao; o Worker preso fica", async () => {
        workers = installWorker(stuckProbe());
        const since = logMark();
        await runHighProbe(NV_ENV, "640032", 0);
        const detail = "nenhum pacote em 0.06 s desde o 1º quadro (o flush() não terminou)";
        assert.deepEqual({ ...highProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "broken", detail, profile: "640032" });
        assert.equal(workers.instances[0].terminated, false, "nunca terminado");
        assert.equal(stuckRecord(), null, "o Baseline nao fica marcado como travado");
        assert.equal(probeRecord()?.verdict, "ok", "nem a sonda do Baseline muda");
        assert.equal(getLocalCaps().h264HwEncode, false, "nesta sessao: VP9");
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").codec, "vp9");
        assert.deepEqual(since(), [
            `warn: Sonda WebCodecs do H.264 High da placa de vídeo: o encoder ficou preso (${detail}); o Worker dela fica como está até o Discord fechar`,
            `warn: A sonda WebCodecs do H.264 High (perfil 640032) travou neste PC (${detail}): o High fica desligado neste ambiente (só o Baseline) e, `
            + "com um encoder H.264 preso na placa de vídeo, o automático vai em VP9 nesta sessão"
        ]);
        workers.restore();

        // a proxima sessao (o mesmo ambiente): o travamento do High salvo vale, sem rodar; o Baseline volta
        setH264HwStuck(false);
        assert.equal(settleHigh(NV_ENV, 0), null);
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").reason, "automático: H.264 por hardware nos dois lados (perfil 42001f; High não: a sonda WebCodecs do High não passou neste PC)");
    });

    test("\"Tentar a placa de vídeo de novo\": esquece as duas sondas; o High so volta depois de a dele passar de novo", async () => {
        workers = installWorker(healthyProbe());
        assert.equal(forgetStuckEncoder(), "testing");
        assert.equal(highProbeRecord(), null);
        assert.equal(getLocalCaps().h264HighProbeOk, false);
        await eventually(() => highProbeRecord()?.verdict === "ok");
        assert.deepEqual(workers.instances.map(codecOf), ["avc1.42001f", "avc1.640032"]);
        await eventually(() => getLocalCaps().h264HighProbeOk);
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").h264Profile, "640032");
        workers.restore();

        // sem Worker: o Baseline volta ja (como antes), o High nao (nao da para testar)
        assert.equal(forgetStuckEncoder(), "now");
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(chooseCodec(HIGH_VIEWER, "auto").h264Profile, "42001f");
        assert.match(highLine()!, /não feita \(esquecida pelo botão; roda depois da do Baseline\)/);
    });

    test("registro do High estragado ou editado a mao: nenhum; perfil fora do formato vira \"?\"", () => {
        for (const bad of [null, "x", {}, { at: "ontem" }, { at: 1, env: {}, verdict: "talvez" }]) {
            pluginSettings.set("hwH264HighProbe", bad);
            assert.equal(highProbeRecord(), null, JSON.stringify(bad));
        }
        pluginSettings.set("hwH264HighProbe", { at: 1, env: {}, verdict: "ok", detail: "d", profile: "6400; DROP" });
        assert.equal(highProbeRecord()?.profile, null);
        assert.match(highLine()!, /salva: ok em \S+ \(perfil \?: d\)/);
        pluginSettings.set("hwH264HighProbe", { at: 1, env: {}, verdict: "ok", profile: "64001F" });
        assert.equal(highProbeRecord()?.profile, "64001f");
        assert.equal(highProbeRecord()?.detail, "");
        pluginSettings.set("hwH264HighProbe", { at: 1, env: {}, verdict: "broken", detail: "x" });
        assert.equal(highProbeRecord()?.profile, null, "sem o perfil");
    });
});
