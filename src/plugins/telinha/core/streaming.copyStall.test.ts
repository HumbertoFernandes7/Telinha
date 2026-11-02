/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A copia na hora (core/captureCopy.ts) parada com o Worker vivo nunca e culpa do encoder: com os quadros sem chegar ao
// gerador e a captura andando, o encoder H.264/H.265 fica sem quadro e o checkStall (core/streaming.ts) conteria o envio
// como placa travada (ate o Discord reiniciar, marca no PC, trava da qualidade). Aqui: o vigia do fluxo da copia desiste
// antes (os envios voltam para a captura direta, nada contido) e, se mesmo assim o checkStall chegar la com a copia
// parada, ele desiste da copia em vez de conter. Este PC codifica H.264 na placa (sonda falsa), a "Captura pela placa de
// vídeo" vale e o navegador da copia e falso (test/fakes/captureCopy.ts).
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.copyStall.test.ts

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { type FakeCopyEnv, fakeCopyEnv } from "@test/fakes/captureCopy";
import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { captureStream, type FakeMediaStreamTrack, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { refreshGpuCapture, resetCaptureBoostForTests } from "./captureBoost";
import { COPY_FLOW_MIN_FRAMES, resetCaptureCopyForTests, setCaptureCopyEnvForTests, setCopyOnArrivalForTests } from "./captureCopy";
import { getLocalCaps } from "./codec";
import { rt } from "./context";
import { isContained } from "./peerConnection";
import { H264_STALL_MS, startStreaming, stopStreaming } from "./streaming";

const TEXTURE_ON = { loader: true, build: 26300, supported: true, saved: true, requested: true, applied: true, loaderNote: null, enableFeatures: null, saveError: null };

let rig: StreamingRig;
let fake: FakeCopyEnv;
let captured: FakeMediaStreamTrack | null = null;
let seq = 0;

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            rtc.mediaCapabilities.hwEncode = ["42001f"];
            rtc.mediaCapabilities.hwDecode = ["42001f"];
        }
    });
    for (let i = 0; i < 200 && !getLocalCaps().h264HwEncode; i++) await turns(1);
    assert.equal(getLocalCaps().h264HwEncode, true, "a sonda achou o H.264 na placa");
    await enterCall(rig, []);
    pluginSettings.set("autoQuality", false);
    pluginSettings.set("requireVerifiedIdentity", false);
    // a captura entrega 60 quadros por segundo (MediaStreamTrack.stats.totalFrames segue o relogio)
    rig.rtc.mediaDevices.getDisplayMediaImpl = () => {
        const s = captureStream();
        const track = s.getVideoTracks()[0];
        const t0 = rig.clock.now();
        Object.defineProperty(track, "stats", { get: () => ({ totalFrames: Math.round((rig.clock.now() - t0) * 60 / 1000) }) });
        captured = track;
        return Promise.resolve(s);
    };
    rig.native.restore();
    rig.native = installNative({ gpuCaptureStatus: async () => TEXTURE_ON });
    await refreshGpuCapture();
});

after(async () => {
    pluginSettings.set("autoQuality", true);
    pluginSettings.set("requireVerifiedIdentity", true);
    resetCaptureCopyForTests();
    resetCaptureBoostForTests();
    await destroyRig(rig);
});

beforeEach(async () => {
    fake = fakeCopyEnv();
    setCaptureCopyEnvForTests(fake.env);
    setCopyOnArrivalForTests(true);
    await startStreaming(screenOptions());
});

afterEach(async () => {
    stopStreaming();
    await turns();
});

/**
 * Um espectador H.264 cujo encoder nao codifica nada enquanto a entrada e a copia parada (sem quadro), com a captura
 * andando; de volta na captura direta, codifica e manda (o encoder da placa esta bom).
 */
