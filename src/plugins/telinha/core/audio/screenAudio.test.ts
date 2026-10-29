/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado renderer do audio da tela inteira (core/audio/screenAudio.ts): os natives vem do installNative
// (readScreenAudio roteirizado: PCM, pedaco parcial, "ended", erro, leitura que nao volta) e o Web Audio e o falso
// de test/fakes/audio.ts (AudioContext + worklet, ou MediaStreamTrackGenerator quando o CSP barra o worklet).
// Rodar:  pnpm test:file src/plugins/telinha/core/audio/screenAudio.test.ts

import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { describe, test,type TestContext } from "node:test";

import { getEventLog } from "@plugins/telinha/store";
import {
    audioEnv,
    FakeAudioContext,
    FakeAudioData,
    FakeMediaStreamAudioDestinationNode,
    FakeMediaStreamTrackGenerator,
    installWebAudio,
    type WebAudioEnv
} from "@test/fakes/audio";
import { flushPromises } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { FakeMediaStream } from "@test/fakes/webrtc";
import { pcm } from "@test/helpers/wpd-audio";

import { getScreenAudioStatus, isScreenAudioAvailable, startScreenAudioCapture } from "./screenAudio";
import { PCM_PLAYER_PROCESSOR, PCM_PLAYER_SOURCE } from "./worklet";

type AnyFn = (...args: any[]) => any;
type ReadStep = { pcm: Uint8Array | null; ended: boolean; reason?: string; } | Error | Promise<{ pcm: Uint8Array | null; ended: boolean; reason?: string; }>;

const OUTDATED = "a parte nativa do Telinha está desatualizada (feche o Discord por completo, inclusive da bandeja, e abra de novo)";

/** readScreenAudio roteirizado: cada leitura consome um passo; sem passos, a leitura fica pendente para sempre. */
class ReadScript {
    readonly calls: { id: number; wait: number; }[] = [];
    private readonly steps: ReadStep[];

    constructor(...steps: ReadStep[]) {
        this.steps = steps;
    }

