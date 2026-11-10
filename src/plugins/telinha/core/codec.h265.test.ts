/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// H.265 na escolha do codec (core/codec.ts → chooseCodec/whyNoH265/sortCodecs/measureLocalCaps): so manual (o automatico
// continua H.264 High → H.264 Baseline → VP9), as redes de seguranca (a placa dos dois lados, a sonda do H.265, o H.264 da
// placa ligado), o espectador de outra versao (v0.3.3 sem caps.hwDecode.h265) e o H.265 fixado nas configuracoes. As
// capacidades e o fmtp sao os do Chrome 156 numa RTX 3070 (sender "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST").
// Rodar:  pnpm test:file src/plugins/telinha/core/codec.h265.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    chooseCodec, type CodecDecision, h264ReserveOf, h265Candidates, isOffHardwareH265, type LocalCodecCaps, measureLocalCaps, pickNegotiatedCodec, sortCodecs, whyNoH265
} from "./codec";
import { h265Rank, isH265Main } from "./sdp";

type Codec = RTCRtpCodec;

const H265_SEND = "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST";
const H265_RECV = "level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST";
const H265_MAIN10 = "level-id=180;profile-id=2;tier-flag=0;tx-mode=SRST";
const h264 = (mode: 0 | 1, profile: string): Codec => ({
    mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`
});
const plain = (name: string, fmtp?: string): Codec => ({ mimeType: `video/${name}`, clockRate: 90000, ...(fmtp ? { sdpFmtpLine: fmtp } : {}) });

/** Chrome 156 (RTX 3070), RTCRtpSender.getCapabilities("video"), sem rtx/red/ulpfec. */
const SENDER: Codec[] = [
    plain("VP8"), h264(1, "42001f"), h264(0, "42001f"), h264(1, "42e01f"), h264(0, "42e01f"), h264(1, "4d001f"), h264(0, "4d001f"),
    plain("AV1", "level-idx=5;profile=0;tier=0"), plain("VP9", "profile-id=0"), plain("VP9", "profile-id=2"), h264(1, "640032"), plain("H265", H265_SEND)
];
/** O receiver do mesmo Chrome: H.265 Main e Main 10 no nivel 6.0. */
const RECEIVER: Codec[] = [plain("VP8"), plain("VP9", "profile-id=0"), h264(1, "42001f"), h264(1, "64001f"), plain("H265", H265_RECV), plain("H265", H265_MAIN10)];

/** Este PC: H.264 Baseline e High na placa, H.265 na placa, as duas sondas ok. */
function pc(over: Partial<LocalCodecCaps> = {}): LocalCodecCaps {
    return {
        h264HwDecode: true, h264HwEncode: true, h264HwProfile: "42001f", h264HighHwDecode: true, h264HighHwProfile: "640032", h264HighProbeOk: true,
        h265HwDecode: true, h265HwFmtp: H265_SEND, h265ProbeOk: true, sendable: new Set(["vp8", "h264", "av1", "vp9", "h265"]), ...over
    };
}

/** Espectadores: os dois (High e H.265), so High (a v0.3.3), so o booleano (v0.3.2), sem placa, uma versao futura do campo. */
const BOTH = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };
const H265_ONLY = { h264HwDecode: true, hwDecode: { v: 1, h265: true } };
const V033 = { h264HwDecode: true, hwDecode: { v: 1, h264High: true } };
const V032 = { h264HwDecode: true };
const NO_HW = { h264HwDecode: false, hwDecode: { v: 1, h265: true } };
const FUTURE = { h264HwDecode: true, hwDecode: { v: 2, h264High: true, h265: true } };

const H265_REASON = "fixado nas configurações (H.265 por hardware nos dois lados: este PC codifica H.265 na placa, com a sonda do H.265 ok, e o espectador "
    + "decodifica H.265 na placa; reserva H.264 perfil 640032/42001f)";

describe("automatico: nunca H.265 (so manual), a ordem de antes", () => {
    test("os dois lados com H.265 na placa e a sonda ok: o automatico continua High → Baseline → VP9, com o motivo de antes", () => {
        const both = chooseCodec(BOTH, "auto", pc());
        assert.deepEqual([both.codec, both.h264Profile, both.h264Backup], ["h264", "640032", "42001f"]);
        assert.ok(!both.reason.includes("H.265"), both.reason);
        assert.deepEqual([chooseCodec(H265_ONLY, "auto", pc()).codec, chooseCodec(H265_ONLY, "auto", pc()).h264Profile], ["h264", "42001f"]);
        // espectador sem H.264 na placa: o Baseline da placa deste PC (decodificar por software e leve), nunca VP9 por software
        assert.deepEqual([chooseCodec(NO_HW, "auto", pc()).codec, chooseCodec(NO_HW, "auto", pc()).h264Profile], ["h264", "42001f"]);
        assert.deepEqual(chooseCodec(BOTH, "auto", pc({ h264HwEncode: false })), { codec: "vp9", reason: "automático: este PC não codifica H.264 por hardware → VP9" });
    });
});

describe("H.265 fixado: decisao e versoes", () => {
    test("os dois lados com H.265 na placa e a sonda ok: H.265, com o High (e o Baseline) de reserva", () => {
        assert.deepEqual(chooseCodec(BOTH, "h265", pc()), { codec: "h265", h264Profile: "640032", h264Backup: "42001f", reason: H265_REASON });
    });

    test("o espectador sem High mas com H.265: H.265 com o Baseline de reserva", () => {
        const d = chooseCodec(H265_ONLY, "h265", pc());
        assert.equal(d.codec, "h265");
        assert.equal(d.h264Profile, "42001f");
        assert.equal(d.h264Backup, undefined);
        assert.match(d.reason, /reserva H\.264 perfil 42001f\)$/);
    });

    test("versoes antigas: a v0.3.3 (so High) recebe High, a v0.3.2 o Baseline, uma versao futura do campo nunca H.265; o motivo diz o porque", () => {
        const v033 = chooseCodec(V033, "h265", pc());
        assert.deepEqual([v033.codec, v033.h264Profile], ["h264", "640032"]);
        assert.match(v033.reason, /^H\.265 fixado nas configurações, mas o espectador não anuncia H\.265 por hardware \(não tem, ou é uma versão antiga do Telinha\) → automático: H\.264 High/);
        assert.deepEqual([chooseCodec(V032, "h265", pc()).codec, chooseCodec(V032, "h265", pc()).h264Profile], ["h264", "42001f"]);
        // outra `v` (o sanitizePresence ja a descarta; aqui chega crua): nunca H.265
        assert.equal(chooseCodec(FUTURE, "h265", pc()).codec, "h264");
    });

    test("este PC: sem H.265 na placa, sem a sonda do H.265 ok, ou um Chromium que nao oferece H.265: o H.264 do automatico", () => {
        const noHw = chooseCodec(BOTH, "h265", pc({ h265HwFmtp: null }));
        assert.deepEqual([noHw.codec, noHw.h264Profile], ["h264", "640032"]);
        assert.match(noHw.reason, /^H\.265 fixado nas configurações, mas este PC não codifica H\.265 por hardware → /);
        const edge = chooseCodec(BOTH, "h265", pc({ sendable: new Set(["vp8", "h264", "vp9"]) }));
        assert.equal(edge.codec, "h264");
        assert.match(edge.reason, /mas este cliente não envia H\.265/);
        assert.equal(chooseCodec(BOTH, "h265", pc({ sendable: new Set() })).codec, "h264", "lista de envio desconhecida: nunca H.265");
    });

    test("medido antes desta versao (sem os campos do H.265): nunca H.265", () => {
        const { h265HwDecode: _d, h265HwFmtp: _f, h265ProbeOk: _p, ...old } = pc();
        assert.equal(chooseCodec(BOTH, "h265", old as LocalCodecCaps).codec, "h264");
    });

    test("a placa travada, uma sonda segurando o H.264 ou as quedas (h264HwEncode false): VP9 (a placa AMD nunca cria um encoder H.265)", () => {
        assert.equal(whyNoH265(BOTH, pc({ h264HwEncode: false })), "o H.264 da placa está desligado neste PC (travou, sonda rodando ou quedas para software), e o H.265 vai junto");
    });
});

describe("H.265 fixado nas configuracoes: as mesmas redes de seguranca", () => {
    test("com tudo ok: H.265 (com a reserva do automatico)", () => {
        const d = chooseCodec(BOTH, "h265", pc());
        assert.deepEqual({ ...d, reason: "" }, { codec: "h265", h264Profile: "640032", h264Backup: "42001f", reason: "" });
        assert.match(d.reason, /^fixado nas configurações \(H\.265 por hardware nos dois lados/);
    });

    test("o espectador decodifica H.265 na placa mas nao H.264 (decodifica por software): H.265 com o Baseline da placa de reserva", () => {
        const d = chooseCodec(NO_HW, "h265", pc());
        assert.equal(d.codec, "h265");
        assert.equal(d.h264Profile, "42001f");
        assert.ok(!("h264Backup" in d));
        assert.match(d.reason, /reserva H\.264 perfil 42001f\)$/);
    });

    test("sem a sonda, sem o espectador, ou com a placa travada: o que o automatico escolheria, e o motivo diz que o H.265 estava fixado", () => {
        const noProbe = chooseCodec(BOTH, "h265", pc({ h265ProbeOk: false }));
        assert.deepEqual([noProbe.codec, noProbe.h264Profile], ["h264", "640032"]);
        assert.match(noProbe.reason, /^H\.265 fixado nas configurações, mas a sonda WebCodecs do H\.265 não passou neste PC → automático: H\.264 High/);
        const old = chooseCodec(V032, "h265", pc());
        assert.deepEqual([old.codec, old.h264Profile], ["h264", "42001f"]);
        assert.match(old.reason, /^H\.265 fixado nas configurações, mas o espectador não anuncia H\.265 por hardware/);
        const stuck = chooseCodec(BOTH, "h265", pc({ h264HwEncode: false }));
        assert.equal(stuck.codec, "vp9", "a placa travada: nem o H.265 fixado");
        assert.match(stuck.reason, /^H\.265 fixado nas configurações, mas o H\.264 da placa está desligado neste PC/);
        assert.equal(chooseCodec(NO_HW, "h265", pc({ h265HwFmtp: null })).codec, "h264");
        assert.equal(chooseCodec(NO_HW, "h265", pc({ h265HwFmtp: null, h264HwEncode: false })).codec, "vp9");
    });

    test("os outros codecs fixados nao mudam (H.264 fixado continua o Baseline)", () => {
        assert.deepEqual(chooseCodec(BOTH, "h264", pc()), { codec: "h264", h264Profile: "42001f", reason: "fixado nas configurações" });
        assert.deepEqual(chooseCodec(BOTH, "vp9", pc()), { codec: "vp9", reason: "fixado nas configurações" });
    });
});

describe("a reserva H.264 de um envio H.265", () => {
    test("h264ReserveOf: a decisao H.264 que a negociacao leva logo depois do H.265", () => {
        const d = chooseCodec(BOTH, "h265", pc());
        assert.deepEqual(h264ReserveOf(d, "x"), { codec: "h264", h264Profile: "640032", h264Backup: "42001f", reason: "x" });
        assert.equal(h264ReserveOf({ codec: "h265", reason: "" }, "x"), null, "sem reserva");
        assert.equal(h264ReserveOf({ codec: "h264", h264Profile: "42001f", reason: "" }, "x"), null, "nao e H.265");
    });

    test("isOffHardwareH265: so H.265 com quadros e powerEfficientEncoder false", () => {
        assert.equal(isOffHardwareH265({ mimeType: "video/H265", framesEncoded: 10, powerEfficient: false }), true);
        assert.equal(isOffHardwareH265({ mimeType: "video/H265", framesEncoded: 10, powerEfficient: true }), false);
        assert.equal(isOffHardwareH265({ mimeType: "video/H265", framesEncoded: 0, powerEfficient: false }), false);
        assert.equal(isOffHardwareH265({ mimeType: "video/H265", framesEncoded: 10 }), false, "sem o campo: nao da para saber");
        assert.equal(isOffHardwareH265({ mimeType: "video/H264", framesEncoded: 10, powerEfficient: false }), false);
    });
});

describe("ordem dos codecs com H.265 (setCodecPreferences e a troca no ar)", () => {
    test("H.265 Main, depois o H.264 reserva na ordem dele (High, Baseline, os outros pm=1, pm=0), depois o resto na ordem do Chromium", () => {
        const { sorted, matched } = sortCodecs([...SENDER, plain("H265", H265_MAIN10)], "h265", "640032", "42001f");
        assert.equal(matched, 2);
        assert.deepEqual(sorted.map(c => `${c.mimeType.slice(6)} ${c.sdpFmtpLine ?? ""}`.trim()), [
            `H265 ${H265_SEND}`, `H265 ${H265_MAIN10}`,
            `H264 ${h264(1, "640032").sdpFmtpLine}`, `H264 ${h264(1, "42001f").sdpFmtpLine}`, `H264 ${h264(1, "42e01f").sdpFmtpLine}`,
            `H264 ${h264(1, "4d001f").sdpFmtpLine}`, `H264 ${h264(0, "42001f").sdpFmtpLine}`, `H264 ${h264(0, "42e01f").sdpFmtpLine}`, `H264 ${h264(0, "4d001f").sdpFmtpLine}`,
            "VP8", "AV1 level-idx=5;profile=0;tier=0", "VP9 profile-id=0", "VP9 profile-id=2"
        ]);
    });

    test("sem reserva: H.265 e depois a ordem do Chromium; sem H.265 na lista: matched 0", () => {
        assert.deepEqual(sortCodecs(SENDER, "h265").sorted.slice(0, 3).map(c => c.mimeType), ["video/H265", "video/VP8", "video/H264"]);
        assert.equal(sortCodecs(SENDER.filter(c => c.mimeType !== "video/H265"), "h265", "42001f").matched, 0);
    });

    test("pickNegotiatedCodec: a variante H.265 negociada", () => {
        const negotiated = [h264(1, "42001f"), plain("H265", `${H265_SEND};x-google-max-bitrate=8000`)];
        const d: CodecDecision = { codec: "h265", h264Profile: "42001f", reason: "" };
        assert.deepEqual(pickNegotiatedCodec(negotiated, d), { mimeType: "video/H265", clockRate: 90000, sdpFmtpLine: `${H265_SEND};x-google-max-bitrate=8000` });
        assert.equal(pickNegotiatedCodec([h264(1, "42001f")], d), null);
    });

    test("isH265Main e h265Rank: Main (ou sem profile-id) com SRST (ou sem tx-mode)", () => {
        assert.equal(isH265Main(H265_SEND), true);
        assert.equal(isH265Main("level-id=93"), true);
        assert.equal(isH265Main(H265_MAIN10), false);
        assert.equal(isH265Main("profile-id=1;tx-mode=MRST"), false);
        assert.deepEqual([h265Rank(H265_RECV), h265Rank(H265_MAIN10)], [0, 1]);
    });
});

describe("a sonda de capacidades do H.265", () => {
    const g = globalThis as any;
    function setup(encode: boolean, decode: boolean, sender = SENDER, receiver = RECEIVER) {
        const api = (codecs: Codec[]) => ({ getCapabilities: (kind: string) => (kind === "video" ? { codecs, headerExtensions: [] } : null) });
        g.RTCRtpSender = api(sender);
        g.RTCRtpReceiver = api(receiver);
        const calls: { kind: string; contentType: string; }[] = [];
        const answer = (kind: string, hw: boolean) => (config: any) => {
            const { contentType } = config.video;
            calls.push({ kind, contentType });
            const h265 = /^video\/H265;/.test(contentType);
            return Promise.resolve({ supported: true, smooth: true, powerEfficient: h265 ? hw : /profile-level-id=(42001f|640032|64001f)/.test(contentType) && /packetization-mode=1/.test(contentType) });
        };
        Object.defineProperty(globalThis, "navigator", { value: { mediaCapabilities: { encodingInfo: answer("encodingInfo", encode), decodingInfo: answer("decodingInfo", decode) } }, configurable: true, writable: true });
        return calls;
    }
    const FAST = { callMs: 40, totalMs: 1000 };

    test("Chrome 156 numa RTX 3070: codifica o fmtp Main do sender e decodifica o Main do receiver na placa; a medicao nunca diz que a sonda passou", async () => {
        const calls = setup(true, true);
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h265HwFmtp, H265_SEND);
        assert.equal(local.h265HwDecode, true);
        assert.equal(local.h265ProbeOk, false);
        assert.ok(local.sendable.has("h265"));
        assert.deepEqual(calls.filter(c => /H265/.test(c.contentType)).map(c => `${c.kind} ${c.contentType}`), [
            `decodingInfo video/H265;${H265_RECV}`, `encodingInfo video/H265;${H265_SEND}`
        ], "uma consulta de cada, so no Main (o Main 10 do receiver fica de fora)");
    });

    test("sem H.265 na placa: nao; sem H.265 na lista (o Edge 156): nenhuma consulta", async () => {
        setup(false, false);
        const none = await measureLocalCaps(FAST);
        assert.deepEqual([none.h265HwFmtp, none.h265HwDecode], [null, false]);
        const calls = setup(true, true, SENDER.filter(c => c.mimeType !== "video/H265"), RECEIVER.filter(c => c.mimeType !== "video/H265"));
        const edge = await measureLocalCaps(FAST);
        assert.deepEqual([edge.h265HwFmtp, edge.h265HwDecode, edge.sendable.has("h265")], [null, false, false]);
        assert.equal(calls.filter(c => /H265/.test(c.contentType)).length, 0);
    });

    test("h265Candidates: so Main/SRST, sem repetir, na ordem", () => {
        assert.deepEqual(h265Candidates([...RECEIVER, plain("H265", H265_RECV), plain("H265", "profile-id=1;tx-mode=MRST")]), [H265_RECV]);
    });
});
