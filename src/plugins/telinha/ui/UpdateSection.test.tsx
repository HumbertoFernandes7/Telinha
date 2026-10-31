/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da secao de atualizacao na pagina do plugin (ui/UpdateSection.tsx): a versao instalada, a linha de status e os
// botoes "Procurar atualizacao", "Atualizar" e "Reiniciar agora", renderizados de verdade (React + happy-dom) sobre o
// loader falso do add-on (test/fakes/native.ts). Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/UpdateSection.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { refreshUpdateStatus } from "@plugins/telinha/core/update";
import { installNative, type NativeEnv, updateStatus as statusOf } from "@test/fakes/native";
import { act, fireEvent, render, screen, settle, waitFor } from "@test/fakes/render";
import { resetVencordFakes, toasts } from "@test/fakes/vencord";

import { UpdateSection } from "./UpdateSection";

let native: NativeEnv | null = null;
let next = statusOf();
const g = globalThis as { DiscordNative?: unknown; };

/** instala o loader falso; o que ele responde em updateStatus e `next` */
function withLoader(addon: Parameters<typeof installNative>[1] = {}) {
    native = installNative({}, { addon: { updateStatus: async () => next, ...addon?.addon } });
    return native;
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
    resetVencordFakes();
    next = statusOf();
});

afterEach(() => {
    native?.restore();
    native = null;
    delete g.DiscordNative;
    mock.restoreAll();
});

describe("sem o loader do add-on", () => {
    test("diz que a versao e desconhecida e de onde vem a atualizacao automatica", () => {
        render(<UpdateSection />);
        assert.ok(screen.getByText("Versão: desconhecida. A atualização automática só funciona com o Telinha instalado pelo TelinhaInstaller."));
        assert.equal(screen.queryAllByRole("button").length, 0);
    });
});

describe("com o loader do add-on", () => {
    test("mostra a versao instalada e a linha de status que o main reportou", async () => {
        withLoader();
        render(<UpdateSection />);
        assert.ok(screen.getByText("…"), "ate o main responder");
        await settle();
        assert.equal(screen.getByText("0.2.3").tagName, "STRONG");
        assert.ok(screen.getByText("Em dia."));
        assert.equal(button("Procurar atualização").disabled, false);
        assert.equal(screen.queryByRole("button", { name: "Atualizar" }), null);
        assert.equal(screen.queryByRole("button", { name: "Reiniciar agora" }), null);
    });

    test("a linha de status acompanha o que o main passa a dizer (sem recarregar a pagina)", async () => {
        withLoader();
        render(<UpdateSection />);
        await settle();
        next = statusOf({ phase: "up-to-date", lastRollback: { version: "0.3.0", to: "0.2.3", at: "x", reason: "crash" } });
        await act(async () => void await refreshUpdateStatus());
        assert.ok(screen.getByText("Em dia. A versão 0.3.0 não iniciou direito e foi desfeita sozinha."));
    });

    test("'Procurar atualizacao': na hora mostra 'Procurando...' e trava os botoes ate o main terminar", async () => {
        let finish!: () => void;
        withLoader({
            addon: {
                updateCheck: () => new Promise(resolve => {
                    finish = () => resolve(statusOf({ phase: "available", latest: { version: "0.3.0", tag: "v0.3.0" } }));
                })
            }
        });
        render(<UpdateSection />);
        await settle();

        fireEvent.click(button("Procurar atualização"));
        assert.ok(screen.getByText("Procurando atualização…"));
        assert.equal(button("Procurar atualização").disabled, true);
        assert.deepEqual(native!.calls.filter(c => c.name === "updateCheck").map(c => c.args[0]), [{ autoDownload: true, manual: true }]);

        await act(async () => finish());
        await waitFor(() => assert.ok(screen.getByText("Versão 0.3.0 disponível.")));
        assert.equal(button("Procurar atualização").disabled, false);
        assert.ok(button("Atualizar"), "ha versao disponivel: aparece 'Atualizar'");
    });

    test("versao disponivel: 'Atualizar' baixa e depois aparece 'Reiniciar agora'", async () => {
        next = statusOf({ phase: "available", latest: { version: "0.3.0", tag: "v0.3.0" } });
        withLoader();
        render(<UpdateSection />);
        await settle();
        fireEvent.click(button("Atualizar"));
        await waitFor(() => assert.ok(screen.getByText("Versão 0.2.4 pronta: reinicie o Discord para usar.")));
        assert.equal(native!.calls.filter(c => c.name === "updateDownload").length, 1);
        assert.equal(screen.queryByRole("button", { name: "Atualizar" }), null);
        assert.ok(button("Reiniciar agora"));
    });

    test("pronta, mas nao entrou ao reiniciar: a linha diz por que, e 'Reiniciar agora' continua la", async () => {
        next = statusOf({ phase: "ready", ready: "0.3.0", waiting: { reason: "others", detail: { pids: [1234], exes: ["DiscordCanary.exe"] }, at: "x", starts: 2 } });
        withLoader();
        render(<UpdateSection />);
        await settle();
        assert.ok(screen.getByText("Versão 0.3.0 pronta, mas não entrou ao reiniciar (2 tentativas): outro Discord está aberto com o Telinha (Discord Canary). Feche todos os Discords, inclusive pelo ícone perto do relógio (botão direito → Sair do Discord), e abra de novo."));
        assert.ok(button("Reiniciar agora"));
    });

    test("main ocupado (baixando): os botoes ficam travados mesmo sem clique", async () => {
        next = statusOf({ phase: "downloading", latest: { version: "0.3.0", tag: "v0.3.0" } });
        withLoader();
        render(<UpdateSection />);
        await settle();
        assert.ok(screen.getByText("Baixando a versão 0.3.0…"));
        assert.equal(button("Procurar atualização").disabled, true);
    });

    test("'Reiniciar agora' reinicia o Discord; sem como reiniciar, pede para fechar por completo", async () => {
        next = statusOf({ phase: "ready", ready: "0.3.0" });
        withLoader();
        render(<UpdateSection />);
        await settle();
        assert.ok(screen.getByText("Versão 0.3.0 pronta: reinicie o Discord para usar."));

        fireEvent.click(button("Reiniciar agora"));
        assert.deepEqual(toasts, [{ text: "Feche o Discord por completo e abra de novo para usar a versão nova", variant: "default" }]);

        const relaunch = mock.fn();
        g.DiscordNative = { app: { relaunch } };
        fireEvent.click(button("Reiniciar agora"));
        assert.equal(relaunch.mock.callCount(), 1);
        assert.equal(toasts.length, 1, "com como reiniciar, nao ha aviso");
    });

    test("versao instalada ainda desconhecida: mostra reticencias; sem commit nem 'Em dia' falso", async () => {
        next = statusOf({ installed: null, phase: "idle" });
        withLoader();
        render(<UpdateSection />);
        await settle();
        assert.equal(screen.getByText("…").tagName, "STRONG");
        assert.ok(screen.getByText("Ainda não verifiquei nesta sessão."));
    });

    test("ao sair da pagina deixa de ouvir o main (sem erro de atualizacao num componente desmontado)", async () => {
        withLoader();
        const view = render(<UpdateSection />);
        await settle();
        view.unmount();
        next = statusOf({ phase: "ready", ready: "0.3.5" });
        await refreshUpdateStatus();
        assert.equal(document.body.textContent, "");
    });
});
