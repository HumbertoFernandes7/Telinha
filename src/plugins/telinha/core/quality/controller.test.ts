/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da qualidade automatica (core/quality/controller.ts) com um RTCRtpSender falso: as estatisticas vem de um
// EncoderSim (test/fakes/webrtc.ts), cujos contadores acompanham o relogio falso (test/fakes/clock.ts). O controller
// roda evaluate() a cada 2 s (streaming.ts → tick); aqui o teste chama evaluate() nesses instantes
// (test/helpers/wpb-quality.ts). A placa de video e o GpuSim do mesmo helper: um encoder compartilhado com os tempos
// medidos numa RTX 3070.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { type EncoderRates, EncoderSim, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { EVAL_MS, GpuSim, logsDuring, measuredFrameMs, NVENC_IMPLEMENTATION, type QualityHarness, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

import { BW_GRACE_MS } from "./levels";

describe("qualidade automatica: carencia de banda do espectador novo (levels.BW_GRACE_MS)", () => {
    test("a carencia e de 20 s", () => {
        assert.equal(BW_GRACE_MS, 20_000);
    });

    test("espectador novo com 500 kbps estimados: na carencia nada conta; depois, caminho estreito desce 14 s depois", async t => {
        const clock = useFakeClock(t);
        // banda estimada de 0,5 Mbps desde o inicio (a estimativa oscila nos primeiros segundos de um espectador novo)
        const h = qualityHarness(clock, { A: new EncoderSim({ availableKbps: 500 }) });
        h.controller.addViewer("A");
        h.controller.markReady("A"); // readyAt = 0: comeca a carencia
        await Promise.resolve();
        assert.deepEqual(h.applied.map(a => a.level), ["1080p60"], "pronto: entra no teto");

        for (let at = EVAL_MS; at <= 10_000; at += EVAL_MS) await h.evaluateAt(at);
        assert.equal(h.controller.levelFor("A"), "1080p60", "aos 10 s ainda esta na carencia");

        // a carencia acaba em 20 s: a 1a janela que conta e a de 18-20 s; a estimativa nunca deu os 4500 do 1080p60
        // (caminho estreito): desce depois de 14 s seguidos de banda curta
        for (let at = 12_000; at <= BW_GRACE_MS + 10_000; at += EVAL_MS) await h.evaluateAt(at);
        assert.equal(h.controller.levelFor("A"), "1080p60", "12 s de banda curta ainda nao bastam");

        await h.evaluateAt(BW_GRACE_MS + 12_000);
        // conteudo em movimento (sem leitura de movimento e fonte a 60 fps): de 1080p60 vai para 720p60
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.deepEqual(h.applied.map(a => [a.level, a.atMs]), [["1080p60", 0], ["720p60", BW_GRACE_MS + 12_000]]);
        assert.deepEqual(h.controller.state?.viewers.A, { level: "720p60", reason: "bandwidth" });
        assert.match(h.controller.state?.reasonText ?? "", /^720p 60 fps — a conexão com o espectador está limitada$/);
    });

    test("espectador que ja passou da carencia, com a banda que ja deu o degrau: a mesma queda so desce depois de 30 s", async t => {
        const clock = useFakeClock(t);
        const sim = new EncoderSim({ availableKbps: 20_000 });
        const h = qualityHarness(clock, { A: sim });
        h.controller.addViewer("A");
        h.controller.markReady("A");
        for (let at = EVAL_MS; at <= 30_000; at += EVAL_MS) await h.evaluateAt(at);
        assert.equal(h.controller.levelFor("A"), "1080p60", "banda boa: fica no teto");

        // depois de um soluco o estimador do WebRTC leva ~20-25 s para voltar: so a banda curta espera 30 s
        sim.set({ availableKbps: 500 });
        for (let at = 32_000; at <= 58_000; at += EVAL_MS) await h.evaluateAt(at);
        assert.equal(h.controller.levelFor("A"), "1080p60");
        await h.evaluateAt(60_000);
        assert.equal(h.controller.levelFor("A"), "720p60");
        assert.equal(h.applied.at(-1)?.atMs, 60_000);
    });
});

