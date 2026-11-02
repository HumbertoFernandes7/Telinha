/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// H.264 High de ponta a ponta no envio (core/streaming.ts → sendTo → chooseCodec → sendPlanFor), com este PC codificando
// 42001f e 640032 na placa (a sonda de codecs falsa) e as duas sondas WebCodecs ja "ok" neste ambiente (salvas, como
// numa abertura depois da 1a). Cada espectador recebe o que a presenca dele permite: High so com caps.hwDecode.h264High
// (protocol.ts passo 11); a v0.3.2 (sem o campo) e uma versao futura (outro `v`) recebem o Baseline de sempre. O log diz o
// perfil escolhido e o porque, e o "Codificando para" mostra o perfil negociado de fato (o fmtp do codec em uso).
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.high.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { pluginSettings } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, rtpCapabilities, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps, setH264HighProbeOk, setH264HwStuck } from "./codec";
import { rt } from "./context";
import { DEGRADATION_FOR, H264_STALL_MS, sendPlanFor, startStreaming, stopStreaming } from "./streaming";
import { highProbeRecord, STUCK_NOTICE_HIGH, stuckEncoderDiagnostics, stuckRecord } from "./stuckEncoder";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";
const fmtp = (profile: string) => `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`;
const HIGH_REASON = "automático: H.264 High por hardware nos dois lados (perfil 640032: este PC codifica High na placa, com a sonda do High ok, "
    + "e o espectador decodifica High na placa; reserva 42001f)";
const NO_HIGH_VIEWER = "automático: H.264 por hardware nos dois lados (perfil 42001f; High não: o espectador não anuncia High por hardware "
    + "(não tem, ou é uma versão antiga do Telinha))";

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

test("High so para quem anuncia High na placa; a v0.3.2 e uma versao futura recebem o Baseline; o log diz o perfil e o porque", async () => {
    const since = logMark();
    const high = await watcher("alto", { v: 1, h264High: true });
    const old = await watcher("velho");
    const future = await watcher("futuro", { v: 2, h264High: true });
    const lines = since();

    const plan = (peerId: string) => ({ ...sendPlanFor(peerId), bitrate: undefined, label: undefined });
    assert.deepEqual(plan(high.peerId), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", bitrate: undefined, label: undefined });
    assert.deepEqual(plan(old.peerId), { codec: "h264", h264Profile: "42001f", bitrate: undefined, label: undefined });
    assert.deepEqual(plan(future.peerId), { codec: "h264", h264Profile: "42001f", bitrate: undefined, label: undefined });

    assert.ok(lines.includes(`Enviando para ${high.label}: codec H264 (${HIGH_REASON})`), lines.join("\n"));
    assert.ok(lines.includes(`Enviando para ${old.label}: codec H264 (${NO_HIGH_VIEWER})`));
    assert.ok(lines.includes(`Enviando para ${future.label}: codec H264 (${NO_HIGH_VIEWER})`));
    assert.ok(lines.includes(`${high.label}: não está transmitindo; H.264 por hardware: sim; High por hardware: sim`));
    assert.ok(lines.includes(`${old.label}: não está transmitindo; H.264 por hardware: sim`));
    assert.ok(lines.includes(`${future.label}: não está transmitindo; H.264 por hardware: sim`), "versao futura: o campo e ignorado");

    // o "Copiar diagnóstico" mostra o estado do High (e as linhas acima vao nos eventos dele)
    assert.ok(stuckEncoderDiagnostics().endsWith("High automático ligado (só com quem anuncia High por hardware)"));
});

test("Codificando para: o perfil negociado de fato; High pedido e Baseline negociado vira aviso", async () => {
    const high = await watcher("alto2", { v: 1, h264High: true });
    const missed = await watcher("semhigh", { v: 1, h264High: true });
    const old = await watcher("velho2");
    const stats = (profile: string) => videoSenderStats({ mimeType: "video/H264", codecFmtp: fmtp(profile), encoderImplementation: NVENC, powerEfficientEncoder: true, framesEncoded: 600 });
    high.sender.stats = stats("640032");
    missed.sender.stats = stats("42001f");
    old.sender.stats = stats("42001f");
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.includes(`Codificando para ${high.label}: video/H264 perfil 640032 (${NVENC}, hardware)`), lines.join("\n"));
    assert.ok(lines.includes(`Codificando para ${missed.label}: video/H264 perfil 42001f (${NVENC}, hardware) — esperado o perfil 640032`));
    assert.ok(lines.includes(`Codificando para ${old.label}: video/H264 perfil 42001f (${NVENC}, hardware)`));
});

