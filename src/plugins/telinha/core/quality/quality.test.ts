/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes das partes PURAS da qualidade automatica (core/quality/levels.ts): a carencia de banda do espectador novo.
// O controller em si nao e testado aqui: controller.ts importa core/log -> store -> @webpack/common (Vencord), que nao carrega
// no Node. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:quality

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BW_GRACE_MS, inBandwidthGrace } from "./levels";

describe("carencia de banda do espectador novo", () => {
    test("sao 20 s", () => {
        assert.equal(BW_GRACE_MS, 20_000);
    });

    test("antes de ficar pronto (readyAt = Infinity): em carencia", () => {
        assert.equal(inBandwidthGrace(Infinity, 0), true);
        assert.equal(inBandwidthGrace(Infinity, 1_000_000), true);
    });

    test("relogio antes do readyAt: em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 4_000), true);
    });

    test("no instante em que fica pronto (0 s): em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000), true);
    });

    test("aos 10 s (a queda de banda vista nos logs): em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 15_000), true);
    });

    test("aos 19,9 s: em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000 + 19_900), true);
    });

    test("aos 20 s: acabou", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000 + 20_000), false);
    });

    test("depois dos 20 s: acabou", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000 + 20_001), false);
        assert.equal(inBandwidthGrace(5_000, 5_000 + 120_000), false);
    });

    test("avaliacoes de ~2 s: as janelas ate 18 s ficam na carencia, a de 20 s em diante ja conta", () => {
        const readyAt = 1_234;
        const inGrace: boolean[] = [];
        for (let t = 2_000; t <= 22_000; t += 2_000) inGrace.push(inBandwidthGrace(readyAt, readyAt + t));
        assert.deepEqual(inGrace, [true, true, true, true, true, true, true, true, true, false, false]);
    });
});
