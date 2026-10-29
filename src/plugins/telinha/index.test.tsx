/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da definicao do plugin (index.tsx), o que o Vencord le: nome, configuracoes, os patches do Discord (cada regex roda
// contra o trecho minificado que o comentario dela cita, e o codigo resultante e executado), a pagina do plugin com o botao
// "Copiar diagnostico" e o liga/desliga (start/stop liga as notificacoes, os sons, os avisos de atualizacao, as verificacoes e
// a sessao; stop desliga tudo). Se os regex ainda casam com o bundle ATUAL do Discord so da para saber com o cliente de verdade.
// Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/index.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { getState, resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv, updateStatus as statusOf } from "@test/fakes/native";
import { act, fireEvent, render, screen, waitFor } from "@test/fakes/render";
import {
    caughtErrors, clipboard, clipboardImpl, FluxDispatcher, FRIEND_ID, loggerLines, notifications, pluginSettings, PopoutActions, resetVencordFakes, SelectedChannelStore,
    toasts, VOICE_CHANNEL_ID, webpackModules
} from "@test/fakes/vencord";
import { installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { applyPatch, evalExpression, type PatchLike, SELF } from "@test/helpers/wpc-patches";
import type { ReactElement } from "react";

import plugin from "./index";
import { settings } from "./settings";
import { callViewPatches, renderCallTileStream } from "./ui/callView";
import { panelJsx, voiceUserIconsJsx } from "./ui/jsxShims";
import { renderToolboxActions, userContextMenuPatch } from "./ui/menus";
import { openViewer } from "./ui/viewerWindows";

const patches = plugin.patches as unknown as PatchLike[];
const EMPTY: TelinhaState = { inRoom: true, channelId: VOICE_CHANNEL_ID, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };
const streamer: RemotePeer = {
    peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
    stream: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" }
};

beforeEach(() => {
    resetVencordFakes();
    resetState();
});

describe("o que o Vencord le do plugin", () => {
    test("nome, descricao, autor e as configuracoes", () => {
        assert.equal(plugin.name, "Telinha");
        assert.match(plugin.description, /^Telinha: transmita a tela direto entre amigos na call, sem servidor \(P2P\)\.$/);
        assert.equal(plugin.authors.length, 1);
        assert.equal(plugin.authors[0].name, "Telinha");
        assert.equal(plugin.settings, settings);
    });

    test("os ganchos apontam para os modulos certos (o Vencord chama estes objetos)", () => {
        assert.equal(plugin.panelJsx, panelJsx);
        assert.equal(plugin.voiceUserIconsJsx, voiceUserIconsJsx);
        assert.equal(plugin.renderCallTileStream, renderCallTileStream);
        assert.equal(plugin.toolboxActions, renderToolboxActions);
        assert.deepEqual(Object.keys(plugin.contextMenus!), ["user-context"]);
        assert.equal(plugin.contextMenus!["user-context"], userContextMenuPatch);
        assert.equal(typeof plugin.start, "function");
        assert.equal(typeof plugin.stop, "function");
    });

    test("tres patches: painel da conta, etiqueta na lista de voz e a tela da call", () => {
        assert.equal(patches.length, 3);
        for (const p of patches) {
            assert.ok(typeof p.find === "string" && p.find.length > 8, "cada patch diz em qual modulo do Discord age");
            assert.ok(p.replacement.match instanceof RegExp);
        }
        assert.match(patches[0].find as string, /USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL/);
        assert.match(patches[1].find as string, /GUEST_NAME_SUFFIX/);
        assert.equal(patches[2], callViewPatches[0], "o patch da tela da call vem de ui/callView/patches.ts");
    });
});

describe("patch do painel da conta (a barra do Telinha logo abaixo do painel de voz)", () => {
    const panel = patches[0];
    const props = "{currentUser:u,className:s.panel,userTag:d,occluded:f}";

    for (const fn of ["jsx", "jsxs"]) {
        test(`${fn}: troca so a funcao jsx da chamada do painel da conta e deixa os argumentos como estao`, () => {
            const before = `a,(0,r.${fn})(P,${props}),b`;
            assert.equal(applyPatch(panel, before), `a,(0,${SELF}.panelJsx.${fn})(P,${props}),b`);
        });
    }

    test("depois do SpotifyControls (que troca o componente pelo PanelWrapper dele) ainda casa", () => {
        const spotify = "(0,r.jsx)(Vencord.Plugins.plugins[\"SpotifyControls\"].PanelWrapper," + props + ")";
        assert.equal(applyPatch(panel, spotify), `(0,${SELF}.panelJsx.jsx)(Vencord.Plugins.plugins["SpotifyControls"].PanelWrapper,${props})`);
    });

    test("outras chamadas jsx do mesmo modulo (sem userTag/occluded) nao sao tocadas", () => {
        const code = `(0,r.jsx)("div",{className:x}),(0,r.jsxs)(P,{currentUser:u,children:[]}),(0,r.jsx)(P,${props})`;
        assert.equal(applyPatch(panel, code), `(0,r.jsx)("div",{className:x}),(0,r.jsxs)(P,{currentUser:u,children:[]}),(0,${SELF}.panelJsx.jsx)(P,${props})`);
    });

    test("o codigo que sai chama o shim com o componente e as props originais, e a barra vem antes do painel", () => {
        const Account = () => null;
        const code = applyPatch(panel, `(0,r.jsx)(P,${props})`);
        const element = evalExpression(code, {
            Vencord: { Plugins: { plugins: { Telinha: plugin } } },
            r: { jsx: () => "original nao deve ser chamado" },
            P: Account, u: 1, s: { panel: "painel" }, d: 2, f: 3
        }) as ReactElement<{ children: ReactElement[]; }>;
        const [bar, original] = element.props.children;
        assert.equal(original.type, Account);
        assert.deepEqual(original.props, { currentUser: 1, className: "painel", userTag: 2, occluded: 3 });
        assert.notEqual(bar.type, Account);
    });
});

describe("patch da lista de voz (a etiqueta TELINHA antes dos icones da linha)", () => {
    const row = patches[1];
    const icons = "{disabled:a,...o,isHovered:c}";

    for (const fn of ["jsx", "jsxs"]) {
        test(`${fn}: casa na chamada que recebe isHovered e troca so a funcao`, () => {
            assert.equal(applyPatch(row, `(0,r.${fn})(f,${icons})`), `(0,${SELF}.voiceUserIconsJsx.${fn})(f,${icons})`);
        });
    }

    test("o <span> do sufixo de convidado, que vem antes, nao e tocado (so as chamadas com isHovered)", () => {
        const code = `(0,r.jsx)("span",{className:s.guest,children:g}),(0,r.jsx)(f,${icons})`;
        assert.equal(applyPatch(row, code), `(0,r.jsx)("span",{className:s.guest,children:g}),(0,${SELF}.voiceUserIconsJsx.jsx)(f,${icons})`);
    });

    test("uma chamada sem isHovered, ou com isHovered longe demais, fica como estava", () => {
        const noHover = "(0,r.jsx)(f,{disabled:a,...o})";
        assert.equal(applyPatch(row, noHover), noHover);
        const far = `(0,r.jsx)(f,{${"x:1,".repeat(40)}isHovered:c})`;
        assert.equal(applyPatch(row, far), far);
    });

    test("o codigo que sai desenha a etiqueta antes do componente de icones original", () => {
        const Icons = () => null;
        const code = applyPatch(row, `(0,r.jsx)(f,${icons})`);
        const element = evalExpression(code, {
            Vencord: { Plugins: { plugins: { Telinha: plugin } } },
            r: { jsx: () => "original nao deve ser chamado" },
            f: Icons, a: false, o: { user: { id: FRIEND_ID }, collapsed: false }, c: false
        }) as ReactElement<{ children: ReactElement[]; }>;
        const [tag, original] = element.props.children;
        assert.equal(original.type, Icons);
        assert.equal((original.props as { user: { id: string; }; }).user.id, FRIEND_ID);
        assert.deepEqual((tag.props as { userId: string; collapsed: boolean; }), { userId: FRIEND_ID, collapsed: false });
    });
});

describe("pagina do plugin e 'Copiar diagnostico'", () => {
    let native: NativeEnv | null = null;

    afterEach(() => {
        native?.restore();
        native = null;
        mock.restoreAll();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    const About = () => <>{plugin.settingsAboutComponent!({})}</>;
    const copy = () => fireEvent.click(screen.getByRole("button", { name: "Copiar diagnóstico" }));

    test("explica como transmitir e mostra o botao e as secoes de identidade e de atualizacao", async () => {
        native = installNative();
        render(<About />);
        assert.ok(screen.getByText(/Numa call de voz, use "Transmitir com Telinha" logo abaixo do painel da conexão de voz/));
        assert.ok(screen.getByText(/Todos na call precisam ter o Telinha\./));
        assert.ok(screen.getByRole("button", { name: "Copiar diagnóstico" }));
        await waitFor(() => assert.ok(screen.getByText("Versão instalada:", { exact: false })), { timeout: 2000 });
        assert.ok(screen.getByRole("button", { name: "Procurar atualização" }));
    });

    test("copia o diagnostico inteiro (estado, versao fresca, identidade e etiqueta) e avisa", async () => {
        native = installNative({}, { addon: { updateStatus: async () => statusOf({ installed: { version: "0.9.9", commit: "c0ffee00" } }) } });
        render(<About />);
        copy();
        await waitFor(() => assert.equal(toasts.length, 1));
        assert.deepEqual(toasts, [{ text: "Diagnóstico do Telinha copiado", variant: "success" }]);

        assert.equal(clipboard.length, 1);
        const text = clipboard[0];
        assert.match(text, /^Telinha — diagnóstico\n/);
        const version = text.indexOf("versão: 0.9.9 (c0ffee00); atualização automática: ligada; atualização: Em dia.");
        const identity = text.indexOf("identidade: configurada (app ");
        const peers = text.indexOf("identidade dos peers: nenhum");
        const tag = text.lastIndexOf("\n\netiqueta TELINHA (lista de voz): linhas desenhadas ");
        assert.ok(version > 0 && identity > version && peers > identity && tag > peers, "as quatro partes, nessa ordem");
        assert.ok(text.endsWith(text.slice(tag)) && !text.slice(tag + 2).includes("\n"), "a etiqueta e a ultima linha");
        assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, "nenhum IP no diagnostico");
        assert.ok(native.calls.some(c => c.name === "updateStatus"), "a versao foi lida de novo no main antes de copiar");
    });

    test("sem o loader do add-on, a versao sai como desconhecida", async () => {
        render(<About />);
        copy();
        await waitFor(() => assert.equal(toasts.length, 1));
        assert.match(clipboard[0], /versão: \? \(sem o loader do add-on: atualização automática indisponível\)/);
    });

    test("a identidade que falha ao montar o texto vira uma linha de aviso, o resto copia", async t => {
        t.mock.getter(settings, "store", () => {
            throw new Error("configuracoes indisponiveis");
        });
        render(<About />);
        copy();
        await waitFor(() => assert.equal(toasts.length, 1));
        assert.equal(toasts[0].variant, "success");
        assert.match(clipboard[0], /identidade: diagnóstico indisponível \(configuracoes indisponiveis\)/);
    });

    test("identidade que lanca algo que nao e Error: o texto vem como esta", async t => {
        t.mock.getter(settings, "store", () => {
            throw "texto solto";
        });
        render(<About />);
        copy();
        await waitFor(() => assert.equal(toasts.length, 1));
        assert.match(clipboard[0], /identidade: diagnóstico indisponível \(texto solto\)/);
    });

    test("a area de transferencia recusa: avisa em vermelho e nao quebra", async t => {
        t.mock.method(clipboardImpl, "copy", () => Promise.reject(new Error("negado")));
        render(<About />);
        copy();
        await waitFor(() => assert.equal(toasts.length, 1));
        assert.deepEqual(toasts, [{ text: "Não consegui copiar o diagnóstico", variant: "critical" }]);
        assert.deepEqual(clipboard, []);
    });
});

describe("start e stop do plugin", () => {
    let native: NativeEnv;
    let rtc: WebRtcEnv;
    const playSound = mock.fn((_name: string, _volume?: number): unknown => undefined);

    beforeEach(() => {
        native = installNative({}, { addon: { updateStatus: async () => statusOf({ phase: "ready", ready: "0.9.0" }) } });
        rtc = installWebRtc();
        mock.method(document, "hasFocus", () => true);
        playSound.mock.resetCalls();
        webpackModules.provideByCode("Unable to find sound for pack name", playSound);
    });

    afterEach(() => {
        plugin.stop();
        native.restore();
        rtc.restore();
        mock.restoreAll();
    });

    test("start migra a opcao antiga e liga a sessao, os avisos, os sons, os avisos de atualizacao e as verificacoes; stop desliga tudo", async t => {
        const clock = useFakeClock(t);
        pluginSettings.load({ approveViewers: true });
        for (const key of Object.keys(settings.plain)) if (key !== "approveViewers") delete (settings.plain as Record<string, unknown>)[key];

        plugin.start();
        await clock.tickAsync(0);

        // v0.1.0 -> v0.2.0
        assert.equal(settings.plain.defaultAccess, "approval");
        assert.equal("approveViewers" in settings.plain, false);
        // a sessao assina o Discord
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 1);
        // avisos de pedidos para assistir
        const pending = { peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", expiresAt: Date.now() + 60_000 };
        const local = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, viewers: [] as string[], access: "approval" as const, pendingViewers: [pending] };
        act(() => setState({ ...EMPTY, peers: [streamer], local }));
        assert.ok(notifications.some(n => n.title === "Telinha: pedido para assistir"), "notices ligado");
        // sons: alguem comecou a assistir
        act(() => setState({ ...EMPTY, peers: [streamer], local: { ...local, viewers: ["peerA"], pendingViewers: [] } }));
        assert.deepEqual(playSound.mock.calls.map(c => c.arguments[0]), ["stream_user_joined"]);
        // aviso de atualizacao pronta (o status foi lido ao ligar as verificacoes)
        await clock.tickAsync(0);
        assert.ok(notifications.some(n => n.title === "Telinha 0.9.0 pronto"), "avisos de atualizacao ligados");
        // verificacao silenciosa 15 s depois
        await clock.tickAsync(16_000);
        assert.equal(native.calls.filter(c => c.name === "updateCheck").length, 1);

        // um visualizador aberto

        openViewer("peerA");
        assert.equal(PopoutActions.opened.length, 1);

        plugin.stop();
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 0, "sessao parada");
        assert.equal(PopoutActions.closed.length, 1, "visualizadores fechados");
        const shown = notifications.length;
        const played = playSound.mock.callCount();
        act(() => setState({ ...EMPTY, local: { ...local, viewers: [], pendingViewers: [{ ...pending, peerId: "peerZ" }] } }));
        act(() => setState({ ...EMPTY, peers: [streamer], local: { ...local, viewers: ["peerA"], pendingViewers: [] } }));
        assert.equal(notifications.length, shown, "notices desligado");
        assert.equal(playSound.mock.callCount(), played, "sons desligados");
        const calls = native.calls.length;
        await clock.tickAsync(13 * 60 * 60_000, 60 * 60_000);
        assert.equal(native.calls.filter(c => c.name === "updateCheck").length, 1, "verificacoes paradas");
        assert.equal(native.calls.length, calls);
        assert.equal(getState().inRoom, false, "a sessao limpou o estado");
    });

    test("falha ao ligar ou desligar a sessao: so um erro no log do plugin, o Vencord nao ve excecao", t => {
        t.mock.method(FluxDispatcher, "subscribe", () => {
            throw new Error("flux caiu");
        });
        assert.doesNotThrow(() => plugin.start());
        assert.equal(loggerLines.find(l => l.level === "error")?.args[0], "startSession falhou");
        t.mock.restoreAll();

        resetVencordFakes();
        t.mock.method(FluxDispatcher, "unsubscribe", () => {
            throw new Error("flux caiu de novo");
        });
        assert.doesNotThrow(() => plugin.stop());
        assert.ok(loggerLines.some(l => l.level === "error" && l.args[0] === "stopSession falhou"));
    });

    test("entrar numa call depois de ligar: a sessao segue a sala (o plugin esta de fato ligado)", async () => {
        plugin.start();
        SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
        FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId: VOICE_CHANNEL_ID, guildId: null });
        await waitFor(() => assert.equal(getState().channelId, VOICE_CHANNEL_ID));
        await flushPromises();
    });
});
