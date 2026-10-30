/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes de assistir uma transmissao COM SENHA (core/viewing.ts, passo 7 do protocolo): o transmissor responde
// { op: "password", nonce }, a UI mostra o campo (ViewerSession.passwordPrompt), submitPassword manda so a prova HMAC
// (nunca a senha), a senha que deu certo fica lembrada para ESTA transmissao e as recusas/erros a esquecem. A prova
// esperada e calculada aqui por fora, direto com crypto.subtle e a formula do protocolo, nao com computePasswordProof.
// Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.password.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { eventually, flushPromises, useFakeClock } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { FRIEND_ID, ME_ID } from "@test/fakes/vencord";
import { addStreamer, closeRoom, incomingStream, logMark, openRoom, receiveOn, viewerOf } from "@test/helpers/wpc-viewing";

import { clearAll, onPeerGone, onPeerStream, onPresence, onWatchReply, submitPassword, unwatch, watch } from "./viewing";

// nonces no formato do protocolo (base64url, 22 caracteres)
const N1 = "AAAAAAAAAAAAAAAAAAAAAA";
const N2 = "BBBBBBBBBBBBBBBBBBBBBB";
const N3 = "CCCCCCCCCCCCCCCCCCCCCC";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** base64url(HMAC-SHA256(chave = UTF-8 da senha, msg = "telinha-pw-v1|nonce|streamer|viewer")), como o protocolo escreve. */
async function expectedProof(password: string, nonce: string) {
    const key = await crypto.subtle.importKey("raw", utf8(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, utf8(`telinha-pw-v1|${nonce}|${FRIEND_ID}|${ME_ID}`));
    return Buffer.from(mac).toString("base64url");
}

let room: FakeRoom;

beforeEach(() => {
    room = openRoom();
});

afterEach(() => {
    closeRoom();
});

const sent = () => room.sentOn("watch").map(m => m.data as { op: string; proof?: string; });
const proofs = () => sent().filter(m => m.proof !== undefined).map(m => m.proof);

/** Pede para assistir e o transmissor responde com um desafio. */
function challenged(nonce = N1, peerId = "peerA") {
    const pc = addStreamer(room, peerId);
    watch(peerId);
    onWatchReply(peerId, { op: "password", nonce });
    return pc;
}

describe("o desafio de senha", () => {
    test("a UI recebe o pedido de senha e o prazo de 20 s deixa de valer (a pessoa digita com calma)", async t => {
        const clock = useFakeClock(t);
        const lines = logMark();
        challenged();
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "connecting");
        assert.deepEqual(v?.passwordPrompt, { attemptsLeft: null, wrong: false });
        assert.equal(v?.checkingPassword, undefined);
        assert.ok(lines().some(l => /a transmissão é com senha/.test(l)));

        clock.tick(5 * 60_000);
        assert.equal((await viewerOf("peerA"))?.status, "connecting", "continua esperando a senha");
    });

    test("o desafio tira o 'aguardando aprovacao' e mostra quantas tentativas restam", async () => {
        addStreamer(room, "peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "pending" });
        assert.equal((await viewerOf("peerA"))?.awaitingApproval, true);

        onWatchReply("peerA", { op: "password", nonce: N1, attemptsLeft: 4 });
        const v = await viewerOf("peerA");
        assert.equal(v?.awaitingApproval, undefined);
        assert.deepEqual(v?.passwordPrompt, { attemptsLeft: 4, wrong: false });
    });

    test("desafio fora de hora (sessao ja em erro) e ignorado", async () => {
        addStreamer(room, "peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "denied", reason: "declined" });
        onWatchReply("peerA", { op: "password", nonce: N1 });
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.passwordPrompt, undefined);
    });
});

describe("digitar a senha", () => {
    test("manda so a prova HMAC (nunca a senha), com a senha normalizada, e mostra 'conferindo'", async () => {
        challenged(N1);
        assert.equal(submitPassword("peerA", "  segredo-12  "), true);
        await eventually(() => proofs().length === 1);

        assert.deepEqual(proofs(), [await expectedProof("segredo-12", N1)]);
        assert.ok(!JSON.stringify(room.sentOn("watch")).includes("segredo"), "a senha nao trafega");
        const v = await viewerOf("peerA");
        assert.equal(v?.checkingPassword, true);
        assert.equal(v?.passwordPrompt, undefined);
    });

    test("acentos: a mesma senha digitada decomposta (a + acento) ou composta gera a mesma prova", async () => {
        challenged(N1);
        assert.equal(submitPassword("peerA", "senha-á"), true);
        await eventually(() => proofs().length === 1);
        assert.deepEqual(proofs(), [await expectedProof("senha-á", N1)]);
    });

    test("recusa a digitacao quando nao ha pedido de senha ou a senha nao serve", async () => {
        assert.equal(submitPassword("peerA", "segredo"), false, "sem sessao");

        addStreamer(room, "peerA");
        watch("peerA");
        assert.equal(submitPassword("peerA", "segredo"), false, "o transmissor ainda nao pediu senha");

        onWatchReply("peerA", { op: "password", nonce: N1 });
        assert.equal(submitPassword("peerA", ""), false, "vazia");
        assert.equal(submitPassword("peerA", "   "), false, "so espacos");
        assert.equal(submitPassword("peerA", "x".repeat(65)), false, "longa demais");
        assert.equal((await viewerOf("peerA"))?.passwordPrompt?.wrong, false, "o campo continua la");
        assert.equal(sent().length, 1, "so o start do pedido");

        assert.equal(submitPassword("peerA", "x".repeat(64)), true, "64 e o limite");
    });

    test("depois de uma recusa (sessao em erro) a digitacao e recusada", async () => {
        challenged();
        onWatchReply("peerA", { op: "denied", reason: "declined" });
        assert.equal(submitPassword("peerA", "segredo"), false);
    });

    test("senha errada: o campo volta marcado com as tentativas que restam, e a proxima digitacao usa o desafio novo", async () => {
        const lines = logMark();
        challenged(N1);
        submitPassword("peerA", "errada");
        await eventually(() => proofs().length === 1);

        onWatchReply("peerA", { op: "password", nonce: N2, wrong: true, attemptsLeft: 3 });
        const v = await viewerOf("peerA");
        assert.deepEqual(v?.passwordPrompt, { attemptsLeft: 3, wrong: true });
        assert.equal(v?.checkingPassword, undefined);
        assert.ok(lines().some(l => /senha incorreta \(restam 3\)/.test(l)));

        submitPassword("peerA", "certa-42");
        await eventually(() => proofs().length === 2);
        assert.equal(proofs()[1], await expectedProof("certa-42", N2));
    });

    test("senha errada sem contagem de tentativas: o log nao inventa numero", async () => {
        const lines = logMark();
        challenged(N1);
        submitPassword("peerA", "errada");
        onWatchReply("peerA", { op: "password", nonce: N2, wrong: true });
        assert.deepEqual((await viewerOf("peerA"))?.passwordPrompt, { attemptsLeft: null, wrong: true });
        assert.ok(lines().some(l => /senha incorreta$/.test(l)));
    });

    test("desafio novo sem 'errada' (a prova chegou vencida): reenvia a mesma senha uma vez; na segunda pergunta de novo", async () => {
        challenged(N1);
        submitPassword("peerA", "segredo-12");
        await eventually(() => proofs().length === 1);

        onWatchReply("peerA", { op: "password", nonce: N2 });
        await eventually(() => proofs().length === 2);
        assert.equal(proofs()[1], await expectedProof("segredo-12", N2), "a mesma senha, para o desafio novo");
        assert.equal((await viewerOf("peerA"))?.checkingPassword, true, "a UI nem piscou");

        onWatchReply("peerA", { op: "password", nonce: N3 });
        const v = await viewerOf("peerA");
        assert.deepEqual(v?.passwordPrompt, { attemptsLeft: null, wrong: false }, "so uma tentativa automatica");
        assert.equal(proofs().length, 2);
    });

    test("sem resposta a senha em 20 s: erro e a prova que ainda estava sendo calculada nao sai", async t => {
        const clock = useFakeClock(t);
        const real = crypto.subtle.sign.bind(crypto.subtle);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        t.mock.method(crypto.subtle, "sign", async (...args: Parameters<SubtleCrypto["sign"]>) => {
            await gate;
            return real(...args);
        });
        challenged();
        submitPassword("peerA", "segredo-12");
        clock.tick(19_999);
        assert.equal((await viewerOf("peerA"))?.status, "connecting");
        clock.tick(1);
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.error, "O transmissor não respondeu à senha.");

        release();
        await flushPromises();
        await flushPromises();
        assert.deepEqual(proofs(), [], "a prova que chegou tarde nao e enviada");
    });

    test("o amigo saiu da sala entre o campo e o envio: erro claro, nada enviado", async () => {
        challenged();
        rt.peers.delete("peerA");
        assert.equal(submitPassword("peerA", "segredo-12"), true);
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.error, "Esse amigo não está mais na call.");
        assert.deepEqual(proofs(), []);
    });

    test("falha ao enviar a prova: erro com o motivo", async () => {
        challenged();
        room.makeAction("watch").sendImpl = data => ((data as { proof?: string; }).proof ? Promise.reject(new Error("sem canal")) : Promise.resolve());
        submitPassword("peerA", "segredo-12");
        await eventually(() => rt.viewing.get("peerA")?.status === "error");
        assert.equal((await viewerOf("peerA"))?.error, "Não foi possível enviar a senha: Error: sem canal");
    });

    test("a prova que ficou pronta depois de a sessao mudar (recusa, parar de assistir, senha trocada) nao sai", async t => {
        const real = crypto.subtle.sign.bind(crypto.subtle);
        const gates: (() => void)[] = [];
        let open = false;
        t.mock.method(crypto.subtle, "sign", async (...args: Parameters<SubtleCrypto["sign"]>) => {
            if (!open) await new Promise<void>(resolve => gates.push(resolve));
            return real(...args);
        });

        // 1) o transmissor recusou enquanto a prova era calculada
        challenged(N1, "peerA");
        submitPassword("peerA", "um");
        onWatchReply("peerA", { op: "denied", reason: "declined" });

        // 2) a pessoa parou de assistir
        challenged(N1, "peerB");
        submitPassword("peerB", "dois");
        unwatch("peerB");

        // 3) errou, digitou outra senha, e a prova da primeira ficou para tras
        challenged(N1, "peerC");
        submitPassword("peerC", "tres");
        onWatchReply("peerC", { op: "password", nonce: N2, wrong: true, attemptsLeft: 2 });
        submitPassword("peerC", "quatro");

        await eventually(() => gates.length === 4);
        open = true; // daqui em diante o expectedProof do proprio teste tambem passa
        for (const release of gates) release();
        await eventually(() => proofs().length === 1);
        await flushPromises();
        assert.deepEqual(proofs(), [await expectedProof("quatro", N2)], "so a ultima senha digitada, para o desafio dela");
        assert.equal(room.sentOn("watch", "peerA").filter(m => (m.data as { proof?: string; }).proof).length, 0);
        assert.equal(room.sentOn("watch", "peerB").filter(m => (m.data as { proof?: string; }).proof).length, 0);
    });
});

