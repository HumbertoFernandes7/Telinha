/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Prova de identidade do Discord entre peers (ver docs/identity.md). Este arquivo e PURO:
// so constantes e politicas, nada de Discord/Vencord/DOM em tempo de carga (os testes rodam no Node).

/**
 * Client id (Application ID) do aplicativo "Telinha" no Discord Developer Portal (cliente publico, redirect
 * OAUTH_REDIRECT_URI, sem bot nem client secret; passo a passo em docs/identity.md).
 * Vazio = recurso desligado: ninguem e verificado nem "falso" e tudo funciona como na v0.1.0 (os testes
 * cobrem esse caminho passando `configured: false` / clientId "" explicitamente, nao por esta constante).
 */
export const DISCORD_CLIENT_ID: string = "1565419793446862929";

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

const DAY_MS = 24 * 60 * 60_000;

/**
 * Carencia depois do `exp`: um token que passa em assinatura, iss, aud, sub e nonce/fingerprint continua
 * valendo como prova ate `exp + MAX_TOKEN_AGE_MS`. O binding ao certificado e o que impede o replay (um token
 * copiado falha em qualquer outro certificado), e o id_token real do Discord dura so ~60 min. Passou disso:
 * "expired" (nao verificado).
 */
export const MAX_TOKEN_AGE_MS = 7 * DAY_MS;

/** Renova o token proprio quando ja tem mais que isto desde a emissao (`iat`). */
export const TOKEN_RENEW_AFTER_ISSUE_MS = DAY_MS;

/** ...ou quando faltar menos que isto para o fim da carencia. */
export const TOKEN_RENEW_BEFORE_GRACE_END_MS = DAY_MS;

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

/** Ate quando um token com este `exp` (ms) e aceito/enviado: o fim da carencia. */
export function tokenAcceptedUntil(expiresAt: number): number {
    return expiresAt + MAX_TOKEN_AGE_MS;
}

/** Hora de renovar: emitido ha mais de ~24 h, ou a menos de 1 dia do fim da carencia. */
export function tokenNeedsRenewal(issuedAt: number, expiresAt: number, now: number): boolean {
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return true;
    return now - issuedAt > TOKEN_RENEW_AFTER_ISSUE_MS || tokenAcceptedUntil(expiresAt) - now < TOKEN_RENEW_BEFORE_GRACE_END_MS;
}
