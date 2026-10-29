/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado main do audio da tela inteira (core/audio/screenAudioMain.ts) com um telinha-audio.exe de mentira:
// mockSpawn (test/fakes/childProcess.ts) no lugar do child_process.spawn, relogio falso para os prazos (probe 6 s,
// pronto 5 s, leitura parada 5 s, parada educada 800 ms) e um exe vazio numa pasta temporaria (test/helpers/wpd-audio.ts).
// Nunca roda o helper de verdade: isso fica para addon/test/run-main-test.mjs (precisa do Windows e do exe).
// Rodar:  pnpm test:file src/plugins/telinha/core/audio/screenAudioMain.test.ts

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, describe, mock, test } from "node:test";

import { type FakeChildProcess, mockSpawn, type SpawnEnv } from "@test/fakes/childProcess";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { answer, feed, feedErr, floatsOf, helperHost, pcm } from "@test/helpers/wpd-audio";

import {
    readScreenAudioMain,
    SCREEN_AUDIO_HELPER,
    screenAudioDroppedBytes,
    screenAudioStatusMain,
    setScreenAudioHelperPathForTests,
    startScreenAudioMain,
    stopScreenAudioMain
} from "./screenAudioMain";
import { SCREEN_AUDIO_BYTES_PER_FRAME, SCREEN_AUDIO_CHANNELS, SCREEN_AUDIO_MAX_WAIT_MS, SCREEN_AUDIO_RATE } from "./types";

const READY = "ready 48000 2\n";
const ALREADY_STOPPED = { pcm: null, ended: true, reason: "a captura de áudio já foi encerrada" };

// O modulo instala UM gancho em process.once("exit") na primeira captura do processo: guardo-o para chamar a mao.
const exitHooks: (() => void)[] = [];
let restoreOnce: () => void;

before(() => {
    const original = process.once.bind(process);
    const m = mock.method(process, "once", ((event: string, fn: () => void) => {
        if (event === "exit") {
            exitHooks.push(fn);
            return process;
        }
        return original(event as "exit", fn);
    }) as never);
    restoreOnce = () => m.mock.restore();
});

after(() => {
    stopScreenAudioMain();
    restoreOnce();
});

/** Inicia uma captura e deixa o helper dizer "ready". */
async function startReady(procs: SpawnEnv, pid = 4242) {
    const promise = startScreenAudioMain(pid);
    const proc = procs.spawned.at(-1)!;
    await feedErr(proc, READY);
    const result = await promise;
    assert.ok(result.ok, "o helper ficou pronto");
    return { proc, id: result.ok ? result.id : -1, result };
}

/** Para a captura e deixa o helper sair (cancela o kill agendado da parada educada). */
function end(proc: FakeChildProcess) {
    stopScreenAudioMain();
    proc.exit(0);
}

describe("constantes do contrato", () => {
    test("o formato do PCM e coerente: 48 kHz, estereo, float32 = 8 bytes por frame", () => {
        assert.equal(SCREEN_AUDIO_RATE, 48000);
        assert.equal(SCREEN_AUDIO_CHANNELS, 2);
        assert.equal(SCREEN_AUDIO_BYTES_PER_FRAME, SCREEN_AUDIO_CHANNELS * Float32Array.BYTES_PER_ELEMENT);
        assert.equal(SCREEN_AUDIO_HELPER, "telinha-audio.exe");
    });
});