// Limite da placa de video medido por PC: o tempo por quadro dos encoders por hardware (mediana) contra o intervalo
// entre quadros (16,7 ms a 60 fps). RTX 3070: 1 espectador 4,3 ms, 5 8,9 ms, 8 12,4 ms, 9 14-15 ms, 10 188 ms (saturada).
describe("qualidade automatica: limite da placa de video (encoder por hardware)", () => {
    let rtc: WebRtcEnv;
    // 8 threads = orcamento de 4 nucleos para a logica de CPU: com o tempo da placa contado como CPU, 7 espectadores
    // ja passariam disso (7 x 10,1 ms x 60 fps = 4,2 "nucleos"); aqui so a placa de video limita
    before(() => {
        rtc = installWebRtc({ hardwareConcurrency: 8 });
    });
    after(() => rtc.restore());

    /** Entra um espectador a cada 6 s (3 janelas: os ja presentes medem a carga nova antes do proximo). */
    async function joinOneByOne(h: QualityHarness, gpu: GpuSim, from: number, to: number) {
        for (let i = from; i <= to; i++) {
            await gpu.join(`P${i}`);
            await h.runUntil(h.elapsed() + 3 * EVAL_MS);
        }
    }

    const levels = (h: QualityHarness, n: number) => Array.from({ length: n }, (_, i) => h.controller.levelFor(`P${i + 1}`));

    test("o modelo da placa reproduz o medido", () => {
        assert.equal(measuredFrameMs(1), 4.3);
        assert.equal(measuredFrameMs(8), 12.4);
        assert.equal(measuredFrameMs(10), 188);
        // 720p60 = 44% dos pixels de 1080p60: 10 x 720p60 ~ 4,4 espectadores 1080p60 (medido: 49% do encoder, tranquilo)
        assert.ok(measuredFrameMs(10 * 1280 * 720 / (1920 * 1080)) < 9);
    });

    test("1 espectador (4,3 ms por quadro): fica em 1080p60", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h);
        await gpu.join("P1");
        await h.runUntil(60_000);
        assert.equal(gpu.frameMs(), 4.3);
        assert.equal(h.controller.levelFor("P1"), "1080p60");
        assert.equal(h.controller.state?.reason, null);
    });

    test("8 espectadores entrando um a um (12,4 ms por quadro): todos ficam em 1080p60, sem descer por CPU", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h);
        const lines = await logsDuring(async () => {
            await joinOneByOne(h, gpu, 1, 8);
            await h.runUntil(h.elapsed() + 60_000);
        });
        assert.equal(gpu.frameMs(), 12.4);
        assert.deepEqual(levels(h, 8), Array(8).fill("1080p60"));
        assert.equal(h.controller.state?.reason, null);
        assert.deepEqual(qualityLines(lines), [], "nenhuma decisao da qualidade automatica");
        assert.ok(h.applied.every(a => a.level === "1080p60"));
    });

    test("o 9o espectador: previsao de 13,6 ms passa do limite (13,3 ms) e todos descem para 720p60 antes de ele comecar", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h);
        await joinOneByOne(h, gpu, 1, 8);
        assert.deepEqual(levels(h, 8), Array(8).fill("1080p60"));

        const joinedAt = h.elapsed();
        gpu.add("P9");
        const lines = await logsDuring(async () => {
            h.controller.addViewer("P9", true);
            await Promise.resolve();
        });
        // desce na hora: os 8 encoders no ar recebem 720p60 antes de o 9o ficar pronto
        assert.deepEqual(levels(h, 9), Array(9).fill("720p60"));
        const now = h.applied.filter(a => a.atMs === joinedAt);
        assert.deepEqual(now.map(a => [a.peerId, a.level]), levels(h, 8).map((_, i) => [`P${i + 1}`, "720p60"]));
        assert.equal(h.lastApplied("P9"), undefined, "o 9o ainda nao comecou");
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para os 9 espectadores (placa de vídeo: mais um espectador: previsão de 13.6 ms "
            + "por quadro com 9 espectadores em 1080p 60 fps, o limite é 13.3 ms); nova subida só após 10 s estável"
        ]);
        const { state } = h.controller;
        assert.equal(state?.reason, "gpu");
        assert.equal(state?.reasonText, "720p 60 fps — a placa de vídeo não dá conta de 9 espectadores");
        assert.deepEqual(state?.viewers.P1, { level: "720p60", reason: "gpu" });

        h.controller.markReady("P9");
        await Promise.resolve();
        assert.equal(h.lastApplied("P9"), "720p60", "o 9o ja entra em 720p60");

        // 9 x 720p60 = 4 espectadores 1080p60 (7,8 ms): fica, e nao sobe (1080p60 com 9 = 13,5 ms previstos > 10 ms)
        const later = await logsDuring(() => h.runUntil(h.elapsed() + 120_000));
        assert.ok(gpu.frameMs() < 8);
        assert.deepEqual(levels(h, 9), Array(9).fill("720p60"));
        assert.deepEqual(qualityLines(later), []);
    });

    test("9 espectadores de uma vez (nada medido para prever): 14,5 ms por 2 janelas e desce para 720p60", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h);
        for (let i = 1; i <= 9; i++) await gpu.join(`P${i}`);
        assert.equal(gpu.frameMs(), 14.5);
        assert.deepEqual(levels(h, 9), Array(9).fill("1080p60"), "sem medida, nao ha previsao");

        // aquecimento de 6 s; acima do limite as 6 s (1a janela) e as 8 s (2a): desce
        const lines = await logsDuring(() => h.runUntil(6000));
        assert.deepEqual(qualityLines(lines), []);
        assert.equal(h.controller.levelFor("P1"), "1080p60", "uma janela acima do limite nao basta");
        const second = await logsDuring(() => h.runUntil(8000));
        assert.deepEqual(levels(h, 9), Array(9).fill("720p60"));
        assert.deepEqual(qualityLines(second), [
            "Qualidade automática: 1080p 60 fps → 720p 60 fps para os 9 espectadores (placa de vídeo: mediana de 14.5 ms por quadro em 9 encoders "
            + "da placa, o limite é 13.3 ms); nova subida só após 10 s estável"
        ]);
        assert.equal(h.controller.state?.reasonText, "720p 60 fps — a placa de vídeo não dá conta de 9 espectadores");
    });

    test("10 espectadores: a placa satura (188 ms), desce para 720p60 em 2 janelas e fica la", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h);
        for (let i = 1; i <= 10; i++) await gpu.join(`P${i}`);
        assert.equal(gpu.frameMs(), 188);
        await h.runUntil(8000);
        assert.deepEqual(levels(h, 10), Array(10).fill("720p60"));
        assert.equal(h.controller.state?.reason, "gpu");
        assert.equal(h.controller.state?.reasonText, "720p 60 fps — a placa de vídeo não dá conta de 10 espectadores");

        // 10 x 720p60 = 49% do encoder (8,3 ms): nem desce mais, nem volta para 1080p60
        const later = await logsDuring(() => h.runUntil(h.elapsed() + 180_000));
        assert.ok(gpu.frameMs() < 9);
        assert.deepEqual(levels(h, 10), Array(10).fill("720p60"));
        assert.deepEqual(qualityLines(later), []);
    });

    test("10 espectadores com a qualidade escolhida em 720p60: ficam em 720p60, sem motivo", async t => {
        const clock = useFakeClock(t);
        const capture = { width: 1280, height: 720 };
        const h = qualityHarness(clock, {}, { ceiling: "720p60", captureSize: () => capture });
        const gpu = new GpuSim(h, { capture });
        const lines = await logsDuring(async () => {
            await joinOneByOne(h, gpu, 1, 10);
            await h.runUntil(h.elapsed() + 60_000);
        });
        assert.ok(gpu.frameMs() < 9);
        assert.deepEqual(levels(h, 10), Array(10).fill("720p60"));
        assert.equal(h.controller.state?.reason, null);
        assert.deepEqual(qualityLines(lines), []);
    });

    test("placa 2x mais lenta (todos os tempos x2): 3 ficam em 1080p60 e o 4o desce todos", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h, { factor: 2 });
        await joinOneByOne(h, gpu, 1, 3);
        assert.equal(gpu.frameMs(), 13.2);
        assert.deepEqual(levels(h, 3), Array(3).fill("1080p60"));

        const lines = await logsDuring(() => joinOneByOne(h, gpu, 4, 4));
        assert.deepEqual(levels(h, 4), Array(4).fill("720p60"));
        assert.match(qualityLines(lines)[0] ?? "", /^Qualidade automática: 1080p 60 fps → 720p 60 fps para os 4 espectadores \(placa de vídeo: mais um espectador: previsão de 15\.5 ms/);
        assert.equal(h.controller.state?.reasonText, "720p 60 fps — a placa de vídeo não dá conta de 4 espectadores");
    });

    test("1 espectador numa placa 4x mais lenta (17,2 ms): desce, e o motivo fala de um encoder so", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h, { factor: 4 });
        await gpu.join("P1");
        const lines = await logsDuring(() => h.runUntil(8000));
        assert.equal(h.controller.levelFor("P1"), "720p60");
        assert.match(qualityLines(lines)[0] ?? "", /\(placa de vídeo: mediana de 17\.2 ms por quadro em 1 encoder da placa, o limite é 13\.3 ms\)/);
        assert.equal(h.controller.state?.reasonText, "720p 60 fps — a placa de vídeo está sobrecarregada");
    });

    test("com a placa no limite (8 em 1080p60): um espectador novo por software (VP9) nao entra na conta dela; sem palpite, entra", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h);
        await joinOneByOne(h, gpu, 1, 8);

        // VP9 (o espectador nao decodifica H.264 por hardware): libvpx, na CPU
        h.attach("S", new EncoderSim());
        const lines = await logsDuring(async () => {
            await h.join("S", false);
            await h.runUntil(h.elapsed() + 30_000);
        });
        assert.deepEqual(qualityLines(lines), []);
        assert.deepEqual([...levels(h, 8), h.controller.levelFor("S")], Array(9).fill("1080p60"));

        // addViewer sem dizer o codec: conta como os ja medidos (placa de video), e 9 encoders nela nao cabem
        gpu.add("P9");
        h.controller.addViewer("P9");
        assert.equal(h.controller.levelFor("P1"), "720p60");
        assert.equal(h.controller.state?.reason, "gpu");
    });

    test("encoder por software com os mesmos tempos: a placa de video nao entra na conta", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        // libvpx (powerEfficient false) a 14,5 ms por quadro: acima do limite da placa, mas e CPU; com 8 threads (4
        // nucleos de orcamento) e 0,87 nucleo por encoder, a CPU so aguenta 4
        const sims: EncoderSim[] = [];
        const lines = await logsDuring(async () => {
            for (let i = 1; i <= 4; i++) {
                const sim = new EncoderSim({ encodeBusy: 14.5 * 60 / 1000 });
                sims.push(sim);
                h.attach(`S${i}`, sim);
                await h.join(`S${i}`, false);
                await h.runUntil(h.elapsed() + 3 * EVAL_MS);
            }
            await h.runUntil(h.elapsed() + 30_000);
        });
        assert.deepEqual([1, 2, 3, 4].map(i => h.controller.levelFor(`S${i}`)), Array(4).fill("1080p60"));
        assert.deepEqual(qualityLines(lines), [], "14,5 ms por quadro no software nao e a placa de video");

        // o 5o: a logica de CPU de sempre (previsao de nucleos), com o motivo "CPU"
        h.attach("S5", new EncoderSim({ encodeBusy: 14.5 * 60 / 1000 }));
        const fifth = await logsDuring(() => h.join("S5", false));
        assert.equal(h.controller.levelFor("S1"), "720p60");
        assert.match(qualityLines(fifth)[0] ?? "", /^Qualidade automática: 1080p 60 fps → 720p 60 fps para os 5 espectadores \(CPU: mais um espectador: previsão de 4\.\d núcleos codificando para 5 espectadores\)/);
        assert.equal(h.controller.state?.reason, "cpu");
    });

    test("volta para 1080p60 quando espectadores saem e a previsao fica folgada (<= 60% do intervalo)", async t => {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock);
        const gpu = new GpuSim(h);
        await joinOneByOne(h, gpu, 1, 9);
        assert.equal(h.controller.levelFor("P1"), "720p60");

        // 7 em 720p60: 1080p60 daria 11,2 ms previstos (> 10 ms): fica
        gpu.leave("P9");
        gpu.leave("P8");
        const seven = await logsDuring(() => h.runUntil(h.elapsed() + 30_000));
        assert.deepEqual(levels(h, 7), Array(7).fill("720p60"));
        assert.deepEqual(qualityLines(seven), []);

        // 5 em 720p60: 1080p60 da 8,9 ms previstos: sobe na proxima janela (ja estavel ha mais de 10 s)
        gpu.leave("P7");
        gpu.leave("P6");
        const leftAt = h.elapsed();
        const five = await logsDuring(() => h.runUntil(leftAt + EVAL_MS));
        assert.deepEqual(levels(h, 5), Array(5).fill("1080p60"));
        assert.match(qualityLines(five)[0] ?? "", /^Qualidade automática: 720p 60 fps → 1080p 60 fps para os 5 espectadores \(placa de vídeo: estável há \d+ s, previsão de 8\.9 ms por quadro na placa\)$/);
        assert.equal(h.controller.state?.reason, null);
        assert.equal(h.controller.state?.reasonText, null);

        // de volta a 1080p60 com 5 (8,9 ms) e entrando ate 8 de novo: tudo cabe
        const again = await logsDuring(() => joinOneByOne(h, gpu, 6, 8));
        assert.deepEqual(levels(h, 8), Array(8).fill("1080p60"));
        assert.deepEqual(qualityLines(again), []);
    });
});

