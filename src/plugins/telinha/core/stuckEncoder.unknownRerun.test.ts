/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Teste do inicio da sessao (core/stuckEncoder.ts → startLocalCaps) com um travamento salvo num driver antigo e um
// "inconclusiva" deste ambiente nas configuracoes (de uma versao anterior, ou editado a mao): inconclusiva nunca vale
// como resultado final, entao a sonda roda de novo; dizendo "ok", o travamento de outro ambiente e esquecido. Um
// processo so para isto: o inicio roda uma vez por sessao do Discord.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.unknownRerun.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { eventually } from "@test/fakes/clock";
import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { installWebRtc } from "@test/fakes/webrtc";
import { healthyProbe, installWorker } from "@test/fakes/worker";

import { getLocalCaps } from "./codec";
import { PROBE_START, probeRecord, startLocalCaps, stuckRecord } from "./stuckEncoder";

const rtc = installWebRtc();
const native = installNative({
    gpuEnvironment: async () => ({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21013.1000", chrome: "152.0.7444.59", discord: "1.0.9266", error: null })
});
const workers = installWorker(healthyProbe(30));

after(() => {
    workers.restore();
    native.restore();
    rtc.restore();
});

test("travamento de outro driver e um \"inconclusiva\" deste ambiente salvo: a sonda roda de novo e o \"ok\" esquece o travamento", async () => {
    rtc.mediaCapabilities.hwEncode = ["42001f"];
    rtc.mediaCapabilities.hwDecode = ["42001f"];
    PROBE_START.delayMs = 0;
    const at = new Date(2026, 9, 31, 2, 54).getTime();
    const now = { vendorId: "1002", deviceId: "7550", driver: "32.0.21013.1000", chrome: "152.0.7444.59", discord: "1.0.9266" };
    pluginSettings.load({
        stuckHwH264: { at, env: { ...now, driver: "32.0.21001.9024" } },
        hwH264Probe: { at, env: now, verdict: "unknown", detail: "sem resposta" }
    });
    const lines: string[] = [];
    await startLocalCaps(line => lines.push(line));
    assert.equal(getLocalCaps().h264HwEncode, false, "enquanto a sonda roda: VP9");
    await eventually(() => lines.length === 1);
    assert.equal(workers.instances.length, 1, "a sonda rodou de novo");
    assert.equal(probeRecord()?.verdict, "ok");
    assert.equal(stuckRecord(), null);
    assert.equal(getLocalCaps().h264HwEncode, true);
});
