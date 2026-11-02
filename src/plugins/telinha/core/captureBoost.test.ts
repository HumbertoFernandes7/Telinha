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
    captureBoostDiagnostics, captureBoostLines, captureBoostNeedsRestart, captureEndedText, gpuCaptureNeedsRestart, gpuCaptureState, gpuPriorityState, noteCaptureStarted,
    noteCaptureStopped, onGpuCaptureSettingChanged, onGpuPrioritySettingChanged, refreshGpuCapture, resetCaptureBoostForTests, startCaptureBoost,
    subscribeCaptureBoost
} from "./captureBoost";
import type { GpuCaptureStatus, GpuPriorityReport } from "./captureBoostMain";
import { rt } from "./context";

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
/** a linha da "Captura pela placa de vídeo" no "Copiar diagnóstico" (a segunda e a da prioridade) */
const firstDiagLine = () => captureBoostDiagnostics().split("\n")[0];
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
        assert.equal(messages().at(-1), "Modo da captura: pela placa de vídeo (WebRtcAllowWgcUsingTexture ligado nesta partida) · prioridade na placa de vídeo: normal (opção desligada)");
    });

    test("a linha 'Modo da captura' quando a opcao nao pegou, e com a opcao desligada", async () => {
        pluginSettings.load({ gpuCapture: true });
        ({ env } = mainWith({ saved: true, requested: true, applied: false }));
        await refreshGpuCapture();
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador); captura pela placa de vídeo: não ligou nesta partida do Discord (detalhes em \"Copiar diagnóstico\") · prioridade na placa de vídeo: normal (opção desligada)");
        pluginSettings.load({ gpuCapture: false });
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador) · prioridade na placa de vídeo: normal (opção desligada)");
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
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador); captura pela placa de vídeo: só funciona com o Telinha instalado pelo TelinhaInstaller · prioridade na placa de vídeo: normal (opção desligada)");
    });
});

