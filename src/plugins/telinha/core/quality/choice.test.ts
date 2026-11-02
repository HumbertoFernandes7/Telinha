/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade escolhida (core/quality/choice.ts): resolucao x fps, os nomes dos seletores, as opcoes padrao, a
// migracao pura da opcao antiga "Qualidade padrão" e o aviso de 2K numa captura menor. A gravacao da migracao nas
// configuracoes esta em settings.test.ts; o 2K de ponta a ponta, em streaming.test.ts e controller.ceiling.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/choice.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    DEFAULT_FPS, DEFAULT_RESOLUTION, FRAME_RATES, HINT_2K, isFrameRate, isQuality, isResolution, migrateQualitySetting, QUALITIES, qualityFromSettings, qualityLabel, qualityOf,
    RESOLUTION_LABEL, RESOLUTION_WIDTH, RESOLUTIONS, sourceSizeNote, splitQuality
} from "./choice";
import { LEVELS } from "./levels";

describe("resolucao x fps", () => {
    test("as 6 combinacoes, todas escolhiveis (720p30 tambem), com o degrau de cada uma; o padrao e 1080p a 60 fps", () => {
        assert.deepEqual(RESOLUTIONS, [720, 1080, 1440]);
        assert.deepEqual(FRAME_RATES, [30, 60]);
        assert.deepEqual(QUALITIES, ["720p30", "720p60", "1080p30", "1080p60", "1440p30", "1440p60"]);
        assert.equal(qualityOf(DEFAULT_RESOLUTION, DEFAULT_FPS), "1080p60");
        for (const q of QUALITIES) {
            const { resolution, fps } = splitQuality(q);
            assert.equal(qualityOf(resolution, fps), q);
            assert.deepEqual([LEVELS[q].height, LEVELS[q].fps], [resolution, fps], `${q}: o degrau tem a mesma altura e fps`);
        }
        assert.deepEqual(Object.keys(LEVELS).sort(), [...QUALITIES].sort(), "um degrau por combinacao, nem mais nem menos");
    });

    test("nomes: 720p · 1080p · 2K; largura 16:9 de cada uma; o texto curto da qualidade", () => {
        assert.deepEqual(RESOLUTION_LABEL, { 720: "720p", 1080: "1080p", 1440: "2K" });
        assert.deepEqual(RESOLUTION_WIDTH, { 720: 1280, 1080: 1920, 1440: 2560 });
        for (const r of RESOLUTIONS) assert.equal(RESOLUTION_WIDTH[r] * 9, r * 16, `${r}p e 16:9`);
        assert.equal(qualityLabel("1440p60"), "2K · 60 fps");
        assert.equal(qualityLabel("1080p30"), "1080p · 30 fps");
        assert.equal(qualityLabel("720p30"), "720p · 30 fps");
        assert.equal(HINT_2K, "2K (1440p) precisa de uma tela 2K: numa tela ou janela menor, vai no tamanho dela.");
    });

    test("so os valores conhecidos passam (texto, outro numero ou outro tipo nao)", () => {
        for (const r of [720, 1080, 1440]) assert.equal(isResolution(r), true);
        for (const r of [480, 2160, "1080", "2K", null, undefined]) assert.equal(isResolution(r), false, String(r));
        for (const f of [30, 60]) assert.equal(isFrameRate(f), true);
        for (const f of [24, 120, "60", null]) assert.equal(isFrameRate(f), false, String(f));
        for (const q of QUALITIES) assert.equal(isQuality(q), true);
        for (const q of ["4k", "1080p", "1080p120", "constructor", "toString", 1080, null, undefined]) assert.equal(isQuality(q), false, String(q));
    });

    test("opcoes padrao: cada valor invalido cai para o seu padrao (1080p, 60) sem mexer no outro", () => {
        assert.equal(qualityFromSettings(1440, 30), "1440p30");
        assert.equal(qualityFromSettings(720, 30), "720p30");
        assert.equal(qualityFromSettings(undefined, undefined), "1080p60");
        assert.equal(qualityFromSettings(2160, 30), "1080p30");
        assert.equal(qualityFromSettings(1440, 144), "1440p60");
        assert.equal(qualityFromSettings("1440", "30"), "1080p60");
    });
});

