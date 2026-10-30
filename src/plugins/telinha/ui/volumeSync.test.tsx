/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O volume de um amigo e um so na tile da call (callView/CallTileStream.tsx) e na janela do visualizador
// (ViewerContent.tsx): os dois componentes de verdade, montados juntos, com o estado do Telinha montado direto
// (setState). O que se ajusta em um aparece no outro na hora (slider, mudo e o volume do <video>), vale para a janela
// que abre depois, cada amigo tem o seu, e o mudo que o navegador impoe ao recusar o autoplay nunca vira escolha do
// usuario. O caminho completo ("Abrir em janela" com o nucleo por tras) esta em callView/CallTileStream.core.test.tsx;
// o armazenamento em si, em volumes.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/ui/volumeSync.test.tsx

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { PeerId, RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { media, resetMedia } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, settle, within } from "@test/fakes/render";
import { caughtErrors, resetVencordFakes } from "@test/fakes/vencord";
import { captureStream } from "@test/fakes/webrtc";
import { animations, installAnimate } from "@test/helpers/wpe-dom";
import type { ReactNode } from "react";

import { CallTileStream } from "./callView/CallTileStream";
import { resetTileState } from "./callView/tileState";
import { ViewerContent } from "./ViewerContent";
import { getVolume, setVolume } from "./volumes";

const PEER_A = "peerA";
const PEER_B = "peerB";
const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

// O volume lembrado vive o processo inteiro (ate o Discord fechar): cada teste usa amigos (discordUserId) so seus
let nextId = 800000000000000000n;
const freshId = () => String(nextId++);

function friend(peerId: PeerId, discordUserId: string): RemotePeer {
    return {
        peerId, discordUserId, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" }
    };
}

/** Quem assiste a cada amigo, com imagem e som tocando */
function watching(...friends: [peerId: PeerId, discordUserId: string][]) {
    const stream = () => captureStream({ audio: true }) as unknown as MediaStream;
    act(() => setState({
        ...EMPTY,
        peers: friends.map(([peerId, id]) => friend(peerId, id)),
        viewing: Object.fromEntries(friends.map(([peerId]) => [peerId, { peerId, stream: stream(), status: "playing" as const }]))
    }));
}

/** Renderiza e deixa passar as promessas do mount (play(), registro da tile) dentro do act() */
async function mount(ui: ReactNode) {
    const view = render(ui);
    await settle();
    return view;
}

const tileOf = (userId: string) => mount(<CallTileStream userId={userId} />);
const windowOf = (peerId: PeerId) => mount(<ViewerContent peerId={peerId} mode="popout" onMounted={() => { }} onUnmounted={() => { }} onClose={() => { }} />);

const video = (view: { container: HTMLElement; }) => view.container.querySelector("video") as HTMLVideoElement;
const slider = (view: { container: HTMLElement; }) => within(view.container).getByLabelText("Volume") as HTMLInputElement;
const button = (view: { container: HTMLElement; }, name: string | RegExp) => within(view.container).getByRole("button", { name });
const setSlider = (view: { container: HTMLElement; }, percent: number) => fireEvent.change(slider(view), { target: { value: String(percent) } });

/** O navegador so deixa tocar com som depois de um clique do usuario */
const refuseSound = () => {
    media.playImpl = async el => {
        if (!el.muted) throw new DOMException("autoplay com som", "NotAllowedError");
    };
};

