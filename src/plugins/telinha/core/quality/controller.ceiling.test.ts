/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts) com cada qualidade escolhida como teto: as 6 combinacoes de
// resolucao x fps, com conteudo em movimento e parado, descendo ate o piso pelo processador e subindo de volta ate o teto;
// e o 2K numa captura de 1080p ou menos (nao amplia: o teto vira o 1080p e os degraus 2K somem), inclusive com a janela
// mudando de tamanho no meio. Encoders por software (EncoderSim, libvpx) e o relogio falso (test/helpers/wpb-quality.ts).
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.ceiling.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { Quality, QualityLevel } from "@plugins/telinha/types";
import { useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { logsDuring, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

/** O encoder entrega 20 fps com o processador ocupado: abaixo de 80% ate num degrau de 30 fps (falta CPU sempre). */
const SLOW = { fps: 20, encodeBusy: 0.8 } as const;
const OK = { fps: 60, encodeBusy: 0.2 } as const;
const STILL = () => 0.1;
const SIZE_1440 = { width: 2560, height: 1440 };
const SIZE_1080 = { width: 1920, height: 1080 };

let rtc: WebRtcEnv;
// 8 threads: orcamento de 4 nucleos codificando (cpuBudget), folga para subir ate o 2K a 60 fps
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

/** As linhas do teto 2K mudando com o tamanho da captura (sem as de estatisticas que saem junto com a troca de degrau). */
const fitLines = (lines: string[]) => lines.filter(l => l.startsWith("2K escolhido"));

/** Os degraus aplicados a um espectador, sem repetir o mesmo seguido. */
const path = (levels: QualityLevel[]) => levels.filter((l, i) => l !== levels[i - 1]);

describe("cada qualidade escolhida como teto, numa captura 2560x1440", () => {
    // o caminho para baixo (CPU sem dar conta) e o de volta (estavel), como em levels.stepDown/stepUp
    const CASES: [ceiling: Quality, motion: QualityLevel[], still: QualityLevel[]][] = [
        ["1440p60", ["1440p60", "1080p60", "720p60", "720p30"], ["1440p60", "1440p30", "1080p30", "720p30"]],
        ["1440p30", ["1440p30", "1080p30", "720p30"], ["1440p30", "1080p30", "720p30"]],
        ["1080p60", ["1080p60", "720p60", "720p30"], ["1080p60", "1080p30", "720p30"]],
        ["1080p30", ["1080p30", "720p30"], ["1080p30", "720p30"]],
        ["720p60", ["720p60", "720p30"], ["720p60", "720p30"]],
        ["720p30", ["720p30"], ["720p30"]]
    ];

    for (const [ceiling, motion, still] of CASES) {
        for (const [what, expected, motionDep] of [["movimento", motion, () => null], ["parado", still, STILL]] as const) {
            test(`teto ${ceiling}, ${what}: desce ${expected.join(" → ")} pelo processador e sobe de volta ate o teto, sem passar dele`, async t => {
                const clock = useFakeClock(t);
                const sim = new EncoderSim(SLOW);
                const h = qualityHarness(clock, { A: sim }, { ceiling, captureSize: () => SIZE_1440, motion: motionDep });
                await h.join("A");
                assert.equal(h.controller.state?.current, ceiling, "comeca no teto");

                await h.runUntil(40_000);
                assert.equal(h.controller.levelFor("A"), "720p30", "no piso");
                if (ceiling !== "720p30") assert.equal(h.controller.state?.reason, "cpu");

                sim.set(OK);
                await h.runUntil(120_000);
                assert.equal(h.controller.levelFor("A"), ceiling, "de volta ao teto");
                assert.equal(h.controller.state?.reason, null);
                assert.deepEqual(path(h.applied.map(a => a.level)), [...expected, ...expected.slice(0, -1).reverse()]);
            });
        }
    }

    test("2K a 60 fps no teto: a decisao e o motivo falam em 1440p", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim(SLOW) }, { ceiling: "1440p60", captureSize: () => SIZE_1440 });
        await h.join("A");
        const lines = await logsDuring(() => h.runUntil(8000));
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1440p 60 fps → 1080p 60 fps para o espectador (CPU: A codificado a 20 de 60 fps); nova subida só após 10 s estável"
        ]);
        assert.equal(h.controller.state?.reasonText, "1080p 60 fps — o processador está sobrecarregado");
    });
});

