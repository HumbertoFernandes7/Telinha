/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O clique na etiqueta TELINHA de um amigo, com o nucleo de verdade por tras (wpe-core: canal de voz com um amigo que
// ja transmite): leva para a tela da call (ChannelRouter), foca a tile do amigo (CHANNEL_RTC_SELECT_PARTICIPANT) e
// assiste NELA, como o "Assistir" da tile (o pedido sai pela sala: room.sentOn("watch")). Nunca abre a janela separada;
// se a tile nao aparece na call em 3 s, o painel flutuante dentro do Discord. Renderizacao e tooltip: VoiceUserTag.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/VoiceUserTag.core.test.tsx

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { unwatch } from "@plugins/telinha/actions";
import { useFakeClock } from "@test/fakes/clock";
import { resetMedia } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, screen, settle } from "@test/fakes/render";
import {
    caughtErrors, ChannelRouter, ChannelRTCStore, FluxDispatcher, FRIEND_ID, GUILD_ID, loggerLines, NavigationRouter, OTHER_ID,
    PopoutActions, PopoutWindowStore, SelectedChannelStore, toasts, VOICE_CHANNEL_ID
} from "@test/fakes/vencord";
import { startStreamer, type Streamer } from "@test/helpers/wpe-core";
import { animations, installAnimate } from "@test/helpers/wpe-dom";

import { CallTileStream } from "./callView/CallTileStream";
import { isTileOwned, NO_TILE_FALLBACK_MS, resetTileState } from "./callView/tileState";
import { closeAllViewers, isViewerOpen, openViewer } from "./viewerWindows";
import { VoiceUserTag } from "./VoiceUserTag";

const tag = () => screen.getByRole("button", { name: /^Transmitindo pelo Telinha/ });
const selects = () => FluxDispatcher.dispatched.filter(a => a.type === "CHANNEL_RTC_SELECT_PARTICIPANT");
const panels = () => Array.from(document.body.querySelectorAll<HTMLElement>(".vc-telinha-floating"));
const fellBack = () => loggerLines.some(l => l.level === "warn" && /Nenhuma tile de peerA apareceu/.test(String(l.args[0])));

