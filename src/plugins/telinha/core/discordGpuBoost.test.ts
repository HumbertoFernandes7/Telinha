/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do experimento do GPU boost do proprio Discord (core/discordGpuBoost.ts) com um DiscordNative de mentira: o modulo
// ausente, o requireModule que lanca / devolve direto / devolve Promise, a funcao ausente, as respostas da funcao (retorno,
// Promise, rejeicao, excecao, prazo, callback) e a ligacao com a transmissao (core/captureBoost.ts): so em "Tempo real",
// true no inicio e false no fim so para os processos que o Telinha subiu (nunca um que ja estava em REALTIME), o "high" de novo
// depois do false (o false do Discord poe NORMAL), a conferencia dos pids no fim, a corrida de fim/inicio, a troca de modo no
// meio da transmissao e o desfazer depois de um reload do renderer (sessionStorage), sem pedido em dobro.
// Rodar:  pnpm test:file src/plugins/telinha/core/discordGpuBoost.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { getEventLog, resetState } from "@plugins/telinha/store";
import { useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings, resetVencordFakes } from "@test/fakes/vencord";

import { noteCaptureStarted, noteCaptureStopped, resetCaptureBoostForTests, startCaptureBoost } from "./captureBoost";
import type { GpuPriorityReport } from "./captureBoostMain";
import { BOOST_TIMEOUT_MS, PROBE_TIMEOUT_MS, probeDiscordGpuBoost, REREAD_DELAY_MS, resetDiscordGpuBoostForTests, resultText, setDiscordGpuBoost } from "./discordGpuBoost";

type AnyFn = (...args: any[]) => any;
const g = globalThis as { DiscordNative?: unknown; sessionStorage?: unknown; };
const never = () => new Promise<never>(() => { /* nunca responde */ });

/** Um DiscordNative de mentira cujo requireModule devolve `answer` (ou lanca, se for uma funcao que lanca). */
function installDiscord(requireModule: AnyFn) {
    g.DiscordNative = { nativeModules: { requireModule } };
}
const withModule = (mod: unknown) => installDiscord((name: string) => (name === "discord_utils" ? mod : undefined));
/** o modulo com a funcao do GPU boost (e outras, para a lista de funcoes parecidas) */
const moduleWith = (fn: AnyFn | undefined) => ({ setGPUBoostEnabledByPid: fn, getGPUDriverVersions: () => 1, notAFunctionBoost: 3, other: () => 0 });

beforeEach(() => {
    delete g.DiscordNative;
});
afterEach(() => {
    delete g.DiscordNative;
});

describe("probeDiscordGpuBoost", () => {
    test("sem DiscordNative / sem requireModule: indisponivel e diz por que", async () => {
        assert.deepEqual(await probeDiscordGpuBoost(), { available: false, why: "o Discord não expõe o DiscordNative", keys: [] });
        g.DiscordNative = {};
        assert.deepEqual(await probeDiscordGpuBoost(), { available: false, why: "o Discord não expõe nativeModules.requireModule", keys: [] });
    });

    test("o modulo nao veio (undefined, null)", async () => {
        withModule(undefined);
        let p = await probeDiscordGpuBoost();
        assert.equal(p.available, false);
        assert.match(p.why!, /discord_utils não veio \(undefined\)/);
        withModule(null);
        p = await probeDiscordGpuBoost();
        assert.match(p.why!, /não veio \(null\)/);
    });

    test("requireModule lanca: indisponivel, sem lancar", async () => {
        installDiscord(() => {
            throw new Error("modulo bloqueado");
        });
        const p = await probeDiscordGpuBoost();
        assert.equal(p.available, false);
        assert.match(p.why!, /não consegui carregar o módulo discord_utils \(Error: modulo bloqueado\)/);
    });

    test("requireModule devolve direto: disponivel, com as funcoes parecidas em ordem", async () => {
        withModule(moduleWith(() => true));
        assert.deepEqual(await probeDiscordGpuBoost(), { available: true, keys: ["getGPUDriverVersions", "setGPUBoostEnabledByPid"] });
    });

    test("requireModule devolve Promise (resolvida ou rejeitada)", async () => {
        installDiscord(async () => moduleWith(() => true));
        assert.equal((await probeDiscordGpuBoost()).available, true);
        installDiscord(async () => {
            throw new Error("sem permissao");
        });
        assert.match((await probeDiscordGpuBoost()).why!, /Error: sem permissao/);
    });

    test("requireModule que nunca responde: prazo de 3 s", async t => {
        const clock = useFakeClock(t);
        installDiscord(never);
        const pending = probeDiscordGpuBoost();
        await clock.tickAsync(PROBE_TIMEOUT_MS);
        const p = await pending;
        assert.equal(p.available, false);
        assert.match(p.why!, /requireModule\("discord_utils"\): sem resposta em 3000 ms/);
    });

    test("modulo sem a funcao: indisponivel, mas lista o que tem", async () => {
        withModule({ getGPUDriverVersions: () => 1, other: 1 });
        assert.deepEqual(await probeDiscordGpuBoost(), { available: false, why: "o módulo discord_utils não tem a função setGPUBoostEnabledByPid", keys: ["getGPUDriverVersions"] });
        withModule(moduleWith(undefined));
        assert.equal((await probeDiscordGpuBoost()).available, false);
    });

    test("modulo que lanca ao ler as chaves nao derruba a sondagem", async () => {
        withModule(new Proxy({}, {
            ownKeys() {
                throw new Error("proxy");
            },
            get() {
                throw new Error("proxy");
            }
        }));
        const p = await probeDiscordGpuBoost();
        assert.equal(p.available, false);
        assert.deepEqual(p.keys, []);
    });
});

