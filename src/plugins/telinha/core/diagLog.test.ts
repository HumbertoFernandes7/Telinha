/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do registro do Telinha em arquivo, lado renderer (core/diagLog.ts), sobre os natives falsos (o arquivo de
// verdade e do processo main: diagLogMain.test.ts) e o relogio falso: o formato das linhas, os lotes (no maximo
// DIAG_LOG_BATCH_LINES, um por vez, a cada DIAG_LOG_FLUSH_MS), o limite do que espera, a falha que desliga o registro e a
// leitura da sessao anterior (so outras sessoes, com limites de linhas e de caracteres).
// Rodar:  pnpm test:file src/plugins/telinha/core/diagLog.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { DIAG_MAX_LINE_CHARS } from "@plugins/telinha/protocol";
import { getEventLog } from "@plugins/telinha/store";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";

import {
    clearDiagLog, DIAG_LOG_BATCH_LINES, DIAG_LOG_FLUSH_MS, DIAG_LOG_MAX_PENDING_LINES, DIAG_PREVIOUS_MAX_CHARS, DIAG_PREVIOUS_MAX_LINES, diagLogSession,
    readPreviousSession, startDiagLog, stopDiagLog
} from "./diagLog";
import { log } from "./log";

const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z [0-9a-f]{8} (?:info|warn|error) /;

let native: NativeEnv | null = null;

/** Natives falsos; os lotes que o main recebeu ficam em `batches` (uma lista de linhas por lote). */
function withNative(append: (text: string) => Promise<unknown> = async () => true, read: () => Promise<unknown> = async () => []) {
    const batches: string[][] = [];
    native = installNative({
        appendDiagLog: async (text: string) => {
            batches.push(text.split("\n").filter(Boolean));
            return append(text);
        },
        readDiagLog: read
    });
    return batches;
}

afterEach(() => {
    stopDiagLog();
    native?.restore();
    native = null;
});

describe("sessao", () => {
    test("8 hex aleatorios, os mesmos durante o carregamento", () => {
        assert.match(diagLogSession(), /^[0-9a-f]{8}$/);
        assert.equal(diagLogSession(), diagLogSession());
    });
});

describe("gravar", () => {
    test("sem a parte nativa, ou com um native.ts sem o registro: nao grava nada", async t => {
        const clock = useFakeClock(t);
        startDiagLog();
        log.info("sem native");
        clock.tick(DIAG_LOG_FLUSH_MS);
        stopDiagLog();

        const old: Record<string, never>[] = [{ appendDiagLog: undefined as never, readDiagLog: undefined as never }, { readDiagLog: undefined as never }];
        for (const missing of old) {
            native = installNative(missing);
            startDiagLog();
            log.info("native antigo");
            clock.tick(DIAG_LOG_FLUSH_MS);
            await flushPromises();
            assert.deepEqual(native.calls, []);
            assert.equal(await readPreviousSession(), null);
            native.restore();
        }
    });

    test("a primeira vez leva o que o buffer ja tinha; depois, cada linha nova num lote a cada DIAG_LOG_FLUSH_MS", async t => {
        const clock = useFakeClock(t);
        log.warn("antes de ligar");
        const before = getEventLog().length;
        const batches = withNative();
        startDiagLog();
        log.error("depois de ligar\nsegunda linha");
        clock.tick(DIAG_LOG_FLUSH_MS - 1);
        assert.equal(batches.length, 0, "espera o lote juntar");
        clock.tick(1);
        await flushPromises();
        assert.equal(batches.length, 1);
        const sid = diagLogSession();
        const [lines] = batches;
        assert.equal(lines.length, before + 2, "o buffer, o marcador e a linha nova");
        for (const l of lines) assert.match(l, LINE_RE);
        assert.ok(lines.some(l => l.endsWith(` ${sid} warn antes de ligar`)));
        assert.match(lines.at(-2)!, new RegExp(` ${sid} info --- registro do Telinha em arquivo ligado \\(sessão ${sid}\\) ---$`));
        assert.equal(lines.at(-1), `${new Date(Date.now() - DIAG_LOG_FLUSH_MS).toISOString()} ${sid} error depois de ligar ⏎ segunda linha`);

        stopDiagLog();
        startDiagLog();
        clock.tick(DIAG_LOG_FLUSH_MS);
        await flushPromises();
        assert.equal(batches.length, 2);
        assert.equal(batches[1].length, 1, "ligado de novo: so o marcador (o buffer ja foi)");
    });

    test("linha longa cortada; lotes de no maximo DIAG_LOG_BATCH_LINES, um de cada vez", async t => {
        const clock = useFakeClock(t);
        const batches = withNative();
        startDiagLog();
        log.info("x".repeat(5000));
        for (let i = 0; i < 2 * DIAG_LOG_BATCH_LINES + 20; i++) log.info(`linha ${i}`);
        await flushPromises();
        assert.equal(batches.length, 1, "o primeiro lote saiu quando juntou; o resto espera ele terminar");
        assert.equal(batches[0].length, DIAG_LOG_BATCH_LINES);
        assert.equal(batches[0][1].length, batches[0][1].indexOf("info ") + 5 + DIAG_MAX_LINE_CHARS);
        clock.tick(DIAG_LOG_FLUSH_MS);
        await flushPromises();
        clock.tick(DIAG_LOG_FLUSH_MS);
        await flushPromises();
        assert.deepEqual(batches.map(b => b.length), [DIAG_LOG_BATCH_LINES, DIAG_LOG_BATCH_LINES, 22]);
        assert.match(batches[2].at(-1)!, / info linha 219$/);
    });

    test("o main demora: o que espera passa de DIAG_LOG_MAX_PENDING_LINES e as mais velhas saem", async t => {
        const clock = useFakeClock(t);
        let release!: () => void;
        const batches = withNative(() => new Promise<boolean>(resolve => (release = () => resolve(true))));
        startDiagLog();
        log.info("primeira");
        clock.tick(DIAG_LOG_FLUSH_MS);
        await flushPromises();
        assert.equal(batches.length, 1);
        for (let i = 0; i < DIAG_LOG_MAX_PENDING_LINES + 50; i++) log.info(`espera ${i}`);
        release();
        await flushPromises();
        for (let i = 0; i < 6; i++) {
            clock.tick(DIAG_LOG_FLUSH_MS);
            await flushPromises();
            release();
            await flushPromises();
        }
        const waited = batches.slice(1).flat();
        assert.equal(waited.length, DIAG_LOG_MAX_PENDING_LINES);
        assert.match(waited[0], / info espera 50$/);
    });

    test("parar manda o que esperava num ultimo lote; parar e ligar de novo nao duplica o listener", async t => {
        const clock = useFakeClock(t);
        const batches = withNative();
        startDiagLog();
        startDiagLog();
        log.info("ultima");
        stopDiagLog();
        stopDiagLog();
        await flushPromises();
        assert.equal(batches.length, 1);
        assert.match(batches[0].at(-1)!, / info ultima$/);
        log.info("desligado");
        clock.tick(DIAG_LOG_FLUSH_MS);
        await flushPromises();
        assert.equal(batches.length, 1, "desligado: nada mais");
    });

    for (const [what, append, why] of [
        ["o main diz que nao gravou", async () => false, "o processo principal não gravou"],
        ["o IPC falha", async () => {
            throw new Error("IPC caiu");
        }, "Error: IPC caiu"]
    ] as const) {
        test(`falha ao gravar (${what}): um aviso e o registro para; ligar de novo tenta outra vez`, async t => {
            const clock = useFakeClock(t);
            const batches = withNative(append);
            startDiagLog();
            log.info("vai falhar");
            clock.tick(DIAG_LOG_FLUSH_MS);
            await flushPromises();
            const warn = getEventLog().at(-1)!;
            assert.equal(warn.level, "warn");
            assert.equal(warn.msg, `O registro do Telinha em arquivo parou nesta sessão (${why}): o diagnóstico compartilhado vai sem a sessão anterior`);
            log.info("depois da falha");
            clock.tick(DIAG_LOG_FLUSH_MS);
            await flushPromises();
            assert.equal(batches.length, 1, "parou");

            stopDiagLog();
            startDiagLog();
            clock.tick(DIAG_LOG_FLUSH_MS);
            await flushPromises();
            assert.equal(batches.length, 2, "religado: tenta de novo");
        });
    }
});

describe("parar no meio (por ultimo: o que esperava fica para a proxima vez que ligar)", () => {
    test("parar com um lote a caminho: o que esperava fica para depois, sem timer sobrando", async t => {
        const clock = useFakeClock(t);
        let release!: () => void;
        const batches = withNative(() => new Promise<boolean>(resolve => (release = () => resolve(true))));
        startDiagLog();
        stopDiagLog();
        startDiagLog();
        log.info("esperando o lote");
        stopDiagLog();
        clock.tick(DIAG_LOG_FLUSH_MS);
        release();
        await flushPromises();
        clock.tick(DIAG_LOG_FLUSH_MS);
        await flushPromises();
        assert.equal(batches.length, 1, "parado: o lote a caminho terminou e nada mais saiu");
    });
});

describe("ler a sessao anterior", () => {
    const iso = (at: number) => new Date(at).toISOString();

    test("so as linhas de outras sessoes, mais antiga primeiro; lixo e linha desta sessao ficam de fora", async () => {
        const at = Date.UTC(2026, 9, 28, 22, 15, 3, 7);
        const sid = diagLogSession();
        withNative(undefined, async () => [
            `${iso(at)} 0badc0de info comecou`,
            `${iso(at + 1)} 0badc0de error travou: C:\\Users\\x`,
            "linha sem formato",
            `${iso(at + 2)} 0badc0de debug nivel desconhecido`,
            42,
            `${iso(at + 3)} ${sid} info desta sessao`,
            `${iso(at + 4)} cafebabe warn outra sessao`
        ]);
        assert.deepEqual(await readPreviousSession(), [
            { at, level: "info", text: "comecou" },
            { at: at + 1, level: "error", text: "travou: C:\\Users\\x" },
            { at: at + 4, level: "warn", text: "outra sessao" }
        ]);
    });

    test("no maximo DIAG_PREVIOUS_MAX_LINES linhas e DIAG_PREVIOUS_MAX_CHARS caracteres, as mais novas", async () => {
        const at = Date.UTC(2026, 9, 28);
        withNative(undefined, async () => Array.from({ length: DIAG_PREVIOUS_MAX_LINES + 100 }, (_, i) => `${iso(at + i)} 0badc0de info l${i}`));
        const many = (await readPreviousSession())!;
        assert.equal(many.length, DIAG_PREVIOUS_MAX_LINES);
        assert.equal(many[0].text, "l100");

        const long = "y".repeat(1000);
        withNative(undefined, async () => Array.from({ length: 300 }, (_, i) => `${iso(at + i)} 0badc0de info ${long}`));
        const big = (await readPreviousSession())!;
        assert.equal(big.length, Math.floor(DIAG_PREVIOUS_MAX_CHARS / 1000));
        assert.equal(big.at(-1)?.at, at + 299);
    });

    test("o main falha ou devolve algo que nao e lista: null (vai sem a sessao anterior)", async () => {
        withNative(undefined, async () => {
            throw new Error("sem acesso");
        });
        assert.equal(await readPreviousSession(), null);
        withNative(undefined, async () => "texto");
        assert.equal(await readPreviousSession(), null);
        withNative(undefined, async () => []);
        assert.deepEqual(await readPreviousSession(), []);
    });
});

describe("apagar (a opcao foi desligada)", () => {
    test("para de gravar, esquece o que esperava e pede ao main para apagar renderer.log e .1", async t => {
        const clock = useFakeClock(t);
        const batches = withNative();
        startDiagLog();
        log.info("nunca vai");
        clearDiagLog();
        log.info("nem esta");
        clock.tick(DIAG_LOG_FLUSH_MS);
        await flushPromises();
        assert.equal(batches.length, 0);
        assert.equal(native!.calls.filter(c => c.name === "clearDiagLog").length, 1);

        clearDiagLog();
        await flushPromises();
        assert.equal(native!.calls.filter(c => c.name === "clearDiagLog").length, 2, "parado: apaga do mesmo jeito");
    });

    for (const [what, clear, why] of [
        ["o main diz que nao apagou", async () => false, "o processo principal não apagou"],
        ["o IPC falha", async () => {
            throw new Error("IPC caiu");
        }, "Error: IPC caiu"]
    ] as const) {
        test(`falha ao apagar (${what}): so um aviso no log`, async () => {
            native = installNative({ clearDiagLog: clear });
            clearDiagLog();
            await flushPromises();
            const warn = getEventLog().at(-1)!;
            assert.equal(warn.level, "warn");
            assert.equal(warn.msg, `Não deu para apagar o registro do Telinha em arquivo (${why})`);
        });
    }

    test("sem a parte nativa, ou com um native.ts sem clearDiagLog: nada (e nada lanca)", async () => {
        const before = getEventLog().length;
        clearDiagLog();
        native = installNative({ clearDiagLog: undefined as never });
        clearDiagLog();
        await flushPromises();
        assert.deepEqual(native.calls, []);
        assert.equal(getEventLog().length, before);
    });
});
