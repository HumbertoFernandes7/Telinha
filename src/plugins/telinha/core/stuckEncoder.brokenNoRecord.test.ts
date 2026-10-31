/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Teste do inicio da sessao (core/stuckEncoder.ts → startLocalCaps) quando a sonda WebCodecs deste ambiente ja disse
// "travou", mas o registro do travamento nao esta salvo (a gravacao dele falhou): vale como o registro, entao o H.264
// automatico continua desligado e a sonda nao roda de novo. Um processo so para isto: o inicio roda uma vez por sessao.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.brokenNoRecord.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { installWebRtc } from "@test/fakes/webrtc";
import { healthyProbe, installWorker } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps } from "./codec";
import { PROBE_START, startLocalCaps, stuckRecord } from "./stuckEncoder";

const rtc = installWebRtc();
const native = installNative({
    gpuEnvironment: async () => ({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266", error: null })
});
const workers = installWorker(healthyProbe());

after(() => {
    workers.restore();
    native.restore();
    rtc.restore();
});

test("a sonda deste ambiente travou e o registro sumiu: o H.264 automatico continua desligado, sem rodar a sonda de novo", async () => {
    rtc.mediaCapabilities.hwEncode = ["42001f"];
    rtc.mediaCapabilities.hwDecode = ["42001f"];
    PROBE_START.delayMs = 0;
    const env = { vendorId: "1002", deviceId: "7550", driver: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266" };
    pluginSettings.load({ hwH264Probe: { at: new Date(2026, 9, 31, 3, 0).getTime(), env, verdict: "broken", detail: "nenhum pacote" } });
    const lines: string[] = [];
    await startLocalCaps(line => lines.push(line));
    assert.equal(stuckRecord(), null);
    assert.equal(getLocalCaps().h264HwEncode, false);
    assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "vp9");
    assert.equal(workers.instances.length, 0);
    assert.ok(lines[0].endsWith("; sonda WebCodecs H.264 placa: travou (feita em 31/10 neste ambiente: nenhum pacote)"), lines[0]);
});
