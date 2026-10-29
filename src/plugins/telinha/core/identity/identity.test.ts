/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes das partes PURAS da prova de identidade. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm exec tsx --test src/plugins/telinha/core/identity/identity.test.ts

import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { describe, test } from "node:test";

import { buildHello, HELLO_TYPE, isIdentityMessage, MAX_ID_TOKEN_CHARS, parseHello, PROTOCOL_VERSION } from "@plugins/telinha/protocol";

import { certificateNeedsRotation, CLOCK_SKEW_MS, isIdentityConfigured, MAX_ID_TOKEN_LENGTH, MAX_TOKEN_AGE_MS, tokenAcceptedUntil, tokenNeedsRenewal } from "./config";
import { base64UrlDecode, base64UrlEncode, utf8 } from "./encoding";
import { asNormalizedFingerprint, nonceForFingerprint, normalizeFingerprint, parseSdpFingerprints, singleSdpFingerprint } from "./fingerprint";
import { JwksCache } from "./jwks";
import type { Jwk, Jwks } from "./jwt";
import { buildCodeExchangeBody, buildRefreshBody, OAuthError, parseAuthorizeLocation, pkceChallenge, requestToken } from "./oauth";
import {
    type DuplicateCandidate, findDuplicates, identityRequiresApproval, initialPeerIdentity, isAdmitted, nextPeerIdentity, type PeerIdentity,
    watchNeedsApproval
} from "./policy";
import { getRemoteDtlsFingerprint } from "./remoteFingerprint";
import { identityVerdict, verifyPeerIdentity, type VerifyPeerIdentityInput } from "./verify";

const CLIENT_ID = "123456789012345678";
const USER = "987654321098765432";
const OTHER_USER = "111111111111111111";
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const FP_A = "sha-256:" + "ab".repeat(32);
const FP_B = "sha-256:" + "cd".repeat(32);

function makeKey(kid: string): { privateKey: KeyObject; jwk: Jwk; } {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const exported = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string; };
    return { privateKey, jwk: { kty: exported.kty, n: exported.n, e: exported.e, kid, use: "sig", alg: "RS256" } };
}

const K1 = makeKey("k1");
const K2 = makeKey("k2");
const JWKS: Jwks = { keys: [K1.jwk] };

const segment = (obj: unknown) => base64UrlEncode(utf8(JSON.stringify(obj)));

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject = K1.privateKey): string {
    const input = `${segment(header)}.${segment(payload)}`;
    const sig = createSign("RSA-SHA256").update(input).sign(key);
    return `${input}.${base64UrlEncode(sig)}`;
}

async function claims(over: Record<string, unknown> = {}) {
    return {
        iss: "https://discord.com",
        aud: CLIENT_ID,
        sub: USER,
        iat: NOW_S - 60,
        exp: NOW_S + 3600,
        nonce: await nonceForFingerprint(FP_A),
        ...over
    };
}

async function token(over: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }, key?: KeyObject) {
    return signJwt(header, await claims(over), key);
}

function verify(idToken: unknown, over: Partial<VerifyPeerIdentityInput> = {}) {
    return verifyPeerIdentity({
        idToken, claimedUserId: USER, remoteDtlsFingerprint: FP_A, now: NOW, jwks: JWKS, clientId: CLIENT_ID, ...over
    });
}

async function expectFailure(idToken: unknown, reason: string, over: Partial<VerifyPeerIdentityInput> = {}) {
    const res = await verify(idToken, over);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, reason);
}