describe("diagnostico", () => {
    test("sem a parte nativa, e com cada estado", async () => {
        assert.equal(firstDiagLine(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção desligada; parte nativa sem a opção");

        pluginSettings.load({ gpuCapture: true });
        ({ env } = mainWith({ saved: true, requested: true, applied: true, enableFeatures: "A,WebRtcAllowWgcUsingTexture" }));
        await refreshGpuCapture();
        assert.equal(firstDiagLine(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção ligada; nesta partida aplicada; salva para a próxima: ligada; "
            + "Windows build 26300 (suporta); enable-features: A,WebRtcAllowWgcUsingTexture");
        env.restore();

        ({ env } = mainWith({ build: 22631, supported: false, requested: true, applied: false, loaderNote: "Windows build 22631: needs 24H2", saveError: "não consegui salvar a opção (EPERM)" }));
        await refreshGpuCapture();
        assert.equal(firstDiagLine(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção ligada; nesta partida pedida mas NÃO aplicada; "
            + "salva para a próxima: desligada; Windows build 22631 (não suporta); loader: Windows build 22631: needs 24H2; não consegui salvar a opção (EPERM)");
        env.restore();

        ({ env } = mainWith({ loader: false, build: 0, supported: false }));
        await refreshGpuCapture();
        assert.equal(firstDiagLine(), "captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção ligada; nesta partida não pedida; "
            + "salva para a próxima: sem o loader do add-on; Windows build ? (não suporta)");
        env.restore();

        ({ env } = mainWith({ requested: true, applied: null }));
        await refreshGpuCapture();
        assert.match(captureBoostDiagnostics(), /; nesta partida pedida; /);
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: pela placa de vídeo (WebRtcAllowWgcUsingTexture ligado nesta partida) · prioridade na placa de vídeo: normal (opção desligada)",
            "pedida, ainda sem a leitura do app ready");
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

describe("prioridade da captura na placa de video", () => {
    const P = "Prioridade da captura na placa de vídeo";
    const both = (before: string | null, after: string | null, error: string | null = null): GpuPriorityReport["targets"] => [
        { pid: 1234, role: "Discord", before, after, kept: false, error }, { pid: 5678, role: "GPU", before, after, kept: false, error }
    ];
    /** como o main descreve o processo da GPU que o Discord ja deixou em REALTIME (o Telinha nao mexe) */
    const gpuRealtime: GpuPriorityReport["targets"][number] = { pid: 5678, role: "GPU", before: "REALTIME", after: "REALTIME", kept: true, error: null };
    const NORMAL_TO_HIGH = "Discord NORMAL→HIGH, GPU do Discord NORMAL→HIGH";
    const report = (patch: Partial<GpuPriorityReport> = {}): GpuPriorityReport => ({
        mode: "high", ok: true, done: 2, hags: "on", reason: null, refused: false, raised: 2, quiet: false, notes: [], targets: both("NORMAL", "HIGH"), ...patch
    });
    const restored = (patch: Partial<GpuPriorityReport> = {}) => report({ mode: "restore", raised: 0, targets: both("HIGH", "NORMAL"), ...patch });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const priorityCalls = () => env!.calls.filter(c => c.name === "setGpuPriority").map(c => c.args[0]);

    /** natives: o "high" responde `high`, o "restore" responde `restore` */
    function nativeWith(high: unknown = report(), restore: unknown = restored()) {
        env = installNative({ setGpuPriority: async (mode: string) => (mode === "high" ? high : restore) });
    }

    afterEach(() => {
        rt.local = null;
    });

    test("ligada: a transmissao pede HIGH, o log diz o modo e a resposta; parar volta ao normal", async () => {
        pluginSettings.load({ gpuPriority: true });
        nativeWith();
        assert.deepEqual(captureBoostLines(), [`${P}: vale quando você transmitir.`]);
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador) · prioridade na placa de vídeo: pedindo alta");
        assert.deepEqual(captureBoostLines(), [`${P}: pedindo prioridade alta.`]);
        await flush();
        assert.deepEqual(priorityCalls(), ["high"]);
        assert.equal(messages().at(-1), `${P}: alta — Discord 1234 NORMAL→HIGH, GPU do Discord 5678 NORMAL→HIGH; HAGS ligado`);
        assert.deepEqual(captureBoostLines(), [`${P}: alta nesta transmissão — ${NORMAL_TO_HIGH}.`]);
        assert.match(captureBoostDiagnostics().split("\n")[1], /^prioridade da captura na placa de vídeo: opção ligada; agora alta \(pedida nesta transmissão\); última: alta — Discord 1234/);

        // trocar de fonte: continua alta, sem pedir de novo
        noteCaptureStarted();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador) · prioridade na placa de vídeo: alta (continua da fonte anterior)");
        await flush();
        assert.deepEqual(priorityCalls(), ["high"]);

        noteCaptureStopped();
        await flush();
        assert.deepEqual(priorityCalls(), ["high", "restore"]);
        assert.equal(messages().at(-1), `${P}: de volta ao normal (transmissão encerrada) — Discord 1234 HIGH→NORMAL, GPU do Discord 5678 HIGH→NORMAL; HAGS ligado`);
        assert.deepEqual(captureBoostLines(), [`${P}: vale quando você transmitir (na última vez ficou alta) — ${NORMAL_TO_HIGH}.`]);

        // parar de novo: nada a voltar
        noteCaptureStopped();
        await flush();
        assert.deepEqual(priorityCalls(), ["high", "restore"]);
    });

    test("o processo da GPU ja em REALTIME: o log e a pagina dizem 'já estava REALTIME', na subida e na volta", async () => {
        // o log do dono em 02/11/2026 dizia "GPU do Discord 17188 REALTIME→HIGH", e a volta nem citava o processo da GPU
        pluginSettings.load({ gpuPriority: true });
        nativeWith(
            report({ raised: 1, targets: [both("NORMAL", "HIGH")[0], gpuRealtime] }),
            restored({ targets: [both("HIGH", "NORMAL")[0], gpuRealtime] })
        );
        noteCaptureStarted();
        await flush();
        assert.equal(getEventLog().at(-1)!.level, "info");
        assert.equal(messages().at(-1), `${P}: alta — Discord 1234 NORMAL→HIGH, GPU do Discord 5678 já estava REALTIME; HAGS ligado`);
        assert.deepEqual(captureBoostLines(), [`${P}: alta nesta transmissão — Discord NORMAL→HIGH, GPU do Discord já estava REALTIME.`]);
        assert.match(captureBoostDiagnostics().split("\n")[1], /; última: alta — Discord 1234 NORMAL→HIGH, GPU do Discord 5678 já estava REALTIME; HAGS ligado$/);
        noteCaptureStopped();
        await flush();
        assert.equal(messages().at(-1), `${P}: de volta ao normal (transmissão encerrada) — Discord 1234 HIGH→NORMAL, GPU do Discord 5678 já estava REALTIME; HAGS ligado`);
    });

    test("o Windows recusa: a transmissao segue; aviso no log e 'não foi possível: o Windows recusou (talvez precise de administrador)'", async () => {
        pluginSettings.load({ gpuPriority: true });
        nativeWith(report({ ok: false, done: 0, refused: true, raised: 0, hags: "off", targets: both(null, null, "open 0x80070005 Acesso negado.") }), restored({ targets: [] }));
        noteCaptureStarted();
        await flush();
        const last = getEventLog().at(-1)!;
        assert.equal(last.level, "warn");
        assert.equal(last.msg, `${P}: não foi possível: o Windows recusou (talvez precise de administrador) — Discord 1234 open 0x80070005 Acesso negado., GPU do Discord 5678 open 0x80070005 Acesso negado.; HAGS desligado`);
        assert.deepEqual(captureBoostLines(), [`${P}: não foi possível: o Windows recusou (talvez precise de administrador).`]);
        noteCaptureStopped();
        await flush();
        assert.equal(getEventLog().at(-1)!.msg, last.msg, "nada voltou: sem linha nova");
    });

    test("so parte subiu, um motivo geral, ou um erro que nao e de administrador", async () => {
        pluginSettings.load({ gpuPriority: true });
        const partial = report({ ok: false, done: 1, refused: true, raised: 1, hags: null });
        partial.targets[1] = { ...partial.targets[1], before: null, after: null, error: "open 0x80070005 Acesso negado." };
        // [relatorio, resultado, resto da linha do log, resto da linha da pagina (sem pids; o que nao mudou nao diz o erro)]
        const cases: [GpuPriorityReport, string, string, string][] = [
            [partial, "alta em 1 de 2 processos do Discord; no resto, o Windows recusou (talvez precise de administrador)", " — Discord 1234 NORMAL→HIGH, GPU do Discord 5678 open 0x80070005 Acesso negado.; HAGS desconhecido",
                " — Discord NORMAL→HIGH, GPU do Discord não mudou"],
            [report({ ok: false, done: 1, refused: false, targets: [partial.targets[0], { ...partial.targets[1], error: "sem resposta do ajudante" }] }), "alta em 1 de 2 processos do Discord", " — Discord 1234 NORMAL→HIGH, GPU do Discord 5678 sem resposta do ajudante; HAGS ligado",
                " — Discord NORMAL→HIGH, GPU do Discord não mudou"],
            [report({ ok: false, done: 0, reason: "o ajudante do Telinha (telinha-audio.exe) não foi instalado", targets: both(null, null) }), "não foi possível: o ajudante do Telinha (telinha-audio.exe) não foi instalado", "; HAGS ligado", ""],
            [report({ ok: false, done: 0, targets: both(null, null, "tree 0x80070005") }), "não foi possível: detalhes em \"Copiar diagnóstico\"", " — Discord 1234 tree 0x80070005, GPU do Discord 5678 tree 0x80070005; HAGS ligado", ""]
        ];
        for (const [high, outcome, rest, page] of cases) {
            resetCaptureBoostForTests();
            env?.restore();
            nativeWith(high, restored({ targets: [] }));
            noteCaptureStarted();
            await flush();
            assert.equal(messages().at(-1), `${P}: ${outcome}${rest}`);
            assert.deepEqual(captureBoostLines(), [`${P}: ${outcome}${page}.`]);
        }
    });

    test("a volta que falha tambem so avisa", async () => {
        pluginSettings.load({ gpuPriority: true });
        nativeWith(report(), restored({ ok: false, done: 0, reason: "o ajudante do Telinha (telinha-audio.exe) não foi instalado", targets: both(null, null) }));
        noteCaptureStarted();
        await flush();
        noteCaptureStopped();
        await flush();
        assert.equal(getEventLog().at(-1)!.level, "warn");
        assert.equal(messages().at(-1), `${P}: não voltou tudo ao normal (transmissão encerrada; o ajudante do Telinha (telinha-audio.exe) não foi instalado); `
            + "tento de novo na próxima transmissão ou ao reabrir o Discord; HAGS ligado");

        resetCaptureBoostForTests();
        env!.restore();
        nativeWith(report(), restored({ ok: false, done: 1, targets: [both("HIGH", "NORMAL")[0], { pid: 5678, role: "GPU", before: null, after: null, kept: false, error: "open 0x80070057 O parâmetro está incorreto." }] }));
        noteCaptureStarted();
        await flush();
        noteCaptureStopped();
        await flush();
        assert.equal(messages().at(-1), `${P}: não voltou tudo ao normal (transmissão encerrada); tento de novo na próxima transmissão ou ao reabrir o Discord `
            + "— Discord 1234 HIGH→NORMAL, GPU do Discord 5678 open 0x80070057 O parâmetro está incorreto.; HAGS ligado");
    });

    test("o pedido que falha no IPC ou volta lixo: aviso no log, a transmissao segue, e parar ainda tenta voltar", async () => {
        pluginSettings.load({ gpuPriority: true });
        env = installNative({
            setGpuPriority: async (mode: string) => {
                if (mode === "high") throw new Error("ipc caiu");
                return { lixo: true };
            }
        });
        noteCaptureStarted();
        await flush();
        assert.equal(messages().at(-1), `${P}: o pedido falhou (Error: ipc caiu)`);
        assert.deepEqual(captureBoostLines(), [`${P}: pedindo prioridade alta.`]);
        assert.match(captureBoostDiagnostics().split("\n")[1], /; agora alta \(pedida nesta transmissão\); nenhuma tentativa nesta partida$/);
        noteCaptureStopped();
        await flush();
        assert.deepEqual(priorityCalls(), ["high", "restore"]);
    });

    test("sem a funcao na parte nativa: nada pedido, e a pagina e o log dizem", async () => {
        pluginSettings.load({ gpuPriority: true });
        env = installNative({});
        noteCaptureStarted();
        await flush();
        assert.equal(messages().at(-1), "Modo da captura: padrão (cópia pelo processador) · prioridade na placa de vídeo: normal (só funciona com o Telinha instalado pelo TelinhaInstaller)");
        assert.deepEqual(captureBoostLines(), [`${P}: só funciona com o Telinha instalado pelo TelinhaInstaller.`]);
        assert.equal(captureBoostDiagnostics().split("\n")[1], "prioridade da captura na placa de vídeo: opção ligada; agora normal; parte nativa sem a opção; nenhuma tentativa nesta partida");
        assert.equal(gpuPriorityState(false, true, false, null), null);
    });

    test("mudar a opcao: fora do ar so vale na proxima; no ar liga e desliga na hora (onChange de settings.ts)", async () => {
        nativeWith();
        pluginSettings.set("gpuPriority", true);
        assert.equal(messages().at(-1), `${P} ligada nas configurações: vale na próxima transmissão`);
        await flush();
        assert.deepEqual(priorityCalls(), []);

        rt.local = {} as typeof rt.local;
        pluginSettings.set("gpuPriority", false);
        assert.equal(messages().at(-1), `${P} desligada nas configurações`);
        pluginSettings.set("gpuPriority", true);
        assert.equal(messages().at(-1), `${P} ligada nas configurações`);
        await flush();
        assert.deepEqual(priorityCalls(), ["high"]);
        onGpuPrioritySettingChanged(); // de novo, ja alta: nada
        await flush();
        assert.deepEqual(priorityCalls(), ["high"]);
        pluginSettings.set("gpuPriority", false);
        await flush();
        assert.deepEqual(priorityCalls(), ["high", "restore"]);
        assert.equal(messages().at(-1), `${P}: de volta ao normal (opção desligada) — Discord 1234 HIGH→NORMAL, GPU do Discord 5678 HIGH→NORMAL; HAGS ligado`);

        env!.restore();
        env = installNative({});
        pluginSettings.set("gpuPriority", true);
        await flush();
        assert.deepEqual(priorityCalls(), [], "sem a funcao na parte nativa: nada");
    });

    test("inicio do plugin: o que ficou em HIGH de antes de recarregar volta ao normal; sem nada, nenhum log", async () => {
        nativeWith(report(), restored());
        await startCaptureBoost();
        assert.equal(messages().at(-1), `${P}: de volta ao normal (início do Telinha) — Discord 1234 HIGH→NORMAL, GPU do Discord 5678 HIGH→NORMAL; HAGS ligado`);
        env!.restore();
        const before = messages().length;
        nativeWith(report(), restored({ targets: [] }));
        await startCaptureBoost();
        assert.equal(messages().length, before);
    });

    test("as notas do main (o processo da GPU reiniciou) vao para o log; a volta que falha de novo do mesmo jeito (quiet) nao", async () => {
        pluginSettings.load({ gpuPriority: true });
        const note = "o processo da GPU do Discord reiniciou às 21:03:04 UTC (5678 → 9999): alta de novo";
        nativeWith(report(), restored({ ok: false, done: 0, refused: true, quiet: true, notes: [note], targets: both(null, null, "open 0x80070005 Acesso negado.") }));
        noteCaptureStarted();
        await flush();
        const before = messages().length;
        noteCaptureStopped();
        await flush();
        assert.deepEqual(messages().slice(before), [`${P}: ${note}`], "a nota sim; a falha repetida nao");
    });

    test("a volta recusada pelo Windows diz que tenta de novo", async () => {
        pluginSettings.load({ gpuPriority: true });
        nativeWith(report(), restored({ ok: false, done: 0, refused: true, targets: both(null, null, "open 0x80070005 Acesso negado.") }));
        noteCaptureStarted();
        await flush();
        noteCaptureStopped();
        await flush();
        assert.match(messages().at(-1)!, /^Prioridade da captura na placa de vídeo: não voltou tudo ao normal \(transmissão encerrada; o Windows recusou \(talvez precise de administrador\)\); tento de novo/);
    });
});

describe("a captura que termina sozinha com a captura pela placa de video ligada", () => {
    test("so com a opcao valendo nesta partida; tela e janela dizem coisas diferentes", async () => {
        assert.equal(captureEndedText("screen"), null, "sem estado lido");
        for (const patch of [{ loader: false, requested: true, applied: true }, { requested: false }, { requested: true, applied: false }]) {
            resetCaptureBoostForTests();
            env?.restore();
            ({ env } = mainWith(patch));
            await refreshGpuCapture();
            assert.equal(captureEndedText("window"), null, JSON.stringify(patch));
        }
        env!.restore();
        ({ env } = mainWith({ requested: true, applied: true }));
        await refreshGpuCapture();
        assert.deepEqual(captureEndedText("screen"), {
            log: "A captura terminou sozinha com a captura pela placa de vídeo ligada: provavelmente a placa de vídeo reiniciou ou trocou (o Chromium não volta sozinho nesse caso)",
            message: "A transmissão parou: a placa de vídeo provavelmente reiniciou. É só transmitir de novo."
        });
        assert.equal(captureEndedText("window")!.message, "A transmissão parou: a janela foi fechada ou a placa de vídeo reiniciou. É só transmitir de novo.");
    });
});
