/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O lado de quem assiste em "Quem pode assistir" (ui/WatchGate.tsx): o texto do aviso de senha, o campo de senha (vazia,
// longa demais, certa, errada) e o botao "Autorizar o Telinha" que aparece depois de uma recusa "notVerified". O nucleo
// e o de verdade (sala + amigo transmitindo + o "Discord" do fluxo OAuth), entao cada clique e conferido pelo que sai
// para o transmissor e pelo que o usuario ve (avisos, botao ocupado).
// Rodar:  pnpm test:file src/plugins/telinha/ui/WatchGate.test.tsx

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { unwatch, watch } from "@plugins/telinha/actions";
import { rt } from "@plugins/telinha/core/context";
import { getState } from "@plugins/telinha/store";
import type { ViewerSession } from "@plugins/telinha/types";
import { useFakeClock } from "@test/fakes/clock";
import { installFetch } from "@test/fakes/fetch";
import { act, cleanup, fireEvent as fire, render, screen, settle, waitFor } from "@test/fakes/render";
import { caughtErrors, loggerLines, ME_ID, modals, toasts } from "@test/fakes/vencord";
import { NONCE, startStreamer, type Streamer } from "@test/helpers/wpe-core";
import { assertAbsent } from "@test/helpers/wpe-dom";
import { authorizedLocation, discordIdToken, discordNetwork } from "@test/helpers/wpe-identity";
import type { ReactElement } from "react";

import { AuthorizeToWatchButton, PasswordForm, passwordOverlayText } from "./WatchGate";

const PEER = "peerA";

const session = (patch: Partial<ViewerSession> = {}): ViewerSession => ({ peerId: PEER, stream: null, status: "connecting", ...patch });

/** Espera (so com setImmediate: vale com o relogio falso ligado) ate `check()` dar verdadeiro */
async function until(check: () => unknown, ms = 5000) {
    const deadline = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
    while (!check()) {
        if (process.hrtime.bigint() > deadline) throw new Error("until: a condicao nao ficou verdadeira: " + check.toString());
        await settle();
    }
}

describe("passwordOverlayText", () => {
    test("so fala de senha enquanto conecta e o transmissor esta pedindo", () => {
        assert.equal(passwordOverlayText(session({ status: "playing", passwordPrompt: { attemptsLeft: 3, wrong: false } }), "Ana"), null);
        assert.equal(passwordOverlayText(session({ status: "error", passwordPrompt: { attemptsLeft: 3, wrong: false } }), "Ana"), null);
        assert.equal(passwordOverlayText(session(), "Ana"), null, "conectando, mas ninguem pediu senha");
        assert.equal(passwordOverlayText(session({ checkingPassword: true }), "Ana"), null);
    });

    test("primeira vez: pede a senha que o amigo passou", () => {
        assert.deepEqual(passwordOverlayText(session({ passwordPrompt: { attemptsLeft: 5, wrong: false } }), "Ana"), {
            title: "Esta transmissão é com senha",
            detail: "Digite a senha que Ana passou para assistir."
        });
    });

    test("senha errada: diz quantas tentativas restam (1 no singular, sem numero quando o transmissor nao diz)", () => {
        const wrong = (attemptsLeft: number | null) => passwordOverlayText(session({ passwordPrompt: { attemptsLeft, wrong: true } }), "Ana");
        assert.deepEqual(wrong(4), { title: "Senha incorreta", detail: "Confira com Ana e tente de novo. Restam 4 tentativas." });
        assert.equal(wrong(1)!.detail, "Confira com Ana e tente de novo. Resta 1 tentativa.");
        assert.equal(wrong(0)!.detail, "Confira com Ana e tente de novo. Restam 0 tentativas.");
        assert.equal(wrong(null)!.detail, "Confira com Ana e tente de novo.", "sem espaco sobrando no fim");
    });
});

describe("WatchGate com o nucleo", () => {
    let streamer: Streamer;

    before(async () => {
        streamer = await startStreamer({ access: "password" });
    });

    after(async () => {
        await streamer.stop();
    });

    beforeEach(() => {
        toasts.length = 0;
        loggerLines.length = 0;
        modals.reset();
        streamer.room.sent.length = 0;
    });

    afterEach(async () => {
        cleanup();
        await act(async () => unwatch(PEER));
        await settle();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    const proofs = () => streamer.watchMessages().filter(m => m.proof);

    /** O amigo pediu a senha: o estado tem passwordPrompt e o nucleo espera a prova */
    async function askForPassword(attemptsLeft = 5) {
        act(() => watch(PEER));
        await settle();
        streamer.reply({ op: "password", nonce: NONCE, attemptsLeft });
        await settle();
        assert.ok(getState().viewing[PEER]?.passwordPrompt, "o transmissor esta pedindo a senha");
    }

    describe("PasswordForm", () => {
        const field = () => screen.getByLabelText("Senha da transmissão") as HTMLInputElement;
        const submit = () => fire.click(screen.getByRole("button", { name: "Assistir" }));

        test("campo de senha escondida e ja com o foco; \"Mostrar\" revela e \"Esconder\" volta", async () => {
            await askForPassword();
            render(<PasswordForm peerId={PEER} />);
            assert.equal(field().type, "password");
            assert.equal(field().placeholder, "Senha");
            assert.equal(field().maxLength, 128);
            assert.equal(field().autocomplete, "off");
            assert.ok(document.activeElement === field(), "o foco ja esta no campo");

            fire.click(screen.getByRole("button", { name: "Mostrar a senha" }));
            assert.equal(field().type, "text");
            const hide = screen.getByRole("button", { name: "Esconder a senha" });
            assert.equal(hide.textContent, "Esconder");
            fire.click(hide);
            assert.equal(field().type, "password");
        });

        test("versao compacta (tile pequena): campo mais estreito e sem o botao Mostrar", async () => {
            await askForPassword();
            const { rerender } = render(<PasswordForm peerId={PEER} />);
            assert.equal(field().style.width, "180px");
            rerender(<PasswordForm peerId={PEER} compact />);
            assert.equal(field().style.width, "100px");
            assertAbsent(screen.queryByRole("button", { name: /senha$/ }));
            assert.ok(screen.getByRole("button", { name: "Assistir" }));
        });

        test("vazia, ou so espacos: pede para digitar e nao manda nada", async () => {
            await askForPassword();
            render(<PasswordForm peerId={PEER} />);
            submit();
            assert.equal(screen.getByText("Digite a senha.").textContent, "Digite a senha.");

            fire.change(field(), { target: { value: "     " } });
            submit();
            assert.ok(screen.getByText("Digite a senha."));
            await settle();
            assert.equal(proofs().length, 0);
        });

        test("longa demais (mais de 64 caracteres): avisa o limite e nao manda nada", async () => {
            await askForPassword();
            render(<PasswordForm peerId={PEER} />);
            fire.change(field(), { target: { value: "x".repeat(70) } });
            submit();
            assert.ok(screen.getByText("Senha longa demais (máximo 64 caracteres)."));
            await settle();
            assert.equal(proofs().length, 0);
        });

        test("digitar de novo apaga o aviso", async () => {
            await askForPassword();
            render(<PasswordForm peerId={PEER} />);
            submit();
            assert.ok(screen.getByText("Digite a senha."));
            fire.change(field(), { target: { value: "g" } });
            assertAbsent(screen.queryByText("Digite a senha."));
        });

        test("senha valida: so a prova sai (sem a senha), o campo limpa e nao ha aviso", async () => {
            await askForPassword();
            render(<PasswordForm peerId={PEER} />);
            fire.change(field(), { target: { value: "gato-42" } });
            submit();
            assert.equal(field().value, "", "campo limpo");
            assertAbsent(screen.queryByText(/Digite|longa/));

            await waitFor(() => assert.equal(proofs().length, 1));
            assert.match(proofs()[0].proof!, /^[A-Za-z0-9_-]{43}$/);
            assert.equal(JSON.stringify(streamer.room.sent).includes("gato-42"), false, "a senha em si nao sai do PC");
            assert.equal(getState().viewing[PEER]?.checkingPassword, true);
        });

        test("Enter no campo envia igual ao botao; espacos nas pontas sao ignorados", async () => {
            await askForPassword();
            const { container } = render(<PasswordForm peerId={PEER} />);
            fire.change(field(), { target: { value: "  gato-42  " } });
            fire.submit(container.querySelector("form")!);
            await waitFor(() => assert.equal(proofs().length, 1));
            assert.equal(field().value, "");
        });

        test("o nucleo falha ao receber a senha: aviso no formulario e erro no log", async t => {
            await askForPassword();
            render(<PasswordForm peerId={PEER} />);
            const broken = t.mock.method(rt.viewing, "get", () => {
                throw new Error("nucleo quebrado");
            });
            fire.change(field(), { target: { value: "gato-42" } });
            submit();
            broken.mock.restore(); // o afterEach ainda usa o nucleo
            assert.ok(screen.getByText("Não foi possível enviar a senha."));
            assert.ok(loggerLines.some(l => l.level === "error" && l.args[0] === "submitWatchPassword falhou"));
        });

        test("os cliques e teclas no formulario nao chegam na tile do Discord", async () => {
            await askForPassword();
            const seen: string[] = [];
            const spy = (name: string) => () => void seen.push(name);
            const { container } = render(
                <div onClick={spy("click")} onDoubleClick={spy("dblclick")} onMouseDown={spy("mousedown")} onPointerDown={spy("pointerdown")} onKeyDown={spy("keydown")} onKeyUp={spy("keyup")}>
                    <PasswordForm peerId={PEER} />
                </div>
            );
            const form = container.querySelector("form")!;
            fire.click(form);
            fire.doubleClick(form);
            fire.mouseDown(field());
            fire.pointerDown(field());
            fire.keyDown(field(), { key: "a" });
            fire.keyUp(field(), { key: "a" });
            assert.deepEqual(seen, []);
        });
    });

    describe("AuthorizeToWatchButton", () => {
        type AuthorizeProps = { nonce: string; state: string; callback(response?: { location?: string; }): void; };
        const authorizeModal = () => (modals.element() as ReactElement<AuthorizeProps>).props;

        /** O transmissor recusou com "notVerified": a tile/janela mostra o botao */
        async function refusedAsNotVerified() {
            act(() => watch(PEER));
            await settle();
            streamer.reply({ op: "denied", reason: "notVerified" });
            await settle();
            assert.equal(getState().viewing[PEER]?.denied, "notVerified");
        }

        test("mostra o botao \"Autorizar o Telinha\" (so existe com o recurso de identidade ligado)", () => {
            render(<AuthorizeToWatchButton peerId={PEER} />);
            const button = screen.getByRole("button", { name: "Autorizar o Telinha" }) as HTMLButtonElement;
            assert.equal(button.type, "button");
            assert.equal(button.disabled, false);
        });

        test("clicar abre o \"Autorizar\" do Discord e deixa o botao ocupado; cancelar o modal solta o botao sem aviso", async () => {
            let discordClicks = 0;
            render(<div onClick={() => discordClicks++}><AuthorizeToWatchButton peerId={PEER} /></div>);
            fire.click(screen.getByRole("button", { name: "Autorizar o Telinha" }));
            await until(() => modals.list().length === 1);
            assert.equal(discordClicks, 0, "o clique nao chega na tile do Discord");

            const busy = screen.getByRole("button", { name: "Autorizando…" }) as HTMLButtonElement;
            assert.equal(busy.disabled, true);
            assert.equal(busy.style.opacity, "0.6");

            modals.close(modals.top()!.key); // o usuario fechou o modal
            await until(() => screen.queryByRole("button", { name: "Autorizar o Telinha" }));
            assert.deepEqual(toasts, []);
        });

        test("o Discord nao devolve a autorizacao: o botao volta e nenhum aviso de sucesso aparece", async () => {
            render(<AuthorizeToWatchButton peerId={PEER} />);
            fire.click(screen.getByRole("button", { name: "Autorizar o Telinha" }));
            await until(() => modals.list().length === 1);
            act(() => authorizeModal().callback(undefined));
            await until(() => screen.queryByRole("button", { name: "Autorizar o Telinha" }));
            assert.deepEqual(toasts, []);
        });

        test("falha ate ao registrar o erro: o botao nao fica preso em \"Autorizando…\" e o usuario e avisado", async t => {
            render(<AuthorizeToWatchButton peerId={PEER} />);
            fire.click(screen.getByRole("button", { name: "Autorizar o Telinha" }));
            await until(() => modals.list().length === 1);
            t.mock.method(console, "warn", () => {
                throw new Error("console quebrado");
            });
            act(() => authorizeModal().callback(undefined)); // vira erro, e o registro do erro tambem lanca
            await until(() => toasts.length === 1);
            assert.deepEqual(toasts, [{ text: "Telinha: não deu para autorizar agora", variant: "critical" }]);
            assert.ok(loggerLines.some(l => l.level === "error" && l.args[0] === "authorizeAndRewatch falhou"));
            await until(() => screen.queryByRole("button", { name: "Autorizar o Telinha" }));
        });

        test("autorizou: aviso de sucesso e, 2,5 s depois, pede para assistir de novo (o transmissor ja conferiu a prova nova)", async t => {
            const clock = useFakeClock(t);
            let idToken = "";
            const net = installFetch(discordNetwork(() => idToken));
            try {
                await refusedAsNotVerified();
                const startsBefore = streamer.watchMessages().filter(m => m.op === "start").length;
                render(<AuthorizeToWatchButton peerId={PEER} />);
                fire.click(screen.getByRole("button", { name: "Autorizar o Telinha" }));
                await until(() => modals.list().length === 1);

                const { nonce, state, callback } = authorizeModal();
                idToken = discordIdToken(ME_ID, nonce);
                act(() => callback({ location: authorizedLocation(state) }));
                await until(() => toasts.length === 1);
                assert.deepEqual(toasts, [{ text: "Telinha autorizado: pedindo para assistir de novo…", variant: "success" }]);
                assert.ok(net.calls.some(c => c.url.endsWith("/oauth2/token")), "trocou o code pelo token");

                await until(() => screen.queryByRole("button", { name: "Autorizar o Telinha" }));
                act(() => clock.tick(2499));
                assert.equal(streamer.watchMessages().filter(m => m.op === "start").length, startsBefore, "ainda nao");
                act(() => clock.tick(1));
                await settle();
                assert.equal(streamer.watchMessages().filter(m => m.op === "start").length, startsBefore + 1, "pediu de novo");
                assert.equal(getState().viewing[PEER]?.status, "connecting");
            } finally {
                net.restore();
            }
        });

        test("autorizou, mas o usuario ja desistiu de assistir: nao pede de novo", async t => {
            const clock = useFakeClock(t);
            let idToken = "";
            const net = installFetch(discordNetwork(() => idToken));
            try {
                await refusedAsNotVerified();
                render(<AuthorizeToWatchButton peerId={PEER} />);
                fire.click(screen.getByRole("button", { name: "Autorizar o Telinha" }));
                await until(() => modals.list().length === 1);
                const { nonce, state, callback } = authorizeModal();
                idToken = discordIdToken(ME_ID, nonce);
                act(() => callback({ location: authorizedLocation(state) }));
                await until(() => toasts.length === 1);

                act(() => unwatch(PEER));
                await settle();
                const startsBefore = streamer.watchMessages().filter(m => m.op === "start").length;
                act(() => clock.tick(2500));
                await settle();
                assert.equal(streamer.watchMessages().filter(m => m.op === "start").length, startsBefore);
                assert.equal(getState().viewing[PEER], undefined);
            } finally {
                net.restore();
            }
        });
    });
});

