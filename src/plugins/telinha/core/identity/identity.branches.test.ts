/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Os caminhos de erro das partes PURAS da prova de identidade que identity.test.ts nao percorre: base64url/UTF-8
// invalidos, JWT e JWKS malformados, cache do JWKS (persistido, sem rede, concorrencia), fontes do fingerprint DTLS
// (transceivers, estatisticas quebradas, SDP ambiguo), location do modal e respostas ruins do token endpoint.
// Rodar:  pnpm test:file src/plugins/telinha/core/identity/identity.branches.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { installFetch, jsonResponse } from "@test/fakes/fetch";
import { colonHex, fakeDer, makeIdToken, makeRsaKey, type TestKey } from "@test/helpers/wpa-identity";

import { DISCORD_CLIENT_ID, DISCORD_JWKS_URL, DISCORD_TOKEN_URL, isSnowflake } from "./config";
import { base64UrlDecode, base64UrlEncode, randomUrlSafe, sha256, toHex, utf8, utf8Decode } from "./encoding";
import { normalizeFingerprint } from "./fingerprint";
import { JwksCache, type StoredJwks } from "./jwks";
import { decodeJwt, isJwks, type Jwk, type Jwks, selectRsaKeys, verifyRs256 } from "./jwt";
import { buildRefreshBody, createPkcePair, OAuthError, parseAuthorizeLocation, pkceChallenge, requestToken } from "./oauth";
import { getRemoteDtlsFingerprint, localCertificateFingerprint } from "./remoteFingerprint";
import { identityVerdict, verifyPeerIdentity } from "./verify";

const seg = (value: unknown) => base64UrlEncode(utf8(typeof value === "string" ? value : JSON.stringify(value)));
const USER = "987654321098765432";

let K1: TestKey;

before(() => {
    K1 = makeRsaKey("k1");
});

