/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos avisos para quem transmite (ui/notices.ts): um pedido para assistir esperando Permitir/Recusar e uma identidade
// suspeita viram uma notificacao do Vencord, uma vez cada. O estado do Telinha entra pelo store (setState) e o que se
// confere e o que a notificacao diz e o que o clique nela faz. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/notices.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { IdentityAlert, PendingViewer, TelinhaState } from "@plugins/telinha/types";
import { flushPromises } from "@test/fakes/clock";
import { FRIEND_ID, loggerLines, makeUser, modals, notifications, notificationsImpl, OTHER_ID, resetVencordFakes, UserStore } from "@test/fakes/vencord";

import { startNotices, stopNotices } from "./notices";

const LOCAL = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, viewers: [], access: "approval" as const };
const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

const pending = (peerId: string, over: Partial<PendingViewer> = {}): PendingViewer => ({ peerId, discordUserId: FRIEND_ID, username: "amigo", expiresAt: Date.now() + 60_000, ...over });
const withPending = (...viewers: PendingViewer[]): TelinhaState => ({ ...EMPTY, local: { ...LOCAL, pendingViewers: viewers } });
const withAlerts = (...alerts: IdentityAlert[]): TelinhaState => ({ ...EMPTY, identityAlerts: alerts });

beforeEach(() => {
    resetVencordFakes();
    resetState();
    startNotices();
});

afterEach(() => {
    stopNotices();
});

describe("pedido para assistir", () => {
    test("um pedido novo vira uma notificacao com o nome, o prazo e o avatar", () => {
        UserStore.addUsers(makeUser(FRIEND_ID, "amigo", { globalName: "Amiga Ana" }));
        setState(withPending(pending("peerA", { identity: "verified" })));

        assert.equal(notifications.length, 1);
        const [n] = notifications;
        assert.equal(n.title, "Telinha: pedido para assistir");
        assert.equal(n.body, "Amiga Ana quer assistir sua transmissão. Permita ou recuse na barra do Telinha (recusado sozinho em 60 s).");
        assert.equal(n.icon, `https://cdn.discordapp.com/embed/avatars/0.png?size=64&user=${FRIEND_ID}`);
        assert.equal(n.noPersist, true, "nao fica gravada no historico de notificacoes");
    });

    test("quem nao provou a identidade vem marcado; sem o usuario no Discord, vale o nome anunciado e nao ha avatar", () => {
        setState(withPending(pending("peerA", { discordUserId: OTHER_ID, username: "desconhecido", identity: "unverified" })));
        const [n] = notifications;
        assert.equal(n.body, "desconhecido (não verificado: não provou ser essa conta do Discord) quer assistir sua transmissão. Permita ou recuse na barra do Telinha (recusado sozinho em 60 s).");
        assert.equal(n.icon, undefined);
    });

    test("o clique na notificacao abre 'Quem esta assistindo'", () => {
        setState(withPending(pending("peerA")));
        assert.equal(modals.list().length, 0);
        notifications[0].onClick?.();
        assert.equal(modals.list().length, 1);
    });

    test("o mesmo pedido nao avisa de novo a cada mudanca de estado; um pedido novo da mesma conexao depois de sair avisa", () => {
        setState(withPending(pending("peerA")));
        setState({ ...withPending(pending("peerA")), lastError: "outra coisa mudou" });
        assert.equal(notifications.length, 1);

        setState(withPending(pending("peerA"), pending("peerB", { discordUserId: OTHER_ID, username: "outro" })));
        assert.equal(notifications.length, 2, "so o peerB e novo");

        setState({ ...EMPTY, local: { ...LOCAL, pendingViewers: [] } }); // os dois foram atendidos
        setState(withPending(pending("peerA")));
        assert.equal(notifications.length, 3, "o peerA pediu de novo");
    });

    test("sem transmissao ou sem pedidos nao ha aviso", () => {
        setState(EMPTY);
        setState({ ...EMPTY, local: LOCAL });
        assert.equal(notifications.length, 0);
    });
});