test("um envio que comecou na placa continua \"placa\" se o H.264 for segurado logo depois (a sonda do High), antes das estatisticas", async () => {
    seq++;
    const peerId = "pseguro";
    const pc = await connectViewer(rig, peerId, String(810_000_000_000_000_000n + BigInt(seq)), "seguro", { h264HwDecode: true, hwDecode: { v: 1, h264High: true } });
    rig.room.receive("watch", { op: "start" }, peerId);
    assert.equal(sendPlanFor(peerId)?.codec, "h264", "decidido na placa");
    // o H.264 da placa e segurado antes de os parametros de envio serem aplicados (o addStream ainda nao terminou)
    setH264HwStuck(true);
    try {
        await turns();
        assert.equal((videoSenderOf(pc)!.params as { degradationPreference?: string; }).degradationPreference, DEGRADATION_FOR.hardware[0],
            "o encoder que ja sobe e o da placa: a preferencia da placa");
    } finally {
        setH264HwStuck(false);
    }
});

test("um envio em High que cai para o OpenH264 de verdade: o High fica travado neste PC (nao o Baseline); ele vai para VP9, os proximos para o Baseline", async () => {
    const v = await watcher("caiu", { v: 1, h264High: true });
    assert.equal(sendPlanFor(v.peerId)?.h264Profile, "640032");
    v.sender.stats = videoSenderStats({
        mimeType: "video/H264", codecFmtp: fmtp("640032"), encoderImplementation: "OpenH264", powerEfficientEncoder: false, framesEncoded: 600, frameWidth: 1920, frameHeight: 1080
    });
    const since = logMark();
    await seconds(rig, 2);
    const lines = since();
    assert.ok(lines.includes(`O H.264 High (perfil 640032) para ${v.label} caiu para o software: o High fica desligado neste PC até o driver, o Chromium ou a placa mudarem`),
        lines.join("\n"));
    assert.equal(sendPlanFor(v.peerId)?.codec, "vp9");
    await turns();
    assert.equal(highProbeRecord()?.verdict, "broken");
    assert.equal(highProbeRecord()?.source, "stream");
    assert.equal(stuckRecord(), null);
    const next = await watcher("depois", { v: 1, h264High: true });
    assert.equal(sendPlanFor(next.peerId)?.h264Profile, "42001f", "o High desligado; o Baseline continua");
});

test("um envio em High que trava (nada sai): contido; marca o High, nao o Baseline; o aviso diz que da proxima vez vai sem o High", async () => {
    setH264HighProbeOk(true);
    const v = await watcher("trava", { v: 1, h264High: true });
    assert.equal(sendPlanFor(v.peerId)?.h264Profile, "640032");
    let source = 0;
    v.sender.stats = () => videoSenderStats({
        mimeType: "video/H264", framesEncoded: 0, bytesSent: 0, sourceFrames: (source += 60), sourceFps: 60,
        omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight"]
    });
    const since = logMark();
    await seconds(rig, H264_STALL_MS / 1000 + 2);
    const lines = since();
    assert.ok(lines.some(l => l.includes(`: a placa de vídeo travou com H.264 High (perfil 640032). O envio para ${v.label} fica como está até o Discord reiniciar `)
        && l.endsWith("O High fica desligado neste PC até o driver, o Chromium ou a placa mudarem; nesta sessão, o automático vai em VP9.")), lines.join("\n"));
    assert.equal(rt.lastError, STUCK_NOTICE_HIGH);
    assert.equal(sendPlanFor(v.peerId)?.codec, "h264", "contido: nada troca o codec");
    assert.equal(getLocalCaps().h264HwEncode, false, "VP9 ate reiniciar");
    await turns();
    assert.equal(stuckRecord(), null, "o Baseline nao fica marcado: na proxima abertura, Baseline");
    assert.equal(highProbeRecord()?.detail, "o encoder da placa de vídeo travou numa transmissão em High");
});
