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

import { noteStuckEncoder, stuckEncoderDiagnostics } from "@plugins/telinha/core/stuckEncoder";
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
