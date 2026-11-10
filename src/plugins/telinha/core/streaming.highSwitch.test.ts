/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Troca High → Baseline da placa (send.leftHigh, core/streaming.ts → fallBack): checkStall, troca recusada pelo Chromium e
// H.264 da placa desligado na sessao. Arquivo a parte do streaming.high.test.ts porque estes testes contam quedas do H.264
// na sessao (noteH264Fallback, sem reset) e a 2a desliga o H.264. O rig e o mesmo dele (as duas sondas ja "ok").
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.highSwitch.test.ts

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, rtpCapabilities, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps, setH264HighProbeOk, setH264HwStuck } from "./codec";
import { H264_STALL_MS, sendPlanFor, startStreaming, stopStreaming } from "./streaming";
import { stuckRecord } from "./stuckEncoder";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";
const fmtp = (profile: string) => `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`;
let rig: StreamingRig;
let seq = 0;

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            const video = [...DEFAULT_VIDEO_CODECS, { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp("640032") }];
            rtpCapabilities.sender = { ...rtpCapabilities.sender, video };
            rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video };
            rtc.mediaCapabilities.hwEncode = ["42001f", "640032"];
            rtc.mediaCapabilities.hwDecode = ["42001f", "640032"];
            // as duas sondas ja passaram neste PC (o ambiente aqui e todo desconhecido: vale para qualquer um)
            const at = new Date(2026, 10, 2, 9, 0).getTime();
            pluginSettings.load({
                hwH264Probe: { at, env: {}, verdict: "ok", detail: "30 pacotes de 30 quadros" },
                hwH264HighProbe: { at, env: {}, verdict: "ok", detail: "30 pacotes de 30 quadros", profile: "640032" }
            });
        }
    });
    for (let i = 0; i < 200 && !getLocalCaps().h264HighProbeOk; i++) await turns(1);
    assert.equal(getLocalCaps().h264HighProbeOk, true, "o High salvo deste ambiente vale");
    await enterCall(rig, []);
    pluginSettings.set("autoQuality", false);
    pluginSettings.set("requireVerifiedIdentity", false);
    await startStreaming(screenOptions());
});

after(async () => {
    stopStreaming();
    await destroyRig(rig);
});

/** Um espectador que pede para assistir, com `hwDecode` na presenca como mandado (undefined = sem o campo, a v0.3.2). */
async function watcher(name: string, hwDecode?: unknown) {
    seq++;
    const peerId = `p${name}`;
    const pc = await connectViewer(rig, peerId, String(810_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: true, hwDecode });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, sender: videoSenderOf(pc)! };
}

const software = (profile: string) => videoSenderStats({
    mimeType: "video/H264", codecFmtp: fmtp(profile), encoderImplementation: "OpenH264", powerEfficientEncoder: false, framesEncoded: 600, frameWidth: 1920, frameHeight: 1080
});
const gpu = (profile: string) => videoSenderStats({
    mimeType: "video/H264", codecFmtp: fmtp(profile), encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: 600, frameWidth: 1920, frameHeight: 1080
});
const TO_BASELINE = (label: string) => `O H.264 High para ${label} caiu para o software: trocando para o H.264 Baseline da placa (perfil 42001f) só para ${label}.`;

test("High no OpenH264 que nao sai (checkStall): troca uma vez para o Baseline e nao age de novo antes de a troca assentar", async () => {
    setH264HwStuck(false);
    setH264HighProbeOk(true);
    try {
        const v = await watcher("parado", { v: 1, h264High: true });
        let source = 0;
        v.sender.stats = () => videoSenderStats({
            mimeType: "video/H264", codecFmtp: fmtp("640032"), encoderImplementation: "OpenH264", powerEfficientEncoder: false,
            framesEncoded: 0, bytesSent: 0, sourceFrames: (source += 60), sourceFps: 60, frameWidth: 1920, frameHeight: 1080
        });
        const since = logMark();
        await seconds(rig, H264_STALL_MS / 1000 + 2);
        const lines = since();
        assert.equal(lines.filter(l => l === TO_BASELINE(v.label)).length, 1, lines.join("\n"));
        assert.equal(sendPlanFor(v.peerId)?.h264Profile, "42001f");
        // a troca ainda nao assentou (o relatorio segue o do encoder antigo): nada de VP9, nem contido, nem outra queda
        await seconds(rig, 2);
        const after = since();
        assert.ok(!after.some(l => l.includes("trocando para VP9") || l.includes("a placa de vídeo travou")), after.join("\n"));
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        assert.equal(stuckRecord(), null);
        v.sender.stats = gpu("42001f");
    } finally {
        setH264HighProbeOk(true);
    }
});

test("troca High → Baseline recusada pelo Chromium: assenta na hora e o OpenH264 segue para VP9", async () => {
    setH264HwStuck(false);
    setH264HighProbeOk(true);
    const v = await watcher("recusada", { v: 1, h264High: true });
    v.sender.setParametersImpl = () => { throw new Error("recusado"); };
    try {
        v.sender.stats = software("640032");
        const since = logMark();
        await seconds(rig, 5);
        const lines = since();
        assert.ok(lines.includes(TO_BASELINE(v.label)), lines.join("\n"));
        assert.ok(lines.some(l => l.startsWith("Não deu para trocar")), lines.join("\n"));
        assert.equal(sendPlanFor(v.peerId)?.codec, "vp9", lines.join("\n"));
        assert.ok(lines.some(l => l.includes("trocando para VP9 só para")), lines.join("\n"));
    } finally {
        v.sender.setParametersImpl = null;
    }
});

test("H.264 da placa desligado na sessao: o High que cai vai para VP9, sem Baseline da placa", async () => {
    setH264HwStuck(false);
    setH264HighProbeOk(true);
    const v = await watcher("desligado", { v: 1, h264High: true });
    assert.equal(sendPlanFor(v.peerId)?.h264Profile, "640032");
    setH264HwStuck(true);
    try {
        v.sender.stats = software("640032");
        const since = logMark();
        await seconds(rig, 2);
        const lines = since();
        assert.ok(!lines.includes(TO_BASELINE(v.label)), lines.join("\n"));
        assert.equal(sendPlanFor(v.peerId)?.codec, "vp9", lines.join("\n"));
    } finally {
        setH264HwStuck(false);
    }
});
