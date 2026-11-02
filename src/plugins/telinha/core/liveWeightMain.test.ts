/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado main do peso da live (core/liveWeightMain.ts) com um typeperf.exe e um tasklist.exe de mentira (mockSpawn,
// test/fakes/childProcess.ts) e o app.getAppMetrics do Electron de mentira: os argumentos e a janela escondida, a media
// desde a leitura anterior (Discord, jogo pelo nome do executavel, placa toda, processador), o ciclo de vida (comeca,
// para, a execucao que chega ao fim do -sc e recomeca, o typeperf que cai sem medir, o renderer que para de ler, o
// "exit" do processo) e nenhum processo deixado para tras. Nunca roda o typeperf de verdade.
// Rodar:  pnpm test:file src/plugins/telinha/core/liveWeightMain.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test, type TestContext } from "node:test";

import { type FakeChildProcess, mockSpawn, type SpawnEnv } from "@test/fakes/childProcess";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { app } from "@test/fakes/electron";
import { feed, setPlatform } from "@test/helpers/wpd-audio";

import {
    EARLY_REFRESH_MS, GAME_MIN_3D, IDLE_STOP_MS, LIVE_WEIGHT_COUNTERS, liveWeightRunPidForTests, readLiveWeightMain, resetLiveWeightForTests, SAMPLE_INTERVAL_S, SAMPLES_PER_RUN,
    setTypeperfPathForTests, startLiveWeightMain, stopLiveWeightMain
} from "./liveWeightMain";

const DISCORD_GPU = 51_234;
const GAME = 27_368;
const DWM = 1480;
const LUID = "luid_0x00000000_0x0000B82B";
const MB = 1024 * 1024;

const engine = (pid: number, eng: number, type: string) => String.raw`\\PC\GPU Engine(pid_` + `${pid}_${LUID}_phys_0_eng_${eng}_engtype_${type})\\Utilization Percentage`;
const memory = (pid: number) => String.raw`\\PC\GPU Process Memory(pid_` + `${pid}_${LUID}_phys_0)\\Dedicated Usage`;
const csv = (fields: string[]) => fields.map(f => `"${f}"`).join(",") + "\r\n";

/** Discord principal + GPU, o jogo e o dwm: 3D (motor 0), codificar (6), copiar (3) e a memoria do Discord. */
function header(pids = [process.pid, DISCORD_GPU, GAME, DWM]) {
    const cols = pids.flatMap(pid => [engine(pid, 0, "3D"), engine(pid, 6, "VideoEncode"), engine(pid, 3, "Copy"), memory(pid)]);
    return csv(["(PDH-CSV 4.0)", ...cols]);
}

/** Uma amostra: [3D, codificar, copiar, memoria MB] por processo, na ordem do cabecalho. */
function sample(values: [number, number, number, number][]) {
    return csv(["11/02/2026 14:06:07.656", ...values.flatMap(([d3, enc, copy, mem]) => [d3.toFixed(6), enc.toFixed(6), copy.toFixed(6), String(mem * MB)])]);
}

const PLAYING = sample([[1, 2, 1, 100], [3, 10, 2, 300], [90, 0, 1, 2000], [5, 0, 0, 50]]);

// O modulo instala UM gancho em process.once("exit") na primeira medicao do processo: guardo-o para chamar a mao.
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
    resetLiveWeightForTests();
    restoreOnce();
});

beforeEach(() => {
    resetLiveWeightForTests();
    app.appMetrics = [{ pid: process.pid, type: "Browser" }, { pid: DISCORD_GPU, type: "GPU" }];
    app.getAppMetricsImpl = null;
});

afterEach(() => {
    stopLiveWeightMain();
});

const isTypeperf = (p: FakeChildProcess) => /typeperf\.exe$/i.test(p.command);
const isTasklist = (p: FakeChildProcess) => /tasklist\.exe$/i.test(p.command);

