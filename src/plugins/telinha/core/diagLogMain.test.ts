/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado main do registro do Telinha em arquivo (core/diagLogMain.ts, pelos natives appendDiagLog/readDiagLog do
// native.ts) numa pasta temporaria: acrescentar, rodar para .1 antes de passar do limite (o .1 anterior some), ler as
// ultimas linhas das duas, recusar lote invalido e nunca lancar. Nunca toca a %APPDATA% de verdade: a pasta vem de
// setDiagLogDirForTests (sem ela, o electron falso responde um caminho que o teste faz falhar).
// Rodar:  pnpm test:file src/plugins/telinha/core/diagLogMain.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import { appendDiagLog, clearDiagLog, readDiagLog } from "@plugins/telinha/native";
import { app, ipcEvent } from "@test/fakes/electron";

import {
    appendDiagLogMain, clearDiagLogMain, DIAG_LOG_FILE, DIAG_LOG_MAX_APPEND_CHARS, DIAG_LOG_MAX_BYTES, DIAG_LOG_TAIL_LINES, readDiagLogMain, setDiagLogDirForTests
} from "./diagLogMain";

let root: string;
let dir: string;
let n = 0;
const file = () => join(dir, DIAG_LOG_FILE);

before(() => {
    root = mkdtempSync(join(tmpdir(), "telinha-diaglog-"));
});

after(() => {
    setDiagLogDirForTests(null);
    rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
    setDiagLogDirForTests(null);
});

/** Uma pasta nova (que ainda nao existe: o registro cria). */
function freshDir() {
    dir = join(root, `logs${++n}`);
    setDiagLogDirForTests(dir);
}

describe("registro em arquivo (processo main)", () => {
    test("cria a pasta, acrescenta os lotes na ordem e le de volta (pelos natives do native.ts)", async () => {
        freshDir();
        assert.equal(await appendDiagLog(ipcEvent(), "a\nb\n"), true);
        assert.equal(await appendDiagLog(ipcEvent(), "c"), true, "sem o \\n final: completa");
        assert.equal(readFileSync(file(), "utf8"), "a\nb\nc\n");
        assert.deepEqual(await readDiagLog(ipcEvent()), ["a", "b", "c"]);
    });

    test("lote que passaria do limite: o arquivo vira .1 (o .1 anterior some) e o lote comeca um novo", async () => {
        freshDir();
        const line = "x".repeat(1023) + "\n";
        const batch = line.repeat(40); // 40 KiB
        assert.equal(await appendDiagLogMain(batch), true);
        assert.equal(await appendDiagLogMain(batch), true);
        assert.equal(statSync(file()).size, 80 * 1024);
        assert.equal(existsSync(file() + ".1"), false);
        assert.equal(await appendDiagLogMain(batch), true, "80 + 40 KiB passaria de 100 KiB");
        assert.equal(statSync(file() + ".1").size, 80 * 1024);
        assert.equal(statSync(file()).size, 40 * 1024);
        assert.ok(DIAG_LOG_MAX_BYTES === 100 * 1024);

        writeFileSync(file(), "nova\n".repeat(10));
        assert.equal(await appendDiagLogMain(batch.repeat(3)), true);
        assert.equal(readFileSync(file() + ".1", "utf8"), "nova\n".repeat(10), "o .1 anterior some");
    });

    test("le as ultimas DIAG_LOG_TAIL_LINES das duas partes (.1 primeiro), sem linhas vazias", async () => {
        freshDir();
        assert.deepEqual(await readDiagLogMain(), [], "nada gravado ainda");
        await appendDiagLogMain("x\n");
        writeFileSync(file() + ".1", Array.from({ length: 300 }, (_, i) => `velha ${i}`).join("\r\n") + "\r\n\r\n");
        writeFileSync(file(), Array.from({ length: 300 }, (_, i) => `nova ${i}`).join("\n") + "\n");
        const lines = await readDiagLogMain();
        assert.equal(lines.length, DIAG_LOG_TAIL_LINES);
        assert.equal(lines[0], "velha 100");
        assert.equal(lines.at(-1), "nova 299");
    });

    test("apagar (a opcao foi desligada): renderer.log e .1 somem; sem arquivo tambem da certo", async () => {
        freshDir();
        assert.equal(await clearDiagLog(ipcEvent()), true, "nada gravado ainda: nada a apagar");
        await appendDiagLogMain("a\n");
        writeFileSync(file() + ".1", "velha\n");
        assert.equal(await clearDiagLogMain(), true);
        assert.equal(existsSync(file()), false);
        assert.equal(existsSync(file() + ".1"), false);
        assert.deepEqual(await readDiagLogMain(), []);
    });

    test("lote invalido (nao e texto, vazio, grande demais) e recusado sem gravar", async () => {
        freshDir();
        for (const bad of [42, null, "", "z".repeat(DIAG_LOG_MAX_APPEND_CHARS + 1)]) assert.equal(await appendDiagLogMain(bad), false, String(bad).slice(0, 20));
        assert.equal(existsSync(file()), false);
    });

    test("erro de disco ou de caminho: false / [] (nunca lanca para o renderer)", async t => {
        // um arquivo onde deveria estar a pasta
        dir = join(root, `ocupado${++n}`);
        writeFileSync(dir, "nao sou uma pasta");
        setDiagLogDirForTests(dir);
        assert.equal(await appendDiagLogMain("a\n"), false);

        // sem pasta de teste: o caminho de verdade vem do electron (aqui, falhando)
        setDiagLogDirForTests(null);
        t.mock.method(app, "getPath", () => {
            throw new Error("sem appData");
        });
        assert.equal(await appendDiagLogMain("a\n"), false);
        assert.deepEqual(await readDiagLogMain(), []);
        assert.equal(await clearDiagLogMain(), false);
    });
});