describe("encoding", () => {
    test("UTF-8 estrito: bytes invalidos = null", () => {
        assert.equal(utf8Decode(new Uint8Array([0xff, 0xfe, 0xfd])), null);
        assert.equal(utf8Decode(utf8("ação")), "ação");
    });

    test("base64url: ArrayBuffer ou bytes; entrada que nao e texto, com tamanho impossivel ou fora do alfabeto = null", () => {
        assert.equal(base64UrlEncode(new Uint8Array([251, 255]).buffer), "-_8");
        assert.equal(base64UrlDecode(42 as unknown as string), null);
        assert.equal(base64UrlDecode("abcde"), null);
        assert.equal(base64UrlDecode("ab/c"), null);
        assert.deepEqual(base64UrlDecode(""), new Uint8Array(0));
    });

    test("hex, SHA-256 e aleatorio url-safe", async () => {
        assert.equal(toHex(new Uint8Array([0, 15, 255]).buffer), "000fff");
        assert.equal(toHex(await sha256(utf8("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert.match(randomUrlSafe(), /^[A-Za-z0-9_-]{43}$/);
        assert.match(randomUrlSafe(16), /^[A-Za-z0-9_-]{22}$/);
        assert.notEqual(randomUrlSafe(), randomUrlSafe());
    });
});

describe("JWT e JWKS", () => {
    test("decodeJwt: nada que nao seja um JWS compacto com JSON de objeto", () => {
        const ok = `${seg({ alg: "RS256" })}.${seg({ sub: "1" })}.${seg("sig")}`;
        assert.ok(decodeJwt(ok));
        assert.equal(decodeJwt(42 as unknown as string), null);
        assert.equal(decodeJwt(`${seg({ alg: "RS256" })}..${seg("sig")}`), null, "parte vazia");
        assert.equal(decodeJwt(`${seg([1, 2])}.${seg({})}.${seg("sig")}`), null, "header que e lista");
        assert.equal(decodeJwt(`${seg("{nao e json")}.${seg({})}.${seg("sig")}`), null, "JSON quebrado");
        assert.equal(decodeJwt(`${base64UrlEncode(new Uint8Array([0xff, 0xfe]))}.${seg({})}.${seg("sig")}`), null, "UTF-8 invalido");
        assert.equal(decodeJwt(`${seg({})}.${seg({})}.a+b`), null, "assinatura fora do base64url");
    });

    test("isJwks: objeto com lista de chaves com kty", () => {
        assert.equal(isJwks({ keys: [{ kty: "RSA" }] }), true);
        for (const bad of [null, [], { keys: {} }, { keys: [{}] }, { keys: [null] }, { keys: [{ kty: 1 }] }]) assert.equal(isJwks(bad), false);
    });

    test("selectRsaKeys: so RSA de assinatura RS256 com modulo >= 2048 bits; filtra por kid; no maximo 16 chaves", () => {
        const good = K1.jwk;
        assert.deepEqual(selectRsaKeys({ keys: [good] }, "k1"), [good]);
        assert.deepEqual(selectRsaKeys({ keys: [good] }, 42), [good], "kid que nao e texto nao filtra");
        assert.deepEqual(selectRsaKeys({ keys: [good] }, "outro"), []);
        assert.deepEqual(selectRsaKeys("lixo" as unknown as Jwks, "k1"), []);
        const bad: Jwk[] = [
            { ...good, kty: "EC" }, { ...good, use: "enc" }, { ...good, alg: "RS512" }, { ...good, n: undefined }, { ...good, e: undefined },
            { ...good, n: "AQAB" }, { ...good, n: "a+b" }
        ];
        assert.deepEqual(selectRsaKeys({ keys: bad }, undefined), []);
        const { use: _use, alg: _alg, ...bare } = good;
        assert.deepEqual(selectRsaKeys({ keys: [bare] }, "k1"), [bare], "sem use/alg: aceita");
        const many = Array.from({ length: 16 }, (_, i) => ({ ...good, kid: `x${i}` }));
        assert.deepEqual(selectRsaKeys({ keys: [...many, good] }, "k1"), [], "a 17a chave nem e olhada");
    });

    test("verifyRs256: chave que nao importa = false (nunca lanca); o cache de chaves se esvazia em vez de crescer", async () => {
        const jwt = decodeJwt(`${seg({ alg: "RS256" })}.${seg({})}.${seg("sig")}`)!;
        const results = await Promise.all(Array.from({ length: 20 }, (_, i) => verifyRs256(jwt, { kty: "RSA", n: `AA${i}`, e: "AQAB" })));
        assert.deepEqual(new Set(results), new Set([false]));
        // JWK sem modulo: o importKey rejeita
        assert.equal(await verifyRs256(jwt, { kty: "RSA" }), false);
    });
});

describe("JwksCache", () => {
    const JWKS: Jwks = { keys: [{ kty: "RSA", kid: "a", n: "x", e: "AQAB" }] };
    const OTHER: Jwks = { keys: [{ kty: "RSA", kid: "b", n: "y", e: "AQAB" }] };

    function fetcher(answers: (() => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; }>)[]) {
        let i = 0;
        const calls: RequestInit[] = [];
        const impl = async (_url: string, init: RequestInit) => {
            calls.push(init);
            const answer = answers[Math.min(i++, answers.length - 1)];
            return answer();
        };
        return { impl, calls };
    }
    const okJson = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

    test("padroes: fetch global na URL do Discord, sem cookies; JWKS persistido valido e usado sem rede", async () => {
        const net = installFetch(url => (url === DISCORD_JWKS_URL ? jsonResponse(JWKS) : undefined));
        try {
            const cache = new JwksCache();
            assert.deepEqual(await cache.get(), JWKS);
            assert.equal(net.calls.length, 1);
            assert.equal(net.calls[0].init?.credentials, "omit");

            const persisted = new JwksCache({ load: async () => ({ jwks: OTHER, fetchedAt: Date.now() }) });
            assert.deepEqual(await persisted.get(), OTHER);
            assert.equal(net.calls.length, 1, "o persistido ainda esta no ttl: nada de rede");
        } finally {
            net.restore();
        }
    });

    test("persistido invalido, sem data ou que lanca: ignorado (busca na rede)", async () => {
        for (const load of [
            async () => ({ jwks: { keys: "x" }, fetchedAt: Date.now() }) as unknown as StoredJwks,
            async () => ({ jwks: JWKS, fetchedAt: Number.NaN }),
            async () => {
                throw new Error("IndexedDB travado");
            }
        ]) {
            const f = fetcher([okJson(OTHER)]);
            const cache = new JwksCache({ fetchImpl: f.impl, load });
            assert.deepEqual(await cache.get(), OTHER);
            assert.equal(f.calls.length, 1);
        }
    });

    test("leitura do persistido lenta: o que a rede trouxe nesse meio tempo vale mais", async () => {
        let release!: (v: StoredJwks) => void;
        const f = fetcher([okJson(OTHER)]);
        const cache = new JwksCache({ fetchImpl: f.impl, load: () => new Promise(r => { release = r; }) });
        const first = cache.get();
        assert.deepEqual(await cache.get(), OTHER, "a segunda chamada nao espera a leitura");
        release({ jwks: JWKS, fetchedAt: Date.now() });
        assert.deepEqual(await first, OTHER);
    });

    test("duas chamadas juntas: uma busca so; gravar falhando nao atrapalha", async () => {
        const f = fetcher([okJson(JWKS)]);
        const saved: StoredJwks[] = [];
        const cache = new JwksCache({
            fetchImpl: f.impl,
            save: async v => {
                saved.push(v);
                throw new Error("cheio");
            }
        });
        const [a, b] = await Promise.all([cache.get(), cache.get()]);
        assert.deepEqual([a, b], [JWKS, JWKS]);
        assert.equal(f.calls.length, 1);
        assert.equal(saved.length, 1);
    });

    test("HTTP de erro ou JSON que nao e JWKS: sem JWKS anterior, get lanca; refresh devolve null", async () => {
        const http = new JwksCache({ fetchImpl: fetcher([async () => ({ ok: false, status: 503, json: async () => ({}) })]).impl });
        await assert.rejects(http.get(), /JWKS HTTP 503/);
        const invalid = new JwksCache({ fetchImpl: fetcher([okJson({ chaves: [] })]).impl, minRefetchMs: 0 });
        await assert.rejects(invalid.get(), /JWKS inválido/);
        assert.equal(await invalid.refresh(), null);
    });

    test("sem rede: usa o antigo ate maxStale; refresh so depois do intervalo minimo", async () => {
        let now = 1_000_000;
        let offline = false;
        const f = fetcher([async () => {
            if (offline) throw new TypeError("offline");
            return { ok: true, status: 200, json: async () => JWKS };
        }]);
        const cache = new JwksCache({ fetchImpl: f.impl, now: () => now, ttlMs: 100, minRefetchMs: 1000, maxStaleMs: 10_000 });
        await cache.get();
        assert.equal(await cache.refresh(), null, "acabou de buscar");
        now += 1000;
        assert.deepEqual(await cache.refresh(), JWKS);
        offline = true;
        now += 2000;
        assert.equal(await cache.refresh(), null, "refresh sem rede: null");
        assert.deepEqual(await cache.get(), JWKS, "velho, mas dentro do maxStale");
        now += 10_000;
        await assert.rejects(cache.get(), /offline/);
    });
});

describe("fingerprint DTLS do peer: fontes", () => {
    const { der, fingerprint } = fakeDer();
    const transport = (state = "connected", certs: (() => ArrayBuffer[]) | null = () => [der]) => ({ state, getRemoteCertificates: certs ?? undefined });

    function pc(over: Record<string, unknown>) {
        return { sctp: null, getTransceivers: () => [], getStats: async () => new Map(), currentRemoteDescription: null, remoteDescription: null, ...over } as unknown as RTCPeerConnection;
    }

    test("sem data channel: o transporte do receiver ou do sender de um transceiver", async () => {
        const viaReceiver = pc({ getTransceivers: () => [{ receiver: { transport: null }, sender: {} }, { receiver: { transport: transport() }, sender: {} }] });
        assert.deepEqual(await getRemoteDtlsFingerprint(viaReceiver), { fingerprint, sources: ["certificate"] });
        const viaSender = pc({ getTransceivers: () => [{ receiver: null, sender: { transport: transport() } }] });
        assert.equal((await getRemoteDtlsFingerprint(viaSender)).fingerprint, fingerprint);
        assert.deepEqual(await getRemoteDtlsFingerprint(pc({ getTransceivers: undefined })), { fingerprint: null, reason: "dtls-not-connected" });
    });

    test("getRemoteCertificates lancando ou getStats lancando: fica o que sobrar (SDP)", async () => {
        const sdp = `v=0\r\na=fingerprint:sha-256 ${colonHex(fingerprint)}\r\n`;
        const res = await getRemoteDtlsFingerprint(pc({
            sctp: {
                transport: transport("connected", () => {
                    throw new Error("nao suportado");
                })
            },
            getStats: async () => {
                throw new Error("fechada");
            },
            remoteDescription: { type: "offer", sdp }
        }));
        assert.deepEqual(res, { fingerprint, sources: ["sdp"] });
    });

    test("estatisticas: dois certificados diferentes ou um invalido = ambiguo; transporte sem certificado e ignorado", async () => {
        const stats = (entries: Record<string, unknown>[]) => async () => new Map(entries.map(e => [e.id as string, e]));
        const cert = (id: string, fp: string) => ({ id, type: "certificate", fingerprintAlgorithm: "sha-256", fingerprint: fp });
        const two = pc({
            sctp: { transport: transport("connected", null) },
            getStats: stats([
                { id: "T1", type: "transport", remoteCertificateId: "C1" }, { id: "T2", type: "transport", remoteCertificateId: "C2" },
                cert("C1", colonHex(fingerprint)), cert("C2", "AB:".repeat(31) + "AB")
            ])
        });
        assert.deepEqual(await getRemoteDtlsFingerprint(two), { fingerprint: null, reason: "ambiguous" });
        const invalid = pc({ sctp: { transport: transport("connected", null) }, getStats: stats([{ id: "T1", type: "transport", remoteCertificateId: "C9" }]) });
        assert.deepEqual(await getRemoteDtlsFingerprint(invalid), { fingerprint: null, reason: "ambiguous" });
        const ignored = pc({ sctp: { transport: transport("connected", null) }, getStats: stats([{ id: "T1", type: "transport" }, { id: "X", type: "codec" }]) });
        assert.deepEqual(await getRemoteDtlsFingerprint(ignored), { fingerprint: null, reason: "unavailable" });
    });

    test("SDP com dois fingerprints: ambiguo", async () => {
        const sdp = `a=fingerprint:sha-256 ${colonHex(fingerprint)}\r\na=fingerprint:sha-256 ${"CD:".repeat(31)}CD\r\n`;
        const res = await getRemoteDtlsFingerprint(pc({ sctp: { transport: transport() }, currentRemoteDescription: { type: "answer", sdp } }));
        assert.deepEqual(res, { fingerprint: null, reason: "ambiguous" });
    });

    test("fingerprint do certificado local: o primeiro SHA-256; sem SHA-256 lanca", () => {
        const fp = "AB:".repeat(31) + "AB";
        const cert = (list: RTCDtlsFingerprint[]) => ({ getFingerprints: () => list }) as unknown as RTCCertificate;
        assert.equal(localCertificateFingerprint(cert([{ algorithm: "sha-1", value: "AB" }, { algorithm: "sha-256", value: fp }])), "sha-256:" + "ab".repeat(32));
        assert.throws(() => localCertificateFingerprint(cert([{ algorithm: "sha-1", value: "AB" }])), /não tem fingerprint SHA-256/);
        assert.equal(normalizeFingerprint(1, fp), null);
    });
});

describe("OAuth2: location e token endpoint", () => {
    const redirectUri = "http://127.0.0.1/telinha/callback";
    let net: ReturnType<typeof installFetch>;
    let answer: () => Response;

    before(() => {
        net = installFetch(url => (url === DISCORD_TOKEN_URL ? answer() : undefined));
    });

    after(() => net.restore());

    test("location invalido, erro com descricao, sem code", () => {
        assert.deepEqual(parseAuthorizeLocation("nao e url", { state: "S", redirectUri }), { ok: false, error: "location inválido" });
        assert.deepEqual(parseAuthorizeLocation(`${redirectUri}?code=c&state=S`, { state: "S", redirectUri: "relativo" }), { ok: false, error: "location inválido" });
        assert.deepEqual(parseAuthorizeLocation(`${redirectUri}?error=access_denied&error_description=O+usuario+recusou&state=S`, { state: "S", redirectUri }), { ok: false, error: "O usuario recusou" });
        assert.deepEqual(parseAuthorizeLocation(`${redirectUri}?state=S`, { state: "S", redirectUri }), { ok: false, error: "resposta sem code" });
        assert.deepEqual(parseAuthorizeLocation(`${redirectUri}/outro?code=c&state=S`, { state: "S", redirectUri }), { ok: false, error: "redirect_uri inesperado" });
    });

    test("PKCE: verifier de 43 caracteres e o challenge dele", async () => {
        const pair = await createPkcePair();
        assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(pair.challenge, await pkceChallenge(pair.verifier));
    });

    test("fetch e URL padrao (o do Discord); resposta ok", async () => {
        answer = () => jsonResponse({ access_token: "at", token_type: "Bearer", expires_in: 1, scope: "openid", id_token: "a.b.c" });
        const res = await requestToken(buildRefreshBody({ clientId: DISCORD_CLIENT_ID, refreshToken: "r" }));
        assert.equal(res.id_token, "a.b.c");
        assert.equal(net.calls.at(-1)?.url, DISCORD_TOKEN_URL);
        assert.equal(net.calls.at(-1)?.init?.cache, "no-store");
    });

    test("respostas ruins viram OAuthError: erro com descricao, corpo que nao e JSON, JSON nulo, sem access_token", async () => {
        answer = () => jsonResponse({ error: "invalid_grant", error_description: "refresh_token revogado" }, { status: 400 });
        await assert.rejects(requestToken(new URLSearchParams()), (e: unknown) => {
            assert.ok(e instanceof OAuthError);
            assert.equal(e.status, 400);
            assert.equal(e.code, "invalid_grant");
            assert.equal(e.message, "OAuth2 400 invalid_grant: refresh_token revogado");
            assert.equal(e.name, "OAuthError");
            return true;
        });
        answer = () => new Response("<html>erro</html>", { status: 502 });
        await assert.rejects(requestToken(new URLSearchParams()), { code: "http_error", status: 502, message: "OAuth2 502 http_error" });
        answer = () => new Response("null", { status: 200 });
        await assert.rejects(requestToken(new URLSearchParams()), { code: "invalid_response" });
        answer = () => jsonResponse({ token_type: "Bearer" });
        await assert.rejects(requestToken(new URLSearchParams()), { code: "invalid_response" });
    });
});

describe("verifyPeerIdentity: o resto", () => {
    test("aud que nao e texto nem lista = token de outro aplicativo", async () => {
        const { fingerprint } = fakeDer();
        const idToken = await makeIdToken({ userId: USER, fingerprint, key: K1, claims: { aud: 123 } });
        const res = await verifyPeerIdentity({ idToken, claimedUserId: USER, remoteDtlsFingerprint: fingerprint, now: Date.now(), jwks: { keys: [K1.jwk] } });
        assert.deepEqual(res, { ok: false, reason: "wrong-audience" });
        assert.equal(identityVerdict(res), "invalid");
        assert.equal(isSnowflake(123), false);
    });

    test("veredito de cada motivo", () => {
        const unverified = ["not-configured", "missing", "expired", "not-yet-valid", "no-fingerprint", "unknown-key", "timeout"] as const;
        const invalid = ["malformed", "unsupported-alg", "bad-signature", "wrong-issuer", "wrong-audience", "wrong-subject", "fingerprint-mismatch"] as const;
        for (const reason of unverified) assert.equal(identityVerdict({ ok: false, reason }), "unverified", reason);
        for (const reason of invalid) assert.equal(identityVerdict({ ok: false, reason }), "invalid", reason);
    });
});
