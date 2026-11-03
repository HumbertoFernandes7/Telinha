/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A moldura da janelinha, ui/PipViewer.tsx, renderizada de verdade com o estado do Telinha montado direto (setState):
// onde abre, clique x arraste (limite de 4 px), o X e o botao "Voltar para a call", o fim da transmissao e o sumico da
// sessao fecham pelo chamador, e a janelinha volta para dentro da janela quando ela encolhe.
// Rodar:  pnpm test:file src/plugins/telinha/ui/PipViewer.test.tsx

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState, ViewerSession } from "@plugins/telinha/types";
import { useFakeClock } from "@test/fakes/clock";
import { resetMedia } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, resetVencordFakes } from "@test/fakes/vencord";
import { captureStream } from "@test/fakes/webrtc";
import { animations, assertAbsent, installAnimate } from "@test/helpers/wpe-dom";

import { PIP_EDGE, PIP_HEIGHT, PIP_WIDTH, type Pos } from "./pipGeometry";
import { PIP_ENDED_CLOSE_MS, PipViewer } from "./PipViewer";

const PEER = "peerA";
const TITLE = "amigo — Telinha";
const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };
const INITIAL: Pos = { x: 200, y: 150 };

function friend(): RemotePeer {
    return {
        peerId: PEER, discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "Tela", hasAudio: false, width: 1920, height: 1080, fps: 60, access: "all" }
    };
}

function session(patch: Partial<ViewerSession> = {}): ViewerSession {
    return { peerId: PEER, stream: captureStream({ audio: false }) as unknown as MediaStream, status: "playing", ...patch };
}

function show(sess: ViewerSession | null) {
    act(() => setState({ ...EMPTY, peers: [friend()], viewing: sess ? { [PEER]: sess } : {} }));
}

interface Spies {
    returned: number;
    closed: string[];
    moved: Pos[];
}

async function mount(initial: Pos = INITIAL) {
    const spies: Spies = { returned: 0, closed: [], moved: [] };
    const view = render(
        <PipViewer
            peerId={PEER}
            title={TITLE}
            initial={initial}
            content={{ peerId: PEER, mode: "pip", onMounted() { }, onUnmounted() { }, onClose() { } }}
            onReturn={() => void spies.returned++}
            onClose={reason => void spies.closed.push(reason)}
            onMoved={p => void spies.moved.push(p)}
        />
    );
    await settle();
    return { ...view, spies, pip: screen.getByRole("group", { name: TITLE }) };
}

const left = (el: HTMLElement) => parseFloat(el.style.left);
const top = (el: HTMLElement) => parseFloat(el.style.top);

function press(el: HTMLElement, x: number, y: number, pointerId = 1) {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId });
}

function moveTo(el: HTMLElement, x: number, y: number, pointerId = 1) {
    fireEvent.pointerMove(el, { clientX: x, clientY: y, pointerId });
}

function release(el: HTMLElement, pointerId = 1) {
    fireEvent.pointerUp(el, { pointerId });
}