describe("verifyPeerIdentity", () => {
    test("token valido, amarrado ao certificado da conexao", async () => {
        const res = await verify(await token());
        assert.deepEqual(res, { ok: true, userId: USER, expiresAt: (NOW_S + 3600) * 1000, issuedAt: (NOW_S - 60) * 1000 });
        assert.equal(identityVerdict(res), "verified");
    });

    test("aceita o fingerprint no formato do SDP (maiusculo com ':')", async () => {
        const sdpStyle = "sha-256 " + Array(32).fill("AB").join(":");
        assert.equal((await verify(await token(), { remoteDtlsFingerprint: sdpStyle })).ok, true);
    });

    test("token copiado de outro peer (certificado diferente) -> fingerprint-mismatch / invalid", async () => {
        const res = await verify(await token(), { remoteDtlsFingerprint: FP_B });
        assert.deepEqual(res, { ok: false, reason: "fingerprint-mismatch" });
        assert.equal(identityVerdict(res), "invalid");
    });

    test("token copiado E vencido continua sendo impostor (binding antes do tempo)", async () => {
        const res = await verify(await token({ exp: NOW_S - 7200, iat: NOW_S - 10_000 }), { remoteDtlsFingerprint: FP_B });
        assert.equal(identityVerdict(res), "invalid");
    });

    test("token de outra pessoa (sub != id anunciado) -> wrong-subject", async () => {
        await expectFailure(await token({ sub: OTHER_USER }), "wrong-subject");
        await expectFailure(await token(), "wrong-subject", { claimedUserId: OTHER_USER });
    });

    describe("carencia depois do exp (token amarrado ao certificado)", () => {
        const HOUR_S = 3600;
        const DAY_S = 86_400;
        /** token que venceu `secondsPastExp` segundos atras (emitido 1 h antes do exp, como o do Discord) */
        const expiredFor = (secondsPastExp: number, over: Record<string, unknown> = {}) =>
            token({ exp: NOW_S - secondsPastExp, iat: NOW_S - secondsPastExp - HOUR_S, ...over });

        test("a carencia e de 7 dias", () => {
            assert.equal(MAX_TOKEN_AGE_MS, 7 * DAY_S * 1000);
        });

        test("30 min depois do exp -> ok (verified)", async () => {
            const res = await verify(await expiredFor(30 * 60));
            assert.deepEqual(res, { ok: true, userId: USER, expiresAt: (NOW_S - 1800) * 1000, issuedAt: (NOW_S - 1800 - HOUR_S) * 1000 });
            assert.equal(identityVerdict(res), "verified");
        });

        test("6 dias depois do exp -> ok (verified)", async () => {
            const res = await verify(await expiredFor(6 * DAY_S));
            assert.equal(res.ok, true);
            assert.equal(identityVerdict(res), "verified");
        });

        test("8 dias depois do exp -> expired (unverified)", async () => {
            const old = await expiredFor(8 * DAY_S);
            await expectFailure(old, "expired");
            assert.equal(identityVerdict(await verify(old)), "unverified");
        });

        test("limite: 7 dias + tolerancia de relogio", async () => {
            const skewS = CLOCK_SKEW_MS / 1000;
            assert.equal((await verify(await expiredFor(7 * DAY_S + skewS - 1))).ok, true);
            await expectFailure(await expiredFor(7 * DAY_S + skewS), "expired");
        });

        test("copiado e 2 dias depois do exp -> fingerprint-mismatch (invalid), nao so vencido", async () => {
            const res = await verify(await expiredFor(2 * DAY_S), { remoteDtlsFingerprint: FP_B });
            assert.deepEqual(res, { ok: false, reason: "fingerprint-mismatch" });
            assert.equal(identityVerdict(res), "invalid");
        });

        test("assinatura errada e depois do exp -> bad-signature (invalid)", async () => {
            const forged = await token({ exp: NOW_S - 2 * DAY_S, iat: NOW_S - 2 * DAY_S - HOUR_S }, { alg: "RS256", kid: "k1" }, K2.privateKey);
            const res = await verify(forged);
            assert.deepEqual(res, { ok: false, reason: "bad-signature" });
            assert.equal(identityVerdict(res), "invalid");
        });

        test("na carencia, outra pessoa ou outra conta continuam falhando", async () => {
            await expectFailure(await expiredFor(2 * DAY_S, { sub: OTHER_USER }), "wrong-subject");
            await expectFailure(await expiredFor(2 * DAY_S, { aud: "222222222222222222" }), "wrong-audience");
            await expectFailure(await expiredFor(2 * DAY_S, { iss: "https://evil.example" }), "wrong-issuer");
        });
    });

    test("iat/nbf no futuro alem da tolerancia -> not-yet-valid", async () => {
        await expectFailure(await token({ iat: NOW_S + 3600 }), "not-yet-valid");
        await expectFailure(await token({ nbf: NOW_S + 3600 }), "not-yet-valid");
        assert.equal((await verify(await token({ iat: NOW_S + 60 }))).ok, true);
    });

    test("aud errado / iss errado", async () => {
        await expectFailure(await token({ aud: "222222222222222222" }), "wrong-audience");
        await expectFailure(await token({ aud: [CLIENT_ID, "222222222222222222"] }), "wrong-audience");
        assert.equal((await verify(await token({ aud: [CLIENT_ID, "222222222222222222"], azp: CLIENT_ID }))).ok, true);
        assert.equal((await verify(await token({ aud: [CLIENT_ID] }))).ok, true);
        await expectFailure(await token({ iss: "https://evil.example" }), "wrong-issuer");
    });

    test("payload adulterado -> bad-signature", async () => {
        const [h, , s] = (await token()).split(".");
        const forged = `${h}.${segment(await claims({ sub: OTHER_USER }))}.${s}`;
        await expectFailure(forged, "bad-signature", { claimedUserId: OTHER_USER });
    });

    test("assinado por outra chave com o mesmo kid -> bad-signature", async () => {
        await expectFailure(await token({}, { alg: "RS256", kid: "k1" }, K2.privateKey), "bad-signature");
    });

    test("kid desconhecido -> unknown-key (unverified, buscar JWKS de novo)", async () => {
        const res = await verify(await token({}, { alg: "RS256", kid: "k2" }, K2.privateKey));
        assert.deepEqual(res, { ok: false, reason: "unknown-key" });
        assert.equal(identityVerdict(res), "unverified");
        assert.equal((await verify(await token({}, { alg: "RS256", kid: "k2" }, K2.privateKey), { jwks: { keys: [K1.jwk, K2.jwk] } })).ok, true);
    });

    test("sem kid: tenta as chaves RSA do JWKS", async () => {
        assert.equal((await verify(await token({}, { alg: "RS256" }, K2.privateKey), { jwks: { keys: [K1.jwk, K2.jwk] } })).ok, true);
    });

    test("alg none / HS256 / crit -> unsupported-alg", async () => {
        const payload = segment(await claims());
        await expectFailure(`${segment({ alg: "none" })}.${payload}.AAAA`, "unsupported-alg");
        await expectFailure(`${segment({ alg: "HS256", kid: "k1" })}.${payload}.AAAA`, "unsupported-alg");
        await expectFailure(await token({}, { alg: "RS256", kid: "k1", crit: ["x"] }), "unsupported-alg");
    });

    test("entradas ruins", async () => {
        await expectFailure(undefined, "missing");
        await expectFailure(42, "missing");
        await expectFailure("", "missing");
        await expectFailure("a.b", "malformed");
        await expectFailure("x".repeat(9000), "malformed");
        await expectFailure(`${segment({ alg: "RS256" })}.not+base64.AAAA`, "malformed");
        await expectFailure(await token({ exp: "amanha" }), "malformed");
        await expectFailure(await token(), "no-fingerprint", { remoteDtlsFingerprint: null });
        await expectFailure(await token(), "no-fingerprint", { remoteDtlsFingerprint: "sha-1 " + "ab".repeat(20) });
    });

    test("client id placeholder -> not-configured (recurso desligado)", async () => {
        const res = await verify(await token(), { clientId: "" });
        assert.deepEqual(res, { ok: false, reason: "not-configured" });
        assert.equal(identityVerdict(res), "unverified");
        assert.equal(isIdentityConfigured(""), false);
        assert.equal(isIdentityConfigured(CLIENT_ID), true);
    });

    test("JWKS com chave RSA curta (<2048 bits) e ignorada", async () => {
        const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
        const exported = publicKey.export({ format: "jwk" }) as { n: string; e: string; };
        const weak: Jwk = { kty: "RSA", kid: "weak", n: exported.n, e: exported.e };
        await expectFailure(await token({}, { alg: "RS256", kid: "weak" }, privateKey), "unknown-key", { jwks: { keys: [weak] } });
    });
});

