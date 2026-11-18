/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da ligacao automatica do som da tela pelo Chromium (core/screenAudioChromium.ts): o ajudante bloqueado/ausente
// liga o pedido uma vez e avisa; pedido ja salvo nao grava de novo; o interruptor grava; a linha do diagnostico.
// Rodar:  pnpm test:file src/plugins/telinha/core/screenAudioChromium.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { installNative, type NativeEnv } from "@test/fakes/native";
import { resetVencordFakes, toasts } from "@test/fakes/vencord";

import {
    onScreenAudioHelperProblem, refreshScreenAudioChromium, resetScreenAudioChromiumForTests, screenAudioChromiumDiagnostics, screenAudioChromiumLine, screenAudioChromiumNeedsRestart, screenAudioFlagState, setScreenAudioChromiumWanted,
subscribeScreenAudioChromium } from "./screenAudioChromium";
import type { ScreenAudioFlagStatus } from "./screenAudioFlagMain";

let env: NativeEnv | null = null;
const status = (patch: Partial<ScreenAudioFlagStatus> = {}): ScreenAudioFlagStatus => ({ loader: true, saved: false, userOff: false, build: 26300, loaderReason: null, requested: false, applied: null, disableFeatures: null, saveError: null, ...patch });
const calls = (name: string) => env!.calls.filter(c => c.name === name);

function main(initial: Partial<ScreenAudioFlagStatus> = {}, extra: Record<string, (...a: any[]) => any> = {}) {
    let st = status(initial);
    env = installNative({
        screenAudioFlagStatus: async () => st,
        setScreenAudioFlag: async (on: boolean) => (st = { ...st, saved: on }),
        screenAudioChromiumStatus: async () => ({ available: false, reason: "pedido para a próxima partida" }),
        ...extra
    });
}

beforeEach(() => {
    resetVencordFakes();
    resetScreenAudioChromiumForTests();
});

afterEach(() => {
    env?.restore();
    env = null;
    resetScreenAudioChromiumForTests();
});

describe("ligacao automatica", () => {
    test("ajudante bloqueado: grava o pedido uma vez e avisa", async () => {
        main();
        assert.equal(await onScreenAudioHelperProblem("blocked"), true);
        assert.deepEqual(calls("setScreenAudioFlag").map(c => c.args), [[true]]);
        assert.deepEqual(toasts, [{ text: "O Windows bloqueou o ajudante de áudio do Telinha. Reabra o Discord para o som da tela passar a sair pelo próprio Discord.", variant: "default" }]);

        assert.equal(await onScreenAudioHelperProblem("blocked"), false, "so uma vez");
        assert.equal(calls("setScreenAudioFlag").length, 1);
        assert.equal(toasts.length, 1);
    });

    test("ajudante ausente: grava e avisa com o texto da ausencia", async () => {
        main();
        assert.equal(await onScreenAudioHelperProblem("missing"), true);
        assert.match(toasts[0].text, /^O ajudante de áudio do Telinha não está instalado\. Reabra o Discord/);
    });

    test("pedido ja salvo: nao grava de novo nem avisa", async () => {
        main({ saved: true });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        assert.equal(calls("setScreenAudioFlag").length, 0);
        assert.equal(toasts.length, 0);
    });

    test("o usuario desligou pelo interruptor: a ligacao automatica nao religa", async () => {
        main({ userOff: true });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        assert.equal(calls("setScreenAudioFlag").length, 0);
        assert.equal(toasts.length, 0);
    });

    test("duas chamadas concorrentes: uma gravacao e um aviso", async () => {
        main();
        const results = await Promise.all([onScreenAudioHelperProblem("blocked"), onScreenAudioHelperProblem("blocked")]);
        assert.deepEqual(results.sort(), [false, true]);
        assert.equal(calls("setScreenAudioFlag").length, 1);
        assert.equal(toasts.length, 1);
    });

    test("sem o loader do add-on: nao grava, nao avisa", async () => {
        main({ loader: false });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        assert.equal(calls("setScreenAudioFlag").length, 0);
        assert.equal(toasts.length, 0);
    });

    test("a gravacao falhou: nao avisa que ligou", async () => {
        main({}, { setScreenAudioFlag: async () => status({ saved: false, saveError: "disco cheio" }) });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        assert.equal(toasts.length, 0);
    });

    test("nunca desliga sozinho: so setScreenAudioFlag(true)", async () => {
        main();
        await onScreenAudioHelperProblem("blocked");
        assert.ok(calls("setScreenAudioFlag").every(c => c.args[0] === true));
    });
});

