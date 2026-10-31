/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts → trackNet) limitada pela REDE de um espectador, desde a
// 0.2.10: um soluco da internet nao muda o degrau; so problema que dura (perda >= 2%, RTT 60 ms acima da base, fila do
// pacer > 100 ms por 14 s; ou so a banda estimada curta por 30 s, ou por 14 s se ela nunca deu o que o degrau pede).
// Subir: 30 s estavel com folga de 1,5x o piso do degrau de cima; subida desfeita dobra a espera (ate 10 min).
// A rede vem do EncoderSim com `link` (perda, RTT, fila: test/fakes/webrtc.ts), num relogio falso.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.network.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type LinkRates, type WebRtcEnv } from "@test/fakes/webrtc";
import { EVAL_MS, logsDuring, type QualityHarness, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

import { BW_GRACE_MS } from "./levels";

/** A rede boa: sem perda, 30 ms de RTT, 2 ms no pacer. */
const LINK: LinkRates = { targetKbps: 16_000, rtxKbps: 0, lossPct: 0, rttMs: 30, jitterMs: 2, naksPerSecond: 0, plisPerSecond: 0, keyframesPerSecond: 0, qp: 28, pacerMs: 2 };
const GOOD = { availableKbps: 20_000, kbps: 16_000, link: LINK };

let rtc: WebRtcEnv;
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

/** Um espectador "A" pronto em 0 s com a rede `rates`; a rede boa ate `until` (o degrau dele ja deu o que pede). */
async function viewer(t: Parameters<typeof useFakeClock>[0], until = 40_000) {
    const clock = useFakeClock(t);
    const sim = new EncoderSim(GOOD);
    const h = qualityHarness(clock, { A: sim });
    await h.join("A");
    await h.runUntil(until);
    assert.equal(h.controller.levelFor("A"), "1080p60");
    return { h, sim };
}

/** Os degraus que A teve em cada avaliacao de `from` a `to`. */
async function levelsDuring(h: QualityHarness, to: number) {
    const seen: string[] = [];
    for (let at = h.elapsed() + EVAL_MS; at <= to; at += EVAL_MS) {
        await h.evaluateAt(at);
        seen.push(h.controller.levelFor("A"));
    }
    return seen;
}

describe("rede de um espectador: soluco nao muda nada", () => {
    test("soluco de 10 s (perda 5%, RTT 150 ms, fila 180 ms, banda no chao) e o estimador voltando devagar por 16 s: nenhuma troca", async t => {
        const { h, sim } = await viewer(t);
        // o log de 31/10: o receptor via 1080p e, no soluco, a banda caindo para ~1,5 Mbps
        sim.set({ availableKbps: 1500, kbps: 1400, link: { ...LINK, lossPct: 5, rttMs: 150, pacerMs: 180 } });
        const lines = await logsDuring(async () => {
            await h.runUntil(50_000);
            // a rede volta; o estimador (GCC) sobe devagar: abaixo dos 4500 do 1080p60 ate os 66 s
            for (const [at, kbps] of [[50_000, 2000], [54_000, 2600], [58_000, 3200], [62_000, 3800], [66_000, 6000], [70_000, 12_000], [74_000, 20_000]] as const) {
                await h.runUntil(at);
                sim.set({ availableKbps: kbps, kbps: Math.min(kbps * 0.95, 16_000), link: LINK });
            }
            await h.runUntil(180_000);
        });
        assert.deepEqual(qualityLines(lines), [], "nenhuma decisao");
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.deepEqual(h.applied.map(a => a.level), ["1080p60"], "so o apply do comeco");
    });

    test("um recuo do estimador e janelas ruins soltas (uma a cada 6 s) nao somam", async t => {
        const { h, sim } = await viewer(t);
        for (let at = 40_000; at < 100_000; at += 6000) {
            sim.set({ link: { ...LINK, lossPct: 8 } });
            await h.runUntil(at + EVAL_MS);
            sim.set({ link: LINK });
            await h.runUntil(at + 6000);
        }
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("tela parada (o encoder pede pouco): banda estimada abaixo do degrau sem o caminho cheio nao e problema", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ availableKbps: 2000, kbps: 500 });
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(120_000))), []);
    });
});