async function starvedViewer(opts: { encodesOnSource?: boolean; } = {}) {
    seq++;
    const peerId = `cs${seq}`;
    const pc = await connectViewer(rig, peerId, String(820_000_000_000_000_000n + BigInt(seq)), `c${seq}`, { h264HwDecode: true });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    const sender = videoSenderOf(pc)!;
    let source = 0;
    let at = rig.clock.now();
    let encoded = 0;
    sender.stats = () => {
        const fresh = Math.round((rig.clock.now() - at) * 60 / 1000);
        source += fresh;
        at = rig.clock.now();
        if (sender.track === captured && opts.encodesOnSource !== false) encoded += fresh;
        if (encoded > 0) {
            return videoSenderStats({
                mimeType: "video/H264", encoderImplementation: "MediaFoundationVideoEncodeAccelerator (NVIDIA)", powerEfficientEncoder: true,
                framesEncoded: encoded, bytesSent: encoded * 2000, sourceFrames: source, sourceFps: 60
            });
        }
        return videoSenderStats({
            mimeType: "video/H264", framesEncoded: 0, bytesSent: 0, sourceFrames: source, sourceFps: 60,
            omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight"]
        });
    };
    return { peerId, pc, sender };
}

describe("cópia na hora parada com o Worker vivo", () => {
    test("o vigia do fluxo desiste da cópia (os envios voltam para a captura direta) antes de o checkStall culpar a placa", async () => {
        const v = await starvedViewer();
        assert.equal(v.sender.track, fake.generators[0], "o envio começa na cópia");
        const since = logMark();
        // a escrita no gerador nunca termina: o Worker responde, mas "written" nunca anda
        await seconds(rig, H264_STALL_MS / 1000 + 4);
        assert.equal(v.sender.track, captured, "o envio voltou para a captura direta");
        assert.equal(rt.local!.copy, null);
        assert.equal(isContained(v.pc as unknown as RTCPeerConnection), false, "nada contido: a placa não é culpada");
        const lines = since();
        assert.ok(lines.some(l => /^Captura pela placa: a cópia na hora parou \(os quadros não saem da cópia: \d+ quadros da captura sem nenhum chegar aos envios\)/.test(l)), lines.join("\n"));
        assert.ok(!lines.some(l => l.includes("travou")), "nenhuma linha de placa travada");
    });

    test("com o vigia sem disparar, o checkStall vê a cópia parada e desiste dela em vez de conter o envio", async () => {
        let written = 0;
        // o gerador "aceita" quadros (o vigia vê andar), mas a cópia diz que a saída está parada: só o checkStall decide
        fake.stats = { get written() { return ++written; } } as never;
        const copy = rt.local!.copy!;
        copy.outputFlat = () => true;
        const v = await starvedViewer();
        const since = logMark();
        await seconds(rig, H264_STALL_MS / 1000 + 2);
        assert.equal(v.sender.track, captured);
        assert.equal(rt.local!.copy, null);
        assert.equal(isContained(v.pc as unknown as RTCPeerConnection), false);
        assert.ok(since().some(l => l.startsWith("Captura pela placa: a cópia na hora parou (os quadros não saem da cópia (o envio para ")));
    });

    test("a cópia andando: o vigia não desiste (a saída acompanha a captura)", async () => {
        let written = 0;
        fake.stats = { get written() { return (written += COPY_FLOW_MIN_FRAMES * 4); } } as never;
        await seconds(rig, 12);
        assert.ok(rt.local!.copy, "a cópia continua");
        assert.equal(rt.local!.copy!.outputFlat(), false);
    });

    // por ultimo: conter desliga o H.264 automatico neste processo
    test("cópia saudável e o encoder da placa travado de verdade: contido no 1o checkStall de 8 s, a cópia fica", async () => {
        let written = 0;
        fake.stats = { get written() { return (written += 120); } } as never;
        const copy = rt.local!.copy!;
        const v = await starvedViewer({ encodesOnSource: false });
        const since = logMark();
        await seconds(rig, H264_STALL_MS / 1000 + 1);
        assert.equal(isContained(v.pc as unknown as RTCPeerConnection), true, "a placa travada é contida na hora");
        assert.equal(rt.local!.copy, copy, "a cópia saudável não foi derrubada");
        assert.equal(v.sender.track, fake.generators[0]);
        const lines = since();
        assert.ok(lines.some(l => l.includes("não codificou nenhum quadro em 8 s")), lines.join("\n"));
        assert.ok(!lines.some(l => l.includes("a cópia na hora parou")));
    });
});
