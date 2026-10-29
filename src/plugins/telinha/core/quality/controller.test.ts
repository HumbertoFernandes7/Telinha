/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts) com um RTCRtpSender falso: as estatisticas vem de um
// EncoderSim (test/fakes/webrtc.ts), cujos contadores acompanham o relogio falso (test/fakes/clock.ts). O controller
// roda evaluate() a cada 2 s (streaming.ts → tick); aqui o teste chama evaluate() nesses instantes.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { QualityLevel } from "@plugins/telinha/types";
import { type FakeClock, useFakeClock } from "@test/fakes/clock";
import { EncoderSim, FakeRTCRtpSender, videoTrack } from "@test/fakes/webrtc";

import { QualityController, type QualityDeps } from "./controller";
import { BW_GRACE_MS } from "./levels";

const EVAL_MS = 2000;

interface Harness {
    controller: QualityController;
    /** degraus aplicados (setParameters), em ordem, com o instante relativo ao inicio */
    applied: { peerId: string; level: QualityLevel; atMs: number; }[];
    /** avanca o relogio ate `atMs` (relativo ao inicio) e roda uma avaliacao */
    evaluateAt(atMs: number): Promise<void>;
}

function harness(clock: FakeClock, sims: Record<string, EncoderSim>, deps: Partial<QualityDeps> = {}): Harness {
    const start = clock.now();
    const senders = new Map<string, FakeRTCRtpSender>();
    for (const [peerId, sim] of Object.entries(sims)) {
        const sender = new FakeRTCRtpSender(videoTrack());
        sim.attach(sender);
        senders.set(peerId, sender);
    }
    const applied: Harness["applied"] = [];
    const controller = new QualityController({
        ceiling: "1080p60",
        enabled: () => true,
        sender: peerId => (senders.get(peerId) ?? null) as unknown as RTCRtpSender | null,
        apply: async (peerId, level) => {
            applied.push({ peerId, level, atMs: clock.now() - start });
            return true;
        },
        label: peerId => peerId,
        captureSize: () => ({ width: 1920, height: 1080 }),
        motion: () => null,
        sourceFrames: () => { },
        changed: () => { },
        ...deps
    });
    return {
        controller,
        applied,
        async evaluateAt(atMs) {
            clock.tick(atMs - (clock.now() - start));
            await controller.evaluate();
        }
    };
}

describe("qualidade automatica: carencia de banda do espectador novo (levels.BW_GRACE_MS)", () => {
    test("a carencia e de 20 s", () => {
        assert.equal(BW_GRACE_MS, 20_000);
    });

    test("espectador novo com 500 kbps estimados: aos 10 s nao desce; desce depois da carencia + 3 janelas ruins", async t => {
        const clock = useFakeClock(t);
        // banda estimada de 0,5 Mbps desde o inicio (a estimativa oscila nos primeiros segundos de um espectador novo)
        const h = harness(clock, { A: new EncoderSim({ availableKbps: 500 }) });
        h.controller.addViewer("A");
        h.controller.markReady("A"); // readyAt = 0: comeca a carencia
        await Promise.resolve();
        assert.deepEqual(h.applied.map(a => a.level), ["1080p60"], "pronto: entra no teto");

        for (let at = EVAL_MS; at <= 10_000; at += EVAL_MS) await h.evaluateAt(at);
        assert.equal(h.controller.levelFor("A"), "1080p60", "aos 10 s ainda esta na carencia");

        // a carencia acaba em 20 s: as janelas ruins contam de 20 s em diante (BW_STREAK = 3 janelas seguidas)
        for (let at = 12_000; at < BW_GRACE_MS; at += EVAL_MS) await h.evaluateAt(at);
        assert.equal(h.controller.levelFor("A"), "1080p60", "ate o fim da carencia nada muda");
        await h.evaluateAt(BW_GRACE_MS);
        await h.evaluateAt(BW_GRACE_MS + EVAL_MS);
        assert.equal(h.controller.levelFor("A"), "1080p60", "2 janelas ruins depois da carencia ainda nao bastam");

        await h.evaluateAt(BW_GRACE_MS + 2 * EVAL_MS);
        // conteudo em movimento (sem leitura de movimento e fonte a 60 fps): de 1080p60 vai para 720p60
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.deepEqual(h.applied.map(a => [a.level, a.atMs]), [["1080p60", 0], ["720p60", BW_GRACE_MS + 2 * EVAL_MS]]);
        assert.deepEqual(h.controller.state?.viewers.A, { level: "720p60", reason: "bandwidth" });
        assert.match(h.controller.state?.reasonText ?? "", /^720p 60 fps — a conexão com o espectador está limitada$/);
    });

    test("espectador que ja passou da carencia: a mesma queda de banda desce depois de 3 janelas (6 s), sem esperar 20 s", async t => {
        const clock = useFakeClock(t);
        const sim = new EncoderSim({ availableKbps: 20_000 });
        const h = harness(clock, { A: sim });
        h.controller.addViewer("A");
        h.controller.markReady("A");
        for (let at = EVAL_MS; at <= 30_000; at += EVAL_MS) await h.evaluateAt(at);
        assert.equal(h.controller.levelFor("A"), "1080p60", "banda boa: fica no teto");

        sim.set({ availableKbps: 500 });
        await h.evaluateAt(32_000);
        await h.evaluateAt(34_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        await h.evaluateAt(36_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.equal(h.applied.at(-1)?.atMs, 36_000);
    });
});
