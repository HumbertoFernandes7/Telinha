/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-F helper: plays Discord for the "Autorizar o Telinha no Discord" flow, so the identity UI can be driven through the
// REAL core (core/identity/index.ts): the OAuth2 authorize modal (its props are what the plugin asked for), the token
// endpoint and the JWKS (served through installFetch), and an RS256 id_token signed with a throw-away key whose nonce
// binds the certificate, exactly what Discord's id_token carries.
//
//   const discord = installDiscord();                    // routes the token endpoint + the JWKS
//   click "Autorizar"                                    // the plugin opens the OAuth2 modal
//   const props = await authorizeModalProps();           // what it asked: state, nonce, scopes...
//   authorize(props);                                    // the user clicked "Autorizar" in Discord's modal
//   await eventually(() => getLocalIdentity().status === "ready");
//
// Needs installWebRtc() (the DTLS certificate) and a current user in UserStore (the fake default is ME_ID).

import { createSign, generateKeyPairSync } from "node:crypto";

import { DISCORD_CLIENT_ID, DISCORD_ISSUER, DISCORD_JWKS_URL, DISCORD_TOKEN_URL, OAUTH_REDIRECT_URI } from "@plugins/telinha/core/identity/config";
import { base64UrlEncode, utf8 } from "@plugins/telinha/core/identity/encoding";
import { eventually } from "@test/fakes/clock";
import { type FetchEnv, installFetch, jsonResponse } from "@test/fakes/fetch";
import { ME_ID, modals } from "@test/fakes/vencord";
import type { ReactElement } from "react";

/** The props the plugin gives Discord's OAuth2AuthorizeModal (authorize.tsx). */
export interface AuthorizeModalProps {
    clientId: string;
    state: string;
    nonce: string;
    prompt: string;
    redirectUri: string;
    callback(response: { location?: string; } | undefined): void;
    [key: string]: unknown;
}

export interface DiscordEnv {
    /** the routed fetch (calls made by the plugin) */
    net: FetchEnv;
    /** the id_token the token endpoint answers with, set by authorize() */
    idToken: string | null;
    /** how the token endpoint answers: "ok", or an HTTP error status (400 = invalid_grant) */
    tokenAnswer: "ok" | number;
    /** requests to the token endpoint, as form fields (grant_type, code...) */
    tokenRequests: Record<string, string>[];
    restore(): void;
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const exported = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string; };
const JWK = { kty: exported.kty, n: exported.n, e: exported.e, kid: "wpf-k1", use: "sig", alg: "RS256" };

const segment = (obj: unknown) => base64UrlEncode(utf8(JSON.stringify(obj)));

/** A Discord id_token signed with the helper's key (the one the JWKS route serves). */
export function signIdToken(claims: { sub?: string; nonce: string; issuedAt?: number; expiresAt?: number; aud?: string; }): string {
    const now = Date.now();
    const header = { alg: "RS256", kid: JWK.kid, typ: "JWT" };
    const payload = {
        iss: DISCORD_ISSUER,
        aud: claims.aud ?? DISCORD_CLIENT_ID,
        sub: claims.sub ?? ME_ID,
        iat: Math.floor((claims.issuedAt ?? now - 60_000) / 1000),
        exp: Math.floor((claims.expiresAt ?? now + 60 * 60_000) / 1000),
        nonce: claims.nonce
    };
    const input = `${segment(header)}.${segment(payload)}`;
    return `${input}.${base64UrlEncode(createSign("RSA-SHA256").update(input).sign(privateKey))}`;
}

/** Routes Discord's token endpoint and JWKS. restore() in after(). */
export function installDiscord(): DiscordEnv {
    const env: DiscordEnv = {
        idToken: null,
        tokenAnswer: "ok",
        tokenRequests: [],
        net: installFetch((url, init) => {
            if (url === DISCORD_JWKS_URL) return jsonResponse({ keys: [JWK] });
            if (url === DISCORD_TOKEN_URL) {
                env.tokenRequests.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))));
                if (env.tokenAnswer !== "ok") return jsonResponse({ error: "invalid_grant", error_description: "Invalid code" }, { status: env.tokenAnswer });
                return jsonResponse({ access_token: "at", token_type: "Bearer", expires_in: 604800, scope: "openid", refresh_token: "rt-1", id_token: env.idToken });
            }
            return undefined;
        }),
        restore() {
            env.net.restore();
        }
    };
    return env;
}

/** Waits for the plugin to open Discord's OAuth2 modal and returns what it asked for. */
export async function authorizeModalProps(): Promise<AuthorizeModalProps> {
    const open = await eventually(() => modals.top());
    const element = modals.element(open.key) as ReactElement<AuthorizeModalProps>;
    return element.props;
}

export interface AuthorizeOptions {
    /** whose id_token (default: the current user) */
    sub?: string;
    /** when the id_token was issued / expires, ms epoch (default: a minute ago / in one hour) */
    issuedAt?: number;
    expiresAt?: number;
    /** the redirect's state (default: the one the plugin sent; a different one makes the plugin refuse) */
    state?: string;
}

/**
 * The user clicks "Autorizar" in Discord's modal: the id_token is signed with the request's nonce, and the modal's
 * callback gets the redirect location with the code.
 */
export function authorize(discord: DiscordEnv, props: AuthorizeModalProps, opts: AuthorizeOptions = {}) {
    discord.idToken = signIdToken({ nonce: props.nonce, ...(opts.sub !== undefined ? { sub: opts.sub } : {}), ...(opts.issuedAt !== undefined ? { issuedAt: opts.issuedAt } : {}), ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}) });
    props.callback({ location: `${OAUTH_REDIRECT_URI}?code=discord-code&state=${opts.state ?? props.state}&iss=${encodeURIComponent(DISCORD_ISSUER)}` });
}
