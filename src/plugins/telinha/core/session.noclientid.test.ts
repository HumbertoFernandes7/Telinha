/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O Telinha SEM Client ID (prova de identidade desligada): tudo como na v0.1.0. Este processo carrega
// core/identity/config.ts com o Client ID vazio (test/helpers/wpa-no-client-id.ts, importado primeiro) e confere a
// fachada da identidade (desligada: sem certificado, modal, rede nem token) e a sessao (sala sem certificado proprio
// nem acao "identity", ninguem verificado ou falso, duplicados pela regra antiga, sem selos no estado).
// Rodar:  pnpm test:file src/plugins/telinha/core/session.noclientid.test.ts  (todos: pnpm test:unit)

import "@test/helpers/wpa-no-client-id";
import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { buildHello } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { type FetchEnv, installFetch } from "@test/fakes/fetch";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { FRIEND_ID, joinVoice, ME_ID, modals, setVoiceMembers, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { FakeRTCCertificate, FakeRTCPeerConnection, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { hello, logged, logMark } from "@test/helpers/wpa-session";

import { rt } from "./context";
import {
    authorizeIdentity, forgetIdentity, getLocalIdentityState, getLocalIdToken, isIdentityConfigured, localIdentityDiagnostics, prepareIdentity,
    renewIdentity, verifyRemoteIdentity
} from "./identity";
import { peerIdentityDiagnostics, startSession, stopSession } from "./session";
import { startStreaming, stopStreaming } from "./streaming";

const DUP_ID = "200000000000000009";
const AMIGO = "peerAmigo1";
const SCREEN = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, withAudio: false };

describe("sem Client ID: o recurso de identidade desligado (v0.1.0)", () => {
    let rtc: WebRtcEnv;
    let native: NativeEnv;
    let net: FetchEnv;
    let generated = 0;

    before(() => {
        rtc = installWebRtc();
        native = installNative();
        // toda chamada de rede fica registrada (e falha): sem Client ID nao pode haver nenhuma
        net = installFetch(() => undefined);
        FakeRTCPeerConnection.generateCertificateImpl = async () => {
            generated++;
            return new FakeRTCCertificate();
        };
        trystero.reset();
    });

    after(() => {
        stopSession();
        assert.deepEqual(net.calls, [], "nenhuma chamada de rede");
        net.restore();
        native.restore();
        rtc.restore();
    });

    test("este processo ve o Client ID vazio", () => {
        assert.equal(isIdentityConfigured(), false);
    });

    test("identidade local: 'desligada'; nada de certificado, modal, rede ou token", async () => {
        assert.deepEqual(getLocalIdentityState(), { status: "disabled" });
        assert.equal(localIdentityDiagnostics(), "identidade: desligada (sem Client ID)");
        assert.deepEqual(await prepareIdentity(), { certificates: [], fingerprint: null });
        assert.equal(await authorizeIdentity(), false);
        assert.equal(modals.list().length, 0);
        assert.equal(await renewIdentity({ interactive: true }), false);
        await forgetIdentity();
        assert.deepEqual(getLocalIdentityState(), { status: "disabled" });
        assert.equal(getLocalIdToken(), null);
        assert.equal(generated, 0, "sem certificado proprio");
    });

    test("verifyRemoteIdentity: ninguem e verificado nem falso (not-configured)", async () => {
        const res = await verifyRemoteIdentity({ pc: new FakeRTCPeerConnection() as unknown as RTCPeerConnection, idToken: "a.b.c", claimedUserId: FRIEND_ID });
        assert.deepEqual(res, { verdict: "unverified", result: { ok: false, reason: "not-configured" } });
    });

    describe("sessao", () => {
        let room: FakeRoom;

        before(async () => {
            startSession();
            joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID, DUP_ID] });
            room = await eventually(() => trystero.lastRoom);
            await eventually(() => (rt.room as unknown) === room);
        });

        after(() => stopSession());

        test("sala sem certificado proprio e sem a acao identity; o hello vai sem token; quem manda token entra direto", async () => {
            assert.equal("certificates" in room.config.rtcConfig, false);
            assert.equal(rt.certFingerprint, null);
            assert.deepEqual([...room.actions.keys()].sort(), ["codec", "presence", "watch"]);
            assert.equal(generated, 0);

            const { sentHello } = await room.connectPeer(AMIGO, { hello: hello(FRIEND_ID, "amigo", "a.b.c") });
            assert.deepEqual(sentHello, buildHello(ME_ID, "eu"));
            const entry = rt.peers.get(AMIGO)!;
            assert.deepEqual({ identity: entry.identity, reason: entry.identityReason, admitted: entry.admitted }, { identity: "unverified", reason: undefined, admitted: true });
            assert.equal(room.sentOn("presence", AMIGO).length, 1, "admitido na hora, sem 'conferindo'");
            const peer = await eventually(() => getState().peers.find(p => p.peerId === AMIGO));
            assert.equal("identity" in peer, false, "sem selo de identidade na UI");
            assert.equal(peerIdentityDiagnostics(), "");
        });

        test("duplicados: a regra da v0.1.0 (todas as conexoes vivas com o mesmo id ficam marcadas)", async () => {
            const mark = logMark();
            await room.connectPeer("dupA000001", { hello: hello(DUP_ID, "dup", "x.y.z") });
            await room.connectPeer("dupB000001", { hello: hello(DUP_ID, "dup") });
            assert.deepEqual([rt.peers.get("dupA000001")?.duplicate, rt.peers.get("dupB000001")?.duplicate], [true, true]);
            assert.equal(logged(/^Duas conexões dizem ser dup/, mark).length, 1);
            await eventually(() => getState().identityAlerts?.length === 1);
            assert.deepEqual(getState().identityAlerts, [{ discordUserId: DUP_ID, username: "dup", peerIds: ["dupA000001", "dupB000001"], self: false }]);
            room.disconnectPeer("dupA000001");
            room.disconnectPeer("dupB000001");
        });

        test("transmissao: 'exigir identidade verificada' nao vale; 'so quem eu aprovar' espera Permitir, sem selo", async () => {
            await startStreaming({ ...SCREEN, access: "all" });
            room.receive("watch", { op: "start" }, AMIGO);
            await eventually(() => rt.local?.viewers.has(AMIGO));
            stopStreaming();

            await startStreaming({ ...SCREEN, access: "approval" });
            room.receive("watch", { op: "start" }, AMIGO);
            const pending = await eventually(() => getState().local?.pendingViewers?.[0]);
            assert.equal(pending.peerId, AMIGO);
            assert.equal("identity" in pending, false);
            stopStreaming();
        });

        test("saiu do canal de voz: perde a admissao pelo motivo de sempre", async () => {
            const mark = logMark();
            setVoiceMembers(VOICE_CHANNEL_ID, [ME_ID, DUP_ID]);
            await eventually(() => rt.peers.get(AMIGO)?.admitted === false);
            assert.equal(logged(/^amigo \(peerAm\) não está mais admitido \(fora do seu canal de voz\)$/, mark).length, 1);
        });
    });
});
