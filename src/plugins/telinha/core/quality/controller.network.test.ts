/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts → trackNet) limitada pela REDE de um espectador, desde a
// 0.2.10: um soluco da internet nao muda o degrau; so problema que dura (perda >= 5%, ou >= 2% com outro sinal; RTT 60 ms
// acima da base (P15 dos ultimos 2 min); fila do pacer > 100 ms; por 14 s. So a banda estimada curta: 30 s, ou 14 s se
// ela nunca deu o que o degrau pede). Subir: 30 s com 90% das janelas calmas e folga de 1,5x o piso do degrau de cima
// (um recuo do estimador para >= 0,8x do que se enviava, sem outro sinal, e ele sondando o caminho: nao tira a calma);
// subida desfeita dobra a espera (ate 10 min). A rede vem do EncoderSim com `link` (perda, RTT, fila:
// test/fakes/webrtc.ts), num relogio falso.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.network.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type LinkRates, type WebRtcEnv } from "@test/fakes/webrtc";
import { EVAL_MS, logsDuring, NVENC_IMPLEMENTATION, probeSawtooth, type QualityHarness, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

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

    test("tela parada (o encoder pede pouco): banda estimada perto do degrau (4000 de 4500) sem o caminho cheio nao e problema", async t => {
        const { h, sim } = await viewer(t);
        // os 4000 kbps iniciais do estimador (x-google-start-bitrate), que uma tela parada nunca empurra para cima
        sim.set({ availableKbps: 4000, kbps: 500 });
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(300_000))), []);
        assert.equal(h.controller.levelFor("A"), "1080p60");
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

