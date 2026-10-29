/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// OAuth2 (authorization code + PKCE, cliente publico, sem client_secret). PURO: o fetch e injetado.
//
// Fluxo: o modal do Discord faz POST /oauth2/authorize com client_id, redirect_uri, scope=openid,
// code_challenge(S256), state e nonce, e devolve `location` = redirect_uri?code=..&state=..&iss=..
// (sem navegar). Trocamos o code no token endpoint com o code_verifier; a resposta traz o id_token.

import { DISCORD_ISSUER, DISCORD_TOKEN_URL } from "./config";
import { base64UrlEncode, randomUrlSafe, sha256, utf8 } from "./encoding";

export interface PkcePair {
    verifier: string;
    challenge: string;
}

/** RFC 7636: challenge = base64url(SHA-256(ASCII(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
    return base64UrlEncode(await sha256(utf8(verifier)));
}

export async function createPkcePair(): Promise<PkcePair> {
    const verifier = randomUrlSafe(32); // 43 caracteres, dentro do intervalo 43..128 da RFC
    return { verifier, challenge: await pkceChallenge(verifier) };
}

/** Props do OAuth2AuthorizeModal do Discord (nomes conferidos no bundle do cliente em 2026-10-29). */
export interface AuthorizeRequest {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    nonce: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    /** "none" pula a tela se o usuario ja autorizou estes escopos; "consent" sempre pergunta */
    prompt: "none" | "consent";
}

export type AuthorizeResult = { ok: true; code: string; } | { ok: false; error: string; };

/** Le o `location` devolvido pelo modal e confere redirect_uri, state e iss (RFC 9207). */
export function parseAuthorizeLocation(location: unknown, expected: { state: string; redirectUri: string; }): AuthorizeResult {
    if (typeof location !== "string") return { ok: false, error: "resposta sem location" };
    let url: URL;
    let redirect: URL;
    try {
        url = new URL(location);
        redirect = new URL(expected.redirectUri);
    } catch {
        return { ok: false, error: "location inválido" };
    }
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) return { ok: false, error: "redirect_uri inesperado" };

    const q = url.searchParams;
    const iss = q.get("iss");
    if (iss !== null && iss !== DISCORD_ISSUER) return { ok: false, error: "emissor inesperado" };
    if (q.get("state") !== expected.state) return { ok: false, error: "state não confere" };
    const error = q.get("error");
    if (error) return { ok: false, error: q.get("error_description") || error };
    const code = q.get("code");
    return code ? { ok: true, code } : { ok: false, error: "resposta sem code" };
}

export interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token?: string;
    id_token?: string;
}

export class OAuthError extends Error {
    constructor(readonly status: number, readonly code: string, description?: string) {
        super(`OAuth2 ${status} ${code}${description ? `: ${description}` : ""}`);
        this.name = "OAuthError";
    }
}

export function buildCodeExchangeBody(p: { clientId: string; code: string; codeVerifier: string; redirectUri: string; }): URLSearchParams {
    return new URLSearchParams({
        grant_type: "authorization_code",
        client_id: p.clientId,
        code: p.code,
        code_verifier: p.codeVerifier,
        redirect_uri: p.redirectUri
    });
}

export function buildRefreshBody(p: { clientId: string; refreshToken: string; }): URLSearchParams {
    return new URLSearchParams({ grant_type: "refresh_token", client_id: p.clientId, refresh_token: p.refreshToken });
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

/**
 * POST no token endpoint. Do renderer funciona: e same-origin no Discord estavel e o /api responde
 * CORS para ptb/canary. `credentials: "omit"`: nada de cookies, e NUNCA o token do usuario.
 */
export async function requestToken(body: URLSearchParams, fetchImpl: FetchLike = fetch, url = DISCORD_TOKEN_URL): Promise<TokenResponse> {
    const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        credentials: "omit",
        cache: "no-store"
    });
    let data: Record<string, unknown> = {};
    try {
        data = (await res.json()) ?? {};
    } catch { }
    if (!res.ok) {
        throw new OAuthError(res.status, typeof data.error === "string" ? data.error : "http_error",
            typeof data.error_description === "string" ? data.error_description : undefined);
    }
    if (typeof data.access_token !== "string") throw new OAuthError(res.status, "invalid_response");
    return data as unknown as TokenResponse;
}