describe("fingerprint e nonce", () => {
    test("normalizacao", () => {
        assert.equal(normalizeFingerprint("SHA-256", Array(32).fill("AB").join(":")), FP_A);
        assert.equal(normalizeFingerprint("sha-1", "ab".repeat(20)), null);
        assert.equal(normalizeFingerprint("sha-256", "ab".repeat(31)), null);
        assert.equal(asNormalizedFingerprint(FP_A), FP_A);
        assert.equal(asNormalizedFingerprint("lixo"), null);
    });

    test("nonce e deterministico e muda com o certificado", async () => {
        const a = await nonceForFingerprint(FP_A);
        assert.equal(a, await nonceForFingerprint("sha-256 " + Array(32).fill("AB").join(":")));
        assert.notEqual(a, await nonceForFingerprint(FP_B));
        assert.match(a, /^[A-Za-z0-9_-]{43}$/);
        await assert.rejects(nonceForFingerprint("lixo"));
    });

    test("SDP: um fingerprint repetido em varias m-sections; conflito -> null", () => {
        const fp = Array(32).fill("AB").join(":");
        const sdp = `v=0\r\na=fingerprint:sha-256 ${fp}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${fp}\r\n`;
        assert.deepEqual(parseSdpFingerprints(sdp), [FP_A]);
        assert.equal(singleSdpFingerprint(sdp), FP_A);
        assert.equal(singleSdpFingerprint(sdp + `a=fingerprint:sha-256 ${Array(32).fill("CD").join(":")}\r\n`), null);
        assert.equal(singleSdpFingerprint(`a=fingerprint:sha-1 ${Array(20).fill("AB").join(":")}`), null);
        assert.equal(singleSdpFingerprint(""), null);
    });
});

