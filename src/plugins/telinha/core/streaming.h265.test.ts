/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// H.265 de ponta a ponta no envio (core/streaming.ts → sendTo → chooseCodec → sendPlanFor → tick), com este PC
// codificando 42001f, 640032 e H.265 Main na placa, o H.265 fixado (ele e so manual) e as tres sondas ja "ok". Cada espectador
// recebe o que a presenca dele permite (H.265 so com caps.hwDecode.h265; a v0.3.3 recebe o High). Quando algo falha no
// ar, a culpa e do codec DE FATO no ar (o das estatisticas), nao do que a decisao pediu: um H.265 que trava ou sai da
// placa marca o H.265 (nunca o registro do H.264); uma decisao H.265 negociada em H.264 que trava culpa o H.264.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.h265.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, negotiatedCodecs, rtpCapabilities, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps, setH264HighProbeOk, setH264HwStuck, setH265ProbeOk } from "./codec";
import { rt } from "./context";
import { H264_STALL_MS, onCodecRequest, sendPlanFor, startStreaming, stopStreaming } from "./streaming";
import { h265ProbeRecord, highProbeRecord, STUCK_NOTICE_H265, stuckEncoderDiagnostics, stuckRecord } from "./stuckEncoder";

const NVENC_HEVC = "MediaFoundationVideoEncodeAccelerator (NVIDIA HEVC Encoder MFT)";
const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";
const H265_SEND = "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST";
const fmtp = (profile: string) => `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`;
const VIDEO: RTCRtpCodec[] = [...DEFAULT_VIDEO_CODECS, { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp("640032") }, { mimeType: "video/H265", clockRate: 90000, sdpFmtpLine: H265_SEND }];
const BOTH = { v: 1, h264High: true, h265: true };
const OK = "30 pacotes de 30 quadros";

let rig: StreamingRig;
let seq = 0;

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            rtpCapabilities.sender = { ...rtpCapabilities.sender, video: VIDEO };
            rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video: VIDEO };
            rtc.mediaCapabilities.hwEncode = ["42001f", "640032", "h265"];
            rtc.mediaCapabilities.hwDecode = ["42001f", "640032", "h265"];
            const at = new Date(2026, 10, 2, 9, 0).getTime();
            pluginSettings.load({
                hwH264Probe: { at, env: {}, verdict: "ok", detail: OK },
                hwH264HighProbe: { at, env: {}, verdict: "ok", detail: OK, profile: "640032" },
                hwH265Probe: { at, env: {}, verdict: "ok", detail: OK, codec: "hvc1.1.6.L123.B0" }
            });
        }
    });
    for (let i = 0; i < 200 && !getLocalCaps().h265ProbeOk; i++) await turns(1);
    assert.equal(getLocalCaps().h265ProbeOk, true, "o H.265 salvo deste ambiente vale");
    await enterCall(rig, []);
    pluginSettings.set("autoQuality", false);
    pluginSettings.set("requireVerifiedIdentity", false);
    // o H.265 e so manual
    pluginSettings.set("codec", "h265");
    await startStreaming(screenOptions());
});

after(async () => {
    stopStreaming();
    await destroyRig(rig);
});

// cada teste comeca com a placa e as sondas ok (os de falha marcam o H.265 ou travam a placa nesta sessao)
beforeEach(() => {
    setH264HwStuck(false);
    setH264HighProbeOk(true);
    setH265ProbeOk(true);
});

async function watcher(name: string, hwDecode?: unknown) {
    seq++;
    const peerId = `p${name}`;
    const pc = await connectViewer(rig, peerId, String(820_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: true, hwDecode });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    const sender = videoSenderOf(pc)!;
    sender.params.codecs = negotiatedCodecs(VIDEO);
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, sender };
}

const plan = (peerId: string) => ({ ...sendPlanFor(peerId), bitrate: undefined, label: undefined });
const h265Stats = (over: Parameters<typeof videoSenderStats>[0] = {}) => videoSenderStats({
    mimeType: "video/H265", codecFmtp: `${H265_SEND};x-google-max-bitrate=8000`, encoderImplementation: NVENC_HEVC, powerEfficientEncoder: true, framesEncoded: 600,
    bytesSent: 900_000, frameWidth: 1920, frameHeight: 1080, ...over
});

