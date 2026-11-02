/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AV1 de ponta a ponta no envio (core/streaming.ts → sendTo → chooseCodec → sendPlanFor → tick), com este PC (uma RTX 40)
// codificando 42001f, 640032 e AV1 Main na placa, o WebRtcAV1HWEncode ligado nesta partida, o AV1 fixado (ele e so manual)
// e as sondas ja "ok". Cada espectador recebe o que a presenca dele permite (AV1 so com caps.hwDecode.av1). No ar, o AV1
// nunca fica por software: o libaom no lugar da placa (o VideoEncoderSoftwareFallbackWrapper do WebRTC) tira o espectador
// do AV1 na hora. A culpa e do codec DE FATO no ar: um AV1 que trava ou sai da placa marca o AV1, nunca o H.264.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.av1.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, negotiatedCodecs, rtpCapabilities, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps, setAv1HwFeature, setAv1ProbeOk, setH264HighProbeOk, setH264HwStuck } from "./codec";
import { rt } from "./context";
import { H264_STALL_MS, onCodecRequest, sendPlanFor, startStreaming, stopStreaming } from "./streaming";
import { av1ProbeRecord, highProbeRecord, STUCK_NOTICE_AV1, stuckEncoderDiagnostics, stuckRecord } from "./stuckEncoder";

const NVENC_AV1 = "MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)";
const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";
const AV1_SEND = "level-idx=5;profile=0;tier=0";
const fmtp = (profile: string) => `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`;
const VIDEO: RTCRtpCodec[] = [...DEFAULT_VIDEO_CODECS, { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp("640032") }];
const BOTH = { v: 1, h264High: true, av1: true };
const OK = "30 pacotes de 30 quadros";
const AT = new Date(2026, 10, 2, 9, 0).getTime();

let rig: StreamingRig;
let seq = 0;

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            rtpCapabilities.sender = { ...rtpCapabilities.sender, video: VIDEO };
            rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video: VIDEO };
            rtc.mediaCapabilities.hwEncode = ["42001f", "640032", "av1"];
            rtc.mediaCapabilities.hwDecode = ["42001f", "640032", "av1"];
            setAv1HwFeature(true);
            pluginSettings.load({
                codec: "av1",
                hwH264Probe: { at: AT, env: {}, verdict: "ok", detail: OK },
                hwH264HighProbe: { at: AT, env: {}, verdict: "ok", detail: OK, profile: "640032" },
                hwAv1Probe: { at: AT, env: {}, verdict: "ok", detail: OK, codec: "av01.0.05M.08" }
            });
        }
    });
    for (let i = 0; i < 200 && !getLocalCaps().av1ProbeOk; i++) await turns(1);
    assert.equal(getLocalCaps().av1ProbeOk, true, "o AV1 salvo deste ambiente vale");
    await enterCall(rig, []);
    pluginSettings.set("autoQuality", false);
    pluginSettings.set("requireVerifiedIdentity", false);
    await startStreaming(screenOptions());
    assert.equal(rt.lastError, null, "este PC pronto para o AV1: nenhum aviso");
});

after(async () => {
    stopStreaming();
    await destroyRig(rig);
});

// cada teste comeca com a placa, as sondas e o recurso ok (os de falha marcam o AV1 ou travam a placa nesta sessao)
beforeEach(() => {
    setH264HwStuck(false);
    setH264HighProbeOk(true);
    setAv1ProbeOk(true);
    setAv1HwFeature(true);
    pluginSettings.set("codec", "av1");
});

async function watcher(name: string, hwDecode?: unknown, h264HwDecode = true) {
    seq++;
    const peerId = `p${name}`;
    const pc = await connectViewer(rig, peerId, String(850_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode, hwDecode });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    const sender = videoSenderOf(pc)!;
    sender.params.codecs = negotiatedCodecs(VIDEO);
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, sender };
}

const plan = (peerId: string) => ({ ...sendPlanFor(peerId), bitrate: undefined, label: undefined });
const av1Stats = (over: Parameters<typeof videoSenderStats>[0] = {}) => videoSenderStats({
    mimeType: "video/AV1", codecFmtp: `${AV1_SEND};x-google-max-bitrate=8000`, encoderImplementation: NVENC_AV1, powerEfficientEncoder: true, framesEncoded: 600,
    bytesSent: 900_000, frameWidth: 1920, frameHeight: 1080, ...over
});
const h264Stats = (frames = 900) => videoSenderStats({ mimeType: "video/H264", codecFmtp: fmtp("640032"), encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: frames, bytesSent: 1_500_000 });

