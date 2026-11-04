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
import { app, ipcEvent, screen } from "@test/fakes/electron";

import { gpuEnvironment } from "./native";

const defaults = { gpuInfo: app.gpuInfo, getVersion: app.getVersion, displays: screen.displays };

afterEach(() => {
    app.gpuInfo = defaults.gpuInfo;
    app.getVersion = defaults.getVersion;
    app.getGPUInfoImpl = null;
    screen.displays = defaults.displays;
    screen.getAllDisplaysImpl = null;
});

test("a placa ativa (num notebook com duas), o driver, o Chromium e o Discord", async () => {
    app.gpuInfo = {
        gpuDevice: [
            { active: false, vendorId: 0x8086, deviceId: 0x9A49, driverVersion: "31.0.101.4502" },
            { active: true, vendorId: 0x1002, deviceId: 0x7550, driverVersion: " 32.0.21001.9024 " }
        ]
    };
    const env = await gpuEnvironment(ipcEvent());
    const { adapters, internalDisplay, ...old } = env;
    assert.deepEqual(old, { vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: process.versions.chrome ?? null, discord: "1.0.9002", error: null });
    assert.equal(adapters?.length, 2);
    assert.equal(internalDisplay, false);
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

test("adapters: todas as placas na mesma ordem (iGPU, dGPU ativa, WARP, NPU), saneadas; os campos antigos seguem a placa ativa", async () => {
    app.gpuInfo = {
        gpuDevice: [
            { active: false, vendorId: 0x1002, deviceId: 0x164E, deviceString: "  AMD Radeon(TM)   Graphics ", driverVendor: "AMD", driverVersion: "32.0.13031.3015", gpuPreference: 2 },
            { active: true, vendorId: 0x1002, deviceId: 0x7550, deviceString: "AMD Radeon RX 9070 XT", driverVendor: "AMD", driverVersion: "32.0.21001.9024", gpuPreference: 3 },
            { active: false, vendorId: 0x1414, deviceId: 0x008C, deviceString: "Microsoft Basic Render Driver", driverVendor: "Microsoft", driverVersion: "10.0.26100.1" },
            { active: false, vendorId: 0x8086, deviceId: 0x7D1D, deviceString: "x".repeat(300), driverVersion: 7, gpuPreference: 9 }
        ]
    };
    const env = await gpuEnvironment(ipcEvent());
    assert.deepEqual(env.adapters, [
        { vendorId: 0x1002, deviceId: 0x164E, name: "AMD Radeon(TM) Graphics", driverVendor: "AMD", driverVersion: "32.0.13031.3015", active: false, preference: 2 },
        { vendorId: 0x1002, deviceId: 0x7550, name: "AMD Radeon RX 9070 XT", driverVendor: "AMD", driverVersion: "32.0.21001.9024", active: true, preference: 3 },
        { vendorId: 0x1414, deviceId: 0x008C, name: "Microsoft Basic Render Driver", driverVendor: "Microsoft", driverVersion: "10.0.26100.1", active: false, preference: 0 },
        { vendorId: 0x8086, deviceId: 0x7D1D, name: "x".repeat(128), driverVendor: "", driverVersion: "", active: false, preference: 0 }
    ]);
    const { adapters, internalDisplay, ...old } = env;
    assert.deepEqual(old, { vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: process.versions.chrome ?? null, discord: "1.0.9002", error: null });
});

test("adapters: no maximo 8", async () => {
    app.gpuInfo = { gpuDevice: Array.from({ length: 12 }, (_, i) => ({ active: i === 0, vendorId: 0x10DE, deviceId: 0x2000 + i, driverVersion: "1" })) };
    const env = await gpuEnvironment(ipcEvent());
    assert.equal(env.adapters?.length, 8);
    assert.deepEqual(env.adapters?.map(a => a.deviceId), [0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007]);
});

test("internalDisplay: tela embutida true, so externas false, screen que lanca null", async () => {
    screen.displays = [{ id: 1, internal: false }, { id: 2, internal: true }];
    assert.equal((await gpuEnvironment(ipcEvent())).internalDisplay, true);

    screen.displays = [{ id: 1, internal: false }, { id: 2 }];
    assert.equal((await gpuEnvironment(ipcEvent())).internalDisplay, false);

    screen.getAllDisplaysImpl = () => {
        throw new Error("screen not ready");
    };
    const env = await gpuEnvironment(ipcEvent());
    assert.equal(env.internalDisplay, null);
    assert.equal(env.error, null);
    assert.equal(env.vendorId, 0x10DE);
});
