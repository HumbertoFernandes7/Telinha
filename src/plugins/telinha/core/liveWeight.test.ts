/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado do renderer do peso da live (core/liveWeight.ts), com os natives de mentira (@test/fakes/native) e o
// relogio falso: a linha do log a cada STATS_LOG_MS (o formato, o que fica de fora), a linha que so volta quando um
// numero muda o bastante ou depois de LOG_REPEAT_MS, a falha que vira uma linha so, os numeros para a qualidade
// automatica (currentLiveWeight) e a parte do "Copiar diagnóstico".
// Rodar:  pnpm test:file src/plugins/telinha/core/liveWeight.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, type TestContext } from "node:test";

import { getEventLog, resetState } from "@plugins/telinha/store";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";

import {
    currentLiveWeight, formatLiveWeightLine, liveWeightDiagnostics, liveWeightTick, LOG_CHANGE_POINTS, LOG_REPEAT_MS, resetLiveWeightRendererForTests, startLiveWeight,
    stopLiveWeight
} from "./liveWeight";
import type { LiveWeightReport } from "./liveWeightMain";
import { STATS_LOG_MS } from "./statsLog";

function report(patch: Partial<LiveWeightReport> = {}): LiveWeightReport {
    return {
        state: "measuring", reason: null, samples: 2, windowMs: 10_000,
        discord: { "3D": 4.2, VideoEncode: 12.4, VideoDecode: 0, Copy: 2 },
        discordCpu: 6.4, discordGpuMemoryMb: 420.4,
        game: { pid: 27_368, name: "Jogo.exe", load3D: 91, source: "window" },
        total: { "3D": 97, VideoEncode: 12.4, VideoDecode: 0, Copy: 3 },
        runs: 1,
        ...patch
    };
}

const LINE = "Peso da live: placa (Discord) 3D 4% · codificar 12% · copiar 2% · processador 6% — jogo Jogo.exe 3D 91% — placa no total 3D 97% · codificar 12%";

/** as linhas do peso da live escritas neste teste (o log do store guarda as dos testes anteriores) */
let seen = new Set<unknown>();
const messages = () => getEventLog().filter(e => !seen.has(e)).map(e => e.msg).filter(m => m.startsWith("Peso da live"));
let env: NativeEnv | null = null;

/** Natives do peso da live: cada leitura devolve o proximo da fila (o ultimo se repete). */
function main(reads: (LiveWeightReport | (() => Promise<LiveWeightReport>))[] = [report()], start: () => Promise<unknown> = async () => ({ ok: true, reason: null })) {
    const queue = [...reads];
    env = installNative({
        startLiveWeight: start,
        readLiveWeight: async () => {
            const next = queue.length > 1 ? queue.shift()! : queue[0];
            return typeof next === "function" ? next() : next;
        },
        stopLiveWeight: async () => undefined
    });
    return env;
}

const callsOf = (name: string) => env!.calls.filter(c => c.name === name).length;

/** Um segundo do ticker da sessao (streaming.tick → liveWeightTick), deixando a leitura chegar. */
async function seconds(clock: ReturnType<typeof useFakeClock>, n: number) {
    for (let i = 0; i < n; i++) {
        clock.tick(1000);
        liveWeightTick();
        await flushPromises();
        await flushPromises();
    }
}

async function started(t: TestContext, reads?: Parameters<typeof main>[0]) {
    const clock = useFakeClock(t);
    main(reads);
    await startLiveWeight("window:1234:0");
    return clock;
}

beforeEach(() => {
    resetState();
    resetLiveWeightRendererForTests();
    seen = new Set(getEventLog());
});

afterEach(() => {
    stopLiveWeight();
    env?.restore();
    env = null;
});

