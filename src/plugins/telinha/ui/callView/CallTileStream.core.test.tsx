/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A tile da call com o nucleo de verdade por tras (sala, amigo transmitindo, pedido de assistir, senha, janela do
// visualizador): clicar e conferir o que o nucleo mandou pela sala (room.sentOn("watch")) e o que o transmissor
// responde. Os estados e controles isolados estao em CallTileStream.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/CallTileStream.core.test.tsx

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { unwatch } from "@plugins/telinha/actions";
import { buildHello, STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import { closeAllViewers, isViewerOpen } from "@plugins/telinha/ui/viewerWindows";
import { getVolume, setVolume } from "@plugins/telinha/ui/volumes";
import { useFakeClock } from "@test/fakes/clock";
import { media, resetMedia, resizeObservers } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, screen, settle, waitFor, within } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, loggerLines, PopoutActions, PopoutWindowStore, toasts } from "@test/fakes/vencord";
import { captureStream, type FakeRTCPeerConnection, type FakeRTCRtpTransceiver, videoReceiverStats } from "@test/fakes/webrtc";
import { NONCE, startStreamer, type Streamer } from "@test/helpers/wpe-core";
import { animations, assertAbsent, installAnimate } from "@test/helpers/wpe-dom";
import type { ReactNode } from "react";

import { CallTileStream } from "./CallTileStream";
import { isTileOwned, resetTileState, setLocalPreviewHidden } from "./tileState";

const POPOUT_KEY = `DISCORD_TELINHA_VIEWER_${FRIEND_ID}`;

const tile = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const watchButton = () => screen.getByRole("button", { name: "Assistir a transmissão de amigo pelo Telinha" });
const screenStream = (audio = false) => captureStream({ audio }) as unknown as MediaStream;