describe("getRemoteDtlsFingerprint (RTCPeerConnection falsa)", () => {
    const der = randomBytes(300);
    const hex = createHash("sha256").update(der).digest("hex");
    const expected = `sha-256:${hex}`;
    const colon = hex.toUpperCase().match(/../g)!.join(":");

    function fakePc(opts: { state?: string; withCert?: boolean; statsFp?: string; sdpFp?: string; }) {
        const transport = {
            state: opts.state ?? "connected",
            getRemoteCertificates: opts.withCert ? () => [der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)] : undefined
        };
        const report = new Map<string, Record<string, unknown>>();
        if (opts.statsFp) {
            report.set("T1", { type: "transport", id: "T1", remoteCertificateId: "C1" });
            report.set("C1", { type: "certificate", id: "C1", fingerprintAlgorithm: "sha-256", fingerprint: opts.statsFp });
        }
        const sdp = opts.sdpFp ? `v=0\r\na=fingerprint:sha-256 ${opts.sdpFp}\r\n` : undefined;
        return {
            sctp: { transport },
            getTransceivers: () => [],
            getStats: async () => report,
            currentRemoteDescription: sdp ? { type: "answer", sdp } : null,
            remoteDescription: null
        } as unknown as RTCPeerConnection;
    }

    test("todas as fontes concordam", async () => {
        const res = await getRemoteDtlsFingerprint(fakePc({ withCert: true, statsFp: colon, sdpFp: colon }));
        assert.deepEqual(res, { fingerprint: expected, sources: ["certificate", "stats", "sdp"] });
    });

    test("so SDP (com DTLS conectado) ainda serve", async () => {
        assert.equal((await getRemoteDtlsFingerprint(fakePc({ sdpFp: colon }))).fingerprint, expected);
    });

    test("DTLS ainda nao conectado -> null", async () => {
        assert.deepEqual(await getRemoteDtlsFingerprint(fakePc({ state: "connecting", withCert: true })), { fingerprint: null, reason: "dtls-not-connected" });
    });

    test("certificado real diferente do SDP -> mismatch", async () => {
        const other = Array(32).fill("CD").join(":");
        assert.deepEqual(await getRemoteDtlsFingerprint(fakePc({ withCert: true, sdpFp: other })), { fingerprint: null, reason: "mismatch" });
    });
});

