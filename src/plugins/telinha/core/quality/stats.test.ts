/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da leitura das estatisticas de um sender de video (core/quality/stats.ts): o que readSenderSample tira de um
// RTCStatsReport como o do Chromium (e de um incompleto, de versao antiga), o resumo de uma janela (diffSamples) e a
// deteccao de encoder por hardware.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/stats.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FakeRTCRtpSender, type StatsEntry, videoSenderStats, videoTrack } from "@test/fakes/webrtc";

import { diffSamples, isHardwareEncoder, readSenderSample, type SenderSample } from "./stats";

const NVENC = "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)";

function senderWith(stats: StatsEntry[]) {
    const sender = new FakeRTCRtpSender(videoTrack());
    sender.stats = stats;
    return sender as unknown as RTCRtpSender;
}

/** As entradas de videoSenderStats com a outbound-rtp (OT01V) trocada por `out`. */
function withOutbound(out: Record<string, unknown>, init: Parameters<typeof videoSenderStats>[0] = {}): StatsEntry[] {
    return videoSenderStats(init).map(e => (e.id === "OT01V" ? { id: "OT01V", type: "outbound-rtp", kind: "video", ...out } : e));
}

function sample(patch: Partial<SenderSample> = {}): SenderSample {
    return {
        at: 0, framesEncoded: 0, totalEncodeTime: 0, bytesSent: 0, limitation: { cpu: 0, bandwidth: 0 }, reason: "none",
        frameWidth: 1920, frameHeight: 1080, sourceFrames: 0, sourceFps: 60, availableKbps: 20_000, powerEfficient: false,
        implementation: "libvpx", ...patch
    };
}

describe("readSenderSample", () => {
    test("um envio como o Chromium relata: contadores, limitacao, fonte, banda estimada e o encoder", async () => {
        const s = await readSenderSample(senderWith(videoSenderStats({
            framesEncoded: 600, totalEncodeTime: 2.5, bytesSent: 1_000_000, frameWidth: 1280, frameHeight: 720,
            qualityLimitationReason: "bandwidth", qualityLimitationDurations: { cpu: 1.5, bandwidth: 3 },
            sourceFrames: 610, sourceFps: 59, availableOutgoingBitrate: 4_500_000,
            encoderImplementation: NVENC, powerEfficientEncoder: true
        })));
        assert.ok(s);
        assert.equal(typeof s.at, "number");
        assert.deepEqual({ ...s, at: 0 }, {
            at: 0, framesEncoded: 600, totalEncodeTime: 2.5, bytesSent: 1_000_000, limitation: { cpu: 1.5, bandwidth: 3 },
            reason: "bandwidth", frameWidth: 1280, frameHeight: 720, sourceFrames: 610, sourceFps: 59, availableKbps: 4500,
            powerEfficient: true, implementation: NVENC
        });
    });

    test("sem outbound-rtp de video (ainda negociando, ou so audio): null", async () => {
        assert.equal(await readSenderSample(senderWith([])), null);
        assert.equal(await readSenderSample(senderWith([{ id: "OA", type: "outbound-rtp", kind: "audio", bytesSent: 10 }])), null);
    });

    test("duas outbound-rtp de video (ssrc trocado): vale a que mais enviou", async () => {
        // sem bytesSent conta 0 (o primeiro e o ultimo)
        const stats = [{ id: "OT00V", type: "outbound-rtp", kind: "video", framesEncoded: 2 }, ...videoSenderStats({ bytesSent: 500, framesEncoded: 10 })];
        stats.push({ id: "OT02V", type: "outbound-rtp", kind: "video", bytesSent: 9000, framesEncoded: 99 });
        stats.push({ id: "OT03V", type: "outbound-rtp", kind: "video", framesEncoded: 1 });
        const s = await readSenderSample(senderWith(stats));
        assert.equal(s?.framesEncoded, 99);
        assert.equal(s?.bytesSent, 9000);
    });

    test("sem par selecionado no transport: usa o par nomeado e bem-sucedido que tem banda estimada", async () => {
        const stats = videoSenderStats().filter(e => e.type !== "transport" && e.type !== "candidate-pair");
        stats.push(
            { id: "CPa", type: "candidate-pair", nominated: true, state: "in-progress", availableOutgoingBitrate: 1_000_000 },
            { id: "CPb", type: "candidate-pair", nominated: true, state: "succeeded" },
            { id: "CPc", type: "candidate-pair", nominated: true, state: "succeeded", availableOutgoingBitrate: 2_500_000 }
        );
        assert.equal((await readSenderSample(senderWith(stats)))?.availableKbps, 2500);

        // o transport aponta para um par que nao esta no relatorio: o mesmo fallback
        stats.push({ id: "T9", type: "transport", selectedCandidatePairId: "sumiu" });
        assert.equal((await readSenderSample(senderWith(stats)))?.availableKbps, 2500);
    });

    test("par selecionado sem banda estimada, ou nenhum par: availableKbps null", async () => {
        assert.equal((await readSenderSample(senderWith(videoSenderStats({ availableOutgoingBitrate: null }))))?.availableKbps, null);
        const noPairs = videoSenderStats().filter(e => e.type !== "transport" && e.type !== "candidate-pair");
        assert.equal((await readSenderSample(senderWith(noPairs)))?.availableKbps, null);
    });

    test("campos ausentes ou invalidos (Chromium antigo): zeros e nulls, nunca NaN", async () => {
        const stats = withOutbound({
            framesEncoded: NaN, totalEncodeTime: "1", frameWidth: Infinity, qualityLimitationReason: 3,
            qualityLimitationDurations: { cpu: "x" }, encoderImplementation: 42, powerEfficientEncoder: "yes"
        }).filter(e => e.type !== "media-source");
        const s = await readSenderSample(senderWith(stats));
        assert.deepEqual({ ...s, at: 0 }, {
            at: 0, framesEncoded: 0, totalEncodeTime: 0, bytesSent: 0, limitation: { cpu: 0, bandwidth: 0 }, reason: null,
            frameWidth: 0, frameHeight: 0, sourceFrames: null, sourceFps: null, availableKbps: null,
            powerEfficient: null, implementation: null
        });
    });

    test("sem qualityLimitationDurations: limitation null (diffSamples cai para o motivo atual)", async () => {
        const s = await readSenderSample(senderWith(videoSenderStats({ qualityLimitationDurations: null, qualityLimitationReason: "cpu" })));
        assert.equal(s?.limitation, null);
        assert.equal(s?.reason, "cpu");
    });
});

