/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do log de estatisticas (core/statsLog.ts): a conta de cada janela (diferencas dos contadores), o texto das
// linhas de envio e de recepcao (o que falta fica de fora, nunca "NaN"/"undefined"), a cadencia de STATS_LOG_MS e os
// resumos. Funcoes puras com leituras montadas a mao; a ligacao com a qualidade automatica fica em
// quality/controller.stats.test.ts e a com quem assiste em viewing.stats.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/statsLog.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SenderLogCounters, SenderSample } from "./quality/stats";
import {
    emptyReceiverCounters, formatDuration, formatReceiverLine, formatSenderLine, readAudioInbound, readVideoInbound, ReceiverLog, type ReceiverLogCounters,
    type ReceiverSample, receiverWindow, type SenderLevels, SenderLog, senderWindow, STATS_LINE_RE, STATS_LOG_MS
} from "./statsLog";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";
const FIXED: SenderLevels = { level: "1080p60", bw: "1080p60", global: "1080p60", auto: false };
const AUTO_720P30: SenderLevels = { level: "720p30", bw: "720p30", global: "720p30", auto: true };

/** Nada de valor ausente escrito por extenso. */
function assertClean(line: string) {
    assert.doesNotMatch(line, /NaN|undefined|null|Infinity/, line);
}

const senderLog = (patch: Partial<SenderLogCounters> = {}): SenderLogCounters => ({
    mimeType: "video/VP9", targetKbps: 1800, packetsSent: 0, retransmittedPacketsSent: 0, retransmittedBytesSent: 0, packetSendDelay: 0, nackCount: 0,
    pliCount: 0, keyFramesEncoded: 0, qpSum: 0, packetsLost: 0, fractionLost: 0, rttMs: 30, rttTotal: 0, rttCount: 0, jitterMs: 5, route: "host/srflx",
    ...patch
});

function sender(patch: Partial<SenderSample> = {}): SenderSample {
    return {
        at: 0, framesEncoded: 0, totalEncodeTime: 0, bytesSent: 0, limitation: { cpu: 0, bandwidth: 0 }, reason: "none", frameWidth: 1280, frameHeight: 720,
        sourceFrames: 0, sourceFps: 59, availableKbps: 2100, powerEfficient: false, implementation: "libvpx", log: senderLog(), ...patch
    };
}

