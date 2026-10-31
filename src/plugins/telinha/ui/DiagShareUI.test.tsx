/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da secao "Compartilhar diagnóstico" na pagina do plugin (ui/DiagShareUI.tsx), renderizada de verdade (React +
// happy-dom) sobre o estado do store: com a opcao desligada nao desenha nada; ligada, a linha "Enviando diagnóstico para
// ..." (nunca um aviso que bloqueia) e um "Receber diagnóstico de X" para cada pessoa da call com a opcao ligada,
// verificada e no canal de voz. O botao chama o nucleo (core/diagShare.ts; o resto do caminho esta em diagShare.test.ts).
// O build sem Client ID fica em IdentityUI.identity-off.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/DiagShareUI.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { resetState, setState } from "@plugins/telinha/store";
import type { DiagShareState, RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { act, fireEvent, render, screen } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, OTHER_ID, pluginSettings, resetVencordFakes, VOICE_CHANNEL_ID } from "@test/fakes/vencord";

import { DiagShareSection } from "./DiagShareUI";

const THIRD_ID = "300000000000000033";

function peer(peerId: string, discordUserId: string, username: string, patch: Partial<RemotePeer> = {}): RemotePeer {
    return { peerId, discordUserId, username, streaming: false, admitted: true, inVoice: true, identity: "verified", diagShare: true, ...patch };
}

function show(peers: RemotePeer[], diag?: DiagShareState) {
    const state: TelinhaState = {
        inRoom: true, channelId: VOICE_CHANNEL_ID, peers, local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [], ...(diag ? { diag } : {})
    };
    act(() => setState(state));
}

const switches = () => screen.queryAllByRole("switch") as HTMLInputElement[];

beforeEach(() => {
    resetVencordFakes();
    resetState();
    pluginSettings.set("shareDiagnostics", true);
});

afterEach(() => {
    rt.diagRequested.clear();
    assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
});

describe("pagina do plugin: Compartilhar diagnóstico", () => {
    test("opcao desligada: nao desenha nada", () => {
        pluginSettings.set("shareDiagnostics", false);
        show([peer("pA", FRIEND_ID, "amigo")]);
        const { container } = render(<DiagShareSection />);
        assert.equal(container.innerHTML, "");
    });

    test("ligada e ninguem na call com a opcao: diz isso, sem botao", () => {
        show([peer("pA", FRIEND_ID, "amigo", { diagShare: undefined })]);
        render(<DiagShareSection />);
        assert.ok(screen.getByText("Compartilhar diagnóstico"));
        assert.ok(screen.getByText("Ninguém na call está com esta opção ligada agora."));
        assert.deepEqual(switches(), []);
    });

    test("um 'Receber diagnóstico' so para quem esta com a opcao, verificado, admitido e no canal de voz (uma vez por pessoa)", () => {
        show([
            peer("pA", FRIEND_ID, "amigo"),
            peer("pA2", FRIEND_ID, "amigo", { identity: "verified" }),
            peer("pB", OTHER_ID, "naoverificado", { identity: "unverified" }),
            peer("pC", THIRD_ID, "fora", { inVoice: false }),
            peer("pD", "400000000000000044", "naoadmitido", { admitted: false }),
            peer("pE", "500000000000000055", "semopcao", { diagShare: undefined })
        ]);
        render(<DiagShareSection />);
        assert.deepEqual(switches().map(s => s.closest("label")?.textContent), ["Receber diagnóstico de amigo"]);
        assert.equal(switches()[0].checked, false);
        assert.equal(screen.queryByText(/^Enviando diagnóstico/), null, "ninguem recebendo o seu: sem a linha");
    });

    test("pedido e recebendo: o botao ligado diz o que esta acontecendo", () => {
        show([peer("pA", FRIEND_ID, "amigo"), peer("pB", OTHER_ID, "outro")], { sendingTo: [], requested: [FRIEND_ID, OTHER_ID], receivingFrom: [OTHER_ID] });
        render(<DiagShareSection />);
        const [a, b] = switches();
        assert.equal(a.checked, true);
        assert.equal(b.checked, true);
        assert.match(a.closest("label")!.textContent!, /Pedindo…$/);
        assert.match(b.closest("label")!.textContent!, /Recebendo: vai para o console do Discord, nas linhas \[Telinha\] \[diag …\]$/);
    });

    test("alguem recebendo o diagnostico deste PC: so uma linha discreta", () => {
        show([], { sendingTo: ["amigo", "outro"], requested: [], receivingFrom: [] });
        render(<DiagShareSection />);
        assert.ok(screen.getByText("Enviando diagnóstico para amigo, outro"));
        assert.equal(screen.queryByRole("dialog"), null);
    });

    test("o botao liga e desliga o pedido no nucleo", () => {
        show([peer("pA", FRIEND_ID, "amigo")]);
        render(<DiagShareSection />);
        fireEvent.click(switches()[0]);
        assert.equal(rt.diagRequested.get(FRIEND_ID), "amigo");

        show([peer("pA", FRIEND_ID, "amigo")], { sendingTo: [], requested: [FRIEND_ID], receivingFrom: [] });
        assert.equal(switches()[0].checked, true);
        fireEvent.click(switches()[0]);
        assert.equal(rt.diagRequested.has(FRIEND_ID), false);
    });
});
