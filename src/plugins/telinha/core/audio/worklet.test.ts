/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes de comportamento do AudioWorkletProcessor (core/audio/worklet.ts): o PCM_PLAYER_SOURCE roda num node:vm
// com AudioWorkletProcessor/registerProcessor/sampleRate/currentFrame falsos (test/helpers/wpd-worklet.ts) e o teste
// chama process() de 128 em 128 frames, como o motor de audio. Cobre o buffer circular, o jitter buffer (priming,
// underrun, alvo que sobe), a correcao de deriva do relogio e o descarte do excesso. O V8 mapeia a cobertura deste
// codigo para o script do vm, nao para as linhas do worklet.ts: aqui o que vale e o comportamento.
// Rodar:  pnpm test:file src/plugins/telinha/core/audio/worklet.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadPlayer, playQuanta, QUANTUM } from "@test/helpers/wpd-worklet";

import { PCM_PLAYER_PROCESSOR, PCM_PLAYER_SOURCE } from "./worklet";

const RATE = 48000;
const ms = (n: number, rate = RATE) => Math.round(rate * n / 1000);

describe("worklet: fonte e registro", () => {
    test("registra o processador com o nome que o screenAudio.ts usa", () => {
        const player = loadPlayer();
        assert.equal(PCM_PLAYER_PROCESSOR, "telinha-pcm-player");
        assert.equal(player.registeredName, PCM_PLAYER_PROCESSOR);
    });

    test("a fonte e so ASCII (vai por data: URL com btoa quando o blob: e recusado)", () => {
        assert.match(PCM_PLAYER_SOURCE, /^[\x00-\x7f]*$/);
        assert.doesNotThrow(() => btoa(PCM_PLAYER_SOURCE));
        assert.equal(atob(btoa(PCM_PLAYER_SOURCE)), PCM_PLAYER_SOURCE);
    });

    test("padroes: alvo 80 ms, teto 200 ms, passo 20 ms, descarte acima de alvo + 300 ms", () => {
        const { node } = loadPlayer({ options: {} });
        assert.equal(node.target, ms(80));
        assert.equal(node.maxTarget, ms(200));
        assert.equal(node.step, ms(20));
        assert.equal(node.excess, ms(300));
        assert.equal(node.priming, true);
        assert.equal(node.count, 0);
        assert.equal(node.underruns, 0);
        assert.equal(node.alive, true);
    });

    test("sem processorOptions nenhum tambem usa os padroes", () => {
        const { node } = loadPlayer({ noOptions: true });
        assert.equal(node.target, ms(80));
        assert.equal(node.maxTarget, ms(200));
        const viaUndefined = loadPlayer({ options: undefined });
        assert.equal(viaUndefined.node.target, ms(80));
    });

    test("targetMs e maxTargetMs sao limitados (20..500 e 40..1000) e valores invalidos viram o padrao", () => {
        const cases: [unknown, unknown, number, number][] = [
            [5, 10, 20, 40],
            [9999, 99999, 500, 1000],
            [120, 150, 120, 150],
            [0, 0, 80, 200],
            ["abc", "abc", 80, 200],
            [Number.NaN, Number.NaN, 80, 200],
            [-30, -30, 20, 40],
            ["100", "250", 100, 250]
        ];
        for (const [targetMs, maxTargetMs, wantTarget, wantMax] of cases) {
            const { node } = loadPlayer({ options: { targetMs, maxTargetMs } });
            assert.equal(node.target, ms(wantTarget), `targetMs ${String(targetMs)}`);
            assert.equal(node.maxTarget, ms(wantMax), `maxTargetMs ${String(maxTargetMs)}`);
        }
    });

    test("os tempos acompanham o sampleRate do AudioContext (44,1 kHz)", () => {
        const { node } = loadPlayer({ sampleRate: 44100, options: { targetMs: 100 } });
        assert.equal(node.target, ms(100, 44100));
        assert.equal(node.step, ms(20, 44100));
    });
});

