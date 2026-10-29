/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// JWT compacto + verificacao RS256 com WebCrypto e um JWKS. PURO (renderer e Node).

import { base64UrlDecode, utf8, utf8Decode } from "./encoding";

export interface Jwk {
    kty: string;
    kid?: string;
    use?: string;
    alg?: string;
    n?: string;
    e?: string;
}

export interface Jwks {
    keys: Jwk[];
}

export interface DecodedJwt {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
    /** bytes ASCII de "header.payload" (o que foi assinado) */
    signingInput: Uint8Array<ArrayBuffer>;
    signature: Uint8Array<ArrayBuffer>;
}

/** Modulo RSA minimo aceito: 2048 bits (a chave atual do Discord tem 4096). */
const MIN_RSA_MODULUS_BYTES = 256;
const MAX_KEYS = 16;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
    const bytes = base64UrlDecode(segment);
    const text = bytes && utf8Decode(bytes);
    if (text == null) return null;
    try {
        const value: unknown = JSON.parse(text);
        return isRecord(value) ? value : null;
    } catch {
        return null;
    }
}

/** Separa e decodifica um JWT compacto (JWS). null se malformado. Nao verifica nada. */
export function decodeJwt(token: string): DecodedJwt | null {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(p => !p)) return null;
    const header = decodeJsonSegment(parts[0]);
    const payload = decodeJsonSegment(parts[1]);
    const signature = base64UrlDecode(parts[2]);
    if (!header || !payload || !signature?.length) return null;
    return { header, payload, signingInput: utf8(`${parts[0]}.${parts[1]}`), signature };
}

export function isJwks(value: unknown): value is Jwks {
    return isRecord(value) && Array.isArray(value.keys) && value.keys.every(k => isRecord(k) && typeof k.kty === "string");
}

/** Chaves RSA de assinatura do JWKS compativeis com RS256 (filtradas por `kid` se o header tiver um). */
export function selectRsaKeys(jwks: Jwks, kid: unknown): Jwk[] {
    if (!isJwks(jwks)) return [];
    return jwks.keys.slice(0, MAX_KEYS).filter(k =>
        k.kty === "RSA"
        && (k.use === undefined || k.use === "sig")
        && (k.alg === undefined || k.alg === "RS256")
        && typeof k.n === "string" && typeof k.e === "string"
        && (typeof kid !== "string" || k.kid === kid)
        && (base64UrlDecode(k.n)?.length ?? 0) >= MIN_RSA_MODULUS_BYTES
    );
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
    const cacheKey = `${jwk.n}.${jwk.e}`;
    let key = keyCache.get(cacheKey);
    if (!key) {
        if (keyCache.size >= MAX_KEYS) keyCache.clear();
        key = crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"]
        );
        keyCache.set(cacheKey, key);
        key.catch(() => keyCache.delete(cacheKey));
    }
    return key;
}

/** true se a assinatura RS256 confere com a chave. Nunca lanca (chave invalida = false). */
export async function verifyRs256(jwt: DecodedJwt, jwk: Jwk): Promise<boolean> {
    try {
        const key = await importRsaKey(jwk);
        return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, jwt.signature, jwt.signingInput);
    } catch {
        return false;
    }
}
