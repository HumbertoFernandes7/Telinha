/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts) limitada pela REDE: o upload de quem transmite (a
// maioria dos espectadores com problema de rede que dura, ao mesmo tempo, desce o degrau de todos e o upload medido
// limita os proximos) e a banda de UM espectador (so o degrau dele; as regras ficam em controller.network.test.ts).
// Subir de volta depois do upload: a maioria (a mesma conta da descida) com 30 s de folga; quem ja esta limitado pela
// propria rede, um Wi-Fi instavel ou um espectador novo nao seguram todos.
// Espectador novo: 20 s de carencia de banda (test/helpers/wpb-quality.ts).
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.upload.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type LinkRates, type WebRtcEnv } from "@test/fakes/webrtc";
import { EVAL_MS, logsDuring, probeSawtooth, type QualityHarness, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

import { BW_GRACE_MS } from "./levels";

let rtc: WebRtcEnv;
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

/** Caminho cheio e estreito: 3 Mbps estimados (o 1080p60 pede 4,5) e enviando quase tudo. */
const NARROW = { availableKbps: 3000, kbps: 2800 };
const LINK: LinkRates = { targetKbps: 2800, rtxKbps: 0, lossPct: 0, rttMs: 30, jitterMs: 2, naksPerSecond: 0, plisPerSecond: 0, keyframesPerSecond: 0, qp: 30, pacerMs: 2 };

/** Liga e desliga 8% de perda numa janela a cada `everyMs` (um Wi-Fi instavel), de `from` ate `to`. */
async function flaky(h: QualityHarness, sim: EncoderSim, from: number, to: number, everyMs: number) {
    for (let at = from; at < to; at += everyMs) {
        await h.runUntil(at);
        sim.set({ link: { ...LINK, lossPct: 8 } });
        await h.runUntil(at + EVAL_MS);
        sim.set({ link: LINK });
    }
    await h.runUntil(to);
}

describe("upload de quem transmite", () => {
    test("2 de 2 espectadores com a banda curta por 14 s: desce todos e guarda o upload medido; o 3o ja entra abaixo", async t => {
        const clock = useFakeClock(t);
        const sims = { A: new EncoderSim(NARROW), B: new EncoderSim(NARROW), C: new EncoderSim(NARROW) };
        const h = qualityHarness(clock, sims);
        await h.join("A");
        await h.join("B");

        await h.runUntil(BW_GRACE_MS + 10_000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "a carencia e mais 12 s de banda curta");
        const lines = await logsDuring(() => h.runUntil(BW_GRACE_MS + 12_000));
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para os 2 espectadores (upload: 2 de 2 espectadores com banda limitada, 5600 kbps "
            + "enviados no total); nova subida só após 10 s estável"
        ]);
        assert.deepEqual(h.controller.state, {
            current: "720p60", reason: "upload", reasonText: "720p 60 fps — o seu upload está no limite",
            viewers: { A: { level: "720p60", reason: "upload" }, B: { level: "720p60", reason: "upload" } }
        });

        // o 3o: 3 x 2500 kbps (piso de 720p60) nao cabem nos 5600 kbps medidos: desce antes, para 720p30
        const third = await logsDuring(() => h.join("C"));
        assert.deepEqual(qualityLines(third), [
            "Qualidade automática: 720p 60 fps → 720p 30 fps para os 3 espectadores (upload: mais um espectador: upload medido de 5600 kbps "
            + "para 3 espectadores); nova subida só após 10 s estável"
        ]);
        assert.equal(h.lastApplied("C"), "720p30");

        // nao sobe enquanto o upload medido vale (60 s), nem depois com a banda estimada sem folga (< 1,5x o piso)
        const stuck = await logsDuring(() => h.runUntil(120_000));
        assert.equal(h.controller.levelFor("A"), "720p30");
        assert.deepEqual(qualityLines(stuck), []);

        // a banda volta aos 120 s: sobe quando a maioria tem 90% de 30 s com folga (148 s), e o proximo 10 s depois
        for (const sim of Object.values(sims)) sim.set({ availableKbps: 20_000 });
        await h.runUntil(146_000);
        assert.equal(h.controller.levelFor("A"), "720p30");
        const up = await logsDuring(() => h.runUntil(148_000));
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.match(qualityLines(up)[0] ?? "", /^Qualidade automática: 720p 30 fps → 720p 60 fps para os 3 espectadores \(upload: estável há \d+ s\)$/);
        await h.runUntil(158_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.equal(h.controller.state?.reason, null);
    });

    test("problemas que comecam em janelas diferentes (2 s de diferenca) tambem sao o upload: desce todos juntos", async t => {
        const clock = useFakeClock(t);
        const sims = { A: new EncoderSim(NARROW), B: new EncoderSim({ availableKbps: 20_000 }) };
        const h = qualityHarness(clock, sims);
        await h.join("A");
        await h.join("B");
        await h.runUntil(BW_GRACE_MS);
        sims.B.set(NARROW);
        // aos 32 s A completa 14 s; B esta com problema ha 12 s (>= 10): e o upload, nao a banda de A
        const lines = await logsDuring(() => h.runUntil(32_000));
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para os 2 espectadores (upload: 2 de 2 espectadores com banda limitada, 5600 kbps "
            + "enviados no total); nova subida só após 10 s estável"
        ]);
        assert.equal(h.controller.state?.reason, "upload");
    });

    test("o problema do outro comecou ha menos de 10 s: ainda nao e o upload, desce so o que ja durou", async t => {
        const clock = useFakeClock(t);
        const sims = { A: new EncoderSim(NARROW), B: new EncoderSim({ availableKbps: 20_000 }) };
        const h = qualityHarness(clock, sims);
        await h.join("A");
        await h.join("B");
        await h.runUntil(26_000);
        sims.B.set(NARROW);
        const lines = await logsDuring(() => h.runUntil(32_000));
        assert.match(qualityLines(lines)[0] ?? "", /para A \(banda: banda estimada 3000 kbps, o degrau pede 4500 há 14 s\)/);
        assert.deepEqual([h.controller.levelFor("A"), h.controller.levelFor("B")], ["720p60", "1080p60"]);
    });

    test("o upload medido limita a subida enquanto vale", async t => {
        const clock = useFakeClock(t);
        const sims = { A: new EncoderSim(NARROW), B: new EncoderSim(NARROW) };
        const h = qualityHarness(clock, sims);
        await h.join("A");
        await h.join("B");
        await h.runUntil(BW_GRACE_MS + 12_000);
        assert.equal(h.controller.levelFor("A"), "720p60");

        // banda boa de novo logo depois: 2 x 4500 kbps (piso de 1080p60) > 5600 medidos: espera o upload medido vencer
        for (const sim of Object.values(sims)) sim.set({ availableKbps: 20_000 });
        await h.runUntil(BW_GRACE_MS + 12_000 + 58_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(BW_GRACE_MS + 12_000 + 62_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("so 1 de 3 com banda limitada nao e o upload: desce so o degrau dele", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim(NARROW), B: new EncoderSim(), C: new EncoderSim() });
        for (const id of ["A", "B", "C"]) await h.join(id);
        await h.runUntil(BW_GRACE_MS + 12_000);
        assert.deepEqual(["A", "B", "C"].map(id => h.controller.levelFor(id)), ["720p60", "1080p60", "1080p60"]);
        assert.equal(h.controller.state?.reasonText, "720p 60 fps — a conexão de um espectador está limitada");
        assert.deepEqual(h.controller.state?.viewers.B, { level: "1080p60", reason: null });
    });
});

describe("upload: subir de volta sem um espectador segurar todos", () => {
    /** 3 espectadores descem pelo upload aos 32 s; a banda de todos volta aos 100 s (o upload medido ja venceu). */
    async function downByUpload(t: Parameters<typeof useFakeClock>[0]) {
        const clock = useFakeClock(t);
        const sims = { A: new EncoderSim({ ...NARROW, link: LINK }), B: new EncoderSim({ ...NARROW, link: LINK }), C: new EncoderSim({ ...NARROW, link: LINK }) };
        const h = qualityHarness(clock, sims);
        for (const id of ["A", "B", "C"]) await h.join(id);
        await h.runUntil(BW_GRACE_MS + 12_000);
        assert.equal(h.controller.state?.reason, "upload");
        await h.runUntil(100_000);
        for (const sim of Object.values(sims)) sim.set({ availableKbps: 20_000 });
        return { clock, h, sims };
    }

    test("um espectador de Wi-Fi instavel (janela ruim a cada 10 s) nao segura a subida dos outros", async t => {
        const { h, sims } = await downByUpload(t);
        await flaky(h, sims.C, 104_000, 132_000, 10_000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "A e B com 30 s de folga: a maioria");
    });

    test("um espectador que acabou de entrar (sem 30 s medidos) nao segura a subida", async t => {
        const { h, sims } = await downByUpload(t);
        h.attach("D", new EncoderSim({ availableKbps: 20_000 }));
        await h.runUntil(110_000);
        await h.join("D");
        await h.runUntil(132_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.ok(sims);
    });

    test("a maioria ainda instavel segura a subida; quando ela acalma, sobe", async t => {
        const { h, sims } = await downByUpload(t);
        await h.runUntil(104_000);
        for (let at = 104_000; at < 160_000; at += 10_000) {
            await h.runUntil(at);
            sims.A.set({ link: { ...LINK, lossPct: 8 } });
            sims.B.set({ link: { ...LINK, lossPct: 8 } });
            await h.runUntil(at + EVAL_MS);
            sims.A.set({ link: LINK });
            sims.B.set({ link: LINK });
        }
        await h.runUntil(160_000);
        assert.equal(h.controller.levelFor("C"), "720p60", "2 de 3 instaveis");
        await h.runUntil(200_000);
        assert.equal(h.controller.levelFor("C"), "1080p60");
    });

    test("quem ja esta limitado pela propria rede abaixo do degrau de cima nao conta", async t => {
        const clock = useFakeClock(t);
        // C so tem 1,8 Mbps: desce pelo upload com os outros e depois, sozinho, para 720p30 (banda dele)
        const sims = { A: new EncoderSim({ ...NARROW, link: LINK }), B: new EncoderSim({ ...NARROW, link: LINK }), C: new EncoderSim({ availableKbps: 1800, kbps: 1700, link: LINK }) };
        const h = qualityHarness(clock, sims);
        for (const id of ["A", "B", "C"]) await h.join(id);
        await h.runUntil(100_000);
        assert.deepEqual(["A", "B", "C"].map(id => h.controller.levelFor(id)), ["720p60", "720p60", "720p30"]);
        sims.A.set({ availableKbps: 20_000 });
        sims.B.set({ availableKbps: 20_000 });
        // B instavel: com C contando, seriam 2 de 3 sem folga; sem ele, 1 de 2
        await flaky(h, sims.B, 104_000, 132_000, 10_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.equal(h.controller.levelFor("C"), "720p30");
    });

    test("o estimador de todos sondando o teto do 720p60 (12 Mbps), enviando perto dele (90%): os recuos nao seguram a subida, e no 1080p60 fica", async t => {
        const { h, sims } = await downByUpload(t);
        const atCeiling = (est: number) => {
            for (const sim of Object.values(sims)) sim.set({ availableKbps: est, kbps: 10_800 });
        };
        // 3 recuos em cada 15 janelas (test/helpers/wpb-quality.ts → PROBE_SAWTOOTH): sem contar como problema, 30 s com folga
        const up = await logsDuring(() => probeSawtooth(h, 132_000, atCeiling));
        assert.match(qualityLines(up).join("|"), /^Qualidade automática: 720p 60 fps → 1080p 60 fps para os 3 espectadores \(upload: estável há \d+ s\)$/);
        assert.equal(h.controller.state?.reason, null);
        assert.deepEqual(qualityLines(await logsDuring(() => probeSawtooth(h, 300_000, atCeiling))), []);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });
});

describe("banda de um espectador", () => {
    test("o WebRTC reduzindo a resolucao por banda (Chromium que recusou a preferencia) nao desce o degrau por si so", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim({ limitation: "bandwidth", width: 1066, height: 600 }) });
        await h.join("A");
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(120_000))), [], "a banda estimada da o degrau e nada mais conta");
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });
});
