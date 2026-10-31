/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do pedido de codec do espectador, do lado de quem transmite (acao "codec", protocol.ts passo 8 →
// core/session.ts → core/streaming.ts → onCodecRequest): quem assiste recebeu o H.264 e nao decodificou nenhum quadro, e
// pede VP9. Com o codec no automatico, so o envio para ele vira VP9 (sem reconectar) e isso NAO conta como queda do
// H.264 deste PC (pode ser o decodificador dele); fixado em H.264, so loga; quem nao esta assistindo e ignorado; com a
// captura parada (janela minimizada) ou sem contador de quadros, ignorado (o VP9 so pesaria a CPU). O contador da
// captura vem do media-source das estatisticas do envio, lidas pelo tick a cada segundo: os pedidos esperam 2 leituras.
// Do lado de quem assiste (quando pedir), ver viewing.codecRequest.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.codecRequest.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { parseCodecRequest } from "@plugins/telinha/protocol";
import { pluginSettings } from "@test/fakes/vencord";
import { type FakeRTCRtpSender, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { STATS_LINE_RE } from "./statsLog";
import { sendPlanFor, startStreaming, stopStreaming } from "./streaming";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";

let rig: StreamingRig;
let seq = 0;

/** A captura vista no media-source do envio: quadros por segundo (0 = parada, janela minimizada; null = sem contador). */
interface Capture {
    fps: number | null;
}

interface TestViewer {
    peerId: string;
    label: string;
    sender: FakeRTCRtpSender;
    capture: Capture;
}

/**
 * Estatisticas de um envio que ja sai do PC (5 MB enviados: o checkStall nao age), com o contador de quadros da captura
 * seguindo o relogio (`capture.fps`, mudavel no meio).
 */
function senderStats(hw: boolean, capture: Capture) {
    let frames = 0;
    let at = rig.clock.now();
    return () => {
        const now = rig.clock.now();
        frames += Math.round((now - at) / 1000 * (capture.fps ?? 0));
        at = now;
        return videoSenderStats({
            mimeType: hw ? "video/H264" : "video/VP9", encoderImplementation: hw ? NVENC : "libvpx", powerEfficientEncoder: hw, framesEncoded: 600,
            bytesSent: 5_000_000, sourceFrames: capture.fps == null ? null : frames, sourceFps: capture.fps
        });
    };
}

/** Um espectador novo que pede para assistir; `hw`: decodifica H.264 por hardware (presenca). Os quadros saem daqui. */
async function watcher(name: string, hw = true, capture: Capture = { fps: 60 }): Promise<TestViewer> {
    seq++;
    const peerId = `c${name}`;
    const pc = await connectViewer(rig, peerId, String(820_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: hw });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    const sender = videoSenderOf(pc)!;
    sender.stats = senderStats(hw, capture);
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, sender, capture };
}

/** O espectador pede VP9 (o que viewing.ts → askForVp9 manda). */
async function asks(v: { peerId: string; }, data: unknown = { codec: "vp9" }) {
    rig.room.receive("codec", data, v.peerId);
    await turns();
}

const about = (lines: string[], v: TestViewer) => lines.filter(l => l.includes(v.label) && !STATS_LINE_RE.test(l));

/** O codec fixado no encodings[0] do envio (undefined = o negociado). */
const sentCodec = (sender: FakeRTCRtpSender) => sender.encoding.codec?.mimeType;

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

describe("pedido de VP9 de quem assiste (acao \"codec\")", () => {
    test("parseCodecRequest: so { codec: \"vp9\" }, sem campos a mais", () => {
        assert.deepEqual(parseCodecRequest({ codec: "vp9" }), { codec: "vp9" });
        assert.deepEqual(parseCodecRequest({ codec: "vp9", evil: "x".repeat(10_000) }), { codec: "vp9" });
        for (const bad of [null, undefined, "vp9", 9, [], {}, { codec: "VP9" }, { codec: "av1" }, { codec: "h264" }, [{ codec: "vp9" }]])
            assert.equal(parseCodecRequest(bad), null, JSON.stringify(bad));
    });

    test("codec automatico: troca so quem pediu para VP9, sem reconectar e sem contar como queda do H.264 deste PC", async () => {
        const a = await watcher("pediu");
        const b = await watcher("vizinho");
        const c = await watcher("outro");
        await seconds(rig, 2); // 2 leituras: a captura andou
        const since = logMark();
        await asks(a);
        assert.equal(sentCodec(a.sender), "video/VP9");
        assert.equal(sendPlanFor(a.peerId)?.codec, "vp9", "renegociacoes futuras ja vao com VP9");
        assert.deepEqual(about(since(), a), [
            `${a.label} não decodificou nenhum quadro do vídeo em H.264 e pediu VP9: trocando para VP9 só para ${a.label}. `
            + "Não conta como queda do H.264 deste PC (pode ser o decodificador dele).",
            `${a.label} agora recebe VP9 (trocado sem reconectar)`
        ]);
        assert.equal(b.sender.encoding.codec, undefined, "o vizinho continua em H.264");
        assert.equal(sendPlanFor(b.peerId)?.codec, "h264");

        // um 2o espectador pedindo tambem nao conta: com 2 quedas o H.264 automatico desligaria
        await asks(c);
        assert.equal(sentCodec(c.sender), "video/VP9");
        assert.equal(getLocalCaps().h264HwEncode, true, "nenhuma queda contada");
        const next = await watcher("proximo");
        assert.equal(sendPlanFor(next.peerId)?.codec, "h264", "os proximos ainda recebem H.264");

        // repetido (mesmo depois do intervalo minimo): ja atendido, nada mais
        await seconds(rig, 6);
        const again = logMark();
        await asks(a);
        assert.deepEqual(about(again(), a), []);
    });

    test("captura parada (janela minimizada) ou sem contador de quadros: ignorado com uma linha, continua em H.264; com a captura de volta, troca", async () => {
        const idle = await watcher("parada", true, { fps: 0 });
        const blind = await watcher("semcontador", true, { fps: null });
        await seconds(rig, 3);
        const since = logMark();
        await asks(idle);
        await asks(blind);
        for (const v of [idle, blind]) {
            assert.equal(v.sender.encoding.codec, undefined, v.label);
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264", v.label);
            assert.deepEqual(about(since(), v), [`Pedido de VP9 de ${v.label} ignorado: a captura não está entregando quadros (janela minimizada?)`], v.label);
        }

        // o pedido ignorado nao fica marcado: com a captura de volta, um pedido novo (passado o intervalo minimo) troca como hoje
        idle.capture.fps = 60;
        await seconds(rig, 5);
        await asks(idle);
        assert.equal(sentCodec(idle.sender), "video/VP9");
        assert.equal(getLocalCaps().h264HwEncode, true, "nenhuma queda contada");
    });

    test("quem nao esta assistindo, ou ja recebe VP9: ignorado (um aviso no maximo por minuto)", async () => {
        const vp9 = await watcher("vp9", false);
        assert.equal(sendPlanFor(vp9.peerId)?.codec, "vp9");
        const since = logMark();
        await asks(vp9);
        assert.equal(vp9.sender.encoding.codec, undefined, "nada a trocar");
        assert.deepEqual(about(since(), vp9), []);

        const gone = await watcher("saiu");
        rig.room.receive("watch", { op: "stop" }, gone.peerId);
        await turns();
        const after = logMark();
        await asks(gone);
        await seconds(rig, 6);
        await asks(gone);
        assert.deepEqual(about(after(), gone), [`${gone.label} pediu VP9 (nenhum quadro em H.264 do lado dele), mas não está recebendo a sua transmissão: ignorado`]);
        assert.equal(sendPlanFor(gone.peerId), null);
    });

    test("pedido malformado: ignorado sem log; da mesma conexao, um pedido a cada 5 s no maximo", async () => {
        const v = await watcher("spam");
        await seconds(rig, 2);
        const since = logMark();
        for (const bad of [null, "vp9", { codec: "av1" }, { codec: 9 }]) await asks(v, bad);
        assert.equal(v.sender.encoding.codec, undefined);
        assert.deepEqual(about(since(), v), []);
        await asks(v);
        assert.equal(sentCodec(v.sender), "video/VP9");

        // pede antes de assistir (ignorado), comeca a assistir e pede de novo logo em seguida: cai no intervalo minimo
        seq++;
        const peerId = "cpressa";
        const pc = await connectViewer(rig, peerId, String(820_000_000_000_000_000n + BigInt(seq)), "pressa", { h264HwDecode: true });
        await asks({ peerId });
        rig.room.receive("watch", { op: "start" }, peerId);
        await turns();
        const sender = videoSenderOf(pc)!;
        sender.stats = senderStats(true, { fps: 60 });
        await asks({ peerId });
        assert.equal(sender.encoding.codec, undefined, "a menos de 5 s do anterior: ignorado");
        await seconds(rig, 5);
        await asks({ peerId });
        assert.equal(sentCodec(sender), "video/VP9");
    });

    test("codec fixado em H.264: o pedido so e logado, o envio continua em H.264", async () => {
        pluginSettings.set("codec", "h264");
        try {
            const v = await watcher("fixado");
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            await seconds(rig, 2);
            const since = logMark();
            await asks(v);
            assert.equal(v.sender.encoding.codec, undefined, "sem troca");
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            assert.deepEqual(about(since(), v), [
                `${v.label} não decodificou nenhum quadro do vídeo em H.264 e pediu VP9: continua em H.264 porque o codec está fixado nas configurações`
            ]);
        } finally {
            pluginSettings.set("codec", "auto");
        }
    });
});
