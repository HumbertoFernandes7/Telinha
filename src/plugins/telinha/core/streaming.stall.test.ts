/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do H.264 que nao sai (core/streaming.ts → checkStall, no tick): o encoder H.264 de um envio nao codifica nenhum
// quadro com a conexao e a captura no ar (visto em 31/10 numa placa AMD: "Codificando para ...: video/H264" sem
// encoderImplementation e o espectador sem imagem em 45 s, quatro vezes). Passados H264_STALL_MS, so ESSE espectador
// passa para VP9 (como uma queda do H.264 por software) e a queda conta na sessao: na 2a, o H.264 automatico desliga.
// Este PC "codifica H.264 na placa" pela sonda falsa e o espectador anuncia h264HwDecode, como em
// streaming.encoder.test.ts. A contagem de quedas e do processo: a ordem dos testes importa (1a queda, 2a, fixado).
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.stall.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { pluginSettings } from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, type FakeRTCRtpSender, type StatsEntry, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { STATS_LINE_RE } from "./statsLog";
import { H264_STALL_MS, sendPlanFor, startStreaming, stopStreaming } from "./streaming";

const AMD = "MediaFoundationVideoEncodeAccelerator (AMD H.264 Encoder MFT)";

let rig: StreamingRig;
let seq = 0;

interface TestViewer {
    peerId: string;
    label: string;
    pc: FakeRTCPeerConnection;
    sender: FakeRTCRtpSender;
}

/** Um espectador novo (decodifica H.264 por hardware) que pede para assistir. */
async function watcher(name: string): Promise<TestViewer> {
    seq++;
    const peerId = `s${name}`;
    const pc = await connectViewer(rig, peerId, String(810_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: true });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, pc, sender: videoSenderOf(pc)! };
}

interface EncoderPlan {
    /** quadros por segundo que a captura entrega (media-source); 0 = parada (janela minimizada) */
    sourceFps?: number;
    /** ms (desde agora) em que o encoder solta o 1o quadro; ausente = nunca */
    encodesAfterMs?: number;
}

/**
 * Estatisticas de um envio H.264 que seguem o relogio. Sem quadro codificado, como no log de 31/10: framesEncoded 0, sem
 * encoderImplementation, powerEfficientEncoder nem tamanho; a captura (media-source) entrega `sourceFps` por segundo.
 * Mudar o plano no meio (plan.sourceFps = ...) vale dali em diante.
 */
function h264Stats(plan: EncoderPlan) {
    let at = rig.clock.now();
    let source = 0;
    const start = at;
    return (): StatsEntry[] => {
        const now = rig.clock.now();
        source += Math.round((now - at) / 1000 * (plan.sourceFps ?? 60));
        at = now;
        const encodedFor = plan.encodesAfterMs == null ? -1 : now - start - plan.encodesAfterMs;
        if (encodedFor < 0) {
            return videoSenderStats({
                mimeType: "video/H264", framesEncoded: 0, sourceFrames: source, sourceFps: plan.sourceFps ?? 60,
                omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight"]
            });
        }
        return videoSenderStats({
            mimeType: "video/H264", encoderImplementation: AMD, powerEfficientEncoder: true, framesEncoded: 1 + Math.round(encodedFor / 1000 * 60),
            sourceFrames: source, sourceFps: plan.sourceFps ?? 60
        });
    };
}

/** Linhas do log sobre este espectador (sem as do log de estatisticas). */
const about = (lines: string[], v: TestViewer) => lines.filter(l => l.includes(v.label) && !STATS_LINE_RE.test(l));

/** O codec fixado no encodings[0] do envio (undefined = o negociado). */
const sentCodec = (sender: FakeRTCRtpSender) => sender.encoding.codec?.mimeType;

const stalled = (v: TestViewer, seconds: number, source: number) =>
    `O encoder H.264 para ${v.label} não codificou nenhum quadro em ${seconds} s, com a conexão no ar e a captura entregando quadros `
    + `(${source} quadros da captura, 0 codificados, encoder não informado pelo Chromium, tamanho desconhecido)`;

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            rtc.mediaCapabilities.hwEncode = ["42001f"];
            rtc.mediaCapabilities.hwDecode = ["42001f"];
        }
    });
    for (let i = 0; i < 200 && !getLocalCaps().h264HwEncode; i++) await turns(1);
    assert.equal(getLocalCaps().h264HwProfile, "42001f", "a sonda achou o H.264 na placa");
    await enterCall(rig, []);
    pluginSettings.set("autoQuality", false);
    pluginSettings.set("requireVerifiedIdentity", false);
    await startStreaming(screenOptions());
});

after(async () => {
    stopStreaming();
    await destroyRig(rig);
});

