/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do estado mutavel do nucleo (core/context.ts): o snapshot que a UI recebe (peers, alertas de identidade,
// bloqueios, pedidos pendentes, sessoes assistidas, transmissao local), publish() agrupado e os utilitarios.
// Com o Client ID real (o recurso de identidade ligado), como no plugin publicado.
// Rodar:  pnpm test:file src/plugins/telinha/core/context.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { buildHello } from "@plugins/telinha/protocol";
import { getState, resetState, subscribe } from "@plugins/telinha/store";
import { presence } from "@test/helpers/wpa-session";

import { blockOf, getPc, type LocalCapture, type PeerEntry, peerLabel, publish, rt, setLastError, type ViewerEntry } from "./context";

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

function peer(peerId: string, discordUserId: string, username: string, patch: Partial<PeerEntry> = {}): PeerEntry {
    return {
        peerId, hello: buildHello(discordUserId, username), presence: null, inVoice: true, incompatible: false, admitted: true,
        duplicate: false, impostor: false, claimsSelf: false, identity: "verified", identityChecking: false, identityCheckedAt: 0, ...patch
    };
}

function viewer(peerId: string, patch: Partial<ViewerEntry> = {}): ViewerEntry {
    return { peerId, status: "connecting", stream: null, requestedAt: 0, firstFrameAt: null, meter: null, requestCleanup: [], streamCleanup: [], ...patch };
}

function reset() {
    rt.room = null;
    rt.peers.clear();
    rt.viewing.clear();
    rt.blocked.clear();
    rt.pending.clear();
    rt.approved.clear();
    rt.local = null;
    rt.lastError = null;
    rt.channelId = null;
    resetState();
}

describe("snapshot (publish)", () => {
    afterEach(reset);

    test("vazio: fora da sala, nada listado", async () => {
        publish();
        await flush();
        assert.deepEqual(getState(), { inRoom: false, channelId: null, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] });
    });

    test("varias mudancas na mesma volta viram UM snapshot novo", async () => {
        let snapshots = 0;
        const off = subscribe(() => snapshots++);
        rt.channelId = "c1";
        publish();
        publish();
        setLastError("ops");
        await flush();
        off();
        assert.equal(snapshots, 1);
        assert.equal(getState().channelId, "c1");
        assert.equal(getState().lastError, "ops");
    });

    test("peers: so os compativeis e sem prova falsa, ordenados por nome; presenca, bloqueio e identidade", async () => {
        rt.room = { getPeers: () => ({}) } as unknown as typeof rt.room;
        rt.peers.set("pZ", peer("pZ", "1", "zeca", { presence: presence("1", "Zeca (presenca)", { streaming: true, stream: { kind: "window", title: "Jogo", hasAudio: true, width: 1280, height: 720, fps: 30, access: "approval" } }) }));
        rt.peers.set("pB", peer("pB", "2", "bia", { presence: presence("2", "bia", { streaming: true }), identity: "unverified", inVoice: false, admitted: false }));
        rt.peers.set("pA2", peer("pA2", "3", "ana", { identity: "pending" }));
        rt.peers.set("pA1", peer("pA1", "4", "ana"));
        rt.peers.set("pX", peer("pX", "5", "velho", { hello: null, incompatible: true }));
        rt.peers.set("pV", peer("pV", "6", "v2", { incompatible: true }));
        rt.blocked.set("2", { discordUserId: "2", username: "bia", peerIds: new Set(), reason: "declined" });
        rt.blocked.set("other", { discordUserId: "other", username: "?", peerIds: new Set(["pA1"]), reason: "kicked" });
        publish();
        await flush();

        const { peers, inRoom, blocked } = getState();
        assert.equal(inRoom, true);
        assert.deepEqual(peers.map(p => p.peerId), ["pA1", "pA2", "pB", "pZ"], "nome, depois peerId; incompativeis fora");
        assert.deepEqual(peers.find(p => p.peerId === "pZ"), {
            peerId: "pZ", discordUserId: "1", username: "Zeca (presenca)", streaming: true, admitted: true, inVoice: true, identity: "verified",
            stream: { kind: "window", title: "Jogo", hasAudio: true, width: 1280, height: 720, fps: 30, access: "approval" }
        });
        assert.deepEqual(peers.find(p => p.peerId === "pB"), {
            peerId: "pB", discordUserId: "2", username: "bia", streaming: true, admitted: false, inVoice: false, blocked: "declined", identity: "unverified"
        }, "transmitindo sem dados do stream: sem `stream`");
        assert.equal(peers.find(p => p.peerId === "pA1")?.blocked, "kicked", "bloqueio pela conexao");
        assert.equal(peers.find(p => p.peerId === "pA2")?.identity, "pending");
        assert.deepEqual(blocked, [{ discordUserId: "2", username: "bia", reason: "declined" }, { discordUserId: "other", username: "?", reason: "kicked" }]);
    });

    test("alertas de identidade: diz ser voce, prova falsa, duplicada e impostora (uma por pessoa e tipo)", async () => {
        rt.peers.set("s1", peer("s1", "100000000000000001", "eu", { claimsSelf: true, incompatible: true }));
        rt.peers.set("s2", peer("s2", "100000000000000001", "eu", { claimsSelf: true, incompatible: true }));
        rt.peers.set("f1", peer("f1", "7", "falso", { identity: "invalid" }));
        rt.peers.set("d1", peer("d1", "8", "dup", { duplicate: true, identity: "unverified" }));
        rt.peers.set("d2", peer("d2", "8", "dup", { duplicate: true, identity: "unverified", presence: presence("8", "dup (presenca)") }));
        rt.peers.set("i1", peer("i1", "9", "imp", { duplicate: true, impostor: true, identity: "unverified" }));
        rt.peers.set("v1", peer("v1", "9", "imp"));
        publish();
        await flush();

        const { identityAlerts, peers } = getState();
        assert.deepEqual(identityAlerts, [
            { discordUserId: "100000000000000001", username: "eu", peerIds: ["s1", "s2"], self: true },
            { discordUserId: "7", username: "falso", peerIds: ["f1"], self: false, kind: "fake" },
            { discordUserId: "8", username: "dup", peerIds: ["d1", "d2"], self: false },
            { discordUserId: "9", username: "imp", peerIds: ["i1"], self: false, kind: "impostor" }
        ]);
        assert.deepEqual(peers.map(p => p.peerId), ["d1", "d2", "i1", "v1"], "prova falsa e 'diz ser voce' fora da lista");
        assert.equal(peers.find(p => p.peerId === "d1")?.duplicateIdentity, true);
        assert.equal(peers.find(p => p.peerId === "v1")?.duplicateIdentity, undefined);
    });

    test("transmissao local com pedidos pendentes (identidade so de quem esta na sala)", async () => {
        const stream = {} as MediaStream;
        const local: LocalCapture = {
            stream, source: { id: "screen:0:0", name: "Tela", kind: "screen" }, quality: "1080p60",
            info: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60 },
            startedAt: 123, viewers: new Set(["pA"]), access: "password", password: "segredo"
        };
        rt.local = local;
        rt.peers.set("pP", peer("pP", "2", "bia", { identity: "unverified" }));
        const timer = setTimeout(() => { }, 0);
        rt.pending.set("pP", { peerId: "pP", discordUserId: "2", username: "bia", expiresAt: 999, timer });
        rt.pending.set("gone", { peerId: "gone", discordUserId: "3", username: "caio", expiresAt: 1000, timer });
        publish();
        await flush();
        assert.deepEqual(getState().local, {
            source: local.source, quality: "1080p60", hasAudio: true, startedAt: 123, viewers: ["pA"], autoQuality: null, captureWarning: null, access: "password",
            pendingViewers: [
                { peerId: "pP", discordUserId: "2", username: "bia", expiresAt: 999, identity: "unverified" },
                { peerId: "gone", discordUserId: "3", username: "caio", expiresAt: 1000 }
            ]
        });
        assert.equal(JSON.stringify(getState()).includes("segredo"), false, "a senha nunca vai para a UI");

        local.autoQuality = { current: "720p60", reason: "cpu", reasonText: "x", viewers: {} };
        local.captureWarning = "tela preta";
        publish();
        await flush();
        assert.equal(getState().local?.autoQuality?.current, "720p60");
        assert.equal(getState().local?.captureWarning, "tela preta");
        clearTimeout(timer);
    });

    test("sessoes assistidas: so os campos que valem para o status atual", async () => {
        const stream = {} as MediaStream;
        rt.viewing.set("a", viewer("a", { awaitingApproval: true }));
        rt.viewing.set("b", viewer("b", { status: "error", error: "recusado", denied: "declined", awaitingApproval: true }));
        rt.viewing.set("c", viewer("c", { challenge: { nonce: "n".repeat(22), attemptsLeft: 2, wrong: true }, proofPassword: "x" }));
        rt.viewing.set("d", viewer("d", { challenge: null, proofPassword: "x" }));
        rt.viewing.set("e", viewer("e", { status: "playing", stream, stats: { width: 1, height: 2, fps: 3, kbps: 4 }, denied: "declined", challenge: { nonce: "n", attemptsLeft: null, wrong: false } }));
        publish();
        await flush();
        const { viewing } = getState();
        assert.deepEqual(viewing.a, { peerId: "a", stream: null, status: "connecting", awaitingApproval: true });
        assert.deepEqual(viewing.b, { peerId: "b", stream: null, status: "error", error: "recusado", denied: "declined" });
        assert.deepEqual(viewing.c, { peerId: "c", stream: null, status: "connecting", passwordPrompt: { attemptsLeft: 2, wrong: true } });
        assert.deepEqual(viewing.d, { peerId: "d", stream: null, status: "connecting", checkingPassword: true });
        assert.deepEqual(viewing.e, { peerId: "e", stream, status: "playing", stats: { width: 1, height: 2, fps: 3, kbps: 4 } });
        assert.notEqual(viewing.e.stats, rt.viewing.get("e")!.stats, "estatisticas copiadas");
    });
});

