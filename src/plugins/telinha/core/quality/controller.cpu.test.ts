/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts) limitada pelo PROCESSADOR (encoders por software), da
// configuracao autoQuality, da captura redimensionada, das falhas ao aplicar um degrau e da amostragem. Os espectadores
// sao EncoderSim (libvpx) e o relogio e o falso; evaluate() roda a cada 2 s (test/helpers/wpb-quality.ts).
// Tempos: aquecimento de 6 s (o 1o resumo conta na avaliacao das 6 s), 4 s de acomodacao depois de cada mudanca,
// 6 s entre duas descidas, 15 s depois de uma descida para o "cpu" do WebRTC voltar a contar, 10 s estavel para subir.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.cpu.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type StatsEntry, type WebRtcEnv } from "@test/fakes/webrtc";
import { logsDuring, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

/** O encoder nao mantem os 60 fps da fonte e esta ocupado: falta CPU. */
const SHORT = { fps: 40, encodeBusy: 0.8 } as const;
const OK = { fps: 60, encodeBusy: 0.2 } as const;

let rtc: WebRtcEnv;
// 8 threads: orcamento de 4 nucleos codificando (cpuBudget)
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

describe("CPU: o encoder nao mantem o fps da fonte", () => {
    test("2 janelas curtas descem um degrau; a 3a descida espera 6 s; no piso so avisa (uma vez por minuto)", async t => {
        const clock = useFakeClock(t);
        const sim = new EncoderSim(SHORT);
        const h = qualityHarness(clock, { A: sim });
        await h.join("A");

        await h.runUntil(6000);
        assert.equal(h.controller.levelFor("A"), "1080p60", "1 janela curta nao basta");
        const first = await logsDuring(() => h.runUntil(8000));
        assert.equal(h.controller.levelFor("A"), "720p60", "conteudo em movimento: mantem 60 fps");
        assert.deepEqual(qualityLines(first), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para o espectador (CPU: A codificado a 40 de 60 fps); nova subida só após 10 s estável"
        ]);
        assert.deepEqual(h.controller.state, {
            current: "720p60", reason: "cpu", reasonText: "720p 60 fps — o processador está sobrecarregado",
            viewers: { A: { level: "720p60", reason: "cpu" } }
        });
        assert.equal(h.lastApplied("A"), "720p60");

        // acomodacao ate 12 s, 2 janelas curtas (12 s e 14 s): 720p30
        await h.runUntil(12_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(14_000);
        assert.equal(h.controller.levelFor("A"), "720p30");

        // a 20 fps nem 720p30 (30 fps) se mantem: ja no piso, so avisa, e nao repete o aviso a cada janela
        sim.set({ fps: 20 });
        const floor = await logsDuring(() => h.runUntil(60_000));
        assert.equal(h.controller.levelFor("A"), "720p30");
        assert.deepEqual(qualityLines(floor), ["Qualidade automática: já no mínimo (720p 30 fps) e ainda limitado por CPU — A codificado a 20 de 30 fps"]);
    });

    test("quadros a menos que nao sao CPU: rede saturada, encoder folgado, banda limitada, fonte lenta", async t => {
        const clock = useFakeClock(t);
        const cases = {
            // estimativa abaixo do teto do degrau e enviando quase tudo: e o controle de taxa descartando quadros
            redeSaturada: new EncoderSim({ ...SHORT, availableKbps: 5000, kbps: 8000 }),
            encoderFolgado: new EncoderSim({ fps: 40, encodeBusy: 0.3 }),
            bandaLimitada: new EncoderSim({ ...SHORT, limitation: "bandwidth" }),
            fonteLenta: new EncoderSim({ fps: 5, sourceFps: 15, encodeBusy: 0.8 })
        };
        for (const [name, sim] of Object.entries(cases)) {
            const h = qualityHarness(clock, { [name]: sim });
            await h.join(name);
            const lines = await logsDuring(() => h.runUntil(h.elapsed() + 30_000));
            assert.equal(h.controller.levelFor(name), "1080p60", name);
            assert.deepEqual(qualityLines(lines), [], name);
        }
    });
});

describe("CPU: o WebRTC reduzindo a resolucao por conta propria", () => {
    test("abaixo do degrau por CPU em 2 janelas: desce; o proximo so 15 s depois (o WebRTC demora a desfazer a reducao dele)", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim({ width: 1066, height: 600, limitation: "cpu" }) });
        await h.join("A");
        const lines = await logsDuring(() => h.runUntil(8000));
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para o espectador (CPU: o WebRTC reduziu A para 600p por CPU (degrau 1080p)); nova subida só após 10 s estável"
        ]);

        // 600p continua abaixo de 85% de 720p, mas so conta 15 s depois da descida
        await h.runUntil(22_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        await h.runUntil(24_000);
        assert.equal(h.controller.levelFor("A"), "720p30");
    });

    test("conteudo parado (movimento baixo, ou fonte abaixo de 15 fps): de 1080p60 desce para 1080p30, mantendo a nitidez", async t => {
        const clock = useFakeClock(t);
        const binding = { width: 1066, height: 600, limitation: "cpu" } as const;
        const still = qualityHarness(clock, { A: new EncoderSim(binding) }, { motion: () => 0.1 });
        await still.join("A");
        await still.runUntil(8000);
        assert.equal(still.controller.levelFor("A"), "1080p30");

        const slow = qualityHarness(clock, { B: new EncoderSim({ ...binding, sourceFps: 10 }) });
        await slow.join("B");
        await slow.runUntil(slow.elapsed() + 8000);
        assert.equal(slow.controller.levelFor("B"), "1080p30");
    });
});

