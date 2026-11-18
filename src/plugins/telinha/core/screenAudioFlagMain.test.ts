/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado main do som da tela pelo Chromium (core/screenAudioFlagMain.ts), num capture-flags.json de verdade numa
// pasta temporaria e um __TelinhaAddon de mentira.
// Rodar:  pnpm test:file src/plugins/telinha/core/screenAudioFlagMain.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { screenAudioFlagStatus, setScreenAudioFlag } from "@plugins/telinha/native";
import { ipcEvent } from "@test/fakes/electron";

import { setAv1FlagMain } from "./av1FlagMain";
import { setGpuCaptureMain } from "./captureBoostMain";
import { screenAudioFlagStatusMain, setScreenAudioFlagMain } from "./screenAudioFlagMain";

describe("o lado main do som da tela pelo Chromium (core/screenAudioFlagMain.ts, pelos natives)", () => {
    const g = globalThis as { __TelinhaAddon?: unknown; };
    let dir: string;
    let file: string;
    const saved = () => JSON.parse(readFileSync(file, "utf8"));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "tl-screenaudio-"));
        file = join(dir, "capture-flags.json");
    });

    afterEach(() => {
        delete g.__TelinhaAddon;
        rmSync(dir, { recursive: true, force: true });
    });

    const loader = (screenAudioInChromium: unknown = { asked: false, applied: null, disableFeatures: null }) => {
        g.__TelinhaAddon = { capture: { file, build: 26300, wgcTexture: false, applied: null, av1HwEncode: false, av1Applied: null, screenAudioInChromium } };
    };

    test("grava so a chave do som da tela e mantem as outras (e vice-versa)", () => {
        loader();
        writeFileSync(file, JSON.stringify({ format: 1, wgcTexture: true, av1HwEncode: true }));
        assert.equal(setScreenAudioFlag(ipcEvent(), true).saved, true);
        assert.deepEqual(saved(), { format: 1, wgcTexture: true, av1HwEncode: true, screenAudioInChromium: true });
        setGpuCaptureMain(false);
        setAv1FlagMain(false);
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: false, screenAudioInChromium: true }, "as outras opcoes nao apagam o pedido");
        assert.equal(setScreenAudioFlagMain("true" as never).saved, false, "so true liga (o IPC pode trazer qualquer coisa)");
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: false });
    });

    test("o estado desta partida vem do loader: pedido, aplicado e o disable-features final", () => {
        loader({ asked: true, applied: true, disableFeatures: "A,AudioServiceOutOfProcess,RestrictOwnAudioAddChromiumBack" });
        writeFileSync(file, JSON.stringify({ format: 1, screenAudioInChromium: true }));
        assert.deepEqual(screenAudioFlagStatus(ipcEvent()), {
            loader: true, saved: true, requested: true, applied: true,
            disableFeatures: "A,AudioServiceOutOfProcess,RestrictOwnAudioAddChromiumBack", saveError: null
        });
        loader({ asked: true, applied: "x", disableFeatures: 5 });
        const st = screenAudioFlagStatusMain();
        assert.equal(st.applied, null);
        assert.equal(st.disableFeatures, null);
    });

    test("nao pedido nesta partida: applied null, e o salvo vale so para a proxima", () => {
        loader();
        setScreenAudioFlagMain(true);
        assert.deepEqual(screenAudioFlagStatusMain(), { loader: true, saved: true, requested: false, applied: null, disableFeatures: null, saveError: null });
    });

    test("sem o loader, ou um loader de antes desta versao (sem screenAudioInChromium): nao grava nada, loader false", () => {
        assert.deepEqual(setScreenAudioFlagMain(true), { loader: false, saved: false, requested: false, applied: null, disableFeatures: null, saveError: null });
        g.__TelinhaAddon = { capture: { file, build: 26300, wgcTexture: true, applied: true, av1HwEncode: false } };
        assert.equal(setScreenAudioFlagMain(true).loader, false);
        assert.throws(() => readFileSync(file), "nada gravado");
    });

    test("a gravacao falha (a pasta sumiu): o erro em pt-BR, sem lancar", () => {
        loader();
        rmSync(dir, { recursive: true, force: true });
        const st = setScreenAudioFlagMain(true);
        assert.match(st.saveError!, /^não consegui salvar o pedido do som da tela pelo Chromium \(/);
        assert.equal(st.saved, false);
    });
});