describe("interruptor e linhas", () => {
    test("o interruptor grava o pedido e o estado volta a ser lido", async () => {
        main();
        await setScreenAudioChromiumWanted(true);
        assert.deepEqual(calls("setScreenAudioFlag").map(c => c.args), [[true]]);
        assert.match(screenAudioChromiumDiagnostics(), /salvo para a próxima: ligado/);
        await setScreenAudioChromiumWanted(false);
        assert.deepEqual(calls("setScreenAudioFlag").map(c => c.args), [[true], [false]]);
        assert.match(screenAudioChromiumDiagnostics(), /salvo para a próxima: desligado/);
    });

    test("linha das configuracoes: ligado nesta partida, pedido para a proxima, desligado", () => {
        assert.match(screenAudioChromiumLine(status({ saved: true, requested: true, applied: true })), /ligado nesta partida do Discord\.$/);
        assert.match(screenAudioChromiumLine(status({ saved: true })), /pedido para a próxima partida; reabra o Discord para ligar\.$/);
        assert.match(screenAudioChromiumLine(status()), /desligado\.$/);
        assert.match(screenAudioChromiumLine(status({ loader: false })), /TelinhaInstaller/);
        assert.equal(screenAudioChromiumNeedsRestart(status({ saved: true })), true);
        assert.equal(screenAudioChromiumNeedsRestart(status({ saved: true, requested: true, applied: true })), false);
        assert.equal(screenAudioChromiumNeedsRestart(status()), false);
    });

    test("diagnostico: pedido salvo, nesta partida e disponibilidade/motivo", async () => {
        assert.equal(screenAudioChromiumDiagnostics(), "Som da tela pelo Chromium (loopbackWithoutChrome): parte nativa sem a opção (ou ainda não lida); não conferido");
        main({ saved: true });
        await refreshScreenAudioChromium();
        assert.equal(screenAudioChromiumDiagnostics(), "Som da tela pelo Chromium (loopbackWithoutChrome): nesta partida não pedido; salvo para a próxima: ligado; indisponível (pedido para a próxima partida)");
        env!.restore();
        main({ saved: true, requested: true, applied: true }, { screenAudioChromiumStatus: async () => ({ available: true, reason: "ok" }) });
        await refreshScreenAudioChromium();
        assert.match(screenAudioChromiumDiagnostics(), /nesta partida aplicado; salvo para a próxima: ligado; disponível$/);
    });
});

