/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do codigo do Worker da copia na hora (core/captureCopyWorker.ts), rodando o texto de verdade num contexto vm com
// VideoFrame, OffscreenCanvas, WebGPU e os streams falsos: copia com o mesmo timestamp e o original fechado na hora,
// contrapressao (fila da placa e gerador: nada enfileira, o mais novo fica), falha de um quadro (vai o original) e de
// muitos (desliga), WebGPU perdendo a placa (vai para o canvas 2D), reenvio do ultimo quadro, fim e parada.
// Rodar:  pnpm test:file src/plugins/telinha/core/captureCopyWorker.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import vm from "node:vm";

import { COPY_WORKER_SOURCE } from "./captureCopyWorker";

const flush = async (n = 6) => {
    for (let i = 0; i < n; i++) await new Promise<void>(r => setImmediate(r));
};

class Frame {
    timestamp: number;
    duration: number | null;
    displayWidth: number;
    displayHeight: number;
    closed = false;
    readonly source: unknown;
    constructor(source: any, init: { timestamp?: number; duration?: number; } = {}) {
        this.source = source;
        this.timestamp = init.timestamp ?? source?.timestamp ?? 0;
        this.duration = init.duration ?? null;
        this.displayWidth = source?.displayWidth ?? source?.width ?? 1920;
        this.displayHeight = source?.displayHeight ?? source?.height ?? 1080;
    }
    close() { this.closed = true; }
    clone() { return new Frame(this, { timestamp: this.timestamp }); }
}

/** Um quadro "da captura" (nao veio de um canvas). */
const captured = (timestamp: number, w = 1920, h = 1080) => new Frame({ displayWidth: w, displayHeight: h, timestamp }, { timestamp, duration: 16_667 });

interface Gpu {
    submits: number;
    done: (() => void)[];
    lose(message: string): void;
}

function fakeGpu(): { navigatorGpu: unknown; gpu: Gpu; } {
    let lose: (info: unknown) => void = () => { };
    const gpu: Gpu = { submits: 0, done: [], lose: message => lose({ message }) };
    const device = {
        lost: new Promise(r => { lose = r; }),
        createShaderModule: () => ({}),
        createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
        createSampler: () => ({}),
        importExternalTexture: ({ source }: { source: Frame; }) => {
            if (source.closed) throw new Error("closed frame");
            return {};
        },
        createBindGroup: () => ({}),
        createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline() { }, setBindGroup() { }, draw() { }, end() { } }), finish: () => ({}) }),
        queue: {
            submit() { gpu.submits++; },
            onSubmittedWorkDone: () => new Promise<void>(r => gpu.done.push(r))
        },
        destroy() { }
    };
    return {
        gpu,
        navigatorGpu: {
            requestAdapter: async () => ({ info: { vendor: "nvidia", architecture: "ampere" }, requestDevice: async () => device }),
            getPreferredCanvasFormat: () => "bgra8unorm"
        }
    };
}

interface Rig {
    posted: any[];
    send(data: unknown): void;
    push(f: Frame): void;
    end(): void;
    written: Frame[];
    /** resolve a escrita mais antiga ainda pendente no gerador */
    ack(): void;
    autoAck: boolean;
    writerClosed: boolean;
    readerCancelled: boolean;
    drawImage: { calls: Frame[]; throws: Error | null; };
    stats(): Promise<any>;
}