describe("H.264 que nao codifica nenhum quadro (checkStall)", () => {
    test("log de 31/10: nenhum quadro em 8 s com a captura no ar → VP9 so para ele, sem reconectar; 1a queda da sessao", async () => {
        const v = await watcher("gupi");
        const other = await watcher("leo");
        other.sender.stats = videoSenderStats({ mimeType: "video/H264", encoderImplementation: AMD, powerEfficientEncoder: true, framesEncoded: 600 });
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        v.sender.stats = h264Stats({});
        const since = logMark();
        await seconds(rig, 1); // 1a leitura: comeca a contar
        await seconds(rig, H264_STALL_MS / 1000 - 1);
        assert.equal(v.sender.encoding.codec, undefined, "7 s: ainda esperando");
        assert.deepEqual(about(since(), v), [`Codificando para ${v.label}: video/H264`], "o mesmo que o log de 31/10 mostrou");

        await seconds(rig, 1);
        assert.equal(sentCodec(v.sender), "video/VP9", "trocado sem reconectar");
        assert.equal(sendPlanFor(v.peerId)?.codec, "vp9", "renegociacoes futuras ja vao com VP9");
        assert.deepEqual(about(since(), v).slice(1), [
            `${stalled(v, 8, 480)}: trocando para VP9 só para ${v.label}. Os próximos espectadores ainda tentam a placa de vídeo.`,
            `${v.label} agora recebe VP9 (trocado sem reconectar)`
        ]);
        assert.equal(getLocalCaps().h264HwEncode, true, "uma queda so nao desliga o H.264 automatico");
        assert.equal(other.sender.encoding.codec, undefined, "o outro espectador continua em H.264");
        assert.equal(sendPlanFor(other.peerId)?.codec, "h264");

        // uma vez por espectador: o tick nao confere mais esse envio
        await seconds(rig, 10);
        assert.equal(about(since(), v).filter(l => l.includes("não codificou")).length, 1);
    });

    test("encoder lento que solta o 1o quadro aos 5 s: nunca troca, nem depois", async () => {
        const v = await watcher("lento");
        const plan: EncoderPlan = { encodesAfterMs: 5000 };
        v.sender.stats = h264Stats(plan);
        const since = logMark();
        await seconds(rig, 20);
        assert.equal(v.sender.encoding.codec, undefined);
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        assert.deepEqual(about(since(), v).filter(l => !l.startsWith("Codificando para")), []);
        assert.equal(getLocalCaps().h264HwEncode, true);
    });

    test("captura parada (janela minimizada) ou conexao ainda nao conectada: nao culpa o encoder", async () => {
        const idle = await watcher("parada");
        idle.sender.stats = h264Stats({ sourceFps: 0 });
        const connecting = await watcher("conectando");
        connecting.pc.setConnectionState("connecting");
        connecting.sender.stats = h264Stats({});
        const since = logMark();
        await seconds(rig, 30);
        for (const v of [idle, connecting]) {
            assert.equal(v.sender.encoding.codec, undefined, v.label);
            assert.deepEqual(about(since(), v).filter(l => !l.startsWith("Codificando para")), [], v.label);
        }
        connecting.pc.setConnectionState("connected");
        stopWatching(connecting);
        stopWatching(idle);
        await turns();
    });

    test("a captura volta depois de parada: conta 8 s dali; a 2a queda da sessao desliga o H.264 automatico para os proximos", async () => {
        const v = await watcher("volta");
        const plan: EncoderPlan = { sourceFps: 0 };
        v.sender.stats = h264Stats(plan);
        const since = logMark();
        await seconds(rig, 6);
        plan.sourceFps = 30; // a janela foi restaurada
        await seconds(rig, H264_STALL_MS / 1000 - 1);
        assert.equal(v.sender.encoding.codec, undefined, "conta do momento em que a captura voltou, nao de quando parou");
        await seconds(rig, 1);
        assert.equal(v.sender.encoding.codec, undefined);
        await seconds(rig, 1);
        assert.equal(sentCodec(v.sender), "video/VP9");
        const lines = about(since(), v).filter(l => l.includes("não codificou"));
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^O encoder H\.264 para volta \(svolta\) não codificou nenhum quadro em 8 s, com a conexão no ar e a captura entregando quadros \(2\d0 quadros/);
        assert.ok(lines[0].endsWith(`: trocando para VP9 só para ${v.label}. Foi a 2ª queda nesta sessão: os próximos espectadores vão receber VP9.`), lines[0]);
        assert.equal(getLocalCaps().h264HwEncode, false, "H.264 automatico desligado na sessao");

        // os proximos ja comecam em VP9 (nao esperam 8 s por um encoder que nao sai)
        const next = await watcher("depois");
        assert.equal(sendPlanFor(next.peerId)?.codec, "vp9");
    });

    test("codec fixado em H.264: nenhum quadro em 8 s so loga, continua em H.264", async () => {
        pluginSettings.set("codec", "h264");
        try {
            const v = await watcher("fixado");
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            v.sender.stats = h264Stats({});
            const since = logMark();
            await seconds(rig, H264_STALL_MS / 1000 + 1);
            assert.equal(v.sender.encoding.codec, undefined, "sem troca");
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            assert.deepEqual(about(since(), v).slice(1), [`${stalled(v, 8, 480)}. Continua em H.264 porque o codec está fixado nas configurações.`]);
            await seconds(rig, 5);
            assert.equal(about(since(), v).length, 2, "uma vez por espectador");
        } finally {
            pluginSettings.set("codec", "auto");
        }
    });
});

function stopWatching(v: TestViewer) {
    rig.room.receive("watch", { op: "stop" }, v.peerId);
}
