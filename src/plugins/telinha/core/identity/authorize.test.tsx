/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do modal "Autorizar" do Discord (core/identity/authorize.tsx) com o OAuth2AuthorizeModal falso: as props
// que vao para o Discord, o callback com o location, e fechar o modal = cancelado.
// Rodar:  pnpm test:file src/plugins/telinha/core/identity/authorize.test.tsx  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { modals, OAuth2AuthorizeModal } from "@test/fakes/vencord";
import type { ReactElement } from "react";

import { AuthorizationCancelled, openAuthorizeModal } from "./authorize";
import type { AuthorizeRequest } from "./oauth";

const REQ: AuthorizeRequest = {
    clientId: "123456789012345678",
    redirectUri: "http://127.0.0.1/telinha/callback",
    scopes: ["openid"],
    state: "estado-123",
    nonce: "nonce-abc",
    codeChallenge: "desafio",
    codeChallengeMethod: "S256",
    prompt: "consent"
};

type ModalProps = Record<string, any> & { callback(response?: { location?: unknown; }): void; };

/** O elemento que o modal aberto renderiza, com as props que o Discord recebe. */
function modalProps(): ModalProps {
    const el = modals.element() as ReactElement<ModalProps>;
    assert.equal(el.type, OAuth2AuthorizeModal);
    return el.props;
}

describe("openAuthorizeModal", () => {
    afterEach(() => modals.reset());

    test("abre o OAuth2AuthorizeModal do Discord com PKCE, state, nonce e prompt", () => {
        void openAuthorizeModal(REQ);
        assert.equal(modals.list().length, 1);
        const props = modalProps();
        assert.equal(props.transitionState, 1, "props do modal repassadas");
        assert.equal(typeof props.onClose, "function");
        for (const [key, value] of Object.entries({
            clientId: REQ.clientId, scopes: REQ.scopes, responseType: "code", redirectUri: REQ.redirectUri, codeChallenge: "desafio",
            codeChallengeMethod: "S256", state: "estado-123", nonce: "nonce-abc", prompt: "consent", permissions: 0n, cancelCompletesFlow: false
        })) assert.deepEqual(props[key], value, key);
    });

    test("callback com location: resolve com ele (sem navegar); chamadas seguintes e fechar o modal nao mudam nada", async () => {
        const p = openAuthorizeModal({ ...REQ, prompt: "none" });
        const props = modalProps();
        assert.equal(props.prompt, "none");
        props.callback({ location: `${REQ.redirectUri}?code=c1&state=estado-123` });
        props.callback({ location: "outra" });
        props.callback(undefined);
        modals.closeAll();
        assert.equal(await p, `${REQ.redirectUri}?code=c1&state=estado-123`);
    });

    test("callback sem location: rejeita com mensagem clara", async () => {
        const p = openAuthorizeModal(REQ);
        modalProps().callback({});
        await assert.rejects(p, { message: "O Discord não devolveu a autorização" });

        const q = openAuthorizeModal(REQ);
        modalProps().callback(undefined);
        await assert.rejects(q, /não devolveu/);

        const r = openAuthorizeModal(REQ);
        modalProps().callback({ location: 42 });
        await assert.rejects(r, /não devolveu/);
    });

    test("fechar o modal antes de autorizar: AuthorizationCancelled", async () => {
        const p = openAuthorizeModal(REQ);
        modalProps().onClose();
        await assert.rejects(p, (e: unknown) => {
            assert.ok(e instanceof AuthorizationCancelled);
            assert.ok(e instanceof Error);
            assert.equal(e.name, "AuthorizationCancelled");
            assert.equal(e.message, "Autorização cancelada");
            return true;
        });
        assert.equal(modals.list().length, 0);
    });
});
