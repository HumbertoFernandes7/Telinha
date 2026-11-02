/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado do renderer da live com jogo pesado (core/captureBoost.ts), com os natives de mentira
// (@test/fakes/native): a "Captura pela placa de vídeo" no inicio do plugin (o arquivo do loader volta a bater com a
// opcao), ao mudar a opcao, as linhas da pagina do plugin (ligada / reinicie / nao faz nada neste PC), o botao de
// reiniciar, a linha "Modo da captura" do log e o "Copiar diagnóstico".
// Rodar:  pnpm test:file src/plugins/telinha/core/captureBoost.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { settings } from "@plugins/telinha/settings";
import { getEventLog, resetState } from "@plugins/telinha/store";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings, resetVencordFakes } from "@test/fakes/vencord";

import {
    captureBoostDiagnostics, captureBoostLines, captureBoostNeedsRestart, gpuCaptureNeedsRestart, gpuCaptureState, noteCaptureStarted, onGpuCaptureSettingChanged,
    refreshGpuCapture, resetCaptureBoostForTests, startCaptureBoost, subscribeCaptureBoost
} from "./captureBoost";
import type { GpuCaptureStatus } from "./captureBoostMain";

/** O estado que o main devolve: Windows 11 24H2+, loader presente, nada pedido. */
function status(patch: Partial<GpuCaptureStatus> = {}): GpuCaptureStatus {
    return { loader: true, build: 26300, supported: true, saved: false, requested: false, applied: null, loaderNote: null, enableFeatures: null, saveError: null, ...patch };
}

/** Natives com um capture-flags.json de mentira: gpuCaptureStatus le, setGpuCapture grava. */
function mainWith(initial: Partial<GpuCaptureStatus> = {}, extra: Record<string, (...args: any[]) => any> = {}) {
    const main = { st: status(initial) };
    const env = installNative({
        gpuCaptureStatus: async () => main.st,
        setGpuCapture: async (on: boolean) => (main.st = { ...main.st, saved: on }),
        ...extra
    });
    return { main, env };
}

const messages = () => getEventLog().map(e => e.msg);
let env: NativeEnv | null = null;

beforeEach(() => {
    resetVencordFakes();
    resetState();
    resetCaptureBoostForTests();
});

afterEach(() => {
    env?.restore();
    env = null;
});

describe("o texto da opcao (pagina do plugin)", () => {
    test("cada situacao", () => {
        const cases: [Partial<GpuCaptureStatus> | null, boolean, string | null][] = [
            [null, false, null],
            [null, true, "só funciona com o Telinha instalado pelo TelinhaInstaller"],
            [{ loader: false }, true, "só funciona com o Telinha instalado pelo TelinhaInstaller"],
            [{ supported: false, build: 22631 }, false, "não faz nada neste PC (precisa do Windows 11 24H2 ou mais novo; este é o build 22631)"],
            [{ supported: false, build: 0 }, true, "não faz nada neste PC (precisa do Windows 11 24H2 ou mais novo)"],
            [{}, true, "reinicie o Discord para ligar"],
            [{ requested: true, applied: true }, true, "ligada"],
            [{ requested: true, applied: null }, true, "ligada"],
            [{ requested: true, applied: false }, true, "não ligou nesta partida do Discord (detalhes em \"Copiar diagnóstico\")"],
            [{ requested: true, applied: true }, false, "reinicie o Discord para desligar"],
            [{ requested: true, applied: false }, false, null],
            [{}, false, null],
            [{ saveError: "não consegui salvar a opção (EPERM)" }, true, "não consegui salvar a opção (EPERM)"]
        ];
        for (const [st, on, expected] of cases)
            assert.equal(gpuCaptureState(st && status(st), on), expected, JSON.stringify([st, on]));
    });

    test("o botao de reiniciar so aparece quando reiniciar resolve", () => {
        assert.equal(gpuCaptureNeedsRestart(null, true), false);
        assert.equal(gpuCaptureNeedsRestart(status({ loader: false }), true), false);
        assert.equal(gpuCaptureNeedsRestart(status({ supported: false }), true), false);
        assert.equal(gpuCaptureNeedsRestart(status({ saveError: "x" }), true), false);
        assert.equal(gpuCaptureNeedsRestart(status(), true), true);
        assert.equal(gpuCaptureNeedsRestart(status({ requested: true, applied: true }), true), false);
        assert.equal(gpuCaptureNeedsRestart(status({ requested: true, applied: true }), false), true);
        assert.equal(gpuCaptureNeedsRestart(status({ requested: true, applied: false }), false), false);
    });
});