describe("CPU: subir de volta", () => {
    test("sobe depois de 10 s estavel; descer de novo logo em seguida dobra a espera; 2 min depois da descida ela volta a 10 s", async t => {
        const clock = useFakeClock(t);
        const sim = new EncoderSim(SHORT);
        const h = qualityHarness(clock, { A: sim });
        await h.join("A");
        await h.runUntil(8000);
        assert.equal(h.controller.levelFor("A"), "720p60");

        sim.set(OK);
        await h.runUntil(16_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "estavel ha 8 s");
        const up = await logsDuring(() => h.runUntil(18_000));
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.deepEqual(qualityLines(up), ["Qualidade automática: 720p 60 fps → 1080p 60 fps para o espectador (CPU: estável há 10 s)"]);
        assert.equal(h.controller.state?.reason, null);

        // nao aguentou: desce 6 s depois de subir (menos de 30 s) e a proxima subida espera 20 s
        sim.set(SHORT);
        const again = await logsDuring(() => h.runUntil(24_000));
        assert.match(qualityLines(again)[0] ?? "", /1080p 60 fps → 720p 60 fps .*; nova subida só após 20 s estável$/);
        sim.set(OK);
        await h.runUntil(42_000);
        assert.equal(h.controller.levelFor("A"), "720p60", "estavel ha 18 s");
        await h.runUntil(44_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");

        // 2 min depois da ultima descida a espera volta a 10 s (e a descida seguinte, longe da subida, nao dobra)
        await h.runUntil(150_000);
        sim.set(SHORT);
        const late = await logsDuring(() => h.runUntil(154_000));
        assert.match(qualityLines(late)[0] ?? "", /1080p 60 fps → 720p 60 fps .*; nova subida só após 10 s estável$/);
    });

    test("so sobe quando a previsao de CPU no degrau de cima cabe (no maximo 75% de um nucleo por encoder)", async t => {
        const clock = useFakeClock(t);
        const sim = new EncoderSim(SHORT);
        const h = qualityHarness(clock, { A: sim });
        await h.join("A");
        await h.runUntil(8000);

        // em 720p60 gasta 70% de um nucleo: em 1080p60 (2,25x os pixels) seria 157%
        sim.set({ fps: 60, encodeBusy: 0.7, width: 1280, height: 720 });
        const lines = await logsDuring(() => h.runUntil(70_000));
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.deepEqual(qualityLines(lines), []);

        // 30%: 68% previstos, cabe
        sim.set({ encodeBusy: 0.3 });
        await h.runUntil(74_000);
        assert.equal(h.controller.levelFor("A"), "1080p60");
    });
});

describe("CPU: antes de um espectador novo (previsao)", () => {
    test("mais um encode nao cabe no orcamento: desce todos antes, um ou dois degraus", async t => {
        const clock = useFakeClock(t);
        // 3 nucleos por encoder: 2 encoders em 1080p60 = 6 (> 4); em 720p60 = 2,7
        const one = qualityHarness(clock, { A: new EncoderSim({ encodeBusy: 3 }), B: new EncoderSim() });
        await one.join("A");
        await one.runUntil(6000);
        const lines = await logsDuring(() => one.controller.addViewer("B"));
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para os 2 espectadores (CPU: mais um espectador: previsão de 6.0 núcleos codificando "
            + "para 2 espectadores); nova subida só após 10 s estável"
        ]);
        assert.equal(one.lastApplied("A"), "720p60", "o que ja estava no ar desce na hora");
        assert.equal(one.controller.state?.reasonText, "720p 60 fps — o processador não dá conta de 2 espectadores");

        // 5 nucleos por encoder: em 720p60 ainda seriam 4,4: vai direto a 720p30
        const two = qualityHarness(clock, { A: new EncoderSim({ encodeBusy: 5 }), B: new EncoderSim() });
        await two.join("A");
        await two.runUntil(two.elapsed() + 6000);
        const lines2 = await logsDuring(() => two.controller.addViewer("B"));
        assert.match(qualityLines(lines2)[0] ?? "", /^Qualidade automática: 1080p 60 fps → 720p 30 fps para os 2 espectadores \(CPU: mais um espectador: previsão de 4\.4 núcleos/);
    });

    test("captura de tamanho desconhecido (0x0) e fonte sem fps: conta com o tamanho e o fps do degrau", async t => {
        const clock = useFakeClock(t);
        const unknown = { captureSize: () => ({ width: 0, height: 0 }) };
        const h = qualityHarness(clock, { A: new EncoderSim({ encodeBusy: 3, sourceFps: null }), B: new EncoderSim() }, unknown);
        await h.join("A");
        await h.runUntil(6000);
        const lines = await logsDuring(() => h.controller.addViewer("B"));
        assert.match(qualityLines(lines)[0] ?? "", /previsão de 6\.0 núcleos codificando para 2 espectadores/, "1920x1080 a 60 fps, como medido");

        const binding = qualityHarness(clock, { C: new EncoderSim({ width: 1066, height: 600, limitation: "cpu" }) }, unknown);
        await binding.join("C");
        const lines2 = await logsDuring(() => binding.runUntil(binding.elapsed() + 8000));
        assert.match(qualityLines(lines2)[0] ?? "", /o WebRTC reduziu C para 600p por CPU \(degrau 1080p\)/);
    });

    test("sem navigator.hardwareConcurrency o orcamento e de 2 nucleos (4 threads)", async t => {
        const clock = useFakeClock(t);
        const withZero = installWebRtc({ hardwareConcurrency: 0 });
        const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
        try {
            const h = qualityHarness(clock, { A: new EncoderSim({ encodeBusy: 1.2 }), B: new EncoderSim(), C: new EncoderSim() });
            await h.join("A");
            await h.runUntil(6000);
            h.controller.addViewer("B"); // 2,4 nucleos previstos > 2
            assert.equal(h.controller.levelFor("A"), "720p60");

            // sem navigator nenhum (fora do navegador): o mesmo orcamento
            Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
            const g = qualityHarness(clock, { A: new EncoderSim({ encodeBusy: 1.2 }), B: new EncoderSim() });
            await g.join("A");
            await g.runUntil(g.elapsed() + 6000);
            g.controller.addViewer("B");
            assert.equal(g.controller.levelFor("A"), "720p60");
        } finally {
            if (saved) Object.defineProperty(globalThis, "navigator", saved);
            withZero.restore();
        }
    });
});

describe("configuracao autoQuality", () => {
    test("ligada de novo: todos voltam ao teto; desligada: o teto para todos, sem estado e sem decidir", async t => {
        const clock = useFakeClock(t);
        let enabled = true;
        const sim = new EncoderSim(SHORT);
        const h = qualityHarness(clock, { A: sim, B: new EncoderSim() }, { enabled: () => enabled });
        await h.join("A");
        await h.runUntil(8000);
        assert.equal(h.controller.levelFor("A"), "720p60");

        const on = await logsDuring(() => h.controller.settingChanged());
        assert.deepEqual(on, ["Qualidade automática ligada (teto 1080p 60 fps)"]);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        assert.equal(h.lastApplied("A"), "1080p60");
        assert.equal(h.controller.state?.reason, null);

        enabled = false;
        const { changes } = h;
        const off = await logsDuring(() => h.controller.settingChanged());
        assert.deepEqual(off, ["Qualidade automática desligada: todos recebem 1080p 60 fps"]);
        assert.equal(h.controller.state, null);
        assert.equal(h.changes, changes + 1);

        const later = await logsDuring(() => h.runUntil(60_000));
        assert.deepEqual(qualityLines(later), [], "desligada: nao decide nada");
        assert.equal(h.controller.levelFor("A"), "1080p60");
        h.controller.addViewer("B");
        assert.equal(h.controller.levelFor("B"), "1080p60");
    });
});

describe("aplicar o degrau", () => {
    test("captura redimensionada: reaplica o mesmo degrau a quem esta pronto", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim() });
        h.controller.addViewer("B"); // ainda sem sender: nada a aplicar
        await h.join("A");
        h.controller.captureResized();
        await Promise.resolve();
        assert.deepEqual(h.applied.map(a => [a.peerId, a.level]), [["A", "1080p60"], ["A", "1080p60"]]);
    });

    test("apply falhou (false ou erro): tenta de novo na proxima avaliacao, e so ate dar certo", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim() });
        h.applyImpl = () => false;
        await h.join("A");
        await h.runUntil(2000);
        assert.equal(h.applied.length, 2, "falhou de novo na avaliacao das 2 s");

        h.applyImpl = () => Promise.reject(new Error("InvalidModificationError"));
        await h.runUntil(4000);
        await Promise.resolve();
        assert.equal(h.applied.length, 3);

        h.applyImpl = () => true;
        await h.runUntil(6000);
        await h.runUntil(10_000);
        assert.equal(h.applied.length, 4, "deu certo as 6 s; depois disso, nada");

        // redimensionada com o apply falhando: o pedido de reaplicar fica para a proxima avaliacao
        h.applyImpl = () => false;
        h.controller.captureResized();
        await Promise.resolve();
        h.applyImpl = () => Promise.reject(new Error("x"));
        await h.runUntil(12_000);
        await Promise.resolve();
        h.applyImpl = () => true;
        await h.runUntil(14_000);
        await h.runUntil(16_000);
        assert.equal(h.applied.length, 7);
    });

    test("apply em andamento: o pedido seguinte espera e vai com o degrau novo; espectador que saiu ou fim da transmissao nao reaplicam", async t => {
        const clock = useFakeClock(t);
        const pending: ((ok: boolean) => void)[] = [];
        const h = qualityHarness(clock, { A: new EncoderSim({ encodeBusy: 3 }), B: new EncoderSim(), C: new EncoderSim() });
        h.applyImpl = () => new Promise<boolean>(resolve => pending.push(resolve));
        await h.join("A");
        await h.runUntil(6000);
        assert.equal(h.applied.length, 1, "o 1o apply nao terminou: as avaliacoes nao mandam outro");

        h.controller.addViewer("B"); // previsao de CPU: o degrau global desce para 720p60 com o apply de A no ar
        pending.shift()!(true);
        await flushPromises();
        assert.deepEqual(h.applied.map(a => a.level), ["1080p60", "720p60"], "terminou e reaplicou com o degrau novo");

        h.controller.captureResized(); // A ainda aplicando 720p60: fica marcado para reaplicar
        pending.shift()!(true);
        await flushPromises();
        assert.equal(h.applied.length, 3, "reaplicou por causa da captura redimensionada");

        h.controller.removeViewer("A");
        pending.shift()!(true);
        await flushPromises();
        assert.equal(h.applied.length, 3, "saiu: nao reaplica");

        h.controller.markReady("B");
        h.controller.dispose();
        pending.shift()!(true);
        await flushPromises();
        assert.equal(h.applied.length, 4, "so o apply de B, que terminou com a transmissao ja encerrada");
    });
});