describe("setDiscordGpuBoost", () => {
    test("retorno direto (sincrono): ok com o valor, e os argumentos certos", async () => {
        const calls: unknown[][] = [];
        withModule(moduleWith((...args: unknown[]) => {
            calls.push(args);
            return true;
        }));
        const r = await setDiscordGpuBoost(1234, true);
        assert.deepEqual(calls, [[1234, true]]);
        assert.equal(r.ok, true);
        assert.equal(r.result, true);
        assert.equal(r.error, undefined);
        assert.equal(typeof r.ms, "number");
    });

    test("funcao sem retorno: ok, sem valor", async () => {
        withModule(moduleWith(() => undefined));
        const r = await setDiscordGpuBoost(1, false);
        assert.equal(r.ok, true);
        assert.equal(r.result, undefined);
    });

    test("um false explicito e a recusa do Discord", async () => {
        withModule(moduleWith(() => false));
        const r = await setDiscordGpuBoost(1, true);
        assert.equal(r.ok, false);
        assert.equal(r.error, "o Discord respondeu false");
    });

    test("Promise que resolve", async () => {
        withModule(moduleWith(async () => ({ success: true })));
        const r = await setDiscordGpuBoost(1, true);
        assert.equal(r.ok, true);
        assert.deepEqual(r.result, { success: true });
    });

    test("Promise que rejeita", async () => {
        withModule(moduleWith(async () => {
            throw new Error("servico nao respondeu");
        }));
        const r = await setDiscordGpuBoost(1, true);
        assert.equal(r.ok, false);
        assert.equal(r.error, "Error: servico nao respondeu");
    });

    test("a funcao lanca", async () => {
        withModule(moduleWith(() => {
            throw new Error("pipe fechado");
        }));
        const r = await setDiscordGpuBoost(1, true);
        assert.equal(r.ok, false);
        assert.equal(r.error, "Error: pipe fechado");
    });

    test("um throw de algo que nao e Error tambem nao escapa", async () => {
        withModule(moduleWith(() => {

            throw "texto solto";
        }));
        const r = await setDiscordGpuBoost(1, true);
        assert.deepEqual([r.ok, r.error], [false, "texto solto"]);
    });

    test("sem resposta: prazo de 5 s", async t => {
        const clock = useFakeClock(t);
        withModule(moduleWith(never));
        const pending = setDiscordGpuBoost(1, true);
        await clock.tickAsync(BOOST_TIMEOUT_MS);
        const r = await pending;
        assert.equal(r.ok, false);
        assert.match(r.error!, /setGPUBoostEnabledByPid: sem resposta em 5000 ms/);
        assert.ok(r.ms >= BOOST_TIMEOUT_MS);
    });

    test("estilo callback (3 parametros): usa o callback; erro como 1o argumento; (null, valor)", async () => {
        const seen: unknown[][] = [];
        withModule(moduleWith(function boost(pid: number, enabled: boolean, cb: AnyFn) {
            seen.push([pid, enabled, typeof cb]);
            setTimeout(() => cb(null, "feito"), 1);
        }));
        const ok = await setDiscordGpuBoost(7, true);
        assert.deepEqual(seen, [[7, true, "function"]]);
        assert.deepEqual([ok.ok, ok.result], [true, "feito"]);

        withModule(moduleWith((_pid: number, _enabled: boolean, cb: AnyFn) => {
            setTimeout(() => cb(new Error("negado")), 1);
        }));
        const bad = await setDiscordGpuBoost(7, true);
        assert.deepEqual([bad.ok, bad.error], [false, "Error: negado"]);

        withModule(moduleWith((_pid: number, _enabled: boolean, cb: AnyFn) => cb("so um valor")));
        assert.equal((await setDiscordGpuBoost(7, true)).result, "so um valor");
    });

    test("estilo callback que nunca chama o callback: prazo de 5 s", async t => {
        const clock = useFakeClock(t);
        withModule(moduleWith((_pid: number, _enabled: boolean, _cb: AnyFn) => undefined));
        const pending = setDiscordGpuBoost(1, true);
        await clock.tickAsync(BOOST_TIMEOUT_MS);
        assert.match((await pending).error!, /sem resposta em 5000 ms/);
    });

    test("modulo ausente, requireModule que lanca e funcao ausente: erro no resultado, sem lancar", async () => {
        let r = await setDiscordGpuBoost(1, true);
        assert.deepEqual([r.ok, r.error], [false, "o Discord não expõe o DiscordNative"]);
        installDiscord(() => {
            throw new Error("x");
        });
        r = await setDiscordGpuBoost(1, true);
        assert.equal(r.ok, false);
        assert.match(r.error!, /não consegui carregar o módulo discord_utils/);
        withModule({});
        r = await setDiscordGpuBoost(1, true);
        assert.equal(r.error, "o módulo discord_utils não tem a função setGPUBoostEnabledByPid");
    });

    test("requireModule devolve Promise: tambem funciona", async () => {
        installDiscord(async () => moduleWith(() => "ok"));
        assert.deepEqual(await setDiscordGpuBoost(1, true).then(r => [r.ok, r.result]), [true, "ok"]);
    });

    test("opcoes de teste: DiscordNative e prazo proprios", async () => {
        const dn = { nativeModules: { requireModule: () => moduleWith(() => 1) } };
        assert.equal((await setDiscordGpuBoost(1, true, { discordNative: dn })).ok, true);
        const slow = { nativeModules: { requireModule: () => moduleWith(never) } };
        const r = await setDiscordGpuBoost(1, true, { discordNative: slow, boostTimeoutMs: 5 });
        assert.match(r.error!, /sem resposta em 5 ms/);
    });
});

test("resultText: curto e sem lancar", () => {
    assert.equal(resultText(undefined), "sem valor");
    assert.equal(resultText(true), "true");
    assert.equal(resultText("ok"), "\"ok\"");
    assert.equal(resultText({ a: 1 }), "{\"a\":1}");
    assert.equal(resultText("x".repeat(500)).length, 121);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(resultText(circular), "[object Object]");
});

