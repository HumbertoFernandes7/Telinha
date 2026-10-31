/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos avisos de atualizacao dentro do Discord (ui/updateNotice.tsx): "Telinha X pronto" (baixada e conferida) e
// "Telinha X disponivel" (atualizacao automatica desligada), uma vez por versao, nunca no meio de uma transmissao e so com o
// Discord em foco. O status vem do loader falso (test/fakes/native.ts) pelo core/update.ts; a notificacao e a do Vencord falso
// e o corpo dela (os botoes) e renderizado de verdade. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/updateNotice.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { refreshUpdateStatus } from "@plugins/telinha/core/update";
import { resetState, setState } from "@plugins/telinha/store";
import type { TelinhaState, ViewerSession } from "@plugins/telinha/types";
import { flushPromises } from "@test/fakes/clock";
import { installNative, type NativeEnv, updateStatus as statusOf } from "@test/fakes/native";
import { fireEvent, render, screen } from "@test/fakes/render";
import { loggerLines, notifications, notificationsImpl, resetVencordFakes, toasts } from "@test/fakes/vencord";
import type { ReactElement } from "react";

import { startUpdateNotices, stopUpdateNotices } from "./updateNotice";

const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };
const LOCAL = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, viewers: [], access: "all" as const };
const watching = (status: ViewerSession["status"]): TelinhaState => ({ ...EMPTY, viewing: { peerA: { peerId: "peerA", stream: null, status } } });

let native: NativeEnv;
let next = statusOf();
let focused = true;
const g = globalThis as { DiscordNative?: unknown; };

/** o main passa a dizer `patch` e o renderer le */
async function mainSays(patch: Parameters<typeof statusOf>[0]) {
    next = statusOf(patch);
    await refreshUpdateStatus();
}
const ready = (version: string) => mainSays({ phase: "ready", ready: version });
const available = (version: string) => mainSays({ phase: "available", latest: { version, tag: `v${version}` } });

beforeEach(() => {
    resetVencordFakes();
    resetState();
    next = statusOf();
    focused = true;
    native = installNative({}, { addon: { updateStatus: async () => next } });
    mock.method(document, "hasFocus", () => focused);
    startUpdateNotices();
});

afterEach(() => {
    stopUpdateNotices();
    native.restore();
    mock.restoreAll();
    delete g.DiscordNative;
});

describe("quando avisa", () => {
    test("versao pronta: notificacao 'Telinha X pronto' com 'Reiniciar agora' e 'Depois'", async () => {
        await ready("0.3.0");
        assert.equal(notifications.length, 1);
        const [n] = notifications;
        assert.equal(n.title, "Telinha 0.3.0 pronto");
        assert.equal(n.body, "Reinicie o Discord para usar a versão nova.");
        assert.equal(n.permanent, true);
        assert.equal(n.noPersist, true);

        render(n.richBody as ReactElement);
        assert.ok(screen.getByText("A versão nova entra quando o Discord reiniciar. Se preferir, ela entra sozinha na próxima vez que você abrir o Discord."));
        assert.ok(screen.getByRole("button", { name: "Reiniciar agora" }));
        assert.ok(screen.getByRole("button", { name: "Depois" }));
    });

    test("versao disponivel (atualizacao automatica desligada): 'Telinha X disponivel' com 'Atualizar'", async () => {
        await available("0.3.1");
        const [n] = notifications;
        assert.equal(n.title, "Telinha 0.3.1 disponível");
        assert.equal(n.body, "Abra Configurações → Vencord → Plugins → Telinha para atualizar.");
        render(n.richBody as ReactElement);
        assert.ok(screen.getByText("Há uma versão nova do Telinha. Atualizar baixa e confere a versão agora; ela entra quando o Discord reiniciar."));
        assert.ok(screen.getByRole("button", { name: "Atualizar" }));
    });

    test("uma vez por versao e por tipo: ler o mesmo status de novo nao repete", async () => {
        await ready("0.3.2");
        await ready("0.3.2");
        await refreshUpdateStatus();
        assert.equal(notifications.length, 1);

        await ready("0.3.3");
        assert.equal(notifications.length, 2, "versao nova");

        await available("0.3.3");
        assert.equal(notifications.length, 3, "a mesma versao como 'disponivel' e outro aviso");
    });

    test("sem aviso para em dia, procurando, baixando, erro, ou pronta/disponivel sem o numero da versao", async () => {
        await mainSays({ phase: "up-to-date" });
        await mainSays({ phase: "checking" });
        await mainSays({ phase: "downloading", latest: { version: "0.3.4", tag: "v0.3.4" } });
        await mainSays({ phase: "error", error: { kind: "network", message: "sem rede", quiet: true } });
        await mainSays({ phase: "ready", ready: null });
        await mainSays({ phase: "available", latest: null });
        assert.equal(notifications.length, 0);
    });
});