describe("rede de um espectador: problema que dura desce um degrau", () => {
    test("perda de 4% por 20 s: desce um degrau aos 14 s e so um; volta 30 s depois da ultima janela ruim", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, lossPct: 4 } });
        const before14 = await levelsDuring(h, 52_000);
        assert.ok(before14.every(l => l === "1080p60"), "ate 12 s de perda, nada");
        const down = await logsDuring(() => h.runUntil(54_000));
        assert.deepEqual(qualityLines(down), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: perda de 4,0% há 14 s); nova subida só após 30 s estável"]);
        assert.equal(h.lastApplied("A"), "720p60");

        await h.runUntil(60_000);
        sim.set({ link: LINK });
        await h.runUntil(88_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "estavel ha 28 s");
        const up = await logsDuring(() => h.runUntil(90_000));
        assert.deepEqual(qualityLines(up), ["Qualidade automática: 720p 60 fps → 1080p 60 fps para A (banda: estável há 30 s)"]);
        assert.deepEqual(h.applied.map(a => a.level), ["1080p60", "720p60", "1080p60"]);
    });

    test("RTT 80 ms acima do menor RTT recente por 14 s: desce", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, rttMs: 110 } });
        const lines = await logsDuring(() => h.runUntil(54_000));
        assert.deepEqual(qualityLines(lines), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: RTT de 110 ms (30 ms sem fila) há 14 s); nova subida só após 30 s estável"]);
    });

    test("RTT alto que vira o normal (rota nova): desce enquanto parece fila; 2 min depois ele e a base e volta a subir", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, rttMs: 110 } });
        await h.runUntil(54_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(160_000);
        assert.equal(h.controller.levelFor("A"), "720p30", "ate 2 min depois do ultimo RTT de 30 ms (40 s), 110 ms e fila");
        // depois disso 110 ms e o menor: sem fila, um degrau a cada 30 s estavel
        await h.runUntil(260_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("pacotes esperando 150 ms no pacer por 14 s: desce", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, pacerMs: 150 } });
        const lines = await logsDuring(() => h.runUntil(54_000));
        assert.deepEqual(qualityLines(lines), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: fila de 150 ms no envio há 14 s); nova subida só após 30 s estável"]);
    });

    test("so a banda estimada curta, num degrau em que ela ja deu o que ele pede: desce aos 30 s, nao aos 14", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ availableKbps: 3000, kbps: 2850 });
        await h.runUntil(68_000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "28 s: o estimador ainda pode estar voltando de um soluco");
        const lines = await logsDuring(() => h.runUntil(70_000));
        assert.deepEqual(qualityLines(lines), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 3000 kbps, o degrau pede 4500 há 30 s); nova subida só após 30 s estável"]);
    });

    test("caminho estreito (a estimativa nunca deu o que o degrau pede): depois da carencia, um degrau a cada 14 s", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim({ availableKbps: 1800, kbps: 1700, link: LINK }) });
        await h.join("A");
        await h.runUntil(BW_GRACE_MS + 10_000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "a carencia de 20 s e mais 10 s");
        const first = await logsDuring(() => h.runUntil(32_000));
        assert.deepEqual(qualityLines(first), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 1800 kbps, o degrau pede 4500 há 14 s); nova subida só após 30 s estável"]);
        // 720p60 pede 2500: de novo, contando da 1a janela medida depois dos 4 s de acomodacao (34-36 s)
        await h.runUntil(46_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(48_000);
        assert.equal(h.controller.levelFor("A"), "720p30");
        assert.deepEqual(h.controller.state?.viewers.A, { level: "720p30", reason: "bandwidth" });
        // no piso (720p30 nao pede banda): fica
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(200_000))), []);
    });

    test("pronto de novo (renegociou) nao reinicia a carencia de banda", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim({ availableKbps: 500, kbps: 480 }) });
        await h.join("A");
        await h.runUntil(10_000);
        h.controller.markReady("A");
        await h.runUntil(30_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        await h.runUntil(32_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "a carencia contou desde a 1a vez");
    });
});

