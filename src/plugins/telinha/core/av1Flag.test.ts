/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado do renderer do AV1 da placa (core/av1Flag.ts), com os natives de mentira (@test/fakes/native): o
// pedido do WebRtcAV1HWEncode segue o AV1 fixado (no inicio do plugin, o arquivo do loader volta a bater; ao mudar o
// formato de video, grava), o core/codec.ts fica sabendo se o recurso ligou NESTA partida, e o que a pagina do plugin
// diz (reinicie o Discord, a placa nao codifica AV1, sem o loader...). O lado main (core/av1FlagMain.ts) num
// capture-flags.json de verdade numa pasta temporaria.
// Rodar:  pnpm test:file src/plugins/telinha/core/av1Flag.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { av1FlagStatus, setAv1Flag } from "@plugins/telinha/native";
import { getEventLog, resetState } from "@plugins/telinha/store";
import { ipcEvent } from "@test/fakes/electron";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings, resetVencordFakes } from "@test/fakes/vencord";

import {
    av1FlagDiagnostics, av1FlagNeedsRestart, av1FlagState, av1FlagWanted, codecStatusLines, featureOf, onAv1SettingChanged, refreshAv1Flag, resetAv1FlagForTests, startAv1Flag,
    subscribeAv1Flag
} from "./av1Flag";
import { type Av1FlagStatus, av1FlagStatusMain, setAv1FlagMain } from "./av1FlagMain";
import { setGpuCaptureMain } from "./captureBoostMain";
import { getLocalCaps } from "./codec";

/** O que o main devolve: loader presente, nada pedido. */
function status(patch: Partial<Av1FlagStatus> = {}): Av1FlagStatus {
    return { loader: true, saved: false, requested: false, applied: null, saveError: null, ...patch };
}

/** Natives com um capture-flags.json de mentira: av1FlagStatus le, setAv1Flag grava. */
function mainWith(initial: Partial<Av1FlagStatus> = {}) {
    const main = { st: status(initial), writes: [] as boolean[] };
    const env = installNative({
        av1FlagStatus: async () => main.st,
        setAv1Flag: async (on: boolean) => {
            main.writes.push(on);
            return (main.st = { ...main.st, saved: on });
        }
    });
    return { main, env };
}

const messages = () => getEventLog().map(e => e.msg);
let env: NativeEnv | null = null;

beforeEach(() => {
    resetVencordFakes();
    resetState();
    resetAv1FlagForTests();
});

afterEach(() => {
    env?.restore();
    env = null;
    resetAv1FlagForTests();
});