describe("pronta, mas nao entrou ao reiniciar (o loader diz por que)", () => {
    const stuck = (version: string, reason: string, detail: Record<string, unknown> | null = null) =>
        mainSays({ phase: "ready", ready: version, waiting: { reason, detail, at: "2026-10-31T05:53:12.000Z", starts: 1 } });

    test("outro Discord aberto: o aviso diz qual e o que fazer, e nao promete que 'entra sozinha'", async () => {
        await stuck("1.0.0", "others", { pids: [1234], exes: ["DiscordPTB.exe"] });
        const [n] = notifications;
        assert.equal(n.title, "Telinha 1.0.0 pronto");
        assert.equal(n.body, "Não deu pra trocar de versão: outro Discord estava aberto quando este abriu (Discord PTB).");
        render(n.richBody as ReactElement);
        assert.ok(screen.getByText("Não deu pra trocar de versão: outro Discord estava aberto quando este abriu (Discord PTB). Feche todos os Discords, inclusive pelo ícone perto do relógio (botão direito → Sair do Discord), e abra de novo."));
        assert.equal(screen.queryByText(/entra sozinha/), null);
        assert.equal(screen.queryByRole("button", { name: "Reiniciar agora" }), null, "reiniciar so este Discord nao resolve");
        assert.ok(screen.getByRole("button", { name: "Fechei os outros, reiniciar" }));
        assert.ok(screen.getByRole("button", { name: "Depois" }));
    });

    test("'Fechei os outros, reiniciar' reinicia este Discord", async () => {
        const relaunch = mock.fn();
        g.DiscordNative = { app: { relaunch } };
        await stuck("1.0.3", "others", { pids: [1234] });
        render(notifications[0].richBody as ReactElement);
        fireEvent.click(screen.getByRole("button", { name: "Fechei os outros, reiniciar" }));
        assert.equal(relaunch.mock.callCount(), 1);
    });

    test("arquivo em uso: fechar o Discord por completo, e se nao resolver reiniciar o computador; o botao continua 'Reiniciar agora'", async () => {
        await stuck("1.0.1", "in-use", { code: "EBUSY" });
        render(notifications[0].richBody as ReactElement);
        assert.ok(screen.getByText("Não deu pra trocar de versão: um arquivo do Telinha estava em uso (o ajudante de áudio ou o antivírus). Feche o Discord por completo e abra de novo. Se não resolver, reinicie o computador."));
        assert.ok(screen.getByRole("button", { name: "Reiniciar agora" }));
    });

    test("trava antiga que nao sai: reiniciar o computador", async () => {
        await stuck("1.0.4", "lock-stuck");
        assert.equal(notifications[0].body, "Não deu pra trocar de versão: uma trava antiga da atualização não pôde ser apagada.");
        render(notifications[0].richBody as ReactElement);
        assert.ok(screen.getByText("Não deu pra trocar de versão: uma trava antiga da atualização não pôde ser apagada. Reinicie o computador e abra o Discord de novo."));
    });

    test("um aviso por versao: o motivo nao repete o aviso da mesma versao", async () => {
        await ready("1.0.2");
        await stuck("1.0.2", "locked");
        assert.equal(notifications.length, 1);
    });
});

describe("nunca no meio de uma transmissao", () => {
    test("transmitindo: espera; quando a transmissao acaba, aparece", async () => {
        setState({ ...EMPTY, local: LOCAL });
        await ready("0.4.0");
        assert.equal(notifications.length, 0);

        setState(EMPTY);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].title, "Telinha 0.4.0 pronto");
    });

    test("assistindo alguem (conectando, esperando quadro, tocando): espera; sessao acabada ou com erro nao segura", async () => {
        for (const [status, version] of [["connecting", "0.4.1"], ["waiting-first-frame", "0.4.2"], ["playing", "0.4.3"]] as const) {
            setState(watching(status));
            await ready(version);
            assert.equal(notifications.length, 0, status);
        }
        setState(watching("ended"));
        assert.equal(notifications.length, 1, "ended");
        assert.equal(notifications[0].title, "Telinha 0.4.3 pronto", "so o ultimo pendente (os outros foram trocados)");

        setState(watching("error"));
        await ready("0.4.9");
        assert.equal(notifications.length, 2, "com erro nao esta assistindo de verdade");
    });

    test("so o aviso mais recente fica pendente enquanto espera", async () => {
        setState({ ...EMPTY, local: LOCAL });
        await ready("0.5.0");
        await ready("0.5.1");
        setState(EMPTY);
        assert.deepEqual(notifications.map(n => n.title), ["Telinha 0.5.1 pronto"]);
    });
});