    readonly read = async (id: number, wait: number) => {
        this.calls.push({ id, wait });
        const step = this.steps.shift();
        if (step === undefined) return new Promise<never>(() => { });
        if (step instanceof Error) throw step;
        return step;
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

interface Env {
    audio: WebAudioEnv;
    native: NativeEnv;
    script: ReadScript;
    stops(): unknown[][];
}

function setup(t: TestContext, opts: { audio?: { worklet?: boolean; generator?: boolean; }; script?: ReadScript; natives?: Record<string, AnyFn>; } = {}): Env {
    const audio = installWebAudio(opts.audio);
    const script = opts.script ?? new ReadScript();
    let nextId = 7;
    const native = installNative({
        startScreenAudio: async () => ({ ok: true, id: nextId++, sampleRate: 48000, channels: 2 }),
        readScreenAudio: script.read,
        stopScreenAudio: async () => undefined,
        ...opts.natives
    });
    t.after(() => {
        native.restore();
        audio.restore();
    });
    return { audio, native, script, stops: () => native.calls.filter(c => c.name === "stopScreenAudio").map(c => c.args) };
}

async function start(t: TestContext, setupOpts: Parameters<typeof setup>[1] = {}, startOpts: Parameters<typeof startScreenAudioCapture>[0] = {}) {
    const env = setup(t, setupOpts);
    const capture = await startScreenAudioCapture(startOpts);
    t.after(() => capture.stop());
    return { ...env, capture };
}

/** Mensagens do log do plugin (store.ts) depois de `mark`. */
function logsSince(mark: number) {
    return getEventLog().slice(mark).map(e => `${e.level}: ${e.msg}`);
}

function u8(bytes: Buffer): Uint8Array {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe("getScreenAudioStatus / isScreenAudioAvailable", () => {
    test("sem a parte nativa carregada", async () => {
        assert.deepEqual(await getScreenAudioStatus(), { available: false, reason: "a parte nativa do Telinha não está carregada" });
        assert.equal(await isScreenAudioAvailable(), false);
    });

    for (const missing of ["screenAudioStatus", "startScreenAudio", "readScreenAudio", "stopScreenAudio"]) {
        test(`native antigo sem ${missing}: pede para reiniciar o Discord`, async t => {
            setup(t, { natives: { [missing]: undefined as never } });
            assert.deepEqual(await getScreenAudioStatus(), { available: false, reason: OUTDATED });
            await assert.rejects(startScreenAudioCapture(), { message: `Sem áudio da tela: ${OUTDATED}.` });
        });
    }

    test("sem AudioWorklet e sem MediaStreamTrackGenerator: indisponivel", async t => {
        setup(t, { audio: { worklet: false } });
        assert.deepEqual(await getScreenAudioStatus(), { available: false, reason: "este Discord não tem AudioWorklet nem MediaStreamTrackGenerator" });
    });

    test("so o AudioData sem o gerador (ou o inverso) nao conta como gerador", async t => {
        setup(t, { audio: { worklet: false, generator: true } });
        delete (globalThis as Record<string, unknown>).AudioData;
        assert.equal((await getScreenAudioStatus()).available, false);
    });

    test("so com o gerador de faixas (sem worklet): consulta o helper e repassa a resposta", async t => {
        setup(t, { audio: { worklet: false, generator: true }, natives: { screenAudioStatus: async () => ({ available: true, reason: "ok do helper" }) } });
        assert.deepEqual(await getScreenAudioStatus(), { available: true, reason: "ok do helper" });
        assert.equal(await isScreenAudioAvailable(), true);
    });

    test("com worklet: repassa o motivo de indisponivel do helper tal como veio", async t => {
        setup(t, { audio: {}, natives: { screenAudioStatus: async () => ({ available: false, reason: "o Windows é antigo" }) } });
        assert.deepEqual(await getScreenAudioStatus(), { available: false, reason: "o Windows é antigo" });
        assert.equal(await isScreenAudioAvailable(), false);
    });

    test("o native lanca ao consultar: o motivo carrega o erro, sem rejeitar", async t => {
        setup(t, { natives: { screenAudioStatus: async () => { throw new Error("ipc caiu"); } } });
        assert.deepEqual(await getScreenAudioStatus(), { available: false, reason: "falha ao consultar o ajudante de áudio: Error: ipc caiu" });
    });
});

describe("startScreenAudioCapture: falhas (a transmissao segue sem audio)", () => {
    test("sem a parte nativa: rejeita em pt-BR", async () => {
        await assert.rejects(startScreenAudioCapture(), { message: "A parte nativa do Telinha não está carregada." });
    });

    test("o helper recusa (ok: false): rejeita com o motivo, desfaz o AudioContext e nao precisa parar nada no main", async t => {
        const env = setup(t, { natives: { startScreenAudio: async () => ({ ok: false, reason: "o Windows é antigo" }) } });
        await assert.rejects(startScreenAudioCapture(), { message: "Sem áudio da tela: o Windows é antigo." });
        const [ctx] = env.audio.contexts;
        assert.equal(ctx.state, "closed", "o AudioContext criado em paralelo foi fechado");
        const node = env.audio.workletNodes[0];
        assert.deepEqual(node.port.posted.map(p => p.data), [{ type: "stop" }]);
        assert.deepEqual(env.stops(), []);
    });

    test("o start rejeita: a mensagem carrega o erro e a saida e desfeita", async t => {
        const env = setup(t, { natives: { startScreenAudio: async () => { throw new Error("spawn falhou"); } } });
        await assert.rejects(startScreenAudioCapture(), { message: "Sem áudio da tela: Error: spawn falhou" });
        assert.equal(env.audio.contexts[0].state, "closed");
    });

    test("o helper subiu mas a faixa nao: para o helper (stopScreenAudio com o id) e explica", async t => {
        const env = setup(t);
        audioEnv.addModuleImpl = () => {
            throw new Error("CSP bloqueou");
        };
        await assert.rejects(startScreenAudioCapture(), { message: "Sem áudio da tela: não foi possível criar a faixa de áudio (Error: CSP bloqueou)." });
        assert.deepEqual(env.stops(), [[7]], "o helper que subiu e parado");
        assert.equal(env.audio.contexts[0].state, "closed");
    });

    test("sem worklet nem gerador mas com helper pronto: para o helper e diz que nao ha como criar a faixa", async t => {
        const env = setup(t, { audio: { worklet: false } });
        await assert.rejects(startScreenAudioCapture(), /Sem áudio da tela: não foi possível criar a faixa de áudio \(Error: este Discord não tem AudioWorklet nem MediaStreamTrackGenerator\)\./);
        assert.deepEqual(env.stops(), [[7]]);
    });

    test("helper e faixa falham juntos: vale o erro do helper (vem primeiro)", async t => {
        setup(t, { audio: { worklet: false }, natives: { startScreenAudio: async () => { throw new Error("helper"); } } });
        await assert.rejects(startScreenAudioCapture(), { message: "Sem áudio da tela: Error: helper" });
    });

    test("helper recusa (ok: false) e a faixa tambem falha: vale o motivo do helper", async t => {
        setup(t, { audio: { worklet: false }, natives: { startScreenAudio: async () => ({ ok: false, reason: "sem permissao" }) } });
        await assert.rejects(startScreenAudioCapture(), { message: "Sem áudio da tela: sem permissao." });
    });

    test("MediaStreamAudioDestinationNode sem faixa: falha e para o helper", async t => {
        const env = setup(t);
        t.mock.method(FakeAudioContext.prototype, "createMediaStreamDestination", function (this: FakeAudioContext) {
            const dest = new FakeMediaStreamAudioDestinationNode(this);
            Object.defineProperty(dest, "stream", { value: new FakeMediaStream([]) });
            return dest;
        });
        await assert.rejects(startScreenAudioCapture(), /MediaStreamAudioDestinationNode sem faixa/);
        assert.deepEqual(env.stops(), [[7]]);
        assert.equal(env.audio.contexts[0].state, "closed");
    });
});

describe("saida por AudioWorklet", () => {
    test("monta o AudioContext 48 kHz, carrega o worklet por blob:, liga so ao destino da faixa e devolve a faixa", async t => {
        let moduleSource = "";
        let moduleUrl = "";
        const revoked: string[] = [];
        t.mock.method(URL, "revokeObjectURL", ((url: string) => {
            revoked.push(url);
        }) as never);
        const env = setup(t);
        audioEnv.addModuleImpl = async url => {
            moduleUrl = url;
            moduleSource = (await resolveObjectURL(url)?.text()) ?? "";
        };
        const mark = getEventLog().length;
        const capture = await startScreenAudioCapture();
        t.after(() => capture.stop());

        assert.equal(capture.output, "worklet");
        const [ctx] = env.audio.contexts;
        assert.deepEqual(ctx.options, { sampleRate: 48000, latencyHint: "interactive" });
        assert.match(moduleUrl, /^blob:/);
        assert.equal(moduleSource, PCM_PLAYER_SOURCE, "o texto do worklet foi para o blob");
        assert.deepEqual(revoked, [moduleUrl], "o blob: e liberado depois de carregar");
        assert.deepEqual(ctx.workletModules, [moduleUrl]);
        assert.equal(ctx.state, "running", "resume() foi chamado");

        const [node] = env.audio.workletNodes;
        assert.equal(node.name, PCM_PLAYER_PROCESSOR);
        assert.deepEqual(node.options, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { targetMs: 80, maxTargetMs: 200 }
        });
        assert.equal(node.connections.length, 1);
        assert.ok(node.connections[0] instanceof FakeMediaStreamAudioDestinationNode, "ligado so ao destino da faixa");
        assert.ok(!node.connections.includes(ctx.destination as never), "nunca aos alto-falantes");

        const [track] = (node.connections[0] as FakeMediaStreamAudioDestinationNode).stream.getAudioTracks();
        assert.equal(capture.track, track);
        assert.equal(capture.track.contentHint, "music");
        assert.ok(logsSince(mark).includes("info: Áudio da tela: capturando o PC sem o Discord (AudioWorklet, buffer 80 ms)"));
    });

    test("targetLatencyMs: arredonda e limita a 20..500 ms; o teto do worklet acompanha (>= 200)", async t => {
        const env = setup(t);
        let n = 0;
        for (const [asked, wantTarget, wantMax] of [[5, 20, 200], [9999, 500, 500], [120.6, 121, 200], [-10, 20, 200], [250, 250, 250]] as const) {
            const capture = await startScreenAudioCapture({ targetLatencyMs: asked });
            const opts = env.audio.workletNodes[n++].options as { processorOptions: { targetMs: number; maxTargetMs: number; }; };
            assert.deepEqual(opts.processorOptions, { targetMs: wantTarget, maxTargetMs: wantMax }, `pedido ${asked}`);
            capture.stop();
        }
    });

    test("o CSP barra o blob: e o data: URL (base64 do mesmo texto) e a segunda tentativa; avisa no log", async t => {
        const mark = getEventLog().length;
        const env = setup(t);
        audioEnv.addModuleImpl = url => {
            if (url.startsWith("blob:")) throw new Error("CSP: blob");
        };
        const capture = await startScreenAudioCapture();
        t.after(() => capture.stop());
        const [ctx] = env.audio.contexts;
        assert.equal(ctx.workletModules.length, 1);
        const [url] = ctx.workletModules;
        assert.ok(url.startsWith("data:text/javascript;base64,"));
        assert.equal(Buffer.from(url.slice("data:text/javascript;base64,".length), "base64").toString("utf8"), PCM_PLAYER_SOURCE);
        assert.equal(capture.output, "worklet");
        assert.ok(logsSince(mark).includes("warn: Worklet de áudio via blob: recusado (Error: CSP: blob); tentando data:"));
    });

    test("blob: e data: recusados com gerador disponivel: cai para MediaStreamTrackGenerator e fecha o AudioContext", async t => {
        const mark = getEventLog().length;
        const env = setup(t, { audio: { generator: true } });
        audioEnv.addModuleImpl = () => {
            throw new Error("CSP total");
        };
        const capture = await startScreenAudioCapture();
        t.after(() => capture.stop());
        assert.equal(capture.output, "generator");
        assert.equal(env.audio.contexts[0].state, "closed", "o contexto do worklet que falhou foi fechado");
        assert.equal(env.audio.generators.length, 1);
        assert.equal(capture.track, env.audio.generators[0]);
        const logs = logsSince(mark);
        assert.ok(logs.some(l => l.startsWith("warn: Áudio da tela: AudioWorklet indisponível (Error: CSP total)")));
        assert.ok(logs.includes("info: Áudio da tela: capturando o PC sem o Discord (MediaStreamTrackGenerator)"));
    });

    test("AudioContext que nao sobe (suspended / resume rejeita): segue e avisa o estado no log", async t => {
        const mark = getEventLog().length;
        t.mock.method(FakeAudioContext.prototype, "resume", async () => {
            throw new Error("autoplay");
        });
        const env = setup(t);
        const capture = await startScreenAudioCapture();
        t.after(() => capture.stop());
        assert.equal(env.audio.contexts[0].state, "suspended");
        assert.ok(logsSince(mark).includes('warn: Áudio da tela: AudioContext em estado "suspended"'));
    });

    test("estatisticas do worklet: avisa so quando os underruns aumentam e ignora mensagens de outro tipo", async t => {
        const env = await start(t);
        const mark = getEventLog().length;
        const { port } = env.audio.workletNodes[0];
        port.emit({ type: "stats", underruns: 0, targetMs: 80, fillMs: 80 });
        port.emit({ type: "outra", underruns: 9 });
        port.emit(null);
        port.emit(undefined);
        assert.deepEqual(logsSince(mark), []);

        port.emit({ type: "stats", underruns: 2, targetMs: 100, fillMs: 40 });
        port.emit({ type: "stats", underruns: 2, targetMs: 100, fillMs: 90 });
        port.emit({ type: "stats", underruns: 5, targetMs: 140, fillMs: 10 });
        assert.deepEqual(logsSince(mark), [
            "warn: Áudio da tela: 2 falha(s) de buffer; buffer agora 100 ms (preenchido 40 ms)",
            "warn: Áudio da tela: 3 falha(s) de buffer; buffer agora 140 ms (preenchido 10 ms)"
        ]);
    });

    test("o PCM vai ao worklet por postMessage transferindo o buffer", async t => {
        const frames = u8(pcm(480));
        const script = new ReadScript({ pcm: frames, ended: false });
        const env = await start(t, { script });
        await flushPromises();
        const [msg] = env.audio.workletNodes[0].port.posted;
        assert.equal(msg.data, frames.buffer, "o ArrayBuffer inteiro e entregue, sem copia");
        assert.deepEqual(msg.transfer, [frames.buffer]);
    });
});

describe("pump de leitura (PCM, parcial, ended, erro, substituida)", () => {
    test("le com o id da captura e o prazo de 250 ms; entrega quadros inteiros e descarta o resto de um quadro", async t => {
        const whole = u8(pcm(4)); // 32 bytes: o ArrayBuffer inteiro
        const slab = new Uint8Array(64);
        slab.set(pcm(3), 16);
        const view = new Uint8Array(slab.buffer, 16, 24); // 3 quadros, byteOffset != 0: copia exata
        const partial = u8(pcm(2)).subarray(0, 12); // 1 quadro + 4 bytes: usa 8
        const script = new ReadScript(
            { pcm: whole, ended: false },
            { pcm: null, ended: false },
            { pcm: new Uint8Array(0), ended: false },
            { pcm: u8(pcm(1)).subarray(0, 7), ended: false }, // menos de um quadro: nada
            { pcm: view, ended: false },
            { pcm: partial, ended: false }
        );
        const env = await start(t, { script });
        await flushPromises();
        assert.deepEqual(script.calls.map(c => c.id), [7, 7, 7, 7, 7, 7, 7]);
        assert.ok(script.calls.every(c => c.wait === 250));
        const posted = env.audio.workletNodes[0].port.posted.map(p => p.data as ArrayBuffer);
        assert.deepEqual(posted.map(b => b.byteLength), [32, 24, 8]);
        assert.equal(posted[0], whole.buffer);
        assert.deepEqual(Array.from(new Float32Array(posted[1])), [1, -1, 2, -2, 3, -3]);
        assert.deepEqual(Array.from(new Float32Array(posted[2])), [1, -1]);
    });

    test("ended: entrega o ultimo PCM, chama onEnded com o motivo do main e para de ler", async t => {
        const reasons: string[] = [];
        const mark = getEventLog().length;
        const script = new ReadScript({ pcm: u8(pcm(2)), ended: true, reason: "o ajudante de áudio encerrou" });
        const env = await start(t, { script }, { onEnded: r => reasons.push(r) });
        await flushPromises();
        assert.deepEqual(reasons, ["o ajudante de áudio encerrou"]);
        assert.equal(env.audio.workletNodes[0].port.posted.length, 1, "o PCM da ultima leitura entrou antes do aviso");
        assert.equal(script.calls.length, 1, "nao le mais depois do ended");
        assert.ok(logsSince(mark).includes("warn: Áudio da tela parou: o ajudante de áudio encerrou (a transmissão segue sem áudio)"));
    });

    test("ended sem motivo: usa o texto padrao", async t => {
        const reasons: string[] = [];
        await start(t, { script: new ReadScript({ pcm: null, ended: true }) }, { onEnded: r => reasons.push(r) });
        await flushPromises();
        assert.deepEqual(reasons, ["a captura de áudio terminou"]);
    });

    test("erro de leitura (IPC): onEnded com o erro e o pump termina", async t => {
        const reasons: string[] = [];
        const script = new ReadScript(new Error("ipc caiu"));
        await start(t, { script }, { onEnded: r => reasons.push(r) });
        await flushPromises();
        assert.deepEqual(reasons, ["falha ao ler o áudio do ajudante: Error: ipc caiu"]);
        assert.equal(script.calls.length, 1);
    });

    test("um onEnded que lanca nao quebra nada", async t => {
        await start(t, { script: new ReadScript({ pcm: null, ended: true, reason: "x" }) }, {
            onEnded() {
                throw new Error("callback ruim");
            }
        });
        await flushPromises(); // uma excecao nao tratada derrubaria o processo de teste
    });

    test("sem onEnded o fim da captura passa em silencio (so o log)", async t => {
        const mark = getEventLog().length;
        await start(t, { script: new ReadScript({ pcm: null, ended: true, reason: "y" }) });
        await flushPromises();
        assert.ok(logsSince(mark).includes("warn: Áudio da tela parou: y (a transmissão segue sem áudio)"));
    });

    test("stop() com uma leitura pendente: o PCM ou o ended que voltar depois e ignorado", async t => {
        const reasons: string[] = [];
        const late = deferred<{ pcm: Uint8Array | null; ended: boolean; reason?: string; }>();
        const env = await start(t, { script: new ReadScript(late.promise) }, { onEnded: r => reasons.push(r) });
        await flushPromises();
        env.capture.stop();
        late.resolve({ pcm: u8(pcm(4)), ended: true, reason: "tarde" });
        await flushPromises();
        assert.equal(env.audio.workletNodes[0].port.posted.filter(p => p.data instanceof ArrayBuffer).length, 0);
        assert.deepEqual(reasons, []);
        assert.equal(env.script.calls.length, 1, "e nao le mais");
    });

    test("stop() com uma leitura pendente: o erro que voltar depois tambem e ignorado", async t => {
        const reasons: string[] = [];
        const failing = deferred<never>();
        const env = await start(t, { script: new ReadScript(failing.promise) }, { onEnded: r => reasons.push(r) });
        await flushPromises();
        env.capture.stop();
        failing.reject(new Error("depois de parar"));
        await flushPromises();
        assert.deepEqual(reasons, []);
    });

    test("uma captura nova substitui a anterior: a antiga nao entrega mais nada, nao avisa e nao para o helper (o main ja parou)", async t => {
        const reasons: string[] = [];
        const lateA = deferred<{ pcm: Uint8Array | null; ended: boolean; reason?: string; }>();
        const a = await start(t, { script: new ReadScript(lateA.promise) }, { onEnded: r => reasons.push("A: " + r) });
        await flushPromises();

        // a segunda captura usa os mesmos natives (o proximo id e o 8): outro AudioContext e outro worklet
        const b = await startScreenAudioCapture({ onEnded: r => reasons.push("B: " + r) });
        t.after(() => b.stop());
        await flushPromises();
        assert.deepEqual(a.script.calls.map(c => c.id), [7, 8], "a leitura da captura B usa o id 8");

        lateA.resolve({ pcm: u8(pcm(4)), ended: true, reason: "a captura antiga terminou" });
        await flushPromises();
        assert.deepEqual(reasons, [], "A foi substituida: o fim dela nao e noticia");
        const [nodeA, nodeB] = a.audio.workletNodes;
        assert.equal(nodeA.port.posted.length, 0, "A nao entregou o PCM tardio");
        assert.equal(nodeB.port.posted.length, 0);

        a.capture.stop();
        assert.deepEqual(a.stops(), [], "A nao manda parar: o main ja encerrou a captura 7 ao iniciar a 8");
        assert.equal(a.audio.contexts[0].state, "closed", "mas A libera o proprio AudioContext");
        assert.equal(a.capture.track.readyState, "ended");
        assert.equal(a.audio.contexts[1].state, "running", "a captura B segue");

        b.stop();
        assert.deepEqual(a.stops(), [[8]]);
    });
});

describe("stop", () => {
    test("stop() e idempotente: para o helper uma vez, fecha o worklet e o contexto e encerra a faixa", async t => {
        const env = await start(t);
        const { capture } = env;
        const [node] = env.audio.workletNodes;
        const [ctx] = env.audio.contexts;
        capture.stop();
        capture.stop();
        await flushPromises();
        assert.deepEqual(env.stops(), [[7]]);
        assert.deepEqual(node.port.posted.map(p => p.data), [{ type: "stop" }]);
        assert.equal(node.disconnected, true);
        assert.equal(ctx.state, "closed");
        assert.equal(capture.track.readyState, "ended");
    });

    test("track.stop() (o stopCapture do streaming.ts) faz o mesmo que capture.stop()", async t => {
        const env = await start(t);
        env.capture.track.stop();
        await flushPromises();
        assert.deepEqual(env.stops(), [[7]]);
        assert.equal(env.audio.contexts[0].state, "closed");
        assert.equal(env.capture.track.readyState, "ended");
        env.capture.stop();
        assert.deepEqual(env.stops(), [[7]], "nao para o helper de novo");
    });

    test("stopScreenAudio que rejeita, port que lanca e ctx.close que rejeita sao engolidos", async t => {
        const env = await start(t, { natives: { stopScreenAudio: async () => { throw new Error("main sumiu"); } } });
        env.audio.workletNodes[0].port.postMessage = () => {
            throw new Error("porta fechada");
        };
        env.audio.contexts[0].close = async () => {
            throw new Error("ja fechado");
        };
        env.capture.stop();
        await flushPromises(); // uma rejeicao nao tratada derrubaria o processo de teste
        assert.equal(env.capture.track.readyState, "ended");
    });

    test("pode comecar de novo depois de parar (a captura ativa e liberada)", async t => {
        const env = setup(t);
        const first = await startScreenAudioCapture();
        first.stop();
        const second = await startScreenAudioCapture();
        t.after(() => second.stop());
        assert.equal(second.output, "worklet");
        second.stop();
        assert.deepEqual(env.stops(), [[7], [8]], "cada captura parou o proprio id");
    });

    test("contentHint que lanca no Electron antigo nao impede a captura", async t => {
        const env = setup(t);
        t.mock.method(FakeAudioContext.prototype, "createMediaStreamDestination", function (this: FakeAudioContext) {
            const dest = new FakeMediaStreamAudioDestinationNode(this);
            const [track] = dest.stream.getAudioTracks();
            Object.defineProperty(track, "contentHint", {
                get: () => "",
                set: () => {
                    throw new TypeError("contentHint nao suportado");
                }
            });
            return dest;
        });
        const capture = await startScreenAudioCapture();
        t.after(() => capture.stop());
        assert.equal(capture.output, "worklet");
        assert.equal(env.audio.workletNodes.length, 1);
    });
});

describe("saida por MediaStreamTrackGenerator (sem worklet)", () => {
    test("cada bloco vira um AudioData f32 estereo 48 kHz com timestamp acumulado em microssegundos", async t => {
        const script = new ReadScript({ pcm: u8(pcm(480)), ended: false }, { pcm: u8(pcm(100)), ended: false }, { pcm: u8(pcm(100)), ended: false }, { pcm: u8(pcm(100)), ended: false });
        const env = await start(t, { audio: { worklet: false, generator: true }, script });
        await flushPromises();
        assert.equal(env.capture.output, "generator");
        assert.equal(env.audio.contexts.length, 0, "nenhum AudioContext e criado");
        const [generator] = env.audio.generators;
        assert.equal(env.capture.track, generator);
        assert.equal(env.capture.track.contentHint, "music");

        const written = generator.written as FakeAudioData[];
        assert.deepEqual(written.map(w => w.init.numberOfFrames), [480, 100, 100, 100]);
        assert.deepEqual(written.map(w => w.init.timestamp), [0, 10_000, 12_083, 14_167]);
        const [first] = written;
        assert.equal(first.init.format, "f32");
        assert.equal(first.init.sampleRate, 48000);
        assert.equal(first.init.numberOfChannels, 2);
        assert.ok(first.init.data instanceof Float32Array);
        assert.equal(first.init.data.length, 960);
        assert.deepEqual(Array.from(first.init.data.subarray(0, 4)), [1, -1, 2, -2]);
    });

    test("escrita recusada pelo writer: o AudioData e fechado (mesmo se o close lancar)", async t => {
        const made: FakeAudioData[] = [];
        const env = setup(t, { audio: { worklet: false, generator: true }, script: new ReadScript({ pcm: u8(pcm(10)), ended: false }, { pcm: u8(pcm(10)), ended: false }) });
        class RecordingAudioData extends FakeAudioData {
            constructor(init: FakeAudioData["init"]) {
                super(init);
                made.push(this);
            }

            override close() {
                super.close();
                throw new Error("ja fechado"); // o catch do plugin engole
            }
        }
        (globalThis as Record<string, unknown>).AudioData = RecordingAudioData;
        // o gerador ja nasce com o writer fechado: toda escrita rejeita
        class ClosedGenerator extends FakeMediaStreamTrackGenerator {
            constructor(init: { kind: "audio" | "video"; }) {
                super(init);
                this.writerClosed = true;
            }
        }
        (globalThis as Record<string, unknown>).MediaStreamTrackGenerator = ClosedGenerator;
        const capture = await startScreenAudioCapture();
        t.after(() => capture.stop());
        await flushPromises();
        assert.equal(made.length, 2);
        assert.ok(made.every(m => m.closed), "os AudioData que nao entraram foram liberados");
        assert.equal(env.audio.generators[0].written.length, 0);

    });

    test("stop(): fecha o writer do gerador, encerra a faixa e para o helper", async t => {
        const env = await start(t, { audio: { worklet: false, generator: true } });
        const [generator] = env.audio.generators;
        env.capture.stop();
        await flushPromises();
        assert.equal(generator.writerClosed, true);
        assert.equal(env.capture.track.readyState, "ended");
        assert.deepEqual(env.stops(), [[7]]);
        assert.equal(generator.written.length, 0);
    });

    test("writer.close() que rejeita no stop e engolido; contentHint que lanca nao impede", async t => {
        const env = setup(t, { audio: { worklet: false, generator: true } });
        class OddGenerator extends FakeMediaStreamTrackGenerator {
            constructor(init: { kind: "audio" | "video"; }) {
                super(init);
                Object.defineProperty(this, "contentHint", { get: () => "", set: () => { throw new TypeError("sem contentHint"); } });
                Object.defineProperty(this, "writable", {
                    value: { getWriter: () => ({ write: async () => { }, close: async () => { throw new Error("writer quebrado"); } }) }
                });
            }
        }
        (globalThis as Record<string, unknown>).MediaStreamTrackGenerator = OddGenerator;
        const capture = await startScreenAudioCapture();
        t.after(() => capture.stop());
        capture.stop();
        await flushPromises();
        assert.equal(env.audio.generators.length, 1);
        assert.equal(capture.output, "generator");
    });
});
