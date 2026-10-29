/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O que o usuario ve e faz na tile de um participante da call (ui/callView/CallTileStream.tsx), renderizada de verdade
// (React + happy-dom) com o estado do Telinha montado direto (setState). A etiqueta "Assistir", cada estado da
// conexao, os controles (volume, tela cheia, ocultar a previa), a previa da propria transmissao e a escolha da versao
// compacta pela largura. Os fluxos que mexem no nucleo (clicar em Assistir e ver o pedido sair, senha, janela) estao
// em CallTileStream.core.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/CallTileStream.test.tsx

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { type LocalCapture, rt } from "@plugins/telinha/core/context";
import { resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState, ViewerSession } from "@plugins/telinha/types";
import { useFakeClock } from "@test/fakes/clock";
import { fullscreen, media, resetMedia, resizeObservers } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, screen, settle, within } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, loggerLines, makeUser, ME_ID, PopoutWindowStore, resetVencordFakes, UserStore } from "@test/fakes/vencord";
import { captureStream } from "@test/fakes/webrtc";
import { animations, assertAbsent, installAnimate } from "@test/helpers/wpe-dom";
import type { ReactNode } from "react";

import { CallTileStream } from "./CallTileStream";
import { getVolume, isLocalPreviewHidden, isTileOwned, resetTileState, setLocalPreviewHidden, setVolume } from "./tileState";

const PEER = "peerA";
const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

function friend(patch: Partial<RemotePeer> = {}): RemotePeer {
    return {
        peerId: PEER, discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "Tela", hasAudio: false, width: 1920, height: 1080, fps: 60, access: "all" },
        ...patch
    };
}

function session(patch: Partial<ViewerSession> = {}): ViewerSession {
    return { peerId: PEER, stream: null, status: "playing", ...patch };
}

function stream(audio = false): MediaStream {
    return captureStream({ audio }) as unknown as MediaStream;
}

/** Estado com o amigo e (opcionalmente) a sessao de quem assiste */
function show(sess: ViewerSession | null, peer: Partial<RemotePeer> = {}, extra: Partial<TelinhaState> = {}) {
    act(() => setState({ ...EMPTY, peers: [friend(peer)], viewing: sess ? { [PEER]: sess } : {}, ...extra }));
}

/** Renderiza e deixa passar as promessas do mount (play(), registro da tile) dentro do act() */
async function mount(ui: ReactNode) {
    const result = render(ui);
    await settle();
    return result;
}

const tile = (container: HTMLElement) => container.firstElementChild as HTMLElement;
const video = (container: HTMLElement) => container.querySelector("video") as HTMLVideoElement | null;
/** A linha de controles de cima (etiqueta TELINHA, nome, estatisticas, botoes) */
const controls = () => screen.getByTitle(/está transmitindo pelo Telinha/).parentElement as HTMLElement;
const resize = (el: HTMLElement, width: number) => act(() => resizeObservers.resize(el, { width, height: Math.round(width * 9 / 16) }));

