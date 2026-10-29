/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do certificado DTLS persistente (core/identity/certificate.ts) com o DataStore e o RTCCertificate falsos:
// gera e grava, reaproveita, troca perto do vencimento, e sobrevive a DataStore travado/cheio.
// Rodar:  pnpm test:file src/plugins/telinha/core/identity/certificate.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { dataStoreData, dataStoreImpl } from "@test/fakes/vencord";
import { FakeRTCCertificate, FakeRTCPeerConnection, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";

import { forgetLocalCertificate, getLocalCertificate } from "./certificate";
import { CERT_LIFETIME_MS, CERT_ROTATE_BEFORE_MS } from "./config";

const KEY = "telinha-identity-cert-v1";
const DAY = 24 * 60 * 60_000;

describe("certificado DTLS persistente", () => {
    let rtc: WebRtcEnv;
    let keygens: unknown[];

    before(() => {
        rtc = installWebRtc();
    });

    after(() => rtc.restore());

    beforeEach(async () => {
        FakeRTCPeerConnection.generateCertificateImpl = null;
        await forgetLocalCertificate();
        dataStoreData.clear();
        keygens = [];
        FakeRTCPeerConnection.generateCertificateImpl = async keygen => {
            keygens.push(keygen);
            return new FakeRTCCertificate(Date.now() + CERT_LIFETIME_MS);
        };
    });

    test("primeira vez: gera ECDSA P-256 com 180 dias, grava no DataStore e devolve o fingerprint normalizado", async () => {
        const cert = await getLocalCertificate();
        assert.deepEqual(keygens, [{ name: "ECDSA", namedCurve: "P-256", expires: CERT_LIFETIME_MS }]);
        assert.equal(dataStoreData.get(KEY), cert.certificate);
        assert.equal(cert.persisted, true);
        assert.match(cert.fingerprint, /^sha-256:[0-9a-f]{64}$/);
        const raw = (cert.certificate as unknown as FakeRTCCertificate).fingerprint.replace(/:/g, "").toLowerCase();
        assert.equal(cert.fingerprint, `sha-256:${raw}`);
        assert.equal(cert.expiresAt, cert.certificate.expires);
    });

    test("depois: o mesmo certificado (nada de gerar outro a cada sala)", async () => {
        const a = await getLocalCertificate();
        const b = await getLocalCertificate();
        assert.equal(b, a);
        assert.equal(keygens.length, 1);
    });

    test("perto do vencimento: troca por um novo e grava", async () => {
        const a = await getLocalCertificate();
        const b = await getLocalCertificate(a.expiresAt - CERT_ROTATE_BEFORE_MS + 1);
        assert.notEqual(b.certificate, a.certificate);
        assert.equal(dataStoreData.get(KEY), b.certificate);
        assert.equal(keygens.length, 2);
        // e o novo fica: a proxima chamada (hoje) devolve ele
        assert.equal((await getLocalCertificate()).certificate, b.certificate);
    });

    test("carrega o gravado (Discord reaberto); gravado vencendo, invalido ou sem SHA-256: gera outro", async () => {
        const stored = new FakeRTCCertificate(Date.now() + 100 * DAY);
        dataStoreData.set(KEY, stored);
        const loaded = await getLocalCertificate();
        assert.equal(loaded.certificate, stored as unknown as RTCCertificate);
        assert.equal(loaded.persisted, true);
        assert.equal(keygens.length, 0);

        for (const bad of [
            new FakeRTCCertificate(Date.now() + 5 * DAY),
            { expires: Date.now() + 100 * DAY, getFingerprints: () => [] },
            Object.assign(new FakeRTCCertificate(Date.now() + 100 * DAY), { getFingerprints: () => [{ algorithm: "sha-1", value: "AB" }] })
        ]) {
            await forgetLocalCertificate();
            dataStoreData.set(KEY, bad);
            const cert = await getLocalCertificate();
            assert.notEqual(cert.certificate, bad as unknown as RTCCertificate);
            assert.equal(dataStoreData.get(KEY), cert.certificate);
        }
        assert.equal(keygens.length, 3);
    });

    test("DataStore travado na leitura: gera; sem conseguir gravar: persisted false (vale ate fechar o Discord)", async t => {
        t.mock.method(dataStoreImpl, "get", async () => {
            throw new Error("IndexedDB travado");
        });
        t.mock.method(dataStoreImpl, "set", async () => {
            throw new Error("QuotaExceededError");
        });
        const cert = await getLocalCertificate();
        assert.equal(cert.persisted, false);
        assert.equal(keygens.length, 1);
        assert.equal(dataStoreData.has(KEY), false);
    });

    test("gerar falhou: rejeita, e a proxima chamada tenta de novo", async () => {
        FakeRTCPeerConnection.generateCertificateImpl = () => Promise.reject(new Error("sem WebCrypto"));
        await assert.rejects(getLocalCertificate(), /sem WebCrypto/);
        FakeRTCPeerConnection.generateCertificateImpl = async () => new FakeRTCCertificate(Date.now() + CERT_LIFETIME_MS);
        const cert = await getLocalCertificate();
        assert.equal(cert.persisted, true);
    });

    test("forgetLocalCertificate apaga o gravado: o proximo e outro (o token antigo deixa de valer)", async () => {
        const a = await getLocalCertificate();
        await forgetLocalCertificate();
        assert.equal(dataStoreData.has(KEY), false);
        const b = await getLocalCertificate();
        assert.notEqual(b.fingerprint, a.fingerprint);
    });
});