describe("so com o Discord em foco", () => {
    test("sem foco espera o foco voltar (um ouvinte so, mesmo com varias leituras)", async () => {
        focused = false;
        await ready("0.6.0");
        await ready("0.6.0");
        await available("0.6.1");
        assert.equal(notifications.length, 0);

        focused = true;
        window.dispatchEvent(new Event("focus"));
        assert.deepEqual(notifications.map(n => n.title), ["Telinha 0.6.1 disponível"], "o pendente mais recente");

        window.dispatchEvent(new Event("focus"));
        assert.equal(notifications.length, 1, "o ouvinte era de uma vez so");
    });

    test("voltou o foco mas ha uma transmissao: continua esperando", async () => {
        focused = false;
        await ready("0.6.2");
        setState({ ...EMPTY, local: LOCAL });
        focused = true;
        window.dispatchEvent(new Event("focus"));
        assert.equal(notifications.length, 0);
        setState(EMPTY);
        assert.equal(notifications.length, 1);
    });
});

describe("os botoes do aviso", () => {
    test("'Reiniciar agora' reinicia o Discord", async () => {
        const relaunch = mock.fn();
        g.DiscordNative = { app: { relaunch } };
        await ready("0.7.0");
        render(notifications[0].richBody as ReactElement);
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar agora" }));
        assert.equal(relaunch.mock.callCount(), 1);
        assert.deepEqual(toasts, []);
    });

    test("'Reiniciar agora' sem como reiniciar: pede para fechar o Discord por completo", async () => {
        await ready("0.7.1");
        render(notifications[0].richBody as ReactElement);
        fireEvent.click(screen.getByRole("button", { name: "Reiniciar agora" }));
        assert.deepEqual(toasts, [{ text: "Feche o Discord por completo e abra de novo para usar a versão nova", variant: "default" }]);
    });

    test("'Atualizar' avisa que esta baixando e manda baixar", async () => {
        await available("0.7.2");
        render(notifications[0].richBody as ReactElement);
        fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
        assert.deepEqual(toasts, [{ text: "Baixando a atualização do Telinha…", variant: "default" }]);
        await flushPromises();
        assert.equal(native.calls.filter(c => c.name === "updateDownload").length, 1);
    });

    test("'Depois' nao faz nada alem de fechar o aviso", async () => {
        await ready("0.7.3");
        render(notifications[0].richBody as ReactElement);
        fireEvent.click(screen.getByRole("button", { name: "Depois" }));
        assert.deepEqual(toasts, []);
        assert.equal(native.calls.filter(c => c.name === "updateDownload").length, 0);
    });
});

describe("falhas e desligar", () => {
    test("a notificacao recusada (assincrona ou na hora) vai para o log e nao quebra", async () => {
        const refuses = mock.method(notificationsImpl, "show", () => Promise.reject(new Error("sem permissao")));
        await ready("0.8.0");
        await flushPromises();
        refuses.mock.restore();
        mock.method(notificationsImpl, "show", () => {
            throw new Error("quebrou na hora");
        });
        await ready("0.8.1");

        const warns = loggerLines.filter(l => l.logger === "Telinha UI" && l.level === "warn");
        assert.deepEqual(warns.map(w => w.args[0]), ["Aviso de atualização do Telinha falhou", "Aviso de atualização do Telinha falhou"]);
        assert.match(String(warns[0].args[1]), /sem permissao/);
        assert.match(String(warns[1].args[1]), /quebrou na hora/);
    });

    test("desligado: nada avisa; o pendente nao volta quando liga de novo; ligar duas vezes nao duplica", async () => {
        setState({ ...EMPTY, local: LOCAL });
        await ready("0.9.0");
        stopUpdateNotices();
        startUpdateNotices();
        startUpdateNotices();
        setState(EMPTY);
        assert.equal(notifications.length, 0, "o pendente foi esquecido ao parar");

        await ready("0.9.1");
        assert.equal(notifications.length, 1, "uma assinatura so");

        stopUpdateNotices();
        await ready("0.9.2");
        assert.equal(notifications.length, 1);
    });
});
