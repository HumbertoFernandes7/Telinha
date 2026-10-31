/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do estado observavel (store.ts): setState/subscribe/useTelinhaState, o buffer de eventos e o texto do
// "Copiar diagnóstico" (formatDiagnostics) com todos os campos.
// Rodar:  pnpm test:file src/plugins/telinha/store.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { act, renderHook } from "@test/fakes/render";

import { formatDiagnostics, getEventLog, getState, pushEvent, resetState, setState, subscribe, subscribeEvents, useTelinhaState } from "./store";
import type { TelinhaState } from "./types";

const BASE: TelinhaState = { inRoom: false, channelId: null, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

describe("estado", () => {
    afterEach(() => resetState());

    test("comeca vazio e congelado; setState avisa quem assina, o mesmo objeto nao", () => {
        const initial = getState();
        assert.deepEqual(initial, BASE);
        assert.ok(Object.isFrozen(initial));

        let calls = 0;
        const unsubscribe = subscribe(() => calls++);
        setState(initial);
        assert.equal(calls, 0, "o mesmo objeto nao e mudanca");

        const next = { ...BASE, inRoom: true };
        setState(next);
        assert.equal(getState(), next);
        assert.equal(calls, 1);

        unsubscribe();
        setState({ ...BASE });
        assert.equal(calls, 1, "depois de cancelar a assinatura nao avisa mais");

        resetState();
        assert.equal(getState(), initial, "resetState volta ao objeto inicial");
    });

    test("um ouvinte que lanca nao impede os outros (o erro vai para o console)", t => {
        const errors = t.mock.method(console, "error", () => { });
        let ok = 0;
        const a = subscribe(() => {
            throw new Error("ouvinte quebrado");
        });
        const b = subscribe(() => ok++);
        setState({ ...BASE, lastError: "x" });
        assert.equal(ok, 1);
        assert.equal(errors.mock.callCount(), 1);
        assert.equal(errors.mock.calls[0].arguments[0], "[Telinha] listener do estado falhou");
        a();
        b();
    });

    test("useTelinhaState re-renderiza com o estado novo", () => {
        const { result, unmount } = renderHook(() => useTelinhaState());
        assert.equal(result.current.inRoom, false);
        act(() => setState({ ...BASE, inRoom: true, channelId: "c1" }));
        assert.equal(result.current.inRoom, true);
        assert.equal(result.current.channelId, "c1");
        // desmonta antes do resetState do afterEach (senao a atualizacao cai fora do act)
        unmount();
    });
});

describe("eventos", () => {
    test("guarda os 400 mais recentes, mais antigo primeiro; getEventLog devolve uma copia", () => {
        for (let i = 0; i < 410; i++) pushEvent({ at: i, level: "info", msg: `e${i}` });
        const events = getEventLog();
        assert.equal(events.length, 400);
        assert.equal(events[0].msg, "e10");
        assert.equal(events.at(-1)?.msg, "e409");
        events.length = 0;
        assert.equal(getEventLog().length, 400);
    });

    test("subscribeEvents: cada evento novo, depois de entrar no buffer; um listener que lanca nao derruba os outros", t => {
        const error = t.mock.method(console, "error", () => { });
        const seen: string[] = [];
        const offBroken = subscribeEvents(() => {
            throw new Error("listener quebrado");
        });
        const off = subscribeEvents(e => seen.push(`${e.msg}:${getEventLog().at(-1)?.msg}`));
        pushEvent({ at: 1, level: "warn", msg: "um" });
        off();
        offBroken();
        pushEvent({ at: 2, level: "info", msg: "dois" });
        assert.deepEqual(seen, ["um:um"]);
        assert.equal(error.mock.callCount(), 1);
        assert.equal(error.mock.calls[0].arguments[0], "[Telinha] listener do log falhou");
    });
});

describe("formatDiagnostics", () => {
    afterEach(() => resetState());

    test("estado vazio: tudo como 'nenhum' / 'não'", () => {
        resetState();
        const text = formatDiagnostics();
        assert.match(text, /^Telinha — diagnóstico\ngerado: \d{4}-/);
        assert.match(text, /\nagente: .+\n/);
        assert.match(text, /na sala: não; canal: —; erro: —/);
        assert.match(text, /peers: nenhum/);
        assert.match(text, /transmitindo: não/);
        assert.match(text, /alertas de identidade: nenhum/);
        assert.match(text, /bloqueados: ninguém/);
        assert.match(text, /assistindo: nada/);
    });

    test("sem os campos opcionais (versao antiga do estado): listas vazias", () => {
        setState({ ...BASE, blocked: undefined, identityAlerts: undefined });
        const text = formatDiagnostics();
        assert.match(text, /alertas de identidade: nenhum/);
        assert.match(text, /bloqueados: ninguém/);
    });

    test("todos os campos: peers, transmissao, alertas, bloqueados, assistindo e eventos por nivel", () => {
        pushEvent({ at: Date.UTC(2026, 9, 29, 12, 0, 1, 500), level: "error", msg: "deu ruim" });
        pushEvent({ at: Date.UTC(2026, 9, 29, 12, 0, 2), level: "warn", msg: "cuidado" });
        pushEvent({ at: Date.UTC(2026, 9, 29, 12, 0, 3), level: "info", msg: "tudo bem" });
        setState({
            inRoom: true,
            channelId: "500000000000000005",
            lastError: "erro visivel",
            peers: [
                { peerId: "p1", discordUserId: "1", username: "ana", streaming: false, admitted: false, duplicateIdentity: true, identity: "pending" },
                { peerId: "p2", discordUserId: "2", username: "bia", streaming: true, admitted: true, identity: "verified", blocked: "kicked", stream: { kind: "screen", title: "t", hasAudio: false, width: 1, height: 1, fps: 1, access: "password" } },
                { peerId: "p3", discordUserId: "3", username: "caio", streaming: true, admitted: true, identity: "unverified", blocked: "declined", stream: { kind: "window", title: "t", hasAudio: false, width: 1, height: 1, fps: 1 } },
                { peerId: "p4", discordUserId: "4", username: "duda", streaming: false, admitted: true, identity: "invalid", blocked: "tooManyAttempts" },
                { peerId: "p5", discordUserId: "5", username: "edu", streaming: false, admitted: true }
            ],
            local: {
                source: { id: "screen:0:0", name: "Tela", kind: "screen" },
                quality: "720p60",
                hasAudio: true,
                startedAt: 1,
                viewers: ["p2", "p3"],
                access: "approval"
            },
            viewing: {
                p2: { peerId: "p2", stream: null, status: "connecting", passwordPrompt: { attemptsLeft: 2, wrong: true } },
                p3: { peerId: "p3", stream: null, status: "connecting", checkingPassword: true },
                p4: { peerId: "p4", stream: null, status: "error", denied: "declined" },
                p5: { peerId: "p5abcdef", stream: null, status: "playing", stats: { width: 1280, height: 720, fps: 59, kbps: 4200 } }
            },
            blocked: [{ discordUserId: "9", username: "zeca", reason: "tooManyAttempts" }],
            identityAlerts: [
                { discordUserId: "1", username: "ana", peerIds: ["p1", "p9"], self: false },
                { discordUserId: "0", username: "eu", peerIds: ["x"], self: true },
                { discordUserId: "4", username: "duda", peerIds: ["p4"], self: false, kind: "fake" },
                { discordUserId: "2", username: "bia", peerIds: ["p8"], self: false, kind: "impostor" },
                { discordUserId: "3", username: "caio", peerIds: ["p7"], self: false, kind: "duplicate" }
            ]
        });
        const text = formatDiagnostics();
        assert.match(text, /na sala: sim; canal: 500000000000000005; erro: erro visivel/);
        assert.match(text, /peers: ana \(fora do canal\) \(identidade duplicada\) <conferindo>, bia <verificado> \[expulso\] \[transmitindo, acesso password\], caio <não verificado> \[recusado\] \[transmitindo\], duda <identidade falsa> \[errou a senha\], edu\n/);
        assert.match(text, /transmitindo: screen 720p60 com áudio, quem pode assistir: approval, espectadores: 2, pedidos pendentes: 0/);
        assert.match(text, /alertas de identidade: ana \(2 conexões\), diz ser você \(1 conexões\), duda \[prova falsa\] \(1 conexões\), bia \[não verificada x verificada\] \(1 conexões\), caio \(1 conexões\)/);
        assert.match(text, /bloqueados: zeca \(errou a senha\)/);
        assert.match(text, /assistindo: p2=connecting \(pedindo senha\), p3=connecting \(conferindo senha\), p4=error \[declined\], p5abcd=playing 1280x720@59 4200 kbps/);
        assert.match(text, /\neventos:\n/);
        assert.match(text, /12:00:01\.500 ERRO deu ruim/);
        assert.match(text, /12:00:02\.000 AVISO cuidado/);
        assert.match(text, /12:00:03\.000 tudo bem/);
    });

    test("transmissao sem audio e com pedidos pendentes", () => {
        setState({
            ...BASE,
            local: {
                source: { id: "window:1:0", name: "Jogo", kind: "window" },
                quality: "1080p30",
                hasAudio: false,
                startedAt: 1,
                viewers: [],
                access: "all",
                pendingViewers: [{ peerId: "p1", discordUserId: "1", username: "ana", expiresAt: 1 }]
            }
        });
        assert.match(formatDiagnostics(), /transmitindo: window 1080p30, quem pode assistir: all, espectadores: 0, pedidos pendentes: 1/);
    });

    test("sem navigator: agente '?'", t => {
        const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
        if (!desc?.configurable) {
            t.skip("navigator nao configuravel neste Node");
            return;
        }
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
        try {
            assert.match(formatDiagnostics(), /\nagente: \?\n/);
        } finally {
            Object.defineProperty(globalThis, "navigator", desc);
        }
    });
});