describe("screenAudioStatusMain: pre-requisitos e probe", () => {
    test("fora do Windows nem tenta abrir o helper", async t => {
        helperHost(t, { platform: "linux" });
        const procs = mockSpawn(t);
        assert.deepEqual(await screenAudioStatusMain(), { available: false, reason: "o áudio da tela inteira só funciona no Windows" });
        assert.equal(procs.spawned.length, 0);
    });

    test("Windows mais velho que o 10 2004: diz o build; release ilegivel vira '?'; 19041 ja serve", async t => {
        const host = helperHost(t, { build: 18363 });
        const procs = mockSpawn(t, p => answer(p, { code: 0 }));
        const old = await screenAudioStatusMain();
        assert.equal(old.available, false);
        assert.match(old.reason, /Windows 10 versão 2004 ou mais novo \(este é o build 18363\)/);

        host.setBuild("garbage");
        assert.match((await screenAudioStatusMain()).reason, /build \?\)/);

        host.setBuild(19040);
        assert.equal((await screenAudioStatusMain()).available, false);
        assert.equal(procs.spawned.length, 0, "nenhuma consulta chegou a abrir o helper");

        host.setBuild(19041);
        assert.equal((await screenAudioStatusMain()).available, true);
        assert.equal(procs.spawned.length, 1);
    });

    test("sem o exe ao lado do Telinha: motivo com o nome do ajudante", async t => {
        helperHost(t, { exe: false });
        const procs = mockSpawn(t);
        const status = await screenAudioStatusMain();
        assert.equal(status.available, false);
        assert.match(status.reason, /telinha-audio\.exe\) não foi instalado junto com o Telinha/);
        assert.equal(procs.spawned.length, 0);
    });

    test("sem o caminho de teste: o exe vem de TELINHA_HELPER_DIR (so absoluto), senao da pasta do proprio modulo", async t => {
        const host = helperHost(t);
        const dir = dirname(host.exe);
        const saved = process.env.TELINHA_HELPER_DIR;
        t.after(() => {
            if (saved === undefined) delete process.env.TELINHA_HELPER_DIR;
            else process.env.TELINHA_HELPER_DIR = saved;
        });
        const procs = mockSpawn(t, p => answer(p, { code: 0 }));

        setScreenAudioHelperPathForTests(null);
        process.env.TELINHA_HELPER_DIR = dir;
        assert.equal((await screenAudioStatusMain()).available, true);
        assert.equal(procs.spawned[0].command, join(dir, SCREEN_AUDIO_HELPER), "o loader do add-on aponta a pasta do exe");

        // caminho relativo nao vale (so absoluto): cai na pasta do modulo, onde nao ha exe
        for (const value of ["pasta/relativa", ".", ""]) {
            setScreenAudioHelperPathForTests(null);
            process.env.TELINHA_HELPER_DIR = value;
            const status = await screenAudioStatusMain();
            assert.equal(status.available, false, value);
            assert.match(status.reason, /não foi instalado junto com o Telinha/);
        }
        setScreenAudioHelperPathForTests(null);
        delete process.env.TELINHA_HELPER_DIR;
        assert.equal((await screenAudioStatusMain()).available, false);
        assert.equal(procs.spawned.length, 1, "so o primeiro chegou a abrir o helper");
    });

    test("probe com saida 0: disponivel, rodou `--probe` com stdin fechado e o sucesso fica em cache", async t => {
        const host = helperHost(t);
        const procs = mockSpawn(t, p => answer(p, { code: 0 }));
        const status = await screenAudioStatusMain();
        assert.deepEqual(status, { available: true, reason: "áudio do PC sem o Discord (process loopback do Windows)" });
        assert.equal(procs.spawned.length, 1);
        const [proc] = procs.spawned;
        assert.equal(proc.command, host.exe);
        assert.deepEqual(proc.args, ["--probe"]);
        assert.deepEqual(proc.options, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
        assert.equal(proc.stdinEnded, true);

        assert.equal((await screenAudioStatusMain()).available, true);
        assert.equal(procs.spawned.length, 1, "o sucesso do probe e cacheado");
    });

    test("duas consultas ao mesmo tempo dividem um unico probe", async t => {
        helperHost(t);
        const procs = mockSpawn(t, p => answer(p, { code: 0 }));
        const [a, b] = await Promise.all([screenAudioStatusMain(), screenAudioStatusMain()]);
        assert.equal(a.available, true);
        assert.equal(b.available, true);
        assert.equal(procs.spawned.length, 1);
    });

    // [codigo, sinal, stderr, motivo esperado]
    const probeFailures: [number | null, NodeJS.Signals | null, string, string][] = [
        [1, null, "", "o ajudante de áudio foi encerrado por outro programa (antivírus?)"],
        [1, null, "ruido\nerror capture 0x80070005 Acesso negado\r\n", "a captura de áudio parou (0x80070005 — Acesso negado)"],
        [1, null, "error capture sem-codigo-hr\n", "o ajudante de áudio foi encerrado por outro programa (antivírus?)"],
        [3, null, "", "o áudio da tela inteira exige Windows 10 versão 2004 ou mais novo"],
        [2, null, "error os 0x00000032 nao suportado\n", "o áudio da tela inteira exige Windows 10 versão 2004 ou mais novo"],
        [4, null, "", "o Windows recusou a captura de áudio do sistema"],
        [4, null, "error activate 0x88890004\n", "o Windows recusou a captura de áudio do sistema (0x88890004)"],
        [4, null, "error activate 0x88890004 Dispositivo invalido\n", "o Windows recusou a captura de áudio do sistema (0x88890004 — Dispositivo invalido)"],
        [5, null, "", "não foi possível iniciar a captura de áudio do Windows"],
        [5, null, "error start 0x8000FFFF falhou\n", "não foi possível iniciar a captura de áudio do Windows (0x8000FFFF — falhou)"],
        [null, "SIGKILL", "", "o ajudante de áudio foi encerrado"],
        [null, null, "", "o ajudante de áudio fechou inesperadamente (código ?)"],
        [7, null, "", "o ajudante de áudio fechou inesperadamente (código 7)"]
    ];

    for (const [code, signal, stderr, reason] of probeFailures) {
        test(`probe falha: saida ${code ?? "null"}${signal ? `/${signal}` : ""}${stderr ? " com stderr" : ""} -> motivo em pt-BR`, async t => {
            helperHost(t);
            const procs = mockSpawn(t, p => answer(p, { code, signal, stderr }));
            assert.deepEqual(await screenAudioStatusMain(), { available: false, reason });

            // so o sucesso fica em cache: a proxima consulta abre o helper de novo
            await screenAudioStatusMain();
            assert.equal(procs.spawned.length, 2);
        });
    }

    test("stderr gigante do probe e cortado: a linha de erro que vem depois dos 16 KB nao e lida", async t => {
        helperHost(t);
        mockSpawn(t, p => setImmediate(async () => {
            await feedErr(p, "x".repeat(20_000));
            await feedErr(p, "error activate 0x88890004 perdido\n");
            p.exit(4);
        }));
        assert.deepEqual(await screenAudioStatusMain(), { available: false, reason: "o Windows recusou a captura de áudio do sistema" });
    });

    for (const [code, expected] of [
        ["ENOENT", /não foi encontrado \(o antivírus pode tê-lo removido\)/],
        ["EPERM", /o Windows ou o antivírus bloqueou o ajudante de áudio/],
        ["EACCES", /o Windows ou o antivírus bloqueou/],
        ["UNKNOWN", /o Windows ou o antivírus bloqueou/],
        ["EMFILE", /não foi possível abrir o ajudante de áudio: EMFILE too many open files/]
    ] as const) {
        test(`erro ao abrir o helper (${code}): motivo em pt-BR`, async t => {
            helperHost(t);
            mockSpawn(t, p => setImmediate(() => p.fail(Object.assign(new Error("too many open files"), { code }))));
            const status = await screenAudioStatusMain();
            assert.equal(status.available, false);
            assert.match(status.reason, expected);
        });
    }

    test("spawn que lanca na hora (um texto qualquer) vira motivo, sem excecao", async t => {
        helperHost(t);
        mockSpawn(t, () => {
            throw "kaboom";
        });
        const status = await screenAudioStatusMain();
        assert.equal(status.available, false);
        assert.match(status.reason, /não foi possível abrir o ajudante de áudio:\s+kaboom/);
    });

    test("spawn que lanca na hora (ENOENT): mesmo motivo do evento 'error'", async t => {
        helperHost(t);
        mockSpawn(t, () => {
            throw Object.assign(new Error("not found"), { code: "ENOENT" });
        });
        assert.match((await screenAudioStatusMain()).reason, /não foi encontrado/);
    });

    test("probe que nao responde em 6 s: mata o helper e diz que nao respondeu; nao fica em cache", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const status = screenAudioStatusMain();
        let settled = false;
        void status.then(() => (settled = true));
        clock.tick(5999);
        await flushPromises();
        assert.equal(settled, false);
        assert.equal(procs.spawned[0].killed, false);
        clock.tick(1);
        assert.deepEqual(await status, { available: false, reason: "o ajudante de áudio não respondeu" });
        assert.equal(procs.spawned[0].killed, true);

        // uma saida tardia do helper nao muda nada e a proxima consulta abre outro probe
        procs.spawned[0].exit(0);
        const again = screenAudioStatusMain();
        assert.equal(procs.spawned.length, 2);
        clock.tick(6000);
        assert.equal((await again).available, false);
    });

    test("probe: kill que lanca e streams com erro nao derrubam o main", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.kill = () => {
                throw new Error("EPERM");
            };
        });
        const status = screenAudioStatusMain();
        const [proc] = procs.spawned;
        proc.stdin.emit("error", new Error("EPIPE"));
        proc.stdout.emit("error", new Error("EIO"));
        proc.stderr.emit("error", new Error("EIO"));
        clock.tick(6000);
        assert.equal((await status).reason, "o ajudante de áudio não respondeu");
    });

    test("o erro de abertura vem antes da saida: a primeira resposta vence", async t => {
        helperHost(t);
        mockSpawn(t, p => setImmediate(() => {
            p.fail(Object.assign(new Error("x"), { code: "ENOENT" }));
            p.exit(0);
        }));
        assert.match((await screenAudioStatusMain()).reason, /não foi encontrado/);
    });
});

