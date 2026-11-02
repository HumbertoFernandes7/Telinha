/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// caps.hwDecode.av1 (protocol.ts passo 11, depois da v0.3.3, a mesma `v`): o que anunciamos, o que aceitamos, e o que as
// versoes de antes fazem com a marca nova (o parse delas reconstroi o objeto so com as marcas que conhecem: o High e o
// H.265 continuam, o AV1 some, e elas nunca mandam AV1).
// Rodar:  pnpm test:file src/plugins/telinha/core/presence.av1.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    buildHwDecodeCaps, HW_DECODE_CAPS_VERSION, type HwDecodeCaps, isPresenceMessage, parseHwDecodeCaps, type PresenceMessage, PROTOCOL_VERSION, sanitizePresence
} from "@plugins/telinha/protocol";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities } from "@test/fakes/webrtc";

import { getLocalCaps, probeLocalCaps } from "./codec";
import { selfPresence } from "./presence";

const AV1_MAIN: RTCRtpCodec = { mimeType: "video/AV1", clockRate: 90000, sdpFmtpLine: "level-idx=5;profile=0;tier=0" };
const HIGH: RTCRtpCodec = { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f" };

/** O parseHwDecodeCaps da versao do H.265 (o develop antes do AV1), copiado: so o h264High e o h265 sobrevivem. */
function parseH265Era(data: any): HwDecodeCaps | null {
    if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== 1) return null;
    const h264High = data.h264High === true;
    const h265 = data.h265 === true;
    if (!h264High && !h265) return null;
    return { v: 1, ...(h264High ? { h264High: true } : {}), ...(h265 ? { h265: true } : {}) };
}

describe("caps.hwDecode.av1", () => {
    test("o que mandamos: so as marcas verdadeiras; nada verdadeiro = sem o campo", () => {
        assert.equal(buildHwDecodeCaps(false, false, false), null);
        assert.deepEqual(buildHwDecodeCaps(true, false, true), { v: HW_DECODE_CAPS_VERSION, h264High: true, av1: true });
        assert.deepEqual(buildHwDecodeCaps(false, false, true), { v: HW_DECODE_CAPS_VERSION, av1: true });
        assert.deepEqual(buildHwDecodeCaps(true, true, true), { v: HW_DECODE_CAPS_VERSION, h264High: true, h265: true, av1: true });
        assert.deepEqual(buildHwDecodeCaps(true, true), { v: HW_DECODE_CAPS_VERSION, h264High: true, h265: true }, "sem o 3o argumento: o de antes");
    });

    test("o que aceitamos: av1 so `true` e na mesma `v`; lixo sai", () => {
        assert.deepEqual(parseHwDecodeCaps({ v: 1, h264High: true, av1: true, x: "y" }), { v: 1, h264High: true, av1: true });
        assert.deepEqual(parseHwDecodeCaps({ v: 1, av1: true }), { v: 1, av1: true });
        for (const bad of [{ v: 1, av1: "true" }, { v: 1, av1: 1 }, { v: 2, av1: true }, { av1: true }]) assert.equal(parseHwDecodeCaps(bad), null, JSON.stringify(bad));
        const base = { v: PROTOCOL_VERSION, discordUserId: "200000000000000002", username: "amigo", streaming: false };
        const { caps } = sanitizePresence({ ...base, caps: { h264HwDecode: true, hwDecode: { v: 1, h264High: true, av1: true } } } as PresenceMessage);
        assert.deepEqual(caps, { h264HwDecode: true, hwDecode: { v: 1, h264High: true, av1: true } });
    });

    test("versoes misturadas: a de antes le o nosso campo sem o AV1 (High e H.265 continuam) e o so-AV1 como sem o campo", () => {
        const ours = buildHwDecodeCaps(true, true, true)!;
        assert.deepEqual(parseH265Era(ours), { v: 1, h264High: true, h265: true }, "o High e o H.265 nao se perdem por causa do AV1");
        assert.equal(parseH265Era(buildHwDecodeCaps(false, false, true)), null, "so AV1: a versao de antes nao ve nada (e nunca manda AV1)");
        const base = { v: PROTOCOL_VERSION, discordUserId: "200000000000000002", username: "amigo", streaming: false };
        assert.equal(isPresenceMessage({ ...base, caps: { h264HwDecode: true, hwDecode: ours } }), true);
        // e a presenca de uma versao de antes aqui: sem AV1
        assert.deepEqual(parseHwDecodeCaps({ v: 1, h264High: true, h265: true }), { v: 1, h264High: true, h265: true });
    });

    test("selfPresence com AV1 (e High) na placa (uma RTX 30 decodifica AV1): as duas marcas", async () => {
        const rtc = installWebRtc();
        try {
            rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video: [...DEFAULT_VIDEO_CODECS, HIGH, AV1_MAIN] };
            rtc.mediaCapabilities.hwDecode = ["42001f", "64001f", "av1"];
            await probeLocalCaps();
            assert.equal(getLocalCaps().av1HwDecode, true);
            assert.deepEqual(selfPresence().caps, { h264HwDecode: true, hwDecode: { v: HW_DECODE_CAPS_VERSION, h264High: true, av1: true } });
        } finally {
            rtc.restore();
        }
    });
});
