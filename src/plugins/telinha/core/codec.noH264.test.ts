/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Um Discord sem H.264 no sender (1.0.9269 no Windows: veio sem o OpenH264 e o Chromium dele tirou o H.264 inteiro do
// RTCRtpSender.getCapabilities), com o estado do modulo (core/codec.ts → probeLocalCaps memoriza por processo): a medicao
// diz "codifica: não (este Discord não oferece H.264)", o H.265 vale no automatico (hwOnlyWanted com as capacidades ja
// medidas) e so as travas de verdade da placa (setH264HwStuck, setH264HwProbing, noteH264Fallback → h264HwOff) tiram o
// H.265 do automatico. A ordem importa.
// Rodar:  pnpm test:file src/plugins/telinha/core/codec.noH264.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { chooseCodec, getLocalCaps, hwOnlyWanted, noteH264Fallback, probeLocalCaps, setH264HwProbing, setH264HwStuck, setH265ProbeOk, softwareFallback, whyNoHwOnlyHere } from "./codec";

type Codec = RTCRtpCodec;

const H265_SEND = "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST";
const plain = (name: string, fmtp?: string): Codec => ({ mimeType: `video/${name}`, clockRate: 90000, ...(fmtp ? { sdpFmtpLine: fmtp } : {}) });
const h264 = (profile: string): Codec => ({ mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}` });

/** O sender desse Discord (sem H.264) e o receiver (que ainda decodifica H.264). */
const SENDER: Codec[] = [plain("VP8"), plain("AV1", "level-idx=5;profile=0;tier=0"), plain("VP9", "profile-id=0"), plain("H265", H265_SEND)];
const RECEIVER: Codec[] = [plain("VP8"), h264("42001f"), plain("VP9", "profile-id=0"), plain("H265", H265_SEND)];
const VIEWER = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };
const OFF = "a placa de vídeo está desligada neste PC (travou, sonda rodando ou quedas para software), e o H.265 vai junto";
const vp9Because = (no: string) => ({ codec: "vp9", reason: `automático: este Discord não oferece H.264, e o H.265 da placa não vai (${no}) → VP9` });

function install() {
    const g = globalThis as any;
    const api = (codecs: Codec[]) => ({ getCapabilities: (kind: string) => (kind === "video" ? { codecs, headerExtensions: [] } : null) });
    g.RTCRtpSender = api(SENDER);
    g.RTCRtpReceiver = api(RECEIVER);
    const answer = (hw: string[]) => (config: any) => {
        const type = String(config.video.contentType);
        const key = /^video\/H265;/.test(type) ? "h265" : /profile-level-id=([0-9a-f]{6})/.exec(type)?.[1] ?? "";
        return Promise.resolve({ supported: true, smooth: true, powerEfficient: hw.includes(key) });
    };
    Object.defineProperty(globalThis, "navigator", {
        value: { mediaCapabilities: { encodingInfo: answer(["h265"]), decodingInfo: answer(["42001f", "h265"]) } }, configurable: true, writable: true
    });
}

describe("Discord sem H.264: a medicao, a sonda do H.265 no automatico e as travas da placa", () => {
    test("antes da medicao, o H.265 nao vale no automatico (lista do sender desconhecida)", () => {
        assert.ok(!hwOnlyWanted("h265", "auto"));
    });

    test("a medicao (com uma sonda segurando a placa): codifica: não (este Discord não oferece H.264); o H.265 passa a valer no automatico", async () => {
        install();
        setH264HwProbing(true);
        const lines: string[] = [];
        await probeLocalCaps(line => lines.push(line));
        assert.deepEqual(lines, [
            "Capacidades locais: H.264 por hardware — decodifica: sim, codifica: não (este Discord não oferece H.264); envia: vp8, av1, vp9, h265; "
            + `H.264 High por hardware — decodifica: não, codifica: não; H.265 por hardware — decodifica: sim, codifica: sim (${H265_SEND})`
        ]);
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.equal(getLocalCaps().h264HwOff, true, "a sonda segurando a placa ja vale na medicao");
        setH264HwProbing(false);
        assert.equal(getLocalCaps().h264HwOff, false);
        assert.ok(hwOnlyWanted("h265", "auto"));
        assert.ok(!hwOnlyWanted("av1", "auto"));
    });

    test("sem a sonda do H.265: VP9; com ela: H.265 sem reserva H.264", () => {
        assert.deepEqual(chooseCodec(VIEWER, "auto"), vp9Because("a sonda WebCodecs do H.265 não passou neste PC"));
        setH265ProbeOk(true);
        const d = chooseCodec(VIEWER, "auto");
        assert.equal(d.codec, "h265");
        assert.ok(!("h264Profile" in d), "sem reserva H.264");
    });

    test("a placa travou ou uma sonda a segura: VP9 enquanto durar; solta, volta o H.265", () => {
        setH264HwProbing(true);
        assert.deepEqual(chooseCodec(VIEWER, "auto"), vp9Because(OFF));
        setH264HwProbing(false);
        assert.equal(chooseCodec(VIEWER, "auto").codec, "h265");
        setH264HwStuck(true);
        assert.deepEqual(chooseCodec(VIEWER, "auto"), vp9Because(OFF));
        setH264HwStuck(false);
        assert.equal(chooseCodec(VIEWER, "auto").codec, "h265");
        setH264HwStuck(false);
        assert.equal(getLocalCaps().h264HwOff, false, "sem mudanca");
    });

    test("as quedas para software: a 2a desliga a placa (h264HwOff) no resto da sessao, sem 'desligou agora' (o H.264 ja nao estava ligado)", () => {
        assert.deepEqual(noteH264Fallback(), { count: 1, disabledNow: false });
        assert.equal(chooseCodec(VIEWER, "auto").codec, "h265");
        assert.deepEqual(noteH264Fallback(), { count: 2, disabledNow: false });
        assert.equal(getLocalCaps().h264HwOff, true);
        assert.deepEqual(chooseCodec(VIEWER, "auto"), vp9Because(OFF));
        setH264HwStuck(false);
        assert.equal(getLocalCaps().h264HwOff, true, "as quedas continuam valendo");
    });

    test("o atalho 'a placa saiu' (softwareFallback) marca h264HwOff: sem H.264 neste Discord ele vai VP9, nao H.265", () => {
        const local = { ...getLocalCaps(), h264HwOff: false, h265ProbeOk: true };
        assert.equal(chooseCodec(VIEWER, "auto", local).codec, "h265", "sem a queda, o H.265");
        const openh264 = { mimeType: "video/H264", implementation: "OpenH264", powerEfficient: false, framesEncoded: 30 };
        const next = softwareFallback(openh264, false, VIEWER, "auto", local);
        assert.equal(next?.codec, "vp9");
        assert.ok(!local.h264HwOff, "nao mexe no objeto recebido");
    });

    test("AV1 fixado sem H.264 neste Discord: o motivo e o Discord (nao uma falha da placa); com a placa desligada de verdade, o motivo da placa", () => {
        const base = { ...getLocalCaps(), av1HwFmtp: "level-idx=5;profile=0;tier=0", av1HwFeature: true as const, av1ProbeOk: true };
        assert.equal(whyNoHwOnlyHere("av1", { ...base, h264HwOff: false }), "este Discord não oferece H.264, e o AV1 fixado ainda depende dele");
        assert.match(whyNoHwOnlyHere("av1", { ...base, h264HwOff: true })!, /^o H\.264 da placa está desligado neste PC \(travou/);
    });
});
