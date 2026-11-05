/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos registros do volume da barra da call (ui/callView/trayVolume.ts): tiles com som (com a regra do token),
// barra no comando (contador e "desfazer" idempotente), avisos so quando algo muda e listener que falha.
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/trayVolume.test.ts

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { act, cleanup, renderHook } from "@test/fakes/render";
import { loggerLines, resetVencordFakes } from "@test/fakes/vencord";

import {
    getTileAudioKey,
    isTrayBarActive,
    registerTrayBar,
    resetTrayVolume,
    setTileAudio,
    subscribeTray,
    useTrayVersion
} from "./trayVolume";

const U = "100000000000000001";
const A = Symbol("a");
const B = Symbol("b");
const WIN = globalThis.window;
const OTHER = { name: "janela solta" } as unknown as Window;

describe("trayVolume", () => {
    let calls = 0;
    let off: () => void;

    beforeEach(() => {
        resetVencordFakes();
        resetTrayVolume();
        calls = 0;
        off = subscribeTray(() => void calls++);
    });

    afterEach(() => {
        off();
        cleanup();
        resetTrayVolume();
    });

    test("tile com som: grava a chave, troca a chave e so o mesmo token limpa", () => {
        assert.equal(getTileAudioKey(U), null);
        setTileAudio(U, A, "k1");
        assert.equal(getTileAudioKey(U), "k1");
        setTileAudio(U, A, "k2");
        assert.equal(getTileAudioKey(U), "k2");

        setTileAudio(U, B, null); // outra tile: nao apaga
        assert.equal(getTileAudioKey(U), "k2");
        setTileAudio(U, A, null);
        assert.equal(getTileAudioKey(U), null);
        setTileAudio(U, A, null); // ja limpo: nada
    });

    test("uma tile nova assume o registro e a antiga nao consegue apagar", () => {
        setTileAudio(U, A, "k1");
        setTileAudio(U, B, "k1");
        setTileAudio(U, A, null);
        assert.equal(getTileAudioKey(U), "k1");
        setTileAudio(U, B, null);
        assert.equal(getTileAudioKey(U), null);
    });

    test("barra no comando: contador e desfazer idempotente", () => {
        assert.equal(isTrayBarActive(U, WIN), false);
        const a = registerTrayBar(U, WIN);
        const b = registerTrayBar(U, WIN);
        assert.equal(isTrayBarActive(U, WIN), true);
        a();
        a(); // segunda chamada nao desconta de novo
        assert.equal(isTrayBarActive(U, WIN), true);
        b();
        assert.equal(isTrayBarActive(U, WIN), false);
    });

    test("desfazer depois do reset nao faz nada", () => {
        const a = registerTrayBar(U, WIN);
        resetTrayVolume();
        const before = calls;
        a();
        assert.equal(calls, before);
        assert.equal(isTrayBarActive(U, WIN), false);
    });

    test("uma janela nao enxerga a barra da outra; sem janela nunca esta ativa", () => {
        const a = registerTrayBar(U, WIN);
        assert.equal(isTrayBarActive(U, WIN), true);
        assert.equal(isTrayBarActive(U, OTHER), false);
        assert.equal(isTrayBarActive(U, null), false);
        assert.equal(isTrayBarActive(U, undefined), false);
        const b = registerTrayBar(U, OTHER);
        a();
        assert.equal(isTrayBarActive(U, WIN), false);
        assert.equal(isTrayBarActive(U, OTHER), true, "a outra janela segue");
        b();
        assert.equal(isTrayBarActive(U, OTHER), false);
    });

    test("avisa a cada mudanca do par usuario e janela", () => {
        const before = calls;
        const a = registerTrayBar(U, WIN);
        assert.equal(calls, before + 1);
        const b = registerTrayBar(U, OTHER);
        assert.equal(calls, before + 2, "outra janela e outro estado");
        a();
        b();
        assert.equal(calls, before + 4);
    });

    test("desfazer antigo (de antes do reset) nao tira uma barra registrada depois", () => {
        const old = registerTrayBar(U, WIN);
        resetTrayVolume();
        const fresh = registerTrayBar(U, WIN);
        old();
        assert.equal(isTrayBarActive(U, WIN), true);
        fresh();
        assert.equal(isTrayBarActive(U, WIN), false);
    });

    test("so avisa quando algo muda de verdade", () => {
        setTileAudio(U, A, "k1");
        assert.equal(calls, 1);
        setTileAudio(U, A, "k1");
        assert.equal(calls, 1, "mesma tile e mesma chave");
        setTileAudio(U, B, null);
        assert.equal(calls, 1, "token de outra tile");

        const a = registerTrayBar(U, WIN);
        assert.equal(calls, 2);
        const b = registerTrayBar(U, WIN);
        assert.equal(calls, 2, "ja havia barra");
        a();
        assert.equal(calls, 2, "ainda sobra uma barra");
        b();
        assert.equal(calls, 3);
        setTileAudio(U, A, null);
        assert.equal(calls, 4);
    });

    test("um listener que falha e logado e os outros seguem", () => {
        let other = 0;
        const offBad = subscribeTray(() => {
            throw new Error("boom");
        });
        const offOther = subscribeTray(() => void other++);
        setTileAudio(U, A, "k1");
        assert.equal(other, 1);
        assert.equal(calls, 1);
        assert.equal(loggerLines.find(l => l.level === "error")?.args[0], "Listener do volume da barra falhou");
        offBad();
        offOther();
    });

    test("reset limpa tudo e avisa; useTrayVersion acompanha", () => {
        const { result } = renderHook(() => useTrayVersion());
        const before = result.current;
        act(() => setTileAudio(U, A, "k1"));
        assert.ok(result.current > before);
        act(() => void registerTrayBar(U, WIN));
        const mid = calls;
        act(() => resetTrayVolume());
        assert.equal(calls, mid + 1);
        assert.equal(getTileAudioKey(U), null);
        assert.equal(isTrayBarActive(U, WIN), false);
    });
});