// Log de 02/11: um espectador ficou 1 min em 1080p60 (pede 4500) com 1,6-3,2 Mbps estimados; o alvo do encoder ficava
// em ~70-80% da estimativa e o envio em 58-94% dela (qp 38-47, imagem borrada no movimento). A banda curta pedia o envio
// em >= 85% da estimativa, e cada janela abaixo disso recomecava a conta. Agora a estimativa abaixo de 0,7x o que o
// degrau pede conta com qualquer envio; perto do que ele pede, o envio em 85% continua exigido.
describe("rede de um espectador: banda estimada bem abaixo do degrau", () => {
    /** As linhas de 10 s do envio para leozzyy (02/11, 01:35:42-01:36:52, 1080p60 em H.264 na placa): [estimada, enviada]. */
    const LEOZZYY: readonly (readonly [est: number, sent: number])[] = [
        [2489, 1676], [2875, 2014], [3223, 2431], [2490, 2331], [2186, 1888], [1670, 1426], [2056, 1289], [2857, 1647]
    ];

    /** O encoder dele: NVENC, 47 de 51 fps da fonte, ~10 ms por quadro (bem abaixo do limite da placa). */
    const leoSim = () => new EncoderSim({
        mimeType: "video/H264", implementation: NVENC_IMPLEMENTATION, powerEfficient: true, fps: 47, sourceFps: 51, encodeBusy: 10 * 47 / 1000,
        availableKbps: LEOZZYY[0][0], kbps: LEOZZYY[0][1], link: { ...LINK, rttMs: 20, pacerMs: 10 }
    });

    /** Janela a janela de agora ate `to`: a estimativa e o envio de `rates(at)`, onde `at` e o inicio da janela. */
    async function replay(h: QualityHarness, sim: EncoderSim, to: number, rates: (at: number) => readonly [number, number]) {
        for (let at = h.elapsed(); at < to; at += EVAL_MS) {
            const [est, sent] = rates(at);
            sim.set({ availableKbps: est, kbps: sent });
            await h.runUntil(at + EVAL_MS);
        }
    }

    /**
     * O envio de cada janela de 2 s em torno da media da linha de 10 s (a media de WOBBLE e 1): o encoder segue a cena. Com
     * a media em 85-94% da estimativa, algumas janelas ficam abaixo dos 85% e quebravam a sequencia da banda curta.
     */
    const WOBBLE = [1.12, 0.88, 1.06, 0.84, 1.10];
    const leozzyy = (at: number): readonly [number, number] => {
        const [est, sent] = LEOZZYY[Math.floor(at / 10_000) % LEOZZYY.length];
        return [est, Math.round(sent * WOBBLE[Math.floor(at / EVAL_MS) % WOBBLE.length])];
    };

    test("leozzyy (02/11): desce de 1080p60 para 720p60 (pede 2500; a mediana estimada dele e 2490) e la fica por 10 min; com a internet boa, sobe", async t => {
        const clock = useFakeClock(t);
        const sim = leoSim();
        const h = qualityHarness(clock, { A: sim });
        await h.join("A");
        const lines = await logsDuring(() => replay(h, sim, 600_000, leozzyy));
        // 1080p60: as janelas de 20-30 s (3223 kbps, acima de 0,7 x 4500 = 3150, enviando 63-84%) nao contam; de 30 s em
        // diante todas ficam abaixo de 3150, e a estimativa nunca deu os 4500 (caminho estreito): 14 s. Antes (so com o
        // envio em >= 85%) a sequencia mais longa era de 2 janelas, e ele ficava em 1080p60
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 2186 kbps, o degrau pede 4500 há 14 s); nova subida só após 30 s estável"
        ]);
        // 720p60 pede 2500: so os 1670 (< 0,7 x 2500 = 1750) contam com qualquer envio, por 10-12 s seguidos; o resto, so
        // com o caminho cheio. Sem voltar: o 1080p60 pede 6750 de folga, e a estimativa nunca passa de 3223
        assert.deepEqual(h.applied.map(a => [a.level, a.atMs]), [["1080p60", 0], ["720p60", 44_000]]);
        assert.deepEqual(h.controller.state?.viewers.A, { level: "720p60", reason: "bandwidth" });

        // a internet dele melhora: com folga para o 1080p60 em 14 das 15 janelas dos ultimos 30 s (a 1a ainda e a de antes)
        const up = await logsDuring(() => replay(h, sim, 700_000, () => [20_000, 16_000]));
        assert.deepEqual(qualityLines(up), ["Qualidade automática: 720p 60 fps → 1080p 60 fps para A (banda: estável em 93% dos últimos 30 s)"]);
    });

    // caminhos estaveis com o encoder enviando 75% da estimativa (o alvo dele fica em ~70-80% dela): desce ate um degrau
    // que cabe e fica, sem voltar (subir pede 1,5x o piso do degrau de cima)
    for (const [mbps, path, levels] of [
        ["2-3", [2000, 2250, 2500, 2750, 3000, 2750, 2500, 2250], ["1080p60", "720p60"]],
        ["1,2-1,7", [1200, 1350, 1500, 1650, 1700, 1600, 1450, 1300], ["1080p60", "720p60", "720p30"]]
    ] as const) {
        test(`caminho estavel de ${mbps} Mbps, enviando 75% da estimativa: ${levels.join(" → ")}, e la fica por 10 min`, async t => {
            const clock = useFakeClock(t);
            const sim = leoSim();
            const h = qualityHarness(clock, { A: sim });
            await h.join("A");
            const lines = await logsDuring(() => replay(h, sim, 600_000, at => {
                const est = path[(at / EVAL_MS) % path.length];
                return [est, Math.round(est * 0.75)];
            }));
            // 1080p60: tudo abaixo de 3150, 14 s depois da carencia. 720p60 (pede 2500): no de 2-3 Mbps as janelas abaixo de
            // 2500 ficam acima de 1750 sem o caminho cheio, e fica; no de 1,2-1,7, tudo abaixo de 1750: mais 14 s
            assert.deepEqual(h.applied.map(a => a.level), levels);
            assert.deepEqual(qualityLines(lines).length, levels.length - 1);
            assert.deepEqual(h.applied.slice(1).map(a => a.atMs), [32_000, 48_000].slice(0, levels.length - 1));
        });
    }

    test("a fronteira e 0,7x o que o degrau pede: o encoder pedindo pouco com 3200 de 4500 (0,71x) nao conta; com 3100 (0,69x), conta", async t => {
        const { h, sim } = await viewer(t);
        sim.set({ availableKbps: 3200, kbps: 500 });
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(160_000))), []);
        // a estimativa ja deu os 4500 do 1080p60: so a banda curta espera 30 s
        sim.set({ availableKbps: 3100 });
        await h.runUntil(188_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        const lines = await logsDuring(() => h.runUntil(190_000));
        assert.deepEqual(qualityLines(lines), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 3100 kbps, o degrau pede 4500 há 30 s); nova subida só após 30 s estável"]);
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

    // recuos de congestionamento: a estimativa cai bem abaixo do que se enviava (< 0,75x os ~11,4 Mbps do teto do 720p60),
    // ainda acima dos 6750 kbps de folga do 1080p60 (so o recuo conta)
    test("um recuo solto do estimador nao zera a conta (1 janela ruim em 15)", async t => {
        const once = await downByLoss(t);
        once.sim.set({ kbps: 11_400 });
        await once.h.runUntil(80_000);
        once.sim.set({ availableKbps: 8000 });
        await once.h.runUntil(82_000);
        once.sim.set({ availableKbps: 20_000 });
        await once.h.runUntil(90_000);
        assert.equal(once.h.controller.levelFor("A"), "1080p60", "1 janela ruim em 15");
    });

    test("dois recuos seguidos do estimador seguram a subida ate sairem dos 30 s", async t => {
        const { h, sim } = await downByLoss(t);
        sim.set({ kbps: 11_400 });
        await h.runUntil(80_000);
        sim.set({ availableKbps: 8400 });
        await h.runUntil(82_000);
        // o envio segue a estimativa; o 2o recuo vem logo depois do 1o: conta mesmo perto do que se enviava
        sim.set({ availableKbps: 7000, kbps: 7300 });
        await h.runUntil(84_000);
        sim.set({ availableKbps: 20_000, kbps: 11_400 });
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

    // o estimador sondando o caminho (test/helpers/wpb-quality.ts → probeSawtooth): sobe ate 1,05x o caminho, passa e recua
    // para 0,85x a cada 6-14 s (3 janelas em 15), e o envio segue a estimativa (no maximo o teto do degrau). 7,5 Mbps e a
    // fronteira: no recuo a estimativa (6375 kbps) fica abaixo da folga de 1,5x o piso do 1080p60 (6750), e fica em 720p60
    for (const [path, up] of [[7500, false], [9000, true], [10_000, true], [11_000, true]] as const) {
        test(`caminho de ${path / 1000} Mbps com o estimador sondando: ${up ? "os recuos nao seguram a subida para o 1080p60, e la fica" : "sem a folga do 1080p60 no recuo, fica em 720p60"}`, async t => {
            const { h, sim } = await downByLoss(t);
            // a 1a janela (20 Mbps estimados → 0,85x o caminho, < 0,75x o que se enviava) conta; com a de 60 s (perda), aos 88 s
            // sao 2 de 15; aos 90 s, 1 de 15 (93%)
            await probeSawtooth(h, { A: sim }, path, 88_000);
            assert.equal(h.controller.levelFor("A"), "720p60");
            const lines = await logsDuring(() => probeSawtooth(h, { A: sim }, path, 90_000));
            assert.deepEqual(qualityLines(lines), up ? ["Qualidade automática: 720p 60 fps → 1080p 60 fps para A (banda: estável em 93% dos últimos 30 s)"] : []);
            // no 1080p60 (pede 4,5 Mbps) o mesmo caminho e o mesmo serrote: nao volta a descer
            assert.deepEqual(qualityLines(await logsDuring(() => probeSawtooth(h, { A: sim }, path, 300_000))), []);
            assert.deepEqual(h.applied.map(a => a.level), up ? ["1080p60", "720p60", "1080p60"] : ["1080p60", "720p60"]);
        });
    }

    test("caminho encolhendo (-17,5% por janela, sem perda nem RTT): recuos seguidos contam, nao sobe no meio da queda", async t => {
        const { h, sim } = await downByLoss(t);
        // o envio segue a estimativa (no maximo os 12 Mbps do 720p60): cada recuo fica em ~0,79x do que se enviava, perto o
        // bastante para parecer sondagem, mas vem logo depois de outro
        let est = 20_000;
        const lines = await logsDuring(async () => {
            for (let at = 60_000; at < 200_000; at += EVAL_MS) {
                const next = at < 80_000 ? est : Math.max(4000, Math.round(est * 0.825));
                sim.set({ availableKbps: next, kbps: Math.round(Math.min(12_000, (est + next) / 2) * 0.95) });
                est = next;
                await h.runUntil(at + EVAL_MS);
            }
        });
        // aos 88 s so a 1a janela da queda (82 s) ficou calma: 3 ruins em 15. Depois a estimativa fica sem a folga do 1080p60
        assert.deepEqual(qualityLines(lines), []);
        assert.deepEqual(h.applied.map(a => a.level), ["1080p60", "720p60"]);
    });

    test("recuos que caem bem abaixo do que se enviava (0,7x): congestionamento, seguram a subida", async t => {
        const { h, sim } = await downByLoss(t);
        // caminho de 11 Mbps: mesmo no recuo a estimativa fica acima dos 6750 kbps de folga do 1080p60; so o recuo segura
        const lines = await logsDuring(() => probeSawtooth(h, { A: sim }, 11_000, 300_000, { dropToSent: 0.7 }));
        assert.deepEqual(qualityLines(lines), [], "12 de 15 janelas calmas (80%)");
        assert.equal(h.controller.levelFor("A"), "720p60");
    });

    for (const [what, trouble] of [["perda de 6%", { lossPct: 6 }], ["perda de 3%, que com o recuo conta", { lossPct: 3 }], ["RTT 80 ms acima da base", { rttMs: 110 }]] as const) {
        test(`recuos sondando o caminho com problema de verdade nas mesmas janelas (${what}): seguram a subida`, async t => {
            const { h, sim } = await downByLoss(t);
            const each = (s: EncoderSim, backoff: boolean) => s.set({ link: backoff ? { ...LINK, ...trouble } : LINK });
            const lines = await logsDuring(() => probeSawtooth(h, { A: sim }, 10_000, 300_000, { each }));
            assert.deepEqual(qualityLines(lines), [], "nem sobe nem desce: o problema de cada vez e um soluco");
            assert.equal(h.controller.levelFor("A"), "720p60");
        });
    }
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