describe("startScreenAudioMain: validacao e arranque", () => {
    test("recusa fora do Windows, sem exe e com Windows antigo; nunca abre processo", async t => {
        const host = helperHost(t, { platform: "darwin" });
        const procs = mockSpawn(t);
        assert.deepEqual(await startScreenAudioMain(100), { ok: false, reason: "o áudio da tela inteira só funciona no Windows" });

        host.setPlatform("win32");
        host.setExe(false);
        const noExe = await startScreenAudioMain(100);
        assert.equal(noExe.ok === false && /não foi instalado junto com o Telinha/.test(noExe.reason), true);

        host.setExe(true);
        host.setBuild(10240);
        const old = await startScreenAudioMain(100);
        assert.equal(old.ok === false && /build 10240/.test(old.reason), true);
        assert.equal(procs.spawned.length, 0);
    });

    test("PID invalido (0, negativo, fracionario, NaN, infinito, acima de 32 bits): recusa; 0xFFFFFFFF passa", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        for (const pid of [0, -4, 1.5, Number.NaN, 0x100000000, Number.POSITIVE_INFINITY]) {
            assert.deepEqual(await startScreenAudioMain(pid), { ok: false, reason: `PID inválido (${pid})` }, String(pid));
        }
        assert.equal(procs.spawned.length, 0);

        const pending = startScreenAudioMain(0xFFFFFFFF);
        assert.equal(procs.spawned.length, 1);
        assert.deepEqual(procs.spawned[0].args.slice(0, 2), ["--exclude", "4294967295"]);
        end(procs.spawned[0]);
        assert.equal((await pending).ok, false);
    });

    test("spawn lanca na hora: devolve o motivo e nao deixa captura pendurada", async t => {
        helperHost(t);
        mockSpawn(t, () => {
            throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
        });
        const r = await startScreenAudioMain(4242);
        assert.equal(r.ok, false);
        assert.match(r.ok ? "" : r.reason, /bloqueou o ajudante/);
        assert.deepEqual(await readScreenAudioMain(1, 0), ALREADY_STOPPED);
    });

    test("abre `--exclude <pid> --parent <pid do main>` escondido, sem shell, e fica pronto no 'ready'", async t => {
        const host = helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id, result } = await startReady(procs, 777);
        assert.equal(proc.command, host.exe);
        assert.deepEqual(proc.args, ["--exclude", "777", "--parent", String(process.pid)]);
        assert.deepEqual(proc.options, { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
        assert.deepEqual(result, { ok: true, id, sampleRate: SCREEN_AUDIO_RATE, channels: SCREEN_AUDIO_CHANNELS });
        assert.deepEqual(await screenAudioStatusMain(), { available: true, reason: "capturando" });
        end(proc);
    });

    test("'ready' em pedacos, com CRLF e depois de outras linhas; um segundo 'ready' e ignorado", async t => {
        helperHost(t);
        useFakeClock(t);
        const procs = mockSpawn(t);
        const promise = startScreenAudioMain(1);
        const [proc] = procs.spawned;
        await feedErr(proc, "info carregando\r\nrea");
        await feedErr(proc, "dy 48000 2\r\nready 1 1\n");
        const r = await promise;
        assert.equal(r.ok, true);
        end(proc);
    });

    test("o 'ready' nao chega em 5 s: falha, encerra o helper (stdin fechado, kill depois da graca) e some a captura", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const promise = startScreenAudioMain(1);
        const [proc] = procs.spawned;
        clock.tick(4999);
        await flushPromises();
        assert.equal(proc.stdinEnded, false);
        clock.tick(1);
        assert.deepEqual(await promise, { ok: false, reason: "o ajudante de áudio não ficou pronto a tempo" });
        await flushPromises();
        assert.equal(proc.stdinEnded, true, "pedido educado: fecha o stdin");
        assert.equal(proc.killed, false);
        clock.tick(799);
        assert.equal(proc.killed, false);
        clock.tick(1);
        assert.equal(proc.killed, true, "se nao saiu em 800 ms, mata");
        assert.deepEqual(await readScreenAudioMain(1, 0), ALREADY_STOPPED);
    });

    test("saida antes do 'ready': o motivo vem do codigo e da linha 'error ...' do helper", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const promise = startScreenAudioMain(1);
        const [proc] = procs.spawned;
        await feedErr(proc, "error loopback 0x88890008 formato\n");
        proc.exit(4);
        assert.deepEqual(await promise, { ok: false, reason: "o Windows recusou a captura de áudio do sistema (0x88890008 — formato)" });
        assert.deepEqual(await readScreenAudioMain(1, 0), ALREADY_STOPPED);
    });

    test("saida com codigo 0 antes do 'ready'", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const promise = startScreenAudioMain(1);
        procs.spawned[0].exit(0);
        assert.deepEqual(await promise, { ok: false, reason: "o ajudante de áudio encerrou" });
    });

    test("'error' do spawn antes do 'ready' (ENOENT): falha com o motivo e o helper e encerrado", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const promise = startScreenAudioMain(1);
        const [proc] = procs.spawned;
        proc.fail(Object.assign(new Error("spawn"), { code: "ENOENT" }));
        const r = await promise;
        assert.equal(r.ok, false);
        assert.match(r.ok ? "" : r.reason, /não foi encontrado/);
        await flushPromises();
        assert.equal(proc.stdinEnded, true);
        proc.exit(1);
    });

    test("erros nos streams do helper nao viram excecao no main (EPIPE)", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc } = await startReady(procs);
        proc.stdin.emit("error", new Error("EPIPE"));
        proc.stdout.emit("error", new Error("EIO"));
        proc.stderr.emit("error", new Error("EIO"));
        end(proc);
    });

    test("stderr sem quebra de linha passa de 16 KB: o resto e ignorado e o 'ready' que vem depois nao conta", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const promise = startScreenAudioMain(1);
        const [proc] = procs.spawned;
        await feedErr(proc, "x".repeat(17_000));
        await feedErr(proc, READY);
        clock.tick(5000);
        assert.equal((await promise).ok, false);
    });

    test("linha 'error ...' e guardada (cortada em 300 caracteres) e entra no motivo da saida", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        await feedErr(proc, "error capture 0x80070490 " + "y".repeat(500) + "\n");
        proc.exit(1);
        const r = await readScreenAudioMain(id, 0);
        assert.equal(r.ended, true);
        // "error " + "capture " + "0x80070490 " = 25 caracteres de prefixo; 300 no total
        assert.equal(r.reason, `a captura de áudio parou (0x80070490 — ${"y".repeat(300 - 25)})`);
        stopScreenAudioMain();
    });
});

