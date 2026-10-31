/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da etiqueta TELINHA na lista do canal de voz (ui/VoiceUserTag.tsx), renderizada de verdade (React +
// happy-dom) com o estado do Telinha (store.ts) e os stores falsos do Discord (test/fakes/vencord). O clique com o
// nucleo de verdade por tras (tela da call, tile, painel flutuante) esta em VoiceUserTag.core.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/VoiceUserTag.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { closeAllViewers } from "@plugins/telinha/ui/viewerWindows";
import { eventually } from "@test/fakes/clock";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, ChannelRouter, FluxDispatcher, FRIEND_ID, ME_ID, NavigationRouter, PopoutActions, resetVencordFakes } from "@test/fakes/vencord";

import { resetTileState } from "./callView/tileState";
import { formatVoiceTagDiagnostics, noteVoiceRowRender, VoiceUserTag } from "./VoiceUserTag";

const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

const panels = () => document.body.querySelectorAll(".vc-telinha-floating");

function friend(patch: Partial<RemotePeer> = {}): RemotePeer {
    return {
        peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" },
        ...patch
    };
}

function show(state: Partial<TelinhaState>) {
    act(() => setState({ ...EMPTY, ...state }));
}

describe("VoiceUserTag", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
    });

    afterEach(async () => {
        await act(async () => {
            closeAllViewers();
            resetTileState();
        });
        await eventually(() => panels().length === 0); // o painel flutuante sai da tela num setTimeout(0)
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    test("ninguem transmitindo: nao desenha nada", () => {
        show({ peers: [friend({ streaming: false })] });
        const { container } = render(<VoiceUserTag userId={FRIEND_ID} />);
        assert.equal(container.innerHTML, "");
    });

    test("lista recolhida (so avatares): nao desenha nada, mesmo com o amigo transmitindo", () => {
        show({ peers: [friend()] });
        const { container } = render(<VoiceUserTag userId={FRIEND_ID} collapsed />);
        assert.equal(container.innerHTML, "");
    });

    test("a sua etiqueta aparece quando voce transmite e acompanha o numero de espectadores", () => {
        const { container } = render(<VoiceUserTag userId={ME_ID} />);
        assert.equal(container.innerHTML, "", "sem transmissao: nada");

        const local = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, viewers: [], access: "all" as const };
        show({ local });
        const tag = screen.getByText("TELINHA");
        assert.equal(tag.getAttribute("role"), null, "a sua etiqueta nao e um botao");
        assert.equal(tag.getAttribute("aria-label"), "Você está transmitindo pelo Telinha — ninguém assistindo ainda");

        show({ local: { ...local, viewers: ["peerA", "peerB"] } });
        assert.equal(screen.getByText("TELINHA").getAttribute("aria-label"), "Você está transmitindo pelo Telinha — 2 pessoas assistindo");
    });

    test("amigo transmitindo: etiqueta clicavel com identidade e acesso, que diz que assiste dentro do Discord", () => {
        show({ peers: [friend({ stream: { ...friend().stream!, access: "password" } })] });
        render(<VoiceUserTag userId={FRIEND_ID} />);

        const tag = screen.getByRole("button");
        const label = tag.getAttribute("aria-label") ?? "";
        assert.match(label, /^Transmitindo pelo Telinha/);
        assert.match(label, /clique para assistir aqui no Discord, na tela da call$/);
        assert.ok(label.includes(" · "), "mostra o selo do modo de acesso: " + label);
        assert.equal(tag.getAttribute("tabindex"), "0", "da para chegar nela com Tab");
        assert.match(formatVoiceTagDiagnostics(), /etiqueta desenhada \d+x a sua, [1-9]\d*x de amigos/);
    });

    test("sem canal de voz (nenhuma tela da call para abrir): o clique abre o painel flutuante dentro do Discord", async () => {
        show({ channelId: null, peers: [friend()] });
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.click(screen.getByRole("button"));
        await settle();
        assert.equal(panels().length, 1, "o painel flutuante");
        assert.equal(PopoutActions.opened.length, 0, "nenhuma janela separada");
        assert.deepEqual(ChannelRouter.transitions, [], "nenhuma navegacao");
        assert.deepEqual(NavigationRouter.paths, []);
    });

    test("um estado quebrado nao derruba a lista de voz do Discord: a etiqueta some e o erro fica registrado", t => {
        t.mock.method(console, "error", () => { }); // o React conta o erro do desenho no console
        show({ peers: [friend()] });
        const { container } = render(<VoiceUserTag userId={FRIEND_ID} />);
        screen.getByRole("button");
        act(() => setState({ ...EMPTY, peers: null as never }));
        assert.equal(container.innerHTML, "", "a etiqueta some em silencio");
        assert.equal(caughtErrors.length, 1);
        caughtErrors.length = 0;
    });

    test("a sua etiqueta nao e clicavel nem responde ao teclado (nem ao duplo clique)", async () => {
        const local = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, viewers: [], access: "all" as const };
        show({ local });
        let rowEvents = 0;
        render(<div onClick={() => rowEvents++} onDoubleClick={() => rowEvents++}><VoiceUserTag userId={ME_ID} /></div>);
        const tag = screen.getByText("TELINHA");
        assert.equal(tag.getAttribute("tabindex"), null);
        assert.match(tag.className, /vc-telinha-tag-self/);

        fireEvent.keyDown(tag, { key: "Enter" });
        fireEvent.keyDown(tag, { key: " " });
        fireEvent.click(tag, { detail: 1 });
        fireEvent.click(tag, { detail: 2 });
        fireEvent.doubleClick(tag, { detail: 2 });
        await settle();
        assert.equal(rowEvents, 0, "nem a linha do Discord recebe");
        assert.equal(PopoutActions.opened.length, 0);
        assert.deepEqual(ChannelRouter.transitions, []);
        assert.deepEqual(FluxDispatcher.dispatched.filter(a => a.type === "CHANNEL_RTC_SELECT_PARTICIPANT"), []);
        assert.equal(panels().length, 0);
    });

    describe("o texto do tooltip", () => {
        const label = () => screen.getByRole("button").getAttribute("aria-label");

        test("cada identidade tem a sua frase; sem identidade ou conferindo, nenhuma", () => {
            const cases: [RemotePeer["identity"], string][] = [
                ["verified", "Transmitindo pelo Telinha (identidade verificada) — clique para assistir aqui no Discord, na tela da call"],
                ["unverified", "Transmitindo pelo Telinha (não verificado) — clique para assistir aqui no Discord, na tela da call"],
                ["pending", "Transmitindo pelo Telinha — clique para assistir aqui no Discord, na tela da call"],
                ["invalid", "Transmitindo pelo Telinha — clique para assistir aqui no Discord, na tela da call"],
                [undefined, "Transmitindo pelo Telinha — clique para assistir aqui no Discord, na tela da call"]
            ];
            for (const [identity, expected] of cases) {
                show({ peers: [friend({ identity })] });
                const { unmount } = render(<VoiceUserTag userId={FRIEND_ID} />);
                assert.equal(label(), expected, String(identity));
                unmount();
            }
        });

        test("quem voce ja esta assistindo: o clique leva para a tela da call", () => {
            show({ peers: [friend()], viewing: { peerA: { peerId: "peerA", stream: null, status: "playing" } } });
            render(<VoiceUserTag userId={FRIEND_ID} />);
            assert.equal(label(), "Transmitindo pelo Telinha (identidade verificada) — clique para ver na tela da call");
        });

        test("modo de acesso: a etiqueta vai depois da identidade; Todos da call nao tem", () => {
            show({ peers: [friend({ stream: { ...friend().stream!, access: "approval" } })] });
            render(<VoiceUserTag userId={FRIEND_ID} />);
            assert.equal(label(), "Transmitindo pelo Telinha (identidade verificada) · ✋ com aprovação — clique para assistir aqui no Discord, na tela da call");
        });
    });

    describe("a mesma pessoa com mais de uma conexao", () => {
        test("vale a que provou a identidade e transmite", () => {
            show({
                peers: [
                    friend({ peerId: "falsa", identity: "unverified", stream: { ...friend().stream!, access: "password" } }),
                    friend({ peerId: "verdadeira", identity: "verified" })
                ]
            });
            render(<VoiceUserTag userId={FRIEND_ID} />);
            assert.match(screen.getByRole("button").getAttribute("aria-label")!, /identidade verificada/);
            assert.doesNotMatch(screen.getByRole("button").getAttribute("aria-label")!, /senha/);
        });

        test("sem nenhuma verificada, vale a primeira; se ela nao transmite, nada aparece", () => {
            show({ peers: [friend({ peerId: "a", identity: "unverified", streaming: false, stream: undefined }), friend({ peerId: "b", identity: "unverified" })] });
            const { container } = render(<VoiceUserTag userId={FRIEND_ID} />);
            assert.equal(container.innerHTML, "", "a primeira conexao nao transmite");
        });

        test("outra pessoa transmitindo nao aparece na linha desta", () => {
            show({ peers: [friend({ discordUserId: "300000000000000003" })] });
            const { container } = render(<VoiceUserTag userId={FRIEND_ID} />);
            assert.equal(container.innerHTML, "");
        });
    });

    describe("diagnostico da etiqueta", () => {
        const counts = () => {
            const m = formatVoiceTagDiagnostics().match(/linhas desenhadas (\d+)x \(sem usuário: (\d+)\)/)!;
            return { rows: Number(m[1]), withoutUser: Number(m[2]) };
        };

        test("cada linha de usuario que o Discord desenha e contada; sem usuario conta a parte, e a hora aparece", () => {
            const before = counts();
            noteVoiceRowRender(FRIEND_ID);
            noteVoiceRowRender(undefined);
            noteVoiceRowRender(ME_ID);
            const after = counts();
            assert.equal(after.rows - before.rows, 3);
            assert.equal(after.withoutUser - before.withoutUser, 1);
            assert.match(formatVoiceTagDiagnostics(), /última \d\d:\d\d:\d\d\.\d{3};/, "hora ISO da ultima linha");
        });

        test("conta as etiquetas desenhadas: a sua e a dos amigos", () => {
            const read = () => formatVoiceTagDiagnostics().match(/etiqueta desenhada (\d+)x a sua, (\d+)x de amigos/)!.slice(1).map(Number);
            const [ownBefore, peersBefore] = read();
            show({ peers: [friend()] });
            render(<VoiceUserTag userId={FRIEND_ID} />);
            const [ownAfter, peersAfter] = read();
            assert.equal(ownAfter, ownBefore);
            assert.ok(peersAfter > peersBefore);
        });
    });
});
