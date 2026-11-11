/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Renovação sem janela: faz direto, pelo RestAPI do Discord, os mesmos pedidos que o OAuth2AuthorizeModal faz
// (GET /oauth2/authorize, avisos do app, POST /oauth2/authorize), sem abrir o modal. Só autoriza quem JÁ autorizou
// o app (`authorized: true`) e já aceitou os avisos dele: nunca autoriza escondido quem não consentiu.
// Qualquer erro ou resposta inesperada vira { ok: false } (quem chamou cai no modal); nada lança.

import { errorText } from "@plugins/telinha/core/log";
import { RestAPI } from "@webpack/common";

import type { AuthorizeRequest } from "./oauth";

export type DirectAuthorizeResult = { ok: true; location: string; } | { ok: false; reason: string; };

interface RestRequestLike {
    url: string;
    query?: Record<string, unknown>;
    body?: unknown;
    retries?: number;
    oldFormErrors?: boolean;
}

interface RestLike {
    get(request: RestRequestLike): Promise<{ body?: any; status?: number; }>;
    post(request: RestRequestLike): Promise<{ body?: any; status?: number; }>;
}

/**
 * O RestAPI do Discord rejeita com o objeto da resposta ({ status, body: { code, message } }), nao com um Error:
 * "HTTP 401 401: Unauthorized". Nunca "[object Object]".
 */
function failureReason(e: unknown): string {
    if (!(e instanceof Error) && e && typeof e === "object") {
        const { status, body } = e as { status?: unknown; body?: { message?: unknown; code?: unknown; } | null; };
        const parts: string[] = [];
        if (typeof status === "number") parts.push(`HTTP ${status}`);
        const detail = body && typeof body === "object" ? body.message ?? body.code : undefined;
        if (typeof detail === "string" || typeof detail === "number") parts.push(String(detail));
        if (parts.length) return "erro: " + errorText(parts.join(" "));
        if (!("message" in e)) return "erro: resposta inesperada";
    }
    return "erro: " + errorText(e);
}

export async function authorizeDirect(req: AuthorizeRequest, rest: RestLike = RestAPI as unknown as RestLike): Promise<DirectAuthorizeResult> {
    try {
        const query = {
            client_id: req.clientId,
            response_type: "code",
            redirect_uri: req.redirectUri,
            code_challenge: req.codeChallenge,
            code_challenge_method: req.codeChallengeMethod,
            scope: req.scopes.join(" "),
            state: req.state,
            nonce: req.nonce
        };

        const check = await rest.get({ url: "/oauth2/authorize", query: { ...query, integration_type: 0 }, retries: 3 });
        if (check.body?.authorized !== true) return { ok: false, reason: "ainda não autorizado" };

        const disclosures = await rest.get({ url: `/applications/${req.clientId}/disclosures` });
        if (disclosures.body?.all_acked === false) return { ok: false, reason: "avisos do app pendentes" };

        const done = await rest.post({
            url: "/oauth2/authorize",
            query,
            body: {
                authorize: true,
                permissions: "0",
                integration_type: 0,
                location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
            }
        });
        const location = done.body?.location;
        if (typeof location !== "string" || !location) return { ok: false, reason: "sem location" };
        return { ok: true, location };
    } catch (e) {
        return { ok: false, reason: failureReason(e) };
    }
}