function rig(opts: { gpu?: unknown; perf?: { now(): number; }; } = {}): Rig {
    const posted: any[] = [];
    const queue: Frame[] = [];
    let wake: ((v: { value?: Frame; done: boolean; }) => void) | null = null;
    let ended = false;
    const acks: (() => void)[] = [];
    const drawImage = { calls: [] as Frame[], throws: null as Error | null };
    const r: Rig = {
        posted,
        written: [],
        autoAck: true,
        writerClosed: false,
        readerCancelled: false,
        drawImage,
        send: data => (ctx as any).onmessage({ data }),
        push(f) {
            if (wake) { const w = wake; wake = null; w({ value: f, done: false }); } else queue.push(f);
        },
        end() {
            ended = true;
            if (wake) { const w = wake; wake = null; w({ done: true }); }
        },
        ack() { acks.shift()?.(); },
        async stats() {
            r.send({ op: "stats" });
            await flush();
            return posted.filter(m => m.type === "stats").at(-1);
        }
    };
    class OffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) { this.width = w; this.height = h; }
        getContext(type: string) {
            if (type === "2d") return { drawImage: (f: Frame) => { if (drawImage.throws) throw drawImage.throws; drawImage.calls.push(f); } };
            if (type === "webgpu") return { configure() { }, getCurrentTexture: () => ({ createView: () => ({}) }) };
            return null;
        }
    }
    const ctx: Record<string, unknown> = {
        VideoFrame: Frame,
        OffscreenCanvas,
        performance: opts.perf ?? performance,
        Promise,
        console,
        navigator: opts.gpu ? { gpu: opts.gpu } : {},
        postMessage: (m: unknown) => posted.push(m)
    };
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(COPY_WORKER_SOURCE, ctx);
    (r as any).readable = {
        getReader: () => ({
            read: () => new Promise(res => {
                if (queue.length) res({ value: queue.shift(), done: false });
                else if (ended) res({ done: true });
                else wake = res;
            }),
            cancel: async () => { r.readerCancelled = true; }
        })
    };
    (r as any).writable = {
        getWriter: () => ({
            desiredSize: 1,
            write: (f: Frame) => {
                r.written.push(f);
                return r.autoAck ? Promise.resolve() : new Promise<void>(res => acks.push(res));
            },
            close: async () => { r.writerClosed = true; }
        })
    };
    return r;
}

async function started(r: Rig, methods?: string[]) {
    r.send({ op: "init", ...(methods ? { methods } : {}) });
    await flush();
    r.send({ op: "run", readable: (r as any).readable, writable: (r as any).writable });
    await flush();
    return r.posted.find(m => m.type === "ready" || m.type === "failed");
}

