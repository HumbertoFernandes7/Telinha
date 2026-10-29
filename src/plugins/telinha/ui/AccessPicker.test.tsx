/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do "Quem pode assistir" do transmissor (ui/AccessPicker.tsx), renderizado de verdade: o seletor com os 4
// modos e a explicacao de cada um, o campo de senha (digitar, Gerar, Copiar), o modal que a barra do Telinha abre
// para trocar o modo com a transmissao no ar, e o "Copiar senha" da barra. Primeiro so com o estado (setState), depois
// com o nucleo de verdade por tras do botao Aplicar (test/helpers/wpf-live.ts).
// Rodar:  pnpm test:file src/plugins/telinha/ui/AccessPicker.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getStreamPassword } from "@plugins/telinha/actions";
import { resetState, setState } from "@plugins/telinha/store";
import type { AccessMode, LocalStream, TelinhaState } from "@plugins/telinha/types";
import { flushPromises } from "@test/fakes/clock";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, clipboard, clipboardImpl, loggerLines, modals, pluginSettings, resetVencordFakes, toasts } from "@test/fakes/vencord";
import { type LiveScene, openLiveScene } from "@test/helpers/wpf-live";
import { openInHost } from "@test/helpers/wpf-modal";
import { useState } from "@webpack/common";

import { AccessPicker, accessReady, copyStreamPassword, openAccessModal } from "./AccessPicker";

const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

function localStream(patch: Partial<LocalStream> = {}): LocalStream {
    return { source: { id: "screen:0:0", name: "Tela", kind: "screen" }, quality: "1080p60", hasAudio: false, startedAt: 0, viewers: [], access: "all", ...patch };
}

/** The picker as the capture picker uses it: the parent owns the choice. */
function Picker({ initial = "all", initialPassword = "", log }: { initial?: AccessMode; initialPassword?: string; log?: string[]; }) {
    const [access, setAccess] = useState<AccessMode>(initial);
    const [password, setPassword] = useState(initialPassword);
    return (
        <AccessPicker
            access={access}
            onAccess={a => {
                log?.push(`access:${a}`);
                setAccess(a);
            }}
            password={password}
            onPassword={p => {
                log?.push(`password:${p}`);
                setPassword(p);
            }}
        />
    );
}

const select = () => screen.getByRole("combobox") as HTMLSelectElement;
const choose = (value: AccessMode) => fireEvent.change(select(), { target: { value } });
const passwordInput = () => screen.getByLabelText("Senha desta transmissão") as HTMLInputElement;
const copyButton = () => screen.getByRole("button", { name: "Copiar" }) as HTMLButtonElement;

