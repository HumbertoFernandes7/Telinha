/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do modal "Quem está transmitindo" (ui/StreamersModal.tsx), aberto de verdade pelo openStreamersModal():
// a lista de quem transmite na call (nome, selo de identidade, modo de acesso, resumo, aviso de identidade duplicada),
// a sua propria transmissao com Quem assiste / Trocar / Parar, os alertas de identidade e as mensagens de lista vazia.
// Primeiro com o estado do Telinha (setState), depois com o nucleo de verdade (assistir manda o pedido ao transmissor;
// Parar encerra a transmissao).
// Rodar:  pnpm test:file src/plugins/telinha/ui/StreamersModal.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getState, resetState, setState } from "@plugins/telinha/store";
import type { IdentityAlert, LocalStream, RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { act, fireEvent, screen, settle, within } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, makeUser, modals, OTHER_ID, PopoutActions, resetVencordFakes, SelectedChannelStore, toasts, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { type LiveScene, openLiveScene } from "@test/helpers/wpf-live";
import { openInHost, until } from "@test/helpers/wpf-modal";

import { openStreamersModal } from "./StreamersModal";
import { closeAllViewers, isViewerOpen } from "./viewerWindows";

const EMPTY: TelinhaState = { inRoom: true, channelId: VOICE_CHANNEL_ID, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

function friend(patch: Partial<RemotePeer> = {}): RemotePeer {
    return {
        peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" },
        ...patch
    };
}

function mine(patch: Partial<LocalStream> = {}): LocalStream {
    return { source: { id: "screen:0:0", name: "Tela inteira", kind: "screen" }, quality: "1080p60", hasAudio: false, startedAt: 0, viewers: [], access: "all", ...patch };
}

const show = (state: Partial<TelinhaState>) => act(() => setState({ ...EMPTY, ...state }));
const rows = () => [...document.querySelectorAll(".vc-telinha-streamer")] as HTMLElement[];
const nameOf = (row: HTMLElement) => row.querySelector(".vc-telinha-streamer-name")?.textContent;

describe("StreamersModal (so com o estado do Telinha)", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
        UserStore.addUsers(makeUser(FRIEND_ID, "ana_dev", { globalName: "Ana" }), makeUser(OTHER_ID, "beto"));
    });

    afterEach(async () => {
        await act(async () => closeAllViewers());
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    describe("lista vazia", () => {
        test("fora de um canal de voz: pede para entrar numa call", () => {
            show({ inRoom: false, channelId: null });
            const modal = openInHost(openStreamersModal);
            assert.equal(modal.title(), "Quem está transmitindo");
            assert.match(modal.text(), /Transmissões pelo Telinha na sua call de voz\. Cada uma abre numa janela própria\./);
            screen.getByText("Entre num canal de voz para ver quem está transmitindo pelo Telinha.");
            assert.deepEqual(rows(), []);
        });

        test("na sala do Telinha mas ninguem transmite: avisa que ninguem transmite", () => {
            show({});
            openInHost(openStreamersModal);
            screen.getByText("Ninguém está transmitindo pelo Telinha nesta call agora.");
        });

        test("no canal de voz do Discord, antes da sala do Telinha ficar pronta: tambem diz que ninguem transmite", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            show({ inRoom: false, channelId: null });
            openInHost(openStreamersModal);
            screen.getByText("Ninguém está transmitindo pelo Telinha nesta call agora.");
        });

        test("quem esta na sala mas nao transmite nao entra na lista", () => {
            show({ peers: [friend({ streaming: false, stream: undefined })] });
            openInHost(openStreamersModal);
            assert.deepEqual(rows(), []);
            screen.getByText(/Ninguém está transmitindo/);
        });

        test("Fechar fecha o modal", () => {
            show({});
            const modal = openInHost(openStreamersModal);
            modal.click("Fechar");
            assert.equal(modals.list().length, 0);
        });
    });

    describe("quem transmite na call", () => {
        test("amigo transmitindo a tela: nome do Discord, selo, resumo e o botao Assistir", () => {
            show({ peers: [friend()] });
            openInHost(openStreamersModal);

            const [row] = rows();
            assert.equal(nameOf(row), "Ana", "o nome do Discord do id anunciado, nao o apelido anunciado");
            assert.equal(row.querySelector(".vc-telinha-id-badge")?.textContent, "✔ verificado");
            assert.equal(row.querySelector(".vc-telinha-access-badge"), null, "Todos da call nao tem etiqueta");
            assert.equal(row.querySelector(".vc-telinha-streamer-meta")?.textContent, "Tela inteira · 1080p · 60 fps · com som");
            assert.equal(within(row).getByRole("button", { name: "Assistir" }).dataset.variant, "primary");
            assert.equal(screen.queryByText(/Ninguém está transmitindo/), null);
        });

        test("modo de acesso aparece como etiqueta (com o modo por extenso no tooltip) e quem esta fora do canal de voz e marcado", () => {
            show({
                peers: [friend({
                    admitted: false,
                    stream: { kind: "window", title: "Jogo", hasAudio: false, width: 1280, height: 720, fps: 0, access: "password" }
                })]
            });
            openInHost(openStreamersModal);

            const [row] = rows();
            const badge = row.querySelector(".vc-telinha-access-badge")!;
            assert.equal(badge.textContent, "🔒 com senha");
            assert.equal(badge.getAttribute("title"), "Quem pode assistir: Com senha");
            assert.equal(row.querySelector(".vc-telinha-streamer-meta")?.textContent, "Janela: Jogo · 720p · sem som · fora do seu canal de voz");
        });

        test("varias transmissoes: uma linha para cada, na ordem; so quem transmite aparece", () => {
            show({
                peers: [
                    friend({ peerId: "peerA" }),
                    friend({ peerId: "peerB", discordUserId: OTHER_ID, username: "beto", identity: "unverified" }),
                    friend({ peerId: "peerC", streaming: false, stream: undefined })
                ]
            });
            openInHost(openStreamersModal);
            assert.deepEqual(rows().map(nameOf), ["Ana", "beto"]);
            assert.equal(rows()[1].querySelector(".vc-telinha-id-badge")?.textContent, "não verificado");
        });

        test("sem identidade (recurso desligado ou versao antiga): sem selo", () => {
            show({ peers: [friend({ identity: undefined })] });
            openInHost(openStreamersModal);
            assert.equal(rows()[0].querySelector(".vc-telinha-id-badge"), null);
        });

        test("quem voce ja esta assistindo mostra Abrir janela em vez de Assistir", () => {
            show({
                peers: [friend({ peerId: "peerA" }), friend({ peerId: "peerB", discordUserId: OTHER_ID, username: "beto" })],
                viewing: { peerB: { peerId: "peerB", stream: null, status: "playing" } }
            });
            openInHost(openStreamersModal);
            const [a, b] = rows();
            within(a).getByRole("button", { name: "Assistir" });
            const open = within(b).getByRole("button", { name: "Abrir janela" });
            assert.equal(open.dataset.variant, "secondary");
        });

        test("Assistir abre a janela do visualizador dessa pessoa e fecha o modal", () => {
            show({ peers: [friend()] });
            openInHost(openStreamersModal);
            fireEvent.click(within(rows()[0]).getByRole("button", { name: "Assistir" }));

            assert.equal(isViewerOpen("peerA"), true);
            assert.equal(PopoutActions.opened.length, 1);
            assert.match(PopoutActions.opened[0].key, new RegExp(FRIEND_ID));
            assert.equal(modals.list().length, 0, "o modal fechou");
        });

        test("identidade duplicada: o aviso da conexao usa o texto do alerta; sem alerta, a frase padrao", () => {
            const alert: IdentityAlert = { discordUserId: FRIEND_ID, username: "amigo", peerIds: ["peerA", "peerB"], self: false };
            show({
                peers: [
                    friend({ peerId: "peerA", duplicateIdentity: true }),
                    friend({ peerId: "peerX", discordUserId: OTHER_ID, username: "beto", duplicateIdentity: true }),
                    friend({ peerId: "peerY", discordUserId: "400000000000000009", username: "carla" })
                ],
                identityAlerts: [alert]
            });
            openInHost(openStreamersModal);

            const warnings = [...document.querySelectorAll(".vc-telinha-streamers .vc-telinha-streamer .vc-telinha-viewer-warning")].map(w => w.textContent!.trim());
            assert.deepEqual(warnings, [
                "Duas conexões dizem ser Ana — uma pode ser falsa",
                "Outra conexão diz ser essa pessoa — uma pode ser falsa"
            ], "so a conexao com identidade duplicada tem aviso");
        });
    });

    describe("alertas de identidade no topo", () => {
        const alerts: IdentityAlert[] = [
            { discordUserId: "100000000000000001", username: "eu", peerIds: ["p1"], self: true },
            { discordUserId: FRIEND_ID, username: "amigo", peerIds: ["p2", "p3"], self: false },
            { discordUserId: FRIEND_ID, username: "amigo", peerIds: ["p4"], self: false, kind: "impostor" },
            { discordUserId: OTHER_ID, username: "beto", peerIds: ["p5"], self: false, kind: "fake" }
        ];

        test("um aviso para cada alerta, com a frase pronta; so a prova falsa leva o selo de identidade falsa", () => {
            show({ identityAlerts: alerts });
            openInHost(openStreamersModal);

            const texts = screen.getAllByRole("status").map(a => a.textContent);
            assert.deepEqual(texts, [
                "Uma conexão na call diz ser você — alguém pode estar se passando por você.",
                "Duas conexões dizem ser Ana — uma pode ser falsa.",
                "Uma conexão não verificada diz ser Ana, que já provou a identidade — só ela fica bloqueada.",
                "Uma conexão apresentou uma prova de identidade falsa de beto — ignorada.✖ identidade falsa"
            ]);
            assert.equal(screen.getAllByText("✖ identidade falsa").length, 1);
        });
    });

    describe("a sua transmissao", () => {
        test("tela inteira: sua linha com o modo de acesso e quantos assistem; nao aparece o aviso de lista vazia", () => {
            UserStore.setCurrentUser(makeUser("100000000000000001", "humberto", { globalName: "Humberto" }));
            show({ local: mine() });
            openInHost(openStreamersModal);

            const [row] = rows();
            assert.equal(nameOf(row), "Humberto (você)");
            assert.equal(row.querySelector(".vc-telinha-streamer-meta")?.textContent, "Tela inteira · Todos da call · ninguém assistindo ainda");
            assert.deepEqual(within(row).getAllByRole("button").map(b => b.textContent), ["Quem assiste", "Trocar", "Parar"]);
            assert.equal(within(row).getByRole("button", { name: "Parar" }).dataset.variant, "dangerPrimary");
            assert.equal(screen.queryByText(/Ninguém está transmitindo/), null, "voce transmite: a lista nao esta vazia");
        });

        test("janela com senha e dois assistindo", () => {
            show({ local: mine({ source: { id: "window:1:0", name: "Jogo", kind: "window" }, access: "password", viewers: ["peerA", "peerB"] }) });
            openInHost(openStreamersModal);
            assert.equal(rows()[0].querySelector(".vc-telinha-streamer-meta")?.textContent, "Janela: Jogo · Com senha · 2 pessoas assistindo");
        });

        test("sem usuario do Discord conhecido, o nome cai para Voce", () => {
            UserStore.setCurrentUser(null);
            show({ local: mine() });
            openInHost(openStreamersModal);
            assert.equal(nameOf(rows()[0]), "Você (você)");
        });

        test("a sua linha vem antes das dos amigos", () => {
            show({ local: mine(), peers: [friend()] });
            openInHost(openStreamersModal);
            assert.deepEqual(rows().map(nameOf), ["eu (você)", "Ana"]);
        });

        test("Quem assiste fecha este modal e abre a lista de espectadores", () => {
            show({ local: mine() });
            openInHost(openStreamersModal);
            fireEvent.click(screen.getByRole("button", { name: "Quem assiste" }));

            assert.equal(modals.list().length, 1);
            assert.equal(document.querySelector("h1")?.textContent, "Quem está assistindo");
        });

        test("Trocar fecha este modal e abre o seletor de fonte em modo Trocar", async () => {
            show({ local: mine() });
            openInHost(openStreamersModal);
            fireEvent.click(screen.getByRole("button", { name: "Trocar" }));
            await settle();

            assert.equal(modals.list().length, 1);
            assert.equal(document.querySelector("h1")?.textContent, "Trocar o que você transmite");
        });
    });
});

