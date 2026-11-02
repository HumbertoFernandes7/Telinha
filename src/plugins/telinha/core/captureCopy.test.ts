/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado do main da copia na hora (core/captureCopy.ts), com o Worker, o MediaStreamTrackProcessor e o
// MediaStreamTrackGenerator falsos (test/fakes/captureCopy.ts): liga (hello → init → ready → run com os streams
// transferidos, maxBufferSize 1, uma linha no log), falha mole antes de ligar (sem APIs, Worker recusado ou mudo, init
// falhou, transferencia recusada: null + uma linha, nada fica aberto), falha no meio (o Worker cai ou para de responder:
// onFail uma vez), a linha de custo a cada 30 s, stop, refresh e o diagnostico.
// Rodar:  pnpm test:file src/plugins/telinha/core/captureCopy.test.ts

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { getEventLog } from "@plugins/telinha/store";
import { fakeCopyEnv, zeroStats } from "@test/fakes/captureCopy";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { videoTrack } from "@test/fakes/webrtc";

import { captureCopyDiagnostics, COPY_FLOW_MIN_FRAMES, COPY_FLOW_POLLS, COPY_LOG_MS, COPY_RATE_GRACE_MS, COPY_RATE_MIN, COPY_RATE_MIN_FRAMES, COPY_RATE_POLLS, COPY_START_TIMEOUT_MS, COPY_UNANSWERED_POLLS, copyStatsLine, resetCaptureCopyForTests, startCaptureCopy } from "./captureCopy";

function logMark() {
    const seen = new Set(getEventLog());
    return () => getEventLog().filter(e => !seen.has(e)).map(e => `${e.level}: ${e.msg}`);
}

const flush = async (n = 5) => {
    for (let i = 0; i < n; i++) await flushPromises();
};

afterEach(() => resetCaptureCopyForTests());