describe("migracao pura de 'Qualidade padrão'", () => {
    test("as 3 escolhas antigas viram o par delas e a chave antiga sai", () => {
        assert.deepEqual(migrateQualitySetting({ defaultQuality: "1080p60" }), { resolution: 1080, fps: 60, dropOld: true });
        assert.deepEqual(migrateQualitySetting({ defaultQuality: "720p60" }), { resolution: 720, fps: 60, dropOld: true });
        assert.deepEqual(migrateQualitySetting({ defaultQuality: "1080p30" }), { resolution: 1080, fps: 30, dropOld: true });
    });

    test("valor antigo desconhecido: nada a gravar (valem os padroes), a chave antiga sai mesmo assim", () => {
        for (const old of ["4k", "1080p", 60, null, undefined, {}]) assert.deepEqual(migrateQualitySetting({ defaultQuality: old }), { resolution: null, fps: null, dropOld: true }, String(old));
    });

    test("escolha nova ja gravada vence, uma de cada vez; a invalida nao conta", () => {
        assert.deepEqual(migrateQualitySetting({ defaultQuality: "720p60", defaultResolution: 1440, defaultFps: 30 }), { resolution: null, fps: null, dropOld: true });
        assert.deepEqual(migrateQualitySetting({ defaultQuality: "720p60", defaultResolution: 1440 }), { resolution: null, fps: 60, dropOld: true });
        assert.deepEqual(migrateQualitySetting({ defaultQuality: "1080p30", defaultFps: 60 }), { resolution: 1080, fps: null, dropOld: true });
        assert.deepEqual(migrateQualitySetting({ defaultQuality: "1080p30", defaultResolution: "2K", defaultFps: 24 }), { resolution: 1080, fps: 30, dropOld: true });
    });

    test("sem a opcao antiga: nada a fazer", () => {
        assert.deepEqual(migrateQualitySetting({}), { resolution: null, fps: null, dropOld: false });
        assert.deepEqual(migrateQualitySetting({ defaultResolution: 720 }), { resolution: null, fps: null, dropOld: false });
        assert.deepEqual(migrateQualitySetting(null), { resolution: null, fps: null, dropOld: false });
        assert.deepEqual(migrateQualitySetting(undefined), { resolution: null, fps: null, dropOld: false });
    });
});

describe("aviso de 2K numa captura menor", () => {
    test("2K numa tela ou janela de 1080p ou menos: diz o tamanho que vai", () => {
        assert.equal(sourceSizeNote("1440p60", "screen", 1080), "2K escolhido, a tela tem 1080p: enviando 1080p");
        assert.equal(sourceSizeNote("1440p30", "window", 1040), "2K escolhido, a janela tem 1040p: enviando 1040p");
        assert.equal(sourceSizeNote("1440p60", "window", 719.6), "2K escolhido, a janela tem 720p: enviando 720p");
    });

    test("tela mais larga que 16:9 (3440x1440): a captura sai limitada pela largura, e o texto diz o tamanho dela (nao 'a tela tem 1072p')", () => {
        assert.equal(sourceSizeNote("1440p60", "screen", 1072, 2560), "2K escolhido, a captura tem 2560x1072: enviando 1072p");
        assert.equal(sourceSizeNote("1440p30", "window", 1080, 2560), "2K escolhido, a captura tem 2560x1080: enviando 1080p");
        // o caso real de antes: uma tela de 1080p (largura 1920, abaixo da do 2K) ou largura desconhecida
        assert.equal(sourceSizeNote("1440p60", "screen", 1080, 1920), "2K escolhido, a tela tem 1080p: enviando 1080p");
        assert.equal(sourceSizeNote("1440p60", "window", 1040, 1904), "2K escolhido, a janela tem 1040p: enviando 1040p");
        assert.equal(sourceSizeNote("1440p60", "screen", 1080, 0), "2K escolhido, a tela tem 1080p: enviando 1080p");
        // uma captura que comporta o 2K continua sem aviso, qualquer que seja a largura
        assert.equal(sourceSizeNote("1440p60", "screen", 1440, 2560), null);
    });

    test("sem aviso: a captura comporta o 2K (ou fica entre 1080p e 1440p), outra resolucao, ou tamanho desconhecido", () => {
        assert.equal(sourceSizeNote("1440p60", "screen", 1440), null);
        assert.equal(sourceSizeNote("1440p60", "window", 1200), null, "entre 1080p e 1440p: vai em 1200p, mais que o 1080p");
        assert.equal(sourceSizeNote("1080p60", "window", 720), null);
        assert.equal(sourceSizeNote("720p30", "screen", 480), null);
        assert.equal(sourceSizeNote("1440p60", "screen", 0), null);
    });
});