describe("inicio do plugin e mudar a opcao", () => {
    test("opcao desligada, nada pedido: le o estado, nao grava, nao loga", async () => {
        ({ env } = mainWith());
        await startCaptureBoost();
        assert.deepEqual(env.calls.map(c => c.name), ["gpuCaptureStatus"]);
        assert.deepEqual(captureBoostLines(), []);
        assert.equal(captureBoostNeedsRestart(), false);
        assert.ok(!messages().some(m => m.startsWith("Modo da captura")));
    });

    test("opcao ligada mas o arquivo diz desligada (mudada sem a parte nativa): grava e pede para reiniciar", async () => {
        pluginSettings.load({ gpuCapture: true });
        let main: { st: GpuCaptureStatus; };
        ({ env, main } = mainWith());
        await startCaptureBoost();
        assert.deepEqual(env.calls.map(c => [c.name, ...c.args]), [["gpuCaptureStatus"], ["setGpuCapture", true]]);
        assert.equal(main!.st.saved, true);
        assert.deepEqual(captureBoostLines(), ["Captura pela placa de vídeo: reinicie o Discord para ligar."]);
        assert.equal(captureBoostNeedsRestart(), true);
        assert.ok(messages().includes("Modo da captura nesta partida do Discord: padrão (cópia pelo processador); captura pela placa de vídeo: reinicie o Discord para ligar"));
    });

    test("ligada e aplicada nesta partida: a linha do log e a da pagina", async () => {
        pluginSettings.load({ gpuCapture: true });
        ({ env } = mainWith({ saved: true, requested: true, applied: true }));
        await startCaptureBoost();
        assert.deepEqual(env.calls.map(c => c.name), ["gpuCaptureStatus"]);
        assert.deepEqual(captureBoostLines(), ["Captura pela placa de vídeo: ligada."]);
        assert.ok(messages().includes("Modo da captura nesta partida do Discord: pela placa de vídeo (WebRtcAllowWgcUsingTexture ligado nesta partida)"));
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: pela placa de vídeo (WebRtcAllowWgcUsingTexture ligado nesta partida)");
    });

    test("a linha 'Modo da captura' quando a opcao nao pegou, e com a opcao desligada", async () => {
        pluginSettings.load({ gpuCapture: true });
        ({ env } = mainWith({ saved: true, requested: true, applied: false }));
        await refreshGpuCapture();
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador); captura pela placa de vídeo: não ligou nesta partida do Discord (detalhes em \"Copiar diagnóstico\")");
        pluginSettings.load({ gpuCapture: false });
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador)");
    });

    test("desligada, mas pedida nesta partida: loga o modo e o arquivo volta a dizer desligada", async () => {
        ({ env } = mainWith({ saved: true, requested: true, applied: true }));
        await startCaptureBoost();
        assert.deepEqual(env.calls.map(c => [c.name, ...c.args]), [["gpuCaptureStatus"], ["setGpuCapture", false]]);
        assert.deepEqual(captureBoostLines(), ["Captura pela placa de vídeo: reinicie o Discord para desligar."]);
    });

    test("mudar a opcao grava para a proxima partida e avisa quem esta olhando a pagina", async () => {
        let main: { st: GpuCaptureStatus; };
        ({ env, main } = mainWith());
        let seen = 0;
        const off = subscribeCaptureBoost(() => seen++);
        settings.store.gpuCapture = true;
        await onGpuCaptureSettingChanged();
        assert.equal(main!.st.saved, true);
        assert.ok(seen >= 1);
        assert.ok(messages().includes("Captura pela placa de vídeo ligada nas configurações: reinicie o Discord para ligar"));

        settings.store.gpuCapture = false;
        await onGpuCaptureSettingChanged();
        assert.ok(messages().includes("Captura pela placa de vídeo desligada nas configurações: nada muda nesta partida"));
        off();
        const before = seen;
        await refreshGpuCapture();
        assert.equal(seen, before, "cancelado");
    });

    test("a opcao na pagina do plugin chama o main (onChange de settings.ts)", async () => {
        ({ env } = mainWith());
        pluginSettings.set("gpuCapture", true);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(env.calls.some(c => c.name === "setGpuCapture" && c.args[0] === true));
    });

    test("nao conseguiu gravar: aviso no log e a linha da pagina diz", async () => {
        ({ env } = mainWith({}, { setGpuCapture: async () => status({ saveError: "não consegui salvar a opção (EPERM)" }) }));
        settings.store.gpuCapture = true;
        await onGpuCaptureSettingChanged();
        assert.ok(messages().includes("Captura pela placa de vídeo: não consegui salvar a opção (EPERM)"));
        assert.deepEqual(captureBoostLines(), ["Captura pela placa de vídeo: não consegui salvar a opção (EPERM)."]);
    });

    test("o main lancando, respondendo lixo ou sem as funcoes (parte nativa antiga): nada quebra", async () => {
        ({ env } = mainWith({}, {
            gpuCaptureStatus: async () => {
                throw new Error("ipc caiu");
            },
            setGpuCapture: async () => {
                throw new Error("ipc caiu de novo");
            }
        }));
        settings.store.gpuCapture = true;
        assert.equal(await refreshGpuCapture(), null);
        await onGpuCaptureSettingChanged();
        assert.ok(messages().includes("Captura pela placa de vídeo: não consegui ler o estado (Error: ipc caiu)"));
        assert.ok(messages().includes("Captura pela placa de vídeo: não consegui salvar a opção (Error: ipc caiu de novo)"));
        env.restore();

        for (const junk of [null, "texto", { loader: "sim" }, { loader: true }]) {
            ({ env } = mainWith({}, { gpuCaptureStatus: async () => junk }));
            assert.equal(await refreshGpuCapture(), null, JSON.stringify(junk));
            env.restore();
        }

        ({ env } = mainWith({}, { gpuCaptureStatus: undefined as never, setGpuCapture: undefined as never }));
        await startCaptureBoost();
        await onGpuCaptureSettingChanged();
        assert.deepEqual(env.calls, []);
        assert.deepEqual(captureBoostLines(), ["Captura pela placa de vídeo: só funciona com o Telinha instalado pelo TelinhaInstaller."]);
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador); captura pela placa de vídeo: só funciona com o Telinha instalado pelo TelinhaInstaller");
    });
});

