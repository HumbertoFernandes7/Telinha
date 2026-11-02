/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Quem atualiza da v0.3.1 (core/stuckEncoder.ts → startLocalCaps): a sonda do Baseline ja passou NESTE ambiente (salva),
// a do High nunca rodou. O Baseline vale desde o inicio (nada espera); so a sonda do High roda, uma vez, PROBE_START.delayMs
// depois (fora da partida do Discord), e o High so liga quando ela diz ok. A linha das capacidades sai no fim dela.
// Um processo so para isto: o inicio roda uma vez por sessao do Discord.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.highUpgrade.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { eventually } from "@test/fakes/clock";
import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities } from "@test/fakes/webrtc";
import { type FakeWorker, healthyProbe, installWorker } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps } from "./codec";
import { highProbeRecord, PROBE_START, startLocalCaps } from "./stuckEncoder";

const rtc = installWebRtc();
const native = installNative({
    gpuEnvironment: async () => ({ vendorId: 0x10de, deviceId: 0x2484, driverVersion: "32.0.15.6094", chrome: "152.0.7977.167", discord: "1.0.9266", error: null })
});
let held: FakeWorker | null = null;
const workers = installWorker(w => {
    held = w;
});

after(() => {
    workers.restore();
    native.restore();
    rtc.restore();
});

test("Baseline ja testado neste ambiente (v0.3.1): Baseline desde o inicio; so a sonda do High roda, depois do atraso", async () => {
    const video = [...DEFAULT_VIDEO_CODECS, { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032" }];
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video };
    rtc.mediaCapabilities.hwEncode = ["42001f", "640032"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "640032"];
    const at = new Date(2026, 10, 1, 21, 0).getTime();
    const env = { vendorId: "10de", deviceId: "2484", driver: "32.0.15.6094", chrome: "152.0.7977.167", discord: "1.0.9266" };
    pluginSettings.load({ hwH264Probe: { at, env, verdict: "ok", detail: "30 pacotes de 30 quadros" } });
    PROBE_START.delayMs = 50;
    const viewer = { h264HwDecode: true, hwDecode: { v: 1, h264High: true } };

    const lines: string[] = [];
    await startLocalCaps(line => lines.push(line));
    assert.equal(getLocalCaps().h264HwEncode, true, "o Baseline nao espera pela sonda do High");
    assert.equal(chooseCodec(viewer, "auto").h264Profile, "42001f");
    assert.equal(workers.instances.length, 0, "a sonda do High espera um pouco depois do inicio");
    assert.equal(lines.length, 0, "a linha sai no fim da sonda");

    await eventually(() => held);
    assert.deepEqual(workers.instances.map(w => (w.posted[0] as { config: { codec: string; }; }).config.codec), ["avc1.640032"], "so o High: o Baseline ja tinha passado");
    assert.equal(chooseCodec(viewer, "auto").h264Profile, "42001f", "ainda rodando: Baseline");
    healthyProbe()(held!, null);
    await eventually(() => lines.length === 1);
    assert.ok(lines[0].endsWith("; sonda WebCodecs H.264 placa: ok (feita em 01/11 neste ambiente: 30 pacotes de 30 quadros); "
        + "sonda WebCodecs H.264 High: ok (30 pacotes de 30 quadros)"), lines[0]);
    assert.equal(highProbeRecord()?.verdict, "ok");
    assert.equal(chooseCodec(viewer, "auto").h264Profile, "640032");
    assert.equal(chooseCodec({ h264HwDecode: true }, "auto").h264Profile, "42001f", "espectador na v0.3.1");
});
