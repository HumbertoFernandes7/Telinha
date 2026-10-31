/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da sonda WebCodecs do H.264 da placa (core/encoderProbe.ts) sobre um Worker falso (@test/fakes/worker): o lado
// do Worker e o roteiro do teste. Travou (config aceita, nenhum pacote no prazo desde o 1o encode()) = "broken", e o Worker
// preso NUNCA e terminado; sem suporte/erro, ou pacotes saindo com o flush sem fim = "unknown"; pacotes saindo = "ok",
// mesmo devagar. Prazos curtos com timers reais; o caso da placa lenta usa os prazos de verdade no relogio falso.
// Rodar:  pnpm test:file src/plugins/telinha/core/encoderProbe.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { healthyProbe, installWorker, stuckProbe, type WorkerEnv } from "@test/fakes/worker";

import { ENCODER_PROBE_TIMING, PROBE_WORKER_SOURCE, runEncoderProbe, stuckProbeWorkers } from "./encoderProbe";

let workers: WorkerEnv;
const saved = { ...ENCODER_PROBE_TIMING };

const shortTimings = () => Object.assign(ENCODER_PROBE_TIMING, { configureMs: 40, noChunkMs: 60, flushMs: 60 });

before(shortTimings);

after(() => Object.assign(ENCODER_PROBE_TIMING, saved));

afterEach(() => workers?.restore());