describe("amostragem", () => {
    test("sem sender ou getStats com erro: sem medida e sem decisao; o contador de quadros da fonte vai do 1o que tiver", async t => {
        const clock = useFakeClock(t);
        const fed: [string, number][] = [];
        const broken = new EncoderSim(SHORT);
        const h = qualityHarness(clock, { B: broken, C: new EncoderSim({ ...SHORT, sourceFps: null }), D: new EncoderSim(SHORT) }, {
            sourceFrames: (key, frames) => fed.push([key, frames])
        });
        h.senders.get("B")!.stats = () => {
            throw new Error("getStats falhou");
        };
        for (const id of ["A", "B", "C", "D"]) await h.join(id); // A nao tem sender
        await h.runUntil(4000);
        assert.deepEqual(fed, [["D", 120], ["D", 240]], "C nao relata quadros da fonte: vai o de D, um por avaliacao");

        // C tambem esta curto, mas sem o fps da fonte nao da para julgar: quem desce e D
        const lines = await logsDuring(() => h.runUntil(8000));
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.match(qualityLines(lines)[0] ?? "", /\(CPU: D codificado a 40 de 60 fps\)/);
    });

    test("uma avaliacao por vez; descartado no meio de uma, nao decide nem aplica; depois de descartado tudo e ignorado", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim(SHORT) });
        await h.join("A");
        const sender = h.senders.get("A")!;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const real = sender.stats as () => StatsEntry[];
        sender.stats = async () => {
            await gate;
            return real();
        };
        const first = h.controller.evaluate();
        await h.controller.evaluate(); // ja avaliando: volta na hora
        assert.equal(sender.getStatsCalls, 1);

        h.controller.dispose();
        release();
        await first;
        const { changes } = h;
        h.controller.addViewer("B");
        h.controller.markReady("A");
        h.controller.captureResized();
        h.controller.settingChanged();
        await h.controller.evaluate();
        assert.equal(sender.getStatsCalls, 1);
        assert.equal(h.applied.length, 1);
        assert.equal(h.changes, changes);
    });
});

describe("estado publicado", () => {
    test("sem espectadores: o degrau global e o motivo dele; repetidos e desconhecidos nao mudam nada", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, { A: new EncoderSim(SHORT) });
        await h.join("A");
        await h.runUntil(8000);
        h.controller.removeViewer("A");
        assert.deepEqual(h.controller.state, {
            current: "720p60", reason: "cpu", reasonText: "720p 60 fps — o processador está sobrecarregado", viewers: {}
        });
        assert.equal(h.controller.levelFor("A"), "720p60", "quem entrar agora recebe o degrau global");

        const { changes } = h;
        h.controller.removeViewer("A");
        h.controller.markReady("X");
        h.controller.addViewer("B");
        h.controller.addViewer("B");
        assert.equal(h.changes, changes + 1, "so a 1a entrada de B muda o estado");
        assert.equal(h.applied.length, 2);
    });
});