describe("worklet: jitter buffer", () => {
    test("priming: sem PCM suficiente toca silencio, mantem o que chegou e nao conta underrun", () => {
        const player = loadPlayer();
        player.push(100);
        const out = player.process({ fill: 7 });
        assert.equal(out.alive, true);
        assert.ok(out.left.every(v => v === 0) && out.right!.every(v => v === 0), "os dois canais zerados");
        assert.equal(player.node.count, 100);
        assert.equal(player.node.underruns, 0);
        assert.equal(player.node.priming, true);
    });

    test("com o alvo acumulado (80 ms) comeca a tocar o PCM na ordem, sem alterar as amostras", () => {
        const player = loadPlayer();
        player.push(ms(80));
        const out = player.process();
        assert.equal(player.node.priming, false);
        assert.deepEqual(Array.from(out.left.subarray(0, 4)), [1, 2, 3, 4]);
        assert.deepEqual(Array.from(out.right!.subarray(0, 4)), [-1, -2, -3, -4]);
        assert.equal(out.left[QUANTUM - 1], QUANTUM);
        assert.equal(player.node.ratio, 1, "no alvo exato a velocidade e a normal");
        assert.equal(player.node.count, ms(80) - QUANTUM);
        const next = player.process();
        assert.equal(next.left[0], QUANTUM + 1, "o proximo quantum continua de onde parou");
    });

    test("um pouco abaixo do alvo ainda e priming (o limite e >= alvo)", () => {
        const player = loadPlayer();
        player.push(ms(80) - 1);
        assert.ok(player.process().left.every(v => v === 0));
        player.push(1);
        assert.notEqual(player.process().left[0], 0);
    });

    test("NaN no PCM vira silencio (0) nos dois canais", () => {
        const player = loadPlayer({ options: { targetMs: 20 } });
        const buf = new Float32Array(ms(20) * 2);
        buf.fill(0.5);
        buf[0] = Number.NaN;
        buf[1] = Number.NaN;
        buf[4] = Number.NaN;
        player.send(buf.buffer);
        const out = player.process();
        assert.equal(out.left[0], 0);
        assert.equal(out.right![0], 0);
        assert.equal(out.left[1], 0.5);
        assert.equal(out.left[2], 0, "NaN so no L do frame 2");
        assert.equal(out.right![2], 0.5);
    });

    test("saida mono: so o canal L e preenchido (priming, tocando e underrun)", () => {
        const player = loadPlayer();
        assert.equal(player.process({ channels: 1 }).right, null);
        player.push(ms(80));
        const out = player.process({ channels: 1 });
        assert.equal(out.right, null);
        assert.deepEqual(Array.from(out.left.subarray(0, 3)), [1, 2, 3]);
        for (let i = 0; i < 40 && player.node.underruns === 0; i++) player.process({ channels: 1 });
        assert.equal(player.node.underruns, 1);
    });

    test("sem canais de saida: devolve o estado de vida sem mexer em nada", () => {
        const player = loadPlayer();
        player.push(ms(80));
        const before = player.node.count;
        assert.equal(player.process({ channels: 0 }).alive, true);
        assert.equal(player.node.count, before);
    });

    test("quantum de outro tamanho (480 frames) tambem e atendido", () => {
        const player = loadPlayer();
        player.push(ms(80));
        const out = player.process({ size: 480 });
        assert.equal(out.left.length, 480);
        assert.equal(out.left[479], 480);
    });
});

describe("worklet: underrun", () => {
    test("o buffer seca: silencio, underrun contado, volta ao priming e o alvo sobe 20 ms", () => {
        const player = loadPlayer();
        player.push(ms(80));
        let quanta = 0;
        while (player.node.underruns === 0 && quanta < 100) {
            player.process();
            quanta++;
        }
        assert.equal(player.node.underruns, 1);
        assert.ok(quanta >= 28 && quanta <= 31, `secou depois de ~29 quanta (${quanta})`);
        assert.equal(player.node.priming, true);
        assert.equal(player.node.target, ms(100));

        // o quantum do underrun saiu em silencio
        player.push(ms(100)); // chega o suficiente para o novo alvo: toca de novo
        const resumed = player.process();
        assert.equal(player.node.priming, false);
        assert.notEqual(resumed.left[0], 0);
    });

    test("o quantum que seca sai zerado (nada de resto de memoria)", () => {
        const player = loadPlayer();
        player.push(ms(80));
        for (let i = 0; i < 100; i++) {
            const out = player.process({ fill: 5 });
            if (player.node.underruns) {
                assert.ok(out.left.every(v => v === 0));
                assert.ok(out.right!.every(v => v === 0));
                return;
            }
        }
        assert.fail("o buffer deveria ter secado");
    });

    test("cada underrun sobe o alvo mais 20 ms, ate o teto (200 ms), e la fica", () => {
        const player = loadPlayer();
        const targets: number[] = [player.node.target];
        for (let n = 1; n <= 9; n++) {
            player.push(player.node.target);
            while (player.node.underruns < n) player.process();
            targets.push(player.node.target);
        }
        assert.deepEqual(targets.map(t => Math.round(t * 1000 / RATE)), [80, 100, 120, 140, 160, 180, 200, 200, 200, 200]);
    });

    test("com maxTargetMs menor que o alvo + passo, o teto vale", () => {
        const player = loadPlayer({ options: { targetMs: 60, maxTargetMs: 70 } });
        player.push(player.node.target);
        while (player.node.underruns < 1) player.process();
        assert.equal(player.node.target, ms(70));
    });
});