describe("cópia na hora: ligar", () => {
    test("hello → init → ready → run: a faixa do gerador, os streams transferidos, maxBufferSize 1 e uma linha no log", async () => {
        const fake = fakeCopyEnv();
        const source = videoTrack();
        const since = logMark();
        const copy = await startCaptureCopy(source as unknown as MediaStreamTrack, fake.env);
        assert.ok(copy);
        assert.equal(copy.method, "webgpu");
        assert.equal(copy.track, fake.generators[0], "os envios usam a faixa do gerador");
        assert.equal(fake.processors.length, 1);
        assert.equal(fake.processors[0].track, source, "o processador lê a faixa ORIGINAL");
        assert.equal(fake.processors[0].maxBufferSize, 1, "o processador guarda só o quadro mais novo");
        assert.deepEqual(fake.worker.ops(), ["init", "run"]);
        assert.deepEqual(fake.worker.posted[0].methods, ["canvas2d", "webgpu"], "o canvas 2D primeiro (mais barato, medido)");
        assert.deepEqual(fake.holders, [{ tracks: [source], closed: false }], "a faixa ORIGINAL numa RTCPeerConnection nunca negociada (o quadro de 1 s da tela parada)");
        assert.deepEqual(fake.worker.transfers[0], [fake.processors[0].readable, fake.generators[0].writable]);
        assert.equal(fake.worker.url, "blob:fake-copy");
        assert.deepEqual(since(), ["info: Captura pela placa: cópia na hora ligada (WebGPU, nvidia ampere): cada quadro é copiado na placa de vídeo assim que chega, "
            + "para o encoder nunca ler uma textura que o Windows já reaproveitou"]);
        copy.stop();
    });

    test("sem WebGPU no Worker: canvas 2D, sem placa no texto", async () => {
        const fake = fakeCopyEnv({ method: "canvas2d", adapter: null });
        const since = logMark();
        const copy = await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env);
        assert.equal(copy?.method, "canvas2d");
        assert.match(since()[0], /^info: Captura pela placa: cópia na hora ligada \(canvas 2D\): /);
        copy?.stop();
    });

    test("blob: recusado pelo CSP: tenta data: (o mesmo código em base64 UTF-8)", async () => {
        const fake = fakeCopyEnv();
        fake.refuse = url => url.startsWith("blob:");
        const copy = await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env);
        assert.ok(copy);
        assert.ok(fake.worker.url.startsWith("data:text/javascript;base64,"));
        const code = new TextDecoder().decode(Uint8Array.from(atob(fake.worker.url.split(",")[1]), c => c.charCodeAt(0)));
        assert.ok(code.includes("cópia na hora"), "os acentos sobrevivem");
        copy.stop();
    });

    for (const [name, over, why] of [
        ["sem Worker", { Worker: undefined }, "sem Worker"],
        ["sem MediaStreamTrackProcessor", { MediaStreamTrackProcessor: undefined }, "sem MediaStreamTrackProcessor/Generator"],
        ["sem MediaStreamTrackGenerator", { MediaStreamTrackGenerator: undefined }, "sem MediaStreamTrackProcessor/Generator"]
    ] as const) {
        test(`falha mole: ${name} → null e uma linha`, async () => {
            const fake = fakeCopyEnv();
            const since = logMark();
            const copy = await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, { ...fake.env, ...over });
            assert.equal(copy, null);
            assert.deepEqual(since(), [`warn: Captura pela placa: cópia na hora indisponível (${why}); a captura vai direto para os envios`]);
            assert.equal(captureCopyDiagnostics(), `cópia na hora: indisponível na última transmissão (${why})`);
        });
    }

    test("falha mole: blob: e data: recusados → null", async () => {
        const fake = fakeCopyEnv();
        fake.refuse = () => true;
        const since = logMark();
        assert.equal(await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env), null);
        assert.match(since()[0], /^warn: Captura pela placa: cópia na hora indisponível \(o Discord recusou o Worker: /);
    });

    test("falha mole: o Worker nunca diz hello (CSP barrou o script) → null depois do tempo, e o Worker é terminado", async t => {
        const clock = useFakeClock(t);
        const fake = fakeCopyEnv({ hello: false });
        const since = logMark();
        const pending = startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env);
        await clock.tickAsync(COPY_START_TIMEOUT_MS + 100);
        assert.equal(await pending, null);
        assert.equal(fake.worker.terminated, true);
        assert.deepEqual(since(), [`warn: Captura pela placa: cópia na hora indisponível (o Worker não respondeu em ${COPY_START_TIMEOUT_MS / 1000} s); a captura vai direto para os envios`]);
    });

    test("sem RTCPeerConnection: a cópia liga do mesmo jeito (só falta o quadro de 1 s da tela parada)", async () => {
        const fake = fakeCopyEnv();
        const copy = await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, { ...fake.env, RTCPeerConnection: undefined });
        assert.ok(copy);
        copy.stop();
    });

    test("falha mole: o Worker dá erro ao carregar → null", async () => {
        const fake = fakeCopyEnv({ hello: false });
        const pending = startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env);
        await flush();
        fake.worker.fail("Refused to create a worker");
        assert.equal(await pending, null);
        assert.equal(fake.worker.terminated, true);
    });

    test("falha mole: nem WebGPU nem canvas 2D → null com o motivo do Worker, nada criado", async () => {
        const fake = fakeCopyEnv({ initFails: "webgpu: Error: sem WebGPU; canvas2d: sem contexto 2d" });
        const since = logMark();
        assert.equal(await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env), null);
        assert.equal(fake.processors.length, 0);
        assert.deepEqual(since(), ["warn: Captura pela placa: cópia na hora indisponível (webgpu: Error: sem WebGPU; canvas2d: sem contexto 2d); a captura vai direto para os envios"]);
    });

    test("falha mole: transferir os streams falha → null, o gerador para e o Worker é terminado", async () => {
        const fake = fakeCopyEnv({ transferThrows: true });
        const since = logMark();
        assert.equal(await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env), null);
        assert.equal(fake.generators[0].readyState, "ended");
        assert.equal(fake.worker.terminated, true);
        assert.match(since()[0], /^warn: Captura pela placa: cópia na hora indisponível \(não deu para ligar a captura ao Worker: /);
    });
});

