/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes de quem passa pelo Teredo (core/teredoWatch.ts): o par em uso de cada conexao, lido das estatisticas, vira
// PeerEntry.teredo e RemotePeer.teredo (o aviso da UI e o "Copiar diagnóstico"); o log ganha uma linha por pessoa e lado
// por sessao, sem nenhum endereco. A leitura a cada 10 s pela sessao fica no fim (com a sessao de verdade).
// Rodar:  pnpm test:file src/plugins/telinha/core/teredoWatch.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { formatDiagnostics, getState } from "@plugins/telinha/store";
import { flushPromises } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { OTHER_ID } from "@test/fakes/vencord";
import type { FakeRTCPeerConnection, StatsEntry } from "@test/fakes/webrtc";
import { addStreamer, closeRoom, logMark, openRoom } from "@test/helpers/wpc-viewing";

import { rt } from "./context";
import { checkTeredoRoutes, resetTeredoWarnings, TEREDO_CHECK_MS, teredoLogText } from "./teredoWatch";

const TEREDO = "2001:0:4136:e378:8000:63bf:3fff:fdd2";
const V4 = "203.0.113.7";

/** As estatisticas de uma conexao com o par em uso entre `local` e `remote`. */
const pairStats = (local: string, remote: string): StatsEntry[] => [
    { id: "T", type: "transport", selectedCandidatePairId: "CP" },
    { id: "CP", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" },
    { id: "L", type: "local-candidate", candidateType: "host", address: local },
    { id: "R", type: "remote-candidate", candidateType: "srflx", address: remote }
];

let room: FakeRoom;

beforeEach(() => {
    room = openRoom();
    resetTeredoWarnings();
});

afterEach(() => closeRoom());

describe("checkTeredoRoutes", () => {
    test("este PC no Teredo: o estado e o diagnostico marcam, e o log da o passo a passo uma vez por sessao, sem endereco", async () => {
        const pc = addStreamer(room, "peerA");
        pc.stats = pairStats(TEREDO, V4);
        const lines = logMark();
        await checkTeredoRoutes();
        await flushPromises();
        assert.equal(rt.peers.get("peerA")?.teredo, "local");
        assert.equal(getState().peers.find(p => p.peerId === "peerA")?.teredo, "local");
        assert.match(formatDiagnostics(), /amigo.*\[rota via Teredo: este PC\]/);
        assert.deepEqual(lines(), [teredoLogText("amigo (peerA)", "local")]);
        assert.match(lines()[0], /netsh interface teredo set state disabled/);
        assert.doesNotMatch(lines().join("\n"), /2001|203\.0/);

        // saiu do Teredo: o estado limpa; voltou, ou os dois PCs: o log nao repete
        pc.stats = pairStats(V4, V4);
        await checkTeredoRoutes();
        await flushPromises();
        assert.equal(rt.peers.get("peerA")?.teredo, undefined);
        assert.equal(getState().peers.find(p => p.peerId === "peerA")?.teredo, undefined);
        pc.stats = pairStats(TEREDO, "2001::5ef5:79fd");
        await checkTeredoRoutes();
        assert.equal(rt.peers.get("peerA")?.teredo, "both");
        assert.equal(lines().length, 1);
        await checkTeredoRoutes();
        assert.equal(lines().length, 1, "sem mudanca: nada");
    });

    test("so o PC do amigo no Teredo: o log pede para ele desligar", async () => {
        const pc = addStreamer(room, "peerB", { discordUserId: OTHER_ID, username: "beto" });
        pc.stats = pairStats(V4, TEREDO);
        const lines = logMark();
        await checkTeredoRoutes();
        assert.deepEqual(lines(), ["A conexão com beto (peerB) passa pelo Teredo do PC dele (um túnel lento do Windows): peça para ele desligar (ele também recebe o aviso no Telinha dele)"]);
        assert.equal(TEREDO_CHECK_MS, 10_000);
    });

    test("sem conexao, conexao que ainda nao esta no ar, estatisticas que falham ou peer sem hello: nada quebra", async () => {
        addStreamer(room, "peerC");
        room.peers.delete("peerC");
        const notYet = addStreamer(room, "peerD");
        (notYet as FakeRTCPeerConnection).connectionState = "connecting";
        notYet.stats = pairStats(TEREDO, V4);
        const broken = addStreamer(room, "peerE");
        broken.stats = () => {
            throw new Error("getStats falhou");
        };
        const anon = addStreamer(room, "peerF", { noHello: true });
        anon.stats = pairStats(TEREDO, V4);
        const lines = logMark();
        await checkTeredoRoutes();
        assert.deepEqual(lines(), [], "o sem hello fica marcado, mas sem linha (nao da para dizer quem)");
        assert.equal(rt.peers.get("peerD")?.teredo, undefined);
        assert.equal(rt.peers.get("peerF")?.teredo, "local");
    });

    test("a pessoa saiu no meio da leitura: o resultado e descartado", async () => {
        const pc = addStreamer(room, "peerA");
        pc.stats = async () => {
            rt.peers.delete("peerA");
            return pairStats(TEREDO, V4);
        };
        await checkTeredoRoutes();
        assert.equal(rt.peers.get("peerA"), undefined);
    });
});