describe("isHardwareEncoder", () => {
    test("powerEfficientEncoder decide quando o Chromium o expoe", () => {
        assert.equal(isHardwareEncoder(true, "libvpx"), true);
        assert.equal(isHardwareEncoder(false, NVENC), false);
    });

    test("sem powerEfficientEncoder: pelo nome do encoder", () => {
        for (const name of [NVENC, "ExternalEncoder", "VaapiVideoEncodeAccelerator", "VideoToolbox", "V4L2VideoEncodeAccelerator", "AMD AMF H.264", "Intel QuickSync"])
            assert.equal(isHardwareEncoder(null, name), true, name);
        for (const name of ["libvpx", "OpenH264", "libaom", "SimulcastEncoderAdapter (libvpx, libvpx)", ""])
            assert.equal(isHardwareEncoder(null, name), false, name);
        assert.equal(isHardwareEncoder(null, null), false);
    });
});

describe("diffSamples", () => {
    const prev = sample({ at: 10_000, framesEncoded: 100, totalEncodeTime: 1, bytesSent: 100_000, sourceFrames: 100, limitation: { cpu: 1, bandwidth: 2 } });

    test("janela de 2 s de um encoder por hardware: fps, kbps, custo por quadro e pixels", () => {
        const cur = sample({
            at: 12_000, framesEncoded: 220, totalEncodeTime: 2.488, bytesSent: 2_100_000, sourceFrames: 220, limitation: { cpu: 1.5, bandwidth: 2 },
            powerEfficient: true, implementation: NVENC, availableKbps: 9000
        });
        const m = diffSamples(prev, cur);
        assert.ok(m);
        assert.equal(m.dt, 2);
        assert.equal(m.encodedFps, 60);
        assert.equal(m.sourceFps, 60);
        assert.equal(m.cpuFraction, 0.25);
        assert.equal(m.bandwidthFraction, 0);
        assert.equal(m.sentKbps, 8000);
        assert.equal(m.availableKbps, 9000);
        assert.ok(Math.abs(m.encodeBusy! - 0.744) < 1e-9);
        assert.ok(Math.abs(m.encodeMsPerFrame! - 12.4) < 1e-9, "12,4 ms por quadro (8 espectadores na RTX 3070)");
        assert.equal(m.hardware, true);
        assert.equal(m.pixelsPerSecond, 1920 * 1080 * 60);
        assert.equal(m.frameHeight, 1080);
    });

    test("janela curta demais (< 0,5 s) ou contadores que voltaram (sender trocado): null", () => {
        assert.equal(diffSamples(prev, sample({ at: 10_400, framesEncoded: 120, bytesSent: 200_000 })), null);
        assert.equal(diffSamples(prev, sample({ at: 12_000, framesEncoded: 50, bytesSent: 200_000 })), null);
        assert.equal(diffSamples(prev, sample({ at: 12_000, framesEncoded: 200, bytesSent: 50_000 })), null);
    });

    test("fracoes de limitacao ficam entre 0 e 1", () => {
        const m = diffSamples(prev, sample({ at: 12_000, framesEncoded: 200, bytesSent: 200_000, limitation: { cpu: 9, bandwidth: 0 } }));
        assert.equal(m?.cpuFraction, 1);
        assert.equal(m?.bandwidthFraction, 0);
    });

    test("sem duracoes de limitacao numa das leituras: o motivo atual vale pela janela inteira", () => {
        const at = { at: 12_000, framesEncoded: 200, bytesSent: 200_000, limitation: null };
        assert.deepEqual(pick(diffSamples(prev, sample({ ...at, reason: "cpu" }))), { cpu: 1, bw: 0 });
        assert.deepEqual(pick(diffSamples(prev, sample({ ...at, reason: "bandwidth" }))), { cpu: 0, bw: 1 });
        assert.deepEqual(pick(diffSamples({ ...prev, limitation: null }, sample({ at: 12_000, framesEncoded: 200, bytesSent: 200_000, reason: "other" }))), { cpu: 0, bw: 0 });

        function pick(m: ReturnType<typeof diffSamples>) {
            return { cpu: m?.cpuFraction, bw: m?.bandwidthFraction };
        }
    });

    test("fps da fonte: pelo contador de quadros; sem ele (ou se voltou), o framesPerSecond relatado", () => {
        const base = { at: 12_000, framesEncoded: 200, bytesSent: 200_000, sourceFps: 30 };
        assert.equal(diffSamples(prev, sample({ ...base, sourceFrames: 160 }))?.sourceFps, 30, "60 quadros em 2 s");
        assert.equal(diffSamples(prev, sample({ ...base, sourceFrames: 10 }))?.sourceFps, 30, "contador voltou");
        assert.equal(diffSamples(prev, sample({ ...base, sourceFrames: null, sourceFps: 25 }))?.sourceFps, 25);
        assert.equal(diffSamples({ ...prev, sourceFrames: null }, sample({ ...base, sourceFrames: 160, sourceFps: null }))?.sourceFps, null);
    });

    test("nenhum quadro na janela, ou tempo de codificacao que voltou: sem custo de codificacao", () => {
        const still = diffSamples(prev, sample({ at: 12_000, framesEncoded: 100, totalEncodeTime: 1, bytesSent: 100_000 }));
        assert.equal(still?.encodedFps, 0);
        assert.equal(still?.encodeBusy, null);
        assert.equal(still?.encodeMsPerFrame, null);
        assert.equal(still?.pixelsPerSecond, 0);
        const back = diffSamples(prev, sample({ at: 12_000, framesEncoded: 160, totalEncodeTime: 0.5, bytesSent: 200_000 }));
        assert.equal(back?.encodeBusy, null);
        assert.equal(back?.encodeMsPerFrame, null);
        assert.equal(back?.hardware, false, "libvpx");
    });
});
