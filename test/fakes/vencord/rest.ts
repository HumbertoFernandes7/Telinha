/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake do RestAPI do Discord (@webpack/common): get/post programáveis. O teste define `restControl.handler`; sem ele
// todo pedido falha (como uma rede fora do ar). Cada pedido fica em `restCalls`.

export interface RestRequest {
    url: string;
    query?: Record<string, unknown>;
    body?: unknown;
    retries?: number;
    oldFormErrors?: boolean;
}

export interface RestCall {
    method: "get" | "post";
    request: RestRequest;
}

export interface RestResponse {
    body: unknown;
    status: number;
}

export type RestHandler = (call: RestCall) => RestResponse | Promise<RestResponse>;

/** Todo pedido feito ao RestAPI falso, do mais antigo ao mais novo. */
export const restCalls: RestCall[] = [];

export const restControl: { handler: RestHandler | null; } = { handler: null };

async function respond(method: RestCall["method"], request: RestRequest): Promise<RestResponse> {
    const call: RestCall = { method, request };
    restCalls.push(call);
    if (!restControl.handler) throw new Error("RestAPI falso sem handler");
    return restControl.handler(call);
}

export const RestAPI = {
    get: (request: RestRequest) => respond("get", request),
    post: (request: RestRequest) => respond("post", request)
};

export function resetRest() {
    restCalls.length = 0;
    restControl.handler = null;
}
