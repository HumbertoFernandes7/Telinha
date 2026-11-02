/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado main da "Captura pela placa de vídeo" (core/captureBoostMain.ts, pelos natives de native.ts): o estado
// vem do que o loader do add-on publicou nesta partida (globalThis.__TelinhaAddon.capture) e do capture-flags.json, que
// a opcao grava para a proxima partida. O Windows (os.release / process.platform) e trocado por teste (helperHost); o
// arquivo fica numa pasta temporaria. Nunca toca o %APPDATA% de verdade.
// Rodar:  pnpm test:file src/plugins/telinha/core/captureBoostMain.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { gpuCaptureStatus, setGpuCapture } from "@plugins/telinha/native";
import { ipcEvent } from "@test/fakes/electron";
import { helperHost } from "@test/helpers/wpd-audio";

import { GPU_CAPTURE_MIN_BUILD, gpuCaptureStatusMain, setGpuCaptureMain } from "./captureBoostMain";

const g = globalThis as { __TelinhaAddon?: unknown; };
let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tl-capture-"));
    file = join(dir, "capture-flags.json");
});

afterEach(() => {
    delete g.__TelinhaAddon;
    rmSync(dir, { recursive: true, force: true });
});

/** O que o loader publicou nesta partida (addon/loader/main.js → applyCaptureFlags). */
function loader(capture: Record<string, unknown> = {}) {
    g.__TelinhaAddon = { capture: { file, build: 26300, wgcTexture: false, applied: null, enableFeatures: null, reason: null, ...capture } };
}

const saved = () => JSON.parse(readFileSync(file, "utf8"));

describe("o estado da opcao", () => {
    test("Windows 11 24H2+, ligada e aplicada nesta partida: tudo vem do loader e do arquivo", t => {
        helperHost(t, { build: 26300 });
        loader({ wgcTexture: true, applied: true, enableFeatures: "X,WebRtcAllowWgcUsingTexture" });
        writeFileSync(file, JSON.stringify({ format: 1, wgcTexture: true }));
        assert.deepEqual(gpuCaptureStatus(ipcEvent()), {
            loader: true, build: 26300, supported: true, saved: true, requested: true, applied: true, loaderNote: null,
            enableFeatures: "X,WebRtcAllowWgcUsingTexture", saveError: null
        });
    });

    test("Windows mais antigo que o 24H2 (no limite e abaixo), versao sem build e outro sistema", t => {
        const host = helperHost(t, { build: GPU_CAPTURE_MIN_BUILD - 1 });
        loader({ wgcTexture: true, applied: false, reason: "Windows build 26099: needs 24H2" });
        const st = gpuCaptureStatusMain();
        assert.deepEqual([st.build, st.supported, st.applied, st.loaderNote], [26099, false, false, "Windows build 26099: needs 24H2"]);

        host.setBuild(GPU_CAPTURE_MIN_BUILD);
        assert.equal(gpuCaptureStatusMain().supported, true);

        host.setBuild("10.0");
        assert.equal(gpuCaptureStatusMain().build, 0);

        host.setBuild(26300);
        host.setPlatform("linux");
        assert.deepEqual([gpuCaptureStatusMain().build, gpuCaptureStatusMain().supported], [0, false]);
    });

    test("sem o loader do add-on (build do fork, loader antigo, caminho estranho): nada salvo, nada pedido", t => {
        helperHost(t, { build: 26300 });
        for (const addon of [undefined, {}, { capture: null }, { capture: { file: 42 } }, { capture: { file: "relativo.json" } }]) {
            g.__TelinhaAddon = addon;
            const st = gpuCaptureStatusMain();
            assert.deepEqual([st.loader, st.saved, st.requested, st.applied], [false, false, false, null], JSON.stringify(addon));
        }
    });

    test("arquivo ausente, quebrado ou sem true: nao salva; campos estranhos do loader ficam de fora", t => {
        helperHost(t, { build: 26300 });
        loader({ wgcTexture: "sim", applied: "talvez", reason: "", enableFeatures: 7 });
        assert.equal(gpuCaptureStatusMain().saved, false);
        writeFileSync(file, "{ quebrado");
        assert.equal(gpuCaptureStatusMain().saved, false);
        writeFileSync(file, JSON.stringify({ wgcTexture: 1 }));
        const st = gpuCaptureStatusMain();
        assert.deepEqual([st.saved, st.requested, st.applied, st.loaderNote, st.enableFeatures], [false, false, null, null, null]);
    });
});

describe("gravar a opcao para a proxima partida", () => {
    test("liga e desliga: o arquivo inteiro de uma vez, sem sobra de temporario", t => {
        helperHost(t, { build: 26300 });
        loader();
        assert.equal(setGpuCapture(ipcEvent(), true).saved, true);
        assert.deepEqual(saved(), { format: 1, wgcTexture: true });
        assert.equal(setGpuCaptureMain(false).saved, false);
        assert.deepEqual(saved(), { format: 1, wgcTexture: false });
        assert.deepEqual(readdirSync(dir), ["capture-flags.json"]);
    });

    test("so true liga (o IPC pode trazer qualquer coisa)", t => {
        helperHost(t, { build: 26300 });
        loader();
        assert.equal(setGpuCapture(ipcEvent(), "true" as never).saved, false);
    });

    test("sem o loader: nao grava nada", t => {
        helperHost(t, { build: 26300 });
        const st = setGpuCaptureMain(true);
        assert.deepEqual([st.loader, st.saved, st.saveError], [false, false, null]);
        assert.equal(existsSync(file), false);
    });

    test("nao deu para gravar (no lugar do arquivo ha uma pasta): o erro volta em pt-BR e o temporario some", t => {
        helperHost(t, { build: 26300 });
        loader();
        mkdirSync(file);
        const st = setGpuCaptureMain(true);
        assert.match(st.saveError ?? "", /^não consegui salvar a opção \(/);
        assert.deepEqual(readdirSync(dir), ["capture-flags.json"]);
    });

    test("um erro que nao e Error vira texto; e apagar o temporario tambem pode falhar", t => {
        helperHost(t, { build: 26300 });
        loader();
        t.mock.method(fs, "writeFileSync", () => {
            throw "disco cheio";
        });
        t.mock.method(fs, "rmSync", () => {
            throw new Error("EBUSY");
        });
        const st = setGpuCaptureMain(true);
        t.mock.restoreAll(); // antes do afterEach, que apaga a pasta com o rmSync de verdade
        assert.equal(st.saveError, "não consegui salvar a opção (disco cheio)");
    });
});
