/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da presenca e da admissao (core/presence.ts): o nosso hello e a nossa presenca, a politica de admissao
// (canal de voz, "recusar quem esta fora", identidade) e para quem a presenca e enviada.
// Rodar:  pnpm test:file src/plugins/telinha/core/presence.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { buildHello, buildHwDecodeCaps, HW_DECODE_CAPS_VERSION, isPresenceMessage, type PresenceMessage, PROTOCOL_VERSION, sanitizePresence } from "@plugins/telinha/protocol";
import { FakeRoom } from "@test/fakes/trystero";
import { makeUser, ME_ID, pluginSettings, UserStore } from "@test/fakes/vencord";
import { DEFAULT_VIDEO_CODECS, installWebRtc, rtpCapabilities } from "@test/fakes/webrtc";
import { logged, logMark } from "@test/helpers/wpa-session";

import { getLocalCaps, probeLocalCaps } from "./codec";
import { type LocalCapture, type PeerEntry, rt } from "./context";
import { computeAdmitted, me, selfHello, selfPresence, sendPresence } from "./presence";

/** H.264 High como o Chromium 152 lista com a placa de video (packetization-mode=1). */
const HIGH_640032: RTCRtpCodec = { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032" };

function peer(peerId: string, patch: Partial<PeerEntry> = {}): PeerEntry {
    return {
        peerId, hello: buildHello("200000000000000002", "amigo"), presence: null, inVoice: true, incompatible: false, admitted: true,
        duplicate: false, impostor: false, claimsSelf: false, identity: "verified", identityChecking: false, identityCheckedAt: 0, ...patch
    };
}

describe("o que mandamos", () => {
    afterEach(() => {
        UserStore.reset();
        rt.local = null;
    });

    test("me(): id e nome do usuario atual (nome truncado em 64; sem usuario: vazio e '?')", () => {
        assert.deepEqual(me(), { id: ME_ID, username: "eu" });
        UserStore.setCurrentUser(makeUser(ME_ID, "n".repeat(100)));
        assert.equal(me().username.length, 64);
        UserStore.setCurrentUser(makeUser(ME_ID, ""));
        assert.equal(me().username, "?");
        UserStore.setCurrentUser(null);
        assert.deepEqual(me(), { id: "", username: "?" });
    });

    test("selfHello sem token (nunca autorizou): exatamente o hello da v0.1.0", () => {
        assert.deepEqual(selfHello(), { type: "telinha-hello", v: PROTOCOL_VERSION, discordUserId: ME_ID, username: "eu" });
    });

    test("selfHello: se ler o token lancar, vai sem token (nunca derruba o handshake)", () => {
        const desc = Object.getOwnPropertyDescriptor(rt, "certFingerprint")!;
        Object.defineProperty(rt, "certFingerprint", {
            configurable: true,
            get() {
                throw new Error("estado quebrado");
            }
        });
        try {
            assert.equal("idToken" in selfHello(), false);
        } finally {
            Object.defineProperty(rt, "certFingerprint", desc);
        }
    });

    test("selfPresence: parado, e transmitindo (com o modo de acesso, nunca a senha)", () => {
        assert.deepEqual(selfPresence(), { v: PROTOCOL_VERSION, discordUserId: ME_ID, username: "eu", streaming: false, caps: { h264HwDecode: false } });
        rt.local = {
            info: { kind: "window", title: "Jogo", hasAudio: true, width: 1280, height: 720, fps: 60 }, access: "password", password: "segredo"
        } as unknown as LocalCapture;
        const p = selfPresence();
        assert.deepEqual(p.stream, { kind: "window", title: "Jogo", hasAudio: true, width: 1280, height: 720, fps: 60, access: "password" });
        assert.equal(p.streaming, true);
        assert.equal(JSON.stringify(p).includes("segredo"), false);
    });

    test("selfPresence com High na placa: caps.hwDecode versionado (passo 11); o resto da presenca e o de antes", async () => {
        const rtc = installWebRtc();
        try {
            rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video: [...DEFAULT_VIDEO_CODECS, HIGH_640032] };
            rtc.mediaCapabilities.hwDecode = ["42001f", "640032"];
            await probeLocalCaps();
            assert.equal(getLocalCaps().h264HighHwDecode, true);
            assert.deepEqual(selfPresence().caps, { h264HwDecode: true, hwDecode: { v: HW_DECODE_CAPS_VERSION, h264High: true } });
            pluginSettings.set("shareDiagnostics", true);
            assert.deepEqual(selfPresence().caps, { h264HwDecode: true, diag: true, hwDecode: { v: 1, h264High: true } });
        } finally {
            pluginSettings.reset();
            rtc.restore();
        }
    });
});

