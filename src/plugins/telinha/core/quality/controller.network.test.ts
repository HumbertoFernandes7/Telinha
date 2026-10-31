/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts → trackNet) limitada pela REDE de um espectador, desde a
// 0.2.10: um soluco da internet nao muda o degrau; so problema que dura (perda >= 5%, ou >= 2% com outro sinal; RTT 60 ms
// acima da base (P15 dos ultimos 2 min); fila do pacer > 100 ms; por 14 s. So a banda estimada curta: 30 s, ou 14 s se
// ela nunca deu o que o degrau pede). Subir: 30 s com 90% das janelas calmas e folga de 1,5x o piso do degrau de cima;
// subida desfeita dobra a espera (ate 10 min). A rede vem do EncoderSim com `link` (perda, RTT, fila:
// test/fakes/webrtc.ts), num relogio falso.
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
/** Perda que conta sozinha (>= 5%). */
const LOSSY = { link: { ...LINK, lossPct: 6 } };

let rtc: WebRtcEnv;
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

/** Um espectador "A" pronto em 0 s com a rede boa ate `until` (o degrau dele ja deu o que pede). */
async function viewer(t: Parameters<typeof useFakeClock>[0], until = 40_000) {
    const clock = useFakeClock(t);
    const sim = new EncoderSim(GOOD);
    const h = qualityHarness(clock, { A: sim });
    await h.join("A");
    await h.runUntil(until);
    assert.equal(h.controller.levelFor("A"), "1080p60");
    return { h, sim };
}

/** Os degraus que A teve em cada avaliacao daqui ate `to`. */
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

    test("janelas ruins soltas (8% de perda, uma a cada 6 s) nao somam", async t => {
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

    test("Wi-Fi rapido com 3% de perda cronica (o NACK e o colchao escondem): sem outro sinal, nunca desce", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, lossPct: 3 } });
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(300_000))), []);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("uma leitura de RTT baixa solta (5 ms) nao vira a base: 75 ms depois de 30 ms normais nao e fila", async t => {
        const { h, sim } = await viewer(t, 20_000);
        sim.set({ link: { ...LINK, rttMs: 5 } });
        await h.runUntil(22_000);
        sim.set({ link: LINK });
        await h.runUntil(40_000);
        sim.set({ link: { ...LINK, rttMs: 75 } });
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(80_000))), [], "75 - 30 = 45 ms, abaixo dos 60");
    });
});