describe("cópia na hora: no ar", () => {
    async function live(t: Parameters<typeof useFakeClock>[0], shared?: ReturnType<typeof useFakeClock>) {
        const clock = shared ?? useFakeClock(t);
        const fake = fakeCopyEnv();
        const source = videoTrack();
        const copy = (await startCaptureCopy(source as unknown as MediaStreamTrack, fake.env))!;
        return { clock, fake, source, copy };
    }

    test("stats pergunta ao Worker; a linha de custo sai a cada 30 s com a janela", async t => {
        const { clock, fake, copy } = await live(t);
        const since = logMark();
        fake.stats = { frames: 100, copied: 100, written: 100, copyMs: 20, gpuMs: 300, gpuN: 100, gpuMax: 40 };
        await clock.tickAsync(2000);
        fake.stats = { frames: 1900, copied: 1890, written: 1890, copyMs: 400, gpuMs: 2700, gpuN: 1890, gpuMax: 41, gpuLate: 2, dropped: 10, dropGpu: 4, dropWrite: 6 };
        await clock.tickAsync(COPY_LOG_MS);
        assert.deepEqual(since(), ["info: Cópia na hora (WebGPU): 1800 quadros em 30 s · 0,21 ms/quadro no Worker · placa termina a cópia em 1,34 ms (máx. 41, 2 acima de 33 ms) "
            + "· 10 descartados pela fila (placa 4, envio 6)"]);
        const s = await copy.stats();
        assert.equal(s?.frames, 1900);
        assert.match(captureCopyDiagnostics()!, /^cópia na hora: WebGPU \(nvidia ampere\); desde o início: 1900 quadros · 0,21 ms\/quadro no Worker/);
        copy.stop();
    });

    test("refresh e stop vão para o Worker; stop para a faixa do gerador e termina o Worker depois", async t => {
        const { clock, fake, copy } = await live(t);
        copy.refresh();
        copy.stop();
        assert.deepEqual(fake.worker.ops(), ["init", "run", "refresh", "stop"]);
        assert.equal(copy.track.readyState, "ended");
        assert.equal(fake.holders[0].closed, true, "a RTCPeerConnection do quadro de 1 s fecha");
        assert.equal(fake.worker.terminated, false, "o Worker solta a placa e o gerador antes");
        await clock.tickAsync(1500);
        assert.equal(fake.worker.terminated, true);
        copy.refresh();
        assert.equal(fake.worker.ops().at(-1), "stop", "parado, nada mais vai");
    });

    test("o Worker cai no meio: onFail uma vez, uma linha; a cópia para", async t => {
        const { fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        const since = logMark();
        fake.worker.fail("out of memory");
        fake.worker.fail("de novo");
        assert.deepEqual(reasons, ["o Worker caiu: out of memory"]);
        assert.deepEqual(since(), ["warn: Captura pela placa: a cópia na hora parou (o Worker caiu: out of memory); os envios voltam para a captura direta"]);
        assert.equal(fake.worker.ops().at(-1), "stop");
    });

    test("o Worker para de responder com a captura no ar: onFail depois de 3 pedidos sem resposta; com a captura já encerrada, nada", async t => {
        const { clock, fake, source, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        fake.mute = true;
        await clock.tickAsync(2000 * COPY_UNANSWERED_POLLS);
        assert.deepEqual(reasons, [], "3 pedidos ainda sem resposta: espera mais um");
        await clock.tickAsync(2000);
        assert.deepEqual(reasons, [`o Worker não respondeu a ${COPY_UNANSWERED_POLLS} pedidos seguidos`]);

        const other = await live(t, clock);
        const r2: string[] = [];
        other.copy.onFail(r => r2.push(r));
        other.fake.mute = true;
        other.source.stop();
        await other.clock.tickAsync(2000 * COPY_UNANSWERED_POLLS * 3);
        assert.deepEqual(r2, []);
        other.copy.stop();
        void source;
    });

    test("o Worker lento (o timer atrasado, o Discord minimizado): responde antes do próximo pedido e nunca cai", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        fake.script = (w, d) => {
            if (d?.op === "stats") setTimeout(() => w.emit({ type: "stats", ...zeroStats() }), 1900);
        };
        await clock.tickAsync(60_000);
        assert.deepEqual(reasons, []);
        copy.stop();
    });

    test("vigia do fluxo: a captura anda e nada chega ao gerador → onFail; a captura parada não conta", async t => {
        const clock = useFakeClock(t);
        const fake = fakeCopyEnv();
        let total = 0;
        const source = Object.defineProperty(videoTrack(), "stats", { get: () => ({ totalFrames: total }) });
        const copy = (await startCaptureCopy(source as unknown as MediaStreamTrack, fake.env))!;
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        // tela parada: a captura não entrega nada e o gerador também não; nunca é culpa da cópia
        await clock.tickAsync(20_000);
        assert.deepEqual(reasons, []);
        assert.equal(copy.outputFlat(), false);
        // a captura volta a andar e o gerador fica parado
        total += COPY_FLOW_MIN_FRAMES;
        assert.equal(copy.outputFlat(), false, "entre respostas não conta: a próxima resposta ainda pode ver o gerador andar");
        await clock.tickAsync(2000);
        assert.equal(copy.outputFlat(), true, "uma resposta já viu a captura andar sem saída");
        await clock.tickAsync(2000 * (COPY_FLOW_POLLS - 1));
        assert.deepEqual(reasons, [`os quadros não saem da cópia: ${COPY_FLOW_MIN_FRAMES} quadros da captura sem nenhum chegar aos envios`]);
        assert.equal(copy.outputFlat(), false, "parada, não diz mais nada");
    });

    test("vigia do fluxo: sem MediaStreamTrack.stats, usa os quadros que o Worker leu; abandon desiste na hora", async t => {
        const clock = useFakeClock(t);
        const fake = fakeCopyEnv();
        const copy = (await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env))!;
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        fake.stats = { frames: 10, written: 10 };
        await clock.tickAsync(2000);
        fake.stats = { frames: 10 + COPY_FLOW_MIN_FRAMES, written: 10 };
        await clock.tickAsync(2000 * COPY_FLOW_POLLS);
        assert.equal(reasons.length, 1);
        const b = await live(t, clock);
        const r2: string[] = [];
        b.copy.onFail(r => r2.push(r));
        b.copy.abandon("pedido do checkStall");
        b.copy.abandon("de novo");
        assert.deepEqual(r2, ["pedido do checkStall"]);
    });

    /** o Worker com contadores acumulados: cada resposta soma o proximo par [quadros lidos, quadros aceitos pelo gerador] */
    function feed(fake: ReturnType<typeof fakeCopyEnv>, steps: [number, number][]) {
        let frames = 0, written = 0, i = 0;
        fake.script = (w, d) => {
            if (d?.op !== "stats") return;
            const [df, dw] = steps[Math.min(i++, steps.length - 1)];
            frames += df;
            written += dw;
            w.emit({ type: "stats", ...zeroStats(), frames, copied: frames, written });
        };
    }

    /** o Worker com uma resposta por pedido: `step(n)` devolve os contadores acumulados da n-esima (1, 2, ...) */
    function script(fake: ReturnType<typeof fakeCopyEnv>, step: (n: number) => Partial<ReturnType<typeof zeroStats>>) {
        let n = 0;
        fake.script = (w, d) => {
            if (d?.op !== "stats") return;
            const o = step(++n);
            w.emit({ type: "stats", ...zeroStats(), copied: o.frames, ...o });
        };
    }

    test("vigia da taxa: o gerador aceita só 50% → onFail uma vez, com a taxa no motivo, só na 2ª avaliação seguida", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        feed(fake, [[120, 60]]);
        // a 1a resposta (2 s) e so a base; a janela de COPY_RATE_POLLS respostas fecha na 7a (14 s): 1a avaliacao ruim
        await clock.tickAsync(2000 * COPY_RATE_POLLS);
        assert.deepEqual(reasons, [], "ainda sem janela completa");
        await clock.tickAsync(3000);
        assert.deepEqual(reasons, [], "1ª avaliação ruim (14 s): uma só não desliga");
        await clock.tickAsync(1000);
        assert.equal(reasons.length, 1, "2ª avaliação ruim seguida (16 s)");
        assert.match(reasons[0], /entrega só 50% dos quadros/);
        await clock.tickAsync(20_000);
        assert.equal(reasons.length, 1, "falhou uma vez; a cópia fica desligada");
    });

    for (const pct of [36, 61, 66]) {
        test(`vigia da taxa: a janela ruim do ar (${pct}%) desliga, nunca antes de ${COPY_RATE_GRACE_MS / 1000} s e só na 2ª avaliação seguida`, async t => {
            const { clock, fake, copy } = await live(t);
            const reasons: string[] = [];
            copy.onFail(r => reasons.push(r));
            feed(fake, [[100, pct]]);
            await clock.tickAsync(COPY_RATE_GRACE_MS);
            assert.deepEqual(reasons, [], "dentro dos primeiros 10 s");
            await clock.tickAsync(5999);
            assert.deepEqual(reasons, [], "só 1 avaliação ruim (a janela fecha aos 14 s); a 2ª vem aos 16 s");
            await clock.tickAsync(1);
            assert.equal(reasons.length, 1);
            assert.equal(reasons[0], `a cópia entrega só ${pct}% dos quadros ao envio (${6 * pct} de 600 em 12 s)`);
        });
    }

    test("vigia da taxa: a taxa mínima e a janela são as combinadas (75% em ~12 s)", () => {
        assert.equal(COPY_RATE_MIN, 0.75);
        assert.equal(COPY_RATE_POLLS, 6);
        assert.equal(COPY_RATE_GRACE_MS, 10_000);
    });

    test("vigia da taxa: 90% dos quadros chegando ao envio nunca desliga a cópia", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        feed(fake, [[100, 90]]);
        await clock.tickAsync(60_000);
        assert.deepEqual(reasons, []);
        copy.stop();
    });

    test("vigia da taxa: tela parada (poucos quadros na janela, nenhum no envio) nunca desliga a cópia", async t => {
        const clock = useFakeClock(t);
        const fake = fakeCopyEnv();
        // a captura parada: a faixa nao entrega nada (o vigia do fluxo nao tem o que julgar); so o quadro de 1 s passa
        const source = Object.defineProperty(videoTrack(), "stats", { get: () => ({ totalFrames: 0 }) });
        const copy = (await startCaptureCopy(source as unknown as MediaStreamTrack, fake.env))!;
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        feed(fake, [[2, 0]]);
        assert.ok(2 * COPY_RATE_POLLS < COPY_RATE_MIN_FRAMES);
        await clock.tickAsync(60_000);
        assert.deepEqual(reasons, []);
        copy.stop();
    });

    test("vigia da taxa: uma resposta de 2 s a 0% entre boas não desliga (a janela dá 83%)", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        const good: [number, number] = [120, 120];
        feed(fake, [...Array(10).fill(good), [120, 0], ...Array(10).fill(good)]);
        await clock.tickAsync(2000 * 30);
        assert.deepEqual(reasons, []);
        copy.stop();
    });

    test("vigia da taxa: respostas ruins nos primeiros 10 s e depois tudo certo → não desliga", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        // as 4 primeiras respostas (ate 8 s) a 36%, depois 100%: as janelas que ainda pegam o trecho ruim ficam acima de 75%
        const bad: [number, number] = [100, 36];
        feed(fake, [bad, bad, bad, bad, [100, 100]]);
        await clock.tickAsync(2000 * 30);
        assert.deepEqual(reasons, []);
        copy.stop();
    });

    test("vigia da taxa: mudança de tamanho (resized) recomeça a janela e a contagem, sem desligar", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        // 50% sempre; na 8a resposta (16 s) a captura muda de tamanho, justo quando a 2a avaliacao ruim desligaria
        script(fake, n => ({ frames: 120 * n, written: 60 * n, resized: n >= 8 ? 1 : 0, width: 1920, height: 1080 }));
        await clock.tickAsync(16_000);
        assert.deepEqual(reasons, [], "a janela recomeçou na 8ª resposta");
        await clock.tickAsync(11_999);
        assert.deepEqual(reasons, [], "a nova janela só fecha 6 respostas depois da nova base (28 s)");
        await clock.tickAsync(2001);
        assert.equal(reasons.length, 1, "e a 2ª avaliação ruim da nova janela desliga (30 s)");
    });

    test("vigia da taxa: width/height diferentes da resposta anterior também recomeçam a janela", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        script(fake, n => ({ frames: 120 * n, written: 60 * n, width: n >= 8 ? 1280 : 1920, height: n >= 8 ? 720 : 1080 }));
        await clock.tickAsync(29_999);
        assert.deepEqual(reasons, []);
        await clock.tickAsync(2001);
        assert.equal(reasons.length, 1);
        copy.stop();
    });

    test("uma resposta que resolve dois pedidos juntos é julgada uma vez só", async t => {
        const clock = useFakeClock(t);
        const fake = fakeCopyEnv();
        const copy = (await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env))!;
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        let n = 0;
        fake.script = (w, d) => {
            if (d?.op !== "stats") return;
            n++;
            if (n === 2) return; // sem resposta: o pedido fica pendente
            // 1a: a base; 3a: a captura andou COPY_FLOW_MIN_FRAMES sem o gerador aceitar nada, e uma só resposta resolve os pedidos 2 e 3
            const frames = n === 1 ? 10 : 10 + COPY_FLOW_MIN_FRAMES;
            w.emit({ type: "stats", ...zeroStats(), frames, copied: frames, written: 10 });
        };
        await clock.tickAsync(6000);
        assert.equal(n, 3);
        assert.deepEqual(reasons, [], "julgada duas vezes seriam COPY_FLOW_POLLS seguidas e desligaria");
        assert.equal(copy.outputFlat(), true, "mas contou uma vez");
        copy.stop();
    });

    test("vigia da taxa: contador que volta (Worker novo) recomeça a janela, que só fecha 6 respostas depois da nova base", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        let n = 0;
        fake.script = (w, d) => {
            if (d?.op !== "stats") return;
            n++;
            // 7 respostas boas, os contadores voltam a zero e passam a aceitar só 50%
            const [frames, written] = n <= 7 ? [1000 * n, 1000 * n] : [120 * (n - 7), 60 * (n - 7)];
            w.emit({ type: "stats", ...zeroStats(), frames, copied: frames, written });
        };
        // a nova base e a 8a resposta (16 s): a janela fecha na 14a (28 s) e a 2a avaliacao ruim e a 15a (30 s)
        await clock.tickAsync(29_999);
        assert.deepEqual(reasons, []);
        await clock.tickAsync(2001);
        assert.equal(reasons.length, 1);
        assert.match(reasons[0], /entrega só 50% dos quadros ao envio \(360 de 720 em 12 s\)/);
    });

    test("vigia da taxa: stop() antes de a janela fechar → nada", async t => {
        const { clock, fake, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        feed(fake, [[120, 30]]);
        await clock.tickAsync(2000 * COPY_RATE_POLLS);
        copy.stop();
        await clock.tickAsync(30_000);
        assert.deepEqual(reasons, []);
    });

    test("linha de custo: o máximo de escrita é o da janela (um pico de uma janela anterior não volta)", async t => {
        const { clock, fake, copy } = await live(t);
        const since = logMark();
        // cada resposta traz o writeMax da sua janela de 2 s: um pico de 80 ms na 5a, o resto 4 ms
        script(fake, n => ({ frames: 100 * n, written: 100 * n, writeMs: 200 * n, writeN: 100 * n, writeMax: n === 5 ? 80 : 4 }));
        await clock.tickAsync(COPY_LOG_MS + 2000);
        const first = since();
        assert.equal(first.length, 1);
        assert.match(first[0], /escrita no gerador 2,00 ms \(máx\. 80\)/, "o pico entra na linha da janela em que aconteceu");
        await clock.tickAsync(COPY_LOG_MS);
        const second = since();
        assert.equal(second.length, 2);
        assert.match(second[1], /escrita no gerador 2,00 ms \(máx\. 4,00\)/, "a linha seguinte não herda o pico");
        copy.stop();
    });

    test("a leitura da captura falha no Worker com a captura no ar: onFail; o fim normal (captura parou) não", async t => {
        const { clock, fake, source, copy } = await live(t);
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        source.stop();
        fake.worker.emit({ type: "ended", error: "AbortError: x" });
        assert.deepEqual(reasons, []);
        copy.stop();

        const b = await live(t, clock);
        const r2: string[] = [];
        b.copy.onFail(r => r2.push(r));
        b.fake.worker.emit({ type: "ended", error: "TypeError: y" });
        assert.deepEqual(r2, ["a leitura da captura falhou: TypeError: y"]);
    });

    test("avisos e informações do Worker vão para o log", async t => {
        const { fake, copy } = await live(t);
        const since = logMark();
        fake.worker.emit({ type: "warn", message: "WebGPU perdeu a placa de vídeo (TDR): a cópia continua pelo canvas 2D" });
        fake.worker.emit({ type: "info", message: "o canvas 2D está lento" });
        assert.deepEqual(since(), ["warn: Captura pela placa: WebGPU perdeu a placa de vídeo (TDR): a cópia continua pelo canvas 2D", "info: Captura pela placa: o canvas 2D está lento"]);
        copy.stop();
    });
});

