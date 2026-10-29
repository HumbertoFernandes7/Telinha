/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes das partes PURAS da qualidade automatica (core/quality/levels.ts): a carencia de banda do espectador novo e a
// reducao de resolucao em tamanho par (H.264 na placa de video).
// O controller em si nao e testado aqui: controller.ts importa core/log -> store -> @webpack/common (Vencord), que nao carrega
// no Node. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/quality.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { h264HwAcceptsSize } from "@plugins/telinha/core/codec";

import { BW_GRACE_MS, encodingFor, evenScale, inBandwidthGrace, LEVELS, pixelRate, scaledSide, scaledSize } from "./levels";

describe("carencia de banda do espectador novo", () => {
    test("sao 20 s", () => {
        assert.equal(BW_GRACE_MS, 20_000);
    });

    test("antes de ficar pronto (readyAt = Infinity): em carencia", () => {
        assert.equal(inBandwidthGrace(Infinity, 0), true);
        assert.equal(inBandwidthGrace(Infinity, 1_000_000), true);
    });

    test("relogio antes do readyAt: em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 4_000), true);
    });

    test("no instante em que fica pronto (0 s): em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000), true);
    });

    test("aos 10 s (a queda de banda vista nos logs): em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 15_000), true);
    });

    test("aos 19,9 s: em carencia", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000 + 19_900), true);
    });

    test("aos 20 s: acabou", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000 + 20_000), false);
    });

    test("depois dos 20 s: acabou", () => {
        assert.equal(inBandwidthGrace(5_000, 5_000 + 20_001), false);
        assert.equal(inBandwidthGrace(5_000, 5_000 + 120_000), false);
    });

    test("avaliacoes de ~2 s: as janelas ate 18 s ficam na carencia, a de 20 s em diante ja conta", () => {
        const readyAt = 1_234;
        const inGrace: boolean[] = [];
        for (let t = 2_000; t <= 22_000; t += 2_000) inGrace.push(inBandwidthGrace(readyAt, readyAt + t));
        assert.deepEqual(inGrace, [true, true, true, true, true, true, true, true, true, false, false]);
    });
});

// Medido em 29/10/2026 no Electron 44.9.3 (Chromium 152), RTX 3070, H.264 42001f: tamanho que o encoder recebeu
// (outbound-rtp frameWidth/frameHeight) com cada scaleResolutionDownBy. Janelas capturadas como o Telinha captura; as
// de 1920x1080 sao do teste anterior (canvas).
const MEASURED: [width: number, height: number, scale: number, sentWidth: number, sentHeight: number][] = [
    [1798, 1080, 1.5, 1199, 720],
    [1798, 1080, 1.501, 1198, 720],
    [1904, 1040, 1.501, 1268, 693],
    [1904, 1040, 1.445, 1318, 720],
    [1920, 1080, 2.25, 853, 480],
    [1920, 1080, 1.69, 1136, 639],
    [1920, 1080, 2.4, 800, 450],
    [1920, 1080, 2.5, 768, 432]
];

describe("tamanho que o WebRTC codifica com scaleResolutionDownBy", () => {
    test("arredonda para o inteiro mais proximo (bate com o medido)", () => {
        for (const [w, h, s, sw, sh] of MEASURED)
            assert.deepEqual(scaledSize(w, h, s), { width: sw, height: sh }, `${w}x${h} ÷${s}`);
    });

    test("escala 1 (ou menor) nao muda nada", () => {
        assert.equal(scaledSide(1001, 1), 1001);
        assert.equal(scaledSide(1080, 0.5), 1080);
    });
});

describe("reducao de resolucao em tamanho par (evenScale / encodingFor)", () => {
    test("1798x1080 no 720p: ÷1,5 dava 1199x720 (OpenH264, medido); sai ÷1,501 = 1198x720 (placa, medido)", () => {
        assert.equal(evenScale(1798, 1080, 720), 1.501);
        assert.deepEqual(scaledSize(1798, 1080, 1.501), { width: 1198, height: 720 });
        assert.equal(encodingFor("720p60", 1798, 1080).scaleResolutionDownBy, 1.501);
    });

    test("janela redimensionada para 1904x1040: a escala nova da par (medido 1318x720 na placa)", () => {
        assert.equal(evenScale(1904, 1040, 720), 1.445);
        assert.deepEqual(scaledSize(1904, 1040, 1.445), { width: 1318, height: 720 });
    });

    test("quando a escala simples ja da par, continua a mesma de antes", () => {
        assert.equal(evenScale(1920, 1080, 720), 1.5);
        assert.equal(evenScale(1366, 768, 720), 1.067);
        assert.equal(evenScale(1500, 1000, 720), 1.389);
        assert.equal(evenScale(1200, 800, 720), 1.111);
    });

    test("so desce um pouco a altura quando nao ha largura par em 720 (1280x1078 → 854x720)", () => {
        const s = evenScale(1280, 1078, 720);
        assert.deepEqual(scaledSize(1280, 1078, s), { width: 854, height: 720 });
    });

    test("sem reducao ate 2% acima do degrau, e nada muda nos degraus de 1080p", () => {
        assert.equal(encodingFor("720p60", 1306, 734).scaleResolutionDownBy, 1);
        assert.equal(encodingFor("720p30", 1280, 720).scaleResolutionDownBy, 1);
        assert.equal(encodingFor("1080p60", 1798, 1080).scaleResolutionDownBy, 1);
        assert.equal(encodingFor("1080p30", 1920, 1080).scaleResolutionDownBy, 1);
    });

    test("bitrate e fps continuam os do degrau", () => {
        for (const level of ["1080p60", "720p60", "1080p30", "720p30"] as const) {
            const e = encodingFor(level, 1798, 1080);
            assert.equal(e.maxBitrate, LEVELS[level].maxKbps * 1000);
            assert.equal(e.maxFramerate, LEVELS[level].fps);
        }
    });

    test("toda captura par de 360-1920 x 736-1080 no 720p sai par, a partir de 360p (a placa aceita), quase no mesmo tamanho", () => {
        let changed = 0;
        for (let h = 736; h <= 1080; h += 2) {
            for (let w = 360; w <= 1920; w += 2) {
                const s = encodingFor("720p60", w, h).scaleResolutionDownBy;
                const out = scaledSize(w, h, s);
                const plain = Math.round((h / 720) * 1000) / 1000;
                if (s !== plain) changed++;
                if (!h264HwAcceptsSize(out.width, out.height) || out.height < 704 || out.height > 720)
                    assert.fail(`${w}x${h} ÷${s} = ${out.width}x${out.height}`);
                // proporcao e escala: no maximo 1% diferentes da escala simples
                if (Math.abs(out.width / out.height - w / h) / (w / h) > 0.01 || Math.abs(s - plain) / plain > 0.01)
                    assert.fail(`${w}x${h} ÷${s} (simples ÷${plain}) = ${out.width}x${out.height}`);
            }
        }
        // a escala simples dava impar em ~metade desses tamanhos
        assert.ok(changed > 60_000, `${changed} escalas ajustadas`);
    });

    test("pixelRate usa a escala par", () => {
        assert.equal(pixelRate("720p60", 1798, 1080), (1798 / 1.501) * (1080 / 1.501) * 60);
        assert.equal(pixelRate("1080p60", 1920, 1080), 1920 * 1080 * 60);
    });
});