describe("worklet: excesso (descarte)", () => {
    test("exatamente alvo + 300 ms (18240 frames) ainda cabe; um frame a mais descarta ate o alvo", () => {
        const fits = loadPlayer();
        fits.push(ms(80) + ms(300));
        assert.equal(fits.node.dropped, 0);
        assert.equal(fits.node.count, ms(380));

        const over = loadPlayer();
        over.push(ms(80) + ms(300) + 1);
        assert.equal(over.node.count, ms(80), "ficou so o alvo");
        assert.equal(over.node.dropped, ms(300) + 1);
        assert.equal(over.node.received, ms(380) + 1);
    });

    test("o que sobra e o MAIS NOVO: o proximo som tocado e o do fim do bloco recebido", () => {
        const player = loadPlayer();
        player.push(20_000);
        const out = player.process();
        // 20000 recebidos, ficam os ultimos 3840: o primeiro frame tocado e o de indice 16160 (valor 16161)
        assert.equal(out.left[0], 16_161);
        assert.equal(out.right![0], -16_161);
        assert.equal(player.node.dropped, 20_000 - ms(80));
    });

    test("o descarte zera a media do preenchimento e a velocidade volta a 1", () => {
        const player = loadPlayer();
        player.push(30_000);
        assert.equal(player.node.ema, ms(80));
        player.process();
        assert.equal(player.node.ratio, 1);
    });

    test("bloco maior que o buffer circular (131071 frames): guarda so o fim, sem corromper", () => {
        const player = loadPlayer();
        player.push(140_000);
        assert.equal(player.node.received, 131_071, "so 131071 frames cabem no anel");
        assert.equal(player.node.count, ms(80));
        const out = player.process();
        // ficaram os ultimos 3840 do bloco de 140000: primeiro valor 140000 - 3840 + 1
        assert.equal(out.left[0], 136_161);
        assert.equal(out.left[1], 136_162);
    });

    test("float sobrando no fim do bloco (numero impar de floats) e ignorado", () => {
        const player = loadPlayer();
        const buf = new Float32Array(2 * ms(80) + 1).fill(0.25);
        player.send(buf.buffer);
        assert.equal(player.node.count, ms(80));
    });
});

describe("worklet: fluxo continuo e deriva do relogio", () => {
    /** produtor a `perQuantum` frames por quantum (fracionario: acumula o resto), uma chegada por quantum */
    function run(perQuantum: number, quanta: number, opts: { primeWith?: number; } = {}) {
        const player = loadPlayer();
        let next = 1;
        const feed = (n: number) => {
            if (n <= 0) return;
            player.push(n, next);
            next += n;
        };
        feed(opts.primeWith ?? ms(80));
        let acc = 0;
        const left: number[] = [];
        let maxRatio = 0;
        let minRatio = 2;
        for (let i = 0; i < quanta; i++) {
            acc += perQuantum;
            const n = Math.floor(acc);
            acc -= n;
            feed(n);
            const out = player.process();
            for (const v of out.left) left.push(v);
            maxRatio = Math.max(maxRatio, player.node.ratio);
            minRatio = Math.min(minRatio, player.node.ratio);
        }
        return { player, left, maxRatio, minRatio };
    }

    test("no mesmo ritmo: o som sai continuo (sem saltos) mesmo passando do fim do anel (131072)", () => {
        const { player, left } = run(QUANTUM, 2500); // 320 mil frames: o anel da duas voltas
        assert.equal(player.node.underruns, 0);
        assert.equal(player.node.dropped, 0);
        assert.ok(player.node.w < 131_072);
        let worst = 0;
        for (let i = 1; i < left.length; i++) worst = Math.max(worst, Math.abs(left[i] - left[i - 1] - 1));
        // rampa de 1 por frame; ate ~0,07 de erro de float32 + interpolacao; um salto de anel daria milhares
        assert.ok(worst < 0.1, `maior desvio entre amostras vizinhas: ${worst}`);
        assert.ok(left.at(-1)! > 300_000, "tocou o fluxo inteiro");
    });

    test("produtor 0,23% mais rapido: o worklet le mais rapido (ate +0,4%), sem underrun nem descarte", () => {
        const { player, maxRatio } = run(QUANTUM * 1.0023, 4000);
        assert.equal(player.node.underruns, 0);
        assert.equal(player.node.dropped, 0);
        assert.ok(player.node.ratio > 1.0015 && player.node.ratio <= 1.004, `ratio ${player.node.ratio}`);
        assert.ok(maxRatio <= 1.004 + 1e-12);
        assert.ok(player.node.count > ms(80), "o preenchimento ficou acima do alvo");
    });

    test("produtor 0,23% mais lento: le mais devagar (ate -0,4%), sem underrun", () => {
        const { player, minRatio } = run(QUANTUM * 0.9977, 9000);
        assert.equal(player.node.underruns, 0);
        assert.ok(player.node.ratio < 0.9985 && player.node.ratio >= 0.996, `ratio ${player.node.ratio}`);
        assert.ok(minRatio >= 0.996 - 1e-12);
        assert.ok(player.node.count < ms(80), "o preenchimento ficou abaixo do alvo");
    });

    test("produtor bem mais rapido que a correcao alcanca: velocidade no maximo (1,004) e depois descarta o excesso", () => {
        const { player, maxRatio } = run(QUANTUM * 1.02, 12_000);
        assert.ok(Math.abs(maxRatio - 1.004) < 1e-9, `maxRatio ${maxRatio}`);
        assert.ok(player.node.dropped > 0, "passou de alvo + 300 ms e descartou");
        assert.equal(player.node.underruns, 0);
    });

    test("saida de rampa com a velocidade em 1,004: avanca ~0,4% mais amostras por quantum", () => {
        const { left } = run(QUANTUM * 1.02, 3000);
        // com o ratio no teto, 128 amostras de saida consomem ~128,5 de entrada: incremento medio por amostra ~1,004
        const tail = left.slice(-QUANTUM * 200);
        const mean = (tail.at(-1)! - tail[0]) / (tail.length - 1);
        assert.ok(mean > 1.002 && mean < 1.0045, `incremento medio ${mean}`);
    });
});

