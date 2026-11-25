/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da leitura/ligacao da "Aceleracao de hardware" do Discord (core/hwAccel.ts) e da linha do diagnostico.
// Rodar:  pnpm test:file src/plugins/telinha/core/hwAccel.test.ts

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { discordHwAccelSetting, enableHwAccelAndRestart, hwAccelDiagnostics } from "./hwAccel";

const g = globalThis as { DiscordNative?: unknown; };
const original = g.DiscordNative;

afterEach(() => {
    if (original === undefined) delete g.DiscordNative;
    else g.DiscordNative = original;
});

describe("discordHwAccelSetting", () => {
    test("lida: true e false", () => {
        g.DiscordNative = { gpuSettings: { getEnableHardwareAcceleration: () => true } };
        assert.equal(discordHwAccelSetting(), true);
        g.DiscordNative = { gpuSettings: { getEnableHardwareAcceleration: () => false } };
        assert.equal(discordHwAccelSetting(), false);
    });

    test("sem API, funcao ausente, valor estranho ou excecao: desconhecido (null)", () => {
        delete g.DiscordNative;
        assert.equal(discordHwAccelSetting(), null);
        g.DiscordNative = {};
        assert.equal(discordHwAccelSetting(), null);
        g.DiscordNative = { gpuSettings: {} };
        assert.equal(discordHwAccelSetting(), null);
        g.DiscordNative = { gpuSettings: { getEnableHardwareAcceleration: () => "sim" } };
        assert.equal(discordHwAccelSetting(), null);
        g.DiscordNative = { gpuSettings: { getEnableHardwareAcceleration() { throw new Error("quebrou"); } } };
        assert.equal(discordHwAccelSetting(), null);
    });
});

describe("enableHwAccelAndRestart", () => {
    test("chama setEnableHardwareAcceleration(true) e devolve true", () => {
        const calls: unknown[][] = [];
        g.DiscordNative = { gpuSettings: { setEnableHardwareAcceleration: (...a: unknown[]) => void calls.push(a) } };
        assert.equal(enableHwAccelAndRestart(), true);
        assert.deepEqual(calls, [[true]]);
    });

    test("sem API ou se lancar: false", () => {
        delete g.DiscordNative;
        assert.equal(enableHwAccelAndRestart(), false);
        g.DiscordNative = { gpuSettings: { setEnableHardwareAcceleration() { throw new Error("quebrou"); } } };
        assert.equal(enableHwAccelAndRestart(), false);
    });
});

describe("hwAccelDiagnostics", () => {
    test("ligada / DESLIGADA / desconhecida", () => {
        g.DiscordNative = { gpuSettings: { getEnableHardwareAcceleration: () => true } };
        assert.equal(hwAccelDiagnostics(), "aceleração de hardware do Discord: ligada");
        g.DiscordNative = { gpuSettings: { getEnableHardwareAcceleration: () => false } };
        assert.equal(hwAccelDiagnostics(), "aceleração de hardware do Discord: DESLIGADA");
        delete g.DiscordNative;
        assert.equal(hwAccelDiagnostics(), "aceleração de hardware do Discord: desconhecida");
    });
});
