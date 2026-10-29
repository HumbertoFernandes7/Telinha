/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da porta de entrada da tela da call (ui/callView/index.ts) e do patch do CallTile (ui/callView/patches.ts):
// o que o Discord passa para renderCallTileStream a cada render de tile, e a expressao regular do patch rodada
// contra o trecho minificado do bundle que esta citado no comentario de patches.ts.
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/index.test.tsx

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { cleanup, render, screen } from "@test/fakes/render";
import { caughtErrors, FRIEND_ID, loggerLines, resetVencordFakes } from "@test/fakes/vencord";
import type { ReactElement } from "react";

import { CallTileStream } from "./CallTileStream";
import { callViewPatches, renderCallTileStream, stopCallView } from "./index";
import { isTileOwned, registerTile, resetTileState, startTileWatch, unregisterTile } from "./tileState";

// #region o patch

/** O que o Vencord faz com `\\i` antes de usar a expressao: um identificador JS qualquer */
function canonicalize(match: RegExp): RegExp {
    return new RegExp(match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"), match.flags);
}

// Trecho real (minificado, build de 2026-10) citado em patches.ts: a tile de um participante USER, o conteudo (`e2`)
// e o que vem depois dele
const SAMPLE = "x.length&&(0,t.jsx)(V.A,{}),u.type===ek.lp.USER?(0,t.jsx)(\"div\",{className:eU.nl,children:(0,t.jsx)(W.A,{userId:ey,channelId:S.id,"
    + "guildId:S.getGuildId(),containerDimensions:{width:e9??0,height:e3??0}})}):null,e2,R?null:(0,t.jsx)(eL,{}),(0,t.jsx)(ew,{})";

describe("patch da tile da call", () => {
    const [patch] = callViewPatches;
    const { match, replace } = patch.replacement;

    test("procura o modulo do CallTileOverlay do Discord", () => {
        assert.equal(callViewPatches.length, 1);
        assert.equal(patch.find, ".displayName=\"CallTileOverlay\"");
    });

    test("insere a tile do Telinha logo depois do conteudo da tile (e so isso muda no codigo)", () => {
        const patched = SAMPLE.replace(canonicalize(match), replace as never);
        assert.equal(
            patched,
            SAMPLE.replace(":null,e2,R?null", ":null,e2,$self.renderCallTileStream(u,u.type===ek.lp.USER),R?null")
        );
        assert.ok(patched.includes("$self.renderCallTileStream(u,u.type===ek.lp.USER)"));
    });

    test("usa os nomes do build em que roda (o minificador renomeia tudo a cada versao)", () => {
        const renamed = SAMPLE.replaceAll("ek.lp", "qq.zz").replace("u.type", "p.type").replace(":null,e2,", ":null,k$,");
        const patched = renamed.replace(canonicalize(match), replace as never);
        assert.ok(patched.includes(":null,k$,$self.renderCallTileStream(p,p.type===qq.zz.USER),R?null"), patched);
    });

    test("se o Discord mudar o trecho o patch nao aplica e o codigo fica como estava", () => {
        const changed = SAMPLE.replace("containerDimensions", "dimensions");
        assert.equal(changed.replace(canonicalize(match), replace as never), changed);
        const notUserOnly = SAMPLE.replace(".USER?", ".GO_LIVE?");
        assert.equal(notUserOnly.replace(canonicalize(match), replace as never), notUserOnly);
    });
});

// #endregion

// #region renderCallTileStream

const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

function friend(patch: Partial<RemotePeer> = {}): RemotePeer {
    return {
        peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "Tela", hasAudio: false, width: 1920, height: 1080, fps: 60, access: "all" },
        ...patch
    };
}

describe("renderCallTileStream (o que o Discord chama a cada render de tile)", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
    });

    afterEach(() => {
        cleanup();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    test("so tiles de participante USER recebem o Telinha (Go Live, atividades e streams escondidos ficam de fora)", () => {
        const participant = { type: 0, id: FRIEND_ID, user: { id: FRIEND_ID } };
        assert.equal(renderCallTileStream(participant, false), null);
        assert.equal(renderCallTileStream(participant, undefined), null);
        assert.equal(renderCallTileStream(participant, "true"), null, "so o booleano true vale");
    });

    test("participante sem usuario ou com id invalido: nada", () => {
        assert.equal(renderCallTileStream(null, true), null);
        assert.equal(renderCallTileStream(undefined, true), null);
        assert.equal(renderCallTileStream({}, true), null);
        assert.equal(renderCallTileStream({ user: {} }, true), null);
        assert.equal(renderCallTileStream({ user: { id: 123 } }, true), null);
        assert.equal(renderCallTileStream({ user: { id: "" } }, true), null);
    });

    test("tile de um usuario: devolve o elemento do Telinha para aquele usuario, que desenha a etiqueta de quem transmite", () => {
        const element = renderCallTileStream({ type: 0, user: { id: FRIEND_ID } }, true) as ReactElement<{ userId: string; }>;
        assert.equal(element.type, CallTileStream);
        assert.equal(element.props.userId, FRIEND_ID);

        setState({ ...EMPTY, peers: [friend()] });
        render(element);
        assert.ok(screen.getByRole("button", { name: /Assistir a transmissão de amigo pelo Telinha/ }));
    });

    test("se o proprio Discord entregar algo estranho, a tile da call nao quebra: loga e nao desenha", () => {
        const hostile = { get user(): never { throw new Error("participante quebrado"); } };
        assert.equal(renderCallTileStream(hostile, true), null);
        const line = loggerLines.find(l => l.level === "error");
        assert.equal(line?.args[0], "renderCallTileStream falhou");
    });

    test("plugin parado: as tiles esquecem o que estavam fazendo", () => {
        registerTile("peerA");
        startTileWatch("peerA");
        assert.equal(isTileOwned("peerA"), true);
        stopCallView();
        assert.equal(isTileOwned("peerA"), false);
    });

    test("parar o plugin nunca lanca para dentro do stop() do Vencord", t => {
        const token = registerTile("peerB");
        startTileWatch("peerB");
        unregisterTile("peerB", token); // deixa uma graca de 4 s pendente
        const failing = t.mock.method(globalThis, "clearTimeout", () => {
            throw new Error("clearTimeout falhou");
        });
        assert.doesNotThrow(() => stopCallView());
        failing.mock.restore();
        const line = loggerLines.find(l => l.level === "error");
        assert.equal(line?.args[0], "stopCallView falhou");
        resetTileState(); // agora de verdade: cancela o timer que sobrou
    });
});

// #endregion
