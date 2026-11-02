/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Os natives do peso da live (native.ts → core/liveWeightMain.ts), como o IPC os chama (o 1o argumento e o evento): comecar
// roda o typeperf, ler devolve o relatorio, parar e o resetDisplayMedia (o plugin parou) encerram o typeperf. Nunca roda o
// typeperf de verdade (mockSpawn).
// Rodar:  pnpm test:file src/plugins/telinha/native.liveWeight.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { mockSpawn } from "@test/fakes/childProcess";
import { ipcEvent } from "@test/fakes/electron";

import { resetLiveWeightForTests } from "./core/liveWeightMain";
import { readLiveWeight, resetDisplayMedia, startLiveWeight, stopLiveWeight } from "./native";

afterEach(() => resetLiveWeightForTests());

test("comecar, ler, parar; o resetDisplayMedia do fim do plugin tambem para", async t => {
    const env = mockSpawn(t);
    assert.deepEqual(startLiveWeight(ipcEvent()), { ok: true, reason: null });
    const [p] = env.spawned;
    assert.match(p.command, /typeperf\.exe$/i);
    const r = await readLiveWeight(ipcEvent());
    assert.equal(r.state, "measuring");
    stopLiveWeight(ipcEvent());
    assert.ok(p.killed);
    assert.equal((await readLiveWeight(ipcEvent())).state, "off");

    startLiveWeight(ipcEvent());
    const q = env.spawned[1];
    resetDisplayMedia(ipcEvent());
    assert.ok(q.killed, "o plugin parou: o typeperf tambem");
});
