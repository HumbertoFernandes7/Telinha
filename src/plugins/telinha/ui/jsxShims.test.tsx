/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos "shims" de jsx que os patches do Discord chamam no lugar de `(0,r.jsx)(X,{...})` (ui/jsxShims.ts): cada um
// desenha o elemento ORIGINAL sem mexer nas props e um irmao do Telinha: a barra acima do painel da conta e a etiqueta na
// linha de cada usuario do canal de voz. Renderizados de verdade (React + happy-dom). Nao entra no build (nada importa
// este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/jsxShims.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { closeAllViewers } from "@plugins/telinha/ui/viewerWindows";
import { act, render, screen } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, resetVencordFakes, SelectedChannelStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import type { ReactElement } from "react";

import { panelJsx, voiceUserIconsJsx } from "./jsxShims";
import { formatVoiceTagDiagnostics } from "./VoiceUserTag";

const EMPTY: TelinhaState = { inRoom: true, channelId: VOICE_CHANNEL_ID, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };
const streamer: RemotePeer = {
    peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
    stream: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" }
};

beforeEach(() => {
    resetVencordFakes();
    resetState();
});

afterEach(async () => {
    await act(async () => closeAllViewers());
    assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
});

/** Stands for Discord's VoiceUserIcons: gets the whole row's props (user, collapsed...) and draws a marker */
function Icons(props: { "data-testid"?: string; user?: unknown; collapsed?: boolean; }) {
    return <div data-testid={props["data-testid"]} />;
}

/** the DOM order of two elements: negative when `a` comes first */
const order = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

describe("panelJsx: a barra do Telinha acima do painel da conta", () => {
    for (const fn of ["jsx", "jsxs"] as const) {
        test(`${fn}: em um canal de voz desenha a barra antes do painel original, que fica como estava`, () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            const element = panelJsx[fn]("section", { "data-testid": "account", className: "painel", children: "Minha conta" });
            render(element);

            const bar = screen.getByRole("button", { name: /Transmitir com Telinha/ });
            const panel = screen.getByTestId("account");
            assert.equal(panel.textContent, "Minha conta");
            assert.equal(panel.className, "painel", "as props originais passam sem mudar");
            assert.equal(order(bar, panel), -1, "a barra vem ANTES do painel (logo abaixo do painel de voz)");
        });
    }

    test("fora de um canal de voz a barra fica quieta e so o painel original aparece", () => {
        render(panelJsx.jsx("section", { "data-testid": "account" }));
        assert.ok(screen.getByTestId("account"));
        assert.equal(screen.queryByRole("button", { name: /Transmitir com Telinha/ }), null);
    });

    test("a chave (key) do elemento original vai para o fragmento, que e o que o React compara na lista", () => {
        const withKey = panelJsx.jsx("div", {}, "painel-1") as ReactElement;
        assert.equal(withKey.key, "painel-1");
        const withoutKey = panelJsx.jsxs("div", {}) as ReactElement;
        assert.equal(withoutKey.key, null);
    });
});

describe("voiceUserIconsJsx: a etiqueta TELINHA na linha do usuario", () => {
    for (const fn of ["jsx", "jsxs"] as const) {
        test(`${fn}: usuario transmitindo pelo Telinha: a etiqueta vem antes dos icones originais, que ficam como estavam`, () => {
            setState({ ...EMPTY, peers: [streamer] });
            const element = voiceUserIconsJsx[fn](Icons, { user: { id: FRIEND_ID }, "data-testid": "icons", collapsed: false });
            render(element);

            const tag = screen.getByText("TELINHA");
            const icons = screen.getByTestId("icons");
            assert.equal(order(tag, icons), -1, "a etiqueta fica antes dos icones de mudo/surdo/AO VIVO");
            assert.equal(screen.getByRole("button", { name: /Transmitindo pelo Telinha/ }), tag.closest("[role=button]"));
        });
    }

    test("lista recolhida (so avatares): a etiqueta nao aparece, os icones sim", () => {
        setState({ ...EMPTY, peers: [streamer] });
        render(voiceUserIconsJsx.jsx(Icons, { user: { id: FRIEND_ID }, "data-testid": "icons", collapsed: true }));
        assert.equal(screen.queryByText("TELINHA"), null);
        assert.ok(screen.getByTestId("icons"));
    });

    test("usuario que nao transmite: so os icones originais", () => {
        render(voiceUserIconsJsx.jsx(Icons, { user: { id: FRIEND_ID }, "data-testid": "icons" }));
        assert.equal(screen.queryByText("TELINHA"), null);
        assert.ok(screen.getByTestId("icons"));
    });

    test("linha sem usuario (props inesperadas do Discord): devolve o elemento original com a chave, sem etiqueta", () => {
        for (const props of [{}, { user: null }, { user: { id: "" } }, { user: { id: 42 } }] as Record<string, unknown>[]) {
            const element = voiceUserIconsJsx.jsx(Icons, { ...props, "data-testid": "icons" }, "k1") as ReactElement;
            assert.equal(element.type, Icons);
            assert.equal(element.key, "k1");
            assert.equal((element.props as Record<string, unknown>)["data-testid"], "icons");
        }
        const noKey = voiceUserIconsJsx.jsx(Icons, { "data-testid": "icons" }) as ReactElement;
        assert.equal(noKey.key, null);
        assert.equal((voiceUserIconsJsx.jsx(Icons, undefined as never) as ReactElement).type, Icons, "props ausentes nao quebram");
    });

    test("cada linha desenhada e contada no diagnostico (zero depois de abrir um canal = o patch nao aplicou)", () => {
        const before = formatVoiceTagDiagnostics();
        voiceUserIconsJsx.jsx(Icons, { user: { id: FRIEND_ID } });
        voiceUserIconsJsx.jsx(Icons, {});
        const after = formatVoiceTagDiagnostics();
        const rows = (text: string) => Number(/linhas desenhadas (\d+)x/.exec(text)?.[1]);
        const withoutUser = (text: string) => Number(/sem usuário: (\d+)/.exec(text)?.[1]);
        assert.equal(rows(after) - rows(before), 2);
        assert.equal(withoutUser(after) - withoutUser(before), 1);
    });
});
