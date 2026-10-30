/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts) limitada pela REDE: o upload de quem transmite (a
// maioria dos espectadores limitada ao mesmo tempo desce o degrau de todos e o upload medido limita os proximos) e a
// banda de UM espectador (so o degrau dele). Espectador novo: 20 s de carencia de banda; 3 janelas ruins seguidas
// para descer (test/helpers/wpb-quality.ts).
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.upload.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { logsDuring, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

import { BW_GRACE_MS } from "./levels";

let rtc: WebRtcEnv;
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

describe("upload de quem transmite", () => {
    test("2 de 2 espectadores com banda limitada por 3 janelas: desce todos e guarda o upload medido", async t => {
        const clock = useFakeClock(t);
        const slow = { availableKbps: 3000, kbps: 2000 };
        const sims = { A: new EncoderSim(slow), B: new EncoderSim(slow), C: new EncoderSim(slow) };
        const h = qualityHarness(clock, sims);
        await h.join("A");
        await h.join("B");

        await h.runUntil(BW_GRACE_MS + 2000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "carencia + 2 janelas");
        const lines = await logsDuring(() => h.runUntil(BW_GRACE_MS + 4000));
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para os 2 espectadores (upload: 2 de 2 espectadores com banda limitada, 4000 kbps "
            + "enviados no total); nova subida só após 10 s estável"
        ]);
        assert.deepEqual(h.controller.state, {
            current: "720p60", reason: "upload", reasonText: "720p 60 fps — o seu upload está no limite",
            viewers: { A: { level: "720p60", reason: "upload" }, B: { level: "720p60", reason: "upload" } }
        });

        // o 3o: 3 x 2500 kbps (piso de 720p60) nao cabem nos 4000 kbps medidos: desce antes, para 720p30
        const third = await logsDuring(() => h.join("C"));
        assert.deepEqual(qualityLines(third), [
            "Qualidade automática: 720p 60 fps → 720p 30 fps para os 3 espectadores (upload: mais um espectador: upload medido de 4000 kbps "
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
        const sims = { A: new EncoderSim({ availableKbps: 3000, kbps: 2000 }), B: new EncoderSim({ availableKbps: 3000, kbps: 2000 }) };
        const h = qualityHarness(clock, sims);
        await h.join("A");
        await h.join("B");
        await h.runUntil(BW_GRACE_MS + 4000);
        assert.equal(h.controller.levelFor("A"), "720p60");

        // banda boa de novo logo depois: 2 x 4500 kbps (piso de 1080p60) > 4000 medidos: espera o upload medido vencer
        for (const sim of Object.values(sims)) sim.set({ availableKbps: 20_000 });
        await h.runUntil(BW_GRACE_MS + 4000 + 58_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(BW_GRACE_MS + 4000 + 62_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });

    test("so 1 de 3 com banda limitada nao e o upload: desce so o degrau dele", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim({ availableKbps: 3000 }), B: new EncoderSim(), C: new EncoderSim() });
        for (const id of ["A", "B", "C"]) await h.join(id);
        await h.runUntil(BW_GRACE_MS + 4000);
        assert.deepEqual(["A", "B", "C"].map(id => h.controller.levelFor(id)), ["720p60", "1080p60", "1080p60"]);
        assert.equal(h.controller.state?.reasonText, "720p 60 fps — a conexão de um espectador está limitada");
        assert.deepEqual(h.controller.state?.viewers.B, { level: "1080p60", reason: null });
    });
});

describe("banda de um espectador", () => {
    test("o WebRTC reduzindo por banda abaixo do degrau: desce o dele; de novo so 15 s depois; sobe com banda de sobra", async t => {
        const clock = useFakeClock(t);
        const reduced = { limitation: "bandwidth", width: 1066, height: 600 } as const;
        const a = new EncoderSim(reduced);
        const h = qualityHarness(clock, { A: a, B: new EncoderSim() });
        await h.join("A");
        await h.join("B");
        const lines = await logsDuring(() => h.runUntil(BW_GRACE_MS + 4000));
        assert.deepEqual(qualityLines(lines), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: o WebRTC reduziu para 600p por banda (degrau 1080p))"]);
        assert.equal(h.controller.levelFor("B"), "1080p60");

        // 600p continua abaixo de 85% de 720p, mas a reducao do WebRTC so volta a contar 15 s depois da descida
        await h.runUntil(42_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(44_000);
        assert.equal(h.controller.levelFor("A"), "720p30");

        // sem limitacao, 5 Mbps estimados: sobe para 720p60 (pede 2,5 x 1,5), mas nao para 1080p60 (pede 4,5 x 1,5)
        a.set({ limitation: "none", width: 1920, height: 1080, availableKbps: 5000 });
        const up = await logsDuring(() => h.runUntil(54_000));
        assert.deepEqual(qualityLines(up), ["Qualidade automática: 720p 30 fps → 720p 60 fps para A (banda: estável há 10 s)"]);
        await h.runUntil(90_000);
        assert.equal(h.controller.levelFor("A"), "720p60");

        a.set({ availableKbps: 20_000 });
        await h.runUntil(92_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.equal(h.controller.state?.reason, null);
    });

    test("pronto de novo (renegociou) nao reinicia a carencia de banda", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim({ availableKbps: 500 }) });
        await h.join("A");
        await h.runUntil(10_000);
        h.controller.markReady("A");
        await h.runUntil(BW_GRACE_MS + 2000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        await h.runUntil(BW_GRACE_MS + 4000);
        assert.equal(h.controller.levelFor("A"), "720p60", "a carencia contou desde a 1a vez");
    });
});
