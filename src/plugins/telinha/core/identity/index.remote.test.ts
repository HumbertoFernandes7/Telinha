/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado REMOTO da prova de identidade (verifyRemoteIdentity em core/identity/index.ts): o id_token de um
// peer conferido contra o certificado DTLS que ele usou na RTCPeerConnection falsa (DER, estatisticas ou SDP) e o JWKS
// do Discord falso (persistido no DataStore, buscado de novo numa rotacao de chave, sem rede). Em ordem: o cache do
// JWKS e um so por processo.
// Rodar:  pnpm test:file src/plugins/telinha/core/identity/index.remote.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { dataStoreData } from "@test/fakes/vencord";
import { FakeRTCPeerConnection, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { colonHex, fakeDer, type FakeDiscord, installFakeDiscord, makeIdToken, makeRsaKey, type ShiftableNow, shiftableNow, type TestKey } from "@test/helpers/wpa-identity";
import { logged, logMark } from "@test/helpers/wpa-session";

import { verifyRemoteIdentity } from "./index";

const FRIEND = "200000000000000002";
const DAY = 24 * 60 * 60_000;

describe("verifyRemoteIdentity", () => {
    let rtc: WebRtcEnv;
    let clock: ShiftableNow;
    let discord: FakeDiscord;
    let K1: TestKey;
    let K2: TestKey;

    before(() => {
        clock = shiftableNow();
        rtc = installWebRtc();
        K1 = makeRsaKey("k1");
        K2 = makeRsaKey("k2");
        discord = installFakeDiscord({ keys: [K1.jwk, K2.jwk] });
        // o JWKS que ficou gravado da ultima sessao do Discord: so com a chave antiga
        dataStoreData.set("telinha-identity-jwks-v1", { jwks: { keys: [K1.jwk] }, fetchedAt: Date.now() });
    });

    after(() => {
        discord.restore();
        rtc.restore();
        clock.restore();
    });

    /** a conexao com o peer, com o certificado DER que ele usou no DTLS */
    function peerPc(der?: ArrayBuffer) {
        const pc = new FakeRTCPeerConnection();
        if (der) pc.sctp!.transport.remoteCertificates = [der];
        return pc;
    }

    const check = (pc: FakeRTCPeerConnection | null, idToken: unknown, claimedUserId = FRIEND) =>
        verifyRemoteIdentity({ pc: pc as unknown as RTCPeerConnection, idToken, claimedUserId });

    test("sem token (nao autorizou / versao antiga): nao verificado, sem rede", async () => {
        for (const idToken of [undefined, null, 42, ""]) {
            assert.deepEqual(await check(peerPc(), idToken), { verdict: "unverified", result: { ok: false, reason: "missing" } });
        }
        assert.equal(discord.calls.length, 0);
    });

    test("sem conexao, ou DTLS ainda nao conectado: no-fingerprint (com aviso)", async () => {
        assert.deepEqual(await check(null, "a.b.c"), { verdict: "unverified", result: { ok: false, reason: "no-fingerprint" } });
        const pc = peerPc(fakeDer().der);
        pc.sctp!.transport.state = "connecting";
        const mark = logMark();
        assert.deepEqual(await check(pc, "a.b.c"), { verdict: "unverified", result: { ok: false, reason: "no-fingerprint" } });
        assert.equal(logged(/^Identidade: fingerprint DTLS do peer indisponível \(dtls-not-connected\)$/, mark).length, 1);
        assert.equal(discord.calls.length, 0);
    });

    test("chave nova do Discord (rotacao): o JWKS gravado nao tem; busca de novo e verifica", async () => {
        const { der, fingerprint } = fakeDer();
        const idToken = await makeIdToken({ userId: FRIEND, fingerprint, key: K2 });
        const res = await check(peerPc(der), idToken);
        assert.equal(res.verdict, "verified");
        assert.equal(res.result.ok && res.result.userId, FRIEND);
        assert.equal(discord.jwksRequests.length, 1, "uma busca: a do kid desconhecido");
    });

    test("token valido amarrado ao certificado da conexao: verificado, sem rede", async () => {
        const { der, fingerprint } = fakeDer();
        const res = await check(peerPc(der), await makeIdToken({ userId: FRIEND, fingerprint, key: K1 }));
        assert.equal(res.verdict, "verified");
        assert.equal(discord.jwksRequests.length, 1);
    });

    test("fingerprint so pelas estatisticas (certificate) ou so pelo SDP remoto tambem serve", async () => {
        const { fingerprint } = fakeDer();
        const idToken = await makeIdToken({ userId: FRIEND, fingerprint, key: K1 });

        const viaStats = peerPc();
        viaStats.stats = [
            { id: "T1", type: "transport", remoteCertificateId: "C1" },
            { id: "C1", type: "certificate", fingerprintAlgorithm: "sha-256", fingerprint: colonHex(fingerprint) }
        ];
        assert.equal((await check(viaStats, idToken)).verdict, "verified");

        const viaSdp = peerPc();
        viaSdp.currentRemoteDescription = { type: "answer", sdp: `v=0\r\na=fingerprint:sha-256 ${colonHex(fingerprint)}\r\n` };
        assert.equal((await check(viaSdp, idToken)).verdict, "verified");
    });

    test("token copiado de outra conexao, ou de outra pessoa: prova falsa", async () => {
        const mine = fakeDer();
        const theirs = fakeDer();
        const copied = await makeIdToken({ userId: FRIEND, fingerprint: theirs.fingerprint, key: K1 });
        assert.deepEqual(await check(peerPc(mine.der), copied), { verdict: "invalid", result: { ok: false, reason: "fingerprint-mismatch" } });
        const other = await makeIdToken({ userId: FRIEND, fingerprint: mine.fingerprint, key: K1 });
        assert.deepEqual(await check(peerPc(mine.der), other, "300000000000000003"), { verdict: "invalid", result: { ok: false, reason: "wrong-subject" } });
    });

    test("kid desconhecido logo depois de buscar o JWKS: nao verificado, sem buscar de novo (1x/min)", async () => {
        const { der, fingerprint } = fakeDer();
        const idToken = await makeIdToken({ userId: FRIEND, fingerprint, key: K2, header: { kid: "k3" } });
        assert.deepEqual(await check(peerPc(der), idToken), { verdict: "unverified", result: { ok: false, reason: "unknown-key" } });
        assert.equal(discord.jwksRequests.length, 1);
    });

    test("sem rede e o JWKS velho demais (30 dias): nao verificado (unknown-key), com aviso", async () => {
        clock.advance(31 * DAY);
        discord.jwksImpl = () => Promise.reject(new TypeError("offline"));
        const { der, fingerprint } = fakeDer();
        const idToken = await makeIdToken({ userId: FRIEND, fingerprint, key: K1 });
        const mark = logMark();
        assert.deepEqual(await check(peerPc(der), idToken), { verdict: "unverified", result: { ok: false, reason: "unknown-key" } });
        assert.equal(logged(/^Identidade: não foi possível baixar as chaves do Discord: TypeError: offline$/, mark).length, 1);
    });
});