describe("a linha do log", () => {
    test("a cada STATS_LOG_MS: placa do Discord por motor, processador, o jogo e a placa toda", async t => {
        const clock = await started(t);
        assert.equal(callsOf("startLiveWeight"), 1);
        await seconds(clock, STATS_LOG_MS / 1000 - 1);
        assert.equal(callsOf("readLiveWeight"), 0, "antes de STATS_LOG_MS, nao le");
        await seconds(clock, 1);
        assert.equal(callsOf("readLiveWeight"), 1);
        assert.deepEqual(messages(), [LINE]);
    });

    test("formatLiveWeightLine: decodificar so com algo (assistindo alguem), sem processador, jogo sem nome, sem jogo, sem amostras", () => {
        assert.equal(formatLiveWeightLine(report({ discord: { "3D": 4, VideoEncode: 12, VideoDecode: 7.6, Copy: 2 } })),
            LINE.replace("codificar 12% · copiar", "codificar 12% · decodificar 8% · copiar"));
        assert.equal(formatLiveWeightLine(report({ discordCpu: null })), LINE.replace(" · processador 6%", ""));
        assert.equal(formatLiveWeightLine(report({ game: { pid: 1234, name: null, load3D: 50, source: "window" } })), LINE.replace("jogo Jogo.exe 3D 91%", "jogo processo 1234 3D 50%"));
        assert.equal(formatLiveWeightLine(report({ game: null })), LINE.replace("jogo Jogo.exe 3D 91%", "nada usando a placa fora do Discord"));
        // tela inteira (ou a janela sem o processo nas colunas): o Telinha nao sabe qual e o jogo, nao chama de jogo
        assert.equal(formatLiveWeightLine(report({ game: { pid: 4321, name: "msedge.exe", load3D: 18, source: "top" } })),
            LINE.replace("jogo Jogo.exe 3D 91%", "maior 3D fora do Discord: msedge.exe 3D 18%"));
        assert.equal(formatLiveWeightLine(report({ discord: null })), null);
        assert.equal(formatLiveWeightLine(report({ total: null })), null);
    });

    test(`sem mudanca de ${LOG_CHANGE_POINTS} pontos, a linha so volta depois de LOG_REPEAT_MS; com mudanca ou outro jogo, na hora`, async t => {
        const small = report({ discord: { "3D": 6, VideoEncode: 15, VideoDecode: 0, Copy: 2 } });
        const big = report({ discord: { "3D": 6, VideoEncode: 18, VideoDecode: 0, Copy: 2 } });
        const otherGame = report({ ...big, game: { pid: 99, name: null, load3D: 91, source: "window" } });
        const clock = await started(t, [report(), small, big, otherGame, otherGame]);
        await seconds(clock, 10);
        await seconds(clock, 10);
        assert.equal(messages().length, 1, "4→6 e 12→15: menos de 5 pontos");
        await seconds(clock, 10);
        assert.equal(messages().length, 2, "12→18: 6 pontos");
        assert.match(messages()[1], /codificar 18%/);
        await seconds(clock, 10);
        assert.equal(messages().length, 3, "outro jogo");
        assert.match(messages()[2], /jogo processo 99 3D 91%/);
        await seconds(clock, LOG_REPEAT_MS / 1000 - 10);
        assert.equal(messages().length, 3);
        await seconds(clock, 10);
        assert.equal(messages().length, 4, "LOG_REPEAT_MS depois, repete");
    });

    test("sem processador e sem jogo: a comparacao conta o que falta como zero", async t => {
        const bare = report({ discordCpu: null, game: null });
        const clock = await started(t, [bare, bare, report({ discordCpu: 7, game: null })]);
        await seconds(clock, 20);
        assert.equal(messages().length, 1, "igual: uma linha so");
        await seconds(clock, 10);
        assert.equal(messages().length, 2, "o processador apareceu (0 → 7)");
    });

    test("leitura sem amostras (o typeperf comecando ou recomecando): nenhuma linha, e os numeros anteriores ficam", async t => {
        const clock = await started(t, [report(), report({ samples: 0, discord: null, total: null, game: null })]);
        await seconds(clock, 20);
        assert.deepEqual(messages(), [LINE]);
        assert.equal(currentLiveWeight()?.discord.VideoEncode, 12.4);
    });

    test("uma leitura por vez: o tick durante uma leitura lenta nao pede outra", async t => {
        let release: (r: LiveWeightReport) => void = () => { };
        const slow = () => new Promise<LiveWeightReport>(resolve => {
            release = resolve;
        });
        const clock = await started(t, [slow]);
        await seconds(clock, 10);
        await seconds(clock, 15);
        assert.equal(callsOf("readLiveWeight"), 1);
        release(report());
        await flushPromises();
        assert.deepEqual(messages(), [LINE]);
    });

    test("resposta que nao e um relatorio (parte nativa antiga): ignorada", async t => {
        const clock = await started(t, [null as unknown as LiveWeightReport]);
        await seconds(clock, 10);
        assert.deepEqual(messages(), []);
    });
});

