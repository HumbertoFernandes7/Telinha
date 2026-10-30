/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O volume e o mudo escolhidos por amigo (ui/volumes.ts), o que a tile da call e a janela do visualizador compartilham:
// o padrao, guardar e ler, quem e avisado (e quem deixa de ser), a chave por amigo e o hook que re-renderiza.
// Os dois componentes de verdade, juntos, estao em volumeSync.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/volumes.test.ts

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { act, cleanup, renderHook } from "@test/fakes/render";
import { loggerLines, resetVencordFakes } from "@test/fakes/vencord";

import { getVolume, setVolume, subscribeVolumes, useVolume, volumeKeyFor } from "./volumes";

// O que esta guardado vive o processo inteiro (como o Discord aberto): cada teste usa chaves so suas
const A = "300000000000000001";
const B = "300000000000000002";

describe("volumes", () => {
    beforeEach(() => resetVencordFakes());
    afterEach(() => cleanup());

    describe("guardar e ler", () => {
        test("sem registro vale o volume cheio, sem mudo (e e sempre o mesmo objeto, para o React comparar)", () => {
            assert.deepEqual(getVolume("nunca-mexido"), { volume: 1, muted: false });
            assert.ok(getVolume("nunca-mexido") === getVolume("tambem-nao"));
        });

        test("o volume e o mudo ficam guardados por chave; as outras seguem no padrao", () => {
            setVolume(A, { volume: 0.4, muted: true });
            assert.deepEqual(getVolume(A), { volume: 0.4, muted: true });
            assert.deepEqual(getVolume(B), { volume: 1, muted: false });

            setVolume(A, { volume: 0.7, muted: false });
            assert.deepEqual(getVolume(A), { volume: 0.7, muted: false });
        });

        test("guarda uma copia: mexer no objeto que foi passado nao muda o que esta guardado", () => {
            const next = { volume: 0.5, muted: false };
            setVolume("copia", next);
            next.volume = 0.9;
            assert.deepEqual(getVolume("copia"), { volume: 0.5, muted: false });
        });
    });

    describe("chave por amigo", () => {
        test("o usuario do Discord, quando ele veio; senao a conexao", () => {
            assert.equal(volumeKeyFor("peerA", A), A);
            assert.equal(volumeKeyFor("peerA", undefined), "peerA");
            assert.equal(volumeKeyFor("peerA", ""), "peerA");
            assert.equal(volumeKeyFor("peerA"), "peerA");
        });
    });

    describe("avisos", () => {
        test("quem assinou e avisado a cada mudanca; depois de cancelar a assinatura, nao mais", () => {
            let calls = 0;
            const off = subscribeVolumes(() => void calls++);

            setVolume("aviso", { volume: 0.3, muted: false });
            setVolume("aviso", { volume: 0.3, muted: true });
            assert.equal(calls, 2);

            off();
            setVolume("aviso", { volume: 0.8, muted: false });
            assert.equal(calls, 2, "ninguem mais ouvindo");
            off(); // cancelar duas vezes nao quebra nada
        });

        test("repetir o mesmo valor nao avisa ninguem (nem o padrao de quem nunca mexeu)", () => {
            let calls = 0;
            const off = subscribeVolumes(() => void calls++);

            setVolume("repetido", { volume: 1, muted: false });
            assert.equal(calls, 0, "ja era o padrao");
            setVolume("repetido", { volume: 0.5, muted: false });
            setVolume("repetido", { volume: 0.5, muted: false });
            assert.equal(calls, 1);
            off();
        });

        test("um assinante que falha nao impede os outros (o erro vai para o log)", () => {
            let reached = 0;
            const offBroken = subscribeVolumes(() => {
                throw new Error("tile quebrada");
            });
            const offOk = subscribeVolumes(() => void reached++);

            setVolume("falha", { volume: 0.2, muted: false });
            assert.equal(reached, 1, "o outro foi avisado mesmo assim");
            const failure = loggerLines.find(l => l.level === "error");
            assert.equal(failure?.args[0], "Listener dos volumes falhou");
            assert.match(String((failure?.args[1] as Error).message), /tile quebrada/);

            offBroken();
            offOk();
        });

        test("quem assina durante o aviso nao e avisado nessa rodada", () => {
            let late = 0;
            let offLate = () => { };
            const offFirst = subscribeVolumes(() => {
                offLate = subscribeVolumes(() => void late++);
                offFirst();
            });

            setVolume("durante", { volume: 0.6, muted: false });
            assert.equal(late, 0);
            offLate();
        });
    });

    describe("useVolume", () => {
        test("devolve o volume da chave e um setter que guarda e re-renderiza", () => {
            const { result } = renderHook(() => useVolume("hook-a"));
            assert.deepEqual(result.current[0], { volume: 1, muted: false });

            act(() => result.current[1]({ volume: 0.35, muted: false }));
            assert.deepEqual(result.current[0], { volume: 0.35, muted: false });
            assert.deepEqual(getVolume("hook-a"), { volume: 0.35, muted: false });
        });

        test("quem mexe de fora (a outra tela) tambem re-renderiza; dois hooks na mesma chave andam juntos", () => {
            const first = renderHook(() => useVolume("hook-b"));
            const second = renderHook(() => useVolume("hook-b"));

            act(() => setVolume("hook-b", { volume: 0.7, muted: true }));
            assert.deepEqual(first.result.current[0], { volume: 0.7, muted: true });
            assert.deepEqual(second.result.current[0], { volume: 0.7, muted: true });

            act(() => second.result.current[1]({ volume: 0.1, muted: false }));
            assert.deepEqual(first.result.current[0], { volume: 0.1, muted: false });
        });

        test("outra chave mexendo nao re-renderiza este hook", () => {
            let renders = 0;
            renderHook(() => {
                renders++;
                return useVolume("hook-c");
            });
            const before = renders;

            act(() => setVolume("hook-outro", { volume: 0.5, muted: false }));
            assert.equal(renders, before);
        });

        test("trocar a chave (o amigo mudou) passa a mostrar o volume da nova", () => {
            setVolume("hook-d1", { volume: 0.2, muted: false });
            setVolume("hook-d2", { volume: 0.9, muted: true });
            const { result, rerender } = renderHook(({ k }) => useVolume(k), { initialProps: { k: "hook-d1" } });
            assert.deepEqual(result.current[0], { volume: 0.2, muted: false });

            rerender({ k: "hook-d2" });
            assert.deepEqual(result.current[0], { volume: 0.9, muted: true });
            act(() => result.current[1]({ volume: 0.5, muted: false }));
            assert.deepEqual(getVolume("hook-d2"), { volume: 0.5, muted: false });
            assert.deepEqual(getVolume("hook-d1"), { volume: 0.2, muted: false }, "a antiga ficou como estava");
        });
    });
});
