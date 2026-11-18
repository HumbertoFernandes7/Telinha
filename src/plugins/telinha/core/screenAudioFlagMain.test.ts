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
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: false, screenAudioInChromiumUserOff: true });
    });

    test("desligar grava screenAudioInChromiumUserOff; ligar de novo apaga a chave", () => {
        loader();
        assert.equal(setScreenAudioFlagMain(false).userOff, true);
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: false, screenAudioInChromiumUserOff: true });
        assert.equal(setScreenAudioFlagMain(true).userOff, false);
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: false, screenAudioInChromium: true });
        setGpuCaptureMain(true);
        assert.equal(saved().screenAudioInChromiumUserOff, undefined, "as outras gravacoes nao trazem a chave de volta");
    });

    test("Windows abaixo do build 19041: ligar nao grava e volta com saveError; 19041 serve; desligar sempre grava", () => {
        const at = (build: number) => {
            g.__TelinhaAddon = { capture: { file, build, wgcTexture: false, applied: null, av1HwEncode: false, av1Applied: null, screenAudioInChromium: { asked: false, applied: null, disableFeatures: null } } };
        };
        at(19040);
        const st = setScreenAudioFlagMain(true);
        assert.equal(st.saved, false);
        assert.equal(st.saveError, "o som da tela pelo Chromium exige Windows 10 versão 2004 ou mais novo (este é o build 19040)");
        assert.throws(() => readFileSync(file), "nada gravado");
        at(19041);
        assert.equal(setScreenAudioFlagMain(true).saved, true);
        at(0);
        assert.match(setScreenAudioFlagMain(true).saveError ?? "", /build \?\)$/);
        assert.equal(setScreenAudioFlagMain(false).saveError, null);
    });

    test("o motivo do loader fica em loaderReason", () => {
        loader({ asked: true, applied: false, disableFeatures: null, reason: "could not turn it on (x)" });
        assert.equal(screenAudioFlagStatusMain().loaderReason, "could not turn it on (x)");
    });

    test("o estado desta partida vem do loader: pedido, aplicado e o disable-features final", () => {
        loader({ asked: true, applied: true, disableFeatures: "A,AudioServiceOutOfProcess,RestrictOwnAudioAddChromiumBack" });
        writeFileSync(file, JSON.stringify({ format: 1, screenAudioInChromium: true }));
        assert.deepEqual(screenAudioFlagStatus(ipcEvent()), {
            loader: true, saved: true, userOff: false, build: 26300, requested: true, applied: true,
            disableFeatures: "A,AudioServiceOutOfProcess,RestrictOwnAudioAddChromiumBack", loaderReason: null, saveError: null
        });
        loader({ asked: true, applied: "x", disableFeatures: 5 });
        const st = screenAudioFlagStatusMain();
        assert.equal(st.applied, null);
        assert.equal(st.disableFeatures, null);
    });

    test("nao pedido nesta partida: applied null, e o salvo vale so para a proxima", () => {
        loader();
        setScreenAudioFlagMain(true);
        assert.deepEqual(screenAudioFlagStatusMain(), { loader: true, saved: true, userOff: false, build: 26300, requested: false, applied: null, disableFeatures: null, loaderReason: null, saveError: null });
    });

    test("sem o loader, ou um loader de antes desta versao (sem screenAudioInChromium): nao grava nada, loader false", () => {
        assert.deepEqual(setScreenAudioFlagMain(true), { loader: false, saved: false, userOff: false, build: 0, requested: false, applied: null, disableFeatures: null, loaderReason: null, saveError: null });
        g.__TelinhaAddon = { capture: { file, build: 26300, wgcTexture: true, applied: true, av1HwEncode: false } };
        assert.equal(setScreenAudioFlagMain(true).loader, false);
        assert.throws(() => readFileSync(file), "nada gravado");
    });

    test("campos estranhos do loader: build nao numerico, textos vazios/longos, reason nao string", () => {
        g.__TelinhaAddon = { capture: { file, build: "x", wgcTexture: false, applied: null, av1HwEncode: false, av1Applied: null, screenAudioInChromium: { asked: true, applied: true, disableFeatures: "f".repeat(600), reason: "r".repeat(400) } } };
        const st = screenAudioFlagStatusMain();
        assert.equal(st.build, 0);
        assert.equal(st.disableFeatures?.length, 500);
        assert.equal(st.loaderReason?.length, 300);
        loader({ asked: true, applied: true, disableFeatures: "", reason: "" });
        assert.equal(screenAudioFlagStatusMain().disableFeatures, null);
        assert.equal(screenAudioFlagStatusMain().loaderReason, null);
        loader({ asked: true, applied: true, disableFeatures: "x", reason: 7 });
        assert.equal(screenAudioFlagStatusMain().loaderReason, null);
    });

    test("a gravacao lanca algo que nao e Error: o texto vira o motivo", () => {
        let reads = 0;
        const capture = {
            build: 26300, wgcTexture: false, applied: null, av1HwEncode: false, av1Applied: null,
            screenAudioInChromium: { asked: false, applied: null, disableFeatures: null },
            get file() {
                if (++reads === 7) throw "boom";
                return file;
            }
        };
        g.__TelinhaAddon = { capture };
        const st = setScreenAudioFlagMain(true);
        assert.equal(st.saveError, "não consegui salvar o pedido do som da tela pelo Chromium (boom)");
    });

    test("a gravacao falha (a pasta sumiu): o erro em pt-BR, sem lancar", () => {
        loader();
        rmSync(dir, { recursive: true, force: true });
        const st = setScreenAudioFlagMain(true);
        assert.match(st.saveError!, /^não consegui salvar o pedido do som da tela pelo Chromium \(/);
        assert.equal(st.saved, false);
    });
});