describe("identidade suspeita", () => {
    const alert = (over: Partial<IdentityAlert>): IdentityAlert => ({ discordUserId: FRIEND_ID, username: "amigo", peerIds: ["p1", "p2"], self: false, ...over });

    test("duas conexoes dizem ser a mesma pessoa e nenhuma e verificada: avisa que nenhuma recebe a transmissao", () => {
        UserStore.addUsers(makeUser(FRIEND_ID, "amigo", { globalName: "Ana" }));
        setState(withAlerts(alert({})));
        const [n] = notifications;
        assert.equal(n.title, "Telinha: identidade suspeita");
        assert.equal(n.body, "Duas conexões dizem ser Ana — uma pode ser falsa. Nenhuma delas recebe a sua transmissão enquanto isso durar.");
        assert.equal(n.icon, `https://cdn.discordapp.com/embed/avatars/0.png?size=64&user=${FRIEND_ID}`);
    });

    test("alguem diz ser voce", () => {
        setState(withAlerts(alert({ self: true })));
        assert.equal(notifications[0].body, "Uma conexão na call diz ser você — alguém pode estar se passando por você.");
    });

    test("prova falsa e impostor: so ficam bloqueadas as conexoes suspeitas, sem a frase de 'nenhuma delas'", () => {
        setState(withAlerts(alert({ kind: "fake", peerIds: ["p1"] })));
        assert.equal(notifications[0].body, "Uma conexão apresentou uma prova de identidade falsa de amigo — ignorada.");
        setState(withAlerts(alert({ kind: "fake", peerIds: ["p1"] }), alert({ kind: "impostor", discordUserId: OTHER_ID, username: "outro", peerIds: ["p3"] })));
        assert.equal(notifications.length, 2);
        assert.equal(notifications[1].body, "Uma conexão não verificada diz ser outro, que já provou a identidade — só ela fica bloqueada.");
    });

    test("cada alerta avisa uma vez; quando o conflito acaba e volta, avisa de novo", () => {
        setState(withAlerts(alert({})));
        setState({ ...withAlerts(alert({})), lastError: "x" });
        assert.equal(notifications.length, 1);

        setState(withAlerts());
        setState(withAlerts(alert({})));
        assert.equal(notifications.length, 2, "voltou");
    });

    test("alerta da mesma pessoa de natureza diferente (duplicada e falsa) conta como outro alerta", () => {
        setState(withAlerts(alert({})));
        setState(withAlerts(alert({}), alert({ kind: "fake", peerIds: ["p9"] })));
        assert.equal(notifications.length, 2);
    });
});

describe("ligar e desligar", () => {
    test("ligar duas vezes nao duplica os avisos", () => {
        startNotices();
        setState(withPending(pending("peerA")));
        assert.equal(notifications.length, 1);
    });

    test("desligado: nada avisa; ligado de novo, o que ja estava la entra como novo na proxima mudanca", () => {
        stopNotices();
        setState(withPending(pending("peerA")));
        assert.equal(notifications.length, 0);

        startNotices();
        setState({ ...withPending(pending("peerA")), lastError: "x" });
        assert.equal(notifications.length, 1);
    });

    test("estado sem os campos opcionais (identityAlerts) e parar sem ter ligado nao quebram", () => {
        const { identityAlerts: _, ...bare } = EMPTY;
        setState(bare);
        assert.equal(notifications.length, 0);
        stopNotices();
        stopNotices();
    });

    test("parar esquece o que ja foi avisado", () => {
        setState(withPending(pending("peerA")));
        stopNotices();
        startNotices();
        setState({ ...withPending(pending("peerA")), lastError: "x" });
        assert.equal(notifications.length, 2);
    });
});

describe("conexao pelo Teredo (core/teredoWatch.ts)", () => {
    const peer = (teredo: "local" | "remote" | "both" | undefined, discordUserId = FRIEND_ID) =>
        ({ peerId: `p${discordUserId}`, discordUserId, username: "amigo", streaming: false, admitted: true, ...(teredo ? { teredo } : {}) });

    test("este PC no Teredo: o passo a passo para desligar, uma vez por pessoa na sessao; o clique nao abre nada", () => {
        setState({ ...EMPTY, peers: [peer("local")] });
        assert.equal(notifications.length, 1);
        const [n] = notifications;
        assert.equal(n.title, "Telinha: conexão lenta pelo Teredo");
        assert.equal(n.body, "Sua conexão com amigo está passando pelo Teredo, um túnel lento do Windows, e a live pode ficar ruim. Para desligar: menu Iniciar → "
            + "digite cmd → botão direito → Executar como administrador → cole netsh interface teredo set state disabled e aperte Enter.");
        assert.equal(n.onClick, undefined);
        assert.doesNotMatch(n.body, /\d+\.\d+\.\d+\.\d+|2001:/, "sem endereco");

        // saiu do Teredo e voltou, ou os dois PCs: o lado deste PC ja foi avisado
        setState({ ...EMPTY, peers: [peer(undefined)] });
        setState({ ...EMPTY, peers: [peer("both")] });
        assert.equal(notifications.length, 1);
    });

    test("so o PC do amigo no Teredo: uma linha curta pedindo para ele desligar", () => {
        setState({ ...EMPTY, peers: [peer("remote"), peer(undefined, OTHER_ID)] });
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].title, "Telinha: conexão do amigo pelo Teredo");
        assert.equal(notifications[0].body, "A conexão de amigo passa pelo Teredo, um túnel lento do Windows. Peça para ele desligar (ele também recebe o aviso no Telinha dele).");
        setState({ ...EMPTY, peers: [peer("local")] });
        assert.equal(notifications.length, 2, "o lado deste PC e outro aviso");
    });
});

describe("falha ao notificar", () => {
    test("a notificacao que o Vencord recusa vai para o log do plugin e nao derruba o estado", async t => {
        t.mock.method(notificationsImpl, "show", () => Promise.reject(new Error("sem permissao")));
        setState(withPending(pending("peerA")));
        await flushPromises();
        const line = loggerLines.find(l => l.logger === "Telinha UI");
        assert.equal(line?.level, "warn");
        assert.equal(line?.args[0], "Notificação do Telinha falhou");
        assert.match(String(line?.args[1]), /sem permissao/);
    });
});
