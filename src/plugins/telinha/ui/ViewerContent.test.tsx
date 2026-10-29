/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O player dentro da janela do visualizador (pop-out do Discord ou painel flutuante), ui/ViewerContent.tsx, renderizado
// de verdade com o estado do Telinha montado direto (setState): cada aviso, os controles que somem quando o mouse
// para, volume/mudo lembrados por amigo, autoplay recusado, tela cheia, a altura da janela e o ciclo de vida do
// <video>. Rodar:  pnpm test:file src/plugins/telinha/ui/ViewerContent.test.tsx

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState, ViewerSession } from "@plugins/telinha/types";
import { useFakeClock } from "@test/fakes/clock";
import { fullscreen, layout, media, resetMedia } from "@test/fakes/dom";
import { act, cleanup, fireEvent, render, screen, settle, within } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, loggerLines, makeUser, resetVencordFakes, UserStore } from "@test/fakes/vencord";
import { captureStream } from "@test/fakes/webrtc";
import { animations, assertAbsent, installAnimate } from "@test/helpers/wpe-dom";
import type { ReactNode } from "react";

import { ViewerContent, type ViewerMode } from "./ViewerContent";

const PEER = "peerA";
const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

// Cada teste usa um amigo (discordUserId) so seu: o volume lembrado e por usuario e vive ate o Discord fechar
let nextId = 700000000000000000n;
const freshId = () => String(nextId++);

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

const stream = (audio = false) => captureStream({ audio }) as unknown as MediaStream;

function show(sess: ViewerSession | null, peer: Partial<RemotePeer> | null = {}) {
    act(() => setState({ ...EMPTY, peers: peer ? [friend(peer)] : [], viewing: sess ? { [PEER]: sess } : {} }));
}

interface Spies {
    mounted: Document[];
    unmounted: number;
    closed: number;
}

function viewer(mode: ViewerMode = "popout") {
    const spies: Spies = { mounted: [], unmounted: 0, closed: 0 };
    const ui: ReactNode = <ViewerContent peerId={PEER} mode={mode} onMounted={doc => spies.mounted.push(doc)} onUnmounted={() => void spies.unmounted++} onClose={() => void spies.closed++} />;
    return { spies, ui };
}

async function mount(mode: ViewerMode = "popout") {
    const { spies, ui } = viewer(mode);
    const view = render(ui);
    await settle();
    return { ...view, spies, root: view.container.firstElementChild as HTMLElement };
}

const video = (container: HTMLElement) => container.querySelector("video") as HTMLVideoElement | null;
/** A barra de baixo (Parar de assistir, som, estatisticas, tela cheia) */
const bottomBar = () => screen.getByRole("button", { name: "Parar de assistir" }).parentElement as HTMLElement;
const warnings = () => loggerLines.filter(l => l.logger === "Telinha UI" && l.level === "warn").map(l => String(l.args[0]));