describe("CallTileStream com o nucleo de verdade", () => {
    let streamer: Streamer;
    let restoreAnimate: () => void;

    before(async () => {
        restoreAnimate = installAnimate();
        streamer = await startStreamer();
    });

    after(async () => {
        restoreAnimate();
        await streamer.stop();
    });

    beforeEach(() => {
        resetMedia();
        animations.reset();
        PopoutActions.reset();
        PopoutWindowStore.reset();
        toasts.length = 0;
        loggerLines.length = 0;
        streamer.room.sent.length = 0;
        setVolume(FRIEND_ID, { volume: 1, muted: false }); // o volume lembrado por amigo vive o processo inteiro
    });

    afterEach(async () => {
        cleanup();
        await act(async () => {
            closeAllViewers();
            unwatch(streamer.peerId);
            resetTileState();
            setLocalPreviewHidden(false);
        });
        await settle();
        streamer.announce({ streaming: true, hasAudio: false });
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    /** Clica em "TELINHA · Assistir" e deixa o nucleo publicar a sessao */
    async function startWatching() {
        const view = render(<CallTileStream userId={FRIEND_ID} />);
        fireEvent.click(watchButton());
        await settle();
        return view;
    }

    test("clicar em \"Assistir\" manda o pedido ao transmissor e a tile mostra a conexao; ele pede aprovacao", async () => {
        const { container } = render(<CallTileStream userId={FRIEND_ID} />);
        assert.equal(streamer.watchMessages().length, 0, "so a etiqueta: ninguem pediu nada");

        fireEvent.click(watchButton());
        await settle();
        assert.deepEqual(streamer.watchMessages(), [{ op: "start" }]);
        assert.equal(isTileOwned(streamer.peerId), true);
        assert.ok(screen.getByText("Conectando…"));
        assertAbsent(screen.queryByRole("button", { name: "Tentar de novo" }));

        streamer.reply({ op: "pending" });
        await settle();
        assert.ok(screen.getByText("Aguardando o transmissor aprovar…"));
        assertAbsent(tile(container).querySelector("video"));
    });

    test("transmissao com senha: digita, so a prova sai, errou: tenta de novo, errou demais: acabou", async () => {
        await startWatching();
        streamer.reply({ op: "password", nonce: NONCE, attemptsLeft: 5 });
        await settle();
        assert.ok(screen.getByText("Esta transmissão é com senha"));

        fireEvent.change(screen.getByLabelText("Senha da transmissão"), { target: { value: "gato-42" } });
        fireEvent.click(screen.getByRole("button", { name: "Assistir" }));
        await waitFor(() => assert.equal(streamer.watchMessages().length, 2));
        const proofMessage = streamer.watchMessages()[1];
        assert.equal(proofMessage.op, "start");
        assert.match(proofMessage.proof!, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(JSON.stringify(streamer.room.sent).includes("gato-42"), false, "a senha em si nunca sai do PC");
        assert.ok(screen.getByText("Conferindo a senha…"));

        streamer.reply({ op: "password", nonce: NONCE, attemptsLeft: 4, wrong: true });
        await settle();
        assert.ok(screen.getByText("Senha incorreta"));
        assert.match(screen.getByText("Senha incorreta").parentElement!.textContent!, /Restam 4 tentativas\./);
        assert.equal((screen.getByLabelText("Senha da transmissão") as HTMLInputElement).value, "", "campo limpo para a nova tentativa");

        streamer.reply({ op: "denied", reason: "tooManyAttempts" });
        await settle();
        assert.ok(screen.getByText("Senha errada vezes demais"));
        assert.ok(screen.getByRole("button", { name: "Tentar de novo" }));
    });

    test("recusado: \"Tentar de novo\" pede outra vez; \"Fechar\" para de assistir e volta a etiqueta", async () => {
        await startWatching();
        streamer.reply({ op: "denied", reason: "kicked" });
        await settle();
        assert.ok(screen.getByText("O transmissor encerrou sua visualização"));

        fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
        await settle();
        assert.deepEqual(streamer.watchMessages(), [{ op: "start" }, { op: "start" }]);
        assert.ok(screen.getByText("Conectando…"));

        streamer.reply({ op: "denied", reason: "declined" });
        await settle();
        fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
        await settle();
        assert.equal(streamer.watchMessages().at(-1)?.op, "stop");
        assert.equal(isTileOwned(streamer.peerId), false);
        assert.ok(watchButton(), "a etiqueta \"Assistir\" voltou");
    });

    test("o stream chega: aparece o video na tile; \"Parar de assistir\" manda um unico stop", async () => {
        const { container } = await startWatching();
        const incoming = screenStream();
        streamer.room.emitStream(streamer.peerId, incoming, { kind: STREAM_KIND_SCREEN });
        await settle();

        const v = tile(container).querySelector("video")!;
        assert.ok(v.srcObject === incoming);
        assert.ok(media.played.includes(v));
        assert.ok(screen.getByText("Aguardando a primeira imagem…"), "ainda sem quadro decodificado");

        fireEvent.mouseMove(tile(container));
        fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
        await settle();
        assert.deepEqual(streamer.watchMessages().filter(m => m.op === "stop"), [{ op: "stop" }]);
        assert.equal(getState().viewing[streamer.peerId], undefined);
        assertAbsent(tile(container).querySelector("video"));
        assert.ok(watchButton());
    });

    test("o primeiro quadro decodificado tira o aviso e deixa so a imagem", async () => {
        const { container } = await startWatching();
        const incoming = screenStream();
        const pc = streamer.room.peers.get(streamer.peerId) as unknown as FakeRTCPeerConnection;
        const transceiver: FakeRTCRtpTransceiver = pc.addReceivingTrack(incoming.getVideoTracks()[0] as never);
        streamer.room.emitStream(streamer.peerId, incoming, { kind: STREAM_KIND_SCREEN });
        await settle();
        assert.ok(screen.getByText("Aguardando a primeira imagem…"));

        transceiver.receiver.stats = videoReceiverStats({ framesDecoded: 5 });
        await waitFor(() => assert.equal(getState().viewing[streamer.peerId]?.status, "playing"));
        assertAbsent(screen.queryByText("Aguardando a primeira imagem…"));
        assert.ok(tile(container).querySelector("video"));
    });

    test("o amigo para de transmitir enquanto voce assiste: avisa, e so da para fechar", async () => {
        await startWatching();
        streamer.announce({ streaming: false });
        await settle();
        assert.ok(screen.getByText("A transmissão terminou"));
        assertAbsent(screen.queryByRole("button", { name: "Tentar de novo" }));
        assert.ok(screen.getByRole("button", { name: "Fechar" }));
    });

    test("o amigo sai da call: a tile dele some", async () => {
        const { container } = await startWatching();
        streamer.room.disconnectPeer(streamer.peerId);
        await settle();
        assert.equal(container.innerHTML, "");
        // volta, como se tivesse reconectado, para os proximos testes
        await act(async () => {
            await streamer.room.connectPeer(streamer.peerId, { hello: buildHello(FRIEND_ID, "amigo") });
            streamer.announce({ streaming: true });
        });
        await settle();
    });

    describe("\"Abrir em janela\"", () => {
        async function withStream(audio: boolean) {
            streamer.announce({ streaming: true, hasAudio: audio });
            const view = await startWatching();
            streamer.room.emitStream(streamer.peerId, screenStream(audio), { kind: STREAM_KIND_SCREEN });
            await settle();
            fireEvent.mouseMove(tile(view.container));
            return view;
        }

        test("abre o pop-out, a tile larga a sessao e o som fica so na janela; clicar de novo foca a janela", async () => {
            const { container } = await withStream(true);
            const v = tile(container).querySelector("video")!;
            assert.equal(v.muted, false, "antes da janela, a tile toca o som");
            assert.ok(screen.getByLabelText("Volume"));

            fireEvent.click(screen.getByRole("button", { name: "Abrir em janela" }));
            await settle();
            assert.equal(PopoutActions.opened.length, 1);
            assert.equal(PopoutActions.opened[0].key, POPOUT_KEY);
            assert.equal(isTileOwned(streamer.peerId), false, "a janela cuida da sessao agora");
            assert.equal(isViewerOpen(streamer.peerId), true);

            const show = screen.getByRole("button", { name: "Mostrar a janela" });
            assert.equal(show.textContent, "Mostrar janela");
            assert.ok(screen.getByText("Som na janela"));
            assertAbsent(screen.queryByLabelText("Volume"));
            assert.equal(v.muted, true, "nunca o mesmo som nos dois lugares");
            act(() => resizeObservers.resize(tile(container), { width: 250, height: 140 }));
            assertAbsent(screen.queryByText("Som na janela"), "tile estreita: sem o texto");
            assert.equal(screen.getByRole("button", { name: "Mostrar a janela" }).textContent, "");

            fireEvent.click(screen.getByRole("button", { name: "Mostrar a janela" }));
            await settle();
            assert.equal(PopoutActions.opened.length, 1, "nao abriu outra");
            assert.equal(PopoutWindowStore.getWindow(POPOUT_KEY)!.focused, 1);
        });

        test("o volume ajustado na tile vale na janela que abre; o que se ajusta na janela chega na tile que segue montada", async () => {
            const { container } = await withStream(true);
            const tileVideo = tile(container).querySelector("video")!;
            fireEvent.change(screen.getByLabelText("Volume"), { target: { value: "30" } });
            assert.equal(tileVideo.volume, 0.3);

            fireEvent.click(screen.getByRole("button", { name: "Abrir em janela" }));
            await settle();
            const win = render(PopoutActions.opened[0].render() as ReactNode); // o conteudo que o Discord poe no pop-out
            await settle();
            const winVideo = win.container.querySelector("video")!;
            const winSlider = within(win.container).getByLabelText("Volume") as HTMLInputElement;
            assert.equal(winSlider.value, "30", "a janela nasce com o volume da tile");
            assert.equal(winVideo.volume, 0.3);
            assert.equal(winVideo.muted, false);
            assert.equal(tileVideo.muted, true, "o som toca so na janela");

            fireEvent.change(winSlider, { target: { value: "70" } });
            assert.equal(winVideo.volume, 0.7);
            assert.equal(tileVideo.volume, 0.7, "a tile segue montada, com o mesmo <video>, e ja tem o volume novo");
            assert.ok(tile(container).querySelector("video") === tileVideo);
            assert.equal(tileVideo.muted, true, "continua calada: nunca o mesmo som nos dois lugares");

            fireEvent.click(within(win.container).getByRole("button", { name: "Silenciar" }));
            assert.deepEqual(getVolume(FRIEND_ID), { volume: 0.7, muted: true });
            assert.equal(winVideo.muted, true);
        });

        test("\"Parar de assistir\" na tile com a janela aberta fecha a janela e para de assistir (um unico stop)", async () => {
            const { container } = await withStream(false);
            fireEvent.click(screen.getByRole("button", { name: "Abrir em janela" }));
            await settle();

            fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
            await settle();
            assert.deepEqual(PopoutActions.closed, [POPOUT_KEY]);
            assert.deepEqual(streamer.watchMessages().filter(m => m.op === "stop"), [{ op: "stop" }]);
            assert.equal(isViewerOpen(streamer.peerId), false);
            assert.ok(within(container).getByRole("button", { name: "Assistir a transmissão de amigo pelo Telinha" }));
        });

        test("em tela cheia: sai da tela cheia antes de abrir a janela", async () => {
            const { container } = await withStream(false);
            fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
            await settle();
            assert.ok(document.fullscreenElement === tile(container));

            fireEvent.click(screen.getByRole("button", { name: "Abrir em janela" }));
            await settle();
            assertAbsent(document.fullscreenElement);
            assert.equal(PopoutActions.opened.length, 1);
        });

        test("a tile confere de 1,5 em 1,5 s se a janela ainda existe (quando o Discord nao avisa)", async t => {
            const clock = useFakeClock(t);
            PopoutActions.autoOpen = false; // o Discord nao reporta a janela aberta: so o relogio da tile percebe
            const { container } = await withStream(false);
            fireEvent.click(screen.getByRole("button", { name: "Abrir em janela" }));
            await settle();
            assert.equal(screen.getByRole("button", { name: "Abrir em janela" }).textContent, "Abrir em janela", "ainda nao percebeu");

            act(() => clock.tick(1500));
            assert.ok(screen.getByRole("button", { name: "Mostrar a janela" }));

            fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
            await settle();
            assert.ok(within(container).getByRole("button", { name: "Assistir a transmissão de amigo pelo Telinha" }), "a sessao acabou: volta a etiqueta");
        });
    });
});
