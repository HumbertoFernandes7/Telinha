/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-C: a stand-in for Discord's OAuth2 side, enough to run the plugin's "Autorizar" flow end to end
// (core/identity/index.ts → authorizeIdentity): Discord's JWKS and token endpoint behind installFetch, and the
// authorize screen played from the OAuth2AuthorizeModal the plugin opens (read its props, hand back the redirect).
// The id_token is a real RS256 JWT for the signed-in user (ME_ID) whose nonce is the one the modal was opened with, so
// the plugin verifies its own token the way a peer would.
//
//   const discord = discordOAuth();                  // after @test/fakes/dom; discord.restore() in after()
//   const done = authorizeTelinhaIdentity();         // opens the modal
//   await eventually(() => modals.top());
//   discord.approve();                               // the user clicks "Autorizar"
//   assert.equal(await done, true);

import { createSign, generateKeyPairSync } from "node:crypto";

import { DISCORD_CLIENT_ID, DISCORD_ISSUER, DISCORD_JWKS_URL, DISCORD_TOKEN_URL } from "@plugins/telinha/core/identity/config";
import { base64UrlEncode, utf8 } from "@plugins/telinha/core/identity/encoding";
import { type FetchEnv, installFetch, jsonResponse } from "@test/fakes/fetch";
import { ME_ID, modals } from "@test/fakes/vencord";

export interface DiscordOAuth {
    /** the token endpoint's calls, as form fields */
    tokenRequests: URLSearchParams[];
    /** the authorize modal's props of the last approve()/cancel() */
    lastProps: Record<string, any> | null;
    /** the user authorizes in the open modal: the redirect goes back through `callback` */
    approve(over?: { location?: string; }): void;
    /** how the next token request is answered (default: 200 with an id_token) */
    tokenStatus: number;
    restore(): void;
}

const segment = (obj: unknown) => base64UrlEncode(utf8(JSON.stringify(obj)));

export function discordOAuth(): DiscordOAuth {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { kty, n, e } = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string; };
    const jwk = { kty, n, e, kid: "wpc-key", use: "sig", alg: "RS256" };
    let nonce = "";
    const env: DiscordOAuth = {
        tokenRequests: [],
        lastProps: null,
        tokenStatus: 200,
        approve(over = {}) {
            const open = modals.top();
            if (!open) throw new Error("discordOAuth.approve: no authorize modal is open");
            const { props } = (modals.element(open.key) as { props: Record<string, any>; });
            env.lastProps = props;
            nonce = props.nonce;
            const location = over.location ?? `${props.redirectUri}?code=authcode&state=${props.state}&iss=${encodeURIComponent(DISCORD_ISSUER)}`;
            props.callback({ location });
            modals.close(open.key); // Discord closes the authorize screen once it has answered
        },
        restore() {
            net.restore();
        }
    };

    const net: FetchEnv = installFetch((url, init) => {
        if (url === DISCORD_JWKS_URL) return jsonResponse({ keys: [jwk] });
        if (url !== DISCORD_TOKEN_URL) return undefined;
        env.tokenRequests.push(new URLSearchParams(String(init?.body ?? "")));
        if (env.tokenStatus !== 200) return jsonResponse({ error: "invalid_grant" }, { status: env.tokenStatus });
        const now = Math.floor(Date.now() / 1000);
        const input = `${segment({ alg: "RS256", kid: jwk.kid, typ: "JWT" })}.${segment({ iss: DISCORD_ISSUER, aud: DISCORD_CLIENT_ID, sub: ME_ID, iat: now - 60, exp: now + 3600, nonce })}`;
        const idToken = `${input}.${base64UrlEncode(createSign("RSA-SHA256").update(input).sign(privateKey))}`;
        return jsonResponse({ access_token: "access", token_type: "Bearer", expires_in: 3600, scope: "openid", refresh_token: "refresh-1", id_token: idToken });
    });
    return env;
}