describe("utilitarios", () => {
    afterEach(reset);

    test("blockOf: pelo discordUserId anunciado ou pela conexao; nada = null", () => {
        const byUser = { discordUserId: "1", username: "a", peerIds: new Set<string>(), reason: "kicked" as const };
        const byPeer = { discordUserId: "2", username: "b", peerIds: new Set(["pX"]), reason: "declined" as const };
        rt.blocked.set("1", byUser);
        rt.blocked.set("2", byPeer);
        assert.equal(blockOf("p1", "1"), byUser);
        assert.equal(blockOf("pX", "999"), byPeer);
        assert.equal(blockOf("pX", undefined), byPeer);
        assert.equal(blockOf("p3", "3"), null);
        assert.equal(blockOf("p3", undefined), null);
    });

    test("peerLabel: nome da presenca, senao do hello, senao so o id curto", () => {
        rt.peers.set("peerAAAA", peer("peerAAAA", "1", "do hello"));
        assert.equal(peerLabel("peerAAAA"), "do hello (peerAA)");
        rt.peers.get("peerAAAA")!.presence = presence("1", "da presenca");
        assert.equal(peerLabel("peerAAAA"), "da presenca (peerAA)");
        rt.peers.set("peerBBBB", peer("peerBBBB", "2", "x", { hello: null }));
        assert.equal(peerLabel("peerBBBB"), "peerBB");
        assert.equal(peerLabel("desconhecido"), "descon");
    });

    test("getPc: a conexao da sala; sem sala, peer desconhecido ou getPeers lancando: null", () => {
        assert.equal(getPc("p1"), null);
        const pc = {} as RTCPeerConnection;
        rt.room = { getPeers: () => ({ p1: pc }) } as unknown as typeof rt.room;
        assert.equal(getPc("p1"), pc);
        assert.equal(getPc("p2"), null);
        rt.room = {
            getPeers: () => {
                throw new Error("sala fechada");
            }
        } as unknown as typeof rt.room;
        assert.equal(getPc("p1"), null);
    });

    test("setLastError publica a mensagem (e null limpa)", async () => {
        setLastError("algo deu errado");
        assert.equal(rt.lastError, "algo deu errado");
        await flush();
        assert.equal(getState().lastError, "algo deu errado");
        setLastError(null);
        await flush();
        assert.equal(getState().lastError, null);
    });
});