// #region ligacao com a transmissao

describe("na transmissao (core/captureBoost.ts)", () => {
    const P = "Tempo real pelo Discord";
    const targets = (after: string, role2After = after): GpuPriorityReport["targets"] => [
        { pid: 1234, role: "Discord", before: "NORMAL", after, kept: false, error: null },
        { pid: 5678, role: "GPU", before: "NORMAL", after: role2After, kept: false, error: null }
    ];
    const report = (patch: Partial<GpuPriorityReport> = {}): GpuPriorityReport => ({
        mode: "high", ok: true, done: 2, hags: "on", reason: null, refused: false, raised: 2, quiet: false, notes: [], level: "HIGH", realtimeRefused: false, realtimeBlocked: null, targets: targets("HIGH"), ...patch
    });
    const restored = (): GpuPriorityReport => report({ mode: "restore", raised: 0, targets: targets("NORMAL") });
    // o log de eventos nao zera entre os testes: so as linhas desde o comeco deste
    let base = 0;
    const testLines = () => getEventLog().slice(base).map(e => e.msg).filter(m => m.startsWith(P));
    let env: NativeEnv | null = null;
    let boost: Array<[number, boolean]>;
    let priorityCalls: string[];
    /** tudo na ordem em que aconteceu: "boost:pid:true|false" (Discord) e "native:high|restore" (parte nativa) */
    let events: string[];
    /** a classe que o "high" releitura devolve (o Discord ja mexeu nela) */
    let reread: () => GpuPriorityReport;
    /** o sessionStorage de mentira (sobrevive ao "reload" dos testes: so o estado dos modulos e zerado) */
    let session: Map<string, string>;
    const SAVED_KEY = "telinha.discordGpuBoost";
    const saved = (): Array<{ pid: number; role: string; classBefore: string; at: number; }> => JSON.parse(session.get(SAVED_KEY) ?? "[]");

    /** o modulo do Discord de mentira: guarda cada pedido (pid, enabled) */
    function discordOk(fn: AnyFn = () => true) {
        withModule(moduleWith((pid: number, enabled: boolean) => {
            boost.push([pid, enabled]);
            events.push(`boost:${pid}:${enabled}`);
            return fn(pid, enabled);
        }));
    }

    beforeEach(() => {
        resetVencordFakes();
        pluginSettings.load({ gpuCapture: false, gpuPriorityMode: "off" });
        resetState();
        resetCaptureBoostForTests();
        resetDiscordGpuBoostForTests();
        base = getEventLog().length;
        boost = [];
        priorityCalls = [];
        events = [];
        session = new Map();
        g.sessionStorage = {
            getItem: (k: string) => session.get(k) ?? null,
            setItem: (k: string, v: string) => void session.set(k, v),
            removeItem: (k: string) => void session.delete(k)
        };
        reread = () => report({ targets: [targets("HIGH")[0], { ...targets("HIGH")[1], before: "HIGH", after: "REALTIME", kept: true }] });
        installFakeNative();
    });

    /** a parte nativa de mentira; `extra` poe (ou troca) funcoes, como o registro do main (readGpuBoostRecord/writeGpuBoostRecord) */
    function installFakeNative(extra: Record<string, AnyFn> = {}) {
        env?.restore();
        let first = true;
        env = installNative({
            setGpuPriority: async (mode: string) => {
                priorityCalls.push(mode);
                events.push(`native:${mode}`);
                if (mode === "restore") return restored();
                if (first) {
                    first = false;
                    return report();
                }
                return reread();
            },
            ...extra
        });
    }

    afterEach(() => {
        env?.restore();
        env = null;
        resetDiscordGpuBoostForTests();
        delete g.sessionStorage;
    });

    test("tempo real: pede true para os dois processos, relê as classes ~2 s depois, e false no fim", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [5678, true]]);
        assert.deepEqual(testLines().slice(0, 3), [
            `${P}: discord_utils disponível (setGPUBoostEnabledByPid existe); funções parecidas: getGPUDriverVersions, setGPUBoostEnabledByPid`,
            `${P}: Discord 1234 → pedido aceito (0 ms; resposta: true)`,
            `${P}: GPU do Discord 5678 → pedido aceito (0 ms; resposta: true)`
        ]);
        // ainda nao releu: espera ~2 s
        assert.deepEqual(priorityCalls, ["high"]);
        await clock.tickAsync(REREAD_DELAY_MS);
        assert.deepEqual(priorityCalls, ["high", "high"]);
        assert.deepEqual(testLines().slice(3), [`${P}: Discord 1234 → continua HIGH`, `${P}: GPU do Discord 5678 → agora REALTIME`]);

        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [5678, true], [1234, false], [5678, false]]);
        assert.deepEqual(testLines().slice(5), [
            `${P}: Discord 1234 → volta ao normal aceita (0 ms; resposta: true)`,
            `${P}: GPU do Discord 5678 → volta ao normal aceita (0 ms; resposta: true)`
        ]);
        // confere os pids, o NORMAL do Discord, o "high" de novo (o false deixa NORMAL) e so entao o "restore" do Telinha
        assert.deepEqual(priorityCalls, ["high", "high", "high", "high", "restore"]);
        assert.deepEqual(events.slice(-5), ["native:high", "boost:1234:false", "boost:5678:false", "native:high", "native:restore"]);
        assert.equal(session.has(SAVED_KEY), false);
    });

    test("trocar de fonte (inicio em dobro) e parar em dobro: nao repete os pedidos", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(10);
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, [[1234, true], [5678, true]]);
        noteCaptureStopped();
        noteCaptureStopped();
        await clock.tickAsync(10);
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [5678, true], [1234, false], [5678, false]]);
    });

    test("parar antes da releitura: pede o false e nao relê", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(10);
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 100);
        assert.deepEqual(boost, [[1234, true], [5678, true], [1234, false], [5678, false]]);
        assert.deepEqual(priorityCalls, ["high", "high", "high", "restore"]);
        assert.ok(!testLines().some(m => m.includes("continua") || m.includes("agora")));
    });

    test("alta: nunca chama o Discord, nem sonda", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "high" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, []);
        assert.deepEqual(testLines(), []);
        assert.deepEqual(priorityCalls, ["high", "restore"]);
    });

    test("desligada: nada", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "off" });
        discordOk();
        noteCaptureStarted();
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, []);
        assert.deepEqual(priorityCalls, []);
    });

    test("o Discord recusa: uma linha 'falhou' por processo, e a transmissao segue", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk(() => {
            throw new Error("assinatura recusada");
        });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(testLines().slice(1, 3), [
            `${P}: Discord 1234 → falhou: Error: assinatura recusada (0 ms)`,
            `${P}: GPU do Discord 5678 → falhou: Error: assinatura recusada (0 ms)`
        ]);
        assert.equal(getEventLog().slice(base).filter(e => e.msg.startsWith(P) && e.level === "warn").length, 2);
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [5678, true], [1234, false], [5678, false]]);
    });

    test("sem o modulo do Discord: um aviso, nada pedido, e o fim nao pede nada", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(testLines(), [`${P}: discord_utils indisponível (o Discord não expõe o DiscordNative); funções parecidas: nenhuma. Nada foi pedido.`]);
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(testLines().length, 1);
        assert.deepEqual(priorityCalls, ["high", "restore"]);
    });

    test("a releitura sem resposta ou com erro: o log diz que nao deu para ler", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        reread = () => report({ targets: [{ ...targets("HIGH")[0], after: null, error: "sem resposta do ajudante" }] });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(testLines().slice(3), [
            `${P}: Discord 1234 → não deu para ler a classe agora (sem resposta do ajudante)`,
            `${P}: GPU do Discord 5678 → não deu para ler a classe agora (o processo não veio na resposta)`
        ]);
    });

    test("sem processos com classe conhecida (o helper nao respondeu): nada pedido", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        env!.restore();
        env = installNative({ setGpuPriority: async () => report({ ok: false, done: 0, targets: targets("HIGH").map(x => ({ ...x, before: null, after: null, error: "open 0x80070005" })) }) });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, []);
        assert.deepEqual(testLines(), [`${P}: nenhum processo do Discord com classe conhecida; nada foi pedido`]);
    });

    // #region o que o Telinha nao subiu nunca e tocado

    test("quem ja estava em REALTIME (ou HIGH) por conta do Discord nunca e tocado, nem no inicio nem no fim", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        env!.restore();
        const gpuRealtime = { pid: 5678, role: "GPU" as const, before: "REALTIME", after: "REALTIME", kept: true, error: null };
        env = installNative({
            setGpuPriority: async (mode: string) => {
                events.push(`native:${mode}`);
                return mode === "restore" ? restored() : report({ targets: [targets("HIGH")[0], gpuRealtime] });
            }
        });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, [[1234, true]]);
        assert.ok(testLines().includes(`${P}: GPU do Discord 5678 → já estava REALTIME; não pedi nada`));
        // a releitura so fala de quem foi pedido
        assert.ok(!testLines().some(m => m.startsWith(`${P}: GPU do Discord 5678 → agora`) || m.startsWith(`${P}: GPU do Discord 5678 → continua`)));
        assert.deepEqual(saved().map(e => e.pid), [1234]);
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [1234, false]]);

        // o Discord deu HIGH ao processo (kept em HIGH): tambem nao e tocado
        events.length = boost.length = 0;
        env!.restore();
        env = installNative({
            setGpuPriority: async (mode: string) => (mode === "restore" ? restored() : report({ targets: [{ ...targets("HIGH")[0], before: "HIGH", kept: true }, targets("HIGH")[1]] }))
        });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, [[5678, true]]);
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[5678, true], [5678, false]]);
    });

    test("todos ja em REALTIME: nada pedido, e o fim nao pede nada", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        env!.restore();
        const allRealtime = targets("REALTIME").map(x => ({ ...x, before: "REALTIME", kept: true }));
        env = installNative({ setGpuPriority: async (mode: string) => (mode === "restore" ? restored() : report({ targets: allRealtime })) });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, []);
        assert.ok(testLines().includes(`${P}: nenhum processo estava em HIGH por conta do Telinha; nada foi pedido`));
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, []);
    });

    // #endregion

    // #region o false do Discord poe NORMAL: o Telinha pede o "high" de novo

    test("trocar de Tempo real para Alta no meio da transmissao: false, e o high de novo (HIGH, nunca NORMAL); o fim so restaura", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        events.length = 0;
        pluginSettings.set("gpuPriorityMode", "high");
        await clock.tickAsync(10);
        assert.deepEqual(events, ["native:high", "boost:1234:false", "boost:5678:false", "native:high"]);
        assert.equal(session.has(SAVED_KEY), false);
        // o teste acabou: o fim da transmissao nao pede mais nada ao Discord, so a volta do Telinha
        events.length = 0;
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(events, ["native:restore"]);
    });

    test("o pedido grava {pid, classBefore, at} em sessionStorage; o fim apaga", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(10);
        assert.deepEqual(saved().map(e => [e.pid, e.role, e.classBefore, typeof e.at]), [[1234, "Discord", "NORMAL", "number"], [5678, "GPU", "NORMAL", "number"]]);
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.equal(session.has(SAVED_KEY), false);
    });

    test("o pedido que falhou nao e gravado, mas o fim ainda manda o false (o Discord pode ter aplicado)", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk(() => {
            throw new Error("recusou");
        });
        noteCaptureStarted();
        await clock.tickAsync(10);
        assert.equal(session.has(SAVED_KEY), false);
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost.filter(([, on]) => !on), [[1234, false], [5678, false]]);
    });

    // #endregion

    // #region pid que mudou

    test("o processo da GPU reiniciou (pid novo): o pid antigo nao leva o false, e o log diz", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        reread = () => report({ targets: [targets("HIGH")[0], { pid: 9999, role: "GPU", before: "NORMAL", after: "HIGH", kept: false, error: null }] });
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [5678, true], [1234, false]]);
        assert.ok(testLines().includes(`${P}: GPU do Discord 5678 → o processo mudou (reiniciou?); não desfiz nada nesse pid`));
        assert.equal(session.has(SAVED_KEY), false);
    });

    test("o pid existe mas ja e de outro papel, ou o helper diz 'tree': tambem nao leva o false", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        reread = () => report({
            targets: [
                { pid: 1234, role: "GPU", before: "NORMAL", after: "HIGH", kept: false, error: null },
                { pid: 5678, role: "GPU", before: null, after: null, kept: false, error: "tree pid 5678 fora da arvore do Discord" }
            ]
        });
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [5678, true]]);
    });

    test("sem resposta da parte nativa no fim: nao manda false (nao da para conferir) e o pedido continua salvo", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        env!.restore();
        let answered = 0;
        env = installNative({ setGpuPriority: async (mode: string) => (mode === "restore" ? restored() : ++answered <= 2 ? report() : null) });
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost, [[1234, true], [5678, true]]);
        assert.equal(saved().length, 2);
    });

    // #endregion

    // #region corridas

    test("corrida: a transmissao acaba enquanto o 'high' ainda nao voltou: o teste nao comeca", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        env!.restore();
        let open!: () => void;
        const gate = new Promise<void>(resolve => (open = resolve));
        env = installNative({
            setGpuPriority: async (mode: string) => {
                events.push(`native:${mode}`);
                if (mode === "restore") return restored();
                await gate;
                return report();
            }
        });
        noteCaptureStarted();
        noteCaptureStopped();
        open();
        await clock.tickAsync(REREAD_DELAY_MS + 100);
        assert.deepEqual(boost, []);
        assert.deepEqual(testLines(), []);
    });

    test("corrida: uma transmissao nova durante o desfazer da antiga espera ele, e a volta da antiga nao abaixa a nova", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        env!.restore();
        let open!: () => void;
        const gate = new Promise<void>(resolve => (open = resolve));
        let highs = 0;
        env = installNative({
            setGpuPriority: async (mode: string) => {
                events.push(`native:${mode}`);
                if (mode === "restore") return restored();
                // o 3o "high" e a conferencia dos pids do fim da transmissao antiga: fica parado ate soltar
                if (++highs === 3) await gate;
                return report();
            }
        });
        noteCaptureStarted(); // A
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(boost, [[1234, true], [5678, true]]);
        noteCaptureStopped(); // A acaba: o desfazer fica esperando a conferencia
        await clock.tickAsync(10);
        noteCaptureStarted(); // B comeca durante o desfazer de A
        await clock.tickAsync(10);
        // B ainda nao pediu nada ao Discord, e A ainda nao mandou o false
        assert.deepEqual(boost, [[1234, true], [5678, true]]);
        open();
        await clock.tickAsync(REREAD_DELAY_MS + 100);
        // o false de A vem inteiro antes do true de B, e A nao restaura (a prioridade e de B agora)
        assert.deepEqual(boost, [[1234, true], [5678, true], [1234, false], [5678, false], [1234, true], [5678, true]]);
        assert.ok(!events.includes("native:restore"));
        // depois do false de A, o "high" de novo; so entao B pede o REALTIME
        const lastFalse = events.indexOf("boost:5678:false");
        assert.equal(events[lastFalse + 1], "native:high");
        assert.ok(events.indexOf("boost:1234:true", lastFalse) > lastFalse + 1);
    });

    test("corrida: fim em dobro durante o desfazer nao repete o false", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        noteCaptureStopped();
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost.filter(([, on]) => !on), [[1234, false], [5678, false]]);
        assert.equal(events.filter(e => e === "native:restore").length, 1);
    });

    // #endregion

    // #region o desfazer ainda rodando quando a volta chega

    /**
     * O Discord e o main de mentira, com a classe de cada processo: o false do Discord leva a NORMAL (e demora), o true a REALTIME;
     * o "high" sobe quem esta abaixo de HIGH (guardando a classe de antes) e desce o REALTIME do Telinha; o "restore" volta quem
     * ainda esta em HIGH para a classe de antes e larga a entrada (como o main de verdade).
     */
    function statefulWorld() {
        const cls: Record<number, string> = { 1234: "NORMAL", 5678: "NORMAL" };
        const entries = new Map<number, { before: string; current: string; }>();
        const role = (pid: number) => (pid === 1234 ? "Discord" : "GPU") as "Discord" | "GPU";
        withModule(moduleWith((pid: number, enabled: boolean) => {
            boost.push([pid, enabled]);
            events.push(`boost:${pid}:${enabled}`);
            return new Promise<boolean>(resolve => setTimeout(() => {
                cls[pid] = enabled ? "REALTIME" : "NORMAL";
                resolve(true);
            }, 30));
        }));
        env!.restore();
        env = installNative({
            setGpuPriority: async (mode: string) => {
                events.push(`native:${mode}`);
                const list = [1234, 5678].map((pid): GpuPriorityReport["targets"][number] => {
                    const was = cls[pid];
                    const entry = entries.get(pid);
                    if (mode === "restore") {
                        if (entry && cls[pid] === entry.current) cls[pid] = entry.before;
                        entries.delete(pid);
                        return { pid, role: role(pid), before: was, after: cls[pid], kept: false, error: null };
                    }
                    if (entry && was === "REALTIME") {
                        cls[pid] = "HIGH";
                        entry.current = "HIGH";
                    } else if (BELOW.has(was)) {
                        cls[pid] = "HIGH";
                        if (entry) entry.current = "HIGH";
                        else entries.set(pid, { before: was, current: "HIGH" });
                    } else if (!entry) {
                        return { pid, role: role(pid), before: was, after: was, kept: true, error: null };
                    }
                    return { pid, role: role(pid), before: entry?.before ?? was, after: cls[pid], kept: false, error: null };
                });
                return report({ mode: mode as GpuPriorityReport["mode"], targets: list });
            }
        });
        return { cls };
    }
    const BELOW = new Set(["IDLE", "BELOW_NORMAL", "NORMAL", "ABOVE_NORMAL"]);

    test("Tempo real -> Alta e o fim da transmissao logo depois: a volta espera o desfazer, e o processo termina na classe de antes (NORMAL)", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        const world = statefulWorld();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 200);
        assert.deepEqual(boost, [[1234, true], [5678, true]]);
        events.length = 0;
        pluginSettings.set("gpuPriorityMode", "high"); // o desfazer comeca (sem esperar)
        await clock.tickAsync(10);
        noteCaptureStopped(); // o desfazer ainda esta no false
        await clock.tickAsync(500);
        assert.deepEqual([world.cls[1234], world.cls[5678]], ["NORMAL", "NORMAL"]);
        // o restore so vem depois do ultimo "high" do desfazer
        assert.equal(events.at(-1), "native:restore");
        assert.equal(events.filter(e => e === "native:restore").length, 1);
        assert.ok(events.lastIndexOf("native:high") < events.indexOf("native:restore"));
        assert.ok(events.indexOf("boost:5678:false") < events.indexOf("native:restore"));
    });

    test("Tempo real -> opcao desligada logo depois da troca para Alta: tambem termina em NORMAL", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        const world = statefulWorld();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 200);
        pluginSettings.set("gpuPriorityMode", "high");
        await clock.tickAsync(10);
        pluginSettings.set("gpuPriorityMode", "off");
        await clock.tickAsync(500);
        assert.deepEqual([world.cls[1234], world.cls[5678]], ["NORMAL", "NORMAL"]);
        assert.equal(events.at(-1), "native:restore");
    });

    test("parar, comecar e parar de novo em seguida: a volta espera o desfazer da primeira, e termina em NORMAL", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        const world = statefulWorld();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 200);
        noteCaptureStopped(); // desfazer da 1a
        noteCaptureStarted(); // 2a transmissao: o "high" ainda nao voltou
        noteCaptureStopped(); // acaba antes de o teste da 2a comecar
        await clock.tickAsync(REREAD_DELAY_MS + 500);
        assert.deepEqual([world.cls[1234], world.cls[5678]], ["NORMAL", "NORMAL"]);
        assert.equal(events.at(-1), "native:restore");
        assert.ok(events.indexOf("boost:5678:false") < events.lastIndexOf("native:restore"));
    });

    test("transmissao nova durante a espera da volta: a volta da antiga nao abaixa a nova", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        const world = statefulWorld();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 200);
        pluginSettings.set("gpuPriorityMode", "high");
        await clock.tickAsync(10);
        noteCaptureStopped(); // espera o desfazer
        noteCaptureStarted(); // a nova pede a prioridade durante a espera
        await clock.tickAsync(500);
        assert.ok(!events.includes("native:restore"));
        assert.deepEqual([world.cls[1234], world.cls[5678]], ["HIGH", "HIGH"]);
    });

    // #endregion

    // #region reload do renderer

    /** o renderer recarrega: o estado dos modulos some, o sessionStorage e o main continuam */
    const reload = () => {
        resetCaptureBoostForTests();
        resetDiscordGpuBoostForTests();
        events.length = boost.length = 0;
        priorityCalls.length = 0;
    };

    test("reload no meio do teste: o inicio do plugin desfaz (false, high de novo, restore) e limpa a lista; uma linha no log", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.equal(saved().length, 2);
        reload();
        base = getEventLog().length;
        await startCaptureBoost();
        assert.deepEqual(events, ["native:high", "boost:1234:false", "boost:5678:false", "native:high", "native:restore"]);
        assert.equal(session.has(SAVED_KEY), false);
        assert.deepEqual(testLines(), [`${P}: o Telinha recarregou com o tempo real pedido: desfeito em Discord 1234, GPU do Discord 5678`]);
    });

    test("reload: so desfaz o pid que ainda e do Discord (o outro ja era outro processo) e diz isso", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        reload();
        base = getEventLog().length;
        env!.restore();
        env = installNative({
            setGpuPriority: async (mode: string) => {
                events.push(`native:${mode}`);
                return mode === "restore" ? restored() : report({ targets: [targets("HIGH")[0]] });
            }
        });
        await startCaptureBoost();
        assert.deepEqual(boost, [[1234, false]]);
        assert.equal(session.has(SAVED_KEY), false);
        assert.equal(testLines().length, 1);
        assert.match(testLines()[0], /desfeito em Discord 1234; pulei GPU do Discord 5678 \(já não é o mesmo processo do Discord\)$/);
    });

    test("reload: sem nada salvo (ou lixo no sessionStorage) o inicio nao toca o Discord; sem resposta da parte nativa fica salvo", async t => {
        const clock = useFakeClock(t);
        discordOk();
        await startCaptureBoost();
        assert.deepEqual(boost, []);
        assert.deepEqual(priorityCalls, ["restore"]);
        session.set(SAVED_KEY, "isto nao e json");
        await startCaptureBoost();
        session.set(SAVED_KEY, JSON.stringify([{ pid: "x" }, null, { pid: 5, role: "Outro", classBefore: "NORMAL", at: 1 }]));
        await startCaptureBoost();
        assert.deepEqual(boost, []);

        session.set(SAVED_KEY, JSON.stringify([{ pid: 1234, role: "Discord", classBefore: "NORMAL", at: 1 }]));
        env!.restore();
        env = installNative({ setGpuPriority: async () => null });
        await startCaptureBoost();
        await clock.tickAsync(10);
        assert.deepEqual(boost, []);
        assert.equal(saved().length, 1);
        assert.match(testLines().at(-1)!, /não deu para conferir os processos do Discord; tento de novo no próximo início/);
    });

    test("reload: o false que falha deixa o pid salvo para a proxima vez", async () => {
        session.set(SAVED_KEY, JSON.stringify([{ pid: 1234, role: "Discord", classBefore: "NORMAL", at: 1 }]));
        discordOk(() => {
            throw new Error("recusou");
        });
        await startCaptureBoost();
        assert.equal(saved().length, 1);
        assert.match(testLines().at(-1)!, /falhou em Discord 1234 \(tento de novo no próximo início\)$/);
    });


    // #region registro no main (sobrevive a uma queda do renderer)

    /** o main de mentira: guarda o que o renderer mandou, como o native.ts (processo main) de verdade; sobrevive ao "reload" e a "queda" */
    let main: any[];
    function installMain(extra: Record<string, AnyFn> = {}) {
        main = [];
        installFakeNative({
            readGpuBoostRecord: async () => main,
            writeGpuBoostRecord: async (list: unknown[]) => {
                main = list;
                return list;
            },
            ...extra
        });
    }
    /** o renderer cai: um processo novo, sem sessionStorage nem estado dos modulos; so o main continua */
    const crash = () => {
        reload();
        session.clear();
    };

    test("o pedido tambem vai para o main (a lista inteira); o fim limpa os dois", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        installMain();
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(10);
        assert.deepEqual(main.map(e => [e.pid, e.role, e.classBefore, typeof e.at]), [[1234, "Discord", "NORMAL", "number"], [5678, "GPU", "NORMAL", "number"]]);
        assert.equal(saved().length, 2);
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(main, []);
        assert.equal(session.has(SAVED_KEY), false);
    });

    test("queda do renderer no meio do teste: sem sessionStorage, o inicio do plugin desfaz pelo registro do main", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        installMain();
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.equal(main.length, 2);
        crash();
        assert.equal(session.size, 0);
        base = getEventLog().length;
        await startCaptureBoost();
        assert.deepEqual(events, ["native:high", "boost:1234:false", "boost:5678:false", "native:high", "native:restore"]);
        assert.deepEqual(main, []);
        assert.equal(session.has(SAVED_KEY), false);
        assert.deepEqual(testLines(), [`${P}: o Telinha recarregou com o tempo real pedido: desfeito em Discord 1234, GPU do Discord 5678`]);
    });

    test("o main e o sessionStorage se somam por pid (o main manda quando os dois tem o mesmo)", async () => {
        installMain();
        main = [{ pid: 1234, role: "Discord", classBefore: "NORMAL", at: 1 }];
        session.set(SAVED_KEY, JSON.stringify([
            { pid: 1234, role: "Discord", classBefore: "BELOW_NORMAL", at: 2 },
            { pid: 5678, role: "GPU", classBefore: "NORMAL", at: 3 }
        ]));
        discordOk();
        await startCaptureBoost();
        assert.deepEqual(boost, [[1234, false], [5678, false]]);
        assert.deepEqual(main, []);
        assert.equal(session.has(SAVED_KEY), false);
    });

    test("o false que falha deixa o pid no main e no sessionStorage para a proxima vez", async () => {
        installMain();
        main = [{ pid: 1234, role: "Discord", classBefore: "NORMAL", at: 1 }];
        discordOk(() => {
            throw new Error("recusou");
        });
        await startCaptureBoost();
        assert.deepEqual(main, [{ pid: 1234, role: "Discord", classBefore: "NORMAL", at: 1 }]);
        assert.equal(saved().length, 1);
        assert.match(testLines().at(-1)!, /falhou em Discord 1234 \(tento de novo no próximo início\)$/);
    });

    test("sem conseguir conferir os processos (parte nativa muda): o registro do main continua, e o sessionStorage tambem", async () => {
        installMain({ setGpuPriority: async () => null });
        main = [{ pid: 1234, role: "Discord", classBefore: "NORMAL", at: 1 }];
        discordOk();
        await startCaptureBoost();
        assert.deepEqual(boost, []);
        assert.equal(main.length, 1);
        assert.equal(saved().length, 1);
    });

    test("main sem o registro (helper antigo): so o sessionStorage, como antes", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        // o padrao do beforeEach: a parte nativa nao tem readGpuBoostRecord/writeGpuBoostRecord
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.equal(saved().length, 2);
        assert.ok(!env!.calls.some(c => c.name.endsWith("GpuBoostRecord")));
        reload();
        await startCaptureBoost();
        assert.deepEqual(events, ["native:high", "boost:1234:false", "boost:5678:false", "native:high", "native:restore"]);
        assert.equal(session.has(SAVED_KEY), false);
    });

    test("main que falha: um aviso so para as gravacoes, e a leitura cai para o sessionStorage", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        installMain({
            writeGpuBoostRecord: async () => {
                throw new Error("ipc caiu");
            },
            readGpuBoostRecord: async () => {
                throw new Error("ipc caiu de novo");
            }
        });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(10);
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        const writeWarns = testLines().filter(l => l.includes("gravar o registro no processo main"));
        assert.equal(writeWarns.length, 1);
        assert.match(writeWarns[0], /ipc caiu\)/);
        // a leitura: o main nao responde, mas o sessionStorage ainda desfaz
        session.set(SAVED_KEY, JSON.stringify([{ pid: 1234, role: "Discord", classBefore: "NORMAL", at: 1 }]));
        reload();
        base = getEventLog().length;
        await startCaptureBoost();
        assert.deepEqual(boost, [[1234, false]]);
        assert.ok(testLines().some(l => l.includes("ler o registro do processo main (Error: ipc caiu de novo)")));
        assert.equal(session.has(SAVED_KEY), false);
    });

    test("as gravacoes no main saem na ordem, mesmo com a primeira lenta", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        const order: string[] = [];
        installMain({
            writeGpuBoostRecord: async (list: Array<{ pid: number; }>) => {
                const label = list.map(e => e.pid).join(",") || "vazio";
                order.push(`inicio:${label}`);
                if (order.length === 1) await new Promise(r => setTimeout(r, 500));
                order.push(`fim:${label}`);
                return list;
            }
        });
        discordOk();
        noteCaptureStarted();
        await clock.tickAsync(10);
        assert.deepEqual(order, ["inicio:1234"]);
        await clock.tickAsync(600);
        assert.deepEqual(order, ["inicio:1234", "fim:1234", "inicio:1234,5678", "fim:1234,5678"]);
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(order.slice(4).filter(l => l.startsWith("inicio")), ["inicio:vazio"]);
        // cada inicio so depois do fim do anterior
        for (let i = 0; i < order.length; i += 2) assert.ok(order[i].startsWith("inicio") && order[i + 1].startsWith("fim"));
    });

    test("sem sessionStorage no renderer (so o main) e com respostas que nao sao lista: o main ainda desfaz, o resto e ignorado", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        installMain();
        discordOk();
        delete g.sessionStorage;
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.equal(main.length, 2);
        crash();
        await startCaptureBoost();
        assert.deepEqual(boost, [[1234, false], [5678, false]]);
        assert.deepEqual(main, []);
        // o main devolve lixo que nao e lista e o sessionStorage tem um objeto: nada a desfazer
        boost.length = 0;
        installMain({ readGpuBoostRecord: async () => ({ pid: 1234 }) });
        g.sessionStorage = { getItem: () => "{}", setItem: () => undefined, removeItem: () => undefined };
        await startCaptureBoost();
        assert.deepEqual(boost, []);
    });

    test("o teste comecou durante a leitura do main: nao desfaz nada, mas o que a queda deixou no main continua la com o do teste novo", async t => {
        const clock = useFakeClock(t);
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        // o Discord D (pid 9999) ficou em REALTIME numa queda anterior; o teste novo sobe outros pids (1234 e 5678)
        installMain();
        main = [{ pid: 9999, role: "Discord", classBefore: "NORMAL", at: 1 }];
        // o main responde na hora da pergunta (a foto de antes do teste novo gravar), mas a resposta so chega ao renderer depois
        installMain({ readGpuBoostRecord: () => { const snapshot = main; return gate.then(() => snapshot); } });
        main = [{ pid: 9999, role: "Discord", classBefore: "NORMAL", at: 1 }];
        discordOk();
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        const recovering = startCaptureBoost();
        await clock.tickAsync(10);
        noteCaptureStarted();
        await clock.tickAsync(10);
        release();
        await clock.tickAsync(10);
        await recovering;
        assert.deepEqual(boost, [[1234, true], [5678, true]], "so o teste da transmissao nova pediu algo; ninguem desfez nada");
        assert.deepEqual(main.map(e => e.pid).sort((x, y) => x - y), [1234, 5678, 9999], "o main guarda o da queda e os do teste novo");
        // o proximo inicio do plugin ainda consegue desfazer o do pid 9999
        assert.deepEqual(saved().map(e => e.pid).sort((x, y) => x - y), [1234, 5678, 9999]);
    });

    test("o inicio do plugin durante um desfazer ainda rodando espera por ele (o false nao cai em dobro no mesmo pid)", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        installMain();
        let release!: () => void;
        const gate = new Promise<void>(r => (release = r));
        discordOk((_pid, on) => (on ? true : gate.then(() => true)));
        noteCaptureStarted();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.equal(main.length, 2);
        // o fim da transmissao comeca a desfazer (o false do 1o pid ainda nao respondeu) e o plugin reinicia no meio
        noteCaptureStopped();
        await clock.tickAsync(10);
        assert.deepEqual(boost.filter(([, on]) => !on), [[1234, false]]);
        const recovering = startCaptureBoost();
        await clock.tickAsync(50);
        assert.deepEqual(boost.filter(([, on]) => !on), [[1234, false]], "a recuperacao esperou, nao pediu o false de novo");
        release();
        await clock.tickAsync(REREAD_DELAY_MS + 50);
        await recovering;
        assert.deepEqual(boost.filter(([, on]) => !on), [[1234, false], [5678, false]], "cada pid levou um false so");
        assert.deepEqual(main, []);
    });

    test("o aviso de falha ao gravar no main sai uma vez por sequencia de falhas e volta depois de uma gravacao que deu certo", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ gpuPriorityMode: "realtime" });
        let fail = true;
        installMain({
            writeGpuBoostRecord: async (list: unknown[]) => {
                if (fail) throw new Error("disco cheio");
                main = list as any[];
                return list;
            }
        });
        discordOk();
        const warns = () => getEventLog().slice(base).filter(e => /não consegui gravar o registro/.test(e.msg)).length;
        noteCaptureStarted();
        await clock.tickAsync(10);
        // duas gravacoes (uma por pid), as duas falharam: um aviso
        assert.equal(warns(), 1);
        fail = false;
        noteCaptureStopped();
        await clock.tickAsync(REREAD_DELAY_MS + 10);
        assert.deepEqual(main, []);
        // outra sequencia de falhas: avisa de novo
        fail = true;
        noteCaptureStarted();
        await clock.tickAsync(10);
        assert.equal(warns(), 2);
    });

    // #endregion
});

// #endregion