describe("o pedido segue o AV1 fixado", () => {
    test("inicio do plugin com o AV1 fixado e o arquivo sem o pedido: grava, e diz para reiniciar", async () => {
        pluginSettings.load({ codec: "av1" });
        const m = mainWith();
        env = m.env;
        await startAv1Flag();
        assert.deepEqual(m.main.writes, [true]);
        assert.equal(getLocalCaps().av1HwFeature, false, "nesta partida, ainda desligado");
        assert.ok(messages().includes("AV1 fixado no formato de vídeo: reinicie o Discord para ligar o AV1 da placa de vídeo; até lá, vai o do Automático"), messages().join("\n"));
        assert.equal(av1FlagNeedsRestart(), true);
        assert.deepEqual(codecStatusLines(), ["AV1: reinicie o Discord para ligar o AV1 da placa de vídeo; até lá, vai o do Automático."]);
    });

    test("inicio do plugin com o recurso ja ligado nesta partida: nada a gravar; o codec.ts sabe que ligou", async () => {
        pluginSettings.load({ codec: "av1" });
        const m = mainWith({ saved: true, requested: true, applied: true });
        env = m.env;
        await startAv1Flag();
        assert.deepEqual(m.main.writes, []);
        assert.equal(getLocalCaps().av1HwFeature, true);
        assert.equal(av1FlagNeedsRestart(), false);
        // o lado deste PC (a sonda de codecs nao rodou aqui): nao deu para confirmar, sem culpar o cliente nem a placa
        assert.match(codecStatusLines()[0], /^AV1: não deu para confirmar o AV1 da placa nesta partida \(a medição da placa ainda não terminou\); vai o do Automático\.$/);
    });

    test("tirar o AV1: o pedido sai do arquivo; sem nada salvo, nem grava; o automatico nao pede o recurso", async () => {
        pluginSettings.load({ codec: "auto" });
        const m = mainWith({ saved: true, requested: true, applied: true });
        env = m.env;
        assert.equal(av1FlagWanted(), false);
        await startAv1Flag();
        assert.deepEqual(m.main.writes, [false], "o arquivo volta a bater com o formato");
        await onAv1SettingChanged();
        assert.deepEqual(m.main.writes, [false], "nada salvo: nao grava de novo");
        assert.deepEqual(codecStatusLines(), [], "sem o AV1 fixado: nada a dizer");
        assert.equal(av1FlagNeedsRestart(), false);
    });

    test("fixar o AV1 depois do inicio: grava para a proxima partida e avisa quem escuta (a pagina do plugin)", async () => {
        pluginSettings.load({ codec: "auto" });
        const m = mainWith();
        env = m.env;
        await refreshAv1Flag();
        let changes = 0;
        const off = subscribeAv1Flag(() => changes++);
        // o onChange da opcao (settings.ts) ja chama onAv1SettingChanged
        pluginSettings.set("codec", "av1");
        await onAv1SettingChanged();
        off();
        assert.ok(m.main.writes.length >= 1 && m.main.writes.every(Boolean), JSON.stringify(m.main.writes));
        assert.ok(changes >= 1);
        assert.ok(messages().some(l => l.startsWith("AV1 fixado no formato de vídeo: reinicie o Discord")));
    });

    test("sem a funcao na parte nativa (o native.ts de antes): nada grava, o recurso fica desconhecido", async () => {
        pluginSettings.load({ codec: "av1" });
        env = installNative();
        assert.equal(await refreshAv1Flag(), null);
        await startAv1Flag();
        await onAv1SettingChanged();
        assert.equal(getLocalCaps().av1HwFeature, null);
        assert.equal(av1FlagNeedsRestart(), false);
        assert.match(av1FlagDiagnostics(), /^AV1 da placa \(WebRtcAV1HWEncode\): AV1 fixado; parte nativa sem a opção/);
    });

    test("o main falhando: so o log, nunca lanca", async () => {
        pluginSettings.load({ codec: "av1" });
        env = installNative({
            av1FlagStatus: async () => {
                throw new Error("ipc caiu");
            },
            setAv1Flag: async () => {
                throw new Error("ipc caiu");
            }
        });
        await startAv1Flag();
        await onAv1SettingChanged();
        assert.ok(messages().includes("AV1 da placa: não consegui ler o estado (Error: ipc caiu)"), messages().join("\n"));
        env.restore();
        const m = mainWith({ saveError: "não consegui salvar o pedido do AV1 da placa (EPERM)" });
        env = m.env;
        await onAv1SettingChanged();
        assert.ok(messages().includes("AV1 da placa: não consegui salvar o pedido do AV1 da placa (EPERM)"));
    });
});