describe("ViewerContent", () => {
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

    // #region ciclo de vida

    describe("janela", () => {
        test("avisa o gerenciador de janelas quando o player entrou na tela (com o documento da janela) e quando saiu", async () => {
            show(session({ stream: stream() }));
            const { spies, unmount, container } = await mount();
            assert.deepEqual(spies.mounted, [container.ownerDocument]);
            assert.equal(spies.unmounted, 0);
            unmount();
            assert.equal(spies.unmounted, 1);
            assert.equal(spies.mounted.length, 1);
        });

        test("pop-out: o titulo da janela e \"nome — Telinha\" e acompanha o nome do amigo", async () => {
            show(session({ stream: stream() }));
            await mount();
            assert.equal(document.title, "amigo — Telinha");

            UserStore.addUsers(makeUser(FRIEND_ID, "amigo", { globalName: "Ana" }));
            show(session({ stream: stream() }));
            await settle();
            assert.equal(document.title, "Ana — Telinha");
        });

        test("painel flutuante: nao mexe no titulo do Discord", async () => {
            document.title = "Discord";
            show(session({ stream: stream() }));
            await mount("floating");
            assert.equal(document.title, "Discord");
        });

        test("amigo que ja saiu da call: o player segue, chamando-o de \"Alguem\"", async () => {
            show(session({ stream: stream() }), null);
            await mount();
            assert.equal(document.title, "Alguém — Telinha");
        });
    });

    describe("altura", () => {
        test("pop-out: ocupa o que sobra da janela, sem a barra de titulo do Discord (confere de novo depois de 400 ms)", async t => {
            const clock = useFakeClock(t);
            show(session({ stream: stream() }));
            const { root } = await mount();
            assert.equal(root.style.height, "1080px", "a janela de teste tem 1080 px de altura");

            layout.setSize(root, { width: 1280, height: 700, top: 32 }); // a barra de titulo do Discord aparece depois
            act(() => clock.tick(399));
            assert.equal(root.style.height, "1080px");
            act(() => clock.tick(1));
            assert.equal(root.style.height, "1048px");

            const win = window as unknown as { innerHeight: number; };
            const before = win.innerHeight;
            try {
                win.innerHeight = 600;
                act(() => void window.dispatchEvent(new Event("resize")));
                assert.equal(root.style.height, "568px", "redimensionar a janela refaz a conta");
                win.innerHeight = 100;
                act(() => void window.dispatchEvent(new Event("resize")));
                assert.equal(root.style.height, "160px", "nunca menos de 160 px");
            } finally {
                win.innerHeight = before;
            }
        });

        test("fechar o pop-out para de acompanhar o tamanho da janela", async t => {
            const clock = useFakeClock(t);
            show(session({ stream: stream() }));
            const { root, unmount } = await mount();
            unmount();
            layout.setSize(root, { width: 1280, height: 700, top: 100 });
            clock.tick(1000);
            window.dispatchEvent(new Event("resize"));
            assert.equal(root.style.height, "1080px", "ninguem mais mexe");
        });

        test("painel flutuante: a altura vem do painel (100%)", async () => {
            show(session({ stream: stream() }));
            const { root } = await mount("floating");
            assert.equal(root.style.height, "100%");
        });
    });

    // #endregion

    // #region avisos

    describe("avisos por cima da imagem", () => {
        const cases: { name: string; sess: ViewerSession | null; hadSession?: boolean; title: string; detail?: RegExp; buttons: string[]; }[] = [
            { name: "ainda sem sessao: conectando", sess: null, title: "Conectando…", buttons: [] },
            { name: "conectando", sess: session({ status: "connecting" }), title: "Conectando…", buttons: [] },
            { name: "esperando o transmissor aprovar", sess: session({ status: "connecting", awaitingApproval: true }), title: "Aguardando o transmissor aprovar…", detail: /Ele recebeu o seu pedido para assistir\./, buttons: [] },
            { name: "conferindo a senha", sess: session({ status: "connecting", checkingPassword: true }), title: "Conferindo a senha…", buttons: [] },
            { name: "pedindo a senha", sess: session({ status: "connecting", passwordPrompt: { attemptsLeft: 5, wrong: false } }), title: "Esta transmissão é com senha", detail: /Digite a senha que amigo passou/, buttons: ["Mostrar a senha", "Assistir", "Fechar"] },
            { name: "senha errada", sess: session({ status: "connecting", passwordPrompt: { attemptsLeft: 1, wrong: true } }), title: "Senha incorreta", detail: /Resta 1 tentativa\./, buttons: ["Mostrar a senha", "Assistir", "Fechar"] },
            { name: "esperando o primeiro quadro", sess: session({ status: "waiting-first-frame" }), title: "Aguardando a primeira imagem…", buttons: [] },
            { name: "tocando mas ainda sem imagem", sess: session({ status: "playing" }), title: "Aguardando a primeira imagem…", buttons: [] },
            { name: "a transmissao acabou", sess: session({ status: "ended" }), title: "A transmissão terminou", buttons: ["Fechar"] },
            { name: "o stream sumiu da sessao (o nucleo ja limpou)", sess: null, hadSession: true, title: "A transmissão terminou", buttons: ["Fechar"] },
            { name: "erro sem motivo", sess: session({ status: "error", error: "Falha ao pedir a transmissão: x" }), title: "Não foi possível assistir a esta transmissão", detail: /Falha ao pedir a transmissão: x/, buttons: ["Fechar"] },
            { name: "recusado", sess: session({ status: "error", denied: "declined", error: "O transmissor recusou o seu pedido para assistir." }), title: "O transmissor recusou sua visualização", detail: /recusou o seu pedido/, buttons: ["Fechar"] },
            { name: "so para amigos", sess: session({ status: "error", denied: "friendsOnly" }), title: "Esta transmissão é só para amigos de amigo", buttons: ["Fechar"] },
            { name: "precisa autorizar o Telinha", sess: session({ status: "error", denied: "notVerified" }), title: "Autorize o Telinha no Discord para assistir", buttons: ["Autorizar o Telinha", "Fechar"] }
        ];

        for (const c of cases) {
            test(c.name, async () => {
                if (c.hadSession) {
                    show(session({ status: "connecting" }));
                    const view = viewer();
                    const { rerender } = render(view.ui);
                    show(null);
                    rerender(view.ui);
                } else {
                    show(c.sess);
                    await mount();
                }
                await settle();
                const overlay = screen.getByText(c.title).parentElement as HTMLElement;
                if (c.detail) assert.match(overlay.textContent!, c.detail);
                const buttons = within(overlay).queryAllByRole("button").map(b => b.getAttribute("aria-label") ?? b.textContent);
                assert.deepEqual(buttons, c.buttons, c.name);
                assert.equal(bottomBar().style.opacity, "1", "com um aviso na tela os controles ficam visiveis");
            });
        }

        test("\"Fechar\" no aviso fecha o visualizador", async () => {
            show(session({ status: "ended" }));
            const { spies } = await mount();
            fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
            assert.equal(spies.closed, 1);
        });

        test("tocando de verdade: sem aviso nenhum por cima da imagem", async () => {
            show(session({ stream: stream() }));
            const { container } = await mount();
            assertAbsent(screen.queryByText(/Conectando|Aguardando|terminou|Não foi possível/));
            assert.ok(video(container));
        });

        test("um status que esta versao nao conhece (nucleo mais novo): nenhum aviso", async () => {
            show(session({ status: "novo" as ViewerSession["status"], stream: stream() }));
            await mount();
            assertAbsent(screen.queryByText(/Conectando|Aguardando|terminou|Não foi possível/));
        });
    });

    // #endregion

    // #region controles

    describe("controles", () => {
        test("aparecem ao abrir, somem depois de 2,5 s parado (e o cursor tambem) e voltam quando o mouse mexe", async t => {
            const clock = useFakeClock(t);
            show(session({ stream: stream() }));
            const { root } = await mount();
            assert.equal(bottomBar().style.opacity, "1");
            assert.equal(root.style.cursor, "default");

            act(() => clock.tick(2499));
            assert.equal(bottomBar().style.opacity, "1");
            act(() => clock.tick(1));
            assert.equal(bottomBar().style.opacity, "0");
            assert.equal(bottomBar().style.pointerEvents, "none");
            assert.equal(root.style.cursor, "none");

            fireEvent.mouseMove(root);
            assert.equal(bottomBar().style.opacity, "1");
            assert.equal(bottomBar().style.pointerEvents, "auto");
            act(() => clock.tick(2000));
            fireEvent.mouseMove(root); // ainda ativo: so reinicia a contagem
            act(() => clock.tick(2000));
            assert.equal(bottomBar().style.opacity, "1");
            act(() => clock.tick(500));
            assert.equal(bottomBar().style.opacity, "0");
        });

        test("o mouse sai da janela: os controles somem na hora", async () => {
            show(session({ stream: stream() }));
            const { root } = await mount();
            fireEvent.mouseLeave(root);
            assert.equal(bottomBar().style.opacity, "0");
        });

        test("fechar a janela cancela a contagem dos controles (nenhum timer sobra)", async t => {
            useFakeClock(t);
            show(session({ stream: stream() }));
            const { unmount } = await mount("floating"); // sem o ajuste de altura, que tem o seu proprio timer
            const clearTimeoutSpy = t.mock.method(globalThis, "clearTimeout");
            unmount();
            assert.ok(clearTimeoutSpy.mock.callCount() >= 1, "o timer de 2,5 s foi cancelado");
            clearTimeoutSpy.mock.restore();
        });

        test("\"Parar de assistir\" fecha o visualizador", async () => {
            show(session({ stream: stream() }));
            const { spies } = await mount();
            fireEvent.click(screen.getByRole("button", { name: "Parar de assistir" }));
            assert.equal(spies.closed, 1);
        });

        test("estatisticas: resolucao, fps e Mbps; sem bitrate, so os dois primeiros; sem medida ainda, nada", async () => {
            show(session({ stream: stream(), stats: { width: 1920, height: 1080, fps: 59.6, kbps: 4200 } }));
            await mount();
            assert.ok(within(bottomBar()).getByText("1920×1080 · 60 fps · 4.2 Mbps"));

            show(session({ stream: stream(), stats: { width: 1280, height: 720, fps: 30, kbps: 0 } }));
            await settle();
            assert.ok(within(bottomBar()).getByText("1280×720 · 30 fps"));

            show(session({ stream: stream(), stats: { width: 0, height: 0, fps: 0, kbps: 0 } }));
            await settle();
            assertAbsent(within(bottomBar()).queryByText(/fps/));
        });

        test("barra de cima com o nome: sempre no painel flutuante; no pop-out so em tela cheia (o Discord ja poe o titulo)", async () => {
            show(session({ stream: stream() }));
            const floating = await mount("floating");
            assert.ok(screen.getByText("amigo — Telinha"));
            floating.unmount();

            await mount("popout");
            assertAbsent(screen.queryByText("amigo — Telinha"));
            fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
            await settle();
            assert.ok(screen.getByText("amigo — Telinha"));
        });
    });

    // #endregion

    // #region imagem

    describe("imagem", () => {
        test("o <video> e criado pela janela, toca o stream e e solto quando o player fecha", async () => {
            const s = stream();
            show(session({ stream: s }));
            const { container, root, unmount } = await mount();
            const v = video(container)!;
            assert.ok(v.srcObject === s);
            assert.equal(v.autoplay, true);
            assert.ok(media.played.includes(v));
            assert.ok(v.parentElement === root.firstElementChild, "dentro da area da imagem");

            unmount();
            assert.equal(v.srcObject, null);
            assert.equal(v.isConnected, false);
        });

        test("um <video> que falha ao parar nao impede o player de fechar", async t => {
            show(session({ stream: stream() }));
            const { unmount, spies } = await mount();
            const pause = t.mock.method(HTMLMediaElement.prototype, "pause", () => {
                throw new Error("pause falhou");
            });
            assert.doesNotThrow(() => unmount());
            pause.mock.restore();
            assert.equal(spies.unmounted, 1);
        });

        test("stream novo troca o <video>; o fim da sessao tira a imagem", async () => {
            const first = stream();
            show(session({ stream: first }));
            const { container } = await mount();
            const v1 = video(container)!;

            const second = stream();
            show(session({ stream: second }));
            await settle();
            assert.equal(container.querySelectorAll("video").length, 1);
            assert.ok(video(container) !== v1);
            assert.ok(video(container)!.srcObject === second);
            assert.equal(v1.srcObject, null);

            show(session({ status: "ended" }));
            await settle();
            assertAbsent(video(container));
        });
    });

    // #endregion

    // #region som

    describe("som", () => {
        test("sem audio na transmissao: nenhum controle de som", async () => {
            show(session({ stream: stream(false) }));
            await mount();
            assertAbsent(screen.queryByLabelText("Volume"));
            assertAbsent(screen.queryByRole("button", { name: /Silenciar|Ativar som/ }));
        });

        test("o anuncio do transmissor basta para mostrar o som, mesmo antes da trilha de audio", async () => {
            show(session({ status: "connecting" }), { stream: { ...friend().stream!, hasAudio: true } });
            await mount();
            assert.ok(screen.getByRole("button", { name: "Silenciar" }));
        });

        test("volume e silenciar mexem no video e ficam lembrados para esse amigo ao reabrir a janela", async () => {
            const id = freshId();
            show(session({ stream: stream(true) }), { discordUserId: id });
            const first = await mount();
            const v = video(first.container)!;
            assert.equal(v.volume, 1);
            assert.equal(v.muted, false);
            const slider = () => screen.getByLabelText("Volume") as HTMLInputElement;
            assert.equal(slider().value, "100");
            assert.equal(slider().title, "Volume: 100%");

            fireEvent.change(slider(), { target: { value: "35" } });
            assert.equal(v.volume, 0.35);
            assert.equal(slider().title, "Volume: 35%");

            fireEvent.click(screen.getByRole("button", { name: "Silenciar" }));
            assert.equal(v.muted, true);
            assert.equal(slider().value, "0");
            assert.equal(slider().title, "Volume: 0%");

            fireEvent.click(screen.getByRole("button", { name: "Ativar som" }));
            assert.equal(v.muted, false);
            assert.equal(slider().value, "35");

            fireEvent.change(slider(), { target: { value: "0" } });
            assert.equal(screen.getByRole("button", { name: "Ativar som" }).getAttribute("title"), "Ativar som", "volume zero equivale a mudo");
            first.unmount();

            show(session({ stream: stream(true) }), { discordUserId: id });
            const again = await mount();
            assert.equal(video(again.container)!.volume, 0);
            assert.equal(video(again.container)!.muted, true);
            again.unmount();

            // outro amigo nao herda
            show(session({ stream: stream(true) }), { discordUserId: freshId() });
            const other = await mount();
            assert.equal(video(other.container)!.volume, 1);
            assert.equal(video(other.container)!.muted, false);
        });

        test("o navegador recusa tocar com som: toca mudo e oferece \"Ativar som\"; o clique liga o som para sempre", async () => {
            media.playImpl = async el => {
                if (!el.muted) throw new DOMException("autoplay com som", "NotAllowedError");
            };
            show(session({ stream: stream(true) }), { discordUserId: freshId() });
            const { container } = await mount();
            const v = video(container)!;
            const enable = screen.getByRole("button", { name: /Ativar som/ });
            assert.equal(enable.textContent, "Ativar som");
            assert.equal(v.muted, true);
            assertAbsent(screen.queryByLabelText("Volume"));

            media.playImpl = null;
            fireEvent.click(enable);
            await settle();
            assert.equal(v.muted, false);
            assert.equal((screen.getByLabelText("Volume") as HTMLInputElement).value, "100");
            assert.deepEqual(warnings(), []);
        });

        test("recusa tocar ate mudo, e o clique tambem falha: tudo no log", async () => {
            media.playImpl = async () => {
                throw new DOMException("bloqueado", "NotAllowedError");
            };
            show(session({ stream: stream(true) }), { discordUserId: freshId() });
            await mount();
            assert.ok(warnings().includes("play() mudo também falhou"));
            fireEvent.click(screen.getByRole("button", { name: /Ativar som/ }));
            await settle();
            assert.ok(warnings().includes("play() com som falhou"));
        });

        test("play() falha por outro motivo: vai para o log e nao oferece ligar o som", async () => {
            media.playImpl = async () => {
                throw new Error("decodificador travou");
            };
            show(session({ stream: stream(true) }), { discordUserId: freshId() });
            await mount();
            assert.ok(warnings().includes("play() do player falhou"));
            assertAbsent(screen.queryByText("Ativar som"));
            assert.ok(screen.getByLabelText("Volume"));
        });
    });

    // #endregion

    // #region tela cheia

    describe("tela cheia", () => {
        test("o botao entra e sai; clicar duas vezes na imagem tambem; o botao acompanha o estado", async () => {
            show(session({ stream: stream() }));
            const { root } = await mount();
            const imageArea = root.firstElementChild as HTMLElement;
            fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
            await settle();
            assert.ok(document.fullscreenElement === root);
            assert.ok(screen.getByRole("button", { name: "Sair da tela cheia" }));

            fireEvent.doubleClick(imageArea);
            await settle();
            assertAbsent(document.fullscreenElement);
            assert.ok(screen.getByRole("button", { name: "Tela cheia" }));

            fireEvent.doubleClick(imageArea);
            await settle();
            assert.ok(document.fullscreenElement === root);
            fireEvent.click(screen.getByRole("button", { name: "Sair da tela cheia" }));
            await settle();
            assertAbsent(document.fullscreenElement);
        });

        test("outro elemento em tela cheia nao e o player", async () => {
            show(session({ stream: stream() }));
            await mount();
            await act(async () => void await document.body.requestFullscreen());
            assert.ok(screen.getByRole("button", { name: "Tela cheia" }));
        });

        test("o navegador recusa a tela cheia: log, e o player segue normal", async () => {
            fullscreen.refuse = true;
            show(session({ stream: stream() }));
            await mount();
            fireEvent.click(screen.getByRole("button", { name: "Tela cheia" }));
            await settle();
            assertAbsent(document.fullscreenElement);
            assert.ok(warnings().includes("Tela cheia falhou"));
        });
    });

    // #endregion
});
