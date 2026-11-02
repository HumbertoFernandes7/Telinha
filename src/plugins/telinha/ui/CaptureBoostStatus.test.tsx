/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da linha de estado da live com jogo pesado na pagina do plugin (ui/CaptureBoostStatus.tsx), renderizada de
// verdade (React + happy-dom) com os natives de mentira: nada quando nao ha o que dizer; "reinicie o Discord para ligar"
// com o botao, que reinicia o Discord (ou avisa como fazer); a linha acompanha a opcao e a resposta do main.
// Rodar:  pnpm test:file src/plugins/telinha/ui/CaptureBoostStatus.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { resetCaptureBoostForTests } from "@plugins/telinha/core/captureBoost";
import type { GpuCaptureStatus } from "@plugins/telinha/core/captureBoostMain";
import { settings } from "@plugins/telinha/settings";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { pluginSettings, resetVencordFakes, toasts } from "@test/fakes/vencord";

import { CaptureBoostStatus, captureBoostStatusElement } from "./CaptureBoostStatus";

const w = window as { DiscordNative?: unknown; };
let env: NativeEnv | null = null;

function main(patch: Partial<GpuCaptureStatus> = {}) {
    const st: GpuCaptureStatus = { loader: true, build: 26300, supported: true, saved: false, requested: false, applied: null, loaderNote: null, enableFeatures: null, saveError: null, ...patch };
    env = installNative({ gpuCaptureStatus: async () => st, setGpuCapture: async (on: boolean) => ({ ...st, saved: on }) });
}

beforeEach(() => {
    resetVencordFakes();
    resetCaptureBoostForTests();
});

afterEach(() => {
    env?.restore();
    env = null;
    delete w.DiscordNative;
});

test("desligada e nada pendente: nada aparece", async () => {
    main();
    const { container } = render(<CaptureBoostStatus />);
    await settle();
    assert.equal(container.textContent, "");
});

test("ligar a opcao: 'reinicie o Discord para ligar' e o botao, que reinicia o Discord inteiro", async () => {
    main();
    const relaunch = { calls: 0 };
    w.DiscordNative = { app: { relaunch: () => relaunch.calls++ } };
    render(<CaptureBoostStatus />);
    await settle();
    act(() => {
        settings.store.gpuCapture = true;
    });
    await settle();
    assert.ok(screen.getByText("Captura pela placa de vídeo: reinicie o Discord para ligar."));
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar o Discord agora" }));
    });
    assert.equal(relaunch.calls, 1);
    assert.deepEqual(toasts, []);
});

test("sem como reiniciar daqui: o aviso diz como fazer", async () => {
    pluginSettings.load({ gpuCapture: true });
    main();
    render(<CaptureBoostStatus />);
    await settle();
    act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar o Discord agora" }));
    });
    assert.deepEqual(toasts.map(t => t.text), ["Feche o Discord por completo (inclusive da bandeja) e abra de novo"]);
});

test("ligada nesta partida: so a linha, sem botao", async () => {
    pluginSettings.load({ gpuCapture: true });
    main({ saved: true, requested: true, applied: true });
    render(<CaptureBoostStatus />);
    await settle();
    assert.ok(screen.getByText("Captura pela placa de vídeo: ligada."));
    assert.equal(screen.queryByRole("button"), null);
});

test("o que settings.ts entrega ao Vencord (OptionType.COMPONENT chama a funcao direto) e este componente", async () => {
    pluginSettings.load({ gpuCapture: true });
    main({ saved: true, requested: true, applied: true });
    const def = settings.def.captureBoostStatus as { component(props: unknown): ReturnType<typeof captureBoostStatusElement>; };
    render(def.component({}));
    await settle();
    assert.ok(screen.getByText("Captura pela placa de vídeo: ligada."));
});

test("ligar a prioridade na placa de video: a linha dela aparece (sem botao: nao precisa reiniciar)", async () => {
    main();
    env!.restore();
    env = installNative({ ...env!.telinha, setGpuPriority: async () => null });
    render(<CaptureBoostStatus />);
    await settle();
    assert.equal(screen.queryByText(/Prioridade/), null);
    act(() => {
        settings.store.gpuPriority = true;
    });
    await settle();
    assert.ok(screen.getByText("Prioridade da captura na placa de vídeo: vale quando você transmitir."));
    assert.equal(screen.queryByRole("button"), null);
});

test("Windows mais antigo que o 24H2: a linha aparece mesmo com a opcao desligada", async () => {
    main({ supported: false, build: 22631 });
    render(<CaptureBoostStatus />);
    await settle();
    assert.ok(screen.getByText("Captura pela placa de vídeo: não faz nada neste PC (precisa do Windows 11 24H2 ou mais novo; este é o build 22631)."));
    assert.equal(screen.queryByRole("button"), null);
});
