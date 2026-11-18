/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da opcao "Som da tela pelo proprio Discord" da pagina do plugin (ui/ScreenAudioChromiumOption.tsx): o estado e o
// interruptor, que grava o pedido pelo native.
// Rodar:  pnpm test:file src/plugins/telinha/ui/ScreenAudioChromiumOption.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { resetScreenAudioChromiumForTests } from "@plugins/telinha/core/screenAudioChromium";
import type { ScreenAudioFlagStatus } from "@plugins/telinha/core/screenAudioFlagMain";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { resetVencordFakes, toasts } from "@test/fakes/vencord";

import { screenAudioChromiumElement,ScreenAudioChromiumOption } from "./ScreenAudioChromiumOption";

const w = window as { DiscordNative?: unknown; };
let env: NativeEnv | null = null;

function main(patch: Partial<ScreenAudioFlagStatus> = {}) {
    let st: ScreenAudioFlagStatus = { loader: true, saved: false, userOff: false, build: 26300, requested: false, applied: null, disableFeatures: null, loaderReason: null, saveError: null, ...patch };
    env = installNative({ screenAudioFlagStatus: async () => st, setScreenAudioFlag: async (on: boolean) => (st = { ...st, saved: on }) });
}

beforeEach(() => {
    resetVencordFakes();
    resetScreenAudioChromiumForTests();
});

afterEach(() => {
    delete w.DiscordNative;
    env?.restore();
    env = null;
    resetScreenAudioChromiumForTests();
});

test("desligado: mostra o estado e o interruptor; ligar grava o pedido e pede para reabrir o Discord", async () => {
    main();
    render(<ScreenAudioChromiumOption />);
    await settle();
    screen.getByText("Som da tela pelo próprio Discord (sem o ajudante)");
    screen.getByText("Som da tela pelo próprio Discord: desligado.");
    const sw = screen.getByRole("switch") as HTMLInputElement;
    assert.equal(sw.checked, false);

    fireEvent.click(sw);
    await settle();
    assert.deepEqual(env!.calls.filter(c => c.name === "setScreenAudioFlag").map(c => c.args), [[true]]);
    screen.getByText("Som da tela pelo próprio Discord: pedido para a próxima partida; reabra o Discord para ligar.");
    screen.getByRole("button", { name: "Reiniciar o Discord agora" });
});

test("ligado nesta partida: o interruptor aparece ligado, sem botao de reiniciar", async () => {
    main({ saved: true, requested: true, applied: true });
    render(screenAudioChromiumElement());
    await settle();
    screen.getByText("Som da tela pelo próprio Discord: ligado nesta partida do Discord.");
    assert.equal((screen.getByRole("switch") as HTMLInputElement).checked, true);
    assert.equal(screen.queryByRole("button", { name: "Reiniciar o Discord agora" }), null);
});

test("sem o loader do add-on: o interruptor fica desabilitado", async () => {
    main({ loader: false });
    render(<ScreenAudioChromiumOption />);
    await settle();
    assert.equal((screen.getByRole("switch") as HTMLInputElement).disabled, true);
});

test("o botao reinicia o Discord; sem como reiniciar daqui, o aviso diz como fazer", async () => {
    main({ saved: true });
    const relaunch = { calls: 0 };
    w.DiscordNative = { app: { relaunch: () => relaunch.calls++ } };
    render(<ScreenAudioChromiumOption />);
    await settle();
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar o Discord agora" }));
    });
    assert.equal(relaunch.calls, 1);
    assert.equal(toasts.length, 0);

    delete w.DiscordNative;
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar o Discord agora" }));
    });
    assert.deepEqual(toasts.map(t => t.text), ["Feche o Discord por completo (inclusive da bandeja) e abra de novo"]);
});
