/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AV1 na escolha do codec (core/codec.ts → chooseCodec/whyNoHwOnly/sortCodecs/measureLocalCaps): so manual (o automatico
// continua H.264 High → H.264 Baseline → VP9), as redes de seguranca do H.265 (a placa dos dois lados, a sonda do AV1, o
// H.264 da placa ligado) e mais o WebRtcAV1HWEncode desta partida (sem ele, o AV1 do WebRTC e o libaom por software, que
// nunca vai). As capacidades e o fmtp sao os do Edge 156 numa RTX 3070 (sender "level-idx=5;profile=0;tier=0"; o
// receiver tambem profile=1).
// Rodar:  pnpm test:file src/plugins/telinha/core/codec.av1.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    applyCodecPreferences, AUTO_HW_ONLY, AV1_HW_MIN_HEIGHT, av1Candidates, chooseCodec, describeLocalCaps, getLocalCaps, h264ReserveOf, hwOnlyWanted, isOffHardwareAv1, isOffHardwareHwOnly,
    type LocalCodecCaps, measureLocalCaps, pickNegotiatedCodec, probeLocalCaps, setAv1HwFeature, setAv1ProbeOk, sortCodecs, whyNoHwOnly, whyNoHwOnlyHere
} from "./codec";
import { av1Rank, hwOnlyRank, isAv1Main, isHwOnlyCodec } from "./sdp";

type Codec = RTCRtpCodec;

