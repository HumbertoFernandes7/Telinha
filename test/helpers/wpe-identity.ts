/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Helpers do pacote WP-E: o "Discord" do fluxo Autorizar (modal OAuth2 + endpoint de token + JWKS), para os testes de
// componente verem o resultado de verdade (aviso de sucesso, pedir para assistir de novo) sem rede. Uma chave RSA so
// por processo; o id_token sai assinado com ela (RS256) e as chaves publicas saem como o JWKS do Discord.

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { DISCORD_CLIENT_ID, DISCORD_ISSUER, DISCORD_JWKS_URL, DISCORD_TOKEN_URL, OAUTH_REDIRECT_URI } from "@plugins/telinha/core/identity/config";
import { type FetchHandler, jsonResponse } from "@test/fakes/fetch";

let keys: { privateKey: KeyObject; jwks: { keys: unknown[]; }; } | null = null;

function signingKeys() {
    if (keys) return keys;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "wpe-key-1", use: "sig", alg: "RS256" };
    return keys = { privateKey, jwks: { keys: [jwk] } };
}

const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** id_token do Discord para `userId`, amarrado ao `nonce` do pedido de autorizacao (o modal o recebe como prop) */
export function discordIdToken(userId: string, nonce: string, now = Date.now()): string {
    const input = `${segment({ alg: "RS256", kid: "wpe-key-1", typ: "JWT" })}.${segment({
        iss: DISCORD_ISSUER, aud: DISCORD_CLIENT_ID, sub: userId, nonce, iat: Math.floor(now / 1000) - 30, exp: Math.floor(now / 1000) + 3600
    })}`;
    const signature = createSign("RSA-SHA256").update(input).sign(signingKeys().privateKey).toString("base64url");
    return `${input}.${signature}`;
}

/** Rotas de rede do Discord para installFetch: as chaves (JWKS) e a troca do code pelo token */
export function discordNetwork(idTokenFor: () => string): FetchHandler {
    return url => {
        if (url === DISCORD_JWKS_URL) return jsonResponse(signingKeys().jwks);
        if (url === DISCORD_TOKEN_URL) {
            return jsonResponse({ access_token: "acesso", token_type: "Bearer", expires_in: 604800, scope: "openid", id_token: idTokenFor() });
        }
        return undefined;
    };
}

/** O `location` que o modal do Discord entrega quando o usuario autoriza (state devolvido, code qualquer) */
export function authorizedLocation(state: string, code = "codigo-de-teste"): string {
    return `${OAUTH_REDIRECT_URI}?code=${code}&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(DISCORD_ISSUER)}`;
}
