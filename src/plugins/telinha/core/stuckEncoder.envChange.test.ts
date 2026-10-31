/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do ambiente que muda (core/stuckEncoder.ts → startLocalCaps): o travamento salvo foi num driver antigo da placa
// de video, entao ele e esquecido sozinho (com uma linha no log) e o automatico volta a tentar o H.264 da placa. A sonda
// WebCodecs ja tinha rodado NESTE ambiente (driver novo): uma vez por ambiente, ela nao roda de novo, e a linha das
// capacidades diz o resultado salvo. Um processo so para isto: o inicio roda uma vez por sessao do Discord.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.envChange.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { getEventLog } from "@plugins/telinha/store";
import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { installWebRtc } from "@test/fakes/webrtc";
import { healthyProbe, installWorker } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps } from "./codec";
import { PROBE_START, probeRecord, startLocalCaps, stuckRecord } from "./stuckEncoder";

const rtc = installWebRtc();
const native = installNative({
    gpuEnvironment: async () => ({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21013.1000", chrome: "152.0.7444.59", discord: "1.0.9266", error: null })
});
const workers = installWorker(healthyProbe());

after(() => {
    workers.restore();
    native.restore();
    rtc.restore();
});

test("driver novo: o travamento salvo e esquecido sozinho; a sonda deste ambiente ja rodou e nao roda de novo", async () => {
    rtc.mediaCapabilities.hwEncode = ["42001f"];
    rtc.mediaCapabilities.hwDecode = ["42001f"];
    const at = new Date(2026, 9, 31, 2, 54).getTime();
    const now = { vendorId: "1002", deviceId: "7550", driver: "32.0.21013.1000", chrome: "152.0.7444.59", discord: "1.0.9266" };
    pluginSettings.load({
        stuckHwH264: { at, env: { ...now, driver: "32.0.21001.9024" }, source: "stream" },
        hwH264Probe: { at, env: now, verdict: "ok", detail: "30 pacotes de 30 quadros" }
    });
    PROBE_START.delayMs = 0;
    const lines: string[] = [];
    await startLocalCaps(line => lines.push(line));

    assert.equal(stuckRecord(), null);
    assert.ok(getEventLog().some(e => e.level === "info" && e.msg === "A placa de vídeo tinha travado com H.264 neste PC em 31/10, mas o ambiente mudou "
        + "(driver da placa de vídeo 32.0.21001.9024 → 32.0.21013.1000): o automático volta a tentar o H.264 da placa de vídeo"));
    assert.equal(getLocalCaps().h264HwEncode, true);
    assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "h264");
    assert.equal(workers.instances.length, 0, "a sonda ja tinha rodado neste ambiente");
    assert.equal(probeRecord()?.verdict, "ok");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith("; sonda WebCodecs H.264 placa: ok (feita em 31/10 neste ambiente: 30 pacotes de 30 quadros)"), lines[0]);
});
