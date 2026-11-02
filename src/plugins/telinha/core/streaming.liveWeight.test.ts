/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O peso da live (core/liveWeight.ts) ligado a transmissao (core/streaming.ts), com o core inteiro nos fakes: comeca com a
// transmissao, le a cada STATS_LOG_MS pelo ticker da sessao (a linha vai para o log, e dali para o diagnostico
// compartilhado), trocar de fonte nao recomeca, e parar a transmissao para a medicao.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.liveWeight.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { installNative } from "@test/fakes/native";
import { createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, windowOptions } from "@test/helpers/wpb-streaming";

import { currentLiveWeight, liveWeightDiagnostics } from "./liveWeight";
import type { LiveWeightReport } from "./liveWeightMain";
import { STATS_LOG_MS } from "./statsLog";
import { startStreaming, stopStreaming } from "./streaming";

let rig: StreamingRig;

const REPORT: LiveWeightReport = {
    state: "measuring", reason: null, samples: 2, windowMs: STATS_LOG_MS,
    discord: { "3D": 3, VideoEncode: 9, VideoDecode: 0, Copy: 1 }, discordCpu: 4, discordGpuMemoryMb: 300,
    game: { pid: 4321, name: "Jogo.exe", load3D: 88, source: "window" }, total: { "3D": 95, VideoEncode: 9, VideoDecode: 0, Copy: 2 }, runs: 1
};

before(async () => {
    rig = createRig();
    // a parte nativa com o peso da live (o proxy do VencordNative so tem as funcoes que existiam ao instalar)
    rig.native.restore();
    rig.native = installNative({
        startLiveWeight: async () => ({ ok: true, reason: null }),
        readLiveWeight: async () => REPORT,
        stopLiveWeight: async () => undefined
    });
    await enterCall(rig);
});

after(() => destroyRig(rig));

const callsOf = (name: string) => rig.native.calls.filter(c => c.name === name).length;

test("comeca com a transmissao, le a cada STATS_LOG_MS pelo ticker, continua ao trocar de fonte e para junto", async () => {
    const since = logMark();
    await startStreaming(windowOptions());
    assert.equal(callsOf("startLiveWeight"), 1);
    assert.deepEqual(rig.native.calls.find(c => c.name === "startLiveWeight")?.args, [windowOptions().source.id], "com a fonte capturada");
    await seconds(rig, STATS_LOG_MS / 1000);
    assert.equal(callsOf("readLiveWeight"), 1);
    assert.ok(since().includes("Peso da live: placa (Discord) 3D 3% · codificar 9% · copiar 1% · processador 4% — jogo Jogo.exe 3D 88% — placa no total 3D 95% · codificar 9%"));
    assert.equal(currentLiveWeight()?.game?.name, "Jogo.exe");
    assert.match(liveWeightDiagnostics(), /^peso da live: medindo nesta transmissão/);

    // trocar de fonte no ar: a mesma medicao, so com a fonte nova
    await startStreaming(screenOptions());
    assert.deepEqual(rig.native.calls.filter(c => c.name === "startLiveWeight").map(c => c.args), [[windowOptions().source.id], ["screen:0:0"]]);
    assert.equal(callsOf("stopLiveWeight"), 0);

    stopStreaming();
    assert.equal(callsOf("stopLiveWeight"), 1);
    assert.equal(currentLiveWeight(), null);
    await seconds(rig, STATS_LOG_MS / 1000);
    assert.equal(callsOf("readLiveWeight"), 1, "parado: nao le mais");
});