describe("PCM: do stdout do helper ate a leitura", () => {
    test("quadros inteiros passam; o resto de um quadro espera o proximo pedaco", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);

        const all = pcm(4); // quadros 1..4: L = k, R = -k
        await feed(proc, all.subarray(0, 12)); // 1 quadro + 4 bytes
        let r = await readScreenAudioMain(id, 0);
        assert.deepEqual(floatsOf(r.pcm!), [1, -1]);
        assert.equal(r.ended, false);

        await feed(proc, all.subarray(12, 20)); // completa o quadro 2 e deixa 4 bytes do quadro 3
        await feed(proc, all.subarray(20, 32));
        r = await readScreenAudioMain(id, 0);
        assert.deepEqual(floatsOf(r.pcm!), [2, -2, 3, -3, 4, -4]);
        end(proc);
    });

    test("menos de um quadro: nada para ler e nada se perde", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        await feed(proc, pcm(1).subarray(0, 7));
        const pending = readScreenAudioMain(id, 100);
        clock.tick(100);
        assert.deepEqual(await pending, { pcm: null, ended: false });
        await feed(proc, pcm(1).subarray(7));
        assert.deepEqual(floatsOf((await readScreenAudioMain(id, 0)).pcm!), [1, -1]);
        end(proc);
    });

    test("cada leitura devolve uma copia exata num ArrayBuffer proprio (o IPC serializa o buffer inteiro)", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        await feed(proc, pcm(10));
        await feed(proc, pcm(5, 11));
        const { pcm: out } = await readScreenAudioMain(id, 0);
        assert.equal(out!.byteOffset, 0);
        assert.equal(out!.buffer.byteLength, 15 * 8);
        assert.equal(floatsOf(out!)[28], 15);
        // a fila foi esvaziada
        const next = readScreenAudioMain(id, 0);
        clock.tick(0);
        assert.equal((await next).pcm, null);
        end(proc);
    });

    test("o renderer nao le a tempo: passou de 500 ms (192000 bytes) descarta o mais antigo e conta os bytes", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        assert.equal(screenAudioDroppedBytes(), 0);
        await feed(proc, pcm(12_500, 1)); // 100000 bytes
        await feed(proc, pcm(12_500, 12_501)); // 200000 bytes > 192000: o primeiro pedaco sai
        assert.equal(screenAudioDroppedBytes(), 100_000);
        await feed(proc, pcm(12_500, 25_001)); // de novo: sai o segundo
        assert.equal(screenAudioDroppedBytes(), 200_000);

        const floats = floatsOf((await readScreenAudioMain(id, 0)).pcm!);
        assert.equal(floats.length, 25_000, "sobra so o pedaco mais novo");
        assert.equal(floats[0], 25_001);
        assert.equal(floats.at(-2), 37_500);
        end(proc);
        assert.equal(screenAudioDroppedBytes(), 0, "sem captura nao ha contagem");
    });

    test("um pedaco unico maior que o limite nao e descartado (so sobra descarte numa fila com 2 ou mais)", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        await feed(proc, pcm(40_000));
        assert.equal(screenAudioDroppedBytes(), 0);
        assert.equal((await readScreenAudioMain(id, 0)).pcm!.byteLength, 320_000);
        end(proc);
    });

    test("PCM que chega antes do 'ready' ja entra; depois de a captura terminar o stdout e ignorado", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const promise = startScreenAudioMain(1);
        const [proc] = procs.spawned;
        await feed(proc, pcm(2));
        await feedErr(proc, READY);
        const started = await promise;
        const id = started.ok ? started.id : -1;
        assert.equal(floatsOf((await readScreenAudioMain(id, 0)).pcm!).length, 4);

        end(proc);
        await feed(proc, pcm(2));
        assert.deepEqual(await readScreenAudioMain(id, 0), ALREADY_STOPPED);
    });
});