describe("VoiceUserTag: o clique assiste dentro do Discord, na tela da call", () => {
    let streamer: Streamer;
    let restoreAnimate: () => void;
    const starts = () => streamer.watchMessages().filter(m => m.op === "start").length;

    before(async () => {
        restoreAnimate = installAnimate();
        streamer = await startStreamer();
    });

    after(async () => {
        restoreAnimate();
        await streamer.stop();
    });

    /** Ninguem assistindo, a tela do Discord em outro canal, nenhuma tile focada */
    async function freshCall() {
        cleanup();
        await act(async () => {
            closeAllViewers();
            unwatch(streamer.peerId);
            resetTileState();
        });
        await settle();
        PopoutActions.reset();
        PopoutWindowStore.reset();
        ChannelRouter.reset();
        NavigationRouter.reset();
        ChannelRTCStore.reset();
        FluxDispatcher.reset(); // so o registro do que foi despachado; as assinaturas do nucleo ficam
        SelectedChannelStore.setChannel(null);
        toasts.length = 0;
        loggerLines.length = 0;
        streamer.room.sent.length = 0;
    }

    beforeEach(async () => {
        resetMedia();
        animations.reset();
        await freshCall();
    });

    afterEach(async () => {
        await freshCall();
        assert.equal(panels().length, 0, "nenhum painel sobrou na tela");
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    /** Uma acao completa da etiqueta, e so uma */
    function assertOneWatchInCall() {
        assert.deepEqual(ChannelRouter.transitions, [VOICE_CHANNEL_ID], "abriu a tela da call do canal de voz");
        assert.deepEqual(selects(), [{ type: "CHANNEL_RTC_SELECT_PARTICIPANT", channelId: VOICE_CHANNEL_ID, id: FRIEND_ID }], "focou a tile do amigo");
        assert.equal(ChannelRTCStore.getSelectedParticipantId(VOICE_CHANNEL_ID), FRIEND_ID);
        assert.equal(starts(), 1, "pediu o stream uma vez");
        assert.equal(isTileOwned(streamer.peerId), true, "quem cuida da sessao e a tile, como no \"Assistir\"");
        assert.equal(isViewerOpen(streamer.peerId), false, "sem janela nem painel");
        assert.equal(PopoutActions.opened.length, 0, "nenhuma janela separada");
        assert.equal(panels().length, 0);
    }

    test("clique: abre a tela da call, foca a tile do amigo e assiste nela; nenhuma janela separada", async () => {
        render(<VoiceUserTag userId={FRIEND_ID} />);
        assert.equal(starts(), 0);
        fireEvent.click(tag());
        await settle();
        assertOneWatchInCall();
        assert.match(tag().getAttribute("aria-label")!, /clique para ver na tela da call$/, "o tooltip acompanha");
        assert.deepEqual(toasts, []);
    });

    test("a tile do amigo aparece na call: a transmissao toca ali e o painel flutuante nunca abre", async t => {
        const clock = useFakeClock(t);
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();

        // a tela da call que o Discord abriu desenha a tile do amigo (o patch da tile chama CallTileStream)
        render(<CallTileStream userId={FRIEND_ID} />);
        await settle();
        assert.ok(screen.getByText("Conectando…"), "a tile mostra a sessao que a etiqueta pediu");

        act(() => clock.tick(NO_TILE_FALLBACK_MS * 2));
        await settle();
        assert.equal(panels().length, 0);
        assert.equal(isTileOwned(streamer.peerId), true);
        assert.equal(fellBack(), false);
        assert.equal(starts(), 1);
    });

    test("nenhuma tile aparece em 3 s: a mesma sessao passa para o painel flutuante dentro do Discord", async t => {
        const clock = useFakeClock(t);
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();

        act(() => clock.tick(NO_TILE_FALLBACK_MS - 1));
        assert.equal(panels().length, 0, "ainda esperando a tile");
        act(() => clock.tick(1));
        await settle();
        assert.equal(panels().length, 1, "o painel flutuante");
        assert.ok(panels()[0].textContent!.includes("amigo — Telinha"));
        assert.equal(isViewerOpen(streamer.peerId), true);
        assert.equal(isTileOwned(streamer.peerId), false, "o painel cuida da sessao agora");
        assert.equal(PopoutActions.opened.length, 0, "nenhuma janela separada");
        assert.equal(starts(), 1, "a mesma sessao: nada foi pedido de novo");
        assert.ok(fellBack());

        closeAllViewers();
        act(() => clock.tick(0)); // o painel sai da tela num setTimeout(0)
        await settle();
    });

    test("duplo clique: uma acao so, e nem o clique nem o duplo clique chegam na linha do Discord", async () => {
        let rowClicks = 0;
        let rowDoubleClicks = 0;
        render(<div onClick={() => rowClicks++} onDoubleClick={() => rowDoubleClicks++}><VoiceUserTag userId={FRIEND_ID} /></div>);

        assert.equal(fireEvent.click(tag(), { detail: 1 }), false, "o clique e cancelado");
        fireEvent.click(tag(), { detail: 2 });
        assert.equal(fireEvent.doubleClick(tag(), { detail: 2 }), false, "o duplo clique tambem");
        await settle();
        assertOneWatchInCall();
        assert.equal(rowClicks, 0, "a linha nao abre o perfil nem entra no canal");
        assert.equal(rowDoubleClicks, 0);

        // o 2o clique de um duplo clique nao faz nada por si: mesmo com tudo desfeito, nada recomeca
        await freshCall();
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag(), { detail: 2 });
        fireEvent.doubleClick(tag(), { detail: 2 });
        await settle();
        assert.deepEqual(ChannelRouter.transitions, []);
        assert.deepEqual(selects(), []);
        assert.equal(starts(), 0);
    });

    test("Enter e espaco fazem o mesmo que o clique; outras teclas, nada", async () => {
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.keyDown(tag(), { key: "a" });
        fireEvent.keyDown(tag(), { key: "Escape" });
        await settle();
        assert.deepEqual(ChannelRouter.transitions, []);
        assert.equal(starts(), 0);

        fireEvent.keyDown(tag(), { key: "Enter" });
        await settle();
        assertOneWatchInCall();

        await freshCall();
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.keyDown(tag(), { key: " " });
        await settle();
        assertOneWatchInCall();
    });

    test("ja na tela da call com a tile do amigo em foco: nao navega nem refoca, so assiste", async () => {
        SelectedChannelStore.setChannel(VOICE_CHANNEL_ID);
        ChannelRTCStore.selectParticipant(VOICE_CHANNEL_ID, FRIEND_ID);
        FluxDispatcher.reset();
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        assert.deepEqual(ChannelRouter.transitions, []);
        assert.deepEqual(selects(), [], "clicar de novo na tile do Discord a desfocaria: nada e despachado");
        assert.equal(ChannelRTCStore.getSelectedParticipantId(VOICE_CHANNEL_ID), FRIEND_ID);
        assert.equal(starts(), 1);
        assert.equal(isTileOwned(streamer.peerId), true);
    });

    test("ja na tela da call com outra tile em foco: so passa o foco para o amigo", async () => {
        SelectedChannelStore.setChannel(VOICE_CHANNEL_ID);
        ChannelRTCStore.selectParticipant(VOICE_CHANNEL_ID, OTHER_ID);
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        assert.deepEqual(ChannelRouter.transitions, []);
        assert.equal(selects().length, 1);
        assert.equal(ChannelRTCStore.getSelectedParticipantId(VOICE_CHANNEL_ID), FRIEND_ID);
    });

    test("clicar de novo enquanto assiste na tile nao pede outra vez (nem abre nada)", async () => {
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        fireEvent.click(tag());
        await settle();
        assertOneWatchInCall();
    });

    test("a transmissao terminou ou deu erro na tile: clicar de novo pede outra vez, como \"Tentar de novo\"", async () => {
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        streamer.reply({ op: "denied", reason: "declined" });
        await settle();
        fireEvent.click(tag());
        await settle();
        assert.equal(starts(), 2);
        assert.equal(isTileOwned(streamer.peerId), true);
    });

    test("ja assistindo numa janela: nao abre outra nem pede de novo, so leva para a tela da call", async () => {
        openViewer(streamer.peerId);
        await settle();
        assert.equal(PopoutActions.opened.length, 1);
        assert.equal(starts(), 1);

        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        assert.deepEqual(ChannelRouter.transitions, [VOICE_CHANNEL_ID]);
        assert.equal(selects().length, 1);
        assert.equal(PopoutActions.opened.length, 1, "a mesma janela; a tile mostra a mesma transmissao");
        assert.equal(starts(), 1);
        assert.equal(isTileOwned(streamer.peerId), false, "a janela continua dona");
    });

    test("sem o ChannelRouter do Discord: abre a tela da call pela rota /channels/<servidor>/<canal>", async t => {
        t.mock.method(ChannelRouter, "transitionToChannel", () => {
            throw new Error("modulo nao encontrado");
        });
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        assert.deepEqual(NavigationRouter.paths, [`/channels/${GUILD_ID}/${VOICE_CHANNEL_ID}`]);
        assert.ok(loggerLines.some(l => l.level === "warn" && /ChannelRouter\.transitionToChannel falhou/.test(String(l.args[0]))));
        assert.equal(starts(), 1, "e assiste do mesmo jeito");
    });

    test("o Discord recusa a acao de foco (promessa rejeitada): fica no log e o resto segue", async t => {
        t.mock.method(FluxDispatcher, "dispatch", () => Promise.reject(new Error("acao desconhecida")));
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        assert.ok(loggerLines.some(l => l.level === "warn" && l.args[0] === "Não consegui destacar a tile na call"));
        assert.deepEqual(ChannelRouter.transitions, [VOICE_CHANNEL_ID]);
        assert.equal(starts(), 1);
    });

    test("nada do Discord para navegar ou focar funciona: so o log; assiste e o painel flutuante cobre", async t => {
        const clock = useFakeClock(t);
        t.mock.method(ChannelRouter, "transitionToChannel", () => {
            throw new Error("sem ChannelRouter");
        });
        t.mock.method(NavigationRouter, "transitionTo", () => {
            throw new Error("sem NavigationRouter");
        });
        t.mock.method(ChannelRTCStore, "getSelectedParticipantId", () => {
            throw new Error("sem ChannelRTCStore");
        });
        t.mock.method(FluxDispatcher, "dispatch", () => {
            throw new Error("acao desconhecida");
        });
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(tag());
        await settle();
        const warns = loggerLines.filter(l => l.level === "warn").map(l => String(l.args[0]));
        assert.ok(warns.includes("Não consegui abrir a tela da call"), warns.join(" | "));
        assert.ok(warns.includes("Não consegui destacar a tile na call"), warns.join(" | "));
        assert.equal(starts(), 1);
        assert.deepEqual(caughtErrors, []);

        act(() => clock.tick(NO_TILE_FALLBACK_MS));
        await settle();
        assert.equal(panels().length, 1, "sem tile na tela: o painel flutuante");
        closeAllViewers();
        act(() => clock.tick(0));
        await settle();
    });
});