describe("envio: uma janela e a linha", () => {
    // o exemplo do pedido: 10 s de um envio VP9 720p a 29,8 fps, banda limitando 20% do tempo
    const prev = sender({
        at: 10_000, framesEncoded: 1000, totalEncodeTime: 10, bytesSent: 1_000_000, limitation: { cpu: 0, bandwidth: 5 }, sourceFrames: 2000,
        log: senderLog({ packetsSent: 10_000, retransmittedPacketsSent: 100, retransmittedBytesSent: 100_000, packetSendDelay: 30, nackCount: 50, pliCount: 2, keyFramesEncoded: 3, qpSum: 34_000, packetsLost: 80, rttTotal: 3, rttCount: 100 })
    });
    const cur = sender({
        at: 20_000, framesEncoded: 1298, totalEncodeTime: 10 + 298 * 0.0092, bytesSent: 1_000_000 + 2_062_500, limitation: { cpu: 0, bandwidth: 7 }, sourceFrames: 2590,
        log: senderLog({
            packetsSent: 11_740, retransmittedPacketsSent: 140, retransmittedBytesSent: 150_000, packetSendDelay: 30 + 1740 * 0.003, nackCount: 62, pliCount: 2,
            keyFramesEncoded: 3, qpSum: 34_000 + 298 * 34, packetsLost: 94, fractionLost: 0.5, rttTotal: 3.34, rttCount: 110, jitterMs: 6
        })
    });

    test("todos os campos: diferencas na janela, perda sobre os pacotes de midia, rtt medio da janela", () => {
        const w = senderWindow(prev, cur);
        assert.ok(w);
        assert.equal(w.m.dt, 10);
        assert.equal(w.media, 1700, "1740 pacotes, 40 deles retransmissoes");
        assert.equal(w.lost, 14);
        assert.ok(Math.abs(w.lossPct! - 14 / 1700 * 100) < 1e-9, "a perda da janela, nao o fractionLost do ultimo relatorio");
        assert.ok(Math.abs(w.rttMs! - 34) < 1e-9);
        assert.equal(w.rtxKbps, 40);
        assert.ok(Math.abs(w.pacerMs! - 3) < 1e-9);
        assert.ok(Math.abs(w.qp! - 34) < 1e-9);
        assert.deepEqual([w.nacks, w.plis, w.keyframes], [12, 0, 0]);
        assert.equal(formatSenderLine("leozzyy (abc123)", w, AUTO_720P30, "host/srflx"),
            "Envio p/ leozzyy (abc123): VP9 libvpx 1280x720 29,8 fps (fonte 59) · alvo 1800 enviado 1650 rtx 40 est 2100 kbps · perda 0,8% rtt 34 ms jitter 6 ms · "
            + "nack 12 pli 0 kf 0 · fila 3 ms · lim banda 20% cpu 0% · 9,2 ms/q qp 34 · nível 720p30 · rota host/srflx");
    });

    test("placa de video e degraus diferentes: '[hw]', o fabricante do encoder e os dois degraus; a linha fica em ~300 caracteres", () => {
        const hw = (s: SenderSample) => ({ ...s, powerEfficient: true, implementation: NVENC, frameWidth: 1920, frameHeight: 1080, log: { ...s.log!, mimeType: "video/H264" } });
        const w = senderWindow(hw(prev), hw(cur))!;
        const split: SenderLevels = { level: "720p60", bw: "720p60", global: "1080p60", auto: true };
        const line = formatSenderLine("leozzyy (abc123)", w, split, null);
        assert.match(line, /^Envio p\/ leozzyy \(abc123\): H264 NVIDIA H\.264 Encoder MFT \[hw\] 1920x1080 29,8 fps/);
        assert.match(line, / · nível 720p60 \(banda 720p60, geral 1080p60\)$/);
        // o pior caso comum (H.264 na placa, degraus diferentes); a rota so sai na 1a linha e quando muda
        assert.ok(line.length <= 300, `${line.length} caracteres`);
    });

    test("sem os contadores do log (Chromium antigo) e sem fonte/banda/tamanho: so o que existe, nunca NaN/undefined", () => {
        const bare = (s: SenderSample) => ({ ...s, log: undefined, sourceFps: null, sourceFrames: null, availableKbps: null, implementation: null, frameWidth: 0 });
        const w = senderWindow(bare(prev), bare(cur))!;
        const line = formatSenderLine("x", w, FIXED, null);
        assert.equal(line, "Envio p/ x: 29,8 fps · enviado 1650 kbps · lim banda 20% cpu 0% · 9,2 ms/q · nível 1080p60 fixo");
        assertClean(line);
    });

    test("sem pacotes enviados: a perda vem do fractionLost; sem medida de rtt nova: o rtt do ultimo relatorio; contador que voltou fica de fora", () => {
        const w = senderWindow(
            sender({ at: 0, log: senderLog({ packetsSent: null, rttTotal: 1, rttCount: 10, nackCount: 10, qpSum: null }) }),
            sender({ at: 2000, framesEncoded: 60, bytesSent: 400_000, log: senderLog({ packetsSent: null, fractionLost: 0.02, rttMs: 50, rttTotal: 1, rttCount: 10, nackCount: 5 }) })
        )!;
        assert.equal(w.lossPct, 2);
        assert.equal(w.lost, null, "sem os pacotes, a perda nao entra na media do resumo");
        assert.equal(w.rttMs, 50);
        assert.equal(w.nacks, null, "nackCount voltou (sender trocado)");
        assert.equal(w.pacerMs, null);
        const line = formatSenderLine("x", w, AUTO_720P30, null);
        assert.match(line, / · perda 2,0% rtt 50 ms jitter 5 ms · pli 0 kf 0 · lim banda/);
        assertClean(line);

        // sem o contador de retransmissoes: todos os pacotes contam como midia
        const noRtx = senderWindow(
            sender({ log: senderLog({ packetsSent: 0, retransmittedPacketsSent: null, packetsLost: 0 }) }),
            sender({ at: 2000, framesEncoded: 60, bytesSent: 400_000, log: senderLog({ packetsSent: 200, retransmittedPacketsSent: null, packetsLost: 2 }) })
        )!;
        assert.deepEqual([noRtx.media, noRtx.lossPct], [200, 1]);

        // nenhum pacote de midia na janela e sem fractionLost: sem perda
        const idle = senderWindow(sender({ log: senderLog({ fractionLost: null }) }), sender({ at: 2000, log: senderLog({ fractionLost: null }) }))!;
        assert.equal(idle.lossPct, null);
        assert.equal(idle.qp, null, "nenhum quadro na janela");
    });

    test("janela curta demais ou contadores reiniciados: nenhuma janela", () => {
        assert.equal(senderWindow(prev, { ...cur, at: prev.at + 300 }), null);
        assert.equal(senderWindow(cur, prev), null);
    });
});