describe("cópia na hora: linha de custo", () => {
    test("sem quadros: nada; canvas 2D sem tempo da placa; quadros sem cópia aparecem", () => {
        const base = zeroStats("canvas2d");
        assert.equal(copyStatsLine(base, base, 30), null);
        assert.equal(copyStatsLine(base, { ...base, frames: 60, copied: 50, copyMs: 5, passed: 10 }, 1),
            "Cópia na hora (canvas 2D): 60 quadros em 1 s · 0,10 ms/quadro no Worker · nenhum descartado · 10 sem cópia");
        assert.equal(copyStatsLine(null, { ...zeroStats("passthrough"), frames: 5, passed: 5 }, 1),
            "Cópia na hora (desligada, direto): 5 quadros em 1 s · ? ms/quadro no Worker · nenhum descartado · 5 sem cópia");
    });

    test("escrita no gerador: o trecho só aparece quando writeN cresceu na janela; média da janela, máximo da janela", () => {
        const base = zeroStats("canvas2d");
        // sem escritas novas: nada (mesmo com o acumulado de antes)
        const before = { ...base, frames: 60, copied: 60, copyMs: 6, writeMs: 100, writeN: 50, writeMax: 40, writeSlow: 5 };
        assert.equal(copyStatsLine(before, { ...before, frames: 120, copied: 120, copyMs: 12 }, 1),
            "Cópia na hora (canvas 2D): 60 quadros em 1 s · 0,10 ms/quadro no Worker · nenhum descartado");
        // com escritas novas e nenhuma lenta: sem o ", Z acima…"
        assert.equal(copyStatsLine(base, { ...base, frames: 60, copied: 60, copyMs: 6, writeMs: 120, writeN: 60, writeMax: 4 }, 1),
            "Cópia na hora (canvas 2D): 60 quadros em 1 s · 0,10 ms/quadro no Worker · escrita no gerador 2,00 ms (máx. 4,00) · nenhum descartado");
        // com lentas na janela: a média e as lentas são da janela, o máximo é o da resposta (ou o passado: o maior de várias respostas)
        assert.equal(copyStatsLine(before, { ...before, frames: 120, copied: 120, copyMs: 12, writeMs: 100 + 1800, writeN: 50 + 60, writeMax: 55, writeSlow: 5 + 31 }, 2),
            "Cópia na hora (canvas 2D): 60 quadros em 2 s · 0,10 ms/quadro no Worker · escrita no gerador 30 ms (máx. 55, 31 acima de 16,7 ms) · nenhum descartado");
        assert.equal(copyStatsLine(before, { ...before, frames: 120, copied: 120, copyMs: 12, writeMs: 100 + 1800, writeN: 50 + 60, writeMax: 55, writeSlow: 5 + 31 }, 2, 90),
            "Cópia na hora (canvas 2D): 60 quadros em 2 s · 0,10 ms/quadro no Worker · escrita no gerador 30 ms (máx. 90, 31 acima de 16,7 ms) · nenhum descartado");
    });

    test("diagnóstico: nada antes da primeira transmissão", () => {
        assert.equal(captureCopyDiagnostics(), null);
    });
});