describe("rede de um espectador: problema que dura desce um degrau", () => {
    test("perda de 6% por 20 s: desce um degrau aos 14 s e so um; sobe com 90% das janelas calmas nos 30 s seguintes", async t => {
        const { h, sim } = await viewer(t);
        sim.set(LOSSY);
        const before14 = await levelsDuring(h, 52_000);
        assert.ok(before14.every(l => l === "1080p60"), "ate 12 s de perda, nada");
        const down = await logsDuring(() => h.runUntil(54_000));
        assert.deepEqual(qualityLines(down), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: perda de 6,0% há 14 s); nova subida só após 30 s estável"]);
        assert.equal(h.lastApplied("A"), "720p60");

        await h.runUntil(60_000);
        sim.set({ link: LINK });
        // as janelas de 58 e 60 s ainda tinham perda: aos 86 s sao 2 de 15 (87%); aos 88 s, 1 de 15 (93%)
        await h.runUntil(86_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        const up = await logsDuring(() => h.runUntil(88_000));
        assert.deepEqual(qualityLines(up), ["Qualidade automática: 720p 60 fps → 1080p 60 fps para A (banda: estável em 93% dos últimos 30 s)"]);
        assert.deepEqual(h.applied.map(a => a.level), ["1080p60", "720p60", "1080p60"]);
    });

    test("perda de 3% com a banda estimada abaixo do degrau (sem o caminho cheio): conta, e desce aos 14 s", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ availableKbps: 4000, kbps: 2000, link: { ...LINK, lossPct: 3 } });
        const lines = await logsDuring(() => h.runUntil(54_000));
        assert.match(qualityLines(lines).join("|"), /^Qualidade automática: 1080p 60 fps → 720p 60 fps para A \(banda: perda de 3,\d% há 14 s\); nova subida só após 30 s estável$/);
    });

    test("perda de 3% com o estimador recuando a cada janela: conta", async t => {
        const { h, sim } = await viewer(t);
        let est = 20_000;
        const lines = await logsDuring(async () => {
            for (let at = 40_000; at < 54_000; at += EVAL_MS) {
                est = Math.round(est * 0.84);
                sim.set({ availableKbps: Math.max(est, 4600), kbps: 2000, link: { ...LINK, lossPct: 3 } });
                await h.runUntil(at + EVAL_MS);
            }
        });
        assert.match(qualityLines(lines)[0] ?? "", /\(banda: perda de 3,\d% há 14 s\)/);
    });

    test("RTT 80 ms acima da base por 14 s: desce", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, rttMs: 110 } });
        const lines = await logsDuring(() => h.runUntil(54_000));
        assert.deepEqual(qualityLines(lines), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: RTT de 110 ms (30 ms sem fila) há 14 s); nova subida só após 30 s estável"]);
    });

    test("RTT alto que vira o normal (rota nova): desce enquanto parece fila; quando ele vira a base, volta a subir", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ link: { ...LINK, rttMs: 110 } });
        await h.runUntil(54_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(80_000);
        assert.equal(h.controller.levelFor("A"), "720p30", "ainda parece fila");
        await h.runUntil(260_000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "o P15 dos ultimos 2 min ja e 110 ms");
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

    test("depois de descer de um degrau que a banda dava, a banda curta no degrau de baixo tambem espera 30 s", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ availableKbps: 3000, kbps: 2850 });
        await h.runUntil(70_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        // 2000 kbps nunca deu os 2500 do 720p60, mas ja deu os 4500 do 1080p60: e o estimador voltando, nao caminho estreito
        sim.set({ availableKbps: 2000, kbps: 1900 });
        await h.runUntil(100_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "14 s ja passaram");
        await h.runUntil(106_000);
        assert.equal(h.controller.levelFor("A"), "720p30");
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
        v.sim.set(LOSSY);
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
        // a janela que termina aos 200 s ainda nao tinha folga: aos 226 s sao 2 de 15, aos 228 s 1 de 15
        await h.runUntil(226_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(228_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("um recuo solto do estimador nao zera a conta (1 janela ruim em 15)", async t => {
        const once = await downByLoss(t);
        await once.h.runUntil(80_000);
        once.sim.set({ availableKbps: 15_000 });
        await once.h.runUntil(82_000);
        once.sim.set({ availableKbps: 20_000 });
        await once.h.runUntil(90_000);
        assert.equal(once.h.controller.levelFor("A"), "1080p60", "1 janela ruim em 15");
    });

    test("dois recuos seguidos do estimador seguram a subida ate sairem dos 30 s", async t => {
        const { h, sim } = await downByLoss(t);
        await h.runUntil(80_000);
        sim.set({ availableKbps: 15_000 });
        await h.runUntil(82_000);
        sim.set({ availableKbps: 12_000 });
        await h.runUntil(84_000);
        sim.set({ availableKbps: 20_000 });
        await h.runUntil(110_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "2 janelas ruins em 15");
        await h.runUntil(112_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("subida desfeita: a proxima espera dobra (30, 60, 120 s); 15 min sem descer, volta a 30 s", async t => {
        const { h, sim } = await downByLoss(t);
        const narrow = { availableKbps: 4000, kbps: 3800 };

        // sobe aos 88 s; no 1080p60 a estimativa nao da os 4500: desce 14 s depois de voltar a medir (desfeita)
        await h.runUntil(88_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        sim.set(narrow);
        const undone = await logsDuring(() => h.runUntil(112_000));
        assert.deepEqual(qualityLines(undone), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 4000 kbps, o degrau pede 4500 há 14 s); nova subida só após 60 s estável"]);
        const firstUndo = h.applied.at(-1)!.atMs;

        // a folga volta: agora espera 60 s
        sim.set(GOOD);
        await h.runUntil(firstUndo + 58_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "estavel ha 58 s");
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
        sim.set(LOSSY);
        const late = await logsDuring(() => h.runUntil(h.elapsed() + 20_000));
        assert.match(qualityLines(late)[0] ?? "", /\(banda: perda de 6,0% há 14 s\); nova subida só após 30 s estável$/);
    });

    test("perda cronica de 3% nao segura a subida (nao e problema sem outro sinal)", async t => {
        const { h, sim } = await downByLoss(t);
        sim.set({ link: { ...LINK, lossPct: 3 } });
        await h.runUntil(90_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });
});

describe("rede de um espectador: a qualidade automatica desligada ou o espectador saindo", () => {
    test("reaplicar (o encoder mudou de tipo): o mesmo degrau de novo; espectador desconhecido ou transmissao encerrada, nada", async t => {
        const { h } = await viewer(t, 10_000);
        const before = h.applied.length;
        h.controller.reapply("A");
        await Promise.resolve();
        assert.deepEqual(h.applied.slice(before).map(a => a.level), ["1080p60"]);
        h.controller.reapply("ninguem");
        h.controller.dispose();
        h.controller.reapply("A");
        await Promise.resolve();
        assert.equal(h.applied.length, before + 1);
    });

    test("ligada de novo: os periodos de problema recomecam do zero", async t => {
        const { h, sim } = await viewer(t);
        sim.set(LOSSY);
        await h.runUntil(50_000);
        h.controller.settingChanged();
        await h.runUntil(62_000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "a perda conta de novo depois de ligar (e dos 4 s de acomodacao)");
        await h.runUntil(70_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
    });
});