describe("Worker da cópia na hora", () => {
    test("diz hello ao carregar; sem WebGPU, fica no canvas 2D", async () => {
        const r = rig();
        assert.equal(r.posted[0].type, "hello");
        const ready = await started(r);
        assert.deepEqual({ ...ready }, { type: "ready", method: "canvas2d", adapter: null });
    });

    test("com WebGPU e canvas 2D, o 2D vem primeiro (o padrão)", async () => {
        const { navigatorGpu } = fakeGpu();
        const ready = await started(rig({ gpu: navigatorGpu }));
        assert.equal(ready.method, "canvas2d");
    });

    test("canvas 2D lento (sem aceleração): depois de 120 cópias passa para o WebGPU, uma linha", async () => {
        const { navigatorGpu, gpu } = fakeGpu();
        let t = 0;
        const r = rig({ gpu: navigatorGpu, perf: { now: () => (t += 3) } });
        await started(r);
        for (let i = 1; i <= 120; i++) { r.push(captured(i * 1000)); await flush(1); }
        await flush();
        assert.equal(gpu.submits, 0, "as 120 primeiras foram no 2D");
        assert.deepEqual(r.posted.filter(m => m.type === "info").map(m => m.message), ["o canvas 2D está lento (3.0 ms por quadro, sem aceleração?): a cópia passou para o WebGPU (nvidia ampere)"]);
        r.push(captured(200_000));
        await flush();
        assert.equal(gpu.submits, 1);
        assert.equal((await r.stats()).method, "webgpu");
    });

    test("canvas 2D lento e só ele permitido: um aviso, continua no 2D", async () => {
        let t = 0;
        const r = rig({ perf: { now: () => (t += 3) } });
        await started(r, ["canvas2d"]);
        for (let i = 1; i <= 121; i++) { r.push(captured(i * 1000)); await flush(1); }
        await flush();
        assert.deepEqual(r.posted.filter(m => m.type === "warn").map(m => m.message), ["o canvas 2D está lento (3.0 ms por quadro, sem aceleração?)"]);
    });

    test("sem WebGPU e sem canvas 2D: failed com os motivos", async () => {
        const r = rig();
        r.send({ op: "init", methods: ["webgpu"] });
        await flush();
        const failed = r.posted.find(m => m.type === "failed");
        assert.match(failed.error, /webgpu: Error: sem WebGPU/);
    });

    test("cada quadro vira uma cópia com o MESMO timestamp; o original fecha na hora", async () => {
        const r = rig();
        await started(r);
        const a = captured(1_000_000);
        r.push(a);
        await flush();
        assert.equal(a.closed, true, "o original fecha assim que a cópia é pedida");
        assert.deepEqual(r.drawImage.calls, [a]);
        assert.equal(r.written.length, 1);
        const out = r.written[0];
        assert.notEqual(out, a);
        assert.equal(out.timestamp, 1_000_000);
        assert.equal(out.duration, 16_667);
        assert.equal(out.closed, false, "a cópia é do gerador (ele fecha)");
        const s = await r.stats();
        assert.equal(s.frames, 1);
        assert.equal(s.copied, 1);
        assert.equal(s.written, 1, "o gerador aceitou");
        assert.equal(s.dropped, 0);
        assert.equal(s.method, "canvas2d");
        assert.equal(s.width, 1920);
    });

    test("contrapressão no gerador: no máximo 1 quadro esperando, o mais novo; os outros são descartados e fechados", async () => {
        const r = rig();
        r.autoAck = false;
        await started(r);
        const frames = [1, 2, 3, 4].map(i => captured(i * 1000));
        for (const f of frames) { r.push(f); await flush(); }
        // 1 foi escrito (esperando o gerador), 2 e 3 foram substituídos, 4 espera
        assert.deepEqual(r.written.map(f => f.timestamp), [1000]);
        r.ack();
        await flush();
        assert.deepEqual(r.written.map(f => f.timestamp), [1000, 4000]);
        const s = await r.stats();
        assert.equal(s.dropped, 2);
        assert.equal(s.dropWrite, 2);
        assert.ok(frames.every(f => f.closed), "todos os originais fecharam");
    });

    test("WebGPU: com 3 cópias ainda na fila da placa, o quadro novo é descartado (e fechado) sem copiar", async () => {
        const { navigatorGpu, gpu } = fakeGpu();
        const r = rig({ gpu: navigatorGpu });
        const ready = await started(r, ["webgpu", "canvas2d"]);
        assert.equal(ready.method, "webgpu");
        assert.equal(ready.adapter, "nvidia ampere");
        const frames = [1, 2, 3, 4].map(i => captured(i * 1000));
        for (const f of frames) { r.push(f); await flush(); }
        assert.equal(gpu.submits, 3);
        assert.deepEqual(r.written.map(f => f.timestamp), [1000, 2000, 3000]);
        assert.ok(frames[3].closed);
        let s = await r.stats();
        assert.equal(s.dropGpu, 1);
        assert.equal(s.inflight, 3);
        // a placa termina: volta a copiar
        gpu.done.splice(0).forEach(d => d());
        await flush();
        r.push(captured(5000));
        await flush();
        assert.equal(gpu.submits, 4);
        s = await r.stats();
        assert.equal(s.gpuN, 3);
        assert.equal(s.copied, 4);
    });

    test("a escrita no gerador recusada: a cópia é fechada (não vaza) e a próxima segue", async () => {
        const r = rig();
        await started(r);
        const w = (r as any).writable.getWriter;
        (r as any).writable.getWriter = () => ({ ...w(), write: (f: Frame) => { r.written.push(f); return Promise.reject(new Error("errored")); } });
        r.send({ op: "run", readable: (r as any).readable, writable: (r as any).writable });
        await flush();
        r.push(captured(1000));
        await flush();
        r.push(captured(2000));
        await flush();
        assert.ok(r.written.length >= 1);
        assert.ok(r.written.every(f => f.closed), "cada cópia recusada foi fechada");
        assert.equal((await r.stats()).written, 0);
    });

    test("WebGPU perde a placa com cópias na fila: o canvas 2D não herda a fila (nenhum quadro descartado por ela)", async () => {
        const { navigatorGpu, gpu } = fakeGpu();
        const r = rig({ gpu: navigatorGpu });
        await started(r, ["webgpu", "canvas2d"]);
        for (const i of [1, 2, 3]) { r.push(captured(i * 1000)); await flush(); }
        assert.equal(gpu.submits, 3, "3 na fila da placa, que nunca termina");
        gpu.lose("TDR");
        await flush();
        for (const i of [4, 5, 6, 7]) { r.push(captured(i * 1000)); await flush(); }
        const s = await r.stats();
        assert.equal(s.dropGpu, 0);
        assert.equal(s.inflight, 0);
        assert.equal(r.drawImage.calls.length, 4);
    });

    test("WebGPU perde a placa: a cópia continua pelo canvas 2D, um aviso", async () => {
        const { navigatorGpu, gpu } = fakeGpu();
        const r = rig({ gpu: navigatorGpu });
        await started(r, ["webgpu", "canvas2d"]);
        gpu.lose("TDR");
        await flush();
        r.push(captured(1000));
        await flush();
        assert.equal(r.drawImage.calls.length, 1);
        assert.deepEqual(r.posted.filter(m => m.type === "warn").map(m => m.message), ["WebGPU perdeu a placa de vídeo (TDR): a cópia continua pelo canvas 2D"]);
        assert.equal((await r.stats()).method, "canvas2d");
    });

    test("a cópia falha num quadro: o original segue (como antes) e um aviso; 30 seguidas: desliga e passa direto", async () => {
        const r = rig();
        await started(r);
        r.drawImage.throws = new Error("boom");
        const first = captured(1000);
        r.push(first);
        await flush();
        assert.equal(r.written[0], first, "o original foi para o gerador");
        assert.equal(first.closed, false);
        for (let i = 2; i <= 30; i++) { r.push(captured(i * 1000)); await flush(); }
        const warns = r.posted.filter(m => m.type === "warn").map(m => m.message);
        assert.deepEqual(warns, ["A cópia na hora falhou num quadro (Error: boom): esse quadro foi direto", "A cópia na hora falhou 30 vezes seguidas (Error: boom): desligada, a captura segue direto"]);
        r.drawImage.throws = null;
        r.push(captured(31_000));
        await flush();
        assert.equal(r.drawImage.calls.length, 0, "desligada, nem tenta mais");
        const s = await r.stats();
        assert.equal(s.passed, 31);
        assert.equal(s.method, "passthrough");
    });

    test("refresh reenvia o último quadro copiado com um timestamp mais novo; sem quadro ainda, nada", async () => {
        const r = rig();
        await started(r);
        r.send({ op: "refresh" });
        await flush();
        assert.equal(r.written.length, 0);
        r.push(captured(1000));
        await flush();
        r.send({ op: "refresh" });
        await flush();
        assert.equal(r.written.length, 2);
        assert.ok(r.written[1].timestamp > 1000);
        assert.equal((await r.stats()).refreshed, 1);
    });

    test("a captura acabou: fecha o gerador; stop cancela a leitura, fecha o gerador e solta o último quadro", async () => {
        const r1 = rig();
        await started(r1);
        r1.end();
        await flush();
        assert.equal(r1.writerClosed, true);

        const r2 = rig();
        await started(r2);
        r2.push(captured(1000));
        await flush();
        r2.send({ op: "stop" });
        await flush();
        assert.equal(r2.readerCancelled, true);
        assert.equal(r2.writerClosed, true);
        r2.send({ op: "refresh" });
        await flush();
        assert.equal(r2.written.length, 1, "parado, o refresh não escreve");
    });
});