describe("OAuth2 / PKCE", () => {
    test("PKCE S256: vetor do Apendice B da RFC 7636", async () => {
        assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });

    const redirectUri = "http://127.0.0.1/telinha/callback";

    test("location do modal", () => {
        assert.deepEqual(parseAuthorizeLocation(`${redirectUri}?code=abc&state=S1&iss=https%3A%2F%2Fdiscord.com`, { state: "S1", redirectUri }), { ok: true, code: "abc" });
        assert.equal(parseAuthorizeLocation(`${redirectUri}?code=abc&state=S2`, { state: "S1", redirectUri }).ok, false);
        assert.equal(parseAuthorizeLocation(`${redirectUri}?code=abc&state=S1&iss=https%3A%2F%2Fevil.example`, { state: "S1", redirectUri }).ok, false);
        assert.equal(parseAuthorizeLocation("https://evil.example/telinha/callback?code=abc&state=S1", { state: "S1", redirectUri }).ok, false);
        assert.deepEqual(parseAuthorizeLocation(`${redirectUri}?error=access_denied&state=S1`, { state: "S1", redirectUri }), { ok: false, error: "access_denied" });
        assert.equal(parseAuthorizeLocation(undefined, { state: "S1", redirectUri }).ok, false);
    });

    test("troca do code: cliente publico, sem client_secret, sem cookies", async () => {
        let seen: { url: string; init: RequestInit; } | null = null;
        const fetchImpl = async (url: string, init: RequestInit) => {
            seen = { url, init };
            return { ok: true, status: 200, json: async () => ({ access_token: "at", token_type: "Bearer", expires_in: 604800, scope: "openid", id_token: "x.y.z" }) };
        };
        const body = buildCodeExchangeBody({ clientId: CLIENT_ID, code: "C", codeVerifier: "V", redirectUri });
        const res = await requestToken(body, fetchImpl, "https://discord.com/api/oauth2/token");
        assert.equal(res.id_token, "x.y.z");
        assert.ok(seen);
        const { url, init } = seen as { url: string; init: RequestInit; };
        assert.equal(url, "https://discord.com/api/oauth2/token");
        assert.equal(init.method, "POST");
        assert.equal(init.credentials, "omit");
        const sent = new URLSearchParams(String(init.body));
        assert.equal(sent.get("grant_type"), "authorization_code");
        assert.equal(sent.get("code_verifier"), "V");
        assert.equal(sent.get("client_id"), CLIENT_ID);
        assert.equal(sent.has("client_secret"), false);
        assert.equal(buildRefreshBody({ clientId: CLIENT_ID, refreshToken: "R" }).get("grant_type"), "refresh_token");
    });

    test("erro do token endpoint vira OAuthError", async () => {
        const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
        await assert.rejects(requestToken(new URLSearchParams(), fetchImpl), (e: unknown) => e instanceof OAuthError && e.code === "invalid_grant");
    });
});

describe("JwksCache", () => {
    function setup(opts: { fail?: () => boolean; } = {}) {
        let clock = NOW;
        let calls = 0;
        const fetchImpl = async () => {
            calls++;
            if (opts.fail?.()) throw new Error("offline");
            return { ok: true, status: 200, json: async () => JWKS };
        };
        const cache = new JwksCache({ fetchImpl, now: () => clock, ttlMs: 3_600_000, minRefetchMs: 60_000, maxStaleMs: 86_400_000 });
        return { cache, advance: (ms: number) => { clock += ms; }, calls: () => calls };
    }

    test("busca uma vez e reaproveita dentro do ttl", async () => {
        const s = setup();
        await s.cache.get();
        await s.cache.get();
        assert.equal(s.calls(), 1);
        s.advance(3_600_001);
        await s.cache.get();
        assert.equal(s.calls(), 2);
    });

    test("refresh (kid desconhecido) respeita o intervalo minimo", async () => {
        const s = setup();
        await s.cache.get();
        assert.equal(await s.cache.refresh(), null);
        s.advance(60_001);
        assert.deepEqual(await s.cache.refresh(), JWKS);
        assert.equal(s.calls(), 2);
    });

    test("sem rede: usa o JWKS antigo ate maxStale, depois falha", async () => {
        let offline = false;
        const s = setup({ fail: () => offline });
        await s.cache.get();
        offline = true;
        s.advance(2 * 3_600_000);
        assert.deepEqual(await s.cache.get(), JWKS);
        s.advance(86_400_000);
        await assert.rejects(s.cache.get());
    });
});

describe("encoding e politicas", () => {
    test("base64url estrito", () => {
        const bytes = new Uint8Array([0, 255, 62, 63, 1]);
        assert.deepEqual(base64UrlDecode(base64UrlEncode(bytes)), bytes);
        assert.equal(base64UrlDecode("ab+c"), null);
        assert.equal(base64UrlDecode("abcde"), null);
    });

    test("rotacao do certificado", () => {
        const day = 86_400_000;
        assert.equal(certificateNeedsRotation(NOW + 30 * day, NOW), false);
        assert.equal(certificateNeedsRotation(NOW + 13 * day, NOW), true);
    });

    test("fim da aceitacao do token: exp + 7 dias", () => {
        assert.equal(tokenAcceptedUntil(NOW), NOW + 7 * 86_400_000);
    });

    test("renovacao do token: velho (>24 h desde a emissao) ou perto do fim da carencia", () => {
        const hour = 3_600_000;
        const day = 24 * hour;
        // emitido agora, valido por 1 h: nao precisa
        assert.equal(tokenNeedsRenewal(NOW, NOW + hour, NOW), false);
        // ja passou do exp (1 h depois) mas esta na carencia e foi emitido ha 2 h: nao precisa
        assert.equal(tokenNeedsRenewal(NOW - 2 * hour, NOW - hour, NOW), false);
        // 23 h de idade: ainda nao; 25 h: sim
        assert.equal(tokenNeedsRenewal(NOW - 23 * hour, NOW - 22 * hour, NOW), false);
        assert.equal(tokenNeedsRenewal(NOW - 25 * hour, NOW - 24 * hour, NOW), true);
        // a clausula do fim da carencia sozinha (token recente, mas com a carencia acabando em menos de 1 dia)
        assert.equal(tokenNeedsRenewal(NOW, NOW - 5 * day, NOW), false);
        assert.equal(tokenNeedsRenewal(NOW, NOW - 6.5 * day, NOW), true);
        // dados ilegiveis: renova
        assert.equal(tokenNeedsRenewal(NaN, NOW + hour, NOW), true);
        assert.equal(tokenNeedsRenewal(NOW, NaN, NOW), true);
        assert.equal(tokenNeedsRenewal(0, NOW + hour, NOW), true);
    });
});