describe("2K numa captura de 1080p ou menos (nao amplia)", () => {
    test("o teto vira 1080p60: entra nele, sem motivo, e desce direto para 720p60 (nunca um degrau 2K)", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim(SLOW) }, { ceiling: "1440p60", captureSize: () => SIZE_1080 });
        await h.join("A");
        assert.equal(h.lastApplied("A"), "1080p60");
        assert.deepEqual(h.controller.state, { current: "1080p60", reason: null, reasonText: null, viewers: { A: { level: "1080p60", reason: null } } });

        const lines = await logsDuring(() => h.runUntil(40_000));
        assert.deepEqual(path(h.applied.map(a => a.level)), ["1080p60", "720p60", "720p30"]);
        assert.match(qualityLines(lines)[0] ?? "", /^Qualidade automática: 1080p 60 fps → 720p 60 fps para o espectador/);
    });

    test("2K a 30 fps parado numa janela de 1040p: teto 1080p30, depois 720p30", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim(SLOW) }, { ceiling: "1440p30", captureSize: () => ({ width: 1904, height: 1040 }), motion: STILL });
        await h.join("A");
        await h.runUntil(40_000);
        assert.deepEqual(path(h.applied.map(a => a.level)), ["1080p30", "720p30"]);
    });

    test("qualidade automatica desligada: todos recebem o 1080p no fps escolhido, e o log diz o teto de verdade", async t => {
        const clock = useFakeClock(t);
        let enabled = false;
        const h = qualityHarness(clock, { A: new EncoderSim() }, { ceiling: "1440p60", captureSize: () => SIZE_1080, enabled: () => enabled });
        await h.join("A");
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.equal(h.controller.state, null);

        enabled = true;
        const lines = await logsDuring(() => h.controller.settingChanged());
        assert.deepEqual(lines.filter(l => l.startsWith("Qualidade automática")), ["Qualidade automática ligada (teto 1080p 60 fps)"]);
    });

    test("tamanho da captura desconhecido (0x0): o 2K fica como teto", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim() }, { ceiling: "1440p60", captureSize: () => ({ width: 0, height: 0 }) });
        await h.join("A");
        await h.runUntil(10_000);
        assert.equal(h.controller.levelFor("A"), "1440p60");
    });
});

describe("2K com a janela mudando de tamanho no meio", () => {
    test("cresce para 1440p: o teto volta a ser 2K e quem estava nele sobe junto; encolhe: volta para 1080p, uma linha no log cada vez", async t => {
        const clock = useFakeClock(t);
        let size = SIZE_1080;
        const h = qualityHarness(clock, { A: new EncoderSim(OK) }, { ceiling: "1440p60", captureSize: () => size });
        await h.join("A");
        await h.runUntil(10_000);
        assert.equal(h.lastApplied("A"), "1080p60");
        const { changes } = h;

        size = SIZE_1440;
        const grew = await logsDuring(async () => {
            h.controller.captureResized();
            await Promise.resolve();
        });
        assert.deepEqual(fitLines(grew), ["2K escolhido, a captura agora tem 1440p: teto de volta em 1440p 60 fps"]);
        assert.equal(h.lastApplied("A"), "1440p60");
        assert.deepEqual(h.controller.state, { current: "1440p60", reason: null, reasonText: null, viewers: { A: { level: "1440p60", reason: null } } });
        assert.ok(h.changes > changes, "o estado novo foi publicado");

        // encolhe sem a escala de ninguem mudar (streaming.ts so chama captureResized quando ela muda): a avaliacao percebe
        size = SIZE_1080;
        const shrank = await logsDuring(() => h.runUntil(12_000));
        assert.deepEqual(fitLines(shrank), ["2K escolhido, a captura agora tem 1080p: enviando 1080p (teto 1080p 60 fps)"]);
        assert.equal(h.lastApplied("A"), "1080p60");

        // sem mudar de novo, nenhuma linha a mais
        assert.deepEqual(fitLines(await logsDuring(() => h.runUntil(30_000))), []);
    });

    test("quem ja estava abaixo do teto fica onde esta (com o motivo) e depois sobe ate o 2K", async t => {
        const clock = useFakeClock(t);
        let size = SIZE_1080;
        const sim = new EncoderSim(SLOW);
        const h = qualityHarness(clock, { A: sim }, { ceiling: "1440p60", captureSize: () => size });
        await h.join("A");
        await h.runUntil(8000);
        assert.equal(h.controller.levelFor("A"), "720p60");

        size = SIZE_1440;
        h.controller.captureResized();
        assert.equal(h.controller.levelFor("A"), "720p60", "continua no degrau baixo");
        assert.equal(h.controller.state?.reason, "cpu");

        sim.set(OK);
        await h.runUntil(60_000);
        assert.deepEqual(path(h.applied.map(a => a.level)), ["1080p60", "720p60", "1080p60", "1440p60"]);
        assert.equal(h.controller.state?.reason, null);
    });

    test("encolhe com o degrau de todos em 2K a 30 fps (parado, CPU): vira 1080p30, ainda abaixo do teto 1080p60", async t => {
        const clock = useFakeClock(t);
        let size = SIZE_1440;
        const sim = new EncoderSim(SLOW);
        const h = qualityHarness(clock, { A: sim }, { ceiling: "1440p60", captureSize: () => size, motion: STILL });
        await h.join("A");
        await h.runUntil(8000);
        assert.equal(h.controller.levelFor("A"), "1440p30");

        sim.set(OK);
        size = SIZE_1080;
        h.controller.captureResized();
        assert.equal(h.controller.levelFor("A"), "1080p30");
        assert.equal(h.controller.state?.reason, "cpu", "ainda abaixo do teto (1080p60) pelo processador");
    });

    test("encolhe com todos no teto 2K: o degrau de todos vira o teto novo, sem motivo", async t => {
        const clock = useFakeClock(t);
        let size = SIZE_1440;
        const sim = new EncoderSim(SLOW);
        const h = qualityHarness(clock, { A: sim }, { ceiling: "1440p60", captureSize: () => size });
        await h.join("A");
        await h.runUntil(8000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "desceu do 2K pelo processador");
        assert.equal(h.controller.state?.reason, "cpu");

        // a captura encolhe para 1080p: o teto agora e 1080p60, o mesmo degrau, entao nao esta mais "abaixo"
        size = SIZE_1080;
        h.controller.captureResized();
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.equal(h.controller.state?.reason, null);
    });
});
