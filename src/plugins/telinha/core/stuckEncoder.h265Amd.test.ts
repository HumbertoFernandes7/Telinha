/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O PC do amigo de 31/10 (AMD Radeon RX 9070 XT) com H.265 na lista (core/stuckEncoder.ts → startLocalCaps): o
// encodingInfo diz que a placa codifica 42001f, 640032 e H.265, mas o encoder H.264 dela trava. A sonda do Baseline trava
// duas vezes, o PC fica marcado e as do High e do H.265 NUNCA rodam: nenhum encoder H.265 e criado, mesmo com o H.265 fixado.
// Um processo so para isto: o inicio roda uma vez por sessao do Discord.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.h265Amd.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { eventually } from "@test/fakes/clock";
import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities } from "@test/fakes/webrtc";
import { installWorker, stuckProbe } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import { h265ProbeRecord, PROBE_START, startLocalCaps, stuckEncoderDiagnostics, stuckRecord } from "./stuckEncoder";

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

test("o Baseline trava (confirmado): nenhuma sonda do H.265, nenhum H.265 (nem fixado), e o diagnostico diz por que", async () => {
    const video = [...DEFAULT_VIDEO_CODECS,
        { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032" },
        { mimeType: "video/H265", clockRate: 90000, sdpFmtpLine: "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST" }];
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video };
    rtc.mediaCapabilities.hwEncode = ["42001f", "640032", "h265"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "640032", "h265"];
    pluginSettings.load({ codec: "h265" });
    Object.assign(PROBE_START, { delayMs: 0, confirmMs: 0 });
    Object.assign(ENCODER_PROBE_TIMING, { configureMs: 40, noChunkMs: 60, flushMs: 60 });

    const lines: string[] = [];
    await startLocalCaps(line => lines.push(line));
    await eventually(() => lines.length === 1);
    assert.equal(stuckRecord()?.source, "probe");
    assert.deepEqual(workers.instances.map(w => (w.posted[0] as { config: { codec: string; }; }).config.codec), ["avc1.42001f", "avc1.42001f"], "nenhum encoder H.265 nem High");
    assert.equal(h265ProbeRecord(), null);
    assert.ok(getLocalCaps().h265HwFmtp, "a placa diz que codifica H.265...");
    assert.equal(getLocalCaps().h265ProbeOk, false, "...mas a sonda dele nao roda");
    const viewer = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };
    assert.equal(chooseCodec(viewer, "auto").codec, "vp9");
    assert.equal(chooseCodec(viewer, "h265").codec, "vp9", "fixado em H.265 tambem nao");
    assert.ok(lines[0].includes("; sonda WebCodecs H.265: não feita (o H.264 da placa está desligado neste PC, e o H.265 vai junto)"), lines[0]);
    assert.ok(stuckEncoderDiagnostics().includes("sonda WebCodecs H.265: não feita (o H.264 da placa está desligado neste PC, e o H.265 vai junto); H.265 fixado desligado"));
});