describe("AccessPicker: o seletor", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
    });

    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    test("oferece os 4 modos, em ordem, com o atual marcado e a explicacao dele", () => {
        render(<Picker />);
        assert.equal(screen.getByText("Quem pode assistir").tagName, "SPAN");
        assert.deepEqual([...select().options].map(o => o.textContent), ["Todos da call", "Só meus amigos do Discord", "Só quem eu aprovar", "Com senha"]);
        assert.equal(select().value, "all");
        assert.ok([...select().options].every(o => !o.disabled), "com Client ID, nenhum modo fica indisponivel");
        screen.getByText("Quem está no seu canal de voz assiste direto; quem não tem a identidade verificada precisa do seu Permitir.");
        assert.equal(screen.queryByLabelText("Senha desta transmissão"), null, "sem senha fora do modo Com senha");
        assert.equal(screen.queryByText(/está indisponível/), null);
    });

    test("Todos da call com a identidade verificada desligada: a explicacao nao fala do Permitir", () => {
        pluginSettings.set("requireVerifiedIdentity", false);
        render(<Picker />);
        screen.getByText("Quem está no seu canal de voz assiste direto.");
        assert.equal(screen.queryByText(/Permitir/), null);
    });

    test("escolher cada modo avisa o pai e troca a explicacao", () => {
        const log: string[] = [];
        render(<Picker log={log} />);

        choose("friends");
        screen.getByText(/Entra direto quem é seu amigo no Discord e provou a identidade/);
        choose("approval");
        screen.getByText(/espera você clicar em Permitir ou Recusar na barra do Telinha \(recusado sozinho em 60 s\)/);
        choose("password");
        screen.getByText(/Só assiste quem digitar a senha, mesmo sem identidade verificada.*Errou 5 vezes/);
        choose("all");
        screen.getByText(/assiste direto/);

        assert.deepEqual(log, ["access:friends", "access:approval", "access:password", "access:all"]);
        assert.equal(select().value, "all");
    });

    describe("Com senha", () => {
        test("campo vazio com os botoes Gerar e Copiar; Copiar so depois de ter senha", () => {
            render(<Picker initial="password" />);
            const input = passwordInput();
            assert.equal(input.placeholder, "Digite uma senha ou clique em Gerar");
            assert.equal(input.getAttribute("autocomplete"), "off");
            assert.equal(input.maxLength, 80, "deixa digitar um pouco alem do limite para mostrar o erro");
            assert.equal(copyButton().disabled, true, "nada para copiar");
            screen.getByText(/Vale só para esta transmissão e nunca fica salva/);
        });

        test("digitar avisa o pai a cada mudanca e libera o Copiar", () => {
            const log: string[] = [];
            render(<Picker initial="password" log={log} />);
            fireEvent.change(passwordInput(), { target: { value: "pipoca-42" } });
            assert.deepEqual(log, ["password:pipoca-42"]);
            assert.equal(passwordInput().value, "pipoca-42");
            assert.equal(copyButton().disabled, false);
        });

        test("senha so com espacos nao vale para copiar", () => {
            render(<Picker initial="password" initialPassword="    " />);
            assert.equal(copyButton().disabled, true);
        });

        test("Gerar preenche uma senha curta no formato palavra-NN", () => {
            render(<Picker initial="password" />);
            fireEvent.click(screen.getByRole("button", { name: "Gerar" }));
            assert.match(passwordInput().value, /^[a-z]+-\d\d$/);
            assert.equal(copyButton().disabled, false);
        });

        test("Copiar leva a senha ja normalizada (sem espacos nas pontas) para a area de transferencia", async () => {
            render(<Picker initial="password" initialPassword="  pipoca-42 " />);
            fireEvent.click(copyButton());
            await flushPromises();
            assert.deepEqual(clipboard, ["pipoca-42"]);
            assert.deepEqual(toasts, [{ text: "Senha copiada", variant: "success" }]);
        });

        test("Copiar que o Discord nega avisa em vez de calar", async t => {
            t.mock.method(clipboardImpl, "copy", async () => {
                throw new Error("negado");
            });
            render(<Picker initial="password" initialPassword="pipoca-42" />);
            fireEvent.click(copyButton());
            await flushPromises();
            assert.deepEqual(clipboard, []);
            assert.deepEqual(toasts, [{ text: "Não consegui copiar a senha", variant: "critical" }]);
        });

        test("senha com mais de 64 caracteres: erro na explicacao e Copiar desligado", () => {
            render(<Picker initial="password" initialPassword={"a".repeat(65)} />);
            const hint = screen.getByText("A senha pode ter no máximo 64 caracteres.");
            assert.match(hint.className, /vc-telinha-access-error/);
            assert.equal(copyButton().disabled, true);
            assert.equal(screen.queryByText(/nunca fica salva/), null);

            fireEvent.change(passwordInput(), { target: { value: "a".repeat(64) } });
            assert.equal(screen.queryByText(/no máximo 64/), null, "64 ainda cabe");
            assert.equal(copyButton().disabled, false);
        });
    });

    test("o limite de 64 conta depois de tirar os espacos das pontas", () => {
        render(<Picker initial="password" initialPassword={`  ${"a".repeat(64)}  `} />);
        assert.equal(screen.queryByText(/no máximo/), null);
        assert.equal(copyButton().disabled, false);
    });
});

describe("accessReady", () => {
    test("so o modo Com senha exige uma senha valida", () => {
        for (const mode of ["all", "friends", "approval"] as const) assert.equal(accessReady(mode, ""), true, mode);
        assert.equal(accessReady("password", ""), false);
        assert.equal(accessReady("password", "   "), false);
        assert.equal(accessReady("password", "a".repeat(65)), false);
        assert.equal(accessReady("password", "  pipoca-42  "), true, "espacos nas pontas sao tirados");
        assert.equal(accessReady("password", "a".repeat(64)), true);
    });
});