describe("readScreenAudioMain: long poll", () => {
    test("sem captura ou com id de outra captura: ja encerrada", async t => {
        helperHost(t);
        assert.deepEqual(await readScreenAudioMain(1, 100), ALREADY_STOPPED);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        assert.deepEqual(await readScreenAudioMain(id + 1, 100), ALREADY_STOPPED);
        end(proc);
    });

    test("espera no maximo 250 ms (mesmo se pedirem mais) e devolve vazio sem encerrar", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        const pending = readScreenAudioMain(id, 10_000);
        let settled = false;
        void pending.then(() => (settled = true));
        clock.tick(SCREEN_AUDIO_MAX_WAIT_MS - 1);
        await flushPromises();
        assert.equal(settled, false);
        clock.tick(1);
        assert.deepEqual(await pending, { pcm: null, ended: false });
        end(proc);
    });

    test("espera menor: arredonda o pedido; negativo, NaN, texto e undefined viram 0 (volta ja)", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);

        const short = readScreenAudioMain(id, 100.4);
        let settled = false;
        void short.then(() => (settled = true));
        clock.tick(99);
        await flushPromises();
        assert.equal(settled, false);
        clock.tick(1);
        assert.deepEqual(await short, { pcm: null, ended: false });

        for (const wait of [-5, Number.NaN, "abc" as unknown as number, undefined as unknown as number]) {
            const p = readScreenAudioMain(id, wait);
            clock.tick(0);
            assert.deepEqual(await p, { pcm: null, ended: false }, String(wait));
        }
        end(proc);
    });

    test("responde assim que o PCM chega, sem esperar o prazo", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        const pending = readScreenAudioMain(id, 250);
        await feed(proc, pcm(480));
        const r = await pending;
        assert.equal(r.ended, false);
        assert.equal(r.pcm!.byteLength, 480 * 8);
        clock.tick(1000); // o prazo foi cancelado: nada dispara depois
        end(proc);
    });

    test("dados ja enfileirados voltam na hora, antes de olhar se acabou", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        await feed(proc, pcm(3));
        proc.exit(0);
        const first = await readScreenAudioMain(id, 250);
        assert.equal(first.pcm!.byteLength, 24);
        assert.equal(first.ended, false, "o que sobrou na fila sai primeiro");
        assert.deepEqual(await readScreenAudioMain(id, 250), { pcm: null, ended: true, reason: "o ajudante de áudio encerrou" });
        stopScreenAudioMain();
    });

    test("uma nova leitura encerra a anterior (vazia): so uma pendente por vez", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        const first = readScreenAudioMain(id, 250);
        const second = readScreenAudioMain(id, 250);
        assert.deepEqual(await first, { pcm: null, ended: false });
        await feed(proc, pcm(2));
        assert.equal((await second).pcm!.byteLength, 16);
        end(proc);
    });

    test("parar com uma leitura pendente: ela volta encerrada com o motivo da parada", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        const pending = readScreenAudioMain(id, 250);
        end(proc);
        assert.deepEqual(await pending, { pcm: null, ended: true, reason: "captura de áudio parada" });
    });

    test("o helper sai durante a leitura: ela volta encerrada com o motivo da saida", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        const pending = readScreenAudioMain(id, 250);
        await feedErr(proc, "error capture 0x8007001F falhou\n");
        proc.exit(1);
        assert.deepEqual(await pending, { pcm: null, ended: true, reason: "a captura de áudio parou (0x8007001F — falhou)" });
        // a captura ja terminada continua respondendo ended (ela so some no stop)
        assert.equal((await readScreenAudioMain(id, 250)).ended, true);
        stopScreenAudioMain();
    });

    test("'error' do processo depois do 'ready' termina a captura com o motivo do spawn", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        proc.fail(Object.assign(new Error("boom"), { code: "EPERM" }));
        const r = await readScreenAudioMain(id, 0);
        assert.equal(r.ended, true);
        assert.match(r.reason ?? "", /bloqueou o ajudante de áudio/);
        end(proc);
    });
});