describe("sonda WebCodecs do H.264 da placa", () => {
    test("a placa codifica: ok, com a configuracao certa, e o Worker que terminou normalmente e encerrado", async () => {
        workers = installWorker(healthyProbe(30));
        const result = await runEncoderProbe("42001f");
        assert.deepEqual(result, { verdict: "ok", detail: "30 pacotes de 30 quadros" });
        const [w] = workers.instances;
        assert.match(w.url, /^blob:/, "o codigo vai por blob:");
        assert.deepEqual(w.posted, [{
            cmd: "run", frames: 30,
            config: { codec: "avc1.42001f", width: 1280, height: 720, framerate: 30, bitrate: 2_000_000, hardwareAcceleration: "prefer-hardware", latencyMode: "realtime", avc: { format: "annexb" } }
        }]);
        assert.equal(w.terminated, true);
    });

    test("31/10 (AMD RX 9070 XT): configure ok, nenhum pacote e o flush sem fim → broken no prazo; o Worker preso fica (nunca terminado)", async () => {
        workers = installWorker(stuckProbe());
        const before = stuckProbeWorkers();
        const result = await runEncoderProbe("42001f");
        assert.deepEqual(result, { verdict: "broken", detail: "nenhum pacote em 0.06 s desde o 1º quadro (o flush() não terminou)", hung: true });
        assert.equal(workers.instances[0].terminated, false, "terminate() desmontaria o encoder preso");
        assert.equal(stuckProbeWorkers(), before + 1, "guardado para sempre");
        // o Worker solta algo depois do prazo: ignorado
        workers.instances[0].emit({ ev: "done", verdict: "finished", chunks: 5 });
    });

    test("placa lenta mas saudavel (1o pacote aos 3 s, flush aos 5 s, prazos de verdade): ok", async t => {
        Object.assign(ENCODER_PROBE_TIMING, saved);
        const clock = useFakeClock(t);
        try {
            workers = installWorker(w => {
                w.emit({ ev: "phase", phase: "isConfigSupported" });
                setTimeout(() => {
                    w.emit({ ev: "phase", phase: "encode" });
                    w.emit({ ev: "phase", phase: "encoding" });
                }, 2000);
                setTimeout(() => w.emit({ ev: "chunk" }), 2000 + 3000);
                setTimeout(() => w.emit({ ev: "done", verdict: "finished", chunks: 30, error: null }), 2000 + 5000);
            });
            const run = runEncoderProbe("42001f");
            await clock.tickAsync(8000, 500);
            assert.deepEqual(await run, { verdict: "ok", detail: "30 pacotes de 30 quadros" });
            assert.equal(workers.instances[0].terminated, true);
        } finally {
            shortTimings();
        }
    });

    test("alguns pacotes saem, mas o flush nunca termina: inconclusiva (a placa codifica), e o Worker fica", async () => {
        workers = installWorker(w => {
            w.emit({ ev: "phase", phase: "encode" });
            w.emit({ ev: "phase", phase: "encoding" });
            w.emit({ ev: "chunk" });
            w.emit({ ev: "phase", phase: "flush" });
        });
        const result = await runEncoderProbe("4d001f");
        assert.deepEqual(result, { verdict: "unknown", detail: "os pacotes saíram, mas o flush() não terminou em 0.06 s", hung: true });
        assert.equal(workers.instances[0].terminated, false);
    });

    test("ainda codificando no prazo desde o 1o quadro, sem nenhum pacote: broken", async () => {
        workers = installWorker(w => {
            w.emit({ ev: "phase", phase: "encode" });
            w.emit({ ev: "phase", phase: "encoding" });
        });
        const result = await runEncoderProbe("42001f");
        assert.equal(result.detail, "nenhum pacote em 0.06 s desde o 1º quadro (ainda codificando)");
        assert.equal(result.hung, true);
    });

    test("o 1o quadro nao chega ao encoder no prazo: inconclusiva (o encoder ainda nem recebeu nada), e o Worker fica", async () => {
        workers = installWorker(w => w.emit({ ev: "phase", phase: "encode" }));
        assert.deepEqual(await runEncoderProbe("42001f"), { verdict: "unknown", detail: "encode sem resposta em 0.04 s", hung: true });
        assert.equal(workers.instances[0].terminated, false);
    });

    test("o flush termina sem nenhum pacote e sem erro: broken (sem esperar o prazo)", async () => {
        workers = installWorker(w => {
            w.emit({ ev: "phase", phase: "encode" });
            w.emit({ ev: "phase", phase: "encoding" });
            w.emit({ ev: "done", verdict: "finished", chunks: 0, error: null });
        });
        assert.deepEqual(await runEncoderProbe("42001f"), { verdict: "broken", detail: "nenhum pacote de 30 quadros (o flush terminou vazio)" });
        assert.equal(workers.instances[0].terminated, true, "nada preso: pode encerrar");
    });

    test("inconclusiva: sem WebCodecs, configuracao recusada, configure lanca, erro do encoder, Worker que falha", async () => {
        const cases: [NonNullable<WorkerEnv["script"]>, string][] = [
            [w => w.emit({ ev: "done", verdict: "nowebcodecs" }), "sem WebCodecs"],
            [w => w.emit({ ev: "done", verdict: "unsupported" }), "sem suporte: a placa não aceita avc1.42001f"],
            [w => w.emit({ ev: "done", verdict: "unsupported", error: "TypeError: x" }), "sem suporte: a placa não aceita avc1.42001f (TypeError: x)"],
            [w => w.emit({ ev: "done", verdict: "configure", error: "NotSupportedError: y" }), "configure falhou: NotSupportedError: y"],
            [w => w.emit({ ev: "done", verdict: "configure" }), "configure falhou"],
            [w => {
                w.emit({ ev: "phase", phase: "encode" });
                w.emit({ ev: "error", error: "EncodingError: z" });
                w.emit({ ev: "done", verdict: "finished", chunks: 0 });
            }, "erro do encoder sem nenhum pacote: EncodingError: z"],
            [w => {
                w.emit({ ev: "error" });
                w.emit({ ev: "done", verdict: "finished", chunks: 0 });
            }, "erro do encoder sem nenhum pacote: erro"],
            [w => w.fail("boom"), "o Worker falhou: boom"],
            [w => w.fail(""), "o Worker falhou: erro"]
        ];
        for (const [script, detail] of cases) {
            workers = installWorker(script);
            assert.deepEqual(await runEncoderProbe("42001f"), { verdict: "unknown", detail }, detail);
            assert.equal(workers.instances[0].terminated, true, detail);
            workers.restore();
        }
    });

    test("isConfigSupported sem resposta: inconclusiva (nao deu para saber), mas o Worker fica", async () => {
        workers = installWorker(w => w.emit({ ev: "phase", phase: "isConfigSupported" }));
        assert.deepEqual(await runEncoderProbe("42001f"), { verdict: "unknown", detail: "isConfigSupported sem resposta em 0.04 s", hung: true });
        assert.equal(workers.instances[0].terminated, false);
    });

    test("mensagens estranhas do Worker sao ignoradas", async () => {
        workers = installWorker(w => {
            w.emit(null);
            w.emit("texto");
            w.emit({ ev: "outra" });
            healthyProbe(3)(w, null);
        });
        assert.equal((await runEncoderProbe("42001f")).verdict, "ok");
    });

    test("sem Worker; blob: recusado (vai data:); os dois recusados; postMessage que lanca", async () => {
        const g = globalThis as { Worker?: unknown; };
        const original = g.Worker;
        delete g.Worker;
        try {
            assert.deepEqual(await runEncoderProbe("42001f"), { verdict: "unknown", detail: "sem Worker (ou o Discord recusou criar um)" });
        } finally {
            g.Worker = original;
        }

        workers = installWorker(healthyProbe());
        workers.refuse = url => url.startsWith("blob:");
        assert.equal((await runEncoderProbe("42001f")).verdict, "ok");
        assert.match(workers.instances[0].url, /^data:text\/javascript;base64,/);
        assert.equal(atob(workers.instances[0].url.split(",")[1]), PROBE_WORKER_SOURCE);
        workers.restore();

        workers = installWorker(healthyProbe());
        workers.refuse = () => true;
        assert.equal((await runEncoderProbe("42001f")).detail, "sem Worker (ou o Discord recusou criar um)");
        workers.restore();

        workers = installWorker();
        const Base = (globalThis as { Worker: any; }).Worker;
        (globalThis as { Worker: any; }).Worker = class extends Base {
            postMessage() {
                throw new Error("DataCloneError");
            }
        };
        const result = await runEncoderProbe("42001f");
        assert.equal(result.verdict, "unknown");
        assert.match(result.detail, /^o Worker não aceitou a mensagem: Error: DataCloneError/);
    });

    test("o codigo do Worker e so ASCII (vai por data: com btoa quando o blob: e recusado) e nunca termina o encoder preso", () => {
        assert.ok(/^[\x20-\x7e\n]*$/.test(PROBE_WORKER_SOURCE));
        assert.ok(!PROBE_WORKER_SOURCE.includes("terminate"), "o Worker nao se encerra");
        // o encoder so e fechado depois de o flush terminar (preso no flush, ele fica)
        assert.ok(PROBE_WORKER_SOURCE.indexOf("enc.close()") > PROBE_WORKER_SOURCE.indexOf("await enc.flush()"));
    });
});
