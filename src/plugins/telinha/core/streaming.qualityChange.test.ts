/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes de trocar a Resolucao/FPS com a transmissao no ar (actions.ts → changeStreamQuality → startStreaming com a mesma
// fonte), do lado do que cada espectador recebe: quem ja tinha saido do H.264 (pediu VP9 ou o encoder caiu) continua no
// VP9 na captura nova (carryCodecs), e a troca fica bloqueada enquanto um envio H.264 da placa de video ainda nao mandou
// video (o mesmo sinal do checkStall) ou com um envio travado (qualityLockOf): a troca desmonta o envio de cada um
// (removeStream), e desmontar um encoder travado trava o Discord. Rodar:
//   pnpm test:file src/plugins/telinha/core/streaming.qualityChange.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { changeStreamQuality } from "@plugins/telinha/actions";
import { rt } from "@plugins/telinha/core/context";
import { getState } from "@plugins/telinha/store";
import { pluginSettings } from "@test/fakes/vencord";
import { captureStream, type FakeMediaStream, type FakeRTCPeerConnection, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, removalsFrom, screenOptions, seconds, type StreamingRig, turns, videoSenderOf, windowOptions } from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { H264_STALL_MS, QUALITY_LOCK_STARTING, QUALITY_LOCK_STUCK, qualityChangeBlocked, sendPlanFor, SENT_MIN_BYTES, startStreaming, stopStreaming } from "./streaming";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";

let rig: StreamingRig;
let seq = 0;
/** o espectador do envio travado (o teste do travado → o do codec fixado) */
let stuck: TestViewer | null = null;

/** O que o envio H.264 da placa ja mandou (bytesSent); 0 = nada saiu ainda. Mudavel no meio. */
interface Out {
    bytes: number;
}

interface TestViewer {
    peerId: string;
    label: string;
    pc: FakeRTCPeerConnection;
    out: Out;
}

/**
 * Estatisticas do envio H.264 da placa (NVENC) com a captura entregando 60 fps e `out.bytes` enviados. `named` false: sem
 * encoderImplementation nem powerEfficientEncoder (o Chromium nao diz o encoder, como no log da AMD de 31/10).
 */
function h264Stats(out: Out, named = true) {
    let frames = 0;
    let at = rig.clock.now();
    return () => {
        const now = rig.clock.now();
        frames += (now - at) / 1000 * 60;
        at = now;
        return videoSenderStats({
            mimeType: "video/H264", encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: out.bytes ? 600 : 0,
            bytesSent: out.bytes, sourceFrames: Math.floor(frames + 1e-9), sourceFps: 60,
            omit: named ? [] : ["encoderImplementation", "powerEfficientEncoder"]
        });
    };
}

/** O envio de video atual para `v` (o da captura de agora) reporta `v.out`. */
function report(v: TestViewer, named = true) {
    videoSenderOf(v.pc)!.stats = h264Stats(v.out, named);
}

/** Um espectador novo (decodifica H.264 por hardware) que pede para assistir; `bytes`: o que o envio dele ja mandou. */
async function watcher(name: string, bytes: number, named = true): Promise<TestViewer> {
    seq++;
    const peerId = `q${name}`;
    const pc = await connectViewer(rig, peerId, String(830_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: true });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    const v = { peerId, label: `${name} (${peerId.slice(0, 6)})`, pc, out: { bytes } };
    report(v, named);
    return v;
}

const SENDING = 5_000_000;

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

describe("trocar a qualidade no ar", () => {
    test("quem ja foi para o VP9 continua no VP9 na captura nova; quem esta no H.264 recomeca nele", async () => {
        const a = await watcher("pediuvp9", SENDING);
        const b = await watcher("h264", SENDING);
        await seconds(rig, 2);
        rig.room.receive("codec", { codec: "vp9" }, a.peerId);
        await turns();
        assert.equal(sendPlanFor(a.peerId)?.codec, "vp9");
        assert.equal(qualityChangeBlocked(), null, "os dois envios ja mandam video");

        const before = rt.local;
        const since = logMark();
        await changeStreamQuality("720p30");
        assert.notEqual(rt.local, before, "capturou de novo");
        assert.equal(sendPlanFor(a.peerId)?.codec, "vp9", "a captura nova comeca no VP9 para ele");
        assert.equal(sendPlanFor(b.peerId)?.codec, "h264");
        assert.ok(since().some(l => l.startsWith(`Enviando para ${a.label}: codec VP9 (o mesmo da captura anterior: `)), "o log diz de onde veio o codec");

        // o pedido dele ja foi atendido: repetido, nada (nao volta a trocar)
        const again = logMark();
        await seconds(rig, 6);
        rig.room.receive("codec", { codec: "vp9" }, a.peerId);
        await turns();
        assert.deepEqual(again().filter(l => l.includes(`${a.label} não decodificou`) || l.includes(`Pedido de VP9 de ${a.label}`)), []);

        // o envio novo do H.264 da placa ainda nao mandou video: a qualidade fica bloqueada ate ele mandar
        b.out = { bytes: 0 };
        report(b);
        await seconds(rig, 1);
        assert.equal(getState().local?.qualityLock, QUALITY_LOCK_STARTING);
        b.out.bytes = SENDING;
        await seconds(rig, 1);
        assert.equal(getState().local?.qualityLock, undefined, "liberada");
        for (const v of [a, b]) rig.room.receive("watch", { op: "stop" }, v.peerId);
        await turns();
    });

    test("um envio H.264 da placa que ainda nao mandou video: os botoes desligam e a troca e recusada, sem desmontar nada", async () => {
        const v = await watcher("comecando", 0);
        await seconds(rig, 1);
        assert.equal(getState().local?.qualityLock, QUALITY_LOCK_STARTING);

        const before = rt.local;
        const removals = removalsFrom(rig.room, v.peerId).length;
        await assert.rejects(changeStreamQuality("1080p30"), { message: QUALITY_LOCK_STARTING });
        assert.equal(rt.local, before, "nao capturou de novo");
        assert.equal(removalsFrom(rig.room, v.peerId).length, removals, "nenhum removeStream no envio que pode estar travado");

        // um quadro-chave abaixo do SENT_MIN_BYTES ainda nao conta (o mesmo sinal do checkStall); acima, libera
        v.out.bytes = SENT_MIN_BYTES - 1;
        await seconds(rig, 1);
        assert.equal(qualityChangeBlocked(), QUALITY_LOCK_STARTING);
        v.out.bytes = SENT_MIN_BYTES;
        await seconds(rig, 1);
        assert.equal(qualityChangeBlocked(), null);
        assert.equal(getState().local?.qualityLock, undefined);
        await changeStreamQuality("1080p30");
        assert.notEqual(rt.local, before);
        rig.room.receive("watch", { op: "stop" }, v.peerId);
        await turns();
    });

    test("um espectador entra enquanto a captura nova e pedida: desiste antes de desmontar; a nova para e a do ar continua", async () => {
        const before = rt.local!;
        let release!: () => void;
        let fresh: FakeMediaStream | null = null;
        rig.rtc.mediaDevices.getDisplayMediaImpl = constraints => new Promise(resolve => {
            release = () => resolve(fresh = captureStream({ audio: !!constraints.audio }));
        });
        try {
            const change = changeStreamQuality("720p60");
            await turns();
            const v = await watcher("nomeio", 0);
            release();
            await assert.rejects(change, { message: QUALITY_LOCK_STARTING });
            assert.equal(rt.local, before, "a captura do ar continua");
            assert.ok(fresh!.getTracks().every(t => t.readyState === "ended"), "a captura nova parou");
            assert.ok(before.stream.getTracks().every(t => t.readyState === "live"));
            assert.equal(removalsFrom(rig.room, v.peerId).length, 0, "nenhum removeStream no envio que ainda nao mandou video");
            v.out.bytes = SENDING;
            await seconds(rig, 1);
            rig.room.receive("watch", { op: "stop" }, v.peerId);
            await turns();
        } finally {
            rig.rtc.mediaDevices.getDisplayMediaImpl = constraints => Promise.resolve(captureStream({ audio: !!constraints.audio }));
        }
    });

    test("Trocar para outra fonte com um envio H.264 da placa comecando: recusado do mesmo jeito", async () => {
        const v = await watcher("trocar", 0);
        const before = rt.local;
        await assert.rejects(startStreaming(windowOptions()), { message: QUALITY_LOCK_STARTING });
        assert.equal(rt.local, before);
        v.out.bytes = SENDING;
        await seconds(rig, 1);
        rig.room.receive("watch", { op: "stop" }, v.peerId);
        await turns();
    });

    // por ultimo: o envio travado desliga o H.264 automatico nesta sessao
    test("com um envio travado (contido), a troca fica bloqueada", async () => {
        const v = await watcher("travado", 0);
        await seconds(rig, H264_STALL_MS / 1000 + 2);
        assert.equal(getState().local?.qualityLock, QUALITY_LOCK_STUCK);
        const before = rt.local;
        await assert.rejects(changeStreamQuality("720p60"), { message: QUALITY_LOCK_STUCK });
        assert.equal(rt.local, before);
        assert.equal(removalsFrom(rig.room, v.peerId).length, 0);
        stuck = v;
    });

    test("codec fixado em H.264 com o da placa desligado (marca de travado): sem o encoder nas estatisticas, conta como da placa", async () => {
        assert.equal(getLocalCaps().h264HwEncode, false, "a marca do travado desligou o H.264 da placa");
        rig.room.receive("watch", { op: "stop" }, stuck!.peerId);
        await turns();
        assert.equal(qualityChangeBlocked(), null);
        pluginSettings.set("codec", "h264");
        try {
            const v = await watcher("fixado", 0, false);
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            await seconds(rig, 2);
            assert.equal(qualityChangeBlocked(), QUALITY_LOCK_STARTING, "o envio nasce software, mas o encoder pode ser o da placa");
            v.out.bytes = SENDING;
            await seconds(rig, 1);
            assert.equal(qualityChangeBlocked(), null, "o video saiu: liberado");
        } finally {
            pluginSettings.set("codec", "auto");
        }
    });
});