describe("StreamersModal com o nucleo de verdade", () => {
    let scene: LiveScene;

    before(async () => {
        scene = await openLiveScene();
        await scene.connect("peerA", FRIEND_ID, "amigo");
    });

    after(() => scene.close());

    beforeEach(() => scene.resetUi());

    afterEach(async () => {
        await act(async () => closeAllViewers());
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    test("um amigo comeca a transmitir: aparece na lista; Assistir manda o pedido ao transmissor", async () => {
        openInHost(openStreamersModal);
        screen.getByText("Ninguém está transmitindo pelo Telinha nesta call agora.");

        act(() => scene.peerStreams("peerA", FRIEND_ID, "amigo", { access: "approval" }));
        await settle();
        assert.equal(screen.queryByText(/Ninguém está transmitindo/), null);
        const [row] = rows();
        assert.equal(nameOf(row), "Amigo", "apelido global do Discord");
        assert.equal(row.querySelector(".vc-telinha-access-badge")?.textContent, "✋ com aprovação");
        assert.equal(row.querySelector(".vc-telinha-id-badge")?.textContent, "não verificado", "o amigo nao mandou id_token");

        fireEvent.click(within(row).getByRole("button", { name: "Assistir" }));
        await settle();
        assert.equal(modals.list().length, 0);
        assert.deepEqual(scene.room.sentOn("watch", "peerA").map(m => m.data), [{ op: "start" }], "o pedido foi para o transmissor");
    });

    test("voce comeca a transmitir: a sua linha aparece; Parar encerra a transmissao de verdade", async () => {
        openInHost(openStreamersModal);
        await act(async () => scene.goLive({ access: "approval", kind: "window" }));
        await settle();
        const own = rows().find(r => nameOf(r)?.endsWith("(você)"))!;
        assert.equal(own.querySelector(".vc-telinha-streamer-meta")?.textContent, "Janela: Jogo · Só quem eu aprovar · ninguém assistindo ainda");

        fireEvent.click(within(own).getByRole("button", { name: "Parar" }));
        await until(() => getState().local === null);
        await settle();
        assert.equal(rows().find(r => nameOf(r)?.endsWith("(você)")), undefined, "a sua linha sumiu");
        assert.deepEqual(toasts, []);
    });
});
