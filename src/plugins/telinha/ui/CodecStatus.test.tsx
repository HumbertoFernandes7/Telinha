/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da linha abaixo de "Formato de vídeo" na pagina do plugin (ui/CodecStatus.tsx), renderizada de verdade (React +
// happy-dom) com os natives de mentira: nada sem o AV1 fixado; com ele, "reinicie o Discord para ligar o AV1 da placa"
// e o botao, que reinicia o Discord (ou avisa como fazer).
// Rodar:  pnpm test:file src/plugins/telinha/ui/CodecStatus.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { resetAv1FlagForTests } from "@plugins/telinha/core/av1Flag";
import type { Av1FlagStatus } from "@plugins/telinha/core/av1FlagMain";
import { settings } from "@plugins/telinha/settings";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { pluginSettings, resetVencordFakes, toasts } from "@test/fakes/vencord";

import { CodecStatus, codecStatusElement } from "./CodecStatus";

const w = window as { DiscordNative?: unknown; };
let env: NativeEnv | null = null;
const RESTART = "AV1: reinicie o Discord para ligar o AV1 da placa de vídeo; até lá, vai o do Automático.";

function main(patch: Partial<Av1FlagStatus> = {}) {
    const st: Av1FlagStatus = { loader: true, saved: false, requested: false, applied: null, saveError: null, ...patch };
    env = installNative({ av1FlagStatus: async () => st, setAv1Flag: async (on: boolean) => ({ ...st, saved: on }) });
}

beforeEach(() => {
    resetVencordFakes();
    resetAv1FlagForTests();
});

afterEach(() => {
    env?.restore();
    env = null;
    delete w.DiscordNative;
    resetAv1FlagForTests();
});

test("o AV1 nao fixado: nada aparece", async () => {
    main();
    const { container } = render(<CodecStatus />);
    await settle();
    assert.equal(container.textContent, "");
});

test("fixar o AV1: 'reinicie o Discord para ligar' e o botao, que reinicia o Discord inteiro", async () => {
    main();
    const relaunch = { calls: 0 };
    w.DiscordNative = { app: { relaunch: () => relaunch.calls++ } };
    render(<CodecStatus />);
    await settle();
    act(() => {
        settings.store.codec = "av1";
    });
    await settle();
    assert.ok(screen.getByText(RESTART));
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar o Discord agora" }));
    });
    assert.equal(relaunch.calls, 1);
    assert.deepEqual(toasts, []);
});

test("sem como reiniciar daqui: o aviso diz como fazer", async () => {
    pluginSettings.load({ codec: "av1" });
    main();
    render(<CodecStatus />);
    await settle();
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar o Discord agora" }));
    });
    assert.deepEqual(toasts.map(t => t.text), ["Feche o Discord por completo (inclusive da bandeja) e abra de novo"]);
});

test("ligado nesta partida: so a linha do que falta deste PC, sem botao; e o que settings.ts entrega ao Vencord", async () => {
    pluginSettings.load({ codec: "av1" });
    main({ saved: true, requested: true, applied: true });
    const def = settings.def.codecStatus as { component(props: unknown): ReturnType<typeof codecStatusElement>; };
    render(def.component({}));
    await settle();
    assert.ok(screen.getByText(/^AV1: .*; vai o do Automático\.$/));
    assert.equal(screen.queryByRole("button"), null);
});
