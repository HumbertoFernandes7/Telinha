/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes das contas da janelinha (ui/pipGeometry.ts): canto padrao, empilhar, manter dentro da janela, desviar do PiP
// do Discord e clique x arraste. Sao funcoes puras: nada de DOM nem de relogio.
// Rodar:  pnpm test:file src/plugins/telinha/ui/pipGeometry.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clampPip, initialPipPos, isDrag, PIP_DRAG_THRESHOLD, PIP_EDGE, PIP_GAP, PIP_HEIGHT, PIP_MARGIN_BOTTOM, PIP_MARGIN_RIGHT, PIP_WIDTH } from "./pipGeometry";

const WIN_W = 1280;
const WIN_H = 720;

describe("ui/pipGeometry: clampPip", () => {
    test("posicao ja dentro da janela nao muda", () => {
        assert.deepEqual(clampPip({ x: 100, y: 200 }, WIN_W, WIN_H), { x: 100, y: 200 });
    });

    test("passou de qualquer borda: volta para dentro com PIP_EDGE de folga", () => {
        assert.deepEqual(clampPip({ x: -50, y: -50 }, WIN_W, WIN_H), { x: PIP_EDGE, y: PIP_EDGE });
        assert.deepEqual(clampPip({ x: 5000, y: 5000 }, WIN_W, WIN_H), { x: WIN_W - PIP_WIDTH - PIP_EDGE, y: WIN_H - PIP_HEIGHT - PIP_EDGE });
    });

    test("janela menor que a janelinha: fica colada em PIP_EDGE, nunca negativa", () => {
        assert.deepEqual(clampPip({ x: 300, y: 300 }, 100, 100), { x: PIP_EDGE, y: PIP_EDGE });
    });
});

describe("ui/pipGeometry: initialPipPos", () => {
    test("lugar padrao: canto de baixo a direita, longe da caixa de mensagem", () => {
        const pos = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0 });
        assert.deepEqual(pos, { x: WIN_W - 320 - 16, y: WIN_H - 180 - 72 });
        assert.equal(PIP_MARGIN_RIGHT, 16);
        assert.equal(PIP_MARGIN_BOTTOM, 72);
    });

    test("index 1 fica 192 px mais alto, na mesma coluna", () => {
        const a = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0 });
        const b = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 1 });
        assert.equal(PIP_HEIGHT + PIP_GAP, 192);
        assert.equal(b.x, a.x);
        assert.equal(a.y - b.y, 192);
    });

    test("pilha que nao cabe na janela e clampada em cima", () => {
        const pos = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 20 });
        assert.equal(pos.y, PIP_EDGE);
    });

    test("janela minuscula: clampada em PIP_EDGE", () => {
        assert.deepEqual(initialPipPos({ winW: 100, winH: 100, index: 0 }), { x: PIP_EDGE, y: PIP_EDGE });
    });

    test("remembered vale so para o index 0, e e clampado", () => {
        assert.deepEqual(initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, remembered: { x: 40, y: 60 } }), { x: 40, y: 60 });
        assert.deepEqual(initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, remembered: { x: 9999, y: -9999 } }), { x: WIN_W - PIP_WIDTH - PIP_EDGE, y: PIP_EDGE });
        assert.deepEqual(
            initialPipPos({ winW: WIN_W, winH: WIN_H, index: 1, remembered: { x: 40, y: 60 } }),
            initialPipPos({ winW: WIN_W, winH: WIN_H, index: 1 })
        );
    });

    test("remembered null e igual a nao ter lembrado", () => {
        assert.deepEqual(
            initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, remembered: null }),
            initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0 })
        );
    });

    test("retangulo a evitar que se sobrepoe: a janelinha sobe para cima dele", () => {
        const base = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0 });
        const discordPip = { left: base.x + 20, top: base.y + 20, right: base.x + 300, bottom: base.y + 160 };
        const pos = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, avoid: [discordPip] });
        assert.equal(pos.x, base.x);
        assert.equal(pos.y, discordPip.top - PIP_GAP - PIP_HEIGHT);
    });

    test("retangulo que nao se sobrepoe e ignorado (inclusive o que so encosta)", () => {
        const base = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0 });
        const longe = { left: 0, top: 0, right: 200, bottom: 100 };
        const encostado = { left: base.x - 100, top: base.y, right: base.x, bottom: base.y + PIP_HEIGHT };
        assert.deepEqual(initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, avoid: [longe, encostado] }), base);
    });

    test("subir cai em outro retangulo: sobe de novo", () => {
        const base = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0 });
        const baixo = { left: base.x, top: base.y, right: base.x + PIP_WIDTH, bottom: base.y + PIP_HEIGHT };
        const alto = { left: base.x, top: baixo.top - PIP_GAP - PIP_HEIGHT - 10, right: base.x + PIP_WIDTH, bottom: baixo.top - 5 };
        const pos = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, avoid: [baixo, alto] });
        assert.equal(pos.y, alto.top - PIP_GAP - PIP_HEIGHT);
    });

    test("retangulo que cobre a janela toda: para de subir e fica clampada em cima", () => {
        const tudo = { left: 0, top: 0, right: WIN_W, bottom: WIN_H };
        const pos = initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, avoid: [tudo] });
        assert.equal(pos.y, PIP_EDGE);
    });

    test("remembered nao desvia do retangulo a evitar (foi o usuario que escolheu o lugar)", () => {
        const remembered = { x: 100, y: 100 };
        const cobre = { left: 0, top: 0, right: WIN_W, bottom: WIN_H };
        assert.deepEqual(initialPipPos({ winW: WIN_W, winH: WIN_H, index: 0, remembered, avoid: [cobre] }), remembered);
    });
});

describe("ui/pipGeometry: isDrag", () => {
    test("no limite (4 px) ainda e clique; acima (4.1) e arraste", () => {
        assert.equal(PIP_DRAG_THRESHOLD, 4);
        assert.equal(isDrag(4, 0), false);
        assert.equal(isDrag(4.1, 0), true);
    });

    test("usa a distancia nos dois eixos, em qualquer sentido", () => {
        assert.equal(isDrag(3, 3), true); // hipotenusa 4.24
        assert.equal(isDrag(-3, 2), false); // 3.6
        assert.equal(isDrag(0, -5), true);
        assert.equal(isDrag(0, 0), false);
    });
});
