/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A janela do visualizador (ui/viewerWindows.tsx): abrir o pop-out do Discord, o que acontece quando ele nao monta
// (painel flutuante em 6 s), fechar por qualquer caminho (cada um para de assistir uma vez so), focar uma janela que ja
// esta aberta e arrastar o painel. O nucleo e o de verdade (sala + amigo transmitindo): cada fechamento e conferido pelo
// "stop" que sai para o transmissor. Aqui o Discord tem o componente PopoutWindow (viewerWindows.nopopout.test.tsx
// cobre o caso em que ele nao existe: o componente e achado uma vez so por processo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/viewerWindows.test.tsx

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import { unwatch } from "@plugins/telinha/actions";
import { rt } from "@plugins/telinha/core/context";
import { getState, setState } from "@plugins/telinha/store";
import { useFakeClock } from "@test/fakes/clock";
import { resetMedia } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, loggerLines, OTHER_ID, PopoutActions, PopoutWindowStore, toasts, UserStore, webpackModules } from "@test/fakes/vencord";
import { startStreamer, type Streamer } from "@test/helpers/wpe-core";
import { animations, installAnimate } from "@test/helpers/wpe-dom";
import type { ReactNode } from "react";

import { closeAllViewers, closeViewer, isViewerOpen, openViewer } from "./viewerWindows";

const PEER = "peerA";
const KEY = `DISCORD_TELINHA_VIEWER_${FRIEND_ID}`;
const PEER_B = "peerB";
const KEY_B = `DISCORD_TELINHA_VIEWER_${OTHER_ID}`;

/** Props com que o viewerWindows chamou o PopoutWindow do Discord (a moldura da janela) */
const popoutProps: { withTitleBar?: boolean; windowKey: string; title: string; }[] = [];

function PopoutWindowFake(props: { withTitleBar?: boolean; windowKey: string; title: string; children?: ReactNode; }) {
    popoutProps.push({ withTitleBar: props.withTitleBar, windowKey: props.windowKey, title: props.title });
    return <div data-popout-window={props.windowKey}>{props.children}</div>;
}

// O painel flutuante guarda um contador de posicao (0..5) que vive o processo inteiro: acompanhamos igual
let floatingOpened = 0;
const floatingIndex = () => floatingOpened++ % 6;
const floatingPos = (index: number) => ({ x: Math.max(16, window.innerWidth - 560 - 24 - index * 28), y: Math.max(16, window.innerHeight - 360 - 24 - index * 28) });

const panels = () => Array.from(document.body.querySelectorAll<HTMLElement>(".vc-telinha-floating"));
const header = (panel: HTMLElement) => panel.querySelector(".vc-telinha-floating-header") as HTMLElement;
const stops = (streamer: Streamer, peerId = PEER) => streamer.room.sentOn("watch", peerId).filter(m => m.data.op === "stop").length;
const starts = (streamer: Streamer, peerId = PEER) => streamer.room.sentOn("watch", peerId).filter(m => m.data.op === "start").length;
const warnings = () => loggerLines.filter(l => l.logger === "Telinha UI" && l.level === "warn").map(l => String(l.args[0]));
const popoutContent = (i = 0) => PopoutActions.opened[i].render() as ReactNode;

