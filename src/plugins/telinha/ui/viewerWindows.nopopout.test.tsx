/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// viewerWindows.tsx quando o Discord (numa versao futura) nao tem mais o componente PopoutWindow: o Telinha avisa no log
// e abre o player direto na janela, sem a moldura. O componente e procurado uma vez so por processo (e a resposta fica
// guardada), por isso este caso tem o seu arquivo; o caso normal esta em viewerWindows.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/viewerWindows.nopopout.test.tsx

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { resetState } from "@plugins/telinha/store";
import { cleanup, render, screen, settle } from "@test/fakes/render";
import { caughtErrors, loggerLines, PopoutActions, resetVencordFakes } from "@test/fakes/vencord";
import { animations, assertAbsent, installAnimate } from "@test/helpers/wpe-dom";
import type { ReactNode } from "react";

import { closeAllViewers, closeViewer, openViewer } from "./viewerWindows";

const PEER = "peerA";
const MISSING = "O componente PopoutWindow do Discord não foi encontrado".length; // so para o editor mostrar o tamanho
void MISSING;

const warnings = () => loggerLines.filter(l => l.logger === "Telinha UI" && l.level === "warn").map(l => String(l.args[0]));

describe("viewerWindows (sem o PopoutWindow do Discord)", () => {
    let restoreAnimate: () => void;
    before(() => void (restoreAnimate = installAnimate()));
    after(() => restoreAnimate());

    beforeEach(() => {
        resetVencordFakes();
        resetState();
        animations.reset();
    });

    afterEach(async () => {
        cleanup();
        closeAllViewers();
        await settle();
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
    });

    test("avisa no log e o player abre direto dentro da janela, sem a moldura do Discord", async () => {
        openViewer(PEER);
        await settle();
        assert.equal(PopoutActions.opened.length, 1);
        assert.ok(warnings().some(w => w.startsWith("Componente PopoutWindow do Discord não encontrado")), warnings().join("|"));

        render(<>{PopoutActions.opened[0].render() as ReactNode}</>);
        await settle();
        assert.ok(screen.getByRole("button", { name: "Parar de assistir" }), "o player esta la mesmo assim");
        assertAbsent(document.querySelector("[data-popout-window]"));
        assert.equal(document.title, "Alguém — Telinha", "o titulo da janela fica por conta do player");
    });

    test("a procura nao se repete: a segunda janela nao avisa de novo", async () => {
        openViewer(PEER);
        await settle();
        closeViewer(PEER);
        await settle();
        loggerLines.length = 0;

        openViewer("peerB");
        await settle();
        assert.equal(PopoutActions.opened.length, 2);
        assert.deepEqual(warnings().filter(w => /PopoutWindow/.test(w)), []);
        assert.equal(PopoutActions.opened[1].key, "DISCORD_TELINHA_VIEWER_peerB");
    });
});