// Captura pela placa de video (WebRtcAllowWgcUsingTexture, deps.gpuCapture): o tempo por quadro do encoder inclui esperar o
// quadro capturado atras do jogo. Log de 02/11 (God of War, 2 espectadores em 1080p30): mediana de 29,8 ms por quadro,
// acima do limite, com os dois encoders codificando os ~29 fps da fonte inteiros; os dois desceram para 720p30 a toa.
describe("qualidade automatica: limite da placa de video com a captura pela placa de video", () => {
    let rtc: WebRtcEnv;
    before(() => {
        rtc = installWebRtc({ hardwareConcurrency: 8 });
    });
    after(() => rtc.restore());

    const SOURCE_FPS = 29.5;
    /** Um encoder NVENC a 29,8 ms por quadro codificando `fps` dos 29,5 da fonte, com `rates` por cima. */
    const nvenc = (fps: number, rates: Partial<EncoderRates> = {}) => new EncoderSim({
        mimeType: "video/H264", implementation: NVENC_IMPLEMENTATION, powerEfficient: true, fps, sourceFps: SOURCE_FPS, encodeBusy: 29.8 * fps / 1000, ...rates
    });

    /** Os 2 espectadores de 02/11 (L e S) em 1080p30, prontos em 0 s. */
    async function twoViewers(t: Parameters<typeof useFakeClock>[0], gpuCapture: boolean | undefined, sims: { L: EncoderSim; S: EncoderSim; }) {
        const clock = useFakeClock(t);
        const h = qualityHarness(clock, sims, { ceiling: "1080p30", ...(gpuCapture === undefined ? {} : { gpuCapture: () => gpuCapture }) });
        await h.join("L", true);
        await h.join("S", true);
        return h;
    }

    // o limite: 0,8 x o intervalo entre quadros da fonte (1000 / 29,5 = 33,9 ms) = 27,1 ms
    const OLD_DOWN = "Qualidade automática: 1080p 30 fps → 720p 30 fps para os 2 espectadores (placa de vídeo: mediana de 29.8 ms por quadro em 2 encoders da placa, o limite é 27.1 ms); nova subida só após 10 s estável";

    test("ligada, os encoders acompanhando a fonte (29,5 de 29,5 fps): fica em 1080p30, e o log diz por que (uma linha a cada 5 min)", async t => {
        const h = await twoViewers(t, true, { L: nvenc(SOURCE_FPS), S: nvenc(SOURCE_FPS) });
        const lines = await logsDuring(() => h.runUntil(600_000));
        assert.deepEqual(qualityLines(lines), []);
        assert.deepEqual([h.controller.levelFor("L"), h.controller.levelFor("S")], ["1080p30", "1080p30"]);
        assert.deepEqual(h.applied.map(a => a.level), ["1080p30", "1080p30"]);
        const latency = lines.filter(l => l.startsWith("Placa de vídeo:"));
        assert.equal(latency.length, 2, "aos 6 s e 5 min depois");
        assert.equal(latency[0], "Placa de vídeo: mediana de 29.8 ms por quadro em 2 encoders da placa, o limite é 27.1 ms, mas os encoders acompanham a fonte "
            + "(codificando 100% dos quadros esperados): com a captura pela placa de vídeo é espera atrás do jogo, a qualidade fica");
    });

    test("ligada, os encoders ficando para tras (24 de 29,5 fps, 81%): desce em 2 janelas, e o motivo diz quanto codificam", async t => {
        const h = await twoViewers(t, true, { L: nvenc(24), S: nvenc(24) });
        await h.runUntil(6000);
        assert.equal(h.controller.levelFor("L"), "1080p30", "uma janela nao basta");
        const lines = await logsDuring(() => h.runUntil(8000));
        assert.deepEqual(qualityLines(lines), [
            "Qualidade automática: 1080p 30 fps → 720p 30 fps para os 2 espectadores (placa de vídeo: mediana de 29.8 ms por quadro em 2 encoders da placa, "
            + "o limite é 27.1 ms; codificando 81% dos quadros esperados); nova subida só após 10 s estável"
        ]);
        assert.equal(h.controller.state?.reason, "gpu");
    });

    // fonte a 60 fps num degrau de 30: o esperado e o fps do degrau (30 de 30 acompanha; contra os 60 da fonte seria 50%)
    for (const [fps, level] of [[30, "1080p30"], [26, "720p30"]] as const) {
        test(`ligada, a fonte acima do degrau (60 fps num degrau de 30): ${fps} de 30 fps ${fps === 30 ? "acompanha" : "fica para tras (87%)"}`, async t => {
            const sim = () => nvenc(fps, { sourceFps: 60 });
            const h = await twoViewers(t, true, { L: sim(), S: sim() });
            await h.runUntil(60_000);
            assert.equal(h.controller.levelFor("L"), level);
        });
    }

    test("ligada: quem a propria rede limita (descarta quadros para caber na banda) nao conta como a placa ficando para tras", async t => {
        // L com 700 kbps estimados (o degrau pede 2500): o WebRTC codifica 8 de 29,5 fps; S acompanha a fonte
        const h = await twoViewers(t, true, { L: nvenc(8, { availableKbps: 700, kbps: 650 }), S: nvenc(SOURCE_FPS) });
        const lines = await logsDuring(() => h.runUntil(120_000));
        assert.ok(!qualityLines(lines).some(l => l.includes("placa de vídeo")), "a placa de video nao desceu ninguem");
        assert.equal(h.controller.levelFor("S"), "1080p30");
        assert.deepEqual(h.controller.state?.viewers.L, { level: "720p30", reason: "bandwidth" }, "L desce pela banda dele");
    });

    test("ligada, todos limitados pela propria rede: sem encoder para medir, a placa nao desce", async t => {
        const starved = { availableKbps: 700, kbps: 650 };
        const h = await twoViewers(t, true, { L: nvenc(8, starved), S: nvenc(8, starved) });
        const lines = await logsDuring(() => h.runUntil(8000));
        assert.deepEqual(qualityLines(lines), []);
        assert.match(lines.find(l => l.startsWith("Placa de vídeo:")) ?? "", /\(sem encoder para medir fora os limitados pela rede\)/);
    });

    for (const gpuCapture of [false, undefined]) {
        test(`${gpuCapture === false ? "desligada" : "sem a opcao nas dependencias"}: o limite de sempre, mesmo com os encoders acompanhando`, async t => {
            const h = await twoViewers(t, gpuCapture, { L: nvenc(SOURCE_FPS), S: nvenc(SOURCE_FPS) });
            const lines = await logsDuring(() => h.runUntil(8000));
            assert.deepEqual(qualityLines(lines), [OLD_DOWN]);
            assert.ok(!lines.some(l => l.startsWith("Placa de vídeo:")));
        });
    }
});
