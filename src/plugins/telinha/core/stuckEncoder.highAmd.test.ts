/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O PC do amigo de 31/10 (AMD Radeon RX 9070 XT) com o High na lista (core/stuckEncoder.ts → startLocalCaps): o
// encodingInfo diz que a placa codifica 42001f e 640032, mas o encoder H.264 dela trava. A sonda do Baseline trava duas
// vezes, o PC fica marcado e a do High NUNCA roda (nenhum encoder High e criado): o automatico vai em VP9, como antes.
// Um processo so para isto: o inicio roda uma vez por sessao do Discord.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.highAmd.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { eventually } from "@test/fakes/clock";
import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities } from "@test/fakes/webrtc";
import { installWorker, stuckProbe } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import { highProbeRecord, PROBE_START, startLocalCaps, stuckEncoderDiagnostics, stuckRecord } from "./stuckEncoder";

const rtc = installWebRtc();
const native = installNative({
    gpuEnvironment: async () => ({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: "152.0.7977.167", discord: "1.0.9266", error: null })
});
const workers = installWorker(stuckProbe());
const timing = { ...ENCODER_PROBE_TIMING };

after(() => {
    Object.assign(ENCODER_PROBE_TIMING, timing);
    workers.restore();
    native.restore();
    rtc.restore();
});

test("o Baseline trava (confirmado): o PC fica marcado, a sonda do High nunca roda e ninguem recebe H.264 da placa", async () => {
    const video = [...DEFAULT_VIDEO_CODECS, { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032" }];
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video };
    rtc.mediaCapabilities.hwEncode = ["42001f", "640032"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "640032"];
    pluginSettings.load({});
    Object.assign(PROBE_START, { delayMs: 0, confirmMs: 0 });
    Object.assign(ENCODER_PROBE_TIMING, { configureMs: 40, noChunkMs: 60, flushMs: 60 });

    const lines: string[] = [];
    await startLocalCaps(line => lines.push(line));
    await eventually(() => lines.length === 1);
    assert.equal(stuckRecord()?.source, "probe");
    assert.deepEqual(workers.instances.map(w => (w.posted[0] as { config: { codec: string; }; }).config.codec), ["avc1.42001f", "avc1.42001f"], "nenhum encoder High");
    assert.equal(highProbeRecord(), null);
    assert.equal(getLocalCaps().h264HighHwProfile, "640032", "a placa diz que codifica High...");
    assert.equal(getLocalCaps().h264HighProbeOk, false, "...mas a sonda dele nao roda");
    const viewer = { h264HwDecode: true, hwDecode: { v: 1, h264High: true } };
    assert.deepEqual(chooseCodec(viewer, "auto"), { codec: "vp9", reason: "automático: este PC não codifica H.264 por hardware → VP9" });
    assert.ok(lines[0].includes("; sonda WebCodecs H.264 High: não feita (o H.264 da placa está desligado neste PC); H.264 automático desligado: "), lines[0]);
    assert.ok(stuckEncoderDiagnostics().includes("sonda WebCodecs High: não feita (o H.264 da placa está desligado neste PC); High automático desligado\n"));
});