/** Um envio estavel a 60 fps / 8000 kbps; a leitura `i` e no instante 2000·i. */
function steady(i: number, patch: Partial<SenderLogCounters> = {}): SenderSample {
    return sender({
        at: 2000 * i, framesEncoded: 120 * i, totalEncodeTime: 0.5 * i, bytesSent: 2_000_000 * i, frameWidth: 1920, frameHeight: 1080, sourceFrames: 120 * i,
        sourceFps: 60, availableKbps: 9000,
        log: senderLog({
            targetKbps: 8500, packetsSent: 1700 * i, packetSendDelay: 3.4 * i, nackCount: i, keyFramesEncoded: i >= 2 ? 4 : 0, qpSum: 3600 * i,
            packetsLost: 17 * i, fractionLost: 0.01, rttTotal: 0.06 * i, rttCount: 2 * i, ...patch
        })
    });
}

describe("envio: cadencia e resumo (SenderLog)", () => {
    test("uma linha a cada STATS_LOG_MS (a 1 s de folga), com a rota so quando muda; na troca de degrau, a janela que houver", () => {
        const log = new SenderLog(0);
        assert.equal(log.line(steady(0), "A", FIXED, true), null, "sem leitura nenhuma: nada");
        log.add(null, steady(0));
        const lines: (string | null)[] = [];
        for (let i = 1; i <= 5; i++) {
            log.add(steady(i - 1), steady(i));
            lines.push(log.line(steady(i), "A", FIXED));
        }
        assert.deepEqual(lines.slice(0, 4), [null, null, null, null]);
        assert.equal(lines[4], "Envio p/ A: VP9 libvpx 1920x1080 60,0 fps (fonte 60) · alvo 8500 enviado 8000 rtx 0 est 9000 kbps · perda 1,0% rtt 30 ms jitter 5 ms · "
            + "nack 5 pli 0 kf 4 · fila 2 ms · lim banda 0% cpu 0% · 4,2 ms/q qp 30 · nível 1080p60 fixo · rota host/srflx");
        assert.equal(STATS_LOG_MS, 10_000);

        // 9 s depois da ultima linha ja fecha (a leitura atrasa); 8,999 s ainda nao
        assert.equal(log.line({ ...steady(9), at: 18_999 }, "A", FIXED), null);
        const next = log.line({ ...steady(9), at: 19_000 }, "A", FIXED);
        assert.ok(next?.endsWith(" · nível 1080p60 fixo"), "mesma rota: nao repete");

        // troca de degrau: a janela desde a ultima linha, mesmo curta; logo depois, nada (janela vazia)
        const forced = log.line(steady(10, { route: "srflx/srflx" }), "A", { level: "720p60", bw: "720p60", global: "720p60", auto: true }, true);
        assert.match(forced ?? "", / · nível 720p60 · rota srflx\/srflx$/);
        assert.equal(log.line(steady(10), "A", FIXED, true), null);
        // contadores reiniciados entre a ultima linha e esta: sem linha, a janela recomeca
        assert.equal(log.line({ ...steady(20), bytesSent: 0 }, "A", FIXED), null);
        assertClean(lines[4]!);
    });

    test("resumo: tempo em cada degrau, 60/30 fps, medianas, perda e rtt medios, quadros-chave e a rota", () => {
        const log = new SenderLog(0);
        assert.equal(log.trackLevel("1080p60", 0), false, "o primeiro degrau nao e troca");
        assert.equal(log.trackLevel("1080p60", 1000), false);
        log.add(null, steady(0));
        for (let i = 1; i <= 20; i++) {
            if (i === 11) assert.equal(log.trackLevel("720p60", 20_000), true);
            log.add(steady(i - 1), steady(i));
        }
        assert.equal(log.summary("A", 40_000), "Resumo do envio p/ A: 40 s · 1 troca de nível · 1080p60 50%, 720p60 50% · 60 fps 100%, 30 fps 0% · "
            + "60,0 fps em média · est mediana 9000 enviado mediana 8000 kbps · perda média 1,0% rtt médio 30 ms · kf 4 · rota host/srflx");

        log.trackLevel("720p30", 50_000);
        assert.match(log.summary("A", 60_000) ?? "", /· 2 trocas de nível · 1080p60 33%, 720p60 50%, 720p30 17% · 60 fps 83%, 30 fps 17% ·/);
    });

    test("resumo sem nenhuma janela medida: nada; sem degrau nem contadores do log: so o que existe", () => {
        const empty = new SenderLog(0);
        empty.add(null, steady(0));
        assert.equal(empty.summary("A", 5000), null);

        const bare = new SenderLog(0);
        const plain = (i: number) => ({ ...steady(i), log: undefined, availableKbps: null });
        bare.add(null, plain(0));
        bare.add(plain(0), plain(1));
        const line = bare.summary("A", 2000)!;
        assert.equal(line, "Resumo do envio p/ A: 2 s · 0 trocas de nível · 60,0 fps em média · enviado mediana 8000 kbps");
        assertClean(line);
    });

    test("duracao legivel", () => {
        assert.deepEqual([45_000, 750_000, 3_900_000, -5].map(formatDuration), ["45 s", "12 min 30 s", "1 h 05 min", "0 s"]);
    });
});

