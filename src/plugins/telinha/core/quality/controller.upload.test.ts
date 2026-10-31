/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts) limitada pela REDE: o upload de quem transmite (a
// maioria dos espectadores com problema de rede que dura, ao mesmo tempo, desce o degrau de todos e o upload medido
// limita os proximos) e a banda de UM espectador (so o degrau dele; as regras ficam em controller.network.test.ts).
// Espectador novo: 20 s de carencia de banda (test/helpers/wpb-quality.ts).
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.upload.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type LinkRates, type WebRtcEnv } from "@test/fakes/webrtc";
import { logsDuring, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

import { BW_GRACE_MS } from "./levels";

let rtc: WebRtcEnv;
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

/** Caminho cheio e estreito: 3 Mbps estimados (o 1080p60 pede 4,5) e enviando quase tudo. */
const NARROW = { availableKbps: 3000, kbps: 2800 };

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

        for (const sim of Object.values(sims)) sim.set({ availableKbps: 20_000 });
        const up = await logsDuring(() => h.runUntil(122_000));
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.match(qualityLines(up)[0] ?? "", /^Qualidade automática: 720p 30 fps → 720p 60 fps para os 3 espectadores \(upload: estável há \d+ s\)$/);
        await h.runUntil(132_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.equal(h.controller.state?.reason, null);
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

    test("desceu pelo upload: so sobe com a rede de todos estavel ha 30 s (uma perda curta de um recomeca a conta)", async t => {
        const clock = useFakeClock(t);
        const link: LinkRates = { targetKbps: 2800, rtxKbps: 0, lossPct: 0, rttMs: 30, jitterMs: 2, naksPerSecond: 0, plisPerSecond: 0, keyframesPerSecond: 0, qp: 30, pacerMs: 2 };
        const sims = { A: new EncoderSim({ ...NARROW, link }), B: new EncoderSim({ ...NARROW, link }) };
        const h = qualityHarness(clock, sims);
        await h.join("A");
        await h.join("B");
        await h.runUntil(BW_GRACE_MS + 12_000);
        assert.equal(h.controller.levelFor("A"), "720p60");

        // a banda volta e o upload medido vence aos 92 s; antes, A perde 3% por 6 s (80-86 s): nao desce ninguem, mas a
        // subida espera a rede dele ficar 30 s estavel (sem a perda, subiria aos 92 s)
        for (const sim of Object.values(sims)) sim.set({ availableKbps: 20_000 });
        await h.runUntil(80_000);
        sims.A.set({ link: { ...link, lossPct: 3 } });
        await h.runUntil(86_000);
        sims.A.set({ link });
        await h.runUntil(114_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "a rede de A estavel ha 28 s");
        await h.runUntil(116_000);
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

describe("banda de um espectador", () => {
    test("o WebRTC reduzindo a resolucao por banda (Chromium que recusou a preferencia) nao desce o degrau por si so", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim({ limitation: "bandwidth", width: 1066, height: 600 }) });
        await h.join("A");
        assert.deepEqual(qualityLines(await logsDuring(() => h.runUntil(120_000))), [], "a banda estimada da o degrau e nada mais conta");
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });
});
