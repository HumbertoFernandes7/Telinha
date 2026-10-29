/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da etiqueta TELINHA na lista do canal de voz (ui/VoiceUserTag.tsx), renderizada de verdade (React +
// happy-dom) com o estado do Telinha (store.ts) e os stores falsos do Discord (test/fakes/vencord).
// Rodar:  pnpm test:file src/plugins/telinha/ui/VoiceUserTag.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { closeAllViewers } from "@plugins/telinha/ui/viewerWindows";
import { act, fireEvent, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, ME_ID, PopoutActions, resetVencordFakes } from "@test/fakes/vencord";

import { formatVoiceTagDiagnostics, VoiceUserTag } from "./VoiceUserTag";

const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

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
        await act(async () => closeAllViewers());
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

    test("amigo transmitindo: etiqueta clicavel com identidade e acesso; o clique abre o pop-out do visualizador", async () => {
        show({ peers: [friend({ stream: { ...friend().stream!, access: "password" } })] });
        render(<VoiceUserTag userId={FRIEND_ID} />);

        const tag = screen.getByRole("button");
        const label = tag.getAttribute("aria-label") ?? "";
        assert.match(label, /^Transmitindo pelo Telinha/);
        assert.match(label, /clique para assistir$/);
        assert.ok(label.includes(" · "), "mostra o selo do modo de acesso: " + label);

        fireEvent.click(tag);
        await settle(); // o clique pede o stream (core/viewing.ts): o estado novo chega num microtask
        assert.equal(PopoutActions.opened.length, 1, "abriu um pop-out");
        assert.match(PopoutActions.opened[0].key, new RegExp(FRIEND_ID));
        assert.match(formatVoiceTagDiagnostics(), /etiqueta desenhada \d+x a sua, [1-9]\d*x de amigos/);
    });

    test("Enter no teclado tambem abre o visualizador", async () => {
        show({ peers: [friend()] });
        render(<VoiceUserTag userId={FRIEND_ID} />);
        fireEvent.keyDown(screen.getByRole("button"), { key: "Enter" });
        await settle();
        assert.equal(PopoutActions.opened.length, 1);
    });
});
