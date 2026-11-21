/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Janela de tamanho impar (core/codec.ts → oddCaptureSize, avoidHwOnlyOnOddSize): com a captura pela placa, a janela chega
// ao encoder como textura do tamanho exato dela (ex.: 1871x1080), e o encoder da placa (H.265/AV1) recusa tamanho impar; o
// WebRTC trocava sozinho para VP9 ~1 s depois e isso contava como falha do H.265. Agora o envio ja comeca em VP9 (ou VP8),
// com o motivo. Tela par, H.264 e tamanho desconhecido: exatamente como antes. Sem estado do modulo (as capacidades vao
// explicitas).
// Rodar:  pnpm test:file src/plugins/telinha/core/codec.oddSize.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { HW_DECODE_CAPS_VERSION } from "@plugins/telinha/protocol";

import { avoidHwOnlyOnOddSize, chooseCodec, type LocalCodecCaps, oddCaptureSize } from "./codec";

const H265_SEND = "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST";
const AV1_SEND = "level-idx=5;profile=0;tier=0";
/** Este PC com H.264, H.265 e AV1 na placa e todas as sondas ok (Discord com H.264). */
const WITH_H264: LocalCodecCaps = {
    h264HwDecode: true, h264HwEncode: true, h264HwProfile: "42001f", h264HighHwDecode: false, h264HighHwProfile: null, h264HighProbeOk: false,
    h265HwDecode: true, h265HwFmtp: H265_SEND, h265ProbeOk: true, av1HwDecode: true, av1HwFmtp: AV1_SEND, av1ProbeOk: true, av1HwFeature: true,
    sendable: new Set(["h264", "vp8", "vp9", "h265", "av1"])
};
/** O Discord 1.0.9269 no Windows: sem H.264 no sender; o automatico vai de H.265 da placa. */
const NO_H264: LocalCodecCaps = { ...WITH_H264, h264HwEncode: false, h264HwProfile: null, sendable: new Set(["vp8", "vp9", "h265", "av1"]) };
const VIEWER = { h264HwDecode: true, hwDecode: { v: HW_DECODE_CAPS_VERSION, h264High: true, h265: true, av1: true } };
const ODD = { width: 1871, height: 1080 };
const WHY = "e o encoder da placa de vídeo só aceita tamanho par";
const TIP = "(para sair pela placa: transmita a tela inteira ou deixe a janela com tamanho par)";

describe("oddCaptureSize", () => {
    test("largura ou altura impar: o tamanho; as duas pares ou desconhecido: null", () => {
        assert.equal(oddCaptureSize(ODD), "1871x1080");
        assert.equal(oddCaptureSize({ width: 1920, height: 1081 }), "1920x1081");
        assert.equal(oddCaptureSize({ width: 1920, height: 1080 }), null);
        for (const unknown of [undefined, null, {}, { width: 1871 }, { height: 1081 }, { width: 0, height: 1081 }]) {
            assert.equal(oddCaptureSize(unknown), null, JSON.stringify(unknown));
        }
    });
});

describe("avoidHwOnlyOnOddSize: o envio que comeca com a janela impar nunca vai de H.265/AV1", () => {
    test("Discord sem H.264, automatico em H.265: janela 1871x1080 → VP9 com o motivo (e so a altura impar tambem)", () => {
        const base = chooseCodec(VIEWER, "auto", NO_H264);
        assert.equal(base.codec, "h265", "sem a janela impar, o H.265 da placa");
        assert.deepEqual(avoidHwOnlyOnOddSize(base, ODD, NO_H264), {
            codec: "vp9", reason: `a janela tem tamanho ímpar (1871x1080) ${WHY} → VP9 ${TIP}; sem isso iria H.265: ${base.reason}`
        });
        const tall = avoidHwOnlyOnOddSize(base, { width: 1920, height: 1081 }, NO_H264);
        assert.equal(tall.codec, "vp9");
        assert.ok(tall.reason.startsWith(`a janela tem tamanho ímpar (1920x1081) ${WHY} → VP9 ${TIP}`), tall.reason);
    });

    test("tela 1920x1080 (par): o H.265 como antes, a mesma decisao", () => {
        const base = chooseCodec(VIEWER, "auto", NO_H264);
        assert.equal(avoidHwOnlyOnOddSize(base, { width: 1920, height: 1080 }, NO_H264), base);
    });

    test("tamanho ainda desconhecido: a decisao de hoje", () => {
        const base = chooseCodec(VIEWER, "auto", NO_H264);
        for (const unknown of [undefined, null, {}]) assert.equal(avoidHwOnlyOnOddSize(base, unknown, NO_H264), base);
    });

    test("H.265 ou AV1 fixado com a janela impar: VP9 com o motivo (tambem num Discord com H.264, sem a reserva H.264)", () => {
        for (const [setting, label] of [["h265", "H.265"], ["av1", "AV1"]] as const) {
            const base = chooseCodec(VIEWER, setting, WITH_H264);
            assert.equal(base.codec, setting, `${setting} fixado vai, com a tela par`);
            const d = avoidHwOnlyOnOddSize(base, ODD, WITH_H264);
            assert.deepEqual(d, { codec: "vp9", reason: `a janela tem tamanho ímpar (1871x1080) ${WHY} → VP9 ${TIP}; sem isso iria ${label}: ${base.reason}` }, setting);
            assert.ok(!("h264Profile" in d), "sem reserva H.264");
        }
    });

    test("sem VP9 neste cliente: VP8, com o motivo", () => {
        const local: LocalCodecCaps = { ...NO_H264, sendable: new Set(["vp8", "h265"]) };
        const base = chooseCodec(VIEWER, "auto", local);
        assert.equal(base.codec, "h265");
        assert.deepEqual(avoidHwOnlyOnOddSize(base, ODD, local), {
            codec: "vp8", reason: `a janela tem tamanho ímpar (1871x1080) ${WHY}; VP9 indisponível → VP8 ${TIP}; sem isso iria H.265: ${base.reason}`
        });
    });

    test("Discord com H.264 (automatico, ou fixado em H.264/VP9): a decisao igual a de hoje, mesmo com a janela impar", () => {
        for (const setting of ["auto", "h264", "vp9", "vp8"] as const) {
            const base = chooseCodec(VIEWER, setting, WITH_H264);
            assert.ok(base.codec !== "h265" && base.codec !== "av1", setting);
            assert.equal(avoidHwOnlyOnOddSize(base, ODD, WITH_H264), base, setting);
        }
        assert.equal(chooseCodec(VIEWER, "auto", WITH_H264).codec, "h264");
    });

    test("sem as capacidades: usa as do modulo (ainda nao medidas: lista vazia = VP9 vale)", () => {
        const base = chooseCodec(VIEWER, "auto", NO_H264);
        assert.equal(avoidHwOnlyOnOddSize(base, ODD).codec, "vp9");
    });
});