describe("viewerWindows (com o PopoutWindow do Discord)", () => {
    let streamer: Streamer;
    let restoreAnimate: () => void;

    before(async () => {
        restoreAnimate = installAnimate();
        webpackModules.provideByCode("Missing guestWindow reference", PopoutWindowFake);
        streamer = await startStreamer();
        await streamer.addFriend(PEER_B, OTHER_ID, "outro");
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
        popoutProps.length = 0;
        streamer.room.sent.length = 0;
    });

    afterEach(async () => {
        cleanup();
        await act(async () => {
            closeAllViewers();
            unwatch(PEER);
            unwatch(PEER_B);
        });
        await settle();
        assert.equal(PopoutWindowStore.listenerCount(), 0, "ninguem mais ouve o PopoutWindowStore");
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    /**
     * Fecha tudo e deixa o Telinha tirar os paineis da tela: o desmonte do painel e um setTimeout(0), e o relogio
     * falso precisa andar para ele rodar.
     */
    async function endFloating(clock: ReturnType<typeof useFakeClock>) {
        closeAllViewers();
        act(() => clock.tick(0));
        await settle();
        assert.equal(panels().length, 0, "nenhum painel sobrou na tela");
    }

    /** O pop-out nao monta: depois de 6 s o Telinha abre o painel flutuante */
    async function fallBackToFloating(clock: ReturnType<typeof useFakeClock>) {
        act(() => clock.tick(6000));
        await settle();
        return { index: floatingIndex(), panel: panels().at(-1)! };
    }

    // #region abrir

    describe("abrir o pop-out", () => {
        test("abre com a chave do amigo e o tamanho padrao, pede o stream e acompanha a janela", async () => {
            openViewer(PEER);
            await settle();
            assert.equal(PopoutActions.opened.length, 1);
            assert.equal(PopoutActions.opened[0].key, KEY);
            assert.deepEqual(PopoutActions.opened[0].features, { defaultWidth: 1280, defaultHeight: 760 });
            assert.equal(starts(streamer), 1, "o clique tambem pede para assistir");
            assert.equal(isViewerOpen(PEER), true);
            assert.equal(PopoutWindowStore.listenerCount(), 1);
            assert.ok(getState().viewing[PEER]);
        });

        test("o conteudo do pop-out vem dentro da moldura do Discord, com o nome do amigo no titulo", async () => {
            openViewer(PEER);
            await settle();
            render(<>{popoutContent()}</>);
            await settle();
            assert.deepEqual(popoutProps.at(-1), { withTitleBar: true, windowKey: KEY, title: "amigo — Telinha" });
            assert.ok(document.querySelector(`[data-popout-window="${KEY}"]`), "dentro da moldura");
            assert.ok(screen.getByText("Conectando…"), "o player mostra o pedido em andamento");
            assert.ok(screen.getByRole("button", { name: "Parar de assistir" }));
        });

        test("depois que o player monta nao ha painel flutuante, mesmo passados os 6 s", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            render(<>{popoutContent()}</>);
            await settle();
            act(() => clock.tick(10_000));
            assert.equal(panels().length, 0);
            assert.deepEqual(PopoutActions.closed, []);
            assert.deepEqual(warnings(), []);
        });

        test("amigo que nao esta mais na lista: a chave usa o id da conexao, so com caracteres aceitos", async () => {
            openViewer("peer x/ç-9");
            await settle();
            assert.equal(PopoutActions.opened[0].key, "DISCORD_TELINHA_VIEWER_peer_x___9");
        });

        test("pedir de novo com a janela aberta so foca a janela (nao pede o stream outra vez)", async () => {
            openViewer(PEER);
            await settle();
            openViewer(PEER);
            await settle();
            assert.equal(PopoutActions.opened.length, 1);
            assert.equal(starts(streamer), 1);
            assert.equal(PopoutWindowStore.getWindow(KEY)!.focused, 1);
        });

        test("sobrou uma janela com a mesma chave: fecha e abre a nova (senao so focaria a velha)", async () => {
            PopoutWindowStore.setOpen(KEY, true);
            openViewer(PEER);
            await settle();
            assert.deepEqual(PopoutActions.closed, [KEY]);
            assert.equal(PopoutActions.opened.length, 1);
        });

        test("dois amigos: uma janela para cada, cada uma com a sua chave", async () => {
            openViewer(PEER);
            openViewer(PEER_B);
            await settle();
            assert.deepEqual(PopoutActions.opened.map(o => o.key), [KEY, KEY_B]);
            assert.equal(starts(streamer, PEER_B), 1);
        });

        test("o nucleo nao deixa assistir: o aviso aparece e nenhuma janela abre", async t => {
            t.mock.method(rt.viewing, "set", () => {
                throw new Error("sem sala");
            });
            openViewer(PEER);
            assert.deepEqual(toasts, [{ text: "Telinha: não foi possível assistir — sem sala", variant: "critical" }]);
            assert.equal(PopoutActions.opened.length, 0);
            assert.equal(isViewerOpen(PEER), false);
            assert.equal(PopoutWindowStore.listenerCount(), 0);
        });

        test("o Discord nao deixa observar as janelas: o visualizador abre mesmo assim", async t => {
            t.mock.method(PopoutWindowStore, "addChangeListener", () => {
                throw new Error("sem store");
            });
            openViewer(PEER);
            await settle();
            assert.ok(warnings().includes("Não consegui observar o PopoutWindowStore"));
            assert.equal(PopoutActions.opened.length, 1);
            closeViewer(PEER);
            await settle();
        });
    });

    // #endregion

    // #region fechar

    describe("fechar", () => {
        test("o usuario fecha a janela do pop-out: para de assistir uma vez so", async () => {
            openViewer(PEER);
            await settle();
            assert.equal(stops(streamer), 0);

            act(() => PopoutWindowStore.setOpen(KEY, false));
            await settle();
            assert.equal(stops(streamer), 1);
            assert.equal(isViewerOpen(PEER), false);
            assert.equal(getState().viewing[PEER], undefined);
            assert.equal(PopoutWindowStore.listenerCount(), 0, "sem viewers, nao ouve mais");
            assert.deepEqual(PopoutActions.closed, [], "a janela ja tinha fechado");

            act(() => PopoutWindowStore.setOpen(KEY, false)); // nova notificacao: nada acontece
            assert.equal(stops(streamer), 1);
        });

        test("mudancas no store antes de a janela ser vista aberta nao encerram nada", async () => {
            PopoutActions.autoOpen = false;
            openViewer(PEER);
            await settle();
            act(() => PopoutWindowStore.emitChange());
            assert.equal(isViewerOpen(PEER), true);

            act(() => PopoutWindowStore.setOpen(KEY, true));
            act(() => PopoutWindowStore.setOpen(KEY, false));
            await settle();
            assert.equal(isViewerOpen(PEER), false);
            assert.equal(stops(streamer), 1);
        });

        test("\"Parar de assistir\" dentro do pop-out fecha a janela do Discord e para de assistir", async () => {
            openViewer(PEER);
            await settle();
            render(<>{popoutContent()}</>);
            await settle();
            fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
            await settle();
            assert.deepEqual(PopoutActions.closed, [KEY]);
            assert.equal(stops(streamer), 1);
            assert.equal(isViewerOpen(PEER), false);
        });

        test("fechar de dois jeitos ao mesmo tempo (a janela some e o botao do player ainda estava na tela): um stop so", async () => {
            openViewer(PEER);
            await settle();
            render(<>{popoutContent()}</>);
            await settle();
            act(() => PopoutWindowStore.setOpen(KEY, false));
            await settle();
            assert.equal(stops(streamer), 1);

            fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
            await settle();
            assert.equal(stops(streamer), 1);
            const endings = loggerLines.filter(l => /Visualizador de peerA encerrado/.test(String(l.args[0])));
            assert.equal(endings.length, 1, "o encerramento so acontece (e so e registrado) uma vez: " + endings.map(l => l.args[0]).join(" | "));
        });

        test("closeViewer (a tile da call fecha a janela): um stop; sem janela aberta nao faz nada", async () => {
            closeViewer(PEER);
            assert.equal(stops(streamer), 0);

            openViewer(PEER);
            await settle();
            closeViewer(PEER);
            await settle();
            assert.deepEqual(PopoutActions.closed, [KEY]);
            assert.equal(stops(streamer), 1);
            closeViewer(PEER);
            assert.equal(stops(streamer), 1, "ja estava fechado");
        });

        test("plugin parado: fecha todas as janelas, cada uma para de assistir uma vez", async () => {
            openViewer(PEER);
            openViewer(PEER_B);
            await settle();
            closeAllViewers();
            await settle();
            assert.deepEqual(PopoutActions.closed.sort(), [KEY, KEY_B].sort());
            assert.equal(stops(streamer), 1);
            assert.equal(stops(streamer, PEER_B), 1);
            assert.equal(PopoutWindowStore.listenerCount(), 0);
            closeAllViewers(); // sem nenhuma aberta: nada
            assert.equal(stops(streamer), 1);
        });

        test("o Discord falha ao fechar a janela: fica no log e o resto do fechamento acontece", async t => {
            openViewer(PEER);
            await settle();
            t.mock.method(PopoutActions, "close", () => {
                throw new Error("janela travada");
            });
            closeViewer(PEER);
            await settle();
            assert.ok(warnings().includes("Falha ao fechar o pop-out"));
            assert.equal(stops(streamer), 1);
        });

        test("o Discord falha ao parar de observar as janelas: o fechamento termina normalmente", async t => {
            openViewer(PEER);
            await settle();
            const broken = t.mock.method(PopoutWindowStore, "removeChangeListener", () => {
                throw new Error("sem store");
            });
            closeViewer(PEER);
            await settle();
            broken.mock.restore();
            assert.equal(stops(streamer), 1);
            PopoutWindowStore.clearListeners(); // o do Telinha ficou, porque o Discord nao deixou tirar
        });

        test("a janela foi desmontada (o player saiu da tela) mas o Discord ainda a tem aberta: segue aberta", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            const { unmount } = render(<>{popoutContent()}</>);
            await settle();
            unmount();
            act(() => clock.tick(250));
            assert.equal(isViewerOpen(PEER), true);
            assert.equal(stops(streamer), 0);
        });

        test("o player desmontou e a janela nao existe mais: encerra depois de 250 ms", async t => {
            const clock = useFakeClock(t);
            PopoutActions.autoOpen = false; // o Discord nunca reportou a janela: so o desmonte denuncia
            openViewer(PEER);
            await settle();
            const { unmount } = render(<>{popoutContent()}</>);
            await settle();
            unmount();
            assert.equal(isViewerOpen(PEER), true, "ainda na espera dos 250 ms");
            act(() => clock.tick(250));
            assert.equal(isViewerOpen(PEER), false);
            assert.equal(stops(streamer), 1);
        });

        test("o player do pop-out quebra: o erro vai para o log (a janela do Discord nao cai junto)", async t => {
            t.mock.method(console, "error", () => { });
            openViewer(PEER);
            await settle();
            render(<>{popoutContent()}</>);
            await settle();
            t.mock.method(UserStore, "getUser", () => {
                throw new Error("store quebrado");
            });
            // o ViewerContent le o estado do Telinha: um estado novo o renderiza de novo (e ele quebra)
            act(() => setState({ ...getState() }));
            assert.equal(caughtErrors.length, 1);
            caughtErrors.length = 0;
            assert.ok(loggerLines.some(l => l.level === "error" && l.args[0] === "O player no pop-out quebrou"));
        });
    });

    // #endregion

    // #region painel flutuante

    describe("painel flutuante (o pop-out nao montou)", () => {
        test("depois de 6 s sem o player montar, a sessao continua e o player passa para um painel dentro do Discord", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            act(() => clock.tick(5999));
            assert.equal(panels().length, 0);

            const { panel } = await fallBackToFloating(clock);
            assert.equal(panels().length, 1);
            assert.ok(warnings().some(w => /player não montou em 6 s/.test(w) && /painel flutuante/.test(w)), warnings().join("|"));
            assert.deepEqual(PopoutActions.closed, [KEY], "o pop-out que nao montou foi fechado");
            assert.equal(stops(streamer), 0, "trocar de pop-out para painel nao encerra a sessao");
            assert.equal(isViewerOpen(PEER), true);
            assert.equal(panel.querySelector(".vc-telinha-floating-title")!.textContent, "amigo — Telinha");
            assert.ok(screen.getByRole("button", { name: "Parar de assistir" }), "o player esta dentro do painel");
            await endFloating(clock);
        });

        test("o painel nasce no canto de baixo e cada painel novo vem um pouco deslocado", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            const first = await fallBackToFloating(clock);
            assert.deepEqual({ x: parseFloat(first.panel.style.left), y: parseFloat(first.panel.style.top) }, floatingPos(first.index));

            openViewer(PEER_B);
            await settle();
            const second = await fallBackToFloating(clock);
            assert.deepEqual({ x: parseFloat(second.panel.style.left), y: parseFloat(second.panel.style.top) }, floatingPos(second.index));
            assert.ok(second.panel !== first.panel);
            await endFloating(clock);
        });

        test("o pop-out monta tarde demais (o painel ja esta de pe): e ignorado e fecha-lo nao encerra a sessao", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            const late = popoutContent();
            await fallBackToFloating(clock);

            const { unmount } = render(<>{late}</>);
            await settle();
            unmount();
            act(() => clock.tick(300));
            assert.equal(isViewerOpen(PEER), true, "so o painel conta agora");
            assert.equal(stops(streamer), 0);
            await endFloating(clock);
        });

        test("\"Fechar\" no painel para de assistir uma vez e tira o painel da tela", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            const { panel } = await fallBackToFloating(clock);

            fireEvent.click(panel.querySelector("button[aria-label=\"Fechar\"]")!);
            act(() => clock.tick(0));
            await settle();
            assert.equal(stops(streamer), 1);
            assert.equal(isViewerOpen(PEER), false);
            assert.equal(panels().length, 0);
            assert.equal(getState().viewing[PEER], undefined);
        });

        test("\"Parar de assistir\" dentro do painel tambem encerra tudo", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            await fallBackToFloating(clock);
            fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
            act(() => clock.tick(0));
            await settle();
            assert.equal(stops(streamer), 1);
            assert.equal(panels().length, 0);
        });

        test("pedir de novo com o painel aberto o traz para a frente (de volta ao fim do <body>)", async t => {
            const clock = useFakeClock(t);
            openViewer(PEER);
            await settle();
            const a = await fallBackToFloating(clock);
            openViewer(PEER_B);
            await settle();
            const b = await fallBackToFloating(clock);
            assert.ok(panels().at(-1) === b.panel);

            openViewer(PEER);
            await settle();
            assert.ok(panels().at(-1) === a.panel, "o painel do primeiro amigo ficou por cima");
            assert.equal(starts(streamer), 1, "e nao pediu o stream de novo");
            await endFloating(clock);
        });

        test("abrir o pop-out lanca: vai direto para o painel flutuante", async t => {
            const clock = useFakeClock(t);
            t.mock.method(PopoutActions, "open", () => {
                throw new Error("janela bloqueada");
            });
            act(() => openViewer(PEER));
            await settle();
            floatingIndex();
            assert.equal(panels().length, 1);
            assert.ok(warnings().some(w => w.includes("abrir lançou: janela bloqueada")), warnings().join("|"));
            assert.equal(stops(streamer), 0);
            act(() => clock.tick(60_000)); // o timer dos 6 s nao faz mais nada (ja esta no painel)
            assert.equal(panels().length, 1);
            await endFloating(clock);
        });

        test("o React falha ao desmontar o painel: o painel sai da tela do mesmo jeito", async t => {
            const clock = useFakeClock(t);
            const reactDomClient = createRequire(__filename)("react-dom/client") as { createRoot(el: Element): { render(node: unknown): void; unmount(): void; }; };
            const realCreateRoot = reactDomClient.createRoot;
            const patched = t.mock.method(reactDomClient, "createRoot", (el: Element) => {
                const root = realCreateRoot(el);
                return {
                    render: (node: unknown) => root.render(node),
                    unmount() {
                        root.unmount();
                        throw new Error("unmount falhou");
                    }
                };
            });
            openViewer(PEER);
            await settle();
            await fallBackToFloating(clock);
            assert.equal(panels().length, 1);
            await endFloating(clock);
            patched.mock.restore();
        });

        test("o painel quebra: o erro vai para o log", async t => {
            const clock = useFakeClock(t);
            t.mock.method(console, "error", () => { });
            openViewer(PEER);
            await settle();
            await fallBackToFloating(clock);
            t.mock.method(UserStore, "getUser", () => {
                throw new Error("store quebrado");
            });
            act(() => setState({ ...getState() }));
            assert.ok(caughtErrors.length >= 1);
            caughtErrors.length = 0;
            assert.ok(loggerLines.some(l => l.level === "error" && l.args[0] === "O painel flutuante quebrou"));
            // o player saiu da tela: o visualizador se encerra (a sessao nao fica presa sem janela)
            act(() => clock.tick(0));
            await settle();
            assert.equal(isViewerOpen(PEER), false);
            assert.equal(stops(streamer), 1);
        });

        describe("arrastar", () => {
            async function floatingPanel(t: TestContext) {
                const clock = useFakeClock(t);
                openViewer(PEER);
                await settle();
                const { panel, index } = await fallBackToFloating(clock);
                return { clock, panel, start: floatingPos(index) };
            }

            test("segurar o cabecalho e mover leva o painel junto, sem sair da tela", async t => {
                const { clock, panel, start } = await floatingPanel(t);
                const bar = header(panel);

                fireEvent.pointerDown(bar, { clientX: start.x + 20, clientY: start.y + 10, pointerId: 1 });
                fireEvent.pointerMove(bar, { clientX: start.x + 120, clientY: start.y - 60, pointerId: 1 });
                assert.equal(parseFloat(panel.style.left), start.x + 100);
                assert.equal(parseFloat(panel.style.top), start.y - 70);

                fireEvent.pointerMove(bar, { clientX: 5000, clientY: 5000, pointerId: 1 });
                assert.equal(parseFloat(panel.style.left), window.innerWidth - 120, "pelo menos 120 px ficam visiveis");
                assert.equal(parseFloat(panel.style.top), window.innerHeight - 40);
                fireEvent.pointerMove(bar, { clientX: -500, clientY: -500, pointerId: 1 });
                assert.equal(parseFloat(panel.style.left), 0);
                assert.equal(parseFloat(panel.style.top), 0);
                await endFloating(clock);
            });

            test("soltar (ou cancelar) o toque para o arraste", async t => {
                const { clock, panel, start } = await floatingPanel(t);
                const bar = header(panel);
                fireEvent.pointerDown(bar, { clientX: start.x, clientY: start.y, pointerId: 1 });
                fireEvent.pointerMove(bar, { clientX: start.x + 30, clientY: start.y, pointerId: 1 });
                fireEvent.pointerUp(bar, { pointerId: 1 });
                fireEvent.pointerMove(bar, { clientX: start.x + 300, clientY: start.y, pointerId: 1 });
                assert.equal(parseFloat(panel.style.left), start.x + 30, "depois de soltar, mexer o mouse nao arrasta");

                fireEvent.pointerDown(bar, { clientX: start.x + 30, clientY: start.y, pointerId: 2 });
                fireEvent.pointerCancel(bar, { pointerId: 2 });
                fireEvent.pointerMove(bar, { clientX: start.x + 200, clientY: start.y, pointerId: 2 });
                assert.equal(parseFloat(panel.style.left), start.x + 30);
                await endFloating(clock);
            });

            test("mover o mouse sem ter segurado o cabecalho nao faz nada; o botao Fechar nao inicia arraste", async t => {
                const { clock, panel, start } = await floatingPanel(t);
                const bar = header(panel);
                fireEvent.pointerMove(bar, { clientX: start.x + 50, clientY: start.y, pointerId: 1 });
                assert.equal(parseFloat(panel.style.left), start.x);

                fireEvent.pointerDown(panel.querySelector("button[aria-label=\"Fechar\"]")!, { clientX: start.x, clientY: start.y, pointerId: 3 });
                fireEvent.pointerMove(bar, { clientX: start.x + 50, clientY: start.y, pointerId: 3 });
                assert.equal(parseFloat(panel.style.left), start.x, "clicar em Fechar nao arrasta");
                await endFloating(clock);
            });
        });
    });

    // #endregion

    // #region o Discord responde de formas estranhas

    describe("Discord estranho", () => {
        test("focar uma janela que o Discord nao sabe mais focar nao quebra nada", async t => {
            openViewer(PEER);
            await settle();
            t.mock.method(PopoutWindowStore, "getWindow", () => {
                throw new Error("janela sumiu");
            });
            assert.doesNotThrow(() => openViewer(PEER));
            assert.equal(PopoutActions.opened.length, 1);
        });

        test("o Discord falha ao dizer se a janela esta aberta: conta como fechada", async t => {
            t.mock.method(PopoutWindowStore, "getWindowOpen", () => {
                throw new Error("store quebrado");
            });
            openViewer(PEER);
            await settle();
            assert.equal(PopoutActions.opened.length, 1);
            assert.equal(isViewerOpen(PEER), true);
        });
    });

    // #endregion
});