describe("erros e native ausente/antigo", () => {
    test("refresh: native ausente nao lanca e devolve null", async () => {
        assert.equal(await refreshScreenAudioChromium(), null);
        assert.equal(screenAudioFlagState(), null);
    });

    test("refresh: native antigo sem as funcoes", async () => {
        main({}, { screenAudioFlagStatus: undefined as never, screenAudioChromiumStatus: undefined as never });
        assert.equal(await refreshScreenAudioChromium(), null);
        assert.equal(screenAudioFlagState(), null);
    });

    test("refresh: valor invalido do estado vira null; chromium com available/reason invalidos", async () => {
        main({}, { screenAudioFlagStatus: async () => ({ loader: "sim" }), screenAudioChromiumStatus: async () => ({ available: "yes", reason: 5 }) });
        assert.deepEqual(await refreshScreenAudioChromium(), { available: false, reason: "" });
        assert.equal(screenAudioFlagState(), null);
        env!.restore();
        main({}, { screenAudioFlagStatus: async () => null, screenAudioChromiumStatus: async () => null });
        assert.deepEqual(await refreshScreenAudioChromium(), { available: false, reason: "" });
        env!.restore();
        main({}, { screenAudioFlagStatus: async () => ({ loader: true, saved: "x" }) });
        await refreshScreenAudioChromium();
        assert.equal(screenAudioFlagState(), null);
    });

    test("refresh: as duas funcoes lancam", async () => {
        main({}, { screenAudioFlagStatus: async () => { throw new Error("ipc caiu"); }, screenAudioChromiumStatus: async () => { throw new Error("outro erro"); } });
        const r = await refreshScreenAudioChromium();
        assert.equal(r?.available, false);
        assert.match(r!.reason, /não consegui conferir o som da tela pelo Chromium: .*outro erro/);
        assert.equal(screenAudioFlagState(), null);
    });

    test("interruptor: native ausente ou antigo nao faz nada", async () => {
        await setScreenAudioChromiumWanted(true);
        main({}, { setScreenAudioFlag: undefined as never });
        await setScreenAudioChromiumWanted(true);
        assert.equal(calls("setScreenAudioFlag").length, 0);
    });

    test("interruptor: saveError e erro lancado nao quebram; valor invalido mantem o estado", async () => {
        main({}, { setScreenAudioFlag: async () => status({ saveError: "disco cheio" }) });
        await setScreenAudioChromiumWanted(true);
        assert.equal(calls("setScreenAudioFlag").length, 1);
        env!.restore();
        main({}, { setScreenAudioFlag: async () => { throw new Error("falhou"); } });
        await setScreenAudioChromiumWanted(true);
        assert.equal(screenAudioFlagState()?.loader, true);
        env!.restore();
        main({}, { setScreenAudioFlag: async () => "lixo" });
        await setScreenAudioChromiumWanted(false);
        assert.equal(screenAudioFlagState()?.saved, false);
    });

    test("ajudante: native ausente ou sem as funcoes", async () => {
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        resetScreenAudioChromiumForTests();
        main({}, { setScreenAudioFlag: undefined as never });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        resetScreenAudioChromiumForTests();
        env!.restore();
        main({}, { screenAudioFlagStatus: undefined as never });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
    });

    test("ajudante: estado invalido, leitura que lanca, gravacao invalida ou que lanca", async () => {
        main({}, { screenAudioFlagStatus: async () => "lixo" });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        resetScreenAudioChromiumForTests();
        env!.restore();
        main({}, { screenAudioFlagStatus: async () => { throw new Error("ipc"); } });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        resetScreenAudioChromiumForTests();
        env!.restore();
        main({}, { setScreenAudioFlag: async () => "lixo" });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
        assert.equal(toasts.length, 0);
        resetScreenAudioChromiumForTests();
        env!.restore();
        main({}, { setScreenAudioFlag: async () => { throw new Error("falhou"); } });
        assert.equal(await onScreenAudioHelperProblem("blocked"), false);
    });

    test("ajudante: gravou mas saveError vem junto no log (sem saved)", async () => {
        main({}, { setScreenAudioFlag: async () => status({ saved: false }) });
        assert.equal(await onScreenAudioHelperProblem("missing"), false);
    });

    test("subscribe avisa e cancela", async () => {
        main();
        let n = 0;
        const off = subscribeScreenAudioChromium(() => n++);
        await refreshScreenAudioChromium();
        assert.equal(n, 1);
        off();
        await refreshScreenAudioChromium();
        assert.equal(n, 1);
    });
});

describe("linhas: todos os estados", () => {
    test("linha", () => {
        assert.match(screenAudioChromiumLine(null), /ainda não lido/);
        assert.match(screenAudioChromiumLine(status({ saveError: "sem permissão" })), /sem permissão\.$/);
        assert.match(screenAudioChromiumLine(status({ requested: true, applied: true, saved: false })), /desligado para a próxima/);
        assert.match(screenAudioChromiumLine(status({ requested: true, applied: false })), /não ligou nesta partida/);
        assert.equal(screenAudioChromiumNeedsRestart(null), false);
        assert.equal(screenAudioChromiumNeedsRestart(status({ loader: false })), false);
        assert.equal(screenAudioChromiumNeedsRestart(status({ saved: true, saveError: "x" })), false);
        assert.equal(screenAudioChromiumNeedsRestart(status({ requested: true, applied: true, saved: false })), true);
    });

    test("diagnostico: sem loader, pedido nao aplicado, pedido sem resposta, saveError", async () => {
        main({ loader: false });
        await refreshScreenAudioChromium();
        assert.match(screenAudioChromiumDiagnostics(), /nesta partida sem o loader do add-on; salvo para a próxima: sem o loader do add-on/);
        env!.restore();
        main({ requested: true, applied: false });
        await refreshScreenAudioChromium();
        assert.match(screenAudioChromiumDiagnostics(), /pedido mas NÃO aplicado/);
        env!.restore();
        main({ requested: true, applied: null, saveError: "disco cheio" });
        await refreshScreenAudioChromium();
        assert.match(screenAudioChromiumDiagnostics(), /nesta partida pedido; .*; disco cheio;/);
    });
});
