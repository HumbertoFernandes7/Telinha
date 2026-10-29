/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da barra do Telinha no painel de voz (ui/VoiceBar.tsx), renderizada de verdade: quando aparece (so na call
// ou transmitindo), cada estado (parado, ao vivo, quem pode assistir, pedido esperando, alerta de identidade, qualidade
// automatica, aviso de captura, alguem transmitindo, erro) e o que cada botao faz. Primeiro so com o estado do Telinha
// (setState), depois com o nucleo de verdade por tras dos botoes (Permitir, Recusar, Parar, Dispensar aviso).
// Rodar:  pnpm test:file src/plugins/telinha/ui/VoiceBar.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { setStreamAccess, unlinkTelinhaIdentity } from "@plugins/telinha/actions";
import { setLastError } from "@plugins/telinha/core/context";
import { getState, resetState, setState } from "@plugins/telinha/store";
import type { AccessMode, IdentityAlert, LocalStream, PendingViewer, QualityReason, RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { flushPromises } from "@test/fakes/clock";
import { act, fireEvent, render, screen, settle, within } from "@test/fakes/render";
import {
    caughtErrors, clipboard, FRIEND_ID, makeUser, ME_ID, ModalHost, modals, OTHER_ID, PopoutActions, resetVencordFakes, SelectedChannelStore, toasts,
    UserStore, VOICE_CHANNEL_ID
} from "@test/fakes/vencord";
import { type LiveScene, openLiveScene } from "@test/helpers/wpf-live";
import { until } from "@test/helpers/wpf-modal";

import { closeAllViewers, isViewerOpen } from "./viewerWindows";
import { VoiceBar } from "./VoiceBar";

const EMPTY: TelinhaState = { inRoom: true, channelId: VOICE_CHANNEL_ID, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

function mine(patch: Partial<LocalStream> = {}): LocalStream {
    return { source: { id: "screen:0:0", name: "Tela inteira", kind: "screen" }, quality: "1080p60", hasAudio: false, startedAt: 0, viewers: [], access: "all", ...patch };
}

function friend(patch: Partial<RemotePeer> = {}): RemotePeer {
    return {
        peerId: "peerA", discordUserId: FRIEND_ID, username: "ana_dev", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" },
        ...patch
    };
}

function request(patch: Partial<PendingViewer> = {}): PendingViewer {
    return { peerId: "peerA", discordUserId: FRIEND_ID, username: "ana_dev", expiresAt: Date.now() + 60_000, identity: "verified", ...patch };
}

const show = (state: Partial<TelinhaState>) => act(() => setState({ ...EMPTY, ...state }));
const inVoice = (yes = true) => act(() => SelectedChannelStore.setVoiceChannel(yes ? VOICE_CHANNEL_ID : null));
const bar = () => document.querySelector(".vc-telinha-bar") as HTMLElement | null;
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const texts = () => [...(bar()?.querySelectorAll(".vc-telinha-bar-row-text") ?? [])].map(e => e.textContent);
const dialogTitle = () => document.querySelector("[role=dialog] h1")?.textContent;
/** the status row (the live one): the tooltip wrapper around the "Ao vivo" button */
const statusRow = () => document.querySelector(".vc-telinha-bar-status") as HTMLButtonElement;
const tooltipOf = (el: Element) => el.closest("[data-tooltip]")?.getAttribute("data-tooltip");

function renderBar() {
    return render(<><VoiceBar /><ModalHost /></>);
}

describe("VoiceBar (so com o estado do Telinha)", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
        UserStore.addUsers(makeUser(FRIEND_ID, "ana_dev", { globalName: "Ana" }), makeUser(OTHER_ID, "beto"));
    });

    afterEach(async () => {
        await settle();
        await act(async () => closeAllViewers());
        await settle(); // o unwatch publica o estado num microtask
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    describe("quando aparece", () => {
        test("fora de um canal de voz e sem transmitir: nada na tela", () => {
            const { container } = render(<VoiceBar />);
            assert.equal(container.innerHTML, "");
        });

        test("entrar e sair da call mostra e esconde a barra", () => {
            const { container } = render(<VoiceBar />);
            inVoice();
            assert.ok(bar(), "na call: a barra aparece");
            inVoice(false);
            assert.equal(container.innerHTML, "", "saiu da call");
        });

        test("um estado quebrado nao derruba o Discord: a barra some e o erro fica registrado", t => {
            t.mock.method(console, "error", () => { }); // o React conta o erro do desenho no console
            inVoice();
            const { container } = render(<VoiceBar />);
            assert.ok(bar());
            act(() => setState({ ...EMPTY, peers: null as never }));
            assert.equal(container.innerHTML, "", "a barra some em silencio");
            assert.equal(caughtErrors.length, 1);
            caughtErrors.length = 0;
        });

        test("transmitindo, a barra fica mesmo sem canal de voz (para dar para parar)", () => {
            show({ local: mine() });
            render(<VoiceBar />);
            assert.ok(bar());
            button("Parar transmissão");
        });
    });

    describe("parado, na call", () => {
        test("so o botao Transmitir com Telinha, que abre o seletor de fonte", async () => {
            inVoice();
            show({});
            renderBar();
            assert.deepEqual([...bar()!.querySelectorAll("button")].map(b => b.textContent), ["Transmitir com Telinha"]);
            assert.equal(texts().length, 0);

            fireEvent.click(button("Transmitir com Telinha"));
            await settle();
            assert.equal(modals.list().length, 1);
            assert.equal(dialogTitle(), "Transmitir com Telinha");
        });
    });

    describe("ao vivo", () => {
        test("ninguem assistindo: contagem 0, dica no tooltip e o botao Parar transmissao", () => {
            show({ local: mine() });
            renderBar();
            assert.equal(statusRow().querySelector(".vc-telinha-bar-row-text")?.textContent, "Ao vivo · ninguém assistindo ainda");
            assert.equal(statusRow().querySelector(".vc-telinha-bar-row-count")?.textContent, "0");
            assert.equal(tooltipOf(statusRow()), "Ninguém abriu a sua transmissão ainda");
            assert.equal(screen.queryByRole("button", { name: "Transmitir com Telinha" }), null);
            button("Parar transmissão");
        });

        test("com espectadores: quantos, e os nomes no tooltip (quem saiu da sala vira Alguem)", () => {
            show({
                local: mine({ viewers: ["peerA", "peerB", "peerGone"] }),
                peers: [friend({ streaming: false }), friend({ peerId: "peerB", discordUserId: OTHER_ID, username: "beto", streaming: false })]
            });
            renderBar();
            assert.equal(statusRow().querySelector(".vc-telinha-bar-row-text")?.textContent, "Ao vivo · 3 pessoas assistindo");
            assert.equal(statusRow().querySelector(".vc-telinha-bar-row-count")?.textContent, "3");
            assert.equal(tooltipOf(statusRow()), "Assistindo: Ana, beto, Alguém");
        });

        test("1 pessoa assistindo (singular)", () => {
            show({ local: mine({ viewers: ["peerA"] }), peers: [friend({ streaming: false })] });
            renderBar();
            assert.equal(statusRow().querySelector(".vc-telinha-bar-row-text")?.textContent, "Ao vivo · 1 pessoa assistindo");
        });

        test("clicar em Ao vivo abre a lista de quem assiste", async () => {
            show({ local: mine() });
            renderBar();
            fireEvent.click(statusRow());
            await settle();
            assert.equal(dialogTitle(), "Quem está assistindo");
        });

        test("Parar transmissao pede ao nucleo para parar (sem transmissao de verdade por tras, nada quebra)", () => {
            show({ local: mine() });
            renderBar();
            fireEvent.click(button("Parar transmissão"));
            assert.deepEqual(toasts, []);
        });
    });

    describe("Quem assiste: o modo da transmissao no ar", () => {
        const modes: [AccessMode, string, string][] = [
            ["all", "todos da call", "Todos da call"],
            ["friends", "👥 só amigos", "Só meus amigos do Discord"],
            ["approval", "✋ com aprovação", "Só quem eu aprovar"],
            ["password", "🔒 com senha", "Com senha"]
        ];

        for (const [access, short, full] of modes) {
            test(`${access}: ${short}, com o modo por extenso no tooltip`, () => {
                show({ local: mine({ access }) });
                renderBar();
                const row = document.querySelector(".vc-telinha-bar-access-row") as HTMLButtonElement;
                assert.equal(row.querySelector("strong")?.textContent, short);
                assert.equal(row.textContent, `Quem assiste: ${short}Mudar`);
                assert.equal(row.title, `Quem pode assistir: ${full}. Clique para mudar (vale para os próximos pedidos; quem já assiste continua).`);
                assert.equal(screen.queryByRole("button", { name: "Copiar senha" }) !== null, access === "password", "Copiar senha so no modo Com senha");
            });
        }

        test("Mudar abre o modal de Quem pode assistir", async () => {
            show({ local: mine() });
            renderBar();
            fireEvent.click(document.querySelector(".vc-telinha-bar-access-row")!);
            await settle();
            assert.equal(dialogTitle(), "Quem pode assistir");
        });

        test("Copiar senha: sem senha guardada no nucleo nao copia nada", async () => {
            show({ local: mine({ access: "password" }) });
            renderBar();
            fireEvent.click(button("Copiar senha"));
            await flushPromises();
            assert.deepEqual(clipboard, []);
            assert.deepEqual(toasts, []);
        });
    });

    describe("pedidos esperando Permitir ou Recusar", () => {
        test("quem pede, com o selo curto, e os botoes Permitir e Recusar", () => {
            show({ local: mine({ pendingViewers: [request({ identity: "unverified" }), request({ peerId: "peerB", discordUserId: OTHER_ID, username: "beto", identity: "verified" })] }) });
            renderBar();

            const [first, second] = screen.getAllByRole("alert");
            assert.equal(first.querySelector(".vc-telinha-bar-row-text")?.textContent, "Ana quer assistir");
            assert.equal(first.querySelector(".vc-telinha-id-badge")?.textContent, "não verificado");
            assert.equal(first.getAttribute("title"), "Ana quer assistir sua transmissão (recusado sozinho em 60 s). Não verificado: não provou ser essa conta do Discord.");
            assert.equal(second.querySelector(".vc-telinha-id-badge")?.textContent, "✔", "verificado, no formato curto");
            assert.equal(second.getAttribute("title"), "beto quer assistir sua transmissão (recusado sozinho em 60 s).");
            assert.deepEqual([...first.querySelectorAll("button")].map(b => b.textContent), ["Permitir", "Recusar"]);
        });

        test("Permitir e Recusar de um pedido que ja expirou: avisa", () => {
            show({ local: mine({ pendingViewers: [request()] }) });
            renderBar();
            const alert = screen.getByRole("alert");
            fireEvent.click(within(alert).getByRole("button", { name: "Permitir" }));
            fireEvent.click(within(alert).getByRole("button", { name: "Recusar" }));
            assert.deepEqual(toasts, [
                { text: "Telinha: o pedido de Ana já expirou", variant: "default" },
                { text: "Telinha: o pedido de Ana já expirou", variant: "default" }
            ]);
        });

        test("sem identidade (recurso desligado): o pedido nao leva selo", () => {
            show({ local: mine({ pendingViewers: [request({ identity: undefined })] }) });
            renderBar();
            assert.equal(screen.getByRole("alert").querySelector(".vc-telinha-id-badge"), null);
        });
    });

    describe("alertas de identidade", () => {
        const dup: IdentityAlert = { discordUserId: FRIEND_ID, username: "ana_dev", peerIds: ["p1", "p2"], self: false };
        const self: IdentityAlert = { discordUserId: ME_ID, username: "eu", peerIds: ["p3"], self: true };
        const impostor: IdentityAlert = { discordUserId: FRIEND_ID, username: "ana_dev", peerIds: ["p4"], self: false, kind: "impostor" };
        const fake: IdentityAlert = { discordUserId: OTHER_ID, username: "beto", peerIds: ["p5"], self: false, kind: "fake" };

        test("transmitindo: o alerta de conflito avisa que nenhuma das duas recebe a transmissao", () => {
            show({ local: mine(), identityAlerts: [dup, self, impostor, fake] });
            renderBar();
            const alerts = screen.getAllByRole("alert");
            assert.deepEqual(alerts.map(a => a.textContent), [
                "Duas conexões dizem ser Ana — uma pode ser falsa. Nenhuma recebe sua transmissão.",
                "Uma conexão na call diz ser você — alguém pode estar se passando por você",
                "Uma conexão não verificada diz ser Ana, que já provou a identidade — só ela fica bloqueada",
                "Uma conexão apresentou uma prova de identidade falsa de beto — ignorada"
            ]);
            assert.equal(alerts[0].getAttribute("title"), alerts[0].textContent);
        });

        test("so olhando (sem transmitir): o mesmo alerta sem a frase da transmissao", () => {
            inVoice();
            show({ identityAlerts: [dup] });
            renderBar();
            assert.equal(screen.getByRole("alert").textContent, "Duas conexões dizem ser Ana — uma pode ser falsa");
        });

        test("clicar: transmitindo abre a lista de quem assiste; senao, a de quem transmite", async () => {
            show({ local: mine(), identityAlerts: [dup] });
            const first = renderBar();
            fireEvent.click(screen.getByRole("alert"));
            await settle();
            assert.equal(dialogTitle(), "Quem está assistindo");
            first.unmount();

            act(() => modals.reset());
            inVoice();
            show({ local: null, identityAlerts: [dup] });
            renderBar();
            fireEvent.click(screen.getByRole("alert"));
            await settle();
            assert.equal(dialogTitle(), "Quem está transmitindo");
        });
    });

    describe("qualidade automatica", () => {
        const auto = (patch: Partial<NonNullable<LocalStream["autoQuality"]>> = {}) => ({ current: "1080p60" as const, reason: null, reasonText: null, viewers: {}, ...patch });

        test("no maximo escolhido: so o nivel atual, com a explicacao padrao no tooltip", () => {
            show({ local: mine({ autoQuality: auto() }) });
            renderBar();
            const info = document.querySelector(".vc-telinha-bar-info") as HTMLElement;
            assert.equal(info.textContent, "1080p60");
            assert.equal(info.title, "Qualidade automática: no máximo escolhido");
            assert.ok(!info.className.includes("bar-info-lowered"));
        });

        const reasons: [QualityReason, string][] = [["cpu", "processador"], ["upload", "seu upload"], ["bandwidth", "conexão de quem assiste"]];
        for (const [reason, text] of reasons) {
            test(`reduzida por ${reason}: mostra o motivo curto e a frase completa no tooltip`, () => {
                show({ local: mine({ autoQuality: auto({ current: "720p30", reason, reasonText: `720p 30 fps — motivo ${reason}` }) }) });
                renderBar();
                const info = document.querySelector(".vc-telinha-bar-info") as HTMLElement;
                assert.equal(info.textContent, `720p30 · menor: ${text}`);
                assert.equal(info.title, `720p 30 fps — motivo ${reason}`);
                assert.ok(info.className.includes("vc-telinha-bar-info-lowered"));
            });
        }

        test("desligada (sem autoQuality): sem a linha", () => {
            show({ local: mine({ autoQuality: null }) });
            renderBar();
            assert.equal(document.querySelector(".vc-telinha-bar-info"), null);
        });
    });

    describe("aviso de captura", () => {
        test("imagem preta ou janela congelada: o aviso aparece como status enquanto durar", () => {
            show({ local: mine({ captureWarning: "A imagem está preta há 5 s" }) });
            renderBar();
            const warning = screen.getByRole("status");
            assert.equal(warning.textContent, "A imagem está preta há 5 s");
            assert.equal(warning.getAttribute("title"), "A imagem está preta há 5 s");
        });

        test("sem aviso, sem linha", () => {
            show({ local: mine({ captureWarning: null }) });
            renderBar();
            assert.equal(screen.queryByRole("status"), null);
        });
    });

    describe("alguem transmitindo na call", () => {
        beforeEach(() => inVoice());

        test("uma transmissao: quem e, com Assistir; o modo de acesso vai no tooltip", () => {
            show({ peers: [friend({ stream: { ...friend().stream!, access: "password" } })] });
            renderBar();
            const row = screen.getByTitle("Assistir pelo Telinha (🔒 com senha)") as HTMLButtonElement;
            assert.equal(row.querySelector(".vc-telinha-bar-row-text")?.textContent, "Ana está transmitindo");
            assert.equal(row.querySelector(".vc-telinha-bar-row-action")?.textContent, "Assistir");
        });

        test("sem modo de acesso: o tooltip e curto", () => {
            show({ peers: [friend()] });
            renderBar();
            screen.getByTitle("Assistir pelo Telinha");
        });

        test("clicar abre o visualizador dessa pessoa; quem ja esta assistindo mostra Abrir", async () => {
            show({ peers: [friend()] });
            renderBar();
            fireEvent.click(screen.getByTitle("Assistir pelo Telinha"));
            await settle();
            assert.equal(isViewerOpen("peerA"), true);
            assert.match(PopoutActions.opened[0].key, new RegExp(FRIEND_ID));

            show({ peers: [friend()], viewing: { peerA: { peerId: "peerA", stream: null, status: "playing" } } });
            assert.equal(screen.getByTitle("Assistir pelo Telinha").querySelector(".vc-telinha-bar-row-action")?.textContent, "Abrir");
        });

        test("varias transmissoes: a contagem, os nomes com a etiqueta no tooltip e Ver, que abre a lista", async () => {
            show({
                peers: [
                    friend({ stream: { ...friend().stream!, access: "approval" } }),
                    friend({ peerId: "peerB", discordUserId: OTHER_ID, username: "beto" })
                ]
            });
            renderBar();
            const row = screen.getByTitle("Ana (✋ com aprovação), beto") as HTMLButtonElement;
            assert.equal(row.querySelector(".vc-telinha-bar-row-text")?.textContent, "2 transmissões ao vivo");
            assert.equal(row.querySelector(".vc-telinha-bar-row-action")?.textContent, "Ver");

            fireEvent.click(row);
            await settle();
            assert.equal(dialogTitle(), "Quem está transmitindo");
        });

        test("quem esta na call mas nao transmite nao ganha linha", () => {
            show({ peers: [friend({ streaming: false, stream: undefined })] });
            renderBar();
            assert.equal(document.querySelector(".vc-telinha-bar-row-icon"), null);
            assert.deepEqual(texts(), []);
        });
    });

    describe("ultimo erro", () => {
        test("mostra o texto, com o tooltip, e o botao de dispensar", () => {
            inVoice();
            show({ lastError: "A captura foi recusada." });
            renderBar();
            const row = screen.getByTitle("A captura foi recusada.");
            assert.equal(row.querySelector(".vc-telinha-bar-row-text")?.textContent, "A captura foi recusada.");
            assert.equal(within(row).getByRole("button", { name: "Dispensar aviso" }).getAttribute("title"), "Dispensar aviso");
        });

        test("Dispensar pede ao nucleo para limpar o erro, sem nenhum aviso", async () => {
            inVoice();
            show({ lastError: "erro antigo" });
            renderBar();
            fireEvent.click(button("Dispensar aviso"));
            await settle(); // o nucleo publica o estado num microtask
            assert.deepEqual(toasts, []);
        });
    });

    test("tudo ao mesmo tempo, na ordem da barra", () => {
        const alert: IdentityAlert = { discordUserId: FRIEND_ID, username: "ana_dev", peerIds: ["p1", "p2"], self: false };
        show({
            local: mine({
                viewers: ["peerA"], access: "approval", captureWarning: "congelada",
                pendingViewers: [request({ peerId: "peerB", discordUserId: OTHER_ID, username: "beto" })],
                autoQuality: { current: "720p60", reason: "cpu", reasonText: "x", viewers: {} }
            }),
            peers: [friend({ streaming: false }), friend({ peerId: "peerC", discordUserId: "400000000000000009", username: "carla" })],
            identityAlerts: [alert],
            lastError: "falhou"
        });
        renderBar();
        assert.deepEqual(texts(), [
            "Ao vivo · 1 pessoa assistindo",
            "Quem assiste: ✋ com aprovação",
            "beto quer assistir",
            "Duas conexões dizem ser Ana — uma pode ser falsa. Nenhuma recebe sua transmissão.",
            "720p60 · menor: processador",
            "congelada",
            "carla está transmitindo",
            "falhou"
        ]);
        assert.deepEqual([...bar()!.children].map(c => c.className.split(" ")[0]).slice(-2), ["vc-telinha-bar-row", "vc-telinha-bar-error"], "a barra termina com a transmissao dos outros e o erro");
    });

    describe("o aviso para autorizar no Discord", () => {
        test("quem nunca autorizou ve o aviso dentro da barra (o resto do aviso esta em IdentityUI.test.tsx)", async () => {
            inVoice();
            await unlinkTelinhaIdentity(); // estado "nao autorizado"
            show({});
            renderBar();
            screen.getByText("Autorize o Telinha no Discord para provar que é você");
        });
    });
});

// Uma unica sessao ao vivo: os testes deste bloco seguem a historia em ordem (transmite, aprova, copia a senha, para).
describe("VoiceBar com o nucleo de verdade", () => {
    let scene: LiveScene;

    before(async () => {
        scene = await openLiveScene();
        UserStore.addUsers(makeUser(FRIEND_ID, "ana_dev", { globalName: "Ana" }), makeUser(OTHER_ID, "beto"));
        await scene.connect("peerA", FRIEND_ID, "ana_dev");
        await scene.connect("peerB", OTHER_ID, "beto");
    });

    after(() => scene.close());

    beforeEach(() => scene.resetUi());

    afterEach(async () => {
        await settle();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    test("parada na call: Transmitir com Telinha; ao transmitir a barra vira Ao vivo e Parar transmissao", async () => {
        renderBar();
        button("Transmitir com Telinha");
        await act(async () => scene.goLive({ access: "approval" }));
        await settle();
        button("Parar transmissão");
        assert.equal(statusRow().querySelector(".vc-telinha-bar-row-text")?.textContent, "Ao vivo · ninguém assistindo ainda");
    });

    test("Permitir na barra: o pedido vira espectador e a contagem sobe; Recusar avisa e remove o pedido", async () => {
        renderBar();
        scene.askToWatch("peerA");
        scene.askToWatch("peerB");
        await act(async () => void await until(() => getState().local?.pendingViewers?.length === 2));
        await settle();
        assert.deepEqual(screen.getAllByRole("alert").map(a => a.querySelector(".vc-telinha-bar-row-text")?.textContent), ["Ana quer assistir", "beto quer assistir"]);

        fireEvent.click(within(screen.getAllByRole("alert")[0]).getByRole("button", { name: "Permitir" }));
        await act(async () => void await until(() => getState().local?.viewers.includes("peerA")));
        await settle();
        assert.equal(statusRow().querySelector(".vc-telinha-bar-row-text")?.textContent, "Ao vivo · 1 pessoa assistindo");
        assert.equal(tooltipOf(statusRow()), "Assistindo: Ana");

        fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Recusar" }));
        await settle();
        assert.deepEqual(toasts, [{ text: "beto não vai assistir esta transmissão", variant: "success" }]);
        assert.equal(screen.queryByRole("alert"), null, "nenhum pedido sobrou");
    });

    test("Copiar senha da barra copia a senha da transmissao", async () => {
        act(() => setStreamAccess("password", "pipoca-42"));
        await settle();
        renderBar();
        fireEvent.click(button("Copiar senha"));
        await flushPromises();
        assert.deepEqual(clipboard, ["pipoca-42"]);
        assert.deepEqual(toasts, [{ text: "Senha copiada", variant: "success" }]);
    });

    test("erro do nucleo aparece na barra e Dispensar o limpa de verdade", async () => {
        renderBar();
        act(() => setLastError("A captura foi recusada."));
        await settle();
        const row = screen.getByTitle("A captura foi recusada.");
        fireEvent.click(within(row).getByRole("button", { name: "Dispensar aviso" }));
        await settle();
        assert.equal(screen.queryByTitle("A captura foi recusada."), null);
        assert.equal(getState().lastError, null);
    });

    test("Parar transmissao encerra a transmissao de verdade e a barra volta ao inicio", async () => {
        renderBar();
        fireEvent.click(button("Parar transmissão"));
        await act(async () => void await until(() => getState().local === null));
        await settle();
        button("Transmitir com Telinha");
        assert.equal(statusRow(), null);
        assert.deepEqual(toasts, []);
    });
});