describe("AccessModal (so com o estado do Telinha)", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
    });

    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    test("sem transmissao no ar: avisa e nao deixa aplicar", () => {
        const modal = openInHost(openAccessModal);
        assert.equal(modal.title(), "Quem pode assistir");
        assert.equal(modal.notice(), "Você não está mais transmitindo.");
        assert.equal(modal.button("Aplicar").disabled, true);
        assert.equal(modal.button("Cancelar").disabled, false);
    });

    test("com transmissao: ja vem marcado o modo atual; Cancelar fecha sem aplicar", () => {
        act(() => setState({ ...EMPTY, local: localStream({ access: "approval" }) }));
        const modal = openInHost(openAccessModal);
        assert.equal(modal.notice(), null);
        assert.equal(select().value, "approval");
        assert.equal(modal.button("Aplicar").disabled, false);
        assert.match(modal.text(), /Vale para os próximos pedidos: quem já está assistindo continua assistindo/);

        modal.click("Cancelar");
        assert.equal(modals.list().length, 0, "fechou");
        assert.deepEqual(toasts, []);
    });

    test("Com senha: Aplicar so liga depois de digitar ou gerar uma senha valida", () => {
        act(() => setState({ ...EMPTY, local: localStream() }));
        const modal = openInHost(openAccessModal);
        choose("password");
        assert.equal(modal.button("Aplicar").disabled, true, "sem senha");
        fireEvent.change(passwordInput(), { target: { value: "a".repeat(65) } });
        assert.equal(modal.button("Aplicar").disabled, true, "senha longa demais");
        fireEvent.click(screen.getByRole("button", { name: "Gerar" }));
        assert.equal(modal.button("Aplicar").disabled, false);
    });

    test("o nucleo recusa (a transmissao acabou de verdade): o motivo aparece no modal, que continua aberto, e some ao mexer", () => {
        // o estado diz que ha transmissao, o nucleo nao tem nenhuma: setStreamAccess lanca "Você não está transmitindo."
        act(() => setState({ ...EMPTY, local: localStream() }));
        const modal = openInHost(openAccessModal);
        choose("approval");
        modal.click("Aplicar");

        assert.equal(modal.notice(), "Você não está transmitindo.");
        assert.equal(modals.list().length, 1, "continua aberto");
        assert.deepEqual(toasts, []);
        assert.equal(loggerLines.at(-1)?.args[0], "setStreamAccess falhou");

        choose("friends");
        assert.equal(modal.notice(), null, "mexer no seletor limpa o erro");
    });
});

// Uma unica sessao ao vivo: os testes deste bloco seguem a historia em ordem (Todos da call → Com senha → so a senha → aprovacao).
describe("AccessModal e a barra, com o nucleo de verdade", () => {
    let scene: LiveScene;

    before(async () => {
        scene = await openLiveScene();
        await scene.connect("peerA"); // alguem na call: a presenca com o novo modo vai para ele
        await scene.goLive({ access: "all" });
    });

    after(() => scene.close());

    beforeEach(() => scene.resetUi());

    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    test("trocar para Com senha: o nucleo passa a exigir a senha, o modal fecha e avisa", async () => {
        const modal = openInHost(openAccessModal);
        assert.equal(select().value, "all", "ja vem o modo atual");

        choose("password");
        fireEvent.change(passwordInput(), { target: { value: "  pipoca-42  " } });
        modal.click("Aplicar");
        await settle();

        assert.equal(modals.list().length, 0, "fechou");
        assert.deepEqual(toasts, [{ text: "Telinha: quem pode assistir agora: Com senha", variant: "success" }]);
        assert.equal(getStreamPassword(), "pipoca-42", "guardada ja sem os espacos");
        const presence = scene.room.sentOn("presence", "peerA").at(-1)?.data as { stream?: { access?: string; }; };
        assert.equal(presence.stream?.access, "password", "quem esta na call ve o novo modo");
    });

    test("reabrir o modal traz a senha atual e o modo atual; trocar so a senha tambem vale", async () => {
        const modal = openInHost(openAccessModal);
        assert.equal(select().value, "password");
        assert.equal(passwordInput().value, "pipoca-42");

        fireEvent.change(passwordInput(), { target: { value: "sofa-77" } });
        modal.click("Aplicar");
        await settle();
        assert.equal(getStreamPassword(), "sofa-77");
        assert.deepEqual(toasts, [{ text: "Telinha: quem pode assistir agora: Com senha", variant: "success" }]);
    });

    test("\"Copiar senha\" da barra copia a senha desta transmissao", async () => {
        copyStreamPassword();
        await flushPromises();
        assert.deepEqual(clipboard, ["sofa-77"]);
        assert.deepEqual(toasts, [{ text: "Senha copiada", variant: "success" }]);
    });

    test("sair do modo Com senha: a senha deixa de existir e nao ha mais o que copiar", async () => {
        const modal = openInHost(openAccessModal);
        choose("approval");
        modal.click("Aplicar");
        await settle();

        assert.deepEqual(toasts, [{ text: "Telinha: quem pode assistir agora: Só quem eu aprovar", variant: "success" }]);
        assert.equal(getStreamPassword(), null);
        toasts.length = 0;
        copyStreamPassword();
        await flushPromises();
        assert.deepEqual(toasts, [], "sem senha, nada a copiar e nada de aviso");
    });

    test("Só meus amigos: o nucleo aceita (a identidade do Discord esta ligada neste build)", async () => {
        const modal = openInHost(openAccessModal);
        choose("friends");
        modal.click("Aplicar");
        await settle();
        assert.deepEqual(toasts, [{ text: "Telinha: quem pode assistir agora: Só meus amigos do Discord", variant: "success" }]);
    });
});