const AV1_MAIN = "level-idx=5;profile=0;tier=0";
const AV1_HIGH = "level-idx=5;profile=1;tier=0";
const h264 = (mode: 0 | 1, profile: string): Codec => ({
    mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`
});
const plain = (name: string, fmtp?: string): Codec => ({ mimeType: `video/${name}`, clockRate: 90000, ...(fmtp ? { sdpFmtpLine: fmtp } : {}) });

/** Edge 156 (RTX 3070), RTCRtpSender.getCapabilities("video"), sem rtx/red/ulpfec. */
const SENDER: Codec[] = [
    plain("VP8"), h264(1, "42001f"), h264(0, "42001f"), h264(1, "42e01f"), h264(0, "42e01f"), h264(1, "4d001f"), h264(0, "4d001f"),
    plain("AV1", AV1_MAIN), plain("VP9", "profile-id=0"), plain("VP9", "profile-id=2"), h264(1, "640032")
];
/** O receiver do mesmo Edge: AV1 profile 0 e 1. */
const RECEIVER: Codec[] = [plain("VP8"), plain("VP9", "profile-id=0"), h264(1, "42001f"), plain("AV1", AV1_MAIN), plain("AV1", AV1_HIGH), h264(1, "64001f")];

/** Este PC (uma RTX 4070): H.264 Baseline e High na placa, AV1 na placa com o recurso ligado, as sondas ok. */
function pc(over: Partial<LocalCodecCaps> = {}): LocalCodecCaps {
    return {
        h264HwDecode: true, h264HwEncode: true, h264HwProfile: "42001f", h264HighHwDecode: true, h264HighHwProfile: "640032", h264HighProbeOk: true,
        h265HwDecode: false, h265HwFmtp: null, h265ProbeOk: false, av1HwDecode: true, av1HwFmtp: AV1_MAIN, av1ProbeOk: true, av1HwFeature: true,
        sendable: new Set(["vp8", "h264", "av1", "vp9"]), ...over
    };
}

/** Espectadores: AV1 e High (uma RTX 30 nesta versao), so AV1, a versao do H.265 (sem av1), sem H.264 na placa, outra `v`. */
const BOTH = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, av1: true } };
const AV1_ONLY = { h264HwDecode: true, hwDecode: { v: 1, av1: true } };
const H265_ERA = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };
const NO_H264 = { h264HwDecode: false, hwDecode: { v: 1, av1: true } };
const FUTURE = { h264HwDecode: true, hwDecode: { v: 2, h264High: true, av1: true } };

const AV1_REASON = "fixado nas configurações (AV1 por hardware nos dois lados: este PC codifica AV1 na placa, com a sonda do AV1 ok, e o espectador "
    + "decodifica AV1 na placa; reserva H.264 perfil 640032/42001f)";

describe("automatico: nunca AV1 (so manual), a ordem de antes", () => {
    test("os dois lados com AV1 na placa e a sonda ok: o automatico continua High → Baseline → VP9", () => {
        assert.deepEqual(AUTO_HW_ONLY, [], "a lista do automatico (a unica troca para promover o AV1) esta vazia");
        const both = chooseCodec(BOTH, "auto", pc());
        assert.deepEqual([both.codec, both.h264Profile, both.h264Backup], ["h264", "640032", "42001f"]);
        assert.ok(!both.reason.includes("AV1"), both.reason);
        assert.equal(chooseCodec(NO_H264, "auto", pc()).codec, "vp9");
    });

    test("hwOnlyWanted: so fixado (o automatico nao pede a sonda nem o recurso)", () => {
        assert.equal(hwOnlyWanted("av1", "av1"), true);
        for (const s of ["auto", "h264", "h265", "vp9", null, undefined] as const) assert.equal(hwOnlyWanted("av1", s), false, String(s));
        assert.equal(hwOnlyWanted("h265", "h265"), true);
    });
});

describe("AV1 fixado: decisao e versoes", () => {
    test("os dois lados com AV1 na placa, a sonda ok e o recurso ligado: AV1, com o High (e o Baseline) de reserva", () => {
        assert.deepEqual(chooseCodec(BOTH, "av1", pc()), { codec: "av1", h264Profile: "640032", h264Backup: "42001f", reason: AV1_REASON });
    });

    test("o espectador sem High mas com AV1: AV1 com o Baseline de reserva; sem H.264 na placa: AV1 sem reserva", () => {
        const d = chooseCodec(AV1_ONLY, "av1", pc());
        assert.deepEqual([d.codec, d.h264Profile, d.h264Backup], ["av1", "42001f", undefined]);
        const none = chooseCodec(NO_H264, "av1", pc());
        assert.deepEqual(none, { codec: "av1", reason: "fixado nas configurações (AV1 por hardware nos dois lados, com a sonda do AV1 ok; sem reserva H.264 na placa para este espectador)" });
        assert.equal(h264ReserveOf(none, "x"), null);
        assert.deepEqual(h264ReserveOf(d, "r"), { codec: "h264", h264Profile: "42001f", reason: "r" });
    });

    test("versoes antigas (sem av1 no campo) e outra `v`: nunca AV1; o motivo diz o porque", () => {
        const old = chooseCodec(H265_ERA, "av1", pc());
        assert.deepEqual([old.codec, old.h264Profile], ["h264", "640032"]);
        assert.match(old.reason, /^AV1 fixado nas configurações, mas o espectador não anuncia AV1 por hardware \(não tem, ou é uma versão antiga do Telinha\) → automático: H\.264 High/);
        assert.equal(chooseCodec(FUTURE, "av1", pc()).codec, "h264");
        assert.equal(chooseCodec(undefined, "av1", pc()).codec, "vp9");
    });
});

describe("AV1 fixado: nunca o AV1 por software (o que falta deste PC cai no automatico)", () => {
    test("o WebRtcAV1HWEncode desligado nesta partida: o automatico, com 'reinicie o Discord' (antes de olhar a placa)", () => {
        const d = chooseCodec(BOTH, "av1", pc({ av1HwFeature: false, av1HwFmtp: null }));
        assert.deepEqual([d.codec, d.h264Profile], ["h264", "640032"]);
        assert.match(d.reason, /^AV1 fixado nas configurações, mas o AV1 da placa de vídeo ainda não está ligado nesta partida do Discord \(reinicie o Discord\) → automático/);
        // desconhecido (sem o loader): o encodingInfo decide
        assert.equal(chooseCodec(BOTH, "av1", pc({ av1HwFeature: null })).codec, "av1");
        assert.equal(chooseCodec(BOTH, "av1", pc({ av1HwFeature: null, av1HwFmtp: null })).codec, "h264");
    });

    test("este PC sem AV1 na placa (a RTX 3070), sem a sonda ok, a placa travada, ou um Chromium sem AV1: o automatico", () => {
        assert.equal(whyNoHwOnlyHere("av1", pc({ av1HwFmtp: null })), "este PC não codifica AV1 por hardware (só placas RTX 40/50, Radeon RX 7000, Intel Arc ou mais novas)");
        assert.equal(whyNoHwOnlyHere("av1", pc({ av1ProbeOk: false })), "a sonda WebCodecs do AV1 não passou neste PC");
        assert.equal(whyNoHwOnlyHere("av1", pc({ h264HwEncode: false })),
            "o H.264 da placa está desligado neste PC (travou, sonda rodando ou quedas para software), e o AV1 vai junto");
        assert.equal(whyNoHwOnlyHere("av1", pc({ sendable: new Set(["h264", "vp9"]) })), "este cliente não envia AV1 (o Chromium dele não oferece)");
        assert.equal(whyNoHwOnlyHere("av1", pc({ sendable: new Set() })), "este cliente não envia AV1 (o Chromium dele não oferece)", "lista desconhecida: nunca AV1");
        assert.equal(whyNoHwOnlyHere("av1", pc()), null);
        assert.equal(whyNoHwOnly("av1", BOTH, pc()), null);
        for (const over of [{ av1HwFmtp: null }, { av1ProbeOk: false }, { h264HwEncode: false }]) assert.notEqual(chooseCodec(BOTH, "av1", pc(over)).codec, "av1", JSON.stringify(over));
    });

    test("medido antes desta versao (sem os campos do AV1): nunca AV1", () => {
        const { av1HwDecode: _d, av1HwFmtp: _f, av1ProbeOk: _p, av1HwFeature: _x, ...old } = pc();
        assert.equal(chooseCodec(BOTH, "av1", old as LocalCodecCaps).codec, "h264");
    });

    test("o AV1 nao mexe no H.265 fixado (cada um com a sua sonda e a sua marca)", () => {
        const both = pc({ h265HwFmtp: "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST", h265ProbeOk: true, sendable: new Set(["vp8", "h264", "av1", "vp9", "h265"]) });
        assert.equal(chooseCodec({ h264HwDecode: true, hwDecode: { v: 1, h265: true } }, "h265", both).codec, "h265");
        assert.equal(chooseCodec({ h264HwDecode: true, hwDecode: { v: 1, h265: true } }, "av1", both).codec, "h264", "o espectador so com H.265");
    });
});

describe("a ordem dos codecs e a negociacao no ar", () => {
    test("AV1 Main na frente, as variantes H.264 da reserva logo depois, depois o resto; o profile=1 nunca na frente", () => {
        const { sorted, matched } = sortCodecs(RECEIVER, "av1", "640032", "42001f");
        assert.equal(matched, 2);
        assert.deepEqual(sorted.slice(0, 4).map(c => `${c.mimeType} ${c.sdpFmtpLine ?? ""}`), [
            `video/AV1 ${AV1_MAIN}`, `video/AV1 ${AV1_HIGH}`, "video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f",
            "video/H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"
        ]);
        const noReserve = sortCodecs(SENDER, "av1", null);
        assert.deepEqual(noReserve.sorted.slice(0, 2).map(c => c.mimeType), ["video/AV1", "video/VP8"], "sem reserva: a ordem do Chromium depois do AV1");
        assert.equal(sortCodecs([plain("VP9")], "av1", "42001f").matched, 0);
    });

    test("pickNegotiatedCodec: o AV1 Main negociado (troca no ar), so os campos de RTCRtpCodec; sem AV1, null", () => {
        const negotiated = [{ ...plain("AV1", AV1_HIGH), payloadType: 46 }, { ...plain("AV1", AV1_MAIN), payloadType: 45 }, h264(1, "42001f")] as Codec[];
        assert.deepEqual(pickNegotiatedCodec(negotiated, { codec: "av1", reason: "" }), { mimeType: "video/AV1", clockRate: 90000, sdpFmtpLine: AV1_MAIN });
        assert.equal(pickNegotiatedCodec([h264(1, "42001f")], { codec: "av1", reason: "" }), null);
    });

    test("applyCodecPreferences: 'AV1 primeiro', com e sem a reserva", () => {
        const g = globalThis as any;
        const before = [g.RTCRtpSender, g.RTCRtpReceiver];
        try {
            g.RTCRtpSender = { getCapabilities: () => ({ codecs: SENDER }) };
            g.RTCRtpReceiver = { getCapabilities: () => ({ codecs: RECEIVER }) };
            let applied: Codec[] = [];
            const tr = { setCodecPreferences: (c: Codec[]) => { applied = c; } } as unknown as RTCRtpTransceiver;
            assert.equal(applyCodecPreferences(tr, "av1", "640032", "42001f"), "AV1 primeiro (1 variante(s), capacidades do sender; reserva H.264 perfil 640032/42001f logo depois)");
            assert.deepEqual(applied.slice(0, 3).map(c => c.mimeType), ["video/AV1", "video/H264", "video/H264"]);
            assert.equal(applyCodecPreferences(tr, "av1", null), "AV1 primeiro (1 variante(s), capacidades do sender; sem reserva H.264)");
        } finally {
            [g.RTCRtpSender, g.RTCRtpReceiver] = before;
        }
    });

    test("sdp.ts: AV1 Main = profile=0 ou sem profile; isHwOnlyCodec", () => {
        assert.equal(isAv1Main(AV1_MAIN), true);
        assert.equal(isAv1Main("level-idx=5;tier=0"), true);
        assert.equal(isAv1Main("a=fmtp:45 profile=0;level-idx=5"), true, "a linha a=fmtp inteira");
        assert.equal(isAv1Main(AV1_HIGH), false);
        assert.deepEqual([av1Rank(AV1_MAIN), av1Rank(AV1_HIGH), hwOnlyRank("av1", AV1_HIGH)], [0, 1, 1]);
        assert.deepEqual(av1Candidates([...RECEIVER, plain("AV1", AV1_MAIN)]), [AV1_MAIN]);
        assert.deepEqual(["av1", "h265", "h264", "auto", null].map(isHwOnlyCodec), [true, true, false, false, false]);
    });
});

describe("AV1 no ar fora da placa (o libaom)", () => {
    const enc = (over: object) => ({ mimeType: "video/AV1", framesEncoded: 30, width: 1920, height: 1080, ...over });

    test("powerEfficientEncoder false, ou sem ele o libaom/SVT: fora da placa; sem quadros, outro codec ou abaixo de 270p: nao", () => {
        assert.equal(isOffHardwareAv1(enc({ powerEfficient: false, implementation: "libaom" })), true);
        assert.equal(isOffHardwareAv1(enc({ implementation: "libaom" })), true);
        assert.equal(isOffHardwareAv1(enc({ implementation: "SVT-AV1" })), true);
        assert.equal(isOffHardwareAv1(enc({ powerEfficient: true, implementation: "MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)" })), false);
        assert.equal(isOffHardwareAv1(enc({ implementation: "MediaFoundationVideoEncodeAccelerator" })), false, "sem powerEfficient e sem nome de software: sem evidencia");
        assert.equal(isOffHardwareAv1(enc({ powerEfficient: false, framesEncoded: 0 })), false);
        assert.equal(AV1_HW_MIN_HEIGHT, 270);
        assert.equal(isOffHardwareAv1(enc({ powerEfficient: false, height: 240, width: 426 })), false, "abaixo de 270p o software e de proposito");
        assert.equal(isOffHardwareAv1(enc({ powerEfficient: false, mimeType: "video/VP9" })), false);
        assert.equal(isOffHardwareHwOnly("av1", enc({ powerEfficient: false })), true);
        assert.equal(isOffHardwareHwOnly("h265", { mimeType: "video/H265", framesEncoded: 3, powerEfficient: false }), true);
    });
});

describe("sonda de capacidades: AV1 pelo encodingInfo, o recurso na linha do log", () => {
    const g = globalThis as any;

    function setup(hwEncode: boolean, hwDecode: boolean) {
        const calls: string[] = [];
        g.RTCRtpSender = { getCapabilities: () => ({ codecs: SENDER }) };
        g.RTCRtpReceiver = { getCapabilities: () => ({ codecs: RECEIVER }) };
        const answer = (hw: boolean) => (config: any) => {
            const ct = String(config.video.contentType);
            calls.push(ct);
            return Promise.resolve({ supported: true, smooth: true, powerEfficient: /^video\/AV1;/.test(ct) ? hw : false });
        };
        Object.defineProperty(globalThis, "navigator", { value: { mediaCapabilities: { encodingInfo: answer(hwEncode), decodingInfo: answer(hwDecode) } }, configurable: true, writable: true });
        return calls;
    }

    test("uma RTX 40: codifica e decodifica AV1 (o fmtp Main do sender, o Main do receiver)", async () => {
        const calls = setup(true, true);
        const caps = await measureLocalCaps({ callMs: 40, totalMs: 1000 });
        assert.deepEqual([caps.av1HwFmtp, caps.av1HwDecode, caps.av1ProbeOk], [AV1_MAIN, true, false]);
        assert.ok(calls.includes(`video/AV1;${AV1_MAIN}`));
        assert.ok(!calls.includes(`video/AV1;${AV1_HIGH}`), "o profile=1 nunca e consultado");
        assert.match(describeLocalCaps(caps), /; AV1 por hardware — decodifica: sim, codifica: sim \(level-idx=5;profile=0;tier=0\)$/);
        assert.match(describeLocalCaps({ ...caps, av1HwFeature: false }), /codifica: sim \(level-idx=5;profile=0;tier=0\); WebRtcAV1HWEncode desligado nesta partida$/);
        assert.match(describeLocalCaps({ ...caps, av1HwFeature: true }), /; WebRtcAV1HWEncode ligado nesta partida$/);
    });

    test("a RTX 3070 (medido no Edge 156): decodifica AV1, nao codifica; sem o recurso conhecido nem a placa, a linha de antes", async () => {
        setup(false, true);
        const caps = await measureLocalCaps({ callMs: 40, totalMs: 1000 });
        assert.deepEqual([caps.av1HwFmtp, caps.av1HwDecode], [null, true]);
        assert.match(describeLocalCaps(caps), /AV1 por hardware — decodifica: sim, codifica: não$/);
        assert.doesNotMatch(describeLocalCaps({ ...caps, av1HwDecode: false }), /AV1 por hardware/);
    });

    test("probeLocalCaps leva o recurso e a sonda ja conhecidos; setAv1HwFeature/setAv1ProbeOk mudam a hora", async () => {
        setup(true, true);
        setAv1HwFeature(true);
        setAv1ProbeOk(true);
        const lines: string[] = [];
        await probeLocalCaps(line => lines.push(line));
        assert.deepEqual([getLocalCaps().av1HwFeature, getLocalCaps().av1ProbeOk, getLocalCaps().av1HwFmtp], [true, true, AV1_MAIN]);
        assert.match(lines[0], /WebRtcAV1HWEncode ligado nesta partida$/);
        setAv1HwFeature(false);
        setAv1ProbeOk(false);
        assert.deepEqual([getLocalCaps().av1HwFeature, getLocalCaps().av1ProbeOk], [false, false]);
        setAv1HwFeature(false);
        setAv1HwFeature(null);
        setAv1ProbeOk(false);
        assert.equal(getLocalCaps().av1HwFeature, null);
    });
});