describe("worklet: estatisticas e parada", () => {
    test("a cada 2 s de currentFrame (96000 frames) posta { type: 'stats' } para diagnostico", () => {
        const player = loadPlayer();
        player.push(ms(80) + 960); // 4800 frames
        player.frame = 95_999 - QUANTUM + 1;
        player.process();
        assert.equal(player.posted.length, 0, "ainda nao deu 2 s");
        player.frame = 96_000;
        player.process();
        assert.equal(player.posted.length, 1);
        const stats = player.posted[0];
        assert.equal(stats.type, "stats");
        assert.equal(stats.targetMs, 80);
        assert.equal(stats.underruns, 0);
        assert.equal(stats.droppedMs, 0);
        assert.equal(stats.receivedMs, 100);
        assert.equal(typeof stats.fillMs, "number");
        assert.equal(typeof stats.ratio, "number");

        player.frame = 96_000 + 95_999;
        player.process();
        assert.equal(player.posted.length, 1, "a proxima so daqui a mais 2 s");
        player.frame = 192_000;
        player.process();
        assert.equal(player.posted.length, 2);
    });

    test("as estatisticas refletem underruns e descartes (em ms) e o alvo que subiu", () => {
        const player = loadPlayer();
        player.push(20_000); // descarta 16160 frames = 337 ms
        while (player.node.underruns < 1) player.process();
        player.frame = 96_000;
        player.process();
        const stats = player.posted.at(-1)!;
        assert.equal(stats.underruns, 1);
        assert.equal(stats.droppedMs, Math.round(16_160 * 1000 / RATE));
        assert.equal(stats.targetMs, 100);
        assert.equal(stats.receivedMs, Math.round(20_000 * 1000 / RATE));
    });

    test("{ type: 'stop' } encerra: process() devolve false em qualquer estado", () => {
        const priming = loadPlayer();
        priming.send({ type: "stop" });
        assert.equal(priming.process().alive, false, "no priming");

        const playing = loadPlayer();
        playing.push(ms(80));
        assert.equal(playing.process().alive, true);
        playing.send({ type: "stop" });
        assert.equal(playing.process().alive, false, "tocando");

        const dry = loadPlayer();
        dry.push(ms(80));
        while (dry.node.underruns < 1) dry.process();
        dry.send({ type: "stop" });
        assert.equal(dry.process().alive, false, "depois de um underrun");
        assert.equal(dry.node.alive, false);
    });

    test("mensagens que nao sao ArrayBuffer nem stop sao ignoradas", () => {
        const player = loadPlayer();
        for (const data of [null, undefined, "oi", 42, { type: "outra" }, {}, new Float32Array(8), new Uint8Array(8)]) player.send(data);
        assert.equal(player.node.count, 0);
        assert.equal(player.node.alive, true);
        assert.equal(player.process().alive, true);
    });
});

describe("worklet: tocar muitos quanta de uma vez (playQuanta)", () => {
    test("o ajudante junta a saida e conta os quanta em silencio", () => {
        const player = loadPlayer();
        const { silent: beforeData } = playQuanta(player, 3);
        assert.equal(beforeData, 3);
        player.push(ms(80));
        const { left, silent } = playQuanta(player, 2);
        assert.equal(silent, 0);
        assert.equal(left.length, 2 * QUANTUM);
        assert.equal(left[0], 1);
    });
});