describe("falha mansa: uma linha so, a transmissao segue", () => {
    test("o main nao consegue medir ao comecar: um aviso com o motivo, e a mesma falha nao se repete na proxima transmissao", async () => {
        main([report()], async () => ({ ok: false, reason: "o typeperf.exe do Windows não foi encontrado" }));
        await startLiveWeight();
        stopLiveWeight();
        await startLiveWeight();
        assert.deepEqual(messages(), ["Peso da live: sem números nesta transmissão (o typeperf.exe do Windows não foi encontrado); a transmissão continua normal"]);
        assert.equal(getEventLog().at(-1)?.level, "warn");
        assert.equal(callsOf("stopLiveWeight"), 1, "o stop vai sempre (o main pode ter um typeperf mesmo sem medicao aqui)");
        assert.match(liveWeightDiagnostics(), /^peso da live: sem números \(o typeperf\.exe do Windows não foi encontrado\); nenhuma leitura ainda$/);
        liveWeightTick();
        assert.equal(callsOf("readLiveWeight"), 0);
    });

    test("o typeperf cai no meio (unavailable): uma linha, e para de ler", async t => {
        const clock = await started(t, [report(), report({ state: "unavailable", reason: "Erro: nenhum contador válido. (código 1)", samples: 0 })]);
        await seconds(clock, 30);
        assert.deepEqual(messages(), [LINE, "Peso da live: sem números nesta transmissão (Erro: nenhum contador válido. (código 1)); a transmissão continua normal"]);
        assert.equal(callsOf("readLiveWeight"), 2);
        assert.equal(currentLiveWeight(), null);
        // o diagnostico guarda a ultima leitura
        assert.match(liveWeightDiagnostics(), /sem números \(Erro: nenhum contador válido\. \(código 1\)\).*última leitura/);
    });

    test("unavailable sem motivo, resposta ok false sem motivo, o pedido que rejeita e a leitura que rejeita", async t => {
        const clock = await started(t, [report({ state: "unavailable", reason: null })]);
        await seconds(clock, 10);
        assert.match(messages().at(-1)!, /\(o typeperf\.exe parou\)/);
        env!.restore();
        main([report()], async () => ({ ok: false, reason: null }));
        await startLiveWeight();
        assert.match(messages().at(-1)!, /\(o processo main não respondeu\)/);
        env!.restore();
        main([report()], async () => {
            throw new Error("IPC caiu");
        });
        await startLiveWeight();
        assert.match(messages().at(-1)!, /\(o pedido falhou: .*IPC caiu\)/);
        env!.restore();
        main([async () => {
            throw new Error("sem resposta");
        }]);
        await startLiveWeight();
        await seconds(clock, 10);
        assert.match(messages().at(-1)!, /\(a leitura falhou: .*sem resposta\)/);
    });

    test("a medicao parou sozinha no main (o renderer demorou a ler): comeca de novo", async t => {
        const clock = await started(t, [report({ state: "off", samples: 0 }), report()]);
        await seconds(clock, 10);
        assert.equal(callsOf("startLiveWeight"), 2);
        await seconds(clock, 10);
        assert.deepEqual(messages(), [LINE]);
    });

    test("parar no meio do comeco: a resposta que chega depois nao reativa nada", async () => {
        let answer: (v: unknown) => void = () => { };
        main([report()], () => new Promise(resolve => {
            answer = resolve;
        }));
        const pending = startLiveWeight();
        stopLiveWeight();
        answer({ ok: false, reason: "tarde demais" });
        await pending;
        assert.deepEqual(messages(), []);
        // e o pedido que rejeita depois de parar tambem
        env!.restore();
        main([report()], () => Promise.reject(new Error("tarde")));
        const p2 = startLiveWeight();
        stopLiveWeight();
        await p2;
        assert.deepEqual(messages(), []);
    });

    test("a leitura que chega depois de parar: ignorada (e a que falha tambem)", async t => {
        let release: (r: LiveWeightReport) => void = () => { };
        let fail: (e: Error) => void = () => { };
        const clock = await started(t, [() => new Promise<LiveWeightReport>(resolve => {
            release = resolve;
        }), () => new Promise<LiveWeightReport>((_, reject) => {
            fail = reject;
        })]);
        await seconds(clock, 10);
        stopLiveWeight();
        release(report());
        await flushPromises();
        await startLiveWeight();
        await seconds(clock, 10);
        stopLiveWeight();
        fail(new Error("x"));
        await flushPromises();
        assert.deepEqual(messages(), []);
    });
});