const receiverLog = (patch: Partial<ReceiverLogCounters> = {}): ReceiverLogCounters => ({ ...emptyReceiverCounters(), ...patch });

function receiver(patch: Partial<ReceiverSample> = {}): ReceiverSample {
    return { at: 0, framesDecoded: 0, width: 1280, height: 720, bytes: 0, codec: "video/VP9", decoder: "libvpx", powerEfficient: false, log: receiverLog(), ...patch };
}

describe("recepcao: uma janela e a linha", () => {
    const zero = receiverLog({
        framesReceived: 0, framesDropped: 0, freezeCount: 0, freezeSeconds: 0, jitterBufferDelay: 0, jitterBufferEmitted: 0, interFrameDelay: 0,
        interFrameDelaySquared: 0, packetsLost: 0, packetsReceived: 0, nackCount: 0, pliCount: 0, concealedSamples: 0, audioSamples: 0
    });
    // 10 s: 298 quadros com intervalo medio de 33,5 ms e desvio de 6 ms
    const full = receiverLog({
        framesReceived: 300, framesDropped: 2, freezeCount: 1, freezeSeconds: 0.4, jitterBufferDelay: 298 * 0.045, jitterBufferEmitted: 298,
        interFrameDelay: 298 * 0.0335, interFrameDelaySquared: 298 * (0.0335 ** 2 + 0.006 ** 2), packetsLost: 14, packetsReceived: 1736, nackCount: 3,
        pliCount: 0, concealedSamples: 960, audioSamples: 480_000
    });

    test("todos os campos: fps recebidos/decodificados/descartados, congelamentos, buffer, desvio entre quadros, perda e audio", () => {
        const w = receiverWindow(receiver({ log: zero }), receiver({ at: 10_000, framesDecoded: 298, bytes: 2_062_500, log: full }))!;
        assert.ok(Math.abs(w.interFrameSigmaMs! - 6) < 1e-6);
        assert.deepEqual([w.lost, w.expected], [14, 1750]);
        const line = formatReceiverLine("amigo (peerA)", receiver({ log: full }), w);
        assert.equal(line, "Recepção de amigo (peerA): VP9 libvpx 1280x720 · 29,8 fps decodificados de 30,0 recebidos, 2 descartados · congelou 1x (0,4 s) · "
            + "buffer 45 ms · σ entre quadros 6 ms · perda 0,8% · nack 3 pli 0 · 1650 kbps · áudio ocultado 0,2%");
        assert.ok(line.length <= 300);
    });

    test("decodificador na placa de video: '[hw]' e o nome encurtado", () => {
        const hw = receiver({ codec: "video/H264", decoder: "MediaFoundationVideoDecodeAccelerator", powerEfficient: true });
        const w = receiverWindow(receiver(), { ...hw, at: 2000 })!;
        assert.match(formatReceiverLine("a", hw, w), /^Recepção de a: H264 MF \[hw\] 1280x720 · 0,0 fps decodificados · 0 kbps$/);
    });

    test("sem os contadores (Chromium antigo): so fps e kbps, nunca NaN/undefined; sem congelar, so a contagem", () => {
        const bare = receiver({ codec: null, decoder: null, width: 0 });
        const w = receiverWindow(bare, { ...bare, at: 2000, framesDecoded: 60, bytes: 250_000 })!;
        const line = formatReceiverLine("a", bare, w);
        assert.equal(line, "Recepção de a: 30,0 fps decodificados · 1000 kbps");
        assertClean(line);

        const calm = receiverWindow(receiver({ log: zero }), receiver({ at: 2000, log: { ...zero, packetsReceived: 0, freezeSeconds: null } }))!;
        assert.equal(calm.lossPct, null, "nenhum pacote esperado");
        assert.equal(calm.concealedPct, null, "nenhuma amostra de audio");
        assert.equal(calm.interFrameSigmaMs, null, "nenhum quadro");
        assert.match(formatReceiverLine("a", receiver(), calm), / · congelou 0x · /);
        const twice = receiverWindow(receiver({ log: zero }), receiver({ at: 2000, log: { ...zero, freezeCount: 2, freezeSeconds: null } }))!;
        assert.match(formatReceiverLine("a", receiver(), twice), / · congelou 2x · /);
    });

    test("janela curta demais ou contadores que voltaram (outro stream): nenhuma janela", () => {
        assert.equal(receiverWindow(receiver(), receiver({ at: 400 })), null);
        assert.equal(receiverWindow(receiver({ framesDecoded: 10 }), receiver({ at: 2000 })), null);
        assert.equal(receiverWindow(receiver({ bytes: 10 }), receiver({ at: 2000 })), null);
    });

    test("leitura do inbound-rtp: campos ausentes ou invalidos ficam null; o audio soma os inbound-rtp de audio", () => {
        const c = emptyReceiverCounters();
        readVideoInbound(c, { framesReceived: 10, framesDropped: "x", freezeCount: NaN, totalFreezesDuration: 0.5, packetsLost: 1, packetsReceived: 99 });
        assert.deepEqual(c, receiverLog({ framesReceived: 10, freezeSeconds: 0.5, packetsLost: 1, packetsReceived: 99 }));
        readAudioInbound(c, { concealedSamples: 10, totalSamplesReceived: 1000 });
        readAudioInbound(c, { concealedSamples: 5 });
        readAudioInbound(c, {});
        assert.deepEqual([c.concealedSamples, c.audioSamples], [15, 1000]);
    });
});

