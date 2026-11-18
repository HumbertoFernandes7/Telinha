/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A sonda WebCodecs do H.265 num Discord sem H.264 no sender (1.0.9269 no Windows, sem o OpenH264), com o formato de video
// no AUTOMATICO: sem H.264 nao ha sonda do Baseline nem do High, entao a do H.265 roda sozinha (core/stuckEncoder.ts →
// settleHwOnly, com hwOnlyWanted valendo no automatico) e o automatico passa a mandar H.265 pela placa para quem o
// decodifica na placa. Num PC NVIDIA com H.265 Main na placa (a sonda de codecs falsa, com o fmtp do Chrome 156). Estado
// do modulo e do processo: a ordem importa.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.noH264.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { installWebRtc, rtpCapabilities, type WebRtcEnv } from "@test/fakes/webrtc";
import { type FakeWorker, healthyProbe, installWorker, type WorkerEnv } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps, setH264HwStuck } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import { type EncoderEnv, forgetStuckEncoder, h265ProbeRecord, noteStreamStarting, onCodecSettingChanged, onStreamStopped, PROBE_START, settleH265, startLocalCaps, stuckEncoderDiagnostics } from "./stuckEncoder";

const NV_ENV: EncoderEnv = { vendorId: "10de", deviceId: "2484", driver: "32.0.16.2101", chrome: "152.0.7977.167", discord: "1.0.9269" };
const H265_SEND = "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST";
const CODEC = "hvc1.1.6.L123.B0";
const OK_DETAIL = "30 pacotes de 30 quadros";
const vcodec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({ mimeType, clockRate: 90000, ...(sdpFmtpLine ? { sdpFmtpLine } : {}) });
/** O sender desse Discord: sem nenhum H.264. */
const SENDER = [vcodec("video/VP8"), vcodec("video/rtx"), vcodec("video/AV1", "level-idx=5;profile=0;tier=0"), vcodec("video/VP9", "profile-id=0"), vcodec("video/H265", H265_SEND)];
const RECEIVER = [vcodec("video/VP8"), vcodec("video/H264", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"), vcodec("video/VP9", "profile-id=0"), vcodec("video/H265", H265_SEND)];
const BOTH = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };

let rtc: WebRtcEnv;
let native: NativeEnv;
let workers: WorkerEnv | null = null;
const timing = { ...ENCODER_PROBE_TIMING };

const configOf = (w: FakeWorker) => (w.posted[0] as { config: Record<string, unknown>; }).config;
const h265Line = () => stuckEncoderDiagnostics().split("\n").find(l => l.startsWith("H.265: "));

before(() => {
    rtc = installWebRtc();
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video: SENDER };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video: RECEIVER };
    rtc.mediaCapabilities.hwEncode = ["h265"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "h265"];
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x10de, deviceId: 0x2484, driverVersion: NV_ENV.driver, chrome: NV_ENV.chrome, discord: NV_ENV.discord, error: null })
    });
    pluginSettings.load({ codec: "auto" });
    Object.assign(PROBE_START, { delayMs: 0, confirmMs: 0 });
    Object.assign(ENCODER_PROBE_TIMING, { configureMs: 40, noChunkMs: 60, flushMs: 60 });
});

after(() => {
    workers?.restore();
    Object.assign(ENCODER_PROBE_TIMING, timing);
    native.restore();
    rtc.restore();
});

describe("Discord sem H.264, formato de video no automatico", () => {
    test("inicio da sessao: so a sonda do H.265 roda (sem Baseline nem High) e o automatico manda H.265 pela placa, sem reserva H.264", async () => {
        workers = installWorker(healthyProbe());
        const lines: string[] = [];
        await startLocalCaps(line => lines.push(line));
        await eventually(() => lines.length === 1);
        assert.deepEqual(workers.instances.map(w => configOf(w).codec), [CODEC], "nem a sonda do Baseline, nem a do High, nem a do AV1");
        assert.match(lines[0], /^Capacidades locais: H\.264 por hardware — decodifica: sim, codifica: não \(este Discord não oferece H\.264\); envia: vp8, av1, vp9, h265; /);
        assert.match(lines[0], /; sonda WebCodecs H\.264 placa: não feita \(este Discord não oferece H\.264\)/);
        assert.ok(lines[0].endsWith(`; sonda WebCodecs H.265: ok (${OK_DETAIL})`), lines[0]);
        assert.equal(h265ProbeRecord()?.verdict, "ok");
        assert.equal(getLocalCaps().h265ProbeOk, true);
        const d = chooseCodec(BOTH, "auto");
        assert.equal(d.codec, "h265");
        assert.ok(!("h264Profile" in d), "sem reserva H.264");
        assert.match(d.reason, /^automático: este Discord não oferece H\.264 → H\.265 pela placa/);
        assert.match(h265Line()!, /; H\.265 no automático \(este Discord não oferece H\.264\) ligado \(só com quem anuncia H\.265 por hardware\)$/);
        workers.restore();
        workers = null;
    });

    test("fixado em H.265: o mesmo H.265 (o diagnostico diz 'fixado'); em VP9: a sonda do H.265 nao vale", () => {
        pluginSettings.set("codec", "h265");
        assert.match(h265Line()!, /; H\.265 fixado ligado \(só com quem anuncia H\.265 por hardware\)$/);
        pluginSettings.set("codec", "vp9");
        assert.equal(onCodecSettingChanged(), null);
        assert.match(h265Line()!, /; H\.265 fixado desligado \(o formato de vídeo não está em H\.265\)$/);
        pluginSettings.set("codec", "auto");
    });

    test("a placa travada (o registro do H.264 deste PC) segura a sonda do H.265 tambem; o H.265 no automatico fica desligado", () => {
        pluginSettings.set("hwH265Probe", null);
        setH264HwStuck(true);
        assert.equal(settleH265(NV_ENV, 0), null);
        assert.match(h265Line()!, /sonda WebCodecs H\.265: não feita \(o H\.264 da placa está desligado neste PC, e o H\.265 vai junto\); H\.265 no automático \(este Discord não oferece H\.264\) desligado$/);
        assert.equal(chooseCodec(BOTH, "auto").codec, "vp9");
        setH264HwStuck(false);
    });

    test("o botao 'Tentar a placa de vídeo de novo' (sem H.264 para testar: 'h265Now'): a sonda do H.265 roda de novo na hora", async () => {
        workers = installWorker(healthyProbe());
        assert.equal(forgetStuckEncoder(), "h265Now");
        await eventually(() => getLocalCaps().h265ProbeOk === true);
        assert.deepEqual(workers.instances.map(w => configOf(w).codec), [CODEC]);
        assert.equal(chooseCodec(BOTH, "auto").codec, "h265");
        workers.restore();
        workers = null;
    });

    test("o botao com transmissao no ar: 'h265Later' (nada de sonda agora); quando ela acaba, a sonda do H.265 roda", async () => {
        workers = installWorker(healthyProbe());
        noteStreamStarting(true);
        try {
            assert.equal(forgetStuckEncoder(), "h265Later");
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.equal(workers.instances.length, 0, "com a transmissao no ar a sonda nao roda");
            assert.equal(getLocalCaps().h265ProbeOk, false);
        } finally {
            noteStreamStarting(false);
        }
        await onStreamStopped();
        await eventually(() => getLocalCaps().h265ProbeOk === true);
        workers.restore();
        workers = null;
    });
});
