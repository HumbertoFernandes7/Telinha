/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da linha da placa de video travada na pagina do plugin (ui/StuckEncoderSection.tsx), renderizada de verdade
// (React + happy-dom): sem travamento lembrado, nada; com ele, "A placa de vídeo travou com H.264 neste PC em 31/10;
// usando VP9." e o botao "Tentar a placa de vídeo de novo", que esquece o travamento (core/stuckEncoder.ts) e some.
// Rodar:  pnpm test:file src/plugins/telinha/ui/StuckEncoderSection.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { av1ProbeRecord, measureEnvironment, noteStuckEncoder, stuckEncoderDiagnostics } from "@plugins/telinha/core/stuckEncoder";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { act, fireEvent, render, screen, settle, waitFor } from "@test/fakes/render";
import { pluginSettings, resetVencordFakes, toasts } from "@test/fakes/vencord";

import { StuckEncoderSection } from "./StuckEncoderSection";

afterEach(() => resetVencordFakes());

test("sem travamento lembrado: nada aparece (e o diagnostico diz que o ambiente ainda nao foi lido)", async () => {
    pluginSettings.load({});
    assert.ok(stuckEncoderDiagnostics().startsWith("ambiente do encoder: ainda lendo\nplacas de vídeo: ? (parte nativa antiga); dica duas placas: não\nH.264 da placa travado neste PC: não;"));
    const { container } = render(<StuckEncoderSection />);
    await settle();
    assert.equal(container.textContent, "");
});

test("com o travamento: a linha e o botao; o botao esquece, avisa e a linha some", async () => {
    pluginSettings.load({ stuckHwH264: { at: new Date(2026, 9, 31, 2, 54).getTime(), env: { vendorId: "1002" }, source: "probe" } });
    render(<StuckEncoderSection />);
    await settle();
    assert.ok(screen.getByText("A placa de vídeo travou com H.264 neste PC em 31/10; usando VP9."));
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Tentar a placa de vídeo de novo" }));
    });
    await settle();
    assert.equal(pluginSettings.get("stuckHwH264"), null);
    assert.deepEqual(toasts.map(t => t.text), ["Pronto: a próxima pessoa que assistir recebe o H.264 da placa de vídeo de novo."]);
    assert.ok(!screen.queryByText(/A placa de vídeo travou/), "nao deveria existir: texto /A placa de vídeo travou/");
});

test("travou nesta sessao (ha um envio contido): o botao vale so depois de reiniciar o Discord", async () => {
    noteStuckEncoder();
    await waitFor(() => assert.ok(pluginSettings.get("stuckHwH264")));
    render(<StuckEncoderSection />);
    await settle();
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Tentar a placa de vídeo de novo" }));
    });
    await settle();
    assert.deepEqual(toasts.map(t => t.text), ["Pronto: a placa de vídeo é testada de novo quando você reiniciar o Discord."]);
});

test("so o AV1 saiu da placa (offHw, sem travamento do H.264): a linha do AV1 e o botao aparecem; o botao esquece o registro e tudo some", async () => {
    pluginSettings.load({ hwAv1Probe: { at: new Date(2026, 10, 2, 9, 0).getTime(), env: { vendorId: "10de" }, verdict: "offHw", detail: "o AV1 saiu da placa (libaom)", codec: "av01.0.05M.08", source: "stream" } });
    assert.equal(av1ProbeRecord()?.verdict, "offHw");
    render(<StuckEncoderSection />);
    await settle();
    assert.ok(screen.getByText("O AV1 saiu da placa de vídeo neste PC em 02/11; ele fica desligado até você tentar de novo."));
    assert.ok(!screen.queryByText(/A placa de vídeo travou/), "o H.264 nao travou");
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Tentar a placa de vídeo de novo" }));
    });
    await settle();
    assert.equal(pluginSettings.get("hwAv1Probe"), null);
    assert.equal(av1ProbeRecord(), null);
    assert.ok(!screen.queryByText(/O AV1 saiu da placa/), "nao deveria existir: texto /O AV1 saiu da placa/");
    assert.ok(!screen.queryByRole("button", { name: "Tentar a placa de vídeo de novo" }), "nao deveria existir: botao 'Tentar a placa de vídeo de novo'");
});

test("o AV1 que travou de verdade (broken) nao mostra o botao: so o offHw limpa", async () => {
    pluginSettings.load({ hwAv1Probe: { at: Date.now(), env: {}, verdict: "broken", detail: "x", codec: "av01.0.05M.08" } });
    const { container } = render(<StuckEncoderSection />);
    await settle();
    assert.equal(container.textContent, "");
});

// A dica das duas placas (core/gpuAdapters.ts → dualGpuParagraphs): so com o registro do H.264 e a lista de placas do native.
const AT = new Date(2026, 9, 31, 2, 54).getTime();
const adapters = [
    { vendorId: 0x1002, deviceId: 0x164E, name: "AMD Radeon(TM) Graphics", driverVendor: "AMD", driverVersion: "32.0.1", active: false, preference: 2 },
    { vendorId: 0x1002, deviceId: 0x7550, name: "AMD Radeon RX 9070 XT", driverVendor: "AMD", driverVersion: "32.0.21001.9024", active: true, preference: 3 }
];
let native: NativeEnv | undefined;
after(() => native?.restore());

async function friendsPc(extra: Record<string, unknown>) {
    native?.restore();
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266", error: null, ...extra })
    });
    await measureEnvironment();
}

const stuck = () => pluginSettings.load({ stuckHwH264: { at: AT, env: { vendorId: "1002" }, source: "probe" } });

test("dica das duas placas: com o registro e o PC do amigo, os passos aparecem acima do botao, com o nome real e como desfazer", async () => {
    await friendsPc({ adapters, internalDisplay: false });
    stuck();
    const { container } = render(<StuckEncoderSection />);
    await settle();
    assert.ok(screen.getByText(/Desabilitar dispositivo/));
    assert.ok(screen.getByText(/AMD Radeon RX 9070 XT/));
    assert.ok(container.textContent?.includes('botão direito em "AMD Radeon(TM) Graphics"'));
    assert.ok(screen.getByText(/Habilitar dispositivo/));
    const text = container.textContent ?? "";
    assert.ok(text.indexOf("Habilitar dispositivo") < text.lastIndexOf("Tentar a placa de vídeo de novo"), "a dica vem antes do botao");
    assert.ok(text.indexOf("A placa de vídeo travou com H.264") < text.indexOf("Este PC tem duas placas"), "e depois da linha do travamento");
});

test("dica das duas placas: notebook (tela embutida) mostra so o paragrafo do notebook, nada de desabilitar", async () => {
    await friendsPc({ adapters, internalDisplay: true });
    stuck();
    render(<StuckEncoderSection />);
    await settle();
    assert.ok(screen.getByText(/não desative nada/));
    assert.ok(!screen.queryByText(/Desabilitar/), "nao deveria existir: texto /Desabilitar/");
});

test("dica das duas placas: sem o registro do travamento, nada aparece", async () => {
    await friendsPc({ adapters, internalDisplay: false });
    pluginSettings.load({});
    const { container } = render(<StuckEncoderSection />);
    await settle();
    assert.equal(container.textContent, "");
});

test("dica das duas placas: native antigo (sem a lista de placas), so a linha do travamento", async () => {
    await friendsPc({});
    stuck();
    render(<StuckEncoderSection />);
    await settle();
    assert.ok(screen.getByText("A placa de vídeo travou com H.264 neste PC em 31/10; usando VP9."));
    assert.ok(!screen.queryByText(/duas placas/), "nao deveria existir: texto /duas placas/");
});
