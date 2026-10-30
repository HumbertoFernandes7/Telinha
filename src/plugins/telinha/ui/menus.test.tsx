/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos menus (ui/menus.tsx): as entradas do Telinha na caixa de ferramentas do Vencord (renderToolboxActions) e o item
// no menu de contexto de um usuario do Discord (userContextMenuPatch), renderizados com o Menu falso (role="menu"/"menuitem")
// e clicados como a pessoa clicaria. O estado vem do store; as acoes que mexem no nucleo (parar, expulsar, assistir) rodam
// dentro de uma call de verdade, como no harness. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/menus.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getState, resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { closeAllViewers } from "@plugins/telinha/ui/viewerWindows";
import { eventually } from "@test/fakes/clock";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, ME_ID, Menu, modals, OTHER_ID, pluginSettings, PopoutActions, resetVencordFakes, SelectedChannelStore, toasts, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { type Call, friendArrives, goLive, joinCall } from "@test/helpers/wpc-session";
import { createElement, type ReactElement } from "react";

import { renderToolboxActions, userContextMenuPatch } from "./menus";

const EMPTY: TelinhaState = { inRoom: true, channelId: VOICE_CHANNEL_ID, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };
const LOCAL = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, viewers: [] as string[], access: "all" as const };
const streamer = (over: Partial<RemotePeer> = {}): RemotePeer => ({
    peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
    stream: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" }, ...over
});

function Toolbox() {
    return <Menu.Menu navId="vc-toolbox">{renderToolboxActions()}</Menu.Menu>;
}

/** O menu de contexto de `userId`, montado como o Discord monta: o patch empurra grupos para o array de filhos. */
function contextMenu(userId: string | undefined) {
    const children: (ReactElement | null)[] = [];
    userContextMenuPatch(children, { user: userId ? { id: userId } : undefined });
    // varargs, as Discord's Menu receives them (an array child would ask every group for a key)
    render(createElement(Menu.Menu, { navId: "user-context" }, ...children));
    return children;
}

const items = () => screen.queryAllByRole("menuitem").map(i => i.textContent);
const item = (label: string | RegExp) => screen.getByRole("menuitem", { name: label });

/** the last describe runs the real core: its published state must survive from one test to the next */
let realCore = false;

beforeEach(() => {
    if (realCore) {
        toasts.length = 0;
        PopoutActions.reset();
        return;
    }
    resetVencordFakes();
    resetState();
});

afterEach(async () => {
    await act(async () => closeAllViewers());
    assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
});

describe("caixa de ferramentas do Vencord", () => {
    test("em uma call, sem transmitir: 'Transmitir com Telinha' e a lista de quem transmite", () => {
        SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
        render(<Toolbox />);
        assert.deepEqual(items(), ["Transmitir com Telinha", "Quem está transmitindo"]);
    });

    test("quem transmite aparece contado no item", () => {
        SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
        setState({ ...EMPTY, peers: [streamer(), streamer({ peerId: "peerB", discordUserId: OTHER_ID, streaming: false }), streamer({ peerId: "peerC", discordUserId: OTHER_ID })] });
        render(<Toolbox />);
        assert.deepEqual(items(), ["Transmitir com Telinha", "Quem está transmitindo (2)"]);
    });

    test("fora de uma call o item diz para entrar, e clicar so avisa", () => {
        render(<Toolbox />);
        assert.deepEqual(items(), ["Transmitir com Telinha (entre numa call)", "Quem está transmitindo"]);
        fireEvent.click(item(/Transmitir com Telinha/));
        assert.deepEqual(toasts, [{ text: "Telinha: entre num canal de voz para transmitir.", variant: "critical" }]);
        assert.equal(modals.list().length, 0);
    });

    test("em uma call, 'Transmitir com Telinha' abre a escolha de tela ou janela", () => {
        SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
        render(<Toolbox />);
        fireEvent.click(item("Transmitir com Telinha"));
        assert.equal(modals.list().length, 1);
    });

    test("transmitindo: parar (com quantos assistem), quem esta assistindo, trocar tela ou janela", async () => {
        setState({ ...EMPTY, local: LOCAL });
        render(<Toolbox />);
        assert.deepEqual(items(), ["Parar transmissão (ninguém assistindo ainda)", "Quem está assistindo", "Trocar tela ou janela", "Quem está transmitindo"]);

        act(() => setState({ ...EMPTY, local: { ...LOCAL, viewers: ["peerA"] } }));
        assert.equal(items()[0], "Parar transmissão (1 pessoa assistindo)");
        act(() => setState({ ...EMPTY, local: { ...LOCAL, viewers: ["peerA", "peerB"] } }));
        assert.equal(items()[0], "Parar transmissão (2 pessoas assistindo)");

        fireEvent.click(item("Quem está assistindo"));
        assert.equal(modals.list().length, 1);
        fireEvent.click(item("Trocar tela ou janela"));
        assert.equal(modals.list().length, 2);
        fireEvent.click(item("Quem está transmitindo"));
        assert.equal(modals.list().length, 3);
        await settle();
    });

    test("entrar e sair da call atualiza o item sem recarregar o menu", () => {
        render(<Toolbox />);
        assert.equal(items()[0], "Transmitir com Telinha (entre numa call)");
        act(() => SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID));
        assert.equal(items()[0], "Transmitir com Telinha");
        act(() => SelectedChannelStore.setVoiceChannel(null));
        assert.equal(items()[0], "Transmitir com Telinha (entre numa call)");
    });
});