describe("parar e substituir capturas", () => {
    test("stop sem captura, ou com id de outra, nao faz nada", async t => {
        helperHost(t);
        stopScreenAudioMain();
        stopScreenAudioMain(99);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        stopScreenAudioMain(id + 5);
        await flushPromises();
        assert.equal(proc.stdinEnded, false);
        stopScreenAudioMain(id);
        await flushPromises();
        assert.equal(proc.stdinEnded, true);
        proc.exit(0);
    });

    test("parada educada: fecha o stdin; se o helper sair sozinho dentro de 800 ms o kill nao acontece", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const { proc } = await startReady(procs);
        stopScreenAudioMain();
        await flushPromises();
        assert.equal(proc.stdinEnded, true);
        clock.tick(500);
        proc.exit(0);
        clock.tick(1000);
        assert.equal(proc.killed, false);
    });

    test("helper que nao sai: kill depois de 800 ms; kill e stdin.end que lancam sao engolidos", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const { proc } = await startReady(procs);
        let killCalls = 0;
        proc.kill = () => {
            killCalls++;
            throw new Error("EPERM");
        };
        proc.stdin.end = (() => {
            throw new Error("write after end");
        }) as never;
        stopScreenAudioMain();
        clock.tick(799);
        assert.equal(killCalls, 0);
        clock.tick(1);
        assert.equal(killCalls, 1);
    });

    test("helper que ja saiu: stop nao agenda kill nenhum", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t);
        const { proc } = await startReady(procs);
        proc.exit(0);
        stopScreenAudioMain();
        clock.tick(5000);
        assert.equal(proc.killed, false);
    });

    test("iniciar outra captura para a anterior; o id antigo passa a 'ja encerrada'", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const first = await startReady(procs, 100);
        const second = await startReady(procs, 200);
        assert.notEqual(first.id, second.id);
        await flushPromises();
        assert.equal(first.proc.stdinEnded, true);
        assert.equal(second.proc.stdinEnded, false);
        assert.deepEqual(await readScreenAudioMain(first.id, 0), ALREADY_STOPPED);
        first.proc.exit(0);

        const pending = readScreenAudioMain(second.id, 250);
        await feed(second.proc, pcm(1));
        assert.equal((await pending).ended, false);
        end(second.proc);
    });

    test("um arranque antigo que falha tarde nao derruba a captura nova", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const aPromise = startScreenAudioMain(100); // fica esperando o "ready" e e substituido
        const bPromise = startScreenAudioMain(200);
        const [a, b] = procs.spawned;
        a.exit(null, "SIGTERM");
        assert.deepEqual(await aPromise, { ok: false, reason: "o ajudante de áudio foi encerrado" });
        await feedErr(b, READY);
        const result = await bPromise;
        assert.equal(result.ok, true);
        const pending = readScreenAudioMain(result.ok ? result.id : 0, 250);
        await feed(b, pcm(1));
        assert.equal((await pending).ended, false, "a captura B segue valendo");
        end(b);
    });

    test("leitura parada por mais de 5 s: o main encerra o helper; ler de vez em quando mantem vivo", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        clock.tick(4000);
        const read = readScreenAudioMain(id, 0);
        clock.tick(0);
        await read;
        clock.tick(4000);
        await flushPromises();
        assert.equal(proc.stdinEnded, false, "4 s depois da ultima leitura: ainda vivo");
        clock.tick(2000);
        await flushPromises();
        assert.equal(proc.stdinEnded, true, "mais de 5 s sem ler: encerrado");
        assert.deepEqual(await readScreenAudioMain(id, 0), ALREADY_STOPPED);
    });
});

describe("gancho de saida do processo (process.once('exit'))", () => {
    test("ao sair o Discord, mata o helper da captura em andamento; sem captura nao faz nada; kill que lanca e engolido", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const { proc, id } = await startReady(procs);
        assert.equal(exitHooks.length, 1, "um unico gancho por processo");
        exitHooks[0]();
        assert.equal(proc.killed, true);
        assert.deepEqual(await readScreenAudioMain(id, 0), ALREADY_STOPPED);

        exitHooks[0](); // sem captura

        const second = await startReady(procs);
        second.proc.kill = () => {
            throw new Error("EPERM");
        };
        exitHooks[0]();
        assert.deepEqual(await readScreenAudioMain(second.id, 0), ALREADY_STOPPED);
        assert.equal(exitHooks.length, 1);
        second.proc.exit(0);
    });
});
