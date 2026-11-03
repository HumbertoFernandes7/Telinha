/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do registro do tempo real no processo main (core/discordGpuBoostMain.ts e os natives readGpuBoostRecord /
// writeGpuBoostRecord do native.ts): guarda e devolve a lista, descarta entrada mal formada, um pid vale uma vez, no maximo 16,
// devolve copias e sobrevive entre chamadas (o "renderer" que cai nao leva o registro junto).
// Rodar:  pnpm test:file src/plugins/telinha/core/discordGpuBoostMain.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { readGpuBoostRecord, writeGpuBoostRecord } from "@plugins/telinha/native";
import { ipcEvent } from "@test/fakes/electron";

import {
    cleanGpuBoostRecord, GPU_BOOST_RECORD_MAX, readGpuBoostRecordMain, resetGpuBoostRecordForTests, writeGpuBoostRecordMain
} from "./discordGpuBoostMain";

const ok = (pid: number, role: "Discord" | "GPU" = "Discord") => ({ pid, role, classBefore: "NORMAL", at: 1000 + pid });

beforeEach(() => resetGpuBoostRecordForTests());

describe("registro do tempo real no main", () => {
    test("comeca vazio, guarda a lista e a devolve na mesma ordem", () => {
        assert.deepEqual(readGpuBoostRecordMain(), []);
        assert.deepEqual(writeGpuBoostRecordMain([ok(1234), ok(5678, "GPU")]), [ok(1234), ok(5678, "GPU")]);
        assert.deepEqual(readGpuBoostRecordMain(), [ok(1234), ok(5678, "GPU")]);
    });

    test("a lista nova troca a antiga; lista vazia (ou que nao e array) limpa", () => {
        writeGpuBoostRecordMain([ok(1)]);
        writeGpuBoostRecordMain([ok(2)]);
        assert.deepEqual(readGpuBoostRecordMain(), [ok(2)]);
        for (const empty of [[], null, undefined, "x", { pid: 1 }, 7]) {
            writeGpuBoostRecordMain([ok(3)]);
            assert.deepEqual(writeGpuBoostRecordMain(empty), []);
            assert.deepEqual(readGpuBoostRecordMain(), []);
        }
    });

    test("rejeita entrada mal formada e fica so com as boas", () => {
        const bad: unknown[] = [
            null, undefined, 5, "x", [], {},
            { ...ok(1), pid: 0 }, { ...ok(1), pid: -4 }, { ...ok(1), pid: 1.5 }, { ...ok(1), pid: "7" }, { ...ok(1), pid: NaN },
            { ...ok(1), role: "Outro" }, { ...ok(1), role: undefined },
            { ...ok(1), classBefore: 3 }, { ...ok(1), classBefore: undefined },
            { ...ok(1), at: "1" }, { ...ok(1), at: undefined }
        ];
        assert.deepEqual(writeGpuBoostRecordMain([...bad, ok(9, "GPU")]), [ok(9, "GPU")]);
        assert.deepEqual(readGpuBoostRecordMain(), [ok(9, "GPU")]);
    });

    test("campos a mais ficam de fora, e um pid repetido fica com o ultimo", () => {
        const out = writeGpuBoostRecordMain([{ ...ok(1), extra: "lixo", __proto__: { x: 1 } }, ok(2), { ...ok(1), classBefore: "IDLE" }]);
        assert.deepEqual(out, [ok(2), { ...ok(1), classBefore: "IDLE" }]);
        assert.ok(out.every(e => Object.keys(e).sort().join() === "at,classBefore,pid,role"));
    });

    test(`no maximo ${GPU_BOOST_RECORD_MAX} entradas (ficam as ultimas)`, () => {
        const many = Array.from({ length: GPU_BOOST_RECORD_MAX + 5 }, (_, i) => ok(i + 1));
        const out = writeGpuBoostRecordMain(many);
        assert.equal(out.length, GPU_BOOST_RECORD_MAX);
        assert.equal(out[0].pid, 6);
        assert.equal(out.at(-1)!.pid, GPU_BOOST_RECORD_MAX + 5);
    });

    test("devolve copias: mexer no que voltou nao mexe no registro", () => {
        writeGpuBoostRecordMain([ok(1)]);
        const first = readGpuBoostRecordMain();
        first[0].classBefore = "REALTIME";
        first.push(ok(2));
        assert.deepEqual(readGpuBoostRecordMain(), [ok(1)]);
    });

    test("cleanGpuBoostRecord nao guarda nada", () => {
        assert.deepEqual(cleanGpuBoostRecord([ok(1)]), [ok(1)]);
        assert.deepEqual(readGpuBoostRecordMain(), []);
    });
});

describe("natives readGpuBoostRecord / writeGpuBoostRecord (native.ts)", () => {
    test("o que o renderer grava, o renderer seguinte le (a queda do renderer nao leva o registro)", () => {
        assert.deepEqual(readGpuBoostRecord(ipcEvent()), []);
        assert.deepEqual(writeGpuBoostRecord(ipcEvent(), [ok(1234), { pid: "x" }, ok(5678, "GPU")]), [ok(1234), ok(5678, "GPU")]);
        assert.deepEqual(readGpuBoostRecord(ipcEvent()), [ok(1234), ok(5678, "GPU")]);
        assert.deepEqual(writeGpuBoostRecord(ipcEvent(), "lixo"), []);
        assert.deepEqual(readGpuBoostRecord(ipcEvent()), []);
    });
});