describe("menu de contexto de um usuario", () => {
    test("sem usuario no menu: nao acrescenta nada", () => {
        const children = contextMenu(undefined);
        assert.deepEqual(children, []);
    });

    test("alguem que nao transmite nem assiste a voce: nao acrescenta nada", () => {
        setState({ ...EMPTY, peers: [streamer({ streaming: false })], local: { ...LOCAL, viewers: [] } });
        const children = contextMenu(FRIEND_ID);
        assert.deepEqual(children, []);
        assert.equal(contextMenu("999").length, 0, "usuario desconhecido");
    });

    test("amigo transmitindo: 'Assistir transmissao Telinha' abre o visualizador dele", async () => {
        setState({ ...EMPTY, peers: [streamer()] });
        contextMenu(FRIEND_ID);
        assert.deepEqual(items(), ["Assistir transmissão Telinha"]);
        assert.ok(screen.getByRole("menuitem").querySelector("svg"), "com o icone do Telinha");

        fireEvent.click(item("Assistir transmissão Telinha"));
        await settle();
        assert.equal(PopoutActions.opened.length, 1);
        assert.match(PopoutActions.opened[0].key, new RegExp(FRIEND_ID));
    });

    test("amigo transmitindo que voce ja esta assistindo: o item vira 'Abrir'", () => {
        setState({ ...EMPTY, peers: [streamer()], viewing: { peerA: { peerId: "peerA", stream: null, status: "playing" } } });
        contextMenu(FRIEND_ID);
        assert.deepEqual(items(), ["Abrir transmissão Telinha"]);
    });

    test("voce transmite: o seu proprio menu oferece parar a transmissao; sem transmitir, nada", () => {
        setState({ ...EMPTY, local: LOCAL });
        const children = contextMenu(ME_ID);
        assert.deepEqual(items(), ["Parar transmissão Telinha"]);
        assert.equal(children.length, 1);

        resetState();
        assert.deepEqual(contextMenu(ME_ID), []);
    });

    test("quem esta recebendo a sua transmissao: 'Expulsar...' em vermelho; todas as conexoes dele contam", () => {
        setState({
            ...EMPTY,
            peers: [streamer({ streaming: false }), streamer({ peerId: "peerB", streaming: false }), streamer({ peerId: "peerC", discordUserId: OTHER_ID, streaming: false })],
            local: { ...LOCAL, viewers: ["peerB", "peerC"] }
        });
        contextMenu(FRIEND_ID);
        assert.deepEqual(items(), ["Expulsar da sua transmissão Telinha"]);
        assert.equal(item(/Expulsar/).getAttribute("data-color"), "danger");
    });

    test("quem transmite e tambem assiste a voce: os dois itens no mesmo grupo", () => {
        setState({ ...EMPTY, peers: [streamer()], local: { ...LOCAL, viewers: ["peerA"] } });
        contextMenu(FRIEND_ID);
        assert.deepEqual(items(), ["Assistir transmissão Telinha", "Expulsar da sua transmissão Telinha"]);
        assert.equal(screen.getAllByRole("group").length, 1);
    });
});

describe("as acoes dos menus em uma call de verdade", () => {
    let call: Call;

    before(async () => {
        resetVencordFakes();
        realCore = true;
        call = await joinCall();
        pluginSettings.set("requireVerifiedIdentity", false);
        await friendArrives(call.room, "peerA", { streaming: true });
        await goLive({ access: "all" });
        call.room.receive("watch", { op: "start" }, "peerA");
        await eventually(() => getState().local?.viewers.includes("peerA"));
    });

    after(() => {
        call.close();
    });

    test("o menu do amigo: assistir a transmissao dele manda o pedido de verdade", async () => {
        contextMenu(FRIEND_ID);
        fireEvent.click(item("Assistir transmissão Telinha"));
        await settle();
        assert.ok(call.room.sentOn("watch", "peerA").some(m => (m.data as { op: string; }).op === "start"));
        assert.equal(PopoutActions.opened.length, 1);
    });

    test("'Expulsar da sua transmissao': ele sai da transmissao, fica bloqueado e voce ve o aviso", async () => {
        contextMenu(FRIEND_ID);
        fireEvent.click(item("Expulsar da sua transmissão Telinha"));
        await eventually(() => !getState().local?.viewers.includes("peerA"));
        assert.deepEqual(getState().blocked?.map(b => [b.discordUserId, b.reason]), [[FRIEND_ID, "kicked"]]);
        assert.deepEqual(toasts, [{ text: "amigo foi removido da sua transmissão", variant: "success" }]);
    });

    test("'Parar transmissao' no seu menu de contexto encerra a transmissao", async () => {
        contextMenu(ME_ID);
        fireEvent.click(item("Parar transmissão Telinha"));
        await eventually(() => getState().local === null);
    });

    test("'Parar transmissao' na caixa de ferramentas tambem", async () => {
        await goLive({ access: "all" });
        await eventually(() => getState().local);
        render(<Toolbox />);
        fireEvent.click(item(/^Parar transmissão/));
        await settle(); // the menu re-renders when the core publishes "no stream"
        assert.equal(getState().local, null);
        assert.equal(screen.getByRole("menuitem", { name: /^Transmitir com Telinha/ }).textContent, "Transmitir com Telinha");
    });
});