/** typeperf que espera ser dirigido; tasklist que responde com `names` (pid → nome; sem nome: a mensagem de "nenhuma tarefa"). */
function host(t: TestContext, names: Record<number, string> = { [GAME]: "Jogo.exe", [DWM]: "dwm.exe" }): SpawnEnv & { typeperf(): FakeChildProcess[]; tasklist(): FakeChildProcess[]; } {
    const env = mockSpawn(t, p => {
        if (!isTasklist(p)) return;
        const pid = Number(/PID eq (\d+)/.exec(p.args[1])?.[1]);
        setImmediate(async () => {
            // na pagina de codigo do console (CP850), como o tasklist escreve
            const text = names[pid] ? `"${names[pid]}","${pid}","Console","1","123.456 K"\r\n` : "INFORMA\u0080\u00E5ES: nenhuma tarefa em execu\u0087\u00C6o\r\n";
            await feed(p, Buffer.from(text, "latin1"));
            p.exit(0);
        });
    });
    return { ...env, typeperf: () => env.spawned.filter(isTypeperf), tasklist: () => env.spawned.filter(isTasklist) };
}

describe("o typeperf", () => {
    test("comeca escondido, sem shell, com os contadores em ingles, -si 5 e um fim (-sc)", t => {
        const env = host(t);
        assert.deepEqual(startLiveWeightMain(), { ok: true, reason: null });
        const [p] = env.typeperf();
        assert.match(p.command, /System32[\\/]typeperf\.exe$/i);
        assert.deepEqual(p.args, [...LIVE_WEIGHT_COUNTERS, "-si", String(SAMPLE_INTERVAL_S), "-sc", String(SAMPLES_PER_RUN)]);
        assert.deepEqual(LIVE_WEIGHT_COUNTERS, ["\\GPU Engine(*)\\Utilization Percentage", "\\GPU Process Memory(*)\\Dedicated Usage"]);
        assert.deepEqual(p.options, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        assert.equal(liveWeightRunPidForTests(), p.pid);
    });

    test("ja medindo (trocou de fonte): continua a mesma execucao", t => {
        const env = host(t);
        startLiveWeightMain();
        assert.deepEqual(startLiveWeightMain(), { ok: true, reason: null });
        assert.equal(env.typeperf().length, 1);
    });

    test("fora do Windows: sem numeros, sem processo", t => {
        const env = host(t);
        setPlatform(t, "linux");
        assert.deepEqual(startLiveWeightMain(), { ok: false, reason: "só funciona no Windows" });
        assert.equal(env.spawned.length, 0);
    });

    test("o caminho vem do SystemRoot (sem ele, C:\\Windows); para testes, outro executavel", t => {
        const env = host(t);
        const before = process.env.SystemRoot;
        t.after(() => {
            process.env.SystemRoot = before;
            setTypeperfPathForTests(null);
        });
        delete process.env.SystemRoot;
        startLiveWeightMain();
        assert.equal(env.typeperf()[0].command, join("C:\\Windows", "System32", "typeperf.exe"));
        stopLiveWeightMain();
        setTypeperfPathForTests("D:\\x\\typeperf.exe");
        startLiveWeightMain();
        assert.equal(env.typeperf()[1].command, "D:\\x\\typeperf.exe");
    });
});

describe("a leitura (media desde a leitura anterior)", () => {
    test("Discord (principal + GPU), o jogo pelo nome do executavel, a placa toda e a memoria do Discord", async t => {
        const env = host(t);
        startLiveWeightMain();
        const [p] = env.typeperf();
        await feed(p, "\r\n" + header());
        await feed(p, PLAYING);
        await feed(p, sample([[3, 2, 1, 100], [3, 12, 0, 500], [92, 0, 1, 2000], [3, 0, 0, 50]]));
        const r = await readLiveWeightMain();
        assert.equal(r.state, "measuring");
        assert.equal(r.reason, null);
        assert.equal(r.samples, 2);
        assert.equal(r.runs, 1);
        // 3D: (1+3) e (3+3) → 5; codificar: 12 e 14 → 13; copiar: 3 e 1 → 2
        assert.deepEqual(r.discord, { "3D": 5, VideoEncode: 13, VideoDecode: 0, Copy: 2 });
        assert.deepEqual(r.game, { pid: GAME, name: "Jogo.exe", load3D: 91 });
        // placa toda, 3D: 1+3+90+5 = 99 e 3+3+92+3 = 101 → 100
        // copiar: 1+2+1 = 4 e 1+0+1 = 2 → 3
        assert.deepEqual(r.total, { "3D": 99.5, VideoEncode: 13, VideoDecode: 0, Copy: 3 });
        assert.equal(r.discordGpuMemoryMb, 500);
        assert.equal(env.tasklist().length, 1);
        assert.deepEqual(env.tasklist()[0].args, ["/FI", `PID eq ${GAME}`, "/FO", "CSV", "/NH"]);
        assert.deepEqual(env.tasklist()[0].options, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });

        // a janela recomeca: sem amostra nova, nada (o processador ainda vem)
        const empty = await readLiveWeightMain();
        assert.equal(empty.samples, 0);
        assert.equal(empty.discord, null);
        assert.equal(empty.game, null);

        // o nome fica guardado: outra leitura com o mesmo jogo nao roda o tasklist de novo
        await feed(p, PLAYING);
        assert.equal((await readLiveWeightMain()).game?.name, "Jogo.exe");
        assert.equal(env.tasklist().length, 1);
    });

    test("nenhum processo de fora do Discord acima de 1% de 3D: sem jogo; o tasklist que nao acha o processo: sem nome", async t => {
        const env = host(t, {});
        startLiveWeightMain();
        const [p] = env.typeperf();
        await feed(p, header());
        await feed(p, sample([[1, 2, 1, 100], [3, 10, 2, 300], [0.5, 0, 0, 0], [0.2, 0, 0, 0]]));
        assert.equal(GAME_MIN_3D, 1);
        assert.equal((await readLiveWeightMain()).game, null);
        await feed(p, PLAYING);
        assert.deepEqual((await readLiveWeightMain()).game, { pid: GAME, name: null, load3D: 90 });
    });

    test("o tasklist que nao abre, que da erro ou que nao responde: sem nome (e o tempo do tasklist e limitado)", async t => {
        const clock = useFakeClock(t);
        const env = mockSpawn(t, p => {
            if (isTasklist(p)) p.exitOnKill = true;
        });
        startLiveWeightMain();
        const p = env.spawned[0];
        await feed(p, header());
        await feed(p, PLAYING);
        const pending = readLiveWeightMain();
        await flushPromises();
        const tl = env.spawned.find(isTasklist)!;
        tl.stdout.emit("error", new Error("pipe"));
        tl.stderr.emit("error", new Error("pipe"));
        clock.tick(4000);
        assert.ok(tl.killed, "o tasklist que nao responde e encerrado");
        assert.equal((await pending).game?.name, null);
        // erro ao abrir
        const failing = mockSpawn(t, q => {
            if (isTasklist(q)) setImmediate(() => q.fail(Object.assign(new Error("spawn"), { code: "ENOENT" })));
        });
        await feed(p, sample([[1, 2, 1, 100], [3, 10, 2, 300], [0, 0, 0, 0], [50, 0, 0, 0]]));
        assert.deepEqual((await readLiveWeightMain()).game, { pid: DWM, name: null, load3D: 50 });
        failing.restore();
    });

    test("o spawn do tasklist que lanca: sem nome", async t => {
        const env = host(t);
        startLiveWeightMain();
        const p = env.typeperf()[0];
        await feed(p, header());
        await feed(p, PLAYING);
        const original = childProcess.spawn;
        t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof original>) => {
            if (/tasklist/i.test(String(args[0]))) throw new Error("EPERM");
            return original(...args);
        }) as typeof original);
        assert.equal((await readLiveWeightMain()).game?.name, null);
    });

    test("o processador do Discord: segundos de CPU na janela (cumulativeCPUUsage), em % do processador todo", async t => {
        const clock = useFakeClock(t);
        host(t);
        t.mock.method(os, "availableParallelism", () => 4);
        app.appMetrics = [{ pid: process.pid, type: "Browser", cpu: { cumulativeCPUUsage: 10, percentCPUUsage: 0 } }, { pid: DISCORD_GPU, type: "GPU", cpu: { cumulativeCPUUsage: 5, percentCPUUsage: 0 } }];
        startLiveWeightMain();
        clock.tick(10_000);
        // +0,6 s no principal, +1 s na GPU e um processo novo com 0,4 s: 2 s em 10 s de 4 nucleos = 5%
        app.appMetrics = [
            { pid: process.pid, type: "Browser", cpu: { cumulativeCPUUsage: 10.6 } }, { pid: DISCORD_GPU, type: "GPU", cpu: { cumulativeCPUUsage: 6 } },
            { pid: 777, type: "Utility", cpu: { cumulativeCPUUsage: 0.4 } }
        ];
        const r = await readLiveWeightMain();
        assert.equal(r.windowMs, 10_000);
        assert.ok(Math.abs(r.discordCpu! - 5) < 1e-9, String(r.discordCpu));
    });

    test("sem cumulativeCPUUsage (Electron antigo): o percentCPUUsage, que e de um nucleo, dividido pelos nucleos; os.availableParallelism que falha: os.cpus()", async t => {
        host(t);
        t.mock.method(os, "availableParallelism", () => {
            throw new Error("old node");
        });
        t.mock.method(os, "cpus", () => new Array(8).fill({}));
        app.appMetrics = [{ pid: process.pid, type: "Browser", cpu: { percentCPUUsage: 40 } }, { pid: DISCORD_GPU, type: "GPU", cpu: { percentCPUUsage: 8 } }, { pid: 0 }, null];
        startLiveWeightMain();
        assert.equal((await readLiveWeightMain()).discordCpu, 6);
        app.appMetrics = [{ pid: process.pid, type: "Browser", cpu: { percentCPUUsage: 0 } }];
        assert.equal((await readLiveWeightMain()).discordCpu, null, "zero de um Electron sem a leitura: desconhecido");
        t.mock.method(os, "cpus", () => []);
        app.appMetrics = [{ pid: process.pid, type: "Browser", cpu: { percentCPUUsage: 400 } }];
        assert.equal((await readLiveWeightMain()).discordCpu, 100, "no maximo 100%");
    });

    test("getAppMetrics que lanca: so o processo principal conta como Discord, sem processador", async t => {
        const env = host(t);
        app.getAppMetricsImpl = () => {
            throw new Error("no metrics");
        };
        startLiveWeightMain();
        const p = env.typeperf()[0];
        await feed(p, header());
        await feed(p, PLAYING);
        const r = await readLiveWeightMain();
        assert.equal(r.discordCpu, null);
        // o processo da GPU (51234) passa a contar como de fora do Discord; o jogo continua o maior
        assert.equal(r.discord!["3D"], 1);
        assert.equal(r.game?.pid, GAME);
    });

    test("sem as colunas da memoria (o contador nao veio): memoria desconhecida", async t => {
        const env = host(t);
        startLiveWeightMain();
        const p = env.typeperf()[0];
        await feed(p, csv(["(PDH-CSV 4.0)", engine(process.pid, 0, "3D"), engine(GAME, 0, "3D")]));
        await feed(p, csv(["11/02/2026 14:06:07.656", "2.000000", "80.000000"]));
        const r = await readLiveWeightMain();
        assert.equal(r.discordGpuMemoryMb, null);
        assert.equal(r.discord!["3D"], 2);
    });

    test("parado: state off sem motivo; nada guardado", async () => {
        const r = await readLiveWeightMain();
        assert.equal(r.state, "off");
        assert.equal(r.reason, null);
        assert.equal(r.samples, 0);
    });

    test("amostras demais sem leitura: so as ultimas ficam; linha gigante e descartada; linha de outro cabecalho ignorada", async t => {
        const env = host(t);
        startLiveWeightMain();
        const p = env.typeperf()[0];
        await feed(p, PLAYING);
        await feed(p, header());
        for (let i = 0; i < 30; i++) await feed(p, PLAYING);
        await feed(p, "x".repeat(4 * 1024 * 1024 + 10));
        await feed(p, "\r\n" + csv(["11/02/2026 14:06:07.656", "1"]));
        const r = await readLiveWeightMain();
        assert.equal(r.samples, 24);
    });
});