// #region integracao com a sessao: admissao, aprovacao, duplicados e protocolo (partes puras)

const IDENTITIES: PeerIdentity[] = ["pending", "verified", "unverified", "invalid"];
const BOOLS = [false, true];

/** As regras da v0.1.0, escritas de novo aqui de proposito (nao importar de policy.ts). */
const v010 = {
    admitted: (inVoice: boolean, rejectOutsiders: boolean) => inVoice || !rejectOutsiders,
    needsApproval: (approveViewers: boolean) => approveViewers,
    /** todas as conexoes vivas com o mesmo id ficam marcadas */
    duplicates(peers: DuplicateCandidate[]) {
        const live = peers.filter(p => p.live);
        return live.filter(p => live.filter(q => q.discordUserId === p.discordUserId).length > 1).map(p => p.peerId).sort();
    }
};

const flaggedOf = (peers: DuplicateCandidate[], configured: boolean) => findDuplicates(peers, configured).flatMap(g => g.flagged).sort();
const cand = (peerId: string, identity: PeerIdentity, discordUserId = USER, live = true): DuplicateCandidate => ({ peerId, discordUserId, identity, live });

describe("sem Client ID = comportamento da v0.1.0 (configured: false, nao pela constante)", () => {
    test("o recurso so liga com um client id de verdade", () => {
        assert.equal(isIdentityConfigured(""), false);
        assert.equal(isIdentityConfigured("abc"), false);
        assert.equal(isIdentityConfigured(CLIENT_ID), true);
    });

    test("hello sem token e byte a byte o hello da v0.1.0", () => {
        const v010Hello = JSON.stringify({ type: HELLO_TYPE, v: PROTOCOL_VERSION, discordUserId: USER, username: "ana" });
        assert.equal(JSON.stringify(buildHello(USER, "ana", null)), v010Hello);
        assert.equal(JSON.stringify(buildHello(USER, "ana", undefined)), v010Hello);
        assert.equal(JSON.stringify(buildHello(USER, "ana", "")), v010Hello);
    });

    test("ninguem e verificado nem falso: qualquer token vira not-configured / unverified", async () => {
        for (const t of [await token(), await token({ sub: OTHER_USER }), "lixo", undefined]) {
            const res = await verify(t, { clientId: "", remoteDtlsFingerprint: FP_B });
            assert.deepEqual(res, { ok: false, reason: "not-configured" });
            assert.equal(identityVerdict(res), "unverified");
        }
        assert.equal(initialPeerIdentity({ configured: false, hasToken: true }), "unverified");
    });

    test("admissao e aprovacao ignoram a identidade (todas as combinacoes)", () => {
        for (const identity of IDENTITIES) for (const inVoice of BOOLS) for (const rejectOutsiders of BOOLS) {
            assert.equal(isAdmitted({ configured: false, identity, inVoice, rejectOutsiders }), v010.admitted(inVoice, rejectOutsiders), `${identity} ${inVoice} ${rejectOutsiders}`);
            for (const requireVerified of BOOLS) for (const approveViewers of BOOLS) {
                assert.equal(watchNeedsApproval({ configured: false, identity, requireVerified, approveViewers }), v010.needsApproval(approveViewers));
                assert.equal(identityRequiresApproval({ configured: false, identity, requireVerified }), false);
            }
        }
    });

    test("duplicados: todas as conexoes vivas com o mesmo id, mesmo as que se dizem verificadas", () => {
        const scenarios: DuplicateCandidate[][] = [
            [cand("a", "unverified"), cand("b", "unverified")],
            [cand("a", "verified"), cand("b", "unverified")],
            [cand("a", "verified"), cand("b", "verified"), cand("c", "unverified", OTHER_USER)],
            [cand("a", "unverified"), cand("b", "unverified", USER, false)],
            [cand("a", "invalid"), cand("b", "pending"), cand("c", "unverified")]
        ];
        for (const peers of scenarios) {
            assert.deepEqual(flaggedOf(peers, false), v010.duplicates(peers));
            assert.ok(findDuplicates(peers, false).every(g => g.verified.length === 0));
        }
    });
});

