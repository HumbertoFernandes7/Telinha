/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A dica "duas placas de video" ligada ao diagnostico (core/stuckEncoder.ts → dualGpuTip, stuckEncoderDiagnostics): a lista
// de placas do native fica fora do EncoderEnv, e so o registro do H.264 Baseline (stuckHwH264) conta, nunca os de High,
// H.265 e AV1. Estado do modulo: a ordem importa.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.dualGpu.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";

import { dualGpuTip, dualGpuTipFor, measureEnvironment, stuckEncoderDiagnostics } from "./stuckEncoder";

const ENV = { vendorId: "1002", deviceId: "7550", driver: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266" };
const AT = new Date(2026, 9, 31, 2, 54).getTime();

const adapters = [
    { vendorId: 0x1002, deviceId: 0x164E, name: "AMD Radeon(TM) Graphics", driverVendor: "AMD", driverVersion: "32.0.1", active: false, preference: 2 },
    { vendorId: 0x1002, deviceId: 0x7550, name: "AMD Radeon RX 9070 XT", driverVendor: "AMD", driverVersion: "32.0.21001.9024", active: true, preference: 3 }
];

let native: NativeEnv;
const useNative = (extra: Record<string, unknown>) => {
    native?.restore();
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266", error: null, ...extra })
    });
};

after(() => native?.restore());

describe("dica das duas placas no diagnostico", () => {
    test("native antigo (sem adapters): a linha diz \"?\" e nao ha dica", async () => {
        useNative({});
        pluginSettings.load({ stuckHwH264: { at: AT, env: { ...ENV }, source: "stream" } });
        await measureEnvironment();
        assert.equal(dualGpuTip(), null);
        assert.equal(stuckEncoderDiagnostics().split("\n")[1], "placas de vídeo: dica duas placas: não; ? (parte nativa antiga)");
    });

    test("com a lista, sem tela embutida e o registro do Baseline: desativar a integrada", async () => {
        useNative({ adapters, internalDisplay: false });
        await measureEnvironment();
        assert.equal(dualGpuTip()?.kind, "disable");
        assert.equal(stuckEncoderDiagnostics().split("\n")[1],
            'placas de vídeo: dica duas placas: desativar a integrada; #0 1002:164e "AMD Radeon(TM) Graphics" integrada, baixo consumo; #1 1002:7550 "AMD Radeon RX 9070 XT" dedicada, ativa, alto desempenho; tela embutida: não');
    });

    test("com tela embutida: notebook, sem desativar", async () => {
        useNative({ adapters, internalDisplay: true });
        await measureEnvironment();
        assert.equal(dualGpuTip()?.kind, "laptop");
        const line = stuckEncoderDiagnostics().split("\n")[1];
        assert.ok(line.startsWith("placas de vídeo: dica duas placas: notebook: sem desativar; ") && line.endsWith("tela embutida: sim"), line);
    });

    test("so registro do High, H.265 ou AV1 (sem o do Baseline): nenhuma dica", async () => {
        useNative({ adapters, internalDisplay: false });
        const probe = { at: AT, env: { ...ENV }, verdict: "broken", detail: "x" };
        pluginSettings.load({ hwH264HighProbe: { ...probe, profile: "640020" }, hwH265Probe: { ...probe, codec: "hvc1.1.6.L120.B0" }, hwAv1Probe: { ...probe, codec: "av01.0.08M.08" } });
        await measureEnvironment();
        assert.equal(dualGpuTip(), null);
        const line = stuckEncoderDiagnostics().split("\n")[1];
        assert.ok(line.startsWith("placas de vídeo: dica duas placas: não; ") && line.endsWith("tela embutida: não"), line);
    });
});

describe("lista vazia, entradas mal formadas e o travamento recem-visto", () => {
    test("native novo sem placas: a linha diz que o getGPUInfo nao devolveu placas", async () => {
        useNative({ adapters: [], internalDisplay: false });
        pluginSettings.load({ stuckHwH264: { at: AT, env: { ...ENV }, source: "stream" } });
        await measureEnvironment();
        assert.equal(stuckEncoderDiagnostics().split("\n")[1], "placas de vídeo: dica duas placas: não; ? (getGPUInfo sem placas)");
    });

    test("entrada mal formada e descartada, sem lancar; as boas ficam", async () => {
        useNative({ adapters: [{ vendorId: "1002", deviceId: 1, name: 5, driverVendor: "AMD", driverVersion: "1", active: true, preference: 3 }, null, ...adapters], internalDisplay: false });
        pluginSettings.load({ stuckHwH264: { at: AT, env: { ...ENV }, source: "stream" } });
        await measureEnvironment();
        const line = stuckEncoderDiagnostics().split("\n")[1];
        assert.ok(line.includes("#0 1002:164e") && line.includes("#1 1002:7550") && !line.includes("#2"), line);
    });

    test("dualGpuTipFor(true) vale sem o registro (o primeiro travamento ainda nao gravou)", async () => {
        useNative({ adapters, internalDisplay: false });
        pluginSettings.load({});
        await measureEnvironment();
        assert.equal(dualGpuTip(), null);
        assert.equal(dualGpuTipFor(true)?.kind, "disable");
    });
});