describe("o que a pagina e o diagnostico dizem", () => {
    test("featureOf: sem o loader = desconhecido; pedido e no enable-features = ligado; pedido e trocado depois = desligado", () => {
        assert.equal(featureOf(null), null);
        assert.equal(featureOf(status({ loader: false })), null);
        assert.equal(featureOf(status()), false);
        assert.equal(featureOf(status({ requested: true, applied: true })), true);
        assert.equal(featureOf(status({ requested: true, applied: null })), true, "pedido, antes do app ready");
        assert.equal(featureOf(status({ requested: true, applied: false })), false);
    });

    test("av1FlagState: cada caso em pt-BR", () => {
        assert.equal(av1FlagState(status(), false), null);
        assert.equal(av1FlagState(status({ saveError: "x" }), true), "x");
        assert.equal(av1FlagState(status({ loader: false }), true), "o AV1 da placa de vídeo só funciona com o Telinha instalado pelo TelinhaInstaller; vai o do Automático");
        assert.equal(av1FlagState(status({ requested: true, applied: false }), true),
            "o AV1 da placa de vídeo não ligou nesta partida do Discord (detalhes em \"Copiar diagnóstico\"); vai o do Automático");
        assert.equal(av1FlagNeedsRestart(status({ loader: false }), true), false);
        assert.equal(av1FlagNeedsRestart(status(), true), true);
        assert.equal(av1FlagNeedsRestart(status(), false), false);
    });

    test("o diagnostico: pedido, aplicado ou nao, e o que esta salvo", async () => {
        pluginSettings.load({ codec: "av1" });
        const m = mainWith({ saved: true, requested: true, applied: true });
        env = m.env;
        await refreshAv1Flag();
        assert.equal(av1FlagDiagnostics(), "AV1 da placa (WebRtcAV1HWEncode): AV1 fixado; nesta partida aplicado; salvo para a próxima: ligado");
        m.main.st = status({ requested: true, applied: false });
        await refreshAv1Flag();
        assert.equal(av1FlagDiagnostics(), "AV1 da placa (WebRtcAV1HWEncode): AV1 fixado; nesta partida pedido mas NÃO aplicado; salvo para a próxima: desligado");
        m.main.st = status({ requested: true });
        await refreshAv1Flag();
        assert.match(av1FlagDiagnostics(), /nesta partida pedido;/);
        m.main.st = status({ loader: false });
        await refreshAv1Flag();
        assert.equal(av1FlagDiagnostics(), "AV1 da placa (WebRtcAV1HWEncode): AV1 fixado; nesta partida sem o loader do add-on; salvo para a próxima: sem o loader do add-on");
        m.main.st = status();
        await refreshAv1Flag();
        assert.match(av1FlagDiagnostics(), /nesta partida não pedido;/);
        m.main.st = { nope: true } as unknown as Av1FlagStatus;
        await refreshAv1Flag();
        assert.match(av1FlagDiagnostics(), /parte nativa sem a opção/, "resposta estranha do main: como sem a opcao");
    });
});

describe("o lado main (core/av1FlagMain.ts, pelos natives)", () => {
    const g = globalThis as { __TelinhaAddon?: unknown; };
    let dir: string;
    let file: string;
    const saved = () => JSON.parse(readFileSync(file, "utf8"));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "tl-av1-"));
        file = join(dir, "capture-flags.json");
    });

    afterEach(() => {
        delete g.__TelinhaAddon;
        rmSync(dir, { recursive: true, force: true });
    });

    const loader = (capture: Record<string, unknown> = {}) => {
        g.__TelinhaAddon = { capture: { file, build: 26300, wgcTexture: false, applied: null, enableFeatures: null, reason: null, av1HwEncode: false, av1Applied: null, ...capture } };
    };

    test("grava so a chave do AV1 e mantem a da captura pela placa (e vice-versa)", () => {
        loader();
        writeFileSync(file, JSON.stringify({ format: 1, wgcTexture: true }));
        assert.equal(setAv1Flag(ipcEvent(), true).saved, true);
        assert.deepEqual(saved(), { format: 1, wgcTexture: true, av1HwEncode: true });
        setGpuCaptureMain(false);
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: true }, "a outra opcao nao apaga o pedido do AV1");
        assert.equal(setAv1FlagMain("true" as never).saved, false, "so true liga (o IPC pode trazer qualquer coisa)");
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: false });
    });

    test("o estado desta partida vem do loader: pedido e aplicado", () => {
        loader({ av1HwEncode: true, av1Applied: true });
        writeFileSync(file, JSON.stringify({ format: 1, av1HwEncode: true }));
        assert.deepEqual(av1FlagStatus(ipcEvent()), { loader: true, saved: true, requested: true, applied: true, saveError: null });
        loader({ av1HwEncode: true, av1Applied: "x" });
        assert.equal(av1FlagStatusMain().applied, null);
    });

    test("sem o loader, ou um loader de antes desta versao (sem av1HwEncode): nao grava nada, loader false", () => {
        assert.deepEqual(setAv1FlagMain(true), { loader: false, saved: false, requested: false, applied: null, saveError: null });
        g.__TelinhaAddon = { capture: { file, build: 26300, wgcTexture: true, applied: true } };
        assert.equal(setAv1FlagMain(true).loader, false);
        assert.throws(() => readFileSync(file), "nada gravado");
    });

    test("a gravacao falha (a pasta sumiu): o erro em pt-BR, sem lancar", () => {
        loader();
        rmSync(dir, { recursive: true, force: true });
        const st = setAv1FlagMain(true);
        assert.match(st.saveError!, /^não consegui salvar o pedido do AV1 da placa \(/);
        assert.equal(st.saved, false);
    });
});