describe("admissao com Client ID", () => {
    const admit = (identity: PeerIdentity, inVoice = true, rejectOutsiders = true) => isAdmitted({ configured: true, identity, inVoice, rejectOutsiders });
    const approval = (identity: PeerIdentity, requireVerified: boolean, approveViewers = false) =>
        watchNeedsApproval({ configured: true, identity, requireVerified, approveViewers });

    test("verificado: admitido pelo canal de voz, assiste sem aprovacao (a nao ser com approveViewers)", () => {
        assert.equal(admit("verified"), true);
        assert.equal(admit("verified", false, true), false);
        assert.equal(admit("verified", false, false), true);
        assert.equal(approval("verified", true), false);
        assert.equal(approval("verified", true, true), true);
    });

    test("nao verificado com a opcao LIGADA: ve a presenca, mas so assiste com Permitir (mesmo sem approveViewers)", () => {
        assert.equal(admit("unverified"), true);
        assert.equal(approval("unverified", true), true);
        assert.equal(identityRequiresApproval({ configured: true, identity: "unverified", requireVerified: true }), true);
        // fora do canal de voz continua de fora (rejectOutsiders)
        assert.equal(admit("unverified", false, true), false);
    });

    test("nao verificado com a opcao DESLIGADA: como na v0.1.0", () => {
        for (const inVoice of BOOLS) for (const rejectOutsiders of BOOLS) {
            assert.equal(admit("unverified", inVoice, rejectOutsiders), v010.admitted(inVoice, rejectOutsiders));
        }
        assert.equal(approval("unverified", false), false);
        assert.equal(approval("unverified", false, true), true);
    });

    test("identidade falsa: nunca admitida, com qualquer opcao", () => {
        for (const inVoice of BOOLS) for (const rejectOutsiders of BOOLS) assert.equal(admit("invalid", inVoice, rejectOutsiders), false);
    });

    test("conferindo: ainda nao admitido; so quem mandou token precisa esperar", () => {
        assert.equal(admit("pending"), false);
        assert.equal(initialPeerIdentity({ configured: true, hasToken: true }), "pending");
        assert.equal(initialPeerIdentity({ configured: true, hasToken: false }), "unverified");
    });

    test("verificado nao e rebaixado por renovacao ruim; falso nao vira confiavel", () => {
        assert.equal(nextPeerIdentity("verified", "unverified"), "verified");
        assert.equal(nextPeerIdentity("verified", "invalid"), "verified");
        assert.equal(nextPeerIdentity("invalid", "verified"), "invalid");
        assert.equal(nextPeerIdentity("pending", "verified"), "verified");
        assert.equal(nextPeerIdentity("pending", "invalid"), "invalid");
        assert.equal(nextPeerIdentity("unverified", "invalid"), "invalid");
        assert.equal(nextPeerIdentity("unverified", "verified"), "verified");
    });

    test("ponta a ponta: token copiado / assinatura falsa / conta errada = falso, nunca admitido", async () => {
        const fakes = [
            await verify(await token(), { remoteDtlsFingerprint: FP_B }), // copiado de outra conexao
            await verify(await token({}, { alg: "RS256", kid: "k1" }, K2.privateKey)), // assinatura falsa
            await verify(await token({ sub: OTHER_USER })) // token de outra pessoa
        ];
        for (const res of fakes) {
            const identity = nextPeerIdentity("pending", identityVerdict(res));
            assert.equal(identity, "invalid");
            for (const inVoice of BOOLS) for (const rejectOutsiders of BOOLS) assert.equal(admit(identity, inVoice, rejectOutsiders), false);
        }
        const good = nextPeerIdentity("pending", identityVerdict(await verify(await token())));
        assert.equal(good, "verified");
        assert.equal(admit(good), true);
        assert.equal(approval(good, true), false);
    });

    test("verificacao que estoura o tempo = nao verificado (nunca falso)", () => {
        assert.equal(identityVerdict({ ok: false, reason: "timeout" }), "unverified");
    });
});