describe("presenca recebida: caps.hwDecode (protocol.ts passo 11)", () => {
    const base = { v: PROTOCOL_VERSION, discordUserId: "200000000000000002", username: "amigo", streaming: false };
    const capsOf = (caps: unknown) => sanitizePresence({ ...base, caps } as PresenceMessage).caps;

    test("v1 com High: fica; marcas desconhecidas (H.265/AV1 futuros) e lixo saem", () => {
        assert.deepEqual(capsOf({ h264HwDecode: true, hwDecode: { v: 1, h264High: true } }), { h264HwDecode: true, hwDecode: { v: 1, h264High: true } });
        assert.deepEqual(capsOf({ h264HwDecode: true, hwDecode: { v: 1, h264High: true, av1: true, evil: "x" } }), { h264HwDecode: true, hwDecode: { v: 1, h264High: true } });
    });

    test("versao antiga (sem o campo), nada verdadeiro, outra versao ou formato errado: como sem o campo", () => {
        for (const hwDecode of [undefined, null, "x", 1, [], [{ v: 1, h264High: true }], {}, { v: 1 }, { v: 1, h264High: false }, { v: 1, h264High: "true" },
            { v: 2, h264High: true }, { v: "1", h264High: true }, { h264High: true }]) {
            assert.deepEqual(capsOf({ h264HwDecode: true, ...(hwDecode !== undefined ? { hwDecode } : {}) }), { h264HwDecode: true }, JSON.stringify(hwDecode));
        }
    });

    test("o que mandamos e o que a v0.3.2 aceita: o campo novo e opcional e o resto da presenca fica igual", () => {
        assert.equal(buildHwDecodeCaps(false), null);
        assert.deepEqual(buildHwDecodeCaps(true), { v: HW_DECODE_CAPS_VERSION, h264High: true });
        const ours = { ...base, caps: { h264HwDecode: true, hwDecode: buildHwDecodeCaps(true)! } };
        assert.equal(isPresenceMessage(ours), true);
        // o sanitizePresence da v0.3.2 so copia h264HwDecode e diag: o mesmo resultado de uma presenca sem o campo
        const { hwDecode: _ignored, ...oldView } = sanitizePresence(ours).caps;
        assert.deepEqual(oldView, { h264HwDecode: true });
    });
});

describe("admissao", () => {
    afterEach(() => pluginSettings.reset());

    test("incompativel ou sem hello: nunca", () => {
        assert.equal(computeAdmitted(peer("a", { incompatible: true })), false);
        assert.equal(computeAdmitted(peer("a", { hello: null })), false);
    });

    test("com Client ID: verificado/nao verificado no canal sim; conferindo ou prova falsa nao", () => {
        assert.equal(computeAdmitted(peer("a", { identity: "verified" })), true);
        assert.equal(computeAdmitted(peer("a", { identity: "unverified" })), true);
        assert.equal(computeAdmitted(peer("a", { identity: "pending" })), false);
        assert.equal(computeAdmitted(peer("a", { identity: "invalid" })), false);
    });

    test("fora do canal de voz: so com 'recusar quem esta fora' desligado", () => {
        assert.equal(computeAdmitted(peer("a", { inVoice: false })), false);
        pluginSettings.load({ rejectOutsiders: false });
        assert.equal(computeAdmitted(peer("a", { inVoice: false })), true);
        assert.equal(computeAdmitted(peer("a", { inVoice: false, identity: "invalid" })), false);
    });
});

describe("sendPresence", () => {
    afterEach(() => {
        rt.presenceAction = null;
        rt.peers.clear();
    });

    function setup() {
        const room = new FakeRoom({}, "sala", {});
        const action = room.makeAction("presence");
        rt.presenceAction = action as unknown as typeof rt.presenceAction;
        rt.peers.set("pA", peer("pA"));
        rt.peers.set("pB", peer("pB", { admitted: false }));
        rt.peers.set("pC", peer("pC"));
        return { room, action };
    }

    test("fora da sala (sem acao): nada", () => {
        rt.peers.set("pA", peer("pA"));
        sendPresence();
        sendPresence("pA");
    });

    test("para todos os admitidos, ou so para um admitido; nao admitido nunca recebe", () => {
        const { room } = setup();
        sendPresence();
        assert.deepEqual(room.sent.map(m => m.target), [["pA", "pC"]]);
        assert.equal(room.sent[0].data.discordUserId, ME_ID);

        sendPresence("pC");
        assert.deepEqual(room.sent.at(-1)?.target, ["pC"]);

        sendPresence("pB");
        sendPresence("desconhecido");
        assert.equal(room.sent.length, 2);

        rt.peers.get("pA")!.admitted = false;
        rt.peers.get("pC")!.admitted = false;
        sendPresence();
        assert.equal(room.sent.length, 2, "ninguem admitido: nada sai");
    });

    test("falha ao enviar: so um aviso no log", async () => {
        const { action } = setup();
        action.sendImpl = () => Promise.reject(new Error("canal fechado"));
        const mark = logMark();
        sendPresence();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(logged(/^Falha ao enviar presença: Error: canal fechado$/, mark).length, 1);
    });
});