describe("CallTileStream", () => {
    let restoreAnimate: () => void;
    before(() => void (restoreAnimate = installAnimate()));
    after(() => restoreAnimate());

    beforeEach(() => {
        resetVencordFakes();
        resetMedia();
        resetState();
        animations.reset();
        // o volume lembrado por amigo vive o processo inteiro (ate o Discord fechar): cada teste comeca no padrao
        for (const key of [FRIEND_ID, PEER]) setVolume(key, { volume: 1, muted: false });
    });

    afterEach(async () => {
        cleanup();
        await act(async () => {
            resetTileState();
            setLocalPreviewHidden(false);
        });
        rt.local = null;
        rt.viewing.clear();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    // #region etiqueta "Assistir"

    describe("amigo transmitindo que voce ainda nao assiste", () => {
        test("fora de uma sala do Telinha: a tile fica como o Discord desenhou", () => {
            show(null, {}, { inRoom: false });
            const { container } = render(<CallTileStream userId={FRIEND_ID} />);
            assert.equal(container.innerHTML, "");
        });

        test("participante desconhecido, ou amigo que nao esta transmitindo: nada", () => {
            show(null);
            const stranger = render(<CallTileStream userId="999999999999999999" />);
            assert.equal(stranger.container.innerHTML, "");
            stranger.unmount();

            show(null, { streaming: false, stream: undefined });
            const idle = render(<CallTileStream userId={FRIEND_ID} />);
            assert.equal(idle.container.innerHTML, "");
        });

        test("etiqueta \"TELINHA · Assistir\" com o nome dele; \"Todos da call\" nao mostra selo de acesso", () => {
            show(null);
            render(<CallTileStream userId={FRIEND_ID} />);
            const button = screen.getByRole("button", { name: "Assistir a transmissão de amigo pelo Telinha" });
            assert.equal(button.textContent, "TELINHA · Assistir");
            assert.equal(button.getAttribute("title"), "amigo está transmitindo pelo Telinha — clique para assistir aqui na call");
            assertAbsent(screen.queryByText(/só amigos|com aprovação|com senha/));
        });

        test("usa o nome do Discord quando ele e conhecido", () => {
            UserStore.addUsers(makeUser(FRIEND_ID, "amigo123", { globalName: "Ana" }));
            show(null);
            render(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(screen.getByRole("button", { name: "Assistir a transmissão de Ana pelo Telinha" }));
        });

        test("mostra quem pode assistir: com senha, so amigos ou com aprovacao", () => {
            for (const [access, badge] of [["password", "🔒 com senha"], ["friends", "👥 só amigos"], ["approval", "✋ com aprovação"]] as const) {
                show(null, { stream: { ...friend().stream!, access } });
                const { unmount } = render(<CallTileStream userId={FRIEND_ID} />);
                assert.ok(screen.getByText(badge), badge);
                assert.match(screen.getByRole("button").getAttribute("title")!, new RegExp(`\\(${badge}\\)`));
                unmount();
            }
        });

        test("tile pequena: so \"Assistir\" e o selo vira um icone", () => {
            show(null, { stream: { ...friend().stream!, access: "password" } });
            const { container } = render(<CallTileStream userId={FRIEND_ID} />);
            resize(tile(container), 150);
            assert.equal(screen.getByRole("button").textContent, "Assistir");
            assert.equal(screen.getByText("🔒").textContent, "🔒");
            assertAbsent(screen.queryByText("🔒 com senha"));

            resize(tile(container), 400);
            assert.equal(screen.getByRole("button").textContent, "TELINHA · Assistir");
            assert.ok(screen.getByText("🔒 com senha"));
        });

        test("clicar na etiqueta pede para assistir e nao foca/amplia a tile do Discord", async () => {
            show(null);
            let discordClicks = 0;
            render(<div onClick={() => discordClicks++} onDoubleClick={() => discordClicks++} onKeyDown={() => discordClicks++}><CallTileStream userId={FRIEND_ID} /></div>);
            const button = screen.getByRole("button");
            fireEvent.doubleClick(button);
            fireEvent.keyDown(button, { key: "Enter" });
            fireEvent.mouseDown(button);
            assert.equal(discordClicks, 0);

            fireEvent.click(button);
            assert.equal(isTileOwned(PEER), true, "a tile passou a ser dona da sessao");
            assert.equal(discordClicks, 0, "o clique ficou no Telinha");
            await settle(); // o nucleo publica a sessao num microtask (o pedido em si e conferido em CallTileStream.core.test.tsx)
        });
    });

    // #endregion

    // #region sessao em andamento: avisos

    describe("estado da conexao ao assistir", () => {
        const cases: { name: string; sess: ViewerSession; peer?: Partial<RemotePeer>; title: string; detail?: RegExp; buttons: string[]; }[] = [
            { name: "conectando", sess: session({ status: "connecting" }), title: "Conectando…", buttons: [] },
            { name: "esperando o transmissor aprovar", sess: session({ status: "connecting", awaitingApproval: true }), title: "Aguardando o transmissor aprovar…", buttons: [] },
            { name: "conferindo a senha", sess: session({ status: "connecting", checkingPassword: true }), title: "Conferindo a senha…", buttons: [] },
            { name: "pedindo a senha", sess: session({ status: "connecting", passwordPrompt: { attemptsLeft: 5, wrong: false } }), title: "Esta transmissão é com senha", detail: /Digite a senha que amigo passou/, buttons: [] },
            { name: "senha errada, 2 tentativas", sess: session({ status: "connecting", passwordPrompt: { attemptsLeft: 2, wrong: true } }), title: "Senha incorreta", detail: /Confira com amigo e tente de novo\. Restam 2 tentativas\./, buttons: [] },
            { name: "senha errada, a ultima tentativa", sess: session({ status: "connecting", passwordPrompt: { attemptsLeft: 1, wrong: true } }), title: "Senha incorreta", detail: /Resta 1 tentativa\./, buttons: [] },
            { name: "esperando o primeiro quadro", sess: session({ status: "waiting-first-frame" }), title: "Aguardando a primeira imagem…", buttons: [] },
            { name: "tocando mas sem imagem ainda", sess: session({ status: "playing", stream: null }), title: "Aguardando a primeira imagem…", buttons: [] },
            { name: "a transmissao acabou", sess: session({ status: "ended" }), title: "A transmissão terminou", buttons: ["Tentar de novo", "Fechar"] },
            { name: "a transmissao acabou e ele parou de transmitir", sess: session({ status: "ended" }), peer: { streaming: false }, title: "A transmissão terminou", buttons: ["Fechar"] },
            { name: "erro sem motivo", sess: session({ status: "error", error: "Falha ao pedir a transmissão: x" }), title: "Não foi possível assistir", detail: /Falha ao pedir a transmissão: x/, buttons: ["Tentar de novo", "Fechar"] },
            { name: "expulso", sess: session({ status: "error", denied: "kicked", error: "O transmissor encerrou a sua visualização." }), title: "O transmissor encerrou sua visualização", detail: /encerrou a sua visualização\./, buttons: ["Tentar de novo", "Fechar"] },
            { name: "recusado", sess: session({ status: "error", denied: "declined" }), title: "O transmissor recusou sua visualização", buttons: ["Tentar de novo", "Fechar"] },
            { name: "so para amigos", sess: session({ status: "error", denied: "friendsOnly" }), title: "Esta transmissão é só para amigos de amigo", buttons: ["Tentar de novo", "Fechar"] },
            { name: "senha errada demais", sess: session({ status: "error", denied: "tooManyAttempts" }), title: "Senha errada vezes demais", buttons: ["Tentar de novo", "Fechar"] }
        ];

        for (const c of cases) {
            test(c.name, async () => {
                show(c.sess, c.peer);
                const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
                const overlay = screen.getByText(c.title).parentElement as HTMLElement;
                if (c.detail) assert.match(overlay.textContent!, c.detail);
                const buttons = within(overlay).queryAllByRole("button").map(b => b.getAttribute("aria-label") ?? b.textContent);
                const expected = [...c.buttons];
                if (c.title === "Esta transmissão é com senha" || c.title === "Senha incorreta") expected.push("Mostrar a senha", "Assistir");
                assert.deepEqual(buttons, expected, c.name);
                assert.equal(controls().style.opacity, "1", "com um aviso na tela os controles ficam sempre visiveis");
                assertAbsent(video(container), "sem imagem para tocar");
            });
        }

        test("um status que esta versao nao conhece (nucleo mais novo): nenhum aviso por cima da imagem", async () => {
            show(session({ status: "novo" as ViewerSession["status"], stream: stream() }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(video(container));
            assert.equal(controls().style.opacity, "0");
        });

        test("campo de senha na tile (versao compacta: sem o botao Mostrar) e \"Autorizar o Telinha\" depois de notVerified", async () => {
            show(session({ status: "connecting", passwordPrompt: { attemptsLeft: null, wrong: false } }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(screen.getByLabelText("Senha da transmissão"));
            assert.ok(screen.getByRole("button", { name: "Mostrar a senha" }));
            resize(tile(container), 250);
            assertAbsent(screen.queryByRole("button", { name: "Mostrar a senha" }), "compacta");

            show(session({ status: "error", denied: "notVerified", error: "Autorize o Telinha" }));
            await settle();
            assert.ok(screen.getByText("Autorize o Telinha no Discord para assistir"));
            assert.ok(screen.getByRole("button", { name: "Autorizar o Telinha" }));
            assertAbsent(screen.queryByLabelText("Senha da transmissão"));
        });

        test("tile muito pequena: titulo menor e sem o detalhe", async () => {
            show(session({ status: "error", denied: "kicked", error: "detalhe longo" }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(screen.getByText("detalhe longo"));
            resize(tile(container), 150);
            assertAbsent(screen.queryByText("detalhe longo"));
            assert.equal(screen.getByText("O transmissor encerrou sua visualização").style.fontSize, "12px");
            assert.equal(controls().querySelector("span")!.textContent, "", "so o icone, sem a palavra TELINHA");
        });

        test("o aviso nao deixa o clique chegar na tile do Discord", async () => {
            show(session({ status: "ended" }));
            let discordClicks = 0;
            await mount(<div onClick={() => discordClicks++}><CallTileStream userId={FRIEND_ID} /></div>);
            fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
            assert.equal(discordClicks, 0);
        });
    });

    // #endregion

    // #region imagem e controles

    describe("assistindo", () => {
        test("a imagem toca dentro da tile; os controles somem e o cursor tambem, ate o mouse mexer", async t => {
            const clock = useFakeClock(t);
            const s = stream();
            show(session({ stream: s, stats: { width: 1920, height: 1080, fps: 59.6, kbps: 4200 } }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);

            const v = video(container)!;
            assert.ok(v, "ha um <video> na tile");
            assert.ok(v.srcObject === s);
            assert.equal(v.autoplay, true);
            assert.ok(media.played.includes(v), "play() foi chamado");
            assertAbsent(screen.queryByText("Aguardando a primeira imagem…"), "sem aviso por cima da imagem");

            assert.equal(controls().style.opacity, "0", "controles escondidos");
            assert.equal(tile(container).style.cursor, "none");
            const stop = screen.getByRole("button", { name: "Parar de assistir" });
            assert.equal(stop.style.pointerEvents, "none", "o clique passa para a tile do Discord");
            assert.equal(stop.getAttribute("tabindex"), "-1");

            fireEvent.mouseMove(tile(container));
            assert.equal(controls().style.opacity, "1");
            assert.equal(stop.style.pointerEvents, "auto");
            assert.equal(stop.getAttribute("tabindex"), null);
            assert.equal(tile(container).style.cursor, "");

            act(() => clock.tick(2499));
            assert.equal(controls().style.opacity, "1", "ainda dentro dos 2,5 s");
            fireEvent.mouseMove(tile(container)); // mexeu de novo: reinicia a contagem
            act(() => clock.tick(2499));
            assert.equal(controls().style.opacity, "1");
            act(() => clock.tick(1));
            assert.equal(controls().style.opacity, "0", "parado por 2,5 s: some");
        });

        test("o mouse sai da tile: os controles somem na hora", async () => {
            show(session({ stream: stream() }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            fireEvent.mouseMove(tile(container));
            assert.equal(controls().style.opacity, "1");
            fireEvent.mouseLeave(tile(container));
            assert.equal(controls().style.opacity, "0");
        });

        test("clicar na imagem segue para a tile do Discord (focar/ampliar); clicar nos botoes nao", async () => {
            show(session({ stream: stream() }));
            let discordClicks = 0;
            const { container } = await mount(<div onClick={() => discordClicks++}><CallTileStream userId={FRIEND_ID} /></div>);
            const root = tile(tile(container));
            fireEvent.click(root);
            assert.equal(discordClicks, 1);
            fireEvent.mouseMove(root);
            const fullscreenButton = screen.getByRole("button", { name: "Tela cheia" });
            fireEvent.click(fullscreenButton);
            fireEvent.keyDown(fullscreenButton, { key: "Enter" });
            assert.equal(discordClicks, 1);
        });

        test("etiqueta com o nome, a resolucao e os fps; sem altura medida ainda, so o nome", async () => {
            show(session({ stream: stream(), stats: { width: 1920, height: 1080, fps: 59.6, kbps: 4200 } }));
            await mount(<CallTileStream userId={FRIEND_ID} />);
            const row = controls();
            assert.equal(within(row).getByTitle("amigo está transmitindo pelo Telinha").textContent, "TELINHA");
            assert.ok(within(row).getByText("amigo"));
            assert.ok(within(row).getByText("1080p · 60 fps"));

            show(session({ stream: stream(), stats: { width: 0, height: 0, fps: 0, kbps: 0 } }));
            await settle();
            assertAbsent(within(controls()).queryByText(/fps/));
        });

        test("tile estreita (< 300 px): sem nome, sem estatisticas e botoes so com icone", async () => {
            show(session({ stream: stream(), stats: { width: 1920, height: 1080, fps: 60, kbps: 4200 } }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            const wide = screen.getByRole("button", { name: "Abrir em janela" });
            assert.equal(wide.textContent, "Abrir em janela");
            assert.equal(screen.getByRole("button", { name: "Parar de assistir" }).textContent, "Parar de assistir");

            resize(tile(container), 250);
            assertAbsent(within(controls()).queryByText("amigo"));
            assertAbsent(within(controls()).queryByText(/fps/));
            assert.equal(screen.getByRole("button", { name: "Abrir em janela" }).textContent, "");
            assert.equal(screen.getByRole("button", { name: "Parar de assistir" }).textContent, "");

            resize(tile(container), 800);
            assert.ok(within(controls()).getByText("amigo"));
            assert.ok(within(controls()).getByText("1080p · 60 fps"));
        });

        test("call no pop-out do Discord (outro documento/janela): o <video> nasce no documento da tile e os controles funcionam la dentro", async () => {
            show(session({ stream: stream(true) }), { stream: { ...friend().stream!, hasAudio: true } });
            const iframe = document.createElement("iframe"); // happy-dom: um documento com janela propria, como o pop-out
            document.body.appendChild(iframe);
            const popoutDoc = iframe.contentDocument!;
            const host = popoutDoc.body.appendChild(popoutDoc.createElement("div"));
            render(<CallTileStream userId={FRIEND_ID} />, { container: host });
            await settle();

            const v = host.querySelector("video")!;
            assert.ok(v.ownerDocument === popoutDoc, "o <video> e criado pelo documento do pop-out");
            assert.ok(media.played.includes(v));
            fireEvent.click(within(host).getByRole("button", { name: "Silenciar" }));
            assert.equal(v.muted, true);
            assert.equal(getVolume(FRIEND_ID).muted, true);
        });

        test("o Discord nao deixa observar as janelas do visualizador: a tile funciona do mesmo jeito (confere so pelo relogio)", async t => {
            t.mock.method(PopoutWindowStore, "addChangeListener", () => {
                throw new Error("sem store");
            });
            show(session({ stream: stream() }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(video(container));
            assert.ok(screen.getByRole("button", { name: "Abrir em janela" }));
        });

        test("um <video> que falha ao parar nao impede a tile de fechar", async t => {
            show(session({ stream: stream() }));
            const { unmount } = await mount(<CallTileStream userId={FRIEND_ID} />);
            const pause = t.mock.method(HTMLMediaElement.prototype, "pause", () => {
                throw new Error("pause falhou");
            });
            assert.doesNotThrow(() => unmount());
            pause.mock.restore();
        });

        test("a imagem some quando a sessao termina e volta com um stream novo", async () => {
            const first = stream();
            show(session({ stream: first }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            const v1 = video(container)!;
            assert.ok(v1.srcObject === first);

            show(session({ status: "ended" }));
            await settle();
            assertAbsent(video(container));
            assert.equal(v1.srcObject, null, "o <video> antigo foi solto");

            const second = stream();
            show(session({ stream: second }));
            await settle();
            assert.ok(video(container)!.srcObject === second);
            assert.equal(container.querySelectorAll("video").length, 1);
        });
    });

    // #endregion

    // #region som

    describe("som", () => {
        const withAudio = (s: MediaStream | null = stream(true)) => show(session({ stream: s }), { stream: { ...friend().stream!, hasAudio: true } });
        const warnings = () => loggerLines.filter(l => l.logger === "Telinha UI" && l.level === "warn").map(l => String(l.args[0]));

        test("transmissao sem som: a tile nao mostra nenhum controle de som", async () => {
            show(session({ stream: stream(false) }));
            await mount(<CallTileStream userId={FRIEND_ID} />);
            assertAbsent(screen.queryByRole("button", { name: /Silenciar|Ativar som/ }));
            assertAbsent(screen.queryByLabelText("Volume"));
        });

        test("o anuncio do transmissor (hasAudio) basta para mostrar o som, mesmo antes de a trilha chegar", async () => {
            show(session({ status: "connecting" }), { stream: { ...friend().stream!, hasAudio: true } });
            await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(screen.getByRole("button", { name: "Silenciar" }));
        });

        test("volume e silenciar mexem no video e ficam lembrados para esse amigo ao reabrir a tile", async () => {
            withAudio();
            const first = await mount(<CallTileStream userId={FRIEND_ID} />);
            const v = video(first.container)!;
            assert.equal(v.muted, false, "a primeira tile toca o som");
            assert.equal(v.volume, 1);
            const slider = screen.getByLabelText("Volume") as HTMLInputElement;
            assert.equal(slider.value, "100");
            assert.equal(slider.title, "Volume: 100%");

            fireEvent.change(slider, { target: { value: "40" } });
            assert.equal(v.volume, 0.4);
            assert.equal(slider.title, "Volume: 40%");
            assert.deepEqual(getVolume(FRIEND_ID), { volume: 0.4, muted: false });

            fireEvent.click(screen.getByRole("button", { name: "Silenciar" }));
            assert.equal(v.muted, true);
            assert.equal((screen.getByLabelText("Volume") as HTMLInputElement).value, "0", "o controle mostra 0 enquanto mudo");
            assert.deepEqual(getVolume(FRIEND_ID), { volume: 0.4, muted: true });

            fireEvent.click(screen.getByRole("button", { name: "Ativar som" }));
            assert.equal(v.muted, false);
            assert.equal((screen.getByLabelText("Volume") as HTMLInputElement).value, "40");

            fireEvent.change(screen.getByLabelText("Volume"), { target: { value: "0" } });
            assert.deepEqual(getVolume(FRIEND_ID), { volume: 0, muted: true }, "volume zero tambem silencia");
            first.unmount();

            const again = await mount(<CallTileStream userId={FRIEND_ID} />);
            const v2 = video(again.container)!;
            assert.equal(v2.volume, 0);
            assert.equal(v2.muted, true);
            assert.equal((screen.getByLabelText("Volume") as HTMLInputElement).value, "0");
        });

        test("volume lembrado de antes vale ja na primeira tile", async () => {
            setVolume(FRIEND_ID, { volume: 0.25, muted: false });
            withAudio();
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.equal(video(container)!.volume, 0.25);
            assert.equal((screen.getByLabelText("Volume") as HTMLInputElement).value, "25");
        });

        test("sem o id do Discord do amigo, o volume fica guardado pela conexao", async () => {
            show(session({ stream: stream(true) }), { discordUserId: "" });
            await mount(<CallTileStream userId="" />);
            fireEvent.change(screen.getByLabelText("Volume"), { target: { value: "30" } });
            assert.deepEqual(getVolume(PEER), { volume: 0.3, muted: false });
        });

        test("duas tiles do mesmo amigo (call na janela principal e no pop-out): so a primeira toca; se ela sai, a outra assume", async () => {
            withAudio();
            const both = (first: boolean) => (
                <>
                    {first && <CallTileStream key="a" userId={FRIEND_ID} />}
                    <CallTileStream key="b" userId={FRIEND_ID} />
                </>
            );
            const { container, rerender } = await mount(both(true));
            const [a, b] = Array.from(container.querySelectorAll("video"));
            assert.equal(a.muted, false);
            assert.equal(b.muted, true);
            assert.equal(screen.getAllByLabelText("Volume").length, 1, "controle de som so na tile que toca");

            rerender(both(false));
            await settle();
            const [only] = Array.from(container.querySelectorAll("video"));
            assert.ok(only === b, "o <video> da outra tile foi mantido");
            assert.equal(only.muted, false, "agora ela toca");
            assert.equal(screen.getAllByLabelText("Volume").length, 1);
        });

        test("tile estreita: mutar sem a barra de volume", async () => {
            withAudio();
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            resize(tile(container), 250);
            assert.ok(screen.getByRole("button", { name: "Silenciar" }));
            assertAbsent(screen.queryByLabelText("Volume"));
        });

        test("o navegador recusa tocar com som: toca mudo e oferece \"Ativar som\"; o clique liga o som", async () => {
            media.playImpl = async el => {
                if (!el.muted) throw new DOMException("autoplay com som", "NotAllowedError");
            };
            withAudio();
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            const v = video(container)!;
            const enable = screen.getByRole("button", { name: "Ativar som" });
            assert.equal(enable.textContent, "Ativar som");
            assert.equal(v.muted, true, "enquanto isso, mudo");
            assertAbsent(screen.queryByLabelText("Volume"));
            assert.equal(controls().style.opacity, "1", "o convite aparece mesmo sem mexer o mouse");

            media.playImpl = null; // o clique e um gesto do usuario: agora o navegador deixa
            fireEvent.click(enable);
            await settle();
            assert.equal(v.muted, false);
            assert.ok(screen.getByRole("button", { name: "Silenciar" }));
            assert.equal(warnings().length, 0);
        });

        test("tile muito pequena: o convite vira so o icone", async () => {
            media.playImpl = async el => {
                if (!el.muted) throw new DOMException("autoplay com som", "NotAllowedError");
            };
            withAudio();
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            resize(tile(container), 150);
            assert.equal(screen.getByRole("button", { name: "Ativar som" }).textContent, "");
        });

        test("recusa tocar mesmo mudo, e nem o clique adianta: tudo fica no log, a tile continua de pe", async () => {
            media.playImpl = async () => {
                throw new DOMException("bloqueado", "NotAllowedError");
            };
            withAudio();
            await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(warnings().includes("play() mudo da tile também falhou"));

            fireEvent.click(screen.getByRole("button", { name: "Ativar som" }));
            await settle();
            assert.ok(warnings().includes("play() com som da tile falhou"));
        });

        test("play() falha por outro motivo: log; interrupcao (AbortError) e normal e nao polui o log", async () => {
            media.playImpl = async () => {
                throw new DOMException("trocou o stream", "AbortError");
            };
            show(session({ stream: stream() }));
            const { unmount } = await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.deepEqual(warnings(), []);
            unmount();

            media.playImpl = async () => {
                throw new Error("decodificador");
            };
            await mount(<CallTileStream userId={FRIEND_ID} />);
            assert.ok(warnings().includes("play() da tile falhou"));
            assertAbsent(screen.queryByRole("button", { name: "Ativar som" }), "so o autoplay recusado oferece ligar o som");

            media.playImpl = () => Promise.reject(undefined); // o navegador rejeita sem nenhum erro: ainda assim so vai para o log
            show(session({ stream: stream() }));
            await settle();
            assert.ok(warnings().length >= 2);
        });

        test("stream novo com a tile tocando com som: a recusa do navegador e tratada de novo", async () => {
            withAudio();
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            media.playImpl = async el => {
                if (!el.muted) throw new DOMException("autoplay com som", "NotAllowedError");
            };
            withAudio(stream(true));
            await settle();
            assert.ok(screen.getByRole("button", { name: "Ativar som" }));
            assert.equal(video(container)!.muted, true);
        });
    });

    // #endregion

    // #region tela cheia

    describe("tela cheia", () => {
        test("entra e sai; em tela cheia mostra o nome e os controles mesmo na versao compacta", async () => {
            show(session({ stream: stream() }));
            const { container } = await mount(<CallTileStream userId={FRIEND_ID} />);
            const root = tile(container);
            resize(root, 250);
            assertAbsent(within(controls()).queryByText("amigo"));

            fireEvent.mouseMove(root);
            fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
            await settle();
            assert.ok(document.fullscreenElement === root);
            assert.ok(within(controls()).getByText("amigo"), "o nome aparece em tela cheia");
            fireEvent.mouseLeave(root);
            assert.equal(controls().style.opacity, "1", "em tela cheia os controles nao somem");

            fireEvent.click(screen.getByRole("button", { name: "Sair da tela cheia" }));
            await settle();
            assertAbsent(document.fullscreenElement);
            assert.ok(screen.getByRole("button", { name: "Tela cheia" }));
            assertAbsent(within(controls()).queryByText("amigo"));
            assert.equal(controls().style.opacity, "0");
        });

        test("o navegador recusa a tela cheia: fica registrado e a tile segue normal", async () => {
            fullscreen.refuse = true;
            show(session({ stream: stream() }));
            await mount(<CallTileStream userId={FRIEND_ID} />);
            fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
            await settle();
            assertAbsent(document.fullscreenElement);
            assert.ok(screen.getByRole("button", { name: "Tela cheia" }));
            assert.ok(loggerLines.some(l => l.level === "warn" && l.args[0] === "Tela cheia da tile falhou"));
        });

        test("outro elemento em tela cheia nao e a tile; o botao ainda sai dessa tela cheia", async () => {
            show(session({ stream: stream() }));
            await mount(<CallTileStream userId={FRIEND_ID} />);
            await act(async () => void await document.body.requestFullscreen());
            assert.ok(screen.getByRole("button", { name: "Tela cheia" }), "a tile nao se acha em tela cheia");
            fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
            await settle();
            assertAbsent(document.fullscreenElement);
        });
    });

    // #endregion

    // #region previa da propria transmissao

    describe("sua propria tile", () => {
        const local = (viewers: string[] = []) => ({ source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, viewers, access: "all" as const });
        const showLocal = (viewers: string[] = [], capture: MediaStream | null = stream()) => {
            rt.local = capture ? { stream: capture } as unknown as LocalCapture : null;
            act(() => setState({ ...EMPTY, local: local(viewers) }));
            return capture;
        };

        test("sem transmitir: a tile fica como o Discord desenhou", () => {
            show(null);
            const { container } = render(<CallTileStream userId={ME_ID} />);
            assert.equal(container.innerHTML, "");
        });

        test("transmitindo: previa muda da propria tela; o texto so aparece quando o mouse mexe", async () => {
            const capture = showLocal();
            const { container } = await mount(<CallTileStream userId={ME_ID} />);
            const v = video(container)!;
            assert.ok(v.srcObject === capture);
            assert.equal(v.muted, true, "a previa nunca toca som (daria eco)");
            assert.equal(v.volume, 0);
            assert.equal(screen.getByTitle("Sua transmissão · ninguém assistindo ainda").textContent, "TELINHA");
            assertAbsent(screen.queryByText(/Sua transmissão/));
            assertAbsent(screen.queryByRole("button"));

            fireEvent.mouseMove(tile(container));
            assert.ok(screen.getByText("Sua transmissão · ninguém assistindo ainda"));
            assert.equal(screen.getByRole("button", { name: "Ocultar a prévia" }).textContent, "Ocultar prévia");
            fireEvent.mouseLeave(tile(container));
            assertAbsent(screen.queryByRole("button"));
        });

        test("os controles somem sozinhos depois de 2,5 s parado", async t => {
            const clock = useFakeClock(t);
            showLocal();
            const { container } = await mount(<CallTileStream userId={ME_ID} />);
            fireEvent.mouseMove(tile(container));
            act(() => clock.tick(2499));
            assert.ok(screen.getByRole("button", { name: "Ocultar a prévia" }));
            act(() => clock.tick(1));
            assertAbsent(screen.queryByRole("button"));
        });

        test("acompanha quantas pessoas assistem", async () => {
            showLocal(["p1"]);
            const { container } = await mount(<CallTileStream userId={ME_ID} />);
            fireEvent.mouseMove(tile(container));
            assert.ok(screen.getByText("Sua transmissão · 1 pessoa assistindo"));
            showLocal(["p1", "p2", "p3"]);
            assert.ok(screen.getByText("Sua transmissão · 3 pessoas assistindo"));
        });

        test("ocultar a previa tira o video (o texto e o botao de mostrar ficam) e a escolha vale para as proximas tiles", async () => {
            showLocal();
            const first = await mount(<CallTileStream userId={ME_ID} />);
            fireEvent.mouseMove(tile(first.container));
            fireEvent.click(screen.getByRole("button", { name: "Ocultar a prévia" }));
            await settle();
            assert.equal(isLocalPreviewHidden(), true);
            assertAbsent(video(first.container));
            assert.equal(tile(first.container).style.pointerEvents, "none", "a tile do Discord volta a receber os cliques");
            fireEvent.mouseLeave(tile(first.container));
            assert.ok(screen.getByText("Sua transmissão · ninguém assistindo ainda"), "oculta: o texto fica sempre");
            assert.equal(screen.getByRole("button", { name: "Mostrar a prévia" }).textContent, "Mostrar prévia");
            first.unmount();

            const second = await mount(<CallTileStream userId={ME_ID} />);
            assertAbsent(video(second.container), "a outra tile tambem nasce oculta");

            fireEvent.click(screen.getByRole("button", { name: "Mostrar a prévia" }));
            await settle();
            assert.equal(isLocalPreviewHidden(), false);
            assert.ok(video(second.container));
        });

        test("tile estreita: so os icones", async () => {
            showLocal();
            const { container } = await mount(<CallTileStream userId={ME_ID} />);
            resize(tile(container), 250);
            fireEvent.mouseMove(tile(container));
            assertAbsent(screen.queryByText(/Sua transmissão/));
            assert.equal(screen.getByRole("button", { name: "Ocultar a prévia" }).textContent, "");
        });

        test("a captura ja acabou mas o estado ainda nao: sem imagem, sem erro", async () => {
            showLocal([], null);
            const { container } = await mount(<CallTileStream userId={ME_ID} />);
            assertAbsent(video(container));
            assert.ok(screen.getByTitle(/Sua transmissão/));
        });

        test("os botoes da previa nao chegam na tile do Discord", async () => {
            showLocal();
            let discordClicks = 0;
            const { container } = await mount(<div onClick={() => discordClicks++}><CallTileStream userId={ME_ID} /></div>);
            fireEvent.mouseMove(tile(tile(container)));
            fireEvent.click(screen.getByRole("button", { name: "Ocultar a prévia" }));
            assert.equal(discordClicks, 0);
        });
    });

    // #endregion

    test("se a tile quebrar, ela some sem derrubar a call do Discord", t => {
        t.mock.method(console, "error", () => { }); // o React conta o erro capturado
        t.mock.method(UserStore, "getCurrentUser", () => {
            throw new Error("store quebrado");
        });
        show(null);
        const { container } = render(<CallTileStream userId={FRIEND_ID} />);
        assert.equal(container.innerHTML, "");
        assert.equal(caughtErrors.length, 1);
        caughtErrors.length = 0;
        assert.equal(loggerLines.find(l => l.level === "error")?.args[0], "A tile da call do Telinha quebrou");
    });
});