/** Uma recepcao estavel a 30 fps / 1000 kbps; a leitura `i` e no instante 2000·i. */
function watching(i: number): ReceiverSample {
    return receiver({
        at: 2000 * i, framesDecoded: 60 * i, bytes: 250_000 * i,
        log: receiverLog({
            framesReceived: 60 * i, framesDropped: i, freezeCount: i >= 3 ? 1 : 0, freezeSeconds: i >= 3 ? 0.5 : 0, jitterBufferDelay: 2.4 * i,
            jitterBufferEmitted: 60 * i, interFrameDelay: 2 * i, interFrameDelaySquared: 2 * i / 30, packetsLost: i, packetsReceived: 199 * i, nackCount: i,
            pliCount: 0, concealedSamples: 96 * i, audioSamples: 96_000 * i
        })
    });
}

describe("recepcao: cadencia e resumo (ReceiverLog)", () => {
    test("uma linha a cada STATS_LOG_MS e o resumo do que foi assistido", () => {
        const log = new ReceiverLog(0);
        const lines = [0, 1, 2, 3, 4, 5].map(i => log.add(watching(i), "A"));
        assert.deepEqual(lines.slice(0, 5), [null, null, null, null, null]);
        assert.equal(lines[5], "Recepção de A: VP9 libvpx 1280x720 · 30,0 fps decodificados de 30,0 recebidos, 5 descartados · congelou 1x (0,5 s) · buffer 40 ms · "
            + "σ entre quadros 0 ms · perda 0,5% · nack 5 pli 0 · 1000 kbps · áudio ocultado 0,1%");
        assert.equal(log.summary("A", 10_000), "Resumo da recepção de A: 10 s · VP9 libvpx 1280x720 · 30,0 fps em média · congelou 1x (0,5 s) · 5 descartados · "
            + "perda média 0,5% · mediana 1000 kbps · buffer médio 40 ms · áudio ocultado 0,1%");
        assertClean(lines[5]!);
    });

    test("contadores que voltaram no meio (outro stream): a janela recomeca sem linha", () => {
        const log = new ReceiverLog(0);
        log.add(watching(10), "A");
        assert.equal(log.add({ ...watching(15), bytes: 0 }, "A"), null);
    });

    test("resumo sem nenhuma janela medida: nada; sem os contadores: so o que existe", () => {
        const empty = new ReceiverLog(0);
        assert.equal(empty.summary("A", 1000), null);
        empty.add(receiver(), "A");
        assert.equal(empty.summary("A", 1000), null);

        const bare = new ReceiverLog(0);
        bare.add(receiver({ codec: null, decoder: null }), "A");
        bare.add(receiver({ at: 2000, framesDecoded: 60, bytes: 250_000, codec: null, decoder: null }), "A");
        const line = bare.summary("A", 2000)!;
        assert.equal(line, "Resumo da recepção de A: 2 s · 1280x720 · 30,0 fps em média · mediana 1000 kbps");
        assertClean(line);
    });
});

test("STATS_LINE_RE reconhece as quatro linhas deste modulo e nada mais", () => {
    for (const l of ["Envio p/ a: x", "Resumo do envio p/ a: x", "Recepção de a: x", "Resumo da recepção de a: x"]) assert.match(l, STATS_LINE_RE);
    for (const l of ["Envio para a: 1080p 60 fps", "Assistir a: pedido enviado"]) assert.doesNotMatch(l, STATS_LINE_RE);
});
