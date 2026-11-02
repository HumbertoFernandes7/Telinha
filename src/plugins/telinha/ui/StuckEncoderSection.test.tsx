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
import { afterEach, test } from "node:test";

import { av1ProbeRecord, noteStuckEncoder, stuckEncoderDiagnostics } from "@plugins/telinha/core/stuckEncoder";
import { act, fireEvent, render, screen, settle, waitFor } from "@test/fakes/render";
import { pluginSettings, resetVencordFakes, toasts } from "@test/fakes/vencord";

import { StuckEncoderSection } from "./StuckEncoderSection";

afterEach(() => resetVencordFakes());

test("sem travamento lembrado: nada aparece (e o diagnostico diz que o ambiente ainda nao foi lido)", () => {
    pluginSettings.load({});
    assert.ok(stuckEncoderDiagnostics().startsWith("ambiente do encoder: ainda lendo\nH.264 da placa travado neste PC: não;"));
    const { container } = render(<StuckEncoderSection />);
    assert.equal(container.textContent, "");
});

test("com o travamento: a linha e o botao; o botao esquece, avisa e a linha some", async () => {
    pluginSettings.load({ stuckHwH264: { at: new Date(2026, 9, 31, 2, 54).getTime(), env: { vendorId: "1002" }, source: "probe" } });
    render(<StuckEncoderSection />);
    assert.ok(screen.getByText("A placa de vídeo travou com H.264 neste PC em 31/10; usando VP9."));
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Tentar a placa de vídeo de novo" }));
    });
    await settle();
    assert.equal(pluginSettings.get("stuckHwH264"), null);
    assert.deepEqual(toasts.map(t => t.text), ["Pronto: a próxima pessoa que assistir recebe o H.264 da placa de vídeo de novo."]);
    assert.equal(screen.queryByText(/A placa de vídeo travou/), null);
});

test("travou nesta sessao (ha um envio contido): o botao vale so depois de reiniciar o Discord", async () => {
    noteStuckEncoder();
    await waitFor(() => assert.ok(pluginSettings.get("stuckHwH264")));
    render(<StuckEncoderSection />);
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
    assert.ok(screen.getByText("O AV1 saiu da placa de vídeo neste PC em 02/11; ele fica desligado até você tentar de novo."));
    assert.equal(screen.queryByText(/A placa de vídeo travou/), null, "o H.264 nao travou");
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Tentar a placa de vídeo de novo" }));
    });
    await settle();
    assert.equal(pluginSettings.get("hwAv1Probe"), null);
    assert.equal(av1ProbeRecord(), null);
    assert.equal(screen.queryByText(/O AV1 saiu da placa/), null);
    assert.equal(screen.queryByRole("button", { name: "Tentar a placa de vídeo de novo" }), null);
});

test("o AV1 que travou de verdade (broken) nao mostra o botao: so o offHw limpa", () => {
    pluginSettings.load({ hwAv1Probe: { at: Date.now(), env: {}, verdict: "broken", detail: "x", codec: "av01.0.05M.08" } });
    const { container } = render(<StuckEncoderSection />);
    assert.equal(container.textContent, "");
});