test("H.265 fixado: so para quem anuncia H.265 na placa (com o High de reserva); a v0.3.3 recebe o High; o log diz o codec, a reserva e o porque", async () => {
    const since = logMark();
    const both = await watcher("ambos", BOTH);
    const v033 = await watcher("v033", { v: 1, h264High: true });
    const lines = since();
    assert.deepEqual(plan(both.peerId), { codec: "h265", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
    assert.deepEqual(plan(v033.peerId), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
    assert.ok(lines.includes(`Enviando para ${both.label}: codec H265 (fixado nas configurações (H.265 por hardware nos dois lados: este PC codifica H.265 na placa, `
        + "com a sonda do H.265 ok, e o espectador decodifica H.265 na placa; reserva H.264 perfil 640032/42001f))"), lines.join("\n"));
    assert.ok(lines.some(l => l.startsWith(`Enviando para ${v033.label}: codec H264 (H.265 fixado nas configurações, mas o espectador não anuncia H.265 por hardware `
        + "(não tem, ou é uma versão antiga do Telinha) → automático: H.264 High por hardware")), lines.join("\n"));
    assert.ok(stuckEncoderDiagnostics().includes("H.265 fixado ligado (só com quem anuncia H.265 por hardware)"));
});

test("no automatico, nunca H.265 (nem com tudo ok): o High de antes", async () => {
    pluginSettings.set("codec", "auto");
    try {
        const v = await watcher("auto", BOTH);
        assert.deepEqual(plan(v.peerId), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
        assert.ok(stuckEncoderDiagnostics().includes("H.265 fixado desligado (o formato de vídeo não está em H.265)"));
    } finally {
        pluginSettings.set("codec", "h265");
    }
});

test("Codificando para: o codec negociado de fato, com o nivel do H.265 (sem os x-google-*)", async () => {
    const v = await watcher("codifica", BOTH);
    v.sender.stats = h265Stats();
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.includes(`Codificando para ${v.label}: video/H265 (${H265_SEND}) (${NVENC_HEVC}, hardware)`), lines.join("\n"));
    assert.equal(h265ProbeRecord()?.verdict, "ok", "nada marcado");
});

test("o outro lado nao negociou H.265 (H.264 no ar, o H.265 nem na lista negociada): o envio vira a reserva; nada fica marcado", async () => {
    const v = await watcher("semh265", BOTH);
    v.sender.params.codecs = negotiatedCodecs(VIDEO.filter(c => c.mimeType !== "video/H265"));
    v.sender.stats = videoSenderStats({ mimeType: "video/H264", codecFmtp: fmtp("640032"), encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: 600, bytesSent: 900_000 });
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.includes(`${v.label} não negociou H.265: o vídeo para ele vai em H264 (a reserva); nada fica marcado neste PC`), lines.join("\n"));
    assert.ok(lines.includes(`Codificando para ${v.label}: video/H264 perfil 640032 (${NVENC}, hardware)`), "sem aviso de codec inesperado");
    assert.deepEqual(plan(v.peerId), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
    assert.equal(h265ProbeRecord()?.verdict, "ok");
    assert.equal(getLocalCaps().h265ProbeOk, true);
});

test("o WebRTC trocou sozinho do H.265 para o H.264 (o encoder H.265 falhou): culpa do H.265, sem o registro do H.264; o envio segue na reserva", async () => {
    const v = await watcher("trocou", BOTH);
    let n = 0;
    v.sender.stats = () => (n++ < 2 ? h265Stats() : videoSenderStats({ mimeType: "video/H264", codecFmtp: fmtp("640032"), encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: 900, bytesSent: 1_500_000 }));
    const since = logMark();
    await seconds(rig, 4);
    const lines = since();
    assert.ok(lines.includes(`O H.265 para ${v.label} saiu do ar: o WebRTC trocou sozinho para H264 (o encoder H.265 da placa de vídeo falhou). `
        + "O H.265 fica desligado neste PC até o driver, o Chromium ou a placa mudarem; o H.264 não leva a culpa."), lines.join("\n"));
    assert.equal(plan(v.peerId).codec, "h264");
    await turns();
    assert.equal(h265ProbeRecord()?.verdict, "broken");
    assert.equal(h265ProbeRecord()?.source, "stream");
    assert.equal(stuckRecord(), null, "o H.264 nao fica marcado");
    assert.equal(highProbeRecord()?.verdict, "ok", "nem o High");
    assert.equal(getLocalCaps().h264HwEncode, true);
    const next = await watcher("depois", BOTH);
    assert.equal(plan(next.peerId).codec, "h264", "o H.265 desligado; os proximos vao no High");
    assert.equal(plan(next.peerId).h264Profile, "640032");
});

test("o encoder H.265 morreu antes do 1o quadro: o WebRTC ja estava no H.264 (o libwebrtc poe o codec atual na frente da lista), o H.265 so presente nela: culpa do H.265", async () => {
    const v = await watcher("morreu", BOTH);
    // nenhuma leitura em H.265 antes; a lista negociada com o H.264 (o codec de envio atual) em 1o e o H.265 depois
    const h264First = VIDEO.filter(c => c.mimeType === "video/H264").concat(VIDEO.filter(c => c.mimeType !== "video/H264"));
    v.sender.params.codecs = negotiatedCodecs(h264First);
    assert.equal(v.sender.params.codecs[0].mimeType, "video/H264");
    v.sender.stats = videoSenderStats({ mimeType: "video/H264", codecFmtp: fmtp("640032"), encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: 300, bytesSent: 600_000 });
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.includes(`O H.265 para ${v.label} saiu do ar: o WebRTC trocou sozinho para H264 (o encoder H.265 da placa de vídeo falhou). `
        + "O H.265 fica desligado neste PC até o driver, o Chromium ou a placa mudarem; o H.264 não leva a culpa."), lines.join("\n"));
    await turns();
    assert.equal(h265ProbeRecord()?.verdict, "broken", "o proximo espectador nao tenta de novo");
    assert.equal(stuckRecord(), null);
    assert.equal(plan(v.peerId).codec, "h264");
    const next = await watcher("depoismorreu", BOTH);
    assert.equal(plan(next.peerId).codec, "h264");
});

test("H.265 fora da placa (powerEfficientEncoder false): o H.265 marcado; so ele vai para a reserva H.264, sem reconectar", async () => {
    const v = await watcher("fora", BOTH);
    v.sender.stats = h265Stats({ powerEfficientEncoder: false, encoderImplementation: "?" });
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.some(l => l.startsWith(`O H.265 para ${v.label} não está sendo codificado pela placa de vídeo (?): o H.265 fica desligado neste PC`)
        && l.endsWith(`trocando para H264 só para ${v.label}.`)), lines.join("\n"));
    await turns();
    assert.equal(plan(v.peerId).codec, "h264");
    assert.equal(v.sender.encoding.codec?.mimeType, "video/H264", "trocado com setParameters");
    assert.equal(h265ProbeRecord()?.verdict, "broken");
    assert.equal(stuckRecord(), null);
});

test("quem assiste nao decodificou o H.265 e pediu VP9: vai a reserva H.264 so para ele; nada fica marcado neste PC", async () => {
    const v = await watcher("naodecod", BOTH);
    let frames = 0;
    v.sender.stats = () => h265Stats({ sourceFrames: (frames += 60), sourceFps: 60 });
    await seconds(rig, 2);
    const since = logMark();
    onCodecRequest(v.peerId, { codec: "vp9" });
    await turns();
    const lines = since();
    assert.ok(lines.includes(`${v.label} não decodificou nenhum quadro do vídeo em H.265 e pediu VP9: trocando para H264 só para ${v.label}. `
        + "Não conta como queda do H.265 deste PC (pode ser o decodificador dele)."), lines.join("\n"));
    assert.equal(plan(v.peerId).codec, "h264");
    assert.equal(getLocalCaps().h265ProbeOk, true, "o H.265 deste PC continua");
});

test("H.265 fixado, espectador sem H.264 na placa (reserva Baseline da placa): o outro lado negociou H.264 (vira H.264) ou VP8 (vira VP8); nada marcado", async () => {
    pluginSettings.set("codec", "h265");
    try {
        seq++;
        const make = async (name: string) => {
            const peerId = `p${name}`;
            const pc = await connectViewer(rig, peerId, String(830_000_000_000_000_000n + BigInt(seq++)), name, { h264HwDecode: false, hwDecode: { v: 1, h265: true } });
            rig.room.receive("watch", { op: "start" }, peerId);
            await turns();
            const sender = videoSenderOf(pc)!;
            sender.params.codecs = negotiatedCodecs(DEFAULT_VIDEO_CODECS);
            return { peerId, sender };
        };
        const a = await make("semres264");
        const b = await make("semresvp8");
        assert.deepEqual(plan(a.peerId), { codec: "h265", h264Profile: "42001f", bitrate: undefined, label: undefined });
        a.sender.stats = videoSenderStats({ mimeType: "video/H264", codecFmtp: fmtp("42001f"), encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: 600, bytesSent: 900_000 });
        b.sender.stats = videoSenderStats({ mimeType: "video/VP8", encoderImplementation: "libvpx", powerEfficientEncoder: false, framesEncoded: 600, bytesSent: 900_000 });
        await seconds(rig, 2);
        assert.deepEqual([plan(a.peerId).codec, plan(a.peerId).h264Profile], ["h264", "42001f"]);
        assert.equal(plan(b.peerId).codec, "vp8");
        assert.equal(getLocalCaps().h265ProbeOk, true);
    } finally {
        pluginSettings.set("codec", "h265");
    }
});

test("H.265 fixado com o Baseline da placa de reserva (espectador decodifica H.264 por software) que sai da placa antes de soltar algo (checkStall): culpa do H.265, vai o que o automatico escolhe sem ele (H.264 Baseline da placa)", async () => {
    pluginSettings.set("codec", "h265");
    try {
        const peerId = "psemres";
        const pc = await connectViewer(rig, peerId, String(840_000_000_000_000_000n + BigInt(seq++)), "semres", { h264HwDecode: false, hwDecode: { v: 1, h265: true } });
        rig.room.receive("watch", { op: "start" }, peerId);
        await turns();
        const sender = videoSenderOf(pc)!;
        assert.equal(plan(peerId).codec, "h265");
        let source = 0;
        sender.stats = () => videoSenderStats({ mimeType: "video/H265", powerEfficientEncoder: false, encoderImplementation: "?", framesEncoded: 0, bytesSent: 0, sourceFrames: (source += 60), sourceFps: 60 });
        const since = logMark();
        await seconds(rig, H264_STALL_MS / 1000 + 2);
        const lines = since();
        assert.ok(lines.some(l => l.includes(", fora da placa de vídeo: o H.265 fica desligado neste PC") && l.endsWith("trocando para H264 só para semres (psemre).")), lines.join("\n"));
        assert.equal(plan(peerId).codec, "h264");
        await turns();
        assert.equal(h265ProbeRecord()?.verdict, "broken");
        assert.equal(stuckRecord(), null);
    } finally {
        pluginSettings.set("codec", "h265");
    }
});

test("decisao H.265 negociada em H.264 High que trava: culpa do High (o negociado), nunca do H.265", async () => {
    const v = await watcher("travah264", BOTH);
    let source = 0;
    v.sender.stats = () => videoSenderStats({
        mimeType: "video/H264", codecFmtp: fmtp("640032"), framesEncoded: 0, bytesSent: 0, sourceFrames: (source += 60), sourceFps: 60,
        omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight"]
    });
    const h265Before = h265ProbeRecord();
    const since = logMark();
    await seconds(rig, H264_STALL_MS / 1000 + 2);
    const lines = since();
    assert.ok(lines.some(l => l.includes(`: a placa de vídeo travou com H.264 High (perfil 640032). O envio para ${v.label} fica como está`)), lines.join("\n"));
    await turns();
    assert.equal(highProbeRecord()?.verdict, "broken", "o High leva a culpa");
    assert.deepEqual(h265ProbeRecord(), h265Before, "o H.265 nao");
    assert.equal(stuckRecord(), null);
});

test("um envio em H.265 que trava (nada sai): contido; marca o H.265, nunca o H.264; o aviso diz que da proxima vez vai sem o H.265", async () => {
    const v = await watcher("travah265", BOTH);
    assert.equal(plan(v.peerId).codec, "h265");
    let source = 0;
    v.sender.stats = () => videoSenderStats({
        mimeType: "video/H265", framesEncoded: 0, bytesSent: 0, sourceFrames: (source += 60), sourceFps: 60,
        omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight"]
    });
    const since = logMark();
    await seconds(rig, H264_STALL_MS / 1000 + 2);
    const lines = since();
    assert.ok(lines.some(l => l.includes(`O encoder H.265 para ${v.label} não codificou nenhum quadro`)
        && l.includes(`: a placa de vídeo travou com H.265. O envio para ${v.label} fica como está até o Discord reiniciar `)
        && l.endsWith("O H.265 fica desligado neste PC até o driver, o Chromium ou a placa mudarem (o H.264 não leva a culpa); nesta sessão, o automático vai em VP9.")), lines.join("\n"));
    assert.equal(rt.lastError, STUCK_NOTICE_H265);
    assert.equal(plan(v.peerId).codec, "h265", "contido: nada troca o codec");
    assert.equal(getLocalCaps().h264HwEncode, false, "VP9 ate reiniciar");
    await turns();
    assert.equal(stuckRecord(), null, "o H.264 nao fica marcado: na proxima abertura, o H.264 da placa");
    assert.equal(h265ProbeRecord()?.verdict, "broken");
    assert.equal(h265ProbeRecord()?.detail, "o encoder da placa de vídeo travou numa transmissão em H.265");
});
