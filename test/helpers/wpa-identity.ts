/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ajudantes da WP-A para a prova de identidade (so testes): chaves RSA, id_token RS256 como o do Discord (nonce
// amarrado a um fingerprint DTLS), um certificado DER falso com o fingerprint dele, o Discord falso na rede (JWKS +
// token endpoint, via installFetch) e um Date.now que o teste adianta sem relogio falso. Adaptado dos construtores de
// core/identity/identity.test.ts.

import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";

import { DISCORD_CLIENT_ID, DISCORD_ISSUER, DISCORD_JWKS_URL, DISCORD_TOKEN_URL } from "@plugins/telinha/core/identity/config";
import { base64UrlEncode, utf8 } from "@plugins/telinha/core/identity/encoding";
import { nonceForFingerprint } from "@plugins/telinha/core/identity/fingerprint";
import type { Jwk, Jwks } from "@plugins/telinha/core/identity/jwt";
import { type FetchCall, installFetch, jsonResponse } from "@test/fakes/fetch";

export interface TestKey {
    kid: string;
    privateKey: KeyObject;
    jwk: Jwk;
}

/** Par RSA com o JWK publico (kid, use sig, alg RS256), como os do JWKS do Discord. */
export function makeRsaKey(kid: string, modulusLength = 2048): TestKey {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
    const exported = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string; };
    return { kid, privateKey, jwk: { kty: exported.kty, n: exported.n, e: exported.e, kid, use: "sig", alg: "RS256" } };
}

const segment = (obj: unknown) => base64UrlEncode(utf8(JSON.stringify(obj)));

export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
    const input = `${segment(header)}.${segment(payload)}`;
    const sig = createSign("RSA-SHA256").update(input).sign(key);
    return `${input}.${base64UrlEncode(sig)}`;
}

export interface IdTokenOptions {
    userId: string;
    /** o certificado DTLS ao qual o token fica amarrado (nonce) */
    fingerprint: string;
    key: TestKey;
    /** emissao/validade em ms (padrao: emitido ha 1 min, vence em 1 h, pelo Date.now atual) */
    iatMs?: number;
    expMs?: number;
    /** claims extras ou trocadas (ex.: { nonce: undefined } tira o nonce) */
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
}

/** id_token do Discord (RS256, iss/aud/sub/iat/exp/nonce) assinado com a chave de teste. */
export async function makeIdToken(o: IdTokenOptions): Promise<string> {
    const now = Date.now();
    const payload: Record<string, unknown> = {
        iss: DISCORD_ISSUER,
        aud: DISCORD_CLIENT_ID,
        sub: o.userId,
        iat: Math.floor((o.iatMs ?? now - 60_000) / 1000),
        exp: Math.floor((o.expMs ?? now + 3_600_000) / 1000),
        nonce: await nonceForFingerprint(o.fingerprint),
        ...o.claims
    };
    return signJwt({ alg: "RS256", kid: o.key.kid, typ: "JWT", ...o.header }, payload, o.key.privateKey);
}

/** Um "certificado" DER qualquer (getRemoteCertificates so faz o hash dele) e o fingerprint normalizado. */
export function fakeDer(): { der: ArrayBuffer; fingerprint: string; } {
    const bytes = randomBytes(300);
    const der = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { der, fingerprint: "sha-256:" + createHash("sha256").update(bytes).digest("hex") };
}

/** "sha-256:abcd..." no formato do SDP / getStats: "AB:CD:...". */
export function colonHex(fingerprint: string): string {
    return fingerprint.replace(/^sha-256:/, "").toUpperCase().match(/../g)!.join(":");
}

export function tokenResponse(fields: Record<string, unknown> = {}, init: ResponseInit = {}): Response {
    return jsonResponse({ access_token: "at-descartado", token_type: "Bearer", expires_in: 604800, scope: "openid", ...fields }, init);
}

export interface FakeDiscord {
    /** o JWKS que o endpoint devolve agora */
    jwks: Jwks;
    /** troca a resposta do JWKS (ex.: erro, pendurado) */
    jwksImpl: (() => Response | Promise<Response>) | null;
    /** resposta do token endpoint (padrao: 400 invalid_grant) */
    tokenImpl: ((body: URLSearchParams) => Response | Promise<Response>) | null;
    readonly tokenRequests: URLSearchParams[];
    readonly jwksRequests: FetchCall[];
    readonly calls: FetchCall[];
    restore(): void;
}

/** O Discord na rede: JWKS em DISCORD_JWKS_URL e o token endpoint em DISCORD_TOKEN_URL; o resto continua bloqueado. */
export function installFakeDiscord(jwks: Jwks): FakeDiscord {
    const tokenRequests: URLSearchParams[] = [];
    const jwksRequests: FetchCall[] = [];
    const env: FakeDiscord = {
        jwks,
        jwksImpl: null,
        tokenImpl: null,
        tokenRequests,
        jwksRequests,
        calls: [],
        restore: () => { }
    };
    const net = installFetch((url, init) => {
        if (url === DISCORD_JWKS_URL) {
            jwksRequests.push({ url, ...(init ? { init } : {}) });
            return env.jwksImpl ? env.jwksImpl() : jsonResponse(env.jwks);
        }
        if (url === DISCORD_TOKEN_URL) {
            const body = new URLSearchParams(String(init?.body ?? ""));
            tokenRequests.push(body);
            return env.tokenImpl ? env.tokenImpl(body) : jsonResponse({ error: "invalid_grant" }, { status: 400 });
        }
        return undefined;
    });
    Object.defineProperty(env, "calls", { get: () => net.calls });
    env.restore = net.restore;
    return env;
}

export interface ShiftableNow {
    /** adianta o Date.now em `ms` */
    advance(ms: number): void;
    readonly offset: number;
    restore(): void;
}

/**
 * Date.now = relogio real + deslocamento que o teste controla (sem timers falsos). Instale ANTES do primeiro uso do cache
 * de JWKS do core/identity/index.ts: ele guarda a funcao Date.now do momento em que e criado.
 */
export function shiftableNow(): ShiftableNow {
    const real = Date.now;
    let offset = 0;
    Date.now = () => real() + offset;
    return {
        advance(ms) {
            offset += ms;
        },
        get offset() {
            return offset;
        },
        restore() {
            Date.now = real;
        }
    };
}
