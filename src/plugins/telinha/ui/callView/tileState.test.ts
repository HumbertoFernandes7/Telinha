/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do estado compartilhado das tiles da call (ui/callView/tileState.ts): quem e dono da sessao "Assistir na
// call", quem toca o audio, a graca de 4 s ao desmontar e a previa da propria transmissao (o volume por usuario e
// de ui/volumes.ts).
// O nucleo e o de verdade (sem sala: watch() falha e publica o erro, unwatch() limpa a sessao).
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/tileState.test.ts

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, test } from "node:test";

import { unwatch } from "@plugins/telinha/actions";
import { rt } from "@plugins/telinha/core/context";
import { getState, resetState } from "@plugins/telinha/store";
import { closeAllViewers, openViewer } from "@plugins/telinha/ui/viewerWindows";
import { useFakeClock } from "@test/fakes/clock";
import { act, cleanup, renderHook, settle } from "@test/fakes/render";
import { loggerLines, PopoutActions, resetVencordFakes, toasts } from "@test/fakes/vencord";

import {
    isAudioOwner,
    isLocalPreviewHidden,
    isTileOwned,
    registerTile,
    releaseToWindow,
    resetTileState,
    setLocalPreviewHidden,
    startTileWatch,
    stopTileWatch,
    unregisterTile,
    useTileStateVersion
} from "./tileState";

const PEER = "peerA";