describe("PipViewer", () => {
    let restoreAnimate: () => void;
    before(() => void (restoreAnimate = installAnimate()));
    after(() => restoreAnimate());

    beforeEach(() => {
        resetVencordFakes();
        resetMedia();
        resetState();
        animations.reset();
    });

    afterEach(() => {
        cleanup();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    describe("quadro", () => {
        test("abre na posicao inicial e mostra o player em modo janelinha (sem Tela cheia)", async () => {
            show(session());
            const { pip } = await mount();
            assert.equal(left(pip), INITIAL.x);
            assert.equal(top(pip), INITIAL.y);
            assert.equal(pip.className, "vc-telinha-pip");
            assert.ok(pip.querySelector("video"), "o video da sessao esta dentro da janelinha");
            assertAbsent(screen.queryByRole("button", { name: /Tela cheia/ }));
        });

        test("a barra traz o nome e os botoes Voltar para a call e Parar de assistir", async () => {
            show(session());
            await mount();
            const bar = screen.getByText(TITLE, { selector: "span" }).parentElement as HTMLElement;
            assert.equal(bar.className, "vc-telinha-pip-bar");
            assert.ok(bar.contains(screen.getByRole("button", { name: "Voltar para a call" })));
            assert.ok(bar.contains(screen.getByRole("button", { name: "Parar de assistir" })));
        });
    });

    describe("clique x arraste", () => {
        test("apertar e soltar sem mexer volta para a call, uma vez, e nao lembra posicao", async () => {
            show(session());
            const { pip, spies } = await mount();
            press(pip, 250, 200);
            release(pip);
            assert.equal(spies.returned, 1);
            assert.deepEqual(spies.moved, []);
            assert.deepEqual(spies.closed, []);
            assert.equal(left(pip), INITIAL.x);
            assert.equal(top(pip), INITIAL.y);
        });

        test("arrastar 50 px leva a janelinha junto e avisa a posicao final, sem voltar para a call", async () => {
            show(session());
            const { pip, spies } = await mount();
            press(pip, 250, 200);
            moveTo(pip, 280, 220);
            assert.equal(left(pip), INITIAL.x + 30);
            assert.equal(top(pip), INITIAL.y + 20);
            moveTo(pip, 300, 250);
            assert.equal(left(pip), INITIAL.x + 50);
            assert.equal(top(pip), INITIAL.y + 50);
            release(pip);
            assert.deepEqual(spies.moved, [{ x: INITIAL.x + 50, y: INITIAL.y + 50 }]);
            assert.equal(spies.returned, 0);
        });

        test("mexer 3 px e soltar ainda e clique; a janelinha nao sai do lugar", async () => {
            show(session());
            const { pip, spies } = await mount();
            press(pip, 250, 200);
            moveTo(pip, 253, 200);
            assert.equal(left(pip), INITIAL.x, "abaixo do limite nao arrasta");
            release(pip);
            assert.equal(spies.returned, 1);
            assert.deepEqual(spies.moved, []);
        });

        test("o arraste fica dentro da janela, com a folga das bordas", async () => {
            show(session());
            const { pip } = await mount();
            press(pip, 250, 200);
            moveTo(pip, 99999, 99999);
            assert.equal(left(pip), window.innerWidth - PIP_WIDTH - PIP_EDGE);
            assert.equal(top(pip), window.innerHeight - PIP_HEIGHT - PIP_EDGE);
            moveTo(pip, -99999, -99999);
            assert.equal(left(pip), PIP_EDGE);
            assert.equal(top(pip), PIP_EDGE);
        });

        test("depois de soltar, mexer o mouse nao arrasta mais; mover sem ter apertado tambem nao", async () => {
            show(session());
            const { pip } = await mount();
            moveTo(pip, 400, 400);
            assert.equal(left(pip), INITIAL.x, "sem apertar nao arrasta");

            press(pip, 250, 200);
            moveTo(pip, 280, 200);
            release(pip);
            moveTo(pip, 600, 200);
            assert.equal(left(pip), INITIAL.x + 30);
            release(pip);
        });

        test("soltar sem ter apertado nao faz nada", async () => {
            show(session());
            const { pip, spies } = await mount();
            release(pip);
            assert.equal(spies.returned, 0);
            assert.deepEqual(spies.moved, []);
        });

        test("pointercancel solta o arraste sem voltar para a call nem lembrar posicao", async () => {
            show(session());
            const { pip, spies } = await mount();
            press(pip, 250, 200);
            moveTo(pip, 300, 200);
            fireEvent.pointerCancel(pip, { pointerId: 1 });
            moveTo(pip, 500, 200);
            release(pip);
            assert.equal(left(pip), INITIAL.x + 50, "o cancelamento para onde estava");
            assert.equal(spies.returned, 0);
            assert.deepEqual(spies.moved, []);
        });

        test("apertar no X nao inicia arraste nem conta como clique na imagem", async () => {
            show(session());
            const { pip, spies } = await mount();
            const x = screen.getByRole("button", { name: "Parar de assistir" });
            press(x, 250, 200);
            moveTo(pip, 400, 300);
            release(x);
            assert.equal(left(pip), INITIAL.x);
            assert.equal(spies.returned, 0);
            assert.deepEqual(spies.moved, []);
        });
    });

    describe("botoes", () => {
        test("o X fecha com \"janelinha fechada\" e nao volta para a call", async () => {
            show(session());
            const { spies } = await mount();
            const x = screen.getByRole("button", { name: "Parar de assistir" });
            press(x, 250, 200);
            release(x);
            fireEvent.click(x);
            assert.deepEqual(spies.closed, ["janelinha fechada"]);
            assert.equal(spies.returned, 0);
        });

        test("Voltar para a call chama onReturn (so uma vez)", async () => {
            show(session());
            const { spies } = await mount();
            const back = screen.getByRole("button", { name: "Voltar para a call" });
            press(back, 250, 200);
            release(back);
            fireEvent.click(back);
            assert.equal(spies.returned, 1);
            assert.deepEqual(spies.closed, []);
        });
    });

    describe("fim da sessao", () => {
        test("transmissao terminou: fecha so depois de 4000 ms (nao aos 3999)", async t => {
            const clock = useFakeClock(t);
            show(session());
            const { spies } = await mount();
            show(session({ status: "ended" }));
            await settle();
            await act(async () => void await clock.tickAsync(PIP_ENDED_CLOSE_MS - 1));
            assert.deepEqual(spies.closed, []);
            await act(async () => void await clock.tickAsync(1));
            assert.deepEqual(spies.closed, ["a transmissão terminou"]);
        });

        test("se a transmissao volta antes dos 4 s, o fechamento e cancelado", async t => {
            const clock = useFakeClock(t);
            show(session({ status: "ended" }));
            const { spies } = await mount();
            await act(async () => void await clock.tickAsync(PIP_ENDED_CLOSE_MS - 100));
            show(session({ status: "playing" }));
            await settle();
            await act(async () => void await clock.tickAsync(PIP_ENDED_CLOSE_MS));
            assert.deepEqual(spies.closed, []);
        });

        test("desmontar com o aviso na tela cancela o fechamento", async t => {
            const clock = useFakeClock(t);
            show(session({ status: "ended" }));
            const { spies, unmount } = await mount();
            unmount();
            await act(async () => void await clock.tickAsync(PIP_ENDED_CLOSE_MS * 2));
            assert.deepEqual(spies.closed, []);
        });

        test("erro nao fecha sozinha: o clique leva a tile, que oferece Tentar de novo", async t => {
            const clock = useFakeClock(t);
            show(session({ status: "error", error: "caiu" }));
            const { spies } = await mount();
            await act(async () => void await clock.tickAsync(PIP_ENDED_CLOSE_MS * 3));
            assert.deepEqual(spies.closed, []);
        });

        test("a sessao some: fecha com \"a sessão acabou\", uma vez so", async () => {
            show(session());
            const { spies } = await mount();
            show(null);
            await settle();
            assert.deepEqual(spies.closed, ["a sessão acabou"]);
            show(session());
            await settle();
            show(null);
            await settle();
            assert.deepEqual(spies.closed, ["a sessão acabou"], "sumir de novo nao avisa outra vez");
        });

        test("sem nunca ter visto a sessao nao fecha (o chamador so abre com sessao ativa)", async () => {
            show(null);
            const { spies } = await mount();
            assert.deepEqual(spies.closed, []);
        });
    });

    describe("janela do Discord", () => {
        let width: number;
        let height: number;
        beforeEach(() => {
            width = window.innerWidth;
            height = window.innerHeight;
        });
        afterEach(() => {
            window.innerWidth = width;
            window.innerHeight = height;
        });

        test("a janela encolhe: a janelinha volta para dentro", async () => {
            show(session());
            const { pip } = await mount({ x: width - PIP_WIDTH - PIP_EDGE, y: height - PIP_HEIGHT - PIP_EDGE });
            window.innerWidth = width - 300;
            window.innerHeight = height - 200;
            act(() => void window.dispatchEvent(new Event("resize")));
            assert.equal(left(pip), width - 300 - PIP_WIDTH - PIP_EDGE);
            assert.equal(top(pip), height - 200 - PIP_HEIGHT - PIP_EDGE);
        });

        test("depois de desmontar, o resize nao mexe em mais nada", async () => {
            show(session());
            const { pip, unmount } = await mount();
            unmount();
            window.innerWidth = 100;
            act(() => void window.dispatchEvent(new Event("resize")));
            assert.equal(left(pip), INITIAL.x, "o elemento solto nao foi reposicionado");
        });
    });
});
