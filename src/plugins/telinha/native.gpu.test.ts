/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do native gpuEnvironment (native.ts, processo main) com o `electron` falso: a placa de video ativa de
// app.getGPUInfo("basic") (vendorId/deviceId PCI e o driver), o Chromium deste processo e a versao do Discord. Tudo o que
// falhar vira desconhecido (null) com o motivo, sem lancar: core/stuckEncoder.ts lembra mesmo assim.
// Rodar:  pnpm test:file src/plugins/telinha/native.gpu.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { app, ipcEvent } from "@test/fakes/electron";

import { gpuEnvironment } from "./native";

const defaults = { gpuInfo: app.gpuInfo, getVersion: app.getVersion };

afterEach(() => {
    app.gpuInfo = defaults.gpuInfo;
    app.getVersion = defaults.getVersion;
    app.getGPUInfoImpl = null;
});

test("a placa ativa (num notebook com duas), o driver, o Chromium e o Discord", async () => {
    app.gpuInfo = {
        gpuDevice: [
            { active: false, vendorId: 0x8086, deviceId: 0x9A49, driverVersion: "31.0.101.4502" },
            { active: true, vendorId: 0x1002, deviceId: 0x7550, driverVersion: " 32.0.21001.9024 " }
        ]
    };
    const env = await gpuEnvironment(ipcEvent());
    assert.deepEqual(env, { vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: process.versions.chrome ?? null, discord: "1.0.9002", error: null });
});

test("sem placa ativa marcada: a primeira; campos estranhos ficam de fora", async () => {
    app.gpuInfo = { gpuDevice: [{ vendorId: 0x10DE, deviceId: -1, driverVersion: "" }] };
    const env = await gpuEnvironment(ipcEvent());
    assert.equal(env.vendorId, 0x10DE);
    assert.equal(env.deviceId, null);
    assert.equal(env.driverVersion, null);
});

test("sem gpuDevice, getGPUInfo que lanca ou que nao responde: placa desconhecida com o motivo; app.getVersion que lanca", async t => {
    app.gpuInfo = {};
    assert.equal((await gpuEnvironment(ipcEvent())).error, "getGPUInfo sem gpuDevice");

    app.getGPUInfoImpl = async () => {
        throw new Error("GPU access is disabled");
    };
    app.getVersion = () => {
        throw new Error("nope");
    };
    const failed = await gpuEnvironment(ipcEvent());
    assert.equal(failed.error, "Error: GPU access is disabled");
    assert.equal(failed.vendorId, null);
    assert.equal(failed.discord, null);

    const clock = useFakeClock(t);
    app.getGPUInfoImpl = () => new Promise(() => { });
    const hanging = gpuEnvironment(ipcEvent());
    await clock.tickAsync(3001, 500);
    assert.equal((await hanging).error, "getGPUInfo demorou demais");
});
