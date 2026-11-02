/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// caps.hwDecode.h265 (protocol.ts passo 11, depois da v0.3.3, a mesma `v`): o que anunciamos, o que aceitamos, e o que a
// v0.3.3 faz com o campo novo (o parse dela reconstroi o objeto so com o h264High: o High continua, o H.265 some).
// Rodar:  pnpm test:file src/plugins/telinha/core/presence.h265.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    buildHwDecodeCaps, HW_DECODE_CAPS_VERSION, type HwDecodeCaps, isPresenceMessage, parseHwDecodeCaps, type PresenceMessage, PROTOCOL_VERSION, sanitizePresence
} from "@plugins/telinha/protocol";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities } from "@test/fakes/webrtc";

import { getLocalCaps, probeLocalCaps } from "./codec";
import { selfPresence } from "./presence";

const H265_MAIN: RTCRtpCodec = { mimeType: "video/H265", clockRate: 90000, sdpFmtpLine: "level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST" };
const HIGH: RTCRtpCodec = { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f" };

/** O parseHwDecodeCaps da v0.3.3, copiado da tag (protocol.ts): so o h264High sobrevive. */
function parseV033(data: any): HwDecodeCaps | null {
    if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== 1) return null;
    return data.h264High === true ? { v: 1, h264High: true } : null;
}

describe("caps.hwDecode.h265", () => {
    test("o que mandamos: so as marcas verdadeiras; nada verdadeiro = sem o campo", () => {
        assert.equal(buildHwDecodeCaps(false, false), null);
        assert.deepEqual(buildHwDecodeCaps(true, true), { v: HW_DECODE_CAPS_VERSION, h264High: true, h265: true });
        assert.deepEqual(buildHwDecodeCaps(false, true), { v: HW_DECODE_CAPS_VERSION, h265: true });
        assert.deepEqual(buildHwDecodeCaps(true), { v: HW_DECODE_CAPS_VERSION, h264High: true }, "sem o 2o argumento: o de antes");
    });

    test("o que aceitamos: h265 so `true` e na mesma `v`; lixo e marcas desconhecidas saem", () => {
        assert.deepEqual(parseHwDecodeCaps({ v: 1, h264High: true, h265: true, vvc: true, x: "y" }), { v: 1, h264High: true, h265: true });
        assert.deepEqual(parseHwDecodeCaps({ v: 1, h265: true }), { v: 1, h265: true });
        for (const bad of [{ v: 1, h265: "true" }, { v: 1, h265: 1 }, { v: 2, h265: true }, { h265: true }]) assert.equal(parseHwDecodeCaps(bad), null, JSON.stringify(bad));
        const base = { v: PROTOCOL_VERSION, discordUserId: "200000000000000002", username: "amigo", streaming: false };
        const { caps } = sanitizePresence({ ...base, caps: { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } } } as PresenceMessage);
        assert.deepEqual(caps, { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } });
    });

    test("versoes misturadas: a v0.3.3 le o nosso campo como so High (o High continua) e o so-H.265 como sem o campo; a presenca continua valida", () => {
        const ours = buildHwDecodeCaps(true, true)!;
        assert.deepEqual(parseV033(ours), { v: 1, h264High: true }, "o High nao se perde por causa do H.265");
        assert.equal(parseV033(buildHwDecodeCaps(false, true)), null, "so H.265: a v0.3.3 nao ve nada (e nunca manda H.265)");
        const base = { v: PROTOCOL_VERSION, discordUserId: "200000000000000002", username: "amigo", streaming: false };
        assert.equal(isPresenceMessage({ ...base, caps: { h264HwDecode: true, hwDecode: ours } }), true);
        // e a presenca de uma v0.3.3 (so High) aqui: sem H.265
        assert.deepEqual(parseHwDecodeCaps({ v: 1, h264High: true }), { v: 1, h264High: true });
    });

    test("selfPresence com H.265 (e High) na placa: as duas marcas", async () => {
        const rtc = installWebRtc();
        try {
            rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video: [...DEFAULT_VIDEO_CODECS, HIGH, H265_MAIN] };
            rtc.mediaCapabilities.hwDecode = ["42001f", "64001f", "h265"];
            await probeLocalCaps();
            assert.equal(getLocalCaps().h265HwDecode, true);
            assert.deepEqual(selfPresence().caps, { h264HwDecode: true, hwDecode: { v: HW_DECODE_CAPS_VERSION, h264High: true, h265: true } });
        } finally {
            rtc.restore();
        }
    });
});
