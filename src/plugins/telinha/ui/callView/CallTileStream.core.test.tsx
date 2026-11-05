/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A tile da call com o nucleo de verdade por tras (sala, amigo transmitindo, pedido de assistir, senha, janela do
// visualizador): clicar e conferir o que o nucleo mandou pela sala (room.sentOn("watch")) e o que o transmissor
// responde. A cena da janelinha (sair da tela da call, a mesma sessao seguir tocando, voltar para a tile) tambem e daqui:
// em nenhum passo o nucleo pode mandar um segundo "start" nem um "stop". Os estados e controles isolados estao em
// CallTileStream.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/CallTileStream.core.test.tsx

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import { unwatch } from "@plugins/telinha/actions";
import { buildHello, STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { getEventLog, getState } from "@plugins/telinha/store";
import { PIP_ENDED_CLOSE_MS } from "@plugins/telinha/ui/PipViewer";
import { closeAllViewers, isViewerOpen } from "@plugins/telinha/ui/viewerWindows";
import { getVolume, setVolume } from "@plugins/telinha/ui/volumes";
import { useFakeClock } from "@test/fakes/clock";
import { media, resetMedia, resizeObservers } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, screen, settle, waitFor, within } from "@test/fakes/render";
import { caughtErrors, ChannelRouter, FluxDispatcher, FRIEND_ID, joinVoice, loggerLines, PopoutActions, PopoutWindowStore, SelectedChannelStore, toasts, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { captureStream, type FakeRTCPeerConnection, type FakeRTCRtpTransceiver, videoReceiverStats } from "@test/fakes/webrtc";
import { NONCE, startStreamer, type Streamer } from "@test/helpers/wpe-core";
import { animations, assertAbsent, installAnimate } from "@test/helpers/wpe-dom";
import type { ReactNode } from "react";

import { CallTileStream } from "./CallTileStream";
import { isTileOwned, PIP_DELAY_MS, resetTileState, setLocalPreviewHidden } from "./tileState";
import { getTileAudioKey, resetTrayVolume } from "./trayVolume";

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
        resetTrayVolume();
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

        test("com a janela aberta o som sai da tile e ela deixa de publicar para a barra da call", async () => {
            await withStream(true);
            assert.equal(getTileAudioKey(FRIEND_ID), FRIEND_ID);
            fireEvent.click(screen.getByRole("button", { name: "Abrir em janela" }));
            await settle();
            assert.equal(getTileAudioKey(FRIEND_ID), null);
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
    describe("saiu da tela da call: janelinha", () => {
        let clock: ReturnType<typeof useFakeClock>;
        let incoming: MediaStream;

        beforeEach(t => {
            clock = useFakeClock(t as TestContext);
            SelectedChannelStore.setChannel(VOICE_CHANNEL_ID); // a tela principal e a da call
        });

        afterEach(() => {
            act(() => closeAllViewers());
            act(() => clock.tick(0)); // o desmonte da janelinha e um setTimeout(0)
            SelectedChannelStore.setChannel(null);
        });

        const pips = () => Array.from(document.body.querySelectorAll<HTMLElement>(".vc-telinha-pip"));
        const pipVideo = () => document.body.querySelector<HTMLVideoElement>(".vc-telinha-pip video");
        const stops = () => streamer.watchMessages().filter(m => m.op === "stop").length;
        const noRestart = () => assert.deepEqual(streamer.watchMessages(), [{ op: "start" }], "um start so, nenhum stop");
        const leaveCallScreen = () => SelectedChannelStore.setChannel("text-channel");

        /** Assistindo na tile, com o stream chegando; devolve a tile (ainda montada) */
        async function watchingInTile(audio: boolean) {
            streamer.announce({ streaming: true, hasAudio: audio });
            const view = await startWatching();
            incoming = screenStream(audio);
            streamer.room.emitStream(streamer.peerId, incoming, { kind: STREAM_KIND_SCREEN });
            await settle();
            return view;
        }

        /** Sai da tela da call com a tile desmontando: depois de PIP_DELAY_MS a janelinha esta na tela */
        async function toPip(view: { unmount(): void; }) {
            leaveCallScreen();
            act(() => view.unmount());
            act(() => clock.tick(PIP_DELAY_MS));
            await settle();
        }

        const press = (el: HTMLElement) => {
            fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1 });
            fireEvent.pointerUp(el, { pointerId: 1 });
        };

        test("sai da tela da call: a MESMA sessao segue na janelinha, com som e volume, sem reconectar", async () => {
            setVolume(FRIEND_ID, { volume: 0.4, muted: false });
            const view = await watchingInTile(true);
            const before = getEventLog().length;

            await toPip(view);
            assert.equal(pips().length, 1);
            const v = pipVideo()!;
            assert.ok(v.srcObject === incoming, "o mesmo MediaStream que a tile tocava");
            assert.equal(v.muted, false);
            assert.equal(v.volume, 0.4);
            noRestart();
            const after = getEventLog().slice(before).map(e => e.msg);
            assert.equal(after.some(m => /Parou de assistir|pedido enviado/.test(m)), false, "nenhum stop nem novo pedido no diagnostico");
            assert.ok(after.some(m => /Saiu da tela da call/.test(m)));
            assert.ok(getState().viewing[streamer.peerId]?.stream === incoming);
        });

        test("clicar na janelinha abre a call e destaca a tile do amigo; ela fica ate a tile montar", async () => {
            const view = await watchingInTile(true);
            await toPip(view);

            press(pips()[0]);
            assert.equal(ChannelRouter.transitions.at(-1), VOICE_CHANNEL_ID);
            const selects = FluxDispatcher.dispatched.filter(a => a.type === "CHANNEL_RTC_SELECT_PARTICIPANT");
            assert.deepEqual(selects.map(a => a.id), [FRIEND_ID]);
            assert.equal(pips().length, 1, "ainda nao ha tile: a janelinha fica");
            noRestart();
        });

        test("a tile monta de novo: a janelinha sai e a tile toca o mesmo stream, com som, sem esperar o relogio de 1,5 s", async () => {
            setVolume(FRIEND_ID, { volume: 0.4, muted: false });
            const view = await watchingInTile(true);
            await toPip(view);

            const again = render(<CallTileStream userId={FRIEND_ID} />);
            act(() => clock.tick(0));
            await settle();
            assert.equal(pips().length, 0, "a janelinha saiu");
            assert.equal(isViewerOpen(streamer.peerId), false);
            assert.equal(isTileOwned(streamer.peerId), true);
            const v = tile(again.container).querySelector("video")!;
            assert.ok(v.srcObject === incoming);
            assert.equal(v.muted, false, "a tile ja toca (nenhum poll de 1,5 s)");
            assert.equal(v.volume, 0.4);
            noRestart();
            assert.ok(getEventLog().some(e => /Voltou para a call/.test(e.msg)));
        });

        test("sai de novo e aperta o X: para de assistir (um unico stop) e a sessao some", async () => {
            const view = await watchingInTile(false);
            await toPip(view);
            const again = render(<CallTileStream userId={FRIEND_ID} />);
            act(() => clock.tick(0));
            await settle();
            await toPip(again);
            assert.equal(pips().length, 1, "o ciclo funciona mais de uma vez");

            fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
            await settle();
            act(() => clock.tick(0));
            assert.equal(stops(), 1);
            assert.equal(pips().length, 0);
            assert.equal(getState().viewing[streamer.peerId], undefined);
        });

        test("o amigo para de transmitir com a janelinha na tela: avisa e some sozinha depois de 4 s", async () => {
            const view = await watchingInTile(false);
            await toPip(view);

            streamer.announce({ streaming: false });
            await settle();
            assert.ok(within(pips()[0]).getByText("A transmissão terminou"));
            act(() => clock.tick(PIP_ENDED_CLOSE_MS - 1));
            assert.equal(pips().length, 1);
            act(() => clock.tick(1));
            await settle();
            act(() => clock.tick(0));
            assert.equal(pips().length, 0);
            assert.equal(getState().viewing[streamer.peerId], undefined, "o unwatch final e inofensivo");
        });

        test("\"Abrir em janela\" e depois sair da tela da call: nenhuma janelinha, a janela segue dona da sessao", async () => {
            const view = await watchingInTile(false);
            fireEvent.mouseMove(tile(view.container));
            fireEvent.click(screen.getByRole("button", { name: "Abrir em janela" }));
            await settle();
            assert.equal(PopoutActions.opened.length, 1);

            leaveCallScreen();
            act(() => view.unmount());
            act(() => clock.tick(10_000));
            await settle();
            assert.equal(pips().length, 0);
            assert.equal(isViewerOpen(streamer.peerId), true);
            assert.ok(getState().viewing[streamer.peerId]);
            noRestart();
        });

        test("sair da call de voz com a janelinha na tela: ela fecha junto com a sessao", async () => {
            const view = await watchingInTile(false);
            await toPip(view);
            assert.equal(pips().length, 1);

            try {
                await act(async () => {
                    joinVoice(null);
                });
                await settle();
                act(() => clock.tick(10));
                await settle();
                act(() => clock.tick(0));
                assert.equal(pips().length, 0);
                assert.equal(getState().viewing[streamer.peerId], undefined);
            } finally {
                await act(async () => {
                    joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
                });
                await settle();
            }
        });
    });
});
