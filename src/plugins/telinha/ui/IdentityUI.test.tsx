/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da prova de identidade na UI (ui/IdentityUI.tsx): o selo de cada conexao, o aviso "Autorize o Telinha no
// Discord" na barra e a secao da pagina de configuracoes (Autorizar / Desvincular). A autorizacao roda de verdade pelo
// nucleo (core/identity): o modal OAuth2 do Discord, o endpoint de token e o JWKS vem de test/helpers/wpf-identity.ts,
// com um id_token RS256 assinado cujo nonce amarra o certificado.
// Rodar:  pnpm test:file src/plugins/telinha/ui/IdentityUI.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getLocalIdentity, unlinkTelinhaIdentity } from "@plugins/telinha/actions";
import { eventually } from "@test/fakes/clock";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, dataStoreImpl, modals, resetVencordFakes, toasts } from "@test/fakes/vencord";
import { installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { authorize, authorizeModalProps, type DiscordEnv, installDiscord } from "@test/helpers/wpf-identity";

import { IdentityBadge, IdentityBanner, identityHint,IdentitySection } from "./IdentityUI";

/** Lets the core's async work run inside act() until `check` holds (the state changes land in React). */
const until = (check: () => unknown) => act(async () => void await eventually(check));

const authorizeButton = () => screen.getByRole("button", { name: "Autorizar o Telinha no Discord" }) as HTMLButtonElement;
const statusLine = () => screen.getByText(/Identidade no Discord:/).textContent;

describe("IdentityBadge e identityHint", () => {
    test("cada identidade tem o seu selo, com a explicacao no tooltip", () => {
        const cases = [
            ["verified", "✔ verificado", "✔", /Identidade verificada: provou ser esta conta do Discord/],
            ["unverified", "não verificado", "não verificado", /Não verificado: não provou ser esta conta/],
            ["invalid", "✖ identidade falsa", "✖ falsa", /Identidade falsa: apresentou uma prova que não confere.*Ignorada\./],
            ["pending", "conferindo…", "…", /Conferindo a identidade no Discord/]
        ] as const;
        for (const [identity, text, short, title] of cases) {
            const { container, unmount } = render(<IdentityBadge identity={identity} />);
            const badge = container.firstElementChild!;
            assert.equal(badge.textContent, text, identity);
            assert.equal(badge.className, `vc-telinha-id-badge vc-telinha-id-badge-${identity}`);
            assert.match(badge.getAttribute("title")!, title);
            assert.equal(badge.getAttribute("aria-label"), badge.getAttribute("title"));
            unmount();

            const compact = render(<IdentityBadge identity={identity} compact />);
            assert.equal(compact.container.firstElementChild!.textContent, short, identity + " compacto");
            compact.unmount();
        }
    });

    test("sem identidade (recurso desligado): nao desenha nada", () => {
        const { container } = render(<IdentityBadge identity={undefined} />);
        assert.equal(container.innerHTML, "");
    });

    test("identityHint: so verificado e nao verificado entram no tooltip", () => {
        assert.equal(identityHint("verified"), "identidade verificada");
        assert.equal(identityHint("unverified"), "não verificado");
        assert.equal(identityHint("pending"), "");
        assert.equal(identityHint("invalid"), "");
        assert.equal(identityHint(undefined), "");
    });
});

describe("autorizar o Telinha no Discord (nucleo de verdade)", () => {
    let rtc: WebRtcEnv;
    let discord: DiscordEnv;

    before(() => {
        rtc = installWebRtc(); // o certificado DTLS do Telinha
        discord = installDiscord();
    });

    after(() => {
        discord.restore();
        rtc.restore();
    });

    beforeEach(() => {
        resetVencordFakes();
        discord.tokenAnswer = "ok";
        discord.tokenRequests.length = 0;
    });

    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    /** Clica em "Autorizar" (o da secao) e devolve o que o plugin pediu ao modal do Discord. */
    async function startAuthorization() {
        fireEvent.click(authorizeButton());
        await until(() => getLocalIdentity().status === "authorizing");
        return authorizeModalProps();
    }

    test("recem aberto o Discord: ainda carregando, sem aviso na barra e sem poder autorizar", () => {
        assert.equal(getLocalIdentity().status, "loading");
        const banner = render(<IdentityBanner />);
        assert.equal(banner.container.innerHTML, "");
        banner.unmount();

        render(<IdentitySection />);
        assert.equal(statusLine(), "Identidade no Discord: carregando…");
        assert.equal(document.querySelector(".vc-telinha-identity-status"), null, "carregando nao tem explicacao");
        assert.equal(authorizeButton().disabled, true);
        assert.equal(screen.queryByRole("button", { name: "Desvincular" }), null);
    });

    test("nunca autorizou: a barra pede a autorizacao e as configuracoes explicam o que muda", async () => {
        await unlinkTelinhaIdentity(); // o estado de quem nunca autorizou (ou desvinculou)
        assert.equal(getLocalIdentity().status, "unauthorized");

        const banner = render(<IdentityBanner />);
        screen.getByText("Autorize o Telinha no Discord para provar que é você");
        assert.match(screen.getByRole("status").getAttribute("title")!, /^Uma vez só: o Discord mostra a janela dele pedindo para o Telinha saber quem você é/);
        screen.getByRole("button", { name: "Autorizar" });
        screen.getByRole("button", { name: "Agora não" });
        banner.unmount();

        render(<IdentitySection />);
        assert.equal(statusLine(), "Identidade no Discord: não autorizado");
        screen.getByText(/Seus amigos veem você como "não verificado" e, se eles exigirem identidade verificada, precisam permitir/);
        assert.equal(authorizeButton().disabled, false);
        assert.equal(screen.queryByRole("button", { name: "Desvincular" }), null);
    });

    test("autorizando: a tela espera o Discord; fechar a janela dele volta ao inicio sem reclamar", async () => {
        render(<IdentitySection />);
        const props = await startAuthorization();
        assert.equal(statusLine(), "Identidade no Discord: autorizando…");
        screen.getByText("Confirme na janela do Discord.");
        assert.equal(authorizeButton().disabled, true, "nao abre uma segunda janela");
        assert.equal(props.prompt, "consent");
        assert.equal(props.clientId, "1565419793446862929");

        act(() => modals.close(modals.top()!.key)); // o usuario fecha o modal do Discord
        await until(() => getLocalIdentity().status === "unauthorized");
        assert.equal(statusLine(), "Identidade no Discord: não autorizado");
        assert.deepEqual(toasts, [], "cancelar nao e erro");
    });

    test("o botao da barra faz o mesmo que o das configuracoes", async () => {
        render(<IdentityBanner />);
        fireEvent.click(screen.getByRole("button", { name: "Autorizar" }));
        await until(() => getLocalIdentity().status === "authorizing");
        assert.equal(screen.queryByRole("status"), null, "enquanto o Discord pergunta, o aviso da barra some");
        await authorizeModalProps();
        act(() => modals.close(modals.top()!.key));
        await until(() => getLocalIdentity().status === "unauthorized");
        screen.getByRole("status");
    });

    test("o Discord devolve uma resposta que nao confere: erro na barra e nas configuracoes, e um toast", async () => {
        render(<><IdentityBanner /><IdentitySection /></>);
        const props = await startAuthorization();
        act(() => authorize(discord, props, { state: "outro-state" }));
        await until(() => toasts.length > 0);

        // o nucleo escreve o erro como "Error: state não confere" (core/log errorText): o teste nao trava o prefixo
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0].variant, "critical");
        assert.match(toasts[0].text, /^Telinha: não deu para autorizar \((Error: )?state não confere\)$/);
        assert.equal(statusLine(), "Identidade no Discord: erro");
        screen.getByText(/^Não deu certo da última vez: (Error: )?state não confere$/);
        assert.match(
            screen.getByRole("status").getAttribute("title")!,
            /^A última autorização não deu certo \((Error: )?state não confere\)\. Sem ela, seus amigos veem você como "não verificado"\.$/
        );
        assert.equal(authorizeButton().disabled, false, "da para tentar de novo");
        assert.equal(discord.tokenRequests.length, 0, "nem pediu o token");
    });

    test("o endpoint de token recusa o code: mesmo caminho de erro, com o motivo do Discord", async () => {
        render(<IdentitySection />);
        discord.tokenAnswer = 400;
        const props = await startAuthorization();
        act(() => authorize(discord, props));
        await until(() => toasts.length > 0);

        assert.equal(toasts.length, 1);
        assert.match(toasts[0].text, /^Telinha: não deu para autorizar \((OAuthError: )?OAuth2 400 invalid_grant: Invalid code\)$/);
        screen.getByText(/^Não deu certo da última vez: (OAuthError: )?OAuth2 400 invalid_grant: Invalid code$/);
        assert.equal(discord.tokenRequests.length, 1);
    });

    test("autorizou: selo \"autorizado\", o aviso da barra some, o toast confirma e o Discord recebeu o pedido certo", async () => {
        render(<><IdentityBanner /><IdentitySection /></>);
        const props = await startAuthorization();
        act(() => authorize(discord, props));
        await until(() => toasts.length > 0);

        assert.deepEqual(toasts, [{ text: "Telinha autorizado: seus amigos conseguem confirmar que é você", variant: "success" }]);
        assert.equal(getLocalIdentity().status, "ready");
        assert.equal(statusLine(), "Identidade no Discord: autorizado");
        screen.getByText(/Seus amigos com o Telinha conseguem confirmar que é você \(selo "verificado"\)\. A autorização se renova sozinha\./);
        screen.getByText(/Desvincular apaga a autorização só deste PC\. Para tirar também do Discord: Configurações de usuário → Apps autorizados → Telinha\./);
        assert.equal(screen.queryByRole("status"), null, "sem aviso na barra");
        assert.equal(screen.queryByRole("button", { name: "Autorizar o Telinha no Discord" }), null);

        const [request] = discord.tokenRequests;
        assert.equal(request.grant_type, "authorization_code");
        assert.equal(request.code, "discord-code");
        assert.equal(request.client_id, "1565419793446862929");
        assert.equal(request.redirect_uri, "http://127.0.0.1/telinha/callback");
        assert.ok(request.code_verifier.length >= 43, "PKCE");
    });

    test("a autorizacao passou do prazo (a call durou mais que ela): a tela mostra vencida e deixa autorizar de novo", t => {
        const real = Date.now();
        t.mock.method(Date, "now", () => real + 8 * 24 * 60 * 60_000);
        render(<IdentitySection />);
        assert.equal(statusLine(), "Identidade no Discord: autorização vencida");
        screen.getByText("Ela se renova sozinha quando você entrar numa call. Se preferir, autorize de novo agora.");
        assert.equal(authorizeButton().disabled, false);
        assert.equal(screen.queryByRole("button", { name: "Desvincular" }), null);
    });

    test("Desvincular que falha: avisa, a tela continua autorizada e o botao volta a funcionar", async t => {
        t.mock.method(dataStoreImpl, "update", async () => {
            throw new Error("IndexedDB travado");
        });
        render(<IdentitySection />);
        const unlink = screen.getByRole("button", { name: "Desvincular" }) as HTMLButtonElement;
        fireEvent.click(unlink);
        assert.equal(unlink.disabled, true, "ocupado enquanto desvincula");
        await settle();

        assert.deepEqual(toasts, [{ text: "Telinha: não deu para desvincular", variant: "critical" }]);
        assert.equal((screen.getByRole("button", { name: "Desvincular" }) as HTMLButtonElement).disabled, false);
        assert.equal(statusLine(), "Identidade no Discord: autorizado");
    });

    test("Desvincular: esquece a autorizacao neste PC e volta a pedir", async () => {
        render(<IdentitySection />);
        fireEvent.click(screen.getByRole("button", { name: "Desvincular" }));
        await settle();

        assert.deepEqual(toasts, [{ text: "Telinha desvinculado desta conta neste PC", variant: "success" }]);
        assert.equal(getLocalIdentity().status, "unauthorized");
        assert.equal(statusLine(), "Identidade no Discord: não autorizado");
        assert.equal(authorizeButton().disabled, false);
    });

    test("\"Agora não\" esconde o aviso da barra ate o Discord reiniciar (mesmo abrindo a barra de novo)", () => {
        const first = render(<IdentityBanner />);
        fireEvent.click(screen.getByRole("button", { name: "Agora não" }));
        assert.equal(first.container.innerHTML, "");
        first.unmount();

        const again = render(<IdentityBanner />);
        assert.equal(again.container.innerHTML, "", "continua escondido");
        again.unmount();

        render(<IdentitySection />);
        assert.equal(authorizeButton().disabled, false, "as configuracoes continuam oferecendo a autorizacao");
    });
});