describe("a senha que deu certo fica lembrada para esta transmissao", () => {
    /** pede, digita a senha, o stream chega (a senha foi aceita) */
    async function accepted(password = "segredo-12", peerId = "peerA") {
        const pc = challenged(N1, peerId);
        submitPassword(peerId, password);
        await eventually(() => proofs().length >= 1);
        const incoming = incomingStream();
        receiveOn(pc, incoming.fake);
        onPeerStream(peerId, incoming.stream, undefined);
        const v = await viewerOf(peerId);
        assert.equal(v?.status, "waiting-first-frame");
        assert.equal(v?.checkingPassword, undefined, "o stream chegou: acabou de conferir");
        assert.equal(v?.passwordPrompt, undefined);
        return pc;
    }

    test("assistir de novo: o desafio e respondido sozinho, sem perguntar outra vez", async () => {
        await accepted();
        unwatch("peerA");
        const lines = logMark();
        const before = proofs().length;
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N2 });

        const v = await viewerOf("peerA");
        assert.equal(v?.passwordPrompt, undefined, "sem campo de senha");
        assert.equal(v?.checkingPassword, true);
        await eventually(() => proofs().length === before + 1);
        assert.equal(proofs().at(-1), await expectedProof("segredo-12", N2));
        assert.ok(lines().some(l => /usando a senha que já deu certo nela/.test(l)));
    });

    test("o transmissor trocou a senha: a lembrada e esquecida e a pessoa e perguntada (agora e nas proximas)", async () => {
        await accepted();
        unwatch("peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N2 });
        await eventually(() => proofs().length === 2);

        onWatchReply("peerA", { op: "password", nonce: N3, wrong: true, attemptsLeft: 4 });
        assert.deepEqual((await viewerOf("peerA"))?.passwordPrompt, { attemptsLeft: 4, wrong: true });

        unwatch("peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N1 });
        assert.deepEqual((await viewerOf("peerA"))?.passwordPrompt, { attemptsLeft: null, wrong: false }, "nao ha mais senha lembrada");
    });

    test("recusa por senha errada vezes demais esquece a lembrada; uma recusa comum nao", async () => {
        await accepted();
        unwatch("peerA");

        // recusa comum antes de qualquer prova: a senha continua lembrada
        watch("peerA");
        onWatchReply("peerA", { op: "denied", reason: "declined" });
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N2 });
        assert.equal((await viewerOf("peerA"))?.checkingPassword, true, "continua lembrada");
        await eventually(() => proofs().length === 2);

        // tooManyAttempts: esquecida, mesmo com a prova vinda da memoria
        onWatchReply("peerA", { op: "denied", reason: "tooManyAttempts" });
        unwatch("peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N3 });
        assert.deepEqual((await viewerOf("peerA"))?.passwordPrompt, { attemptsLeft: null, wrong: false });
    });

    test("'errou a senha vezes demais' logo no pedido (sem ter usado a lembrada) tambem a esquece", async () => {
        await accepted();
        unwatch("peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "denied", reason: "tooManyAttempts" });
        assert.equal((await viewerOf("peerA"))?.denied, "tooManyAttempts");

        unwatch("peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N2 });
        assert.deepEqual((await viewerOf("peerA"))?.passwordPrompt, { attemptsLeft: null, wrong: false }, "pergunta de novo");
        assert.equal(proofs().length, 1, "nenhuma prova automatica");
    });

    test("uma recusa qualquer depois de usar a senha lembrada tambem a esquece (ela pode nao valer mais)", async () => {
        await accepted();
        unwatch("peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N2 });
        await eventually(() => proofs().length === 2);
        onWatchReply("peerA", { op: "denied", reason: "kicked" });

        unwatch("peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "password", nonce: N3 });
        assert.equal((await viewerOf("peerA"))?.passwordPrompt?.wrong, false);
        assert.equal((await viewerOf("peerA"))?.checkingPassword, undefined);
    });

    for (const [name, end] of [
        ["o amigo para de transmitir", () => onPresence("peerA", { v: 1, discordUserId: FRIEND_ID, username: "amigo", streaming: false, caps: { h264HwDecode: false } })],
        ["o amigo sai da call", () => onPeerGone("peerA")],
        ["o plugin sai da sala (clearAll)", () => clearAll()]
    ] as const) {
        test(`a lembrada acaba junto com a transmissao: ${name}`, async () => {
            await accepted();
            end();
            addStreamer(room, "peerA");
            unwatch("peerA");
            watch("peerA");
            onWatchReply("peerA", { op: "password", nonce: N2 });
            assert.deepEqual((await viewerOf("peerA"))?.passwordPrompt, { attemptsLeft: null, wrong: false }, "pergunta de novo");
        });
    }

    test("a senha lembrada e de cada transmissor: outro amigo com senha pergunta", async () => {
        await accepted("segredo-12", "peerA");
        challenged(N2, "peerB");
        assert.deepEqual((await viewerOf("peerB"))?.passwordPrompt, { attemptsLeft: null, wrong: false });
    });
});
