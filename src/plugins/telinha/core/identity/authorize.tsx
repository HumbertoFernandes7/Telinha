/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Abre o modal "Autorizar" do proprio Discord (OAuth2AuthorizeModal, o mesmo dos links
// discord.com/oauth2/authorize) com PKCE + state + nonce. Conferido no bundle do cliente
// (2026-10-29): o modal aceita as props codeChallenge, codeChallengeMethod, state, nonce e prompt, as
// repassa ao POST /oauth2/authorize e, havendo `callback`, entrega { location } SEM navegar.
// Com prompt "none" e uma autorizacao anterior com os mesmos escopos, o modal se confirma sozinho.
//
// JSX so dentro da funcao (nada roda no carregamento do modulo).

import { OAuth2AuthorizeModal, openModal } from "@webpack/common";

import type { AuthorizeRequest } from "./oauth";

export class AuthorizationCancelled extends Error {
    constructor() {
        super("Autorização cancelada");
        this.name = "AuthorizationCancelled";
    }
}

/** Resolve com o `location` (redirect_uri?code=..&state=..&iss=..); rejeita se o usuario fechar o modal. */
export function openAuthorizeModal(req: AuthorizeRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let settled = false;
        openModal(props => (
            <OAuth2AuthorizeModal
                {...props}
                clientId={req.clientId}
                scopes={req.scopes}
                responseType="code"
                redirectUri={req.redirectUri}
                codeChallenge={req.codeChallenge}
                codeChallengeMethod={req.codeChallengeMethod}
                state={req.state}
                nonce={req.nonce}
                prompt={req.prompt}
                permissions={0n}
                cancelCompletesFlow={false}
                callback={(response: { location?: string; } | undefined) => {
                    if (settled) return;
                    settled = true;
                    if (typeof response?.location === "string") resolve(response.location);
                    else reject(new Error("O Discord não devolveu a autorização"));
                }}
            />
        ), {
            onCloseCallback() {
                if (settled) return;
                settled = true;
                reject(new AuthorizationCancelled());
            }
        });
    });
}