describe("tileState", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
    });

    afterEach(async () => {
        cleanup(); // desmonta os hooks antes de mexer no estado das tiles (sem avisos de act())
        await act(async () => {
            closeAllViewers();
            resetTileState();
            setLocalPreviewHidden(false);
        });
        rt.viewing.clear();
    });

    test("so a primeira tile montada de um amigo toca o som; quando ela sai, a proxima assume", () => {
        const first = registerTile(PEER);
        const second = registerTile(PEER);
        assert.equal(isAudioOwner(PEER, first), true);
        assert.equal(isAudioOwner(PEER, second), false);
        assert.equal(isAudioOwner(PEER, null), false, "tile ainda sem token (primeiro render)");
        assert.equal(isAudioOwner("outro", first), false, "o token vale para o amigo da tile");

        unregisterTile(PEER, first);
        assert.equal(isAudioOwner(PEER, second), true);
        unregisterTile(PEER, second);
        assert.equal(isAudioOwner(PEER, second), false);
    });

    test("quem esta desenhando as tiles e avisado de cada mudanca (useTileStateVersion)", () => {
        const { result } = renderHook(() => useTileStateVersion());
        const v0 = result.current;

        let token!: symbol;
        act(() => void (token = registerTile(PEER)));
        assert.ok(result.current > v0, "registrar uma tile muda a versao");

        const v1 = result.current;
        act(() => setLocalPreviewHidden(true));
        assert.ok(result.current > v1, "ocultar a previa tambem");

        act(() => unregisterTile(PEER, token));
    });

    test("uma tile que falha ao ser avisada nao impede as outras (o erro vai para o log)", t => {
        // o unico assinante de verdade e o do React; um segundo, que lanca, entra pelo mesmo useSyncExternalStore
        const real = createRequire(__filename)("react") as { useSyncExternalStore(subscribe: (fn: () => void) => () => void, snapshot: () => number): number; };
        const original = real.useSyncExternalStore;
        let off: (() => void) | null = null;
        t.mock.method(real, "useSyncExternalStore", (subscribe: (fn: () => void) => () => void, snapshot: () => number) => {
            off ??= subscribe(() => {
                throw new Error("tile quebrada");
            });
            return original(subscribe, snapshot);
        });

        const { result } = renderHook(() => useTileStateVersion());
        const before = result.current;
        act(() => setLocalPreviewHidden(true));
        assert.ok(result.current > before, "a outra tile foi avisada mesmo assim");
        const failure = loggerLines.find(l => l.level === "error");
        assert.equal(failure?.args[0], "Listener das tiles da call falhou");
        assert.match(String((failure?.args[1] as Error).message), /tile quebrada/);
        (off as (() => void) | null)?.();
    });

    test("ocultar a previa da propria transmissao vale ate o Discord fechar", () => {
        assert.equal(isLocalPreviewHidden(), false);
        setLocalPreviewHidden(true);
        assert.equal(isLocalPreviewHidden(), true);
        setLocalPreviewHidden(false);
        assert.equal(isLocalPreviewHidden(), false);
    });

    test("\"Assistir\" na tile: a tile vira dona, o nucleo pede o stream; \"Parar de assistir\" desfaz tudo", async () => {
        startTileWatch(PEER);
        assert.equal(isTileOwned(PEER), true, "dona da sessao assim que clica");
        await settle();
        assert.ok(getState().viewing[PEER], "o nucleo criou a sessao (sem sala, ela falha, mas existe)");

        stopTileWatch(PEER);
        assert.equal(isTileOwned(PEER), false);
        await settle();
        assert.equal(getState().viewing[PEER], undefined, "sem janela aberta: a propria tile chama unwatch");
    });

    test("o nucleo recusa o pedido: a tile deixa de ser dona e o usuario recebe um aviso", async t => {
        t.mock.method(rt.viewing, "set", () => {
            throw new Error("sem sala");
        });
        startTileWatch(PEER);
        assert.equal(isTileOwned(PEER), false, "a posse e devolvida");
        assert.deepEqual(toasts, [{ text: "Telinha: não foi possível assistir — sem sala", variant: "critical" }]);
        await settle();
    });

    test("a sessao que a tile pediu some em outro lugar (fechou a janela): a tile deixa de ser dona", async () => {
        const { result } = renderHook(() => useTileStateVersion());
        act(() => startTileWatch(PEER));
        await settle();
        assert.equal(isTileOwned(PEER), true, "a sessao apareceu e a tile segue dona");

        const before = result.current;
        act(() => unwatch(PEER)); // a janela do visualizador fechou e chamou unwatch
        await settle();
        assert.equal(isTileOwned(PEER), false);
        assert.ok(result.current > before, "as tiles sao re-renderizadas");
    });

    test("com a sessao ainda nao publicada, a tile nao perde a posse (o estado antigo nao mostra sessao)", async () => {
        startTileWatch(PEER);
        // a sessao so aparece no estado no proximo microtask: um estado qualquer publicado antes nao derruba a posse
        act(() => resetState());
        assert.equal(isTileOwned(PEER), true);
        await settle();
    });

    test("\"Abrir em janela\": a janela passa a cuidar da sessao (a tile larga a posse, sem avisar sem motivo)", () => {
        const { result } = renderHook(() => useTileStateVersion());
        act(() => releaseToWindow(PEER));
        const noOwner = result.current;
        act(() => startTileWatch(PEER));
        const owned = result.current;
        assert.ok(owned > noOwner);
        act(() => releaseToWindow(PEER));
        assert.equal(isTileOwned(PEER), false);
        assert.ok(result.current > owned);
        const settled = result.current;
        act(() => releaseToWindow(PEER));
        assert.equal(result.current, settled, "ja nao era dona: nada a avisar");
    });

    test("fechar a tile com a janela do visualizador aberta encerra tudo pela janela (uma vez so)", async () => {
        openViewer(PEER);
        startTileWatch(PEER);
        await settle();
        assert.equal(PopoutActions.opened.length, 1);

        stopTileWatch(PEER);
        assert.deepEqual(PopoutActions.closed, [PopoutActions.opened[0].key], "a janela foi fechada");
        await settle();
        assert.equal(getState().viewing[PEER], undefined);
    });

    describe("graca de 4 s quando todas as tiles do amigo somem", () => {
        test("passou a graca sem nenhuma tile e sem janela: para de assistir", async t => {
            const clock = useFakeClock(t);
            const token = registerTile(PEER);
            startTileWatch(PEER);
            await settle();
            assert.ok(getState().viewing[PEER]);

            unregisterTile(PEER, token);
            clock.tick(3999);
            assert.equal(isTileOwned(PEER), true, "ainda na graca: o Discord remonta tiles ao trocar de layout");
            clock.tick(1);
            assert.equal(isTileOwned(PEER), false);
            assert.ok(loggerLines.some(l => l.level === "info" && /Nenhuma tile mostra mais peerA/.test(String(l.args[0]))));
            await settle();
            assert.equal(getState().viewing[PEER], undefined, "unwatch");
        });

        test("uma tile volta durante a graca: nada e derrubado", async t => {
            const clock = useFakeClock(t);
            const token = registerTile(PEER);
            startTileWatch(PEER);
            await settle();

            unregisterTile(PEER, token);
            clock.tick(2000);
            const again = registerTile(PEER);
            clock.tick(10_000);
            assert.equal(isTileOwned(PEER), true);
            assert.ok(getState().viewing[PEER]);
            unregisterTile(PEER, again);
        });

        test("outra tile do mesmo amigo continua mostrando: a graca nem comeca", async t => {
            const clock = useFakeClock(t);
            const a = registerTile(PEER);
            const b = registerTile(PEER);
            startTileWatch(PEER);
            await settle();

            unregisterTile(PEER, a);
            clock.tick(10_000);
            assert.equal(isTileOwned(PEER), true);
            unregisterTile(PEER, b);
        });

        test("tile que nunca pediu para assistir (so mostrava a etiqueta) nao dispara nada ao sumir", async t => {
            const clock = useFakeClock(t);
            const token = registerTile(PEER);
            unregisterTile(PEER, token);
            clock.tick(10_000);
            await settle();
            assert.equal(loggerLines.some(l => /Nenhuma tile mostra/.test(String(l.args[0]))), false);
        });

        test("a janela do visualizador esta aberta quando a graca acaba: a janela segue dona da sessao", async t => {
            const clock = useFakeClock(t);
            const token = registerTile(PEER);
            startTileWatch(PEER);
            openViewer(PEER);
            await settle();

            unregisterTile(PEER, token);
            clock.tick(4000);
            assert.equal(isTileOwned(PEER), false, "a tile larga a posse");
            await settle();
            assert.ok(getState().viewing[PEER], "mas a sessao continua, e da janela");
            assert.equal(loggerLines.some(l => /Nenhuma tile mostra/.test(String(l.args[0]))), false);
        });

        test("o usuario ja tinha parado de assistir na propria tile durante a graca: nada acontece no fim dela", async t => {
            const clock = useFakeClock(t);
            const token = registerTile(PEER);
            startTileWatch(PEER);
            await settle();

            unregisterTile(PEER, token);
            stopTileWatch(PEER);
            clock.tick(5000);
            assert.equal(loggerLines.some(l => /Nenhuma tile mostra/.test(String(l.args[0]))), false);
        });

        test("um segundo \"sumiu\" na graca nao agenda outro timer", async t => {
            const clock = useFakeClock(t);
            const a = registerTile(PEER);
            startTileWatch(PEER);
            await settle();
            const b = registerTile(PEER);
            unregisterTile(PEER, a);
            unregisterTile(PEER, b);
            // um desregistro repetido (token que ja nao esta na lista) com a graca em andamento
            unregisterTile(PEER, b);
            clock.tick(4000);
            const logs = loggerLines.filter(l => /Nenhuma tile mostra/.test(String(l.args[0])));
            assert.equal(logs.length, 1);
        });
    });

    test("plugin parado: esquece posse e timers de graca, e para de ouvir o estado", async t => {
        const clock = useFakeClock(t);
        const token = registerTile(PEER);
        startTileWatch(PEER);
        await settle();
        unregisterTile(PEER, token);

        const { result } = renderHook(() => useTileStateVersion());
        const before = result.current;
        act(() => resetTileState());
        assert.equal(isTileOwned(PEER), false);
        assert.ok(result.current > before);

        clock.tick(10_000);
        assert.equal(loggerLines.some(l => /Nenhuma tile mostra/.test(String(l.args[0]))), false, "o timer de graca foi cancelado");

        // sem ouvir o estado: uma sessao que some nao mexe em nada
        const quiet = result.current;
        act(() => resetState());
        assert.equal(result.current, quiet);
    });
});
