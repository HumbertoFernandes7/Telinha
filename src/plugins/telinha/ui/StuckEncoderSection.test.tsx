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

import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { pluginSettings, resetVencordFakes, toasts } from "@test/fakes/vencord";

import { StuckEncoderSection } from "./StuckEncoderSection";

afterEach(() => resetVencordFakes());

test("sem travamento lembrado: nada aparece", () => {
    pluginSettings.load({});
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