describe("parar, a qualidade automatica e o diagnostico", () => {
    test("parar avisa o main (sempre) e currentLiveWeight volta a null; o stop que rejeita nao escapa", async t => {
        const clock = await started(t);
        await seconds(clock, 10);
        const w = currentLiveWeight()!;
        assert.deepEqual(w.discord, report().discord);
        assert.equal(w.discordCpu, 6.4);
        assert.equal(w.game?.name, "Jogo.exe");
        assert.deepEqual(w.total, report().total);
        env!.telinha.stopLiveWeight = async () => {
            throw new Error("main ocupado");
        };
        stopLiveWeight();
        stopLiveWeight();
        await flushPromises();
        assert.equal(callsOf("stopLiveWeight"), 2);
        assert.equal(currentLiveWeight(), null);
    });

    test("a leitura falhou (o renderer parou de medir): parar a transmissao ainda manda o stop ao main", async t => {
        const clock = await started(t, [async () => {
            throw new Error("IPC caiu");
        }]);
        await seconds(clock, 10);
        assert.match(messages().at(-1)!, /a leitura falhou/);
        assert.equal(currentLiveWeight(), null);
        stopLiveWeight();
        assert.equal(callsOf("stopLiveWeight"), 1);
    });

    test("a fonte vai para o main (o jogo e o dono da janela); trocar de fonte no ar so manda a nova; a medicao que recomeca usa a mesma", async t => {
        const clock = await started(t, [report(), report({ state: "off", samples: 0 }), report()]);
        assert.deepEqual(env!.calls.filter(c => c.name === "startLiveWeight").map(c => c.args), [["window:1234:0"]]);
        await startLiveWeight("screen:0:0");
        assert.deepEqual(env!.calls.filter(c => c.name === "startLiveWeight").map(c => c.args), [["window:1234:0"], ["screen:0:0"]]);
        await seconds(clock, 20);
        assert.deepEqual(env!.calls.filter(c => c.name === "startLiveWeight").at(-1)?.args, ["screen:0:0"], "o main parou sozinho: recomeca com a fonte atual");
        // a troca que falha no IPC nao escapa
        env!.telinha.startLiveWeight = () => Promise.reject(new Error("x"));
        await startLiveWeight("window:9:0");
        await flushPromises();
        stopLiveWeight();
        env!.telinha.startLiveWeight = async () => ({ ok: true, reason: null });
        await startLiveWeight();
        assert.deepEqual(env!.calls.at(-1)?.args, [null], "sem fonte depois de parar");
    });

    test("o diagnostico: medindo, a ultima leitura em UTC, a memoria da placa e o decodificar zerado", async t => {
        const clock = await started(t);
        assert.equal(liveWeightDiagnostics(), "peso da live: medindo nesta transmissão (typeperf.exe a cada 5 s); nenhuma leitura ainda");
        await seconds(clock, 10);
        const at = new Date(clock.epoch()).toISOString().slice(11, 19);
        assert.equal(liveWeightDiagnostics(), `peso da live: medindo nesta transmissão (typeperf.exe a cada 5 s); execuções do typeperf: 1; última leitura às ${at} UTC: `
            + `${LINE.replace("Peso da live: ", "")} (decodificar 0%); memória da placa (Discord) 420 MB`);
        stopLiveWeight();
        assert.match(liveWeightDiagnostics(), /^peso da live: parado \(só mede transmitindo\); execuções do typeperf: 1; última leitura às .* \(decodificar 0%\); memória/);
    });

    test("o diagnostico sem a memoria e com o decodificar (aparece na linha)", async t => {
        const clock = await started(t, [report({ discordGpuMemoryMb: null, discord: { "3D": 4, VideoEncode: 12, VideoDecode: 3, Copy: 2 } })]);
        await seconds(clock, 10);
        const d = liveWeightDiagnostics();
        assert.match(d, /decodificar 3%/);
        assert.doesNotMatch(d, /memória|decodificar 0%/);
    });

    test("sem a medicao na parte nativa (versao antiga, build do fork): nada acontece, e o diagnostico diz", async () => {
        env = installNative();
        await startLiveWeight("screen:0:0");
        liveWeightTick();
        stopLiveWeight();
        assert.equal(env.calls.length, 0);
        assert.equal(liveWeightDiagnostics(), "peso da live: a parte nativa não tem a medição");
        assert.equal(currentLiveWeight(), null);
    });

    test("a parte nativa sem readLiveWeight nem stopLiveWeight: o tick nao le, e parar nao chama nada", async t => {
        const clock = useFakeClock(t);
        env = installNative({ startLiveWeight: async () => ({ ok: true, reason: null }) });
        await startLiveWeight();
        clock.tick(STATS_LOG_MS);
        liveWeightTick();
        await flushPromises();
        assert.deepEqual(env.calls.map(c => c.name), ["startLiveWeight"]);
        stopLiveWeight();
        assert.equal(currentLiveWeight(), null);
    });
});
