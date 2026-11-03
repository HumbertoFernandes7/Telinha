/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do relatorio com o encoder de OUTRO codec (core/streaming.ts → tick, checkForeign; isForeignEncoder): o libaom do
// AV1 de antes da troca aparece nas estatisticas do H.264 so de passagem. Mas um encoder da placa que trava ao subir pode
// nunca publicar o nome dele: o relatorio de outro codec vale por H264_STALL_MS e depois o envio e contido (containStuck),
// sem culpar ninguem (nem o H.264, nem o High, nem o codec), e o quality lock sai de "comecando". Um relatorio certo que
// chega a tempo (o encoder subiu) segue normal, sem travamento.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.foreign.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { pluginSettings } from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, type FakeRTCRtpSender, videoSenderStats } from "@test/fakes/webrtc";
import { connectViewer, createRig, destroyRig, enterCall, logMark, repliesTo, screenOptions, seconds, type StreamingRig, turns, videoSenderOf } from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { isContained } from "./peerConnection";
import { STATS_LINE_RE } from "./statsLog";
import { H264_STALL_MS, QUALITY_LOCK_STARTING, QUALITY_LOCK_STUCK, qualityChangeBlocked, sendPlanFor, SENT_MIN_BYTES, startStreaming, stopStreaming } from "./streaming";
import { stuckNoticeUnknown, stuckRecord } from "./stuckEncoder";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";

let rig: StreamingRig;
let seq = 0;

interface TestViewer {
    peerId: string;
    label: string;
    pc: FakeRTCPeerConnection;
    sender: FakeRTCRtpSender;
}

async function watcher(name: string): Promise<TestViewer> {
    seq++;
    const peerId = `f${name}`;
    const pc = await connectViewer(rig, peerId, String(820_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: true });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, pc, sender: videoSenderOf(pc)! };
}

/** O H.264 negociado, com o encoder do AV1 de antes (libaom, sem tamanho): o relatorio de 02/11. */
const foreignStats = (implementation = "libaom") => videoSenderStats({
    mimeType: "video/H264", codecFmtp: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f", encoderImplementation: implementation,
    powerEfficientEncoder: false, framesEncoded: 30, omit: ["frameWidth", "frameHeight"], sourceFrames: 0, sourceFps: 60
});

/** O encoder da placa no ar e o video saindo. */
const sendingStats = () => {
    const entries = videoSenderStats({
        mimeType: "video/H264", codecFmtp: "packetization-mode=1;profile-level-id=42001f", encoderImplementation: NVENC, powerEfficientEncoder: true,
        framesEncoded: 600, bytesSent: SENT_MIN_BYTES * 100
    });
    entries[0].framesSent = 600;
    return entries;
};

const about = (lines: string[], v: TestViewer) => lines.filter(l => l.includes(v.label) && !STATS_LINE_RE.test(l));

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

describe("encoder de outro codec no relatorio por tempo demais (checkForeign)", () => {
    test("o libaom so de passagem e o encoder da placa aparece dentro da janela: normal, sem travamento", async () => {
        const v = await watcher("passagem");
        v.sender.stats = foreignStats();
        await seconds(rig, 5);
        assert.equal(qualityChangeBlocked(), QUALITY_LOCK_STARTING, "o video ainda nao saiu");
        v.sender.stats = sendingStats();
        const since = logMark();
        await seconds(rig, H264_STALL_MS / 1000 + 4);
        assert.deepEqual(about(since(), v), [`Codificando para ${v.label}: video/H264 perfil 42001f (${NVENC}, hardware)`]);
        assert.equal(isContained(v.pc as unknown as RTCPeerConnection), false, "nenhum travamento");
        assert.equal(rt.lastError, null);
        assert.equal(qualityChangeBlocked(), null, "o video saiu: o quality lock acabou");
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        assert.equal(v.sender.encoding.codec, undefined);
    });

    test("so libaom, sempre (o encoder da placa travou ao subir): passados H264_STALL_MS vira travamento contido, sem culpa, e o quality lock sai de \"comecando\"", async () => {
        const counted = getLocalCaps().h264HwEncode;
        const v = await watcher("sempre");
        v.sender.stats = foreignStats();
        const since = logMark();
        await seconds(rig, H264_STALL_MS / 1000 - 2);
        assert.deepEqual(about(since(), v), [], "ainda de passagem: nada no log");
        assert.equal(qualityChangeBlocked(), QUALITY_LOCK_STARTING);
        assert.equal(isContained(v.pc as unknown as RTCPeerConnection), false);

        await seconds(rig, 4);
        assert.ok(isContained(v.pc as unknown as RTCPeerConnection), "contido");
        assert.deepEqual(repliesTo(rig.room, v.peerId).filter(m => m.op === "stuck"), [{ op: "stuck" }], "quem assiste foi avisado uma vez");
        assert.equal(rt.lastError, stuckNoticeUnknown(v.label));
        assert.match(rt.lastError ?? "", /^A transmissão para sempre \(\w+\) travou ao começar\./);
        assert.ok(!/H\.264|VP9/.test(rt.lastError ?? ""), "o aviso nao culpa nenhum codec");
        assert.equal(qualityChangeBlocked(), QUALITY_LOCK_STUCK, "nao esta mais \"comecando\": so o travado, ate o Discord reiniciar");
        // sem culpa: o codec nunca mudou, nada foi marcado e o H.264 automatico segue ligado
        assert.equal(v.sender.encoding.codec, undefined, "nunca trocou o codec");
        assert.ok(v.sender.setCalls.every(p => !(p.encodings[0] as { codec?: unknown; }).codec));
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        assert.equal(stuckRecord(), null, "nada marcado neste PC");
        assert.equal(getLocalCaps().h264HwEncode, counted);
        assert.equal(getLocalCaps().h264HwEncode, true);
        const lines = about(since(), v);
        assert.equal(lines.length, 1, lines.join("\n"));
        assert.match(lines[0], /trouxeram só o encoder de outro codec \(libaom\) por \d+ s/);
        assert.match(lines[0], /nada fica marcado neste PC/);
        assert.match(lines[0], /travou com H\.264\./, "o codec de fato no ar");
        assert.ok(!lines[0].includes("trocando para"), "nunca fallBack");

        // contido: o tick nao le mais esse envio
        const reads = v.sender.getStatsCalls;
        await seconds(rig, 5);
        assert.equal(v.sender.getStatsCalls, reads);
    });

    test("foreign com o video saindo (bytes andando) por 30 s: nunca contido, nada marcado", async () => {
        const v = await watcher("fluindo");
        const stats = foreignStats();
        v.sender.stats = stats;
        const since = logMark();
        for (let i = 0; i < 30; i++) {
            stats[0].bytesSent = (stats[0].bytesSent as number) + 50_000;
            stats[0].framesSent = ((stats[0].framesSent as number | undefined) ?? 0) + 30;
            await seconds(rig, 1);
        }
        assert.equal(isContained(v.pc as unknown as RTCPeerConnection), false, "o video sai: nada contido");
        assert.deepEqual(repliesTo(rig.room, v.peerId).filter(m => m.op === "stuck"), []);
        assert.deepEqual(about(since(), v), []);
        assert.equal(stuckRecord(), null, "nada marcado");
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        assert.equal(getLocalCaps().h264HwEncode, true);
    });
});