describe("ciclo de vida", () => {
    test("parar mata o typeperf e nao recomeca; uma segunda tentativa se o kill nao pegou", async t => {
        const clock = useFakeClock(t);
        const env = host(t);
        startLiveWeightMain();
        const p = env.typeperf()[0];
        p.exitOnKill = false;
        stopLiveWeightMain();
        assert.ok(p.killed);
        assert.equal(liveWeightRunPidForTests(), null);
        clock.tick(1000);
        assert.equal(p.killSignals.length, 2, "tentou de novo");
        p.exit(1);
        await flushPromises();
        assert.equal(env.typeperf().length, 1, "nao recomecou");
        assert.equal((await readLiveWeightMain()).state, "off");
        stopLiveWeightMain();
    });

    test("a execucao chega ao fim (-sc) depois de medir: outra comeca na hora, com o cabecalho novo", async t => {
        const env = host(t);
        startLiveWeightMain();
        const [p] = env.typeperf();
        await feed(p, header());
        await feed(p, PLAYING);
        await feed(p, "Saindo, aguarde...\r\n");
        p.exit(0);
        await flushPromises();
        assert.equal(env.typeperf().length, 2);
        const q = env.typeperf()[1];
        assert.equal(liveWeightRunPidForTests(), q.pid);
        await feed(q, header([process.pid, DISCORD_GPU]));
        await feed(q, sample([[2, 4, 1, 100], [2, 4, 1, 100]]));
        const r = await readLiveWeightMain();
        assert.equal(r.samples, 2, "a amostra da execucao anterior e a da nova");
        assert.equal(r.runs, 2);
    });

    test("o typeperf que cai sem medir: sem numeros com o motivo dele, sem recomecar", async t => {
        const env = host(t);
        startLiveWeightMain();
        const [p] = env.typeperf();
        // a pagina de codigo do console (CP850): o "\u00E1" e o byte 0xA0
        await feed(p, Buffer.from("\r\nSaindo, aguarde...\r\nErro: nenhum contador v\u00A0lido.\r\n", "latin1"));
        p.exit(1);
        await flushPromises();
        assert.equal(env.typeperf().length, 1);
        const r = await readLiveWeightMain();
        assert.equal(r.state, "unavailable");
        assert.equal(r.reason, "Erro: nenhum contador válido. (código 1)", "a linha do erro, nao o \"Saindo, aguarde...\"");
        assert.equal(liveWeightRunPidForTests(), null);
        // a proxima transmissao tenta de novo
        startLiveWeightMain();
        assert.equal(env.typeperf().length, 2);
    });

    test("sai com codigo sem texto, sai com 0 sem medir, ou e morto por sinal: os motivos", async t => {
        const env = host(t);
        startLiveWeightMain();
        env.typeperf()[0].exit(5);
        await flushPromises();
        assert.equal((await readLiveWeightMain()).reason, "o typeperf.exe saiu com o código 5");
        startLiveWeightMain();
        env.typeperf()[1].exit(0);
        await flushPromises();
        assert.equal((await readLiveWeightMain()).reason, "o typeperf.exe não mediu nada");
        startLiveWeightMain();
        await feed(env.typeperf()[2], "Erro: acesso negado.\r\n");
        env.typeperf()[2].exit(null, "SIGTERM");
        await flushPromises();
        assert.equal((await readLiveWeightMain()).reason, "Erro: acesso negado.");
    });

    test("o typeperf que nao abre (evento error): os motivos em pt-BR, e o processo e encerrado", async t => {
        const codes: [string | undefined, RegExp][] = [
            ["ENOENT", /^o typeperf\.exe do Windows não foi encontrado$/],
            ["EACCES", /bloqueou o typeperf/],
            ["EPERM", /bloqueou o typeperf/],
            ["UNKNOWN", /bloqueou o typeperf/],
            ["EIO", /^não foi possível abrir o typeperf\.exe: EIO boom$/],
            [undefined, /^não foi possível abrir o typeperf\.exe: boom$/]
        ];
        for (const [code, re] of codes) {
            const env = mockSpawn(undefined, p => setImmediate(() => p.fail(Object.assign(new Error("boom"), code ? { code } : {}))));
            try {
                assert.equal(startLiveWeightMain().ok, true);
                await flushPromises();
                const r = await readLiveWeightMain();
                assert.equal(r.state, "unavailable");
                assert.match(r.reason!, re);
                assert.ok(env.spawned[0].killed);
                env.spawned[0].exit(1);
                await flushPromises();
                assert.equal(env.spawned.length, 1);
            } finally {
                env.restore();
            }
        }
    });

    test("o spawn que lanca: start devolve ok false com o motivo", t => {
        t.mock.method(childProcess, "spawn", (() => {
            throw Object.assign(new Error("blocked"), { code: "EPERM" });
        }) as unknown as typeof childProcess.spawn);
        assert.deepEqual(startLiveWeightMain(), { ok: false, reason: "o Windows ou o antivírus bloqueou o typeperf.exe" });
        assert.equal(liveWeightRunPidForTests(), null);
    });

    test("o renderer para de ler (recarregou ou travou): a medicao para sozinha em IDLE_STOP_MS", t => {
        const clock = useFakeClock(t);
        const env = host(t);
        startLiveWeightMain();
        const p = env.typeperf()[0];
        clock.tick(IDLE_STOP_MS - 5000);
        void readLiveWeightMain();
        clock.tick(IDLE_STOP_MS - 5000);
        assert.ok(!p.killed, "lendo: continua");
        clock.tick(10_000);
        assert.ok(p.killed, "sem ler: para");
        assert.equal(liveWeightRunPidForTests(), null);
    });

    test("o processo do Discord termina: o gancho do exit mata o typeperf", t => {
        const env = host(t);
        startLiveWeightMain();
        assert.equal(exitHooks.length, 1, "um gancho so");
        const p = env.typeperf()[0];
        exitHooks[0]();
        assert.ok(p.killed);
        assert.equal(liveWeightRunPidForTests(), null);
        exitHooks[0]();
        startLiveWeightMain();
        assert.equal(exitHooks.length, 1, "nao instala outro");
        const q = env.typeperf()[1];
        t.mock.method(q, "kill", () => {
            throw new Error("gone");
        });
        assert.doesNotThrow(() => exitHooks[0]());
    });

    test("o processo da GPU do Discord que nasceu depois da execucao, ou nenhum jogo: recomeca (no maximo um a cada EARLY_REFRESH_MS)", async t => {
        const clock = useFakeClock(t);
        const env = host(t);
        // o renderer le a cada 10 s (sem ler, a medicao para em IDLE_STOP_MS)
        const advance = async (ms: number) => {
            for (let left = ms; left > 0; left -= 10_000) {
                clock.tick(Math.min(10_000, left));
                await readLiveWeightMain();
            }
        };
        startLiveWeightMain();
        const [p] = env.typeperf();
        // o cabecalho nao tem o processo da GPU do Discord (ele reiniciou)
        await feed(p, header([process.pid, GAME]));
        await feed(p, sample([[1, 2, 1, 100], [90, 0, 1, 2000]]));
        await readLiveWeightMain();
        await advance(EARLY_REFRESH_MS - 10_000);
        assert.ok(!p.killed, "antes de EARLY_REFRESH_MS, nao");
        clock.tick(10_000);
        await feed(p, sample([[1, 2, 1, 100], [90, 0, 1, 2000]]));
        await readLiveWeightMain();
        assert.ok(p.killed, "recomeca para o processo novo entrar");
        await flushPromises();
        assert.equal(env.typeperf().length, 2);
        const q = env.typeperf()[1];
        await feed(q, header());
        await feed(q, sample([[1, 2, 1, 100], [3, 10, 2, 300], [0, 0, 0, 0], [0, 0, 0, 0]]));
        await readLiveWeightMain();
        assert.ok(!q.killed, "logo depois de recomecar, nao");
        await advance(EARLY_REFRESH_MS - 10_000);
        clock.tick(10_000);
        await feed(q, sample([[1, 2, 1, 100], [3, 10, 2, 300], [0, 0, 0, 0], [0, 0, 0, 0]]));
        await readLiveWeightMain();
        assert.ok(q.killed, "sem jogo: recomeca para ver um jogo aberto depois");
        // com o jogo, fica
        await flushPromises();
        const r3 = env.typeperf()[2];
        await feed(r3, header());
        await advance(EARLY_REFRESH_MS);
        await feed(r3, PLAYING);
        await readLiveWeightMain();
        assert.ok(!r3.killed);
    });
});
