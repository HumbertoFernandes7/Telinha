/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// No network in unit tests: test/setup.ts (and @test/fakes/dom, after happy-dom) make the global fetch reject.
// A test that needs answers (Discord's JWKS / token endpoint, GitHub releases...) routes them here:
//
//   const net = installFetch(url => url.endsWith("/oauth2/keys") ? jsonResponse(JWKS) : undefined);
//   after(() => net.restore());
//   net.calls   // [{ url, init }]
//
// The handler returns a Response (or a promise of one); undefined = not routed, the call rejects like a network error.

export interface FetchCall {
    url: string;
    init?: RequestInit;
}

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function urlOf(input: unknown): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return String((input as { url?: string; })?.url ?? input);
}

/** The fetch every test process starts with: rejects, naming the URL. */
export function blockedFetch(input: unknown): Promise<Response> {
    return Promise.reject(new TypeError(`network disabled in unit tests: ${urlOf(input)} (route it with installFetch from @test/fakes/fetch)`));
}

export function blockNetwork() {
    (globalThis as { fetch: unknown; }).fetch = blockedFetch;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, ...init, headers: { "content-type": "application/json", ...init.headers as Record<string, string> } });
}

export interface FetchEnv {
    readonly calls: FetchCall[];
    restore(): void;
}

export function installFetch(handler: FetchHandler): FetchEnv {
    const g = globalThis as { fetch: unknown; };
    const before = g.fetch;
    const calls: FetchCall[] = [];
    g.fetch = async (input: unknown, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url, ...(init ? { init } : {}) });
        const res = await handler(url, init);
        if (!res) throw new TypeError(`fake fetch: no route for ${url}`);
        return res;
    };
    return {
        calls,
        restore() {
            g.fetch = before;
        }
    };
}