describe("volume compartilhado entre a tile da call e a janela do visualizador", () => {
    let restoreAnimate: () => void;
    before(() => void (restoreAnimate = installAnimate()));
    after(() => restoreAnimate());

    beforeEach(() => {
        resetVencordFakes();
        resetMedia();
        resetState();
        animations.reset();
        for (const key of [PEER_A, PEER_B]) setVolume(key, { volume: 1, muted: false });
    });

    afterEach(async () => {
        cleanup();
        await act(async () => resetTileState());
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    describe("da tile para a janela", () => {
        test("30% na tile: a janela que abre depois mostra 30% e toca a 0,3", async () => {
            const id = freshId();
            watching([PEER_A, id]);
            const tile = await tileOf(id);
            setSlider(tile, 30);
            assert.equal(video(tile).volume, 0.3);

            const win = await windowOf(PEER_A);
            assert.equal(slider(win).value, "30");
            assert.equal(slider(win).title, "Volume: 30%");
            assert.equal(video(win).volume, 0.3);
            assert.equal(video(win).muted, false);
        });

        test("mudo na tile: a janela que abre depois ja nasce muda, com o volume de antes guardado", async () => {
            const id = freshId();
            watching([PEER_A, id]);
            const tile = await tileOf(id);
            setSlider(tile, 45);
            fireEvent.click(button(tile, "Silenciar"));

            const win = await windowOf(PEER_A);
            assert.equal(video(win).muted, true);
            assert.equal(slider(win).value, "0", "o controle mostra 0 enquanto mudo");
            fireEvent.click(button(win, "Ativar som"));
            assert.equal(slider(win).value, "45", "o volume de antes do mudo");
            assert.equal(video(win).volume, 0.45);
        });
    });

    describe("da janela para a tile que segue montada", () => {
        test("70% e depois mudo na janela aparecem na tile na hora, sem trocar o <video> dela; e de volta", async () => {
            const id = freshId();
            watching([PEER_A, id]);
            const tile = await tileOf(id);
            const win = await windowOf(PEER_A);
            const tileVideo = video(tile);

            setSlider(win, 70);
            assert.equal(slider(tile).value, "70");
            assert.equal(slider(tile).title, "Volume: 70%");
            assert.equal(tileVideo.volume, 0.7);
            assert.equal(video(win).volume, 0.7);
            assert.ok(video(tile) === tileVideo && tileVideo.isConnected, "a tile nao remontou: e o mesmo <video>");

            fireEvent.click(button(win, "Silenciar"));
            assert.equal(slider(tile).value, "0");
            assert.equal(tileVideo.muted, true);
            assert.ok(button(tile, "Ativar som"));
            assert.ok(video(tile) === tileVideo);

            fireEvent.click(button(tile, "Ativar som")); // e a tile devolve o som: a janela acompanha
            assert.equal(slider(win).value, "70");
            assert.equal(video(win).muted, false);
            assert.equal(tileVideo.muted, false);

            setSlider(tile, 0); // volume zero e o mesmo que mudo, nos dois
            assert.ok(button(win, "Ativar som"));
            assert.equal(video(win).muted, true);
        });

        test("o <video> da tile guarda o volume da janela mesmo calada (o som e so da janela), pronto para quando ela voltar a tocar", async () => {
            const id = freshId();
            watching([PEER_A, id]);
            const tile = await tileOf(id);
            const tileVideo = video(tile);
            await windowOf(PEER_A);

            act(() => setVolume(id, { volume: 0.55, muted: false })); // o que a janela faria
            assert.equal(tileVideo.volume, 0.55);
        });
    });

    describe("cada amigo com o seu", () => {
        test("dois amigos: mexer em um (na tile ou na janela) nao muda o outro", async () => {
            const [a, b] = [freshId(), freshId()];
            watching([PEER_A, a], [PEER_B, b]);
            const tileA = await tileOf(a);
            const tileB = await tileOf(b);
            const winA = await windowOf(PEER_A);
            const winB = await windowOf(PEER_B);

            setSlider(winA, 20);
            setSlider(tileB, 80);
            for (const view of [tileA, winA]) assert.equal(slider(view).value, "20");
            for (const view of [tileB, winB]) assert.equal(slider(view).value, "80");
            assert.deepEqual([video(tileA).volume, video(winA).volume, video(tileB).volume, video(winB).volume], [0.2, 0.2, 0.8, 0.8]);

            fireEvent.click(button(tileA, "Silenciar"));
            assert.equal(video(winA).muted, true);
            assert.equal(video(winB).muted, false);
            assert.equal(video(tileB).muted, false);
            assert.deepEqual([getVolume(a), getVolume(b)], [{ volume: 0.2, muted: true }, { volume: 0.8, muted: false }]);
        });

        test("a mesma regra de chave nos dois: sem o id do Discord do amigo, vale a conexao", async () => {
            watching([PEER_B, ""]);
            const tile = await tileOf("");
            setSlider(tile, 30);
            assert.deepEqual(getVolume(PEER_B), { volume: 0.3, muted: false });

            const win = await windowOf(PEER_B);
            assert.equal(slider(win).value, "30");
            setSlider(win, 60);
            assert.equal(slider(tile).value, "60");
        });
    });

    describe("autoplay recusado pelo navegador", () => {
        test("na janela: toca mudo so no <video>; o \"mudo\" nao vira escolha do amigo (a tile toca com som) e ligar o som segue sem mudo", async () => {
            const id = freshId();
            watching([PEER_A, id]);
            refuseSound();
            const win = await windowOf(PEER_A);
            const enable = button(win, /Ativar som/);
            assert.equal(video(win).muted, true, "o navegador silenciou o <video>");
            assert.deepEqual(getVolume(id), { volume: 1, muted: false }, "mas isso nao foi guardado");

            media.playImpl = null;
            const tile = await tileOf(id);
            assert.equal(video(tile).muted, false, "a tile toca com som: o amigo nunca foi silenciado");
            assert.equal(slider(tile).value, "100");

            fireEvent.click(enable);
            await settle();
            assert.equal(video(win).muted, false);
            assert.equal(slider(win).value, "100");
            assert.deepEqual(getVolume(id), { volume: 1, muted: false });
        });

        test("na tile: a mesma coisa, e a janela que abre depois toca com som", async () => {
            const id = freshId();
            watching([PEER_A, id]);
            refuseSound();
            const tile = await tileOf(id);
            const enable = button(tile, "Ativar som");
            assert.equal(enable.textContent, "Ativar som", "o convite da tile, nao o controle de volume");
            assert.equal(video(tile).muted, true);
            assert.deepEqual(getVolume(id), { volume: 1, muted: false }, "o mudo do navegador nao foi guardado");

            media.playImpl = null;
            const win = await windowOf(PEER_A);
            assert.equal(video(win).muted, false);
            assert.equal(slider(win).value, "100");

            fireEvent.click(enable);
            await settle();
            assert.equal(video(tile).muted, false);
            assert.deepEqual(getVolume(id), { volume: 1, muted: false });
        });

        test("o volume que o usuario escolheu continua valendo quando o navegador recusa o som em outra tela", async () => {
            const id = freshId();
            watching([PEER_A, id]);
            const tile = await tileOf(id);
            setSlider(tile, 35);

            refuseSound();
            const win = await windowOf(PEER_A);
            assert.equal(video(win).muted, true, "o navegador recusou o som");
            assert.equal(video(win).volume, 0.35, "mas o nivel e o do amigo");
            assert.deepEqual(getVolume(id), { volume: 0.35, muted: false });
            assert.ok(button(win, /Ativar som/), "enquanto recusado, so o convite");
            assert.equal(within(win.container).queryByLabelText("Volume"), null);
        });
    });
});
