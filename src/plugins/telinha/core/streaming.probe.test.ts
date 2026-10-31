/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Teste de ponta a ponta da sonda WebCodecs no inicio da sessao (core/session.ts → stuckEncoder.ts → startLocalCaps →
// runStartupProbe → encoderProbe.ts), num PC como o do amigo em 31/10: a sonda de codecs diz que a placa codifica H.264,
// mas o encoder WebCodecs dela nunca solta um pacote (Worker falso, @test/fakes/worker). A parte nativa e antiga (sem
// gpuEnvironment: o Discord ainda nao reiniciou depois da atualizacao), entao a placa vem do WebGPU. Resultado: antes da
// 1a transmissao o PC ja esta marcado, o 1o espectador recebe VP9 e nenhum encoder H.264 do WebRTC e criado; o Worker
// preso nunca e terminado. Enquanto a sonda roda, o automatico tambem vai de VP9.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.probe.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { getEventLog } from "@plugins/telinha/store";
import { pluginSettings } from "@test/fakes/vencord";
import { installWorker, stuckProbe, type WorkerEnv } from "@test/fakes/worker";
import { connectViewer, createRig, destroyRig, enterCall, screenOptions, type StreamingRig, turns } from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import { sendPlanFor, startStreaming, stopStreaming } from "./streaming";
import { PROBE_START, probeRecord, stuckEncoderDiagnostics, stuckRecord } from "./stuckEncoder";

let rig: StreamingRig;
let workers: WorkerEnv;
const nav = globalThis.navigator as unknown as { gpu?: unknown; };

before(() => {
    PROBE_START.delayMs = 1000;
    workers = installWorker(stuckProbe());
    Object.defineProperty(nav, "gpu", {
        configurable: true,
        value: { requestAdapter: async () => ({ info: { vendor: "amd", architecture: "rdna-4", device: "0x7550", description: "" } }) }
    });
});

after(async () => {
    stopStreaming();
    await destroyRig(rig);
    workers.restore();
    delete nav.gpu;
});

test("a sonda trava antes da 1a transmissao: o PC fica marcado e o 1o espectador ja recebe VP9; o Worker preso fica", async () => {
    rig = createRig({
        beforeSession: rtc => {
            rtc.mediaCapabilities.hwEncode = ["42001f"];
            rtc.mediaCapabilities.hwDecode = ["42001f"];
        }
    });
    // a sonda de codecs mediu a placa; a WebCodecs espera PROBE_START.delayMs (fora da partida do Discord) com o automatico em VP9
    for (let i = 0; i < 200 && getLocalCaps().h264HwProfile == null; i++) await turns(1);
    assert.equal(getLocalCaps().h264HwProfile, "42001f");
    assert.equal(getLocalCaps().h264HwEncode, false, "esperando a sonda: VP9");
    assert.equal(workers.instances.length, 0, "ainda nao: espera um pouco depois do inicio");
    rig.clock.tick(PROBE_START.delayMs);
    await turns();
    assert.equal(workers.instances.length, 1);
    assert.deepEqual((workers.instances[0].posted[0] as { config: { codec: string; }; }).config.codec, "avc1.42001f");

    // configure ok, nenhum pacote, o flush sem fim: no prazo, travou
    rig.clock.tick(ENCODER_PROBE_TIMING.encodeMs + 1);
    await turns();
    assert.equal(probeRecord()?.verdict, "broken");
    assert.equal(stuckRecord()?.source, "probe");
    assert.deepEqual(stuckRecord()?.env, { vendorId: "1002", deviceId: "7550", driver: null, chrome: null, discord: null }, "placa pelo WebGPU");
    assert.equal(workers.instances[0].terminated, false);
    assert.equal(getLocalCaps().h264HwEncode, false);
    const caps = getEventLog().filter(e => e.msg.startsWith("Capacidades locais:")).map(e => e.msg);
    assert.equal(caps.length, 1);
    assert.ok(caps[0].includes("; placa de vídeo 1002:7550, driver ?;"), caps[0]);
    assert.ok(caps[0].includes("; sonda WebCodecs H.264 placa: travou (nenhum pacote em 4 s (o flush() não terminou))"), caps[0]);
    assert.ok(stuckEncoderDiagnostics().includes("(placa via webgpu)"));

    // a 1a transmissao: o espectador decodifica H.264 na placa, mas recebe VP9
    await enterCall(rig, []);
    pluginSettings.set("requireVerifiedIdentity", false);
    await startStreaming(screenOptions());
    await connectViewer(rig, "pviewer", "840000000000000001", "amigo", { h264HwDecode: true });
    rig.room.receive("watch", { op: "start" }, "pviewer");
    await turns();
    assert.equal(sendPlanFor("pviewer")?.codec, "vp9");
    assert.ok(getEventLog().some(e => e.msg === "Enviando para amigo (pviewe): codec VP9 (automático: este PC não codifica H.264 por hardware → VP9)"));
});
