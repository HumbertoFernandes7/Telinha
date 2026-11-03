/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A janelinha em ui/viewerWindows.tsx (openPip / dockPip) com o nucleo de verdade (sala + amigos transmitindo): ela toca
// a MESMA sessao que ja estava rodando (nunca pede watch de novo), o X para de assistir uma vez so, e devolver para a
// tile (dockPip) nao manda stop nenhum. Arquivo proprio porque o viewerWindows guarda estado de modulo (a posicao
// lembrada do ultimo arraste vale o processo inteiro): o teste da posicao lembrada e o ultimo daqui.
// Rodar:  pnpm test:file src/plugins/telinha/ui/viewerWindows.pip.test.tsx

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import { unwatch, watch } from "@plugins/telinha/actions";
import { STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import { useFakeClock } from "@test/fakes/clock";
import { layout, resetMedia } from "@test/fakes/dom";
import { act, cleanup, fireEvent, settle } from "@test/fakes/render";
import { caughtErrors, OTHER_ID, PopoutActions, PopoutWindowStore } from "@test/fakes/vencord";
import { captureStream } from "@test/fakes/webrtc";
import { startStreamer, type Streamer } from "@test/helpers/wpe-core";
import { animations, installAnimate } from "@test/helpers/wpe-dom";

import { overlaps, PIP_GAP, PIP_HEIGHT, PIP_MARGIN_BOTTOM, PIP_MARGIN_RIGHT, PIP_WIDTH } from "./pipGeometry";
import { closeAllViewers, dockPip, isViewerOpen, openPip, openViewer } from "./viewerWindows";

const PEER = "peerA";
const PEER_B = "peerB";

const pips = () => Array.from(document.body.querySelectorAll<HTMLElement>(".vc-telinha-pip"));
const stops = (streamer: Streamer, peerId = PEER) => streamer.room.sentOn("watch", peerId).filter(m => m.data.op === "stop").length;
const starts = (streamer: Streamer, peerId = PEER) => streamer.room.sentOn("watch", peerId).filter(m => m.data.op === "start").length;
const left = (el: HTMLElement) => parseFloat(el.style.left);
const top = (el: HTMLElement) => parseFloat(el.style.top);
const slotX = () => window.innerWidth - PIP_WIDTH - PIP_MARGIN_RIGHT;
const slotY = (index = 0) => window.innerHeight - PIP_HEIGHT - PIP_MARGIN_BOTTOM - index * (PIP_HEIGHT + PIP_GAP);

describe("janelinha (openPip / dockPip) com o nucleo de verdade", () => {
    let streamer: Streamer;
    let restoreAnimate: () => void;
    let clock: ReturnType<typeof useFakeClock>;
    let onReturn = 0;
    const back = () => void onReturn++;
    const open = (peerId: string) => {
        let opened = false;
        act(() => void (opened = openPip(peerId, { onReturn: back })));
        return opened;
    };

    before(async () => {
        restoreAnimate = installAnimate();
        streamer = await startStreamer();
        await streamer.addFriend(PEER_B, OTHER_ID, "outro");
    });

    after(async () => {
        restoreAnimate();
        await streamer.stop();
    });

    beforeEach(t => {
        clock = useFakeClock(t as TestContext);
        resetMedia();
        animations.reset();
        PopoutActions.reset();
        PopoutWindowStore.reset();
        streamer.room.sent.length = 0;
        onReturn = 0;
    });

    afterEach(async () => {
        cleanup();
        await act(async () => {
            closeAllViewers();
            unwatch(PEER);
            unwatch(PEER_B);
        });
        act(() => clock.tick(0)); // o desmonte das janelinhas e um setTimeout(0)
        await settle();
        for (const el of document.querySelectorAll('[class*="pictureInPictureWindow"]')) el.remove();
        assert.equal(pips().length, 0, "nenhuma janelinha sobrou na tela");
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    /** O usuario ja assiste na tile: sessao ativa no nucleo e o stream chegando (sem abrir nenhum visualizador) */
    async function watching(peerId = PEER) {
        const stream = captureStream({ audio: false }) as unknown as MediaStream;
        await act(async () => {
            await watch(peerId);
        });
        act(() => streamer.room.emitStream(peerId, stream, { kind: STREAM_KIND_SCREEN }));
        await settle();
        return stream;
    }

    test("com a sessao ativa abre no canto de baixo a direita, toca o mesmo stream e nao pede nada de novo", async () => {
        const stream = await watching();
        assert.equal(starts(streamer), 1);
        assert.equal(open(PEER), true);
        await settle();

        const [pip] = pips();
        assert.equal(pips().length, 1);
        assert.equal(left(pip), slotX());
        assert.equal(top(pip), slotY());
        assert.ok(pip.querySelector("video")!.srcObject === stream, "o video toca o stream da sessao");
        assert.equal(starts(streamer), 1, "nenhum pedido novo");
        assert.equal(stops(streamer), 0);
        assert.equal(isViewerOpen(PEER), true);
    });

    test("o nome do amigo e o titulo da janelinha, sem \"— Telinha\"", async () => {
        await watching();
        open(PEER);
        await settle();
        assert.ok(document.querySelector('.vc-telinha-pip[aria-label="amigo"]'));
    });

    test("o X manda um unico stop e a sessao acaba", async () => {
        await watching();
        open(PEER);
        await settle();

        fireEvent.click(document.querySelector<HTMLElement>('.vc-telinha-pip button[aria-label="Parar de assistir"]')!);
        act(() => clock.tick(0));
        await settle();
        assert.equal(stops(streamer), 1);
        assert.equal(pips().length, 0);
        assert.equal(getState().viewing[PEER], undefined);
        assert.equal(isViewerOpen(PEER), false);
    });

    test("dockPip tira a janelinha sem parar de assistir: a sessao e a mesma, sem stop; a segunda vez nao ha o que tirar", async () => {
        await watching();
        const session = getState().viewing[PEER];
        open(PEER);
        await settle();

        assert.equal(dockPip(PEER), true);
        act(() => clock.tick(0));
        await settle();
        assert.equal(pips().length, 0);
        assert.equal(stops(streamer), 0);
        assert.ok(getState().viewing[PEER] === session, "a mesma sessao, nao uma nova");
        assert.equal(starts(streamer), 1);
        assert.equal(isViewerOpen(PEER), false);
        assert.equal(dockPip(PEER), false);
    });

    test("dockPip sem nenhuma janelinha: false", () => {
        assert.equal(dockPip(PEER), false);
    });

    test("dockPip nao mexe num pop-out: ele continua dono da sessao", async () => {
        openViewer(PEER);
        await settle();
        assert.equal(dockPip(PEER), false);
        assert.equal(isViewerOpen(PEER), true);
        assert.equal(PopoutActions.opened.length, 1);
        assert.deepEqual(PopoutActions.closed, []);
        assert.equal(stops(streamer), 0);
    });

    test("openPip com um pop-out do amigo aberto: false, nao abre janelinha e o pop-out segue", async () => {
        openViewer(PEER);
        await settle();
        assert.equal(open(PEER), false);
        assert.equal(pips().length, 0);
        assert.equal(isViewerOpen(PEER), true);
        assert.deepEqual(PopoutActions.closed, []);
    });

    test("openPip com uma janelinha desse amigo ja aberta: false, e ela nao sai do lugar", async () => {
        await watching();
        assert.equal(open(PEER), true);
        await settle();
        assert.equal(open(PEER), false);
        assert.equal(pips().length, 1);
    });

    test("dois amigos: duas janelinhas, a segunda 192 px acima; fechar a de baixo libera o canto para a proxima", async () => {
        await watching(PEER);
        await watching(PEER_B);
        assert.equal(open(PEER), true);
        assert.equal(open(PEER_B), true);
        await settle();

        const [first, second] = pips();
        assert.equal(top(first), slotY(0));
        assert.equal(top(second), slotY(0) - (PIP_HEIGHT + PIP_GAP));
        assert.equal(left(second), left(first));

        // fecha a do canto: a nova ocupa o canto de novo (nao o lugar da que continua aberta)
        fireEvent.click(first.querySelector<HTMLElement>('button[aria-label="Parar de assistir"]')!);
        act(() => clock.tick(0));
        await settle();
        assert.equal(pips().length, 1);
        await watching(PEER);
        assert.equal(open(PEER), true);
        await settle();
        assert.equal(pips().length, 2);
        assert.equal(top(pips().find(p => p.getAttribute("aria-label") === "amigo")!), slotY(0));
        assert.equal(top(pips().find(p => p.getAttribute("aria-label") === "outro")!), slotY(1));
    });

    test("um pop-out de outro amigo nao conta na pilha: a janelinha abre no canto", async () => {
        openViewer(PEER_B);
        await settle();
        await watching(PEER);
        assert.equal(open(PEER), true);
        await settle();
        assert.equal(top(pips()[0]), slotY(0));
    });

    test("o PiP do proprio Discord esta no lugar: a janelinha abre logo acima dele", async () => {
        const discord = document.createElement("div");
        discord.className = "pictureInPictureWindow_abc";
        layout.setSize(discord, { width: 300, height: 170, left: window.innerWidth - 320, top: window.innerHeight - 200 });
        document.body.appendChild(discord);

        await watching();
        open(PEER);
        await settle();
        assert.equal(top(pips()[0]), window.innerHeight - 200 - PIP_GAP - PIP_HEIGHT);
    });

    test("um elemento do Discord que nao deixa medir e ignorado", async () => {
        const discord = document.createElement("div");
        discord.className = "pictureInPictureWindow_abc";
        Object.defineProperty(discord, "getBoundingClientRect", { value() { throw new Error("sem medida"); } });
        document.body.appendChild(discord);

        await watching();
        open(PEER);
        await settle();
        assert.equal(top(pips()[0]), slotY(0));
    });

    test("fechar tudo (plugin parado) com a janelinha aberta manda um unico stop", async () => {
        await watching();
        open(PEER);
        await settle();
        closeAllViewers();
        act(() => clock.tick(0));
        await settle();
        assert.equal(stops(streamer), 1);
        assert.equal(pips().length, 0);
    });

    test("o player de dentro desmonta sozinho: a janelinha encerra e manda um unico stop", async t => {
        const reactDomClient = createRequire(__filename)("react-dom/client") as { createRoot(el: Element): { render(node: unknown): void; unmount(): void; }; };
        const realCreateRoot = reactDomClient.createRoot;
        let root!: { unmount(): void; };
        const patched = t.mock.method(reactDomClient, "createRoot", (el: Element) => (root = realCreateRoot(el)));
        await watching();
        open(PEER);
        await settle();

        act(() => root.unmount());
        act(() => clock.tick(0));
        await settle();
        patched.mock.restore();
        assert.equal(stops(streamer), 1);
        assert.equal(isViewerOpen(PEER), false);
    });

    // Por ultimo: a posicao lembrada vale pelo resto do processo
    test("arrastou e voltou para a call: a proxima janelinha abre onde foi largada", async () => {
        await watching();
        open(PEER);
        await settle();

        const pip = pips()[0];
        fireEvent.pointerDown(pip, { clientX: slotX() + 10, clientY: slotY() + 10, pointerId: 1 });
        fireEvent.pointerMove(pip, { clientX: slotX() - 90, clientY: slotY() - 40, pointerId: 1 });
        fireEvent.pointerUp(pip, { pointerId: 1 });
        const dropped = { x: left(pip), y: top(pip) };
        assert.deepEqual(dropped, { x: slotX() - 100, y: slotY() - 50 });
        assert.equal(onReturn, 0, "arrastar nao volta para a call");

        assert.equal(dockPip(PEER), true);
        act(() => clock.tick(0));
        await settle();
        assert.equal(open(PEER), true);
        await settle();
        assert.equal(left(pips()[0]), dropped.x);
        assert.equal(top(pips()[0]), dropped.y);
        assert.equal(stops(streamer), 0, "nunca parou de assistir");
    });

    // Depois do teste acima: a posicao lembrada (modulo) ja existe; este leva as janelinhas aos lugares que quer
    test("arrastou a de cima para o canto, fechou a de baixo: a nova nao abre em cima dela", async () => {
        const rect = (el: HTMLElement) => ({ left: left(el), top: top(el), right: left(el) + PIP_WIDTH, bottom: top(el) + PIP_HEIGHT });
        const dragTo = (el: HTMLElement, x: number, y: number) => {
            fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1 });
            fireEvent.pointerMove(el, { clientX: 100 + x - left(el), clientY: 100 + y - top(el), pointerId: 1 });
            fireEvent.pointerUp(el, { pointerId: 1 });
        };
        await watching(PEER);
        await watching(PEER_B);
        assert.equal(open(PEER), true);
        assert.equal(open(PEER_B), true);
        await settle();
        const lower = pips().find(p => p.getAttribute("aria-label") === "amigo")!;
        const upper = pips().find(p => p.getAttribute("aria-label") === "outro")!;
        dragTo(lower, slotX(), slotY(0));
        dragTo(upper, slotX(), slotY(0) - 60);

        fireEvent.click(lower.querySelector<HTMLElement>('button[aria-label="Parar de assistir"]')!);
        act(() => clock.tick(0));
        await settle();
        await watching(PEER);
        assert.equal(open(PEER), true);
        await settle();
        const fresh = pips().find(p => p.getAttribute("aria-label") === "amigo")!;
        const stay = pips().find(p => p.getAttribute("aria-label") === "outro")!;
        assert.equal(pips().length, 2);
        assert.ok(!overlaps({ x: left(fresh), y: top(fresh) }, rect(stay)), "a nova nao cobre a que ficou");
    });
});