describe("rede de um espectador: subir de volta", () => {
    /** A desce por perda aos 54 s (720p60) e a rede volta aos 60 s. */
    async function downByLoss(t: Parameters<typeof useFakeClock>[0]) {
        const v = await viewer(t);
        v.sim.set({ link: { ...LINK, lossPct: 4 } });
        await v.h.runUntil(60_000);
        assert.equal(v.h.controller.levelFor("A"), "720p60");
        v.sim.set({ link: LINK });
        return v;
    }

    test("sem folga de 1,5x o piso do degrau de cima (6750 kbps para o 1080p60): nao sobe", async t => {
        const { h, sim } = await downByLoss(t);
        sim.set({ availableKbps: 6500, kbps: 6000 });
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(200_000))), []);
        sim.set({ availableKbps: 7000 });
        await h.runUntil(228_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "folga ha 28 s");
        await h.runUntil(230_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("um recuo do estimador (caiu para 85% ou menos) recomeca a contagem da subida", async t => {
        const { h, sim } = await downByLoss(t);
        await h.runUntil(80_000);
        sim.set({ availableKbps: 15_000 });
        await h.runUntil(82_000);
        sim.set({ availableKbps: 20_000 });
        await h.runUntil(110_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "estavel ha 28 s desde o recuo");
        await h.runUntil(112_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("subida desfeita: a proxima espera dobra (30, 60, 120 s); 15 min sem descer, volta a 30 s", async t => {
        const { h, sim } = await downByLoss(t);
        const narrow = { availableKbps: 4000, kbps: 3800 };

        // sobe aos 90 s; no 1080p60 a estimativa nao da os 4500: desce 14 s depois de voltar a medir (desfeita)
        await h.runUntil(90_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        sim.set(narrow);
        const undone = await logsDuring(() => h.runUntil(112_000));
        assert.deepEqual(qualityLines(undone), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 4000 kbps, o degrau pede 4500 há 14 s); nova subida só após 60 s estável"]);
        const firstUndo = h.elapsed();

        // a folga volta: agora espera 60 s
        sim.set(GOOD);
        await h.runUntil(firstUndo + 58_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "estavel ha 56 s");
        await h.runUntil(firstUndo + 62_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");

        // desfeita de novo: 120 s
        sim.set(narrow);
        const again = await logsDuring(() => h.runUntil(h.elapsed() + 30_000));
        assert.match(qualityLines(again)[0] ?? "", /; nova subida só após 120 s estável$/);

        // 15 min sem descer: a proxima descida (longe de uma subida) fala de 30 s de novo
        sim.set(GOOD);
        await h.runUntil(h.elapsed() + 16 * 60_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        sim.set({ link: { ...LINK, lossPct: 4 } });
        const late = await logsDuring(() => h.runUntil(h.elapsed() + 20_000));
        assert.match(qualityLines(late)[0] ?? "", /\(banda: perda de 4,0% há 14 s\); nova subida só após 30 s estável$/);
    });
});

describe("rede de um espectador: a qualidade automatica desligada ou o espectador saindo", () => {
    test("ligada de novo: os periodos de problema recomecam do zero", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, lossPct: 4 } });
        await h.runUntil(50_000);
        h.controller.settingChanged();
        await h.runUntil(62_000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "a perda conta de novo depois de ligar (e dos 4 s de acomodacao)");
        await h.runUntil(70_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
    });
});
