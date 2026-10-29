/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// verifyPeerIdentity: a decisao "este peer e o usuario X do Discord". PURA (sem rede, sem DOM alem
// de crypto.subtle): recebe o JWKS ja baixado, o fingerprint DTLS visto NESTA conexao e o relogio.
//
// Um id_token do Discord (RS256) prova "o Discord autenticou o usuario `sub` para o app `aud`, e o
// cliente pediu o `nonce` N". O Telinha sempre pede N = hash do fingerprint do proprio certificado
// DTLS. Quem verifica compara N com o fingerprint do certificado que o peer USOU na conexao: copiar
// o token de outra pessoa nao adianta sem a chave privada desse certificado.

import { CLOCK_SKEW_MS, DISCORD_CLIENT_ID, DISCORD_ISSUER, isIdentityConfigured, isSnowflake, MAX_ID_TOKEN_LENGTH } from "./config";
import { asNormalizedFingerprint, nonceForFingerprint } from "./fingerprint";
import { decodeJwt, type Jwks, selectRsaKeys, verifyRs256 } from "./jwt";

export type IdentityFailure =
    /** recurso desligado (sem client id real) */
    | "not-configured"
    /** o peer nao mandou token (nao autorizou o Telinha, ou versao antiga) */
    | "missing"
    | "malformed"
    | "unsupported-alg"
    /** `kid` fora do JWKS em cache: buscar o JWKS de novo e tentar outra vez (rotacao de chave) */
    | "unknown-key"
    | "bad-signature"
    | "wrong-issuer"
    | "wrong-audience"
    | "expired"
    | "not-yet-valid"
    /** token valido, mas de OUTRA pessoa (sub diferente do id anunciado) */
    | "wrong-subject"
    /** nao foi possivel ler o fingerprint DTLS da conexao */
    | "no-fingerprint"
    /** token valido, mas amarrado a OUTRO certificado: copiado/reaproveitado */
    | "fingerprint-mismatch";

export type PeerIdentityResult =
    | { ok: true; userId: string; expiresAt: number; issuedAt: number; }
    | { ok: false; reason: IdentityFailure; };

/**
 * verified   = provou ser `claimedUserId` nesta conexao.
 * unverified = nao provou (sem token, token vencido, recurso desligado, falha transitoria).
 * invalid    = apresentou prova FALSA ou de outra conexao/pessoa: tratar como impostor.
 */
export type IdentityVerdict = "verified" | "unverified" | "invalid";

export interface VerifyPeerIdentityInput {
    /** o que veio da rede (nao confiavel) */
    idToken: unknown;
    /** discordUserId anunciado no hello */
    claimedUserId: string;
    /** fingerprint DTLS remoto desta conexao ("sha-256:hex" ou "sha-256 AB:CD:...") */
    remoteDtlsFingerprint: string | null;
    /** relogio em ms (Date.now()) */
    now: number;
    jwks: Jwks;
    clientId?: string;
    issuer?: string;
    clockSkewMs?: number;
}

const fail = (reason: IdentityFailure): PeerIdentityResult => ({ ok: false, reason });
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function audienceMatches(aud: unknown, azp: unknown, clientId: string): boolean {
    if (typeof aud === "string") return aud === clientId;
    if (!Array.isArray(aud) || !aud.includes(clientId)) return false;
    // OIDC Core 3.1.3.7: com varias audiencias, `azp` tem de ser o nosso client id
    return aud.length === 1 || azp === clientId;
}

export async function verifyPeerIdentity(input: VerifyPeerIdentityInput): Promise<PeerIdentityResult> {
    const {
        idToken, claimedUserId, remoteDtlsFingerprint, now, jwks,
        clientId = DISCORD_CLIENT_ID, issuer = DISCORD_ISSUER, clockSkewMs = CLOCK_SKEW_MS
    } = input;

    if (!isIdentityConfigured(clientId)) return fail("not-configured");
    if (typeof idToken !== "string" || !idToken) return fail("missing");
    if (idToken.length > MAX_ID_TOKEN_LENGTH) return fail("malformed");

    const fingerprint = asNormalizedFingerprint(remoteDtlsFingerprint);
    if (!fingerprint) return fail("no-fingerprint");

    const jwt = decodeJwt(idToken);
    if (!jwt) return fail("malformed");

    // so RS256 (o que o Discord anuncia): barra "none", HS256 com a chave publica etc.
    const { alg, kid, crit } = jwt.header;
    if (alg !== "RS256" || crit !== undefined) return fail("unsupported-alg");

    const keys = selectRsaKeys(jwks, kid);
    if (!keys.length) return fail("unknown-key");
    let signed = false;
    for (const key of keys) {
        if (await verifyRs256(jwt, key)) {
            signed = true;
            break;
        }
    }
    if (!signed) return fail("bad-signature");

    // a partir daqui as claims sao do Discord. Primeiro as que amarram o token a pessoa e a esta
    // conexao (falha = impostor, mesmo que o token tambem esteja vencido); depois o tempo.
    const { iss, aud, azp, exp, iat, nbf, sub, nonce } = jwt.payload;
    if (iss !== issuer) return fail("wrong-issuer");
    if (!audienceMatches(aud, azp, clientId)) return fail("wrong-audience");
    if (!isSnowflake(sub) || sub !== claimedUserId) return fail("wrong-subject");
    if (typeof nonce !== "string" || nonce !== await nonceForFingerprint(fingerprint)) return fail("fingerprint-mismatch");
    if (!isNum(exp) || !isNum(iat)) return fail("malformed");
    if (exp * 1000 + clockSkewMs <= now) return fail("expired");
    if (iat * 1000 - clockSkewMs > now || (isNum(nbf) && nbf * 1000 - clockSkewMs > now)) return fail("not-yet-valid");

    return { ok: true, userId: sub, expiresAt: exp * 1000, issuedAt: iat * 1000 };
}

/** Como a sessao deve tratar o resultado (ver docs/identity.md, "Politica"). */
export function identityVerdict(result: PeerIdentityResult): IdentityVerdict {
    if (result.ok) return "verified";
    switch (result.reason) {
        case "not-configured":
        case "missing":
        case "expired":
        case "not-yet-valid":
        case "no-fingerprint":
        case "unknown-key":
            return "unverified";
        default:
            return "invalid";
    }
}
