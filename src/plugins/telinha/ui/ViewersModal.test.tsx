/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do modal "Quem está assistindo" (ui/ViewersModal.tsx), aberto de verdade pelo openViewersModal(): quem esta
// assistindo (com o tipo de conexao), pedidos esperando Permitir/Recusar (com a contagem regressiva), conexoes
// suspeitas, alertas de identidade e quem foi removido (Liberar). Primeiro so com o estado do Telinha (setState e o
// relogio falso), depois com o nucleo de verdade: aprovar, recusar, expulsar e liberar mudam a transmissao de fato.
// Rodar:  pnpm test:file src/plugins/telinha/ui/ViewersModal.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getState, resetState, setState } from "@plugins/telinha/store";
import type { BlockedViewer, IdentityAlert, LocalStream, PendingViewer, RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { useFakeClock } from "@test/fakes/clock";
import { act, fireEvent, screen, settle, within } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, makeUser, modals, OTHER_ID, resetVencordFakes, toasts, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { type LiveScene, openLiveScene } from "@test/helpers/wpf-live";
import { openInHost, until } from "@test/helpers/wpf-modal";

import { approveWithToast, declineWithToast, kickWithToast, openViewersModal } from "./ViewersModal";

const EMPTY: TelinhaState = { inRoom: true, channelId: VOICE_CHANNEL_ID, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

function peer(patch: Partial<RemotePeer> = {}): RemotePeer {
    return { peerId: "peerA", discordUserId: FRIEND_ID, username: "ana_dev", streaming: false, admitted: true, inVoice: true, identity: "verified", ...patch };
}

function mine(patch: Partial<LocalStream> = {}): LocalStream {
    return { source: { id: "screen:0:0", name: "Tela inteira", kind: "screen" }, quality: "1080p60", hasAudio: false, startedAt: 0, viewers: [], access: "all", ...patch };
}

function pending(patch: Partial<PendingViewer> = {}): PendingViewer {
    return { peerId: "peerA", discordUserId: FRIEND_ID, username: "ana_dev", expiresAt: Date.now() + 60_000, identity: "verified", ...patch };
}

const show = (state: Partial<TelinhaState>) => act(() => setState({ ...EMPTY, ...state }));
const sections = () => [...document.querySelectorAll(".vc-telinha-viewers-section")] as HTMLElement[];
const sectionTitle = (s: HTMLElement) => s.querySelector(".vc-telinha-viewers-section-title")?.textContent;
const section = (title: string | RegExp) => sections().find(s => (typeof title === "string" ? sectionTitle(s) === title : title.test(sectionTitle(s) ?? "")))!;
const rowsIn = (root: ParentNode) => [...root.querySelectorAll(".vc-telinha-streamer")] as HTMLElement[];
const nameOf = (row: HTMLElement) => row.querySelector(".vc-telinha-streamer-name")?.textContent;
const metaOf = (row: HTMLElement) => row.querySelector(".vc-telinha-streamer-meta")?.textContent;
const warningOf = (row: HTMLElement) => row.querySelector(".vc-telinha-viewer-warning")?.textContent?.trim();
const alerts = () => [...document.querySelectorAll(".vc-telinha-viewer-alert")] as HTMLElement[];

/** Abre o modal e deixa terminar a primeira leitura do tipo de conexao (e o que mais o abrir dispare) dentro do act. */
async function openViewers() {
    const modal = openInHost(openViewersModal);
    await settle();
    return modal;
}

describe("ViewersModal (so com o estado do Telinha)", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
        UserStore.addUsers(makeUser(FRIEND_ID, "ana_dev", { globalName: "Ana" }), makeUser(OTHER_ID, "beto"));
    });

    afterEach(async () => {
        await settle(); // a primeira leitura do tipo de conexao termina depois do teste: dentro do act
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    describe("sem transmissao", () => {
        test("diz que voce nao esta transmitindo e so oferece Fechar", async () => {
            show({});
            const modal = await openViewers();
            assert.equal(modal.title(), "Quem está assistindo");
            assert.match(modal.text(), /Você não está transmitindo pelo Telinha agora\./);
            assert.equal(modal.maybeButton("Trocar tela ou janela"), null);
            assert.deepEqual(sections(), []);
            modal.click("Fechar");
            assert.equal(modals.list().length, 0);
        });
    });

    describe("assistindo agora", () => {
        test("ninguem assiste ainda: a explicacao do Expulsar e uma linha vazia", async () => {
            show({ local: mine() });
            const modal = await openViewers();
            assert.match(modal.text(), /Sua transmissão pelo Telinha: ninguém assistindo ainda\. "Expulsar" para de enviar na hora e ignora novos pedidos dessa pessoa até você sair da call\./);
            const [watching] = sections();
            assert.equal(sectionTitle(watching), "Assistindo agora");
            assert.equal(watching.querySelector(".vc-telinha-empty")?.textContent, "Ninguém abriu a sua transmissão ainda.");
        });

        test("cada espectador: nome do Discord, selo, onde esta, tipo de conexao (ainda verificando) e o botao Expulsar", async () => {
            show({ local: mine({ viewers: ["peerA", "peerB"] }), peers: [peer(), peer({ peerId: "peerB", discordUserId: OTHER_ID, username: "beto", inVoice: false, identity: "unverified" })] });
            const modal = await openViewers();
            assert.match(modal.text(), /2 pessoas assistindo/);

            const [a, b] = rowsIn(section("Assistindo agora"));
            assert.equal(nameOf(a), "Ana");
            assert.equal(a.querySelector(".vc-telinha-id-badge")?.textContent, "✔ verificado");
            assert.equal(metaOf(a), "Na sua call de voz · Conexão: verificando…");
            assert.equal(within(a).getByRole("button", { name: "Expulsar" }).dataset.variant, "dangerPrimary");
            assert.equal(nameOf(b), "beto");
            assert.equal(metaOf(b), "Fora da sua call de voz · Conexão: verificando…");
            assert.equal(b.querySelector(".vc-telinha-id-badge")?.textContent, "não verificado");
        });

        test("quem saiu da sala continua na lista como Alguem ate o nucleo tirar", async () => {
            show({ local: mine({ viewers: ["peerGone"] }) });
            await openViewers();
            const [row] = rowsIn(section("Assistindo agora"));
            assert.equal(nameOf(row), "Alguém");
            assert.equal(metaOf(row), "Saiu da sala · Conexão: verificando…");
            assert.equal(row.querySelector(".vc-telinha-id-badge"), null);
        });

        test("o nome anunciado so aparece quando difere do nome da conta do Discord (uma conexao falsa pode escolher outro nome)", async () => {
            show({
                local: mine({ viewers: ["p1", "p2", "p3", "p4"] }),
                peers: [
                    peer({ peerId: "p1", username: "ANA_DEV" }), // o mesmo nome com outras maiusculas: nada a avisar
                    peer({ peerId: "p2", username: "Ana" }), // o apelido global
                    peer({ peerId: "p3", username: "outra-pessoa" }),
                    peer({ peerId: "p4", discordUserId: "400000000000000009", username: "fantasma" }) // o Discord nao conhece essa conta
                ]
            });
            await openViewers();
            const metas = rowsIn(section("Assistindo agora")).map(metaOf);
            assert.deepEqual(metas, [
                "Na sua call de voz · Conexão: verificando…",
                "Na sua call de voz · Conexão: verificando…",
                "Na sua call de voz · Conexão: verificando… · diz se chamar \"outra-pessoa\"",
                "Na sua call de voz · Conexão: verificando… · Conta do Discord não encontrada (id 400000000000000009)"
            ]);
        });

        test("espectador com identidade duplicada: o aviso do alerta aparece na linha dele", async () => {
            const alert: IdentityAlert = { discordUserId: FRIEND_ID, username: "ana_dev", peerIds: ["peerA", "peerB"], self: false };
            show({ local: mine({ viewers: ["peerA"] }), peers: [peer({ duplicateIdentity: true })], identityAlerts: [alert] });
            await openViewers();
            const [row] = rowsIn(section("Assistindo agora"));
            assert.equal(warningOf(row), "Duas conexões dizem ser Ana — uma pode ser falsa");
            assert.equal(row.querySelector(".vc-telinha-viewer-warning")?.getAttribute("title"), "Duas conexões dizem ser Ana — uma pode ser falsa");
        });

        test("duplicado sem alerta correspondente: sem aviso na linha", async () => {
            show({ local: mine({ viewers: ["peerA"] }), peers: [peer({ duplicateIdentity: true })] });
            await openViewers();
            assert.equal(warningOf(rowsIn(section("Assistindo agora"))[0]), undefined);
        });
    });

    test("estado sem as listas opcionais (alertas, removidos, pedidos): desenha so o que ha", async () => {
        act(() => setState({ ...EMPTY, local: mine(), identityAlerts: undefined, blocked: undefined }));
        await openViewers();
        assert.deepEqual(sections().map(sectionTitle), ["Assistindo agora"]);
        assert.deepEqual(alerts(), []);
    });

    describe("Trocar tela ou janela", () => {
        test("fecha este modal e abre o seletor de fonte em modo Trocar", async () => {
            show({ local: mine() });
            const modal = await openViewers();
            modal.click("Trocar tela ou janela");
            await settle();
            assert.equal(modals.list().length, 1);
            assert.equal(document.querySelector("h1")?.textContent, "Trocar o que você transmite");
        });
    });

    describe("pedidos esperando", () => {
        test("Pedindo para assistir: quem pede, com a contagem regressiva ate recusar sozinho (e nunca abaixo de zero)", async t => {
            const clock = useFakeClock(t);
            show({ local: mine({ pendingViewers: [pending({ expiresAt: clock.epoch() + 60_000 })] }) });
            await openViewers();

            const [row] = rowsIn(section("Pedindo para assistir"));
            assert.equal(nameOf(row), "Ana");
            assert.equal(metaOf(row), "Quer assistir · recusado sozinho em 60 s");
            assert.deepEqual(within(row).getAllByRole("button").map(b => b.textContent), ["Permitir", "Recusar"]);
            assert.equal(within(row).getByRole("button", { name: "Permitir" }).dataset.variant, "positive");

            act(() => clock.tick(3000));
            assert.equal(metaOf(rowsIn(section("Pedindo para assistir"))[0]), "Quer assistir · recusado sozinho em 57 s");
            act(() => clock.tick(57_000));
            assert.equal(metaOf(rowsIn(section("Pedindo para assistir"))[0]), "Quer assistir · recusado sozinho em 0 s");
            act(() => clock.tick(5000));
            assert.equal(metaOf(rowsIn(section("Pedindo para assistir"))[0]), "Quer assistir · recusado sozinho em 0 s");
        });

        test("quem nao provou a identidade: o pedido explica e leva o selo", async () => {
            show({ local: mine({ pendingViewers: [pending({ identity: "unverified" })] }) });
            await openViewers();
            const [row] = rowsIn(section("Pedindo para assistir"));
            assert.match(metaOf(row)!, /^Quer assistir · não provou ser essa conta do Discord · recusado sozinho em (59|60) s$/);
            assert.equal(row.querySelector(".vc-telinha-id-badge")?.textContent, "não verificado");
        });

        test("sem pedidos, a secao nem aparece", async () => {
            show({ local: mine() });
            await openViewers();
            assert.equal(section("Pedindo para assistir"), undefined);
        });

        test("Permitir e Recusar de um pedido que ja expirou: avisa que expirou e nao muda nada", async () => {
            show({ local: mine({ pendingViewers: [pending()] }) });
            await openViewers();
            const row = rowsIn(section("Pedindo para assistir"))[0];
            fireEvent.click(within(row).getByRole("button", { name: "Permitir" }));
            fireEvent.click(within(row).getByRole("button", { name: "Recusar" }));
            assert.deepEqual(toasts, [
                { text: "Telinha: o pedido de Ana já expirou", variant: "default" },
                { text: "Telinha: o pedido de Ana já expirou", variant: "default" }
            ]);
        });
    });

    describe("conexoes suspeitas", () => {
        test("duplicadas que nao assistem: aparecem separadas, com o aviso e o Expulsar", async () => {
            const alert: IdentityAlert = { discordUserId: FRIEND_ID, username: "ana_dev", peerIds: ["peerA", "peerB"], self: false };
            show({
                local: mine(),
                peers: [peer({ peerId: "peerA", duplicateIdentity: true }), peer({ peerId: "peerB", duplicateIdentity: true, inVoice: false, identity: "unverified" }), peer({ peerId: "peerC", discordUserId: OTHER_ID, username: "beto", duplicateIdentity: true })],
                identityAlerts: [alert]
            });
            await openViewers();

            const suspicious = section("Conexões suspeitas (não recebem sua transmissão)");
            assert.deepEqual(rowsIn(suspicious).map(nameOf), ["Ana", "Ana", "beto"]);
            assert.deepEqual(rowsIn(suspicious).map(metaOf), [
                "Na sua call de voz · Conexão: verificando…",
                "Fora da sua call de voz · Conexão: verificando…",
                "Na sua call de voz · Conexão: verificando…"
            ]);
            assert.deepEqual(rowsIn(suspicious).map(warningOf), [
                "Duas conexões dizem ser Ana — uma pode ser falsa",
                "Duas conexões dizem ser Ana — uma pode ser falsa",
                "Outra conexão diz ser essa pessoa — uma pode ser falsa"
            ]);
        });

        test("uma conexao duplicada que ja assiste fica so em Assistindo agora", async () => {
            show({ local: mine({ viewers: ["peerA"] }), peers: [peer({ duplicateIdentity: true })] });
            await openViewers();
            assert.equal(section(/suspeitas/), undefined);
        });

        test("Expulsar de uma conexao que ja nao esta na call: avisa e nao muda nada", async () => {
            show({ local: mine(), peers: [peer({ duplicateIdentity: true })] });
            await openViewers();
            fireEvent.click(screen.getByRole("button", { name: "Expulsar" }));
            assert.deepEqual(toasts, [{ text: "Telinha: Ana não está mais na call", variant: "default" }]);
        });
    });

    describe("Removidos", () => {
        const blocked: BlockedViewer[] = [
            { discordUserId: FRIEND_ID, username: "ana_dev", reason: "kicked" },
            { discordUserId: OTHER_ID, username: "beto", reason: "declined" },
            { discordUserId: "400000000000000009", username: "carla", reason: "tooManyAttempts" },
            { discordUserId: "400000000000000010", username: "dani", reason: "motivo-novo" as never }
        ];

        test("cada pessoa removida com o motivo; motivo desconhecido cai no de recusado", async () => {
            show({ local: mine(), blocked });
            await openViewers();
            const rows = rowsIn(section("Removidos"));
            assert.deepEqual(rows.map(nameOf), ["Ana", "beto", "carla", "dani"]);
            assert.deepEqual(rows.map(metaOf), [
                "Expulso até você sair da call",
                "Recusado até esta transmissão acabar",
                "Errou a senha 5 vezes · bloqueado até esta transmissão acabar",
                "Recusado até esta transmissão acabar"
            ]);
            assert.deepEqual(rows.map(r => within(r).getByRole("button").textContent), ["Liberar", "Liberar", "Liberar", "Liberar"]);
        });

        test("a lista de removidos continua mesmo sem transmissao (a pessoa pode ser liberada)", async () => {
            show({ blocked: [blocked[0]] });
            await openViewers();
            assert.equal(sections().length, 1);
            assert.equal(sectionTitle(sections()[0]), "Removidos");
        });

        test("Liberar de alguem que ja nao esta bloqueado: nao reclama", async () => {
            show({ local: mine(), blocked: [blocked[0]] });
            await openViewers();
            fireEvent.click(screen.getByRole("button", { name: "Liberar" }));
            assert.deepEqual(toasts, []);
        });
    });

    describe("alertas de identidade", () => {
        test("cada tipo de alerta explica o que acontece com as conexoes, e so a prova falsa leva o selo", async () => {
            const list: IdentityAlert[] = [
                { discordUserId: "100000000000000001", username: "eu", peerIds: ["p1"], self: true },
                { discordUserId: FRIEND_ID, username: "ana_dev", peerIds: ["p2", "p3"], self: false },
                { discordUserId: FRIEND_ID, username: "ana_dev", peerIds: ["p4"], self: false, kind: "impostor" },
                { discordUserId: OTHER_ID, username: "beto", peerIds: ["p5"], self: false, kind: "fake" }
            ];
            show({ local: mine(), identityAlerts: list });
            await openViewers();

            assert.deepEqual(alerts().map(a => a.textContent), [
                "Uma conexão na call diz ser você — alguém pode estar se passando por você. Essa conexão nunca vê sua presença nem recebe sua transmissão.",
                "Duas conexões dizem ser Ana — uma pode ser falsa. Nenhuma delas recebe sua transmissão enquanto isso durar; quando uma sair, a outra precisa pedir de novo.",
                "Uma conexão não verificada diz ser Ana, que já provou a identidade — só ela fica bloqueada. A conexão verificada continua normal.",
                "Uma conexão apresentou uma prova de identidade falsa de beto — ignorada. Essa conexão nunca vê sua presença nem recebe sua transmissão.✖ identidade falsa"
            ]);
            assert.equal(screen.getAllByText("✖ identidade falsa").length, 1);
            assert.ok(alerts().every(a => a.getAttribute("role") === "status"));
        });
    });
});

// Uma unica sessao ao vivo: os testes deste bloco seguem a historia em ordem (pedem, Ana entra, beto e recusado...).
describe("ViewersModal com o nucleo de verdade", () => {
    let scene: LiveScene;

    before(async () => {
        scene = await openLiveScene();
        UserStore.addUsers(makeUser(FRIEND_ID, "ana_dev", { globalName: "Ana" }), makeUser(OTHER_ID, "beto"));
        await scene.connect("peerA", FRIEND_ID, "ana_dev");
        await scene.connect("peerB", OTHER_ID, "beto");
        // "Só quem eu aprovar": todo pedido espera o Permitir
        await scene.goLive({ access: "approval" });
        scene.askToWatch("peerA");
        scene.askToWatch("peerB");
        await until(() => getState().local?.pendingViewers?.length === 2);
    });

    after(() => scene.close());

    beforeEach(() => scene.resetUi());

    afterEach(async () => {
        await settle();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    const pendingRows = () => rowsIn(section("Pedindo para assistir"));
    const viewerRows = () => rowsIn(section("Assistindo agora"));
    const removedRows = () => rowsIn(section("Removidos"));

    test("dois pedidos esperando, do mais antigo ao mais novo, com a identidade de cada um", async () => {
        await openViewers();
        assert.deepEqual(pendingRows().map(nameOf), ["Ana", "beto"]);
        assert.deepEqual(pendingRows().map(r => r.querySelector(".vc-telinha-id-badge")?.textContent), ["não verificado", "não verificado"]);
        assert.equal(viewerRows().length, 0);
        screen.getByText("Ninguém abriu a sua transmissão ainda.");
    });

    test("Permitir: o pedido sai da fila, a pessoa passa a assistir e a transmissao e enviada para ela", async () => {
        await openViewers();
        fireEvent.click(within(pendingRows()[0]).getByRole("button", { name: "Permitir" }));
        await settle();
        await until(() => getState().local?.viewers.includes("peerA"));
        await settle();

        assert.deepEqual(toasts, [], "aprovar nao precisa de aviso: a lista muda");
        assert.deepEqual(pendingRows().map(nameOf), ["beto"]);
        assert.deepEqual(viewerRows().map(nameOf), ["Ana"]);
        assert.match(document.body.textContent!, /Sua transmissão pelo Telinha: 1 pessoa assistindo\./);
        assert.equal(scene.room.streamsAdded.some(s => s.target === "peerA" || (Array.isArray(s.target) && s.target.includes("peerA"))), true, "o stream foi para a Ana");
    });

    test("o tipo de conexao de quem assiste vem das estatisticas da conexao e se atualiza a cada 3 s", async t => {
        const kinds = [
            ["host", "host", 0.004, "Conexão direta, na mesma rede · 4 ms"],
            ["srflx", "srflx", 0.035, "Conexão direta pela internet (P2P) · 35 ms"],
            ["srflx", "relay", undefined, "Conexão por servidor intermediário (TURN)"]
        ] as const;
        const stats = (local: string, remote: string, rtt: number | undefined) => [
            { id: "T", type: "transport", selectedCandidatePairId: "P" },
            { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", ...(rtt === undefined ? {} : { currentRoundTripTime: rtt }) },
            { id: "L", type: "local-candidate", candidateType: local },
            { id: "R", type: "remote-candidate", candidateType: remote }
        ];
        let step = 0;
        scene.pc("peerA").stats = () => stats(kinds[step][0], kinds[step][1], kinds[step][2]);

        const clock = useFakeClock(t);
        await openViewers();
        await settle();
        const meta = () => metaOf(viewerRows()[0]);
        assert.equal(meta(), `Na sua call de voz · ${kinds[0][3]}`, "logo que abre");

        for (step = 1; step < kinds.length; step++) {
            await act(async () => void await clock.tickAsync(3000));
            assert.equal(meta(), `Na sua call de voz · ${kinds[step][3]}`, `${step * 3} s depois`);
        }
        clock.restore();
    });

    test("conexao ainda sem par escolhido: Conectando…", async () => {
        scene.pc("peerA").stats = [];
        await openViewers();
        await settle();
        assert.equal(metaOf(viewerRows()[0]), "Na sua call de voz · Conectando…");
    });

    test("Recusar: avisa, o pedido some e a pessoa aparece em Removidos ate a transmissao acabar", async () => {
        await openViewers();
        fireEvent.click(within(pendingRows()[0]).getByRole("button", { name: "Recusar" }));
        await settle();

        assert.deepEqual(toasts, [{ text: "beto não vai assistir esta transmissão", variant: "success" }]);
        assert.equal(section("Pedindo para assistir"), undefined, "nenhum pedido sobrou");
        assert.deepEqual(removedRows().map(nameOf), ["beto"]);
        assert.deepEqual(removedRows().map(metaOf), ["Recusado até esta transmissão acabar"]);
        const decline = scene.room.sentOn("watch", "peerB").at(-1)?.data;
        assert.deepEqual(decline, { op: "denied", reason: "declined" }, "a pessoa e avisada");
    });

    test("Expulsar: avisa, para de enviar e a pessoa passa a Removidos", async () => {
        await openViewers();
        fireEvent.click(within(viewerRows()[0]).getByRole("button", { name: "Expulsar" }));
        await settle();

        assert.deepEqual(toasts, [{ text: "Ana foi removido da sua transmissão", variant: "success" }]);
        assert.equal(getState().local?.viewers.length, 0);
        assert.deepEqual(removedRows().map(nameOf), ["beto", "Ana"], "do mais antigo ao mais novo");
        assert.deepEqual(removedRows().map(metaOf), ["Recusado até esta transmissão acabar", "Expulso até você sair da call"]);
        screen.getByText("Ninguém abriu a sua transmissão ainda.");
        assert.deepEqual(scene.room.sentOn("watch", "peerA").at(-1)?.data, { op: "denied", reason: "kicked" });
    });

    test("Liberar: a pessoa sai de Removidos e pode pedir de novo", async () => {
        const removed = (name: string) => removedRows().find(r => nameOf(r) === name)!;
        await openViewers();
        fireEvent.click(within(removed("Ana")).getByRole("button", { name: "Liberar" }));
        await settle();
        assert.deepEqual(removedRows().map(nameOf), ["beto"]);
        fireEvent.click(within(removed("beto")).getByRole("button", { name: "Liberar" }));
        await settle();
        assert.equal(section("Removidos"), undefined);
        assert.deepEqual(getState().blocked, []);

        // quem foi liberado volta a poder pedir: o pedido espera o Permitir de novo
        act(() => scene.askToWatch("peerA"));
        await until(() => getState().local?.pendingViewers?.length === 1);
        await settle();
        assert.deepEqual(pendingRows().map(nameOf), ["Ana"]);
    });

    test("Permitir, Recusar e Expulsar tambem funcionam sem o modal (a barra do Telinha usa as mesmas funcoes)", async () => {
        approveWithToast("peerA", "Ana");
        await until(() => getState().local?.viewers.includes("peerA"));
        assert.deepEqual(toasts, [], "permitir nao precisa de aviso");

        kickWithToast("peerA", "Ana");
        assert.deepEqual(toasts.splice(0), [{ text: "Ana foi removido da sua transmissão", variant: "success" }]);

        // o pedido de quem nao esta pedindo (ou ja foi decidido) expirou
        approveWithToast("peerB", "beto");
        declineWithToast("peerB", "beto");
        assert.deepEqual(toasts, [
            { text: "Telinha: o pedido de beto já expirou", variant: "default" },
            { text: "Telinha: o pedido de beto já expirou", variant: "default" }
        ]);
        toasts.length = 0;

        kickWithToast("peerGone", "Fulano");
        assert.deepEqual(toasts, [{ text: "Telinha: Fulano não está mais na call", variant: "default" }], "conexao que nao existe mais");
    });
});