describe("diagnostico", () => {
    test("sem a parte nativa, e com cada estado", async () => {
        assert.equal(captureBoostDiagnostics(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção desligada; parte nativa sem a opção");

        pluginSettings.load({ gpuCapture: true });
        ({ env } = mainWith({ saved: true, requested: true, applied: true, enableFeatures: "A,WebRtcAllowWgcUsingTexture" }));
        await refreshGpuCapture();
        assert.equal(captureBoostDiagnostics(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção ligada; nesta partida aplicada; salva para a próxima: ligada; "
            + "Windows build 26300 (suporta); enable-features: A,WebRtcAllowWgcUsingTexture");
        env.restore();

        ({ env } = mainWith({ build: 22631, supported: false, requested: true, applied: false, loaderNote: "Windows build 22631: needs 24H2", saveError: "não consegui salvar a opção (EPERM)" }));
        await refreshGpuCapture();
        assert.equal(captureBoostDiagnostics(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção ligada; nesta partida pedida mas NÃO aplicada; "
            + "salva para a próxima: desligada; Windows build 22631 (não suporta); loader: Windows build 22631: needs 24H2; não consegui salvar a opção (EPERM)");
        env.restore();

        ({ env } = mainWith({ loader: false, build: 0, supported: false }));
        await refreshGpuCapture();
        assert.equal(captureBoostDiagnostics(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção ligada; nesta partida não pedida; "
            + "salva para a próxima: sem o loader do add-on; Windows build ? (não suporta)");
        env.restore();

        ({ env } = mainWith({ requested: true, applied: null }));
        await refreshGpuCapture();
        assert.match(captureBoostDiagnostics(), /; nesta partida pedida; /);
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: pela placa de vídeo (WebRtcAllowWgcUsingTexture ligado nesta partida)", "pedida, ainda sem a leitura do app ready");
    });

    test("configuracoes indisponiveis: uma linha de aviso, nunca uma excecao (o resto do diagnostico copia)", t => {
        const store = t.mock.getter(settings, "store", () => {
            throw new Error("configuracoes indisponiveis");
        });
        assert.equal(captureBoostDiagnostics(), "captura pela placa de vídeo: diagnóstico indisponível (configuracoes indisponiveis)");
        store.mock.mockImplementation(() => {
            throw "texto solto";
        });
        assert.equal(captureBoostDiagnostics(), "captura pela placa de vídeo: diagnóstico indisponível (texto solto)");
    });
});
