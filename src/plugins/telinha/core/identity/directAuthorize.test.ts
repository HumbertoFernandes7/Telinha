/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da autorização direta (sem modal): os pedidos exatos ao RestAPI e cada motivo de recusa.
// Rodar:  pnpm test:file src/plugins/telinha/core/identity/directAuthorize.test.ts

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { authorizeDirect } from "./directAuthorize";
import type { AuthorizeRequest } from "./oauth";

const req: AuthorizeRequest = {
    clientId: "123456789",
    redirectUri: "https://example.test/cb",
    scopes: ["openid", "identify"],
    state: "STATE",
    nonce: "NONCE",
    codeChallenge: "CHALLENGE",
    codeChallengeMethod: "S256",
    prompt: "none"
};

interface Call { method: "get" | "post"; request: Record<string, any>; }

describe("authorizeDirect", () => {
    let calls: Call[];
    let getHandler: (url: string) => Promise<{ body?: unknown; status: number; }>;
    let postHandler: () => Promise<{ body?: unknown; status: number; }>;

    const rest = {
        get: async (request: Call["request"]) => {
            calls.push({ method: "get", request: request as Call["request"] });
            return getHandler(request.url);
        },
        post: async (request: Call["request"]) => {
            calls.push({ method: "post", request: request as Call["request"] });
            return postHandler();
        }
    } as Parameters<typeof authorizeDirect>[1];

    beforeEach(() => {
        calls = [];
        getHandler = async url => url.endsWith("/disclosures") ? { body: { all_acked: true }, status: 200 } : { body: { authorized: true }, status: 200 };
        postHandler = async () => ({ body: { location: "https://example.test/cb?code=C&state=STATE" }, status: 200 });
    });

    const posts = () => calls.filter(c => c.method === "post");

    test("sucesso: GET, avisos e POST com a query e o body exatos; devolve o location", async () => {
        assert.deepEqual(await authorizeDirect(req, rest), { ok: true, location: "https://example.test/cb?code=C&state=STATE" });
        assert.equal(calls.length, 3);

        const baseQuery = {
            client_id: "123456789",
            response_type: "code",
            redirect_uri: "https://example.test/cb",
            code_challenge: "CHALLENGE",
            code_challenge_method: "S256",
            scope: "openid identify",
            state: "STATE",
            nonce: "NONCE"
        };
        assert.deepEqual(calls[0], { method: "get", request: { url: "/oauth2/authorize", query: { ...baseQuery, integration_type: 0 }, retries: 3 } });
        assert.deepEqual(calls[1], { method: "get", request: { url: "/applications/123456789/disclosures" } });
        assert.deepEqual(calls[2], {
            method: "post",
            request: {
                url: "/oauth2/authorize",
                query: baseQuery,
                body: { authorize: true, permissions: "0", integration_type: 0, location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 } }
            }
        });
        assert.ok(!("prompt" in calls[0].request.query));
        assert.ok(!("prompt" in calls[2].request.query));
        assert.ok(!("integration_type" in calls[2].request.query));
    });

    test("ainda nao autorizado: recusa e NENHUM POST", async () => {
        getHandler = async () => ({ body: { authorized: false }, status: 200 });
        assert.deepEqual(await authorizeDirect(req, rest), { ok: false, reason: "ainda não autorizado" });
        assert.equal(posts().length, 0);
        assert.equal(calls.length, 1, "nem olha os avisos");

        getHandler = async () => ({ body: undefined, status: 200 });
        assert.equal((await authorizeDirect(req, rest)).ok, false);
        assert.equal(posts().length, 0);
    });

    test("avisos do app pendentes: recusa sem POST", async () => {
        getHandler = async url => url.endsWith("/disclosures") ? { body: { all_acked: false }, status: 200 } : { body: { authorized: true }, status: 200 };
        assert.deepEqual(await authorizeDirect(req, rest), { ok: false, reason: "avisos do app pendentes" });
        assert.equal(posts().length, 0);
    });

    test("erro no GET de autorizacao, nos avisos ou no POST: recusa, sem lancar", async () => {
        getHandler = async () => {
            throw new Error("rede caiu");
        };
        const first = await authorizeDirect(req, rest);
        assert.equal(first.ok, false);
        assert.match((first as { reason: string; }).reason, /^erro: .*rede caiu/);
        assert.equal(posts().length, 0);

        getHandler = async url => {
            if (url.endsWith("/disclosures")) throw new Error("avisos 500");
            return { body: { authorized: true }, status: 200 };
        };
        const second = await authorizeDirect(req, rest);
        assert.match((second as { reason: string; }).reason, /^erro: .*avisos 500/);
        assert.equal(posts().length, 0);

        getHandler = async url => url.endsWith("/disclosures") ? { body: { all_acked: true }, status: 200 } : { body: { authorized: true }, status: 200 };
        postHandler = async () => {
            throw new Error("post 400");
        };
        const third = await authorizeDirect(req, rest);
        assert.match((third as { reason: string; }).reason, /^erro: .*post 400/);
    });

    test("rejeicao do RestAPI com o objeto da resposta: motivo 'HTTP <status> <mensagem>', nunca [object Object]", async () => {
        getHandler = async () => {
            throw { status: 401, body: { code: 0, message: "401: Unauthorized" } };
        };
        assert.deepEqual(await authorizeDirect(req, rest), { ok: false, reason: "erro: HTTP 401 401: Unauthorized" });

        getHandler = async () => {
            throw { status: 429, body: { code: 20028 } };
        };
        assert.deepEqual(await authorizeDirect(req, rest), { ok: false, reason: "erro: HTTP 429 20028" });

        getHandler = async () => {
            throw { weird: true };
        };
        const odd = await authorizeDirect(req, rest);
        assert.ok(!odd.ok && !odd.reason.includes("[object Object]"));
        assert.equal(posts().length, 0);
    });

    test("resposta do POST sem location (ou nao texto): recusa", async () => {
        postHandler = async () => ({ body: {}, status: 200 });
        assert.deepEqual(await authorizeDirect(req, rest), { ok: false, reason: "sem location" });
        postHandler = async () => ({ body: { location: 42 }, status: 200 });
        assert.deepEqual(await authorizeDirect(req, rest), { ok: false, reason: "sem location" });
        postHandler = async () => ({ body: undefined, status: 200 });
        assert.deepEqual(await authorizeDirect(req, rest), { ok: false, reason: "sem location" });
    });
});
