/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Prova de identidade do Discord entre peers (ver docs/identity.md). Este arquivo e PURO:
// so constantes e politicas, nada de Discord/Vencord/DOM em tempo de carga (os testes rodam no Node).

/**
 * Client id do aplicativo "Telinha" no Discord Developer Portal.
 * PLACEHOLDER: vazio = recurso desligado (ninguem e verificado, ninguem e "falso").
 * Troque pelo Application ID real depois de criar o app (passo a passo em docs/identity.md).
 */
export const DISCORD_CLIENT_ID: string = "";

/** Redirect URI registrado no app. O modal do Discord nunca navega ate ela (o callback recebe a URL). */
export const OAUTH_REDIRECT_URI = "http://127.0.0.1/telinha/callback";

/** So `openid`: o id_token traz `sub` (o id do usuario) e o `nonce`. Nenhum outro dado e pedido. */
export const OAUTH_SCOPES: readonly string[] = ["openid"];

// Valores de https://discord.com/.well-known/openid-configuration (conferidos em 2026-10-29).
export const DISCORD_ISSUER = "https://discord.com";
export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_JWKS_URL = "https://discord.com/api/oauth2/keys";

/** Contexto do nonce: nonce = base64url(SHA-256(NONCE_CONTEXT + "|" + "sha-256:" + hex do certificado DTLS)). */
export const NONCE_CONTEXT = "telinha-dtls-v1";

/** Tolerancia de relogio entre os PCs (exp/iat). */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** Um id_token do Discord tem ~1 KB; isto so barra lixo enorme vindo da rede. */
export const MAX_ID_TOKEN_LENGTH = 8192;

/** Renova o token proprio quando faltar menos que isto para expirar. */
export const TOKEN_RENEW_BEFORE_MS = 30 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Validade pedida para o certificado DTLS persistente (o Chromium limita a ~1 ano). */
export const CERT_LIFETIME_MS = 180 * DAY_MS;

/** Troca o certificado quando faltar menos que isto (trocar invalida o token, que e refeito). */
export const CERT_ROTATE_BEFORE_MS = 14 * DAY_MS;

const SNOWFLAKE_RE = /^\d{17,20}$/;

export function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && SNOWFLAKE_RE.test(value);
}

/** O recurso so liga com um client id real. */
export function isIdentityConfigured(clientId: string = DISCORD_CLIENT_ID): boolean {
    return isSnowflake(clientId);
}

export function certificateNeedsRotation(expiresAt: number, now: number): boolean {
    return !Number.isFinite(expiresAt) || expiresAt - now < CERT_ROTATE_BEFORE_MS;
}

export function tokenNeedsRenewal(expiresAt: number, now: number): boolean {
    return !Number.isFinite(expiresAt) || expiresAt - now < TOKEN_RENEW_BEFORE_MS;
}