describe("identidade duplicada com Client ID", () => {
    test("verificada + nao verificada: so a nao verificada e marcada (impostora)", () => {
        const groups = findDuplicates([cand("a", "verified"), cand("b", "unverified")], true);
        assert.deepEqual(groups, [{ discordUserId: USER, flagged: ["b"], verified: ["a"] }]);
    });

    test("verificada nunca e marcada; duas verificadas = a mesma pessoa em dois PCs", () => {
        assert.deepEqual(findDuplicates([cand("a", "verified"), cand("b", "verified")], true), []);
        const groups = findDuplicates([cand("a", "verified"), cand("b", "unverified"), cand("c", "unverified"), cand("d", "verified")], true);
        assert.deepEqual(groups, [{ discordUserId: USER, flagged: ["b", "c"], verified: ["a", "d"] }]);
    });

    test("duas nao verificadas: as duas marcadas (como hoje)", () => {
        assert.deepEqual(findDuplicates([cand("a", "unverified"), cand("b", "unverified")], true), [{ discordUserId: USER, flagged: ["a", "b"], verified: [] }]);
    });

    test("falsa e conferindo ficam de fora; conexao que caiu nao conta; ids diferentes nao se misturam", () => {
        assert.deepEqual(findDuplicates([cand("a", "invalid"), cand("b", "unverified")], true), []);
        assert.deepEqual(findDuplicates([cand("a", "invalid"), cand("b", "verified")], true), []);
        assert.deepEqual(findDuplicates([cand("a", "pending"), cand("b", "unverified")], true), []);
        assert.deepEqual(findDuplicates([cand("a", "unverified", USER, false), cand("b", "unverified")], true), []);
        assert.deepEqual(findDuplicates([cand("a", "unverified"), cand("b", "unverified", OTHER_USER)], true), []);
    });
});

describe("protocolo: hello com idToken opcional e acao identity", () => {
    const base = { type: HELLO_TYPE, v: PROTOCOL_VERSION, discordUserId: USER, username: "ana" };

    test("hello da v0.1.0 (sem idToken) continua valido e sem campo extra", () => {
        const parsed = parseHello({ ...base });
        assert.deepEqual(parsed, base);
        assert.equal(parsed && "idToken" in parsed, false);
    });

    test("idToken valido e mantido; o resto do lixo e descartado", () => {
        assert.deepEqual(parseHello({ ...base, idToken: "a.b.c", extra: { x: 1 } }), { ...base, idToken: "a.b.c" });
    });

    test("idToken ruim (tipo errado, vazio, enorme) sai do hello, que continua valido (= nao verificado)", () => {
        for (const idToken of [42, "", null, { a: 1 }, ["x"], "x".repeat(MAX_ID_TOKEN_CHARS + 1)]) {
            assert.deepEqual(parseHello({ ...base, idToken }), base, String(idToken).slice(0, 20));
        }
        assert.equal(MAX_ID_TOKEN_CHARS, MAX_ID_TOKEN_LENGTH);
    });

    test("hello invalido e nulo, sem lancar; nome truncado", () => {
        for (const data of [null, undefined, 42, "hello", [], { ...base, discordUserId: "abc" }, { ...base, type: "outro" }, { ...base, username: 1 }]) {
            assert.equal(parseHello(data), null);
        }
        assert.equal(parseHello({ ...base, username: "n".repeat(500) })?.username.length, 64);
        // versao diferente passa no parse (a sessao confere `v` e marca como incompativel)
        assert.equal(parseHello({ ...base, v: 2 })?.v, 2);
    });

    test("nosso hello com token; mensagem da acao identity", () => {
        assert.deepEqual(buildHello(USER, "ana", "a.b.c"), { ...base, idToken: "a.b.c" });
        assert.equal(isIdentityMessage({ idToken: "a.b.c" }), true);
        for (const data of [null, {}, { idToken: 1 }, { idToken: "" }, { idToken: "x".repeat(MAX_ID_TOKEN_CHARS + 1) }, []]) {
            assert.equal(isIdentityMessage(data), false);
        }
    });
});

// #endregion