describe("cópia na hora: bordas", () => {
    test("um Worker que lança em tudo depois de ligar nunca derruba quem chama", async t => {
        const clock = useFakeClock(t);
        const fake = fakeCopyEnv();
        const copy = (await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env))!;
        const w = fake.worker;
        w.postMessage = () => { throw new Error("morto"); };
        w.terminate = () => { throw new Error("morto"); };
        fake.generators[0].stop = () => { throw new Error("morto"); };
        copy.refresh();
        assert.equal(await copy.stats(), null);
        copy.stop();
        assert.equal(await copy.stats(), null, "parado: a última leitura (nenhuma)");
        await clock.tickAsync(1500);
    });

    test("sem quadro de 1 s se a RTCPeerConnection recusar a faixa: um aviso, a cópia liga", async () => {
        const fake = fakeCopyEnv();
        const since = logMark();
        const env = { ...fake.env, RTCPeerConnection: class { addTrack() { throw new Error("InvalidStateError: x"); } close() { } } as never };
        const copy = await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, env);
        assert.ok(copy);
        assert.ok(since().includes("warn: Captura pela placa: sem o quadro de 1 s numa tela parada (Error: InvalidStateError: x)"));
        copy.stop();
    });

    test("textos padrão: init falhou sem motivo, erro do Worker sem mensagem", async () => {
        const a = fakeCopyEnv();
        a.script = (w, d) => { if (d?.op === "init") w.emit({ type: "failed" }); };
        const since = logMark();
        assert.equal(await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, a.env), null);
        assert.match(since()[0], /indisponível \(falhou\)/);

        const b = fakeCopyEnv({ hello: false });
        const pending = startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, b.env);
        await flush();
        b.worker.fail("");
        assert.equal(await pending, null);
        assert.match(captureCopyDiagnostics()!, /o Worker não carregou \(CSP\?\)/);

        const c = fakeCopyEnv();
        const copy = (await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, c.env))!;
        const reasons: string[] = [];
        copy.onFail(r => reasons.push(r));
        c.worker.emit(null);
        c.worker.emit({ type: "ended" });
        c.worker.fail("");
        assert.deepEqual(reasons, ["o Worker caiu: erro"]);
        assert.equal(captureCopyDiagnostics(), "cópia na hora: WebGPU (nvidia ampere), parou: o Worker caiu: erro");
    });

    test("diagnóstico com contadores zerados e sem placa; linha com método desconhecido", async () => {
        const fake = fakeCopyEnv({ method: "canvas2d", adapter: null });
        const copy = (await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack, fake.env))!;
        await copy.stats();
        assert.equal(captureCopyDiagnostics(), "cópia na hora: canvas 2D; desde o início: nenhum quadro");
        copy.stop();
        assert.equal(copyStatsLine(null, { ...zeroStats(null), frames: 10, copied: 10, copyMs: 1, gpuMs: 10, gpuN: 10, gpuMax: 2 }, 1),
            "Cópia na hora (?): 10 quadros em 1 s · 0,10 ms/quadro no Worker · placa termina a cópia em 1,00 ms (máx. 2,00) · nenhum descartado");
    });

    test("sem navegador falso: no Node não há Worker", async () => {
        resetCaptureCopyForTests();
        assert.equal(await startCaptureCopy(videoTrack() as unknown as MediaStreamTrack), null);
        assert.equal(captureCopyDiagnostics(), "cópia na hora: indisponível na última transmissão (sem Worker)");
    });
});