test("AV1 fixado: so para quem anuncia AV1 na placa (com o High de reserva); a versao de antes recebe o High; o log diz o codec e o porque", async () => {
    const since = logMark();
    const both = await watcher("ambos", BOTH);
    const old = await watcher("antes", { v: 1, h264High: true, h265: true });
    const lines = since();
    assert.deepEqual(plan(both.peerId), { codec: "av1", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
    assert.deepEqual(plan(old.peerId), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
    assert.ok(lines.includes(`Enviando para ${both.label}: codec AV1 (fixado nas configurações (AV1 por hardware nos dois lados: este PC codifica AV1 na placa, `
        + "com a sonda do AV1 ok, e o espectador decodifica AV1 na placa; reserva H.264 perfil 640032/42001f))"), lines.join("\n"));
    assert.ok(lines.some(l => l.startsWith(`Enviando para ${old.label}: codec H264 (AV1 fixado nas configurações, mas o espectador não anuncia AV1 por hardware `)), lines.join("\n"));
    assert.ok(stuckEncoderDiagnostics().includes("AV1 fixado ligado (só com quem anuncia AV1 por hardware)"));
});

test("no automatico, nunca AV1 (nem com tudo ok): o High de antes", async () => {
    pluginSettings.set("codec", "auto");
    const v = await watcher("auto", BOTH);
    assert.deepEqual(plan(v.peerId), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
});

test("Codificando para: o AV1 negociado, com o nivel e o perfil (sem os x-google-*), na placa", async () => {
    const v = await watcher("codifica", BOTH);
    v.sender.stats = av1Stats();
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.includes(`Codificando para ${v.label}: video/AV1 (${AV1_SEND}) (${NVENC_AV1}, hardware)`), lines.join("\n"));
    assert.equal(plan(v.peerId).codec, "av1");
    assert.equal(av1ProbeRecord()?.verdict, "ok", "nada marcado");
});

test("o libaom no lugar da placa (powerEfficientEncoder false): sai do AV1 na hora para a reserva H.264, sem reconectar; marca so o AV1", async () => {
    const v = await watcher("libaom", BOTH);
    v.sender.stats = av1Stats({ powerEfficientEncoder: false, encoderImplementation: "libaom" });
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.some(l => l.startsWith(`O AV1 para ${v.label} não está sendo codificado pela placa de vídeo (libaom): o AV1 fica desligado neste PC`)
        && l.endsWith(`trocando para H264 só para ${v.label}.`)), lines.join("\n"));
    await turns();
    assert.equal(plan(v.peerId).codec, "h264");
    assert.equal(v.sender.encoding.codec?.mimeType, "video/H264", "trocado com setParameters");
    assert.equal(av1ProbeRecord()?.verdict, "offHw", "software e nao travou: o botao da placa limpa");
    assert.equal(av1ProbeRecord()?.source, "stream");
    assert.equal(stuckRecord(), null, "o H.264 nao fica marcado");
    assert.equal(highProbeRecord()?.verdict, "ok");
    const next = await watcher("depoislibaom", BOTH);
    assert.equal(plan(next.peerId).codec, "h264", "o AV1 desligado: os proximos vao no High");
});

test("o libaom sem o powerEfficientEncoder (so o nome): tambem sai do AV1", async () => {
    pluginSettings.set("hwAv1Probe", { at: AT, env: {}, verdict: "ok", detail: OK, codec: "av01.0.05M.08" });
    const v = await watcher("libaomnome", BOTH);
    v.sender.stats = av1Stats({ omit: ["powerEfficientEncoder"], encoderImplementation: "libaom" });
    await seconds(rig, 2);
    await turns();
    assert.equal(plan(v.peerId).codec, "h264");
    assert.equal(av1ProbeRecord()?.verdict, "offHw");
});

test("o outro lado nao negociou AV1 (H.264 no ar, o AV1 nem na lista negociada): o envio vira a reserva; nada fica marcado", async () => {
    pluginSettings.set("hwAv1Probe", { at: AT, env: {}, verdict: "ok", detail: OK, codec: "av01.0.05M.08" });
    const v = await watcher("semav1", BOTH);
    v.sender.params.codecs = negotiatedCodecs(VIDEO.filter(c => c.mimeType !== "video/AV1"));
    v.sender.stats = h264Stats(600);
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.includes(`${v.label} não negociou AV1: o vídeo para ele vai em H264 (a reserva); nada fica marcado neste PC`), lines.join("\n"));
    assert.deepEqual(plan(v.peerId), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
    assert.equal(av1ProbeRecord()?.verdict, "ok");
    assert.equal(getLocalCaps().av1ProbeOk, true);
});

test("o WebRTC trocou do AV1 para o H.264 (ou o AV1 so presente na lista negociada): culpa do AV1, sem o registro do H.264", async () => {
    const v = await watcher("trocou", BOTH);
    let n = 0;
    v.sender.stats = () => (n++ < 2 ? av1Stats() : h264Stats());
    const since = logMark();
    await seconds(rig, 4);
    const lines = since();
    assert.ok(lines.includes(`O AV1 para ${v.label} saiu do ar: o WebRTC trocou sozinho para H264 (o encoder AV1 da placa de vídeo falhou). `
        + "O AV1 fica desligado neste PC até o driver, o Chromium ou a placa mudarem; o H.264 não leva a culpa."), lines.join("\n"));
    await turns();
    assert.equal(av1ProbeRecord()?.verdict, "broken");
    assert.equal(stuckRecord(), null);
    assert.equal(plan(v.peerId).codec, "h264");

    setAv1ProbeOk(true);
    const w = await watcher("presente", BOTH);
    const h264First = VIDEO.filter(c => c.mimeType === "video/H264").concat(VIDEO.filter(c => c.mimeType !== "video/H264"));
    w.sender.params.codecs = negotiatedCodecs(h264First);
    w.sender.stats = h264Stats(300);
    const since2 = logMark();
    await seconds(rig, 2);
    assert.ok(since2().some(l => l.startsWith(`O AV1 para ${w.label} saiu do ar: o WebRTC trocou sozinho para H264`)), "a presenca na lista, nunca a posicao");
});

test("quem assiste nao decodificou o AV1 e pediu VP9: vai a reserva H.264 so para ele; nada fica marcado neste PC", async () => {
    pluginSettings.set("hwAv1Probe", { at: AT, env: {}, verdict: "ok", detail: OK, codec: "av01.0.05M.08" });
    const v = await watcher("naodecod", BOTH);
    let frames = 0;
    v.sender.stats = () => av1Stats({ sourceFrames: (frames += 60), sourceFps: 60 });
    await seconds(rig, 2);
    const since = logMark();
    onCodecRequest(v.peerId, { codec: "vp9" });
    await turns();
    const lines = since();
    assert.ok(lines.includes(`${v.label} não decodificou nenhum quadro do vídeo em AV1 e pediu VP9: trocando para H264 só para ${v.label}. `
        + "Não conta como queda do AV1 deste PC (pode ser o decodificador dele)."), lines.join("\n"));
    assert.equal(plan(v.peerId).codec, "h264");
    assert.equal(getLocalCaps().av1ProbeOk, true);
});

test("AV1 sem reserva (o espectador sem H.264 na placa) fora da placa antes de soltar algo (checkStall): culpa do AV1, vai VP9", async () => {
    const v = await watcher("semres", { v: 1, av1: true }, false);
    assert.deepEqual(plan(v.peerId), { codec: "av1", h264Profile: null, bitrate: undefined, label: undefined });
    let source = 0;
    v.sender.stats = () => videoSenderStats({ mimeType: "video/AV1", powerEfficientEncoder: false, encoderImplementation: "libaom", framesEncoded: 0, bytesSent: 0, sourceFrames: (source += 60), sourceFps: 60 });
    const since = logMark();
    await seconds(rig, H264_STALL_MS / 1000 + 2);
    const lines = since();
    assert.ok(lines.some(l => l.includes(", fora da placa de vídeo: o AV1 fica desligado neste PC") && l.endsWith(`trocando para VP9 só para ${v.label}.`)), lines.join("\n"));
    assert.equal(plan(v.peerId).codec, "vp9");
    assert.equal(stuckRecord(), null);
    await turns();
    assert.equal(av1ProbeRecord()?.verdict, "offHw", "libaom parado (stall): e software, nao travou a placa; o botao limpa");
});

test("AV1 por software abaixo de 270p parado (checkStall): o libaom e de proposito, nao e a placa; nada marcado, mas so este espectador vai para o H.264", async () => {
    pluginSettings.set("hwAv1Probe", { at: AT, env: {}, verdict: "ok", detail: OK, codec: "av01.0.05M.08" });
    const v = await watcher("pequeno", BOTH);
    assert.equal(plan(v.peerId).codec, "av1");
    let source = 0;
    v.sender.stats = () => videoSenderStats({
        mimeType: "video/AV1", powerEfficientEncoder: false, encoderImplementation: "libaom", framesEncoded: 0, bytesSent: 0, frameWidth: 426, frameHeight: 240,
        sourceFrames: (source += 60), sourceFps: 60
    });
    const since = logMark();
    await seconds(rig, H264_STALL_MS / 1000 + 2);
    const lines = since();
    assert.ok(lines.some(l => l.includes("240p, abaixo de 270p o AV1 por software é de propósito") && l.includes("nada fica marcado")), lines.join("\n"));
    assert.ok(!lines.some(l => l.includes("a placa de vídeo travou") || l.includes("fora da placa de vídeo")), lines.join("\n"));
    assert.ok(lines.some(l => l.endsWith(`trocando para H264 só para ${v.label}`)), lines.join("\n"));
    await turns();
    assert.equal(plan(v.peerId).codec, "h264", "o libaom parado deixaria o espectador no preto: vai a reserva H.264");
    assert.equal(av1ProbeRecord()?.verdict, "ok", "o AV1 nao leva a culpa");
    assert.equal(stuckRecord(), null);
    assert.equal(getLocalCaps().av1ProbeOk, true);
    assert.equal(rt.lastError, null);
});

test("um envio em AV1 que trava (nada sai, o encoder da placa): contido; marca o AV1, nunca o H.264; o aviso diz que da proxima vez vai sem o AV1", async () => {
    pluginSettings.set("hwAv1Probe", { at: AT, env: {}, verdict: "ok", detail: OK, codec: "av01.0.05M.08" });
    const v = await watcher("travaav1", BOTH);
    assert.equal(plan(v.peerId).codec, "av1");
    let source = 0;
    v.sender.stats = () => videoSenderStats({
        mimeType: "video/AV1", framesEncoded: 0, bytesSent: 0, sourceFrames: (source += 60), sourceFps: 60,
        omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight"]
    });
    const since = logMark();
    await seconds(rig, H264_STALL_MS / 1000 + 2);
    const lines = since();
    assert.ok(lines.some(l => l.includes(`O encoder AV1 para ${v.label} não codificou nenhum quadro`)
        && l.includes(`: a placa de vídeo travou com AV1. O envio para ${v.label} fica como está até o Discord reiniciar `)
        && l.endsWith("O AV1 fica desligado neste PC até o driver, o Chromium ou a placa mudarem (o H.264 não leva a culpa); nesta sessão, o automático vai em VP9.")), lines.join("\n"));
    assert.equal(rt.lastError, STUCK_NOTICE_AV1);
    assert.equal(plan(v.peerId).codec, "av1", "contido: nada troca o codec");
    await turns();
    assert.equal(stuckRecord(), null);
    assert.equal(av1ProbeRecord()?.verdict, "broken");
    assert.equal(av1ProbeRecord()?.detail, "o encoder da placa de vídeo travou numa transmissão em AV1");
});

test("AV1 fixado sem o WebRtcAV1HWEncode nesta partida: a transmissao avisa na barra por que vai no Automatico; ninguem recebe AV1", async () => {
    stopStreaming();
    setAv1HwFeature(false);
    const since = logMark();
    await startStreaming(screenOptions());
    const why = "o AV1 da placa de vídeo ainda não está ligado nesta partida do Discord (reinicie o Discord)";
    assert.equal(rt.lastError, `O formato de vídeo está fixado em AV1, mas ${why}. A transmissão vai no Automático.`);
    assert.ok(since().includes(`warn: O formato de vídeo está fixado em AV1, mas ${why}: esta transmissão vai no automático (o AV1 nunca vai por software)`.slice(6)));
    const v = await watcher("semrecurso", BOTH);
    assert.deepEqual([plan(v.peerId).codec, plan(v.peerId).h264Profile], ["h264", "640032"], "o High do automatico, nunca AV1");
    pluginSettings.set("codec", "auto");
    stopStreaming();
    await startStreaming(screenOptions());
    assert.equal(rt.lastError, null, "sem o AV1 fixado: nada a dizer");
});
