/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes de "Quem pode assistir" no transmissor (core/streaming.ts): os 4 modos (todos da call, so amigos, so quem eu
// aprovar, com senha), Permitir/Recusar/Expulsar/Liberar, o pedido que expira em 60 s, trocar o modo no ar, a senha de
// ponta a ponta (desafio, prova feita com computePasswordProof como o espectador faz, tentativas, provas velhas) e a
// identidade duplicada. A decisao em si (core/access.ts → decideWatch) tem os proprios testes; aqui e o que o
// espectador recebe na acao "watch" e o que a transmissao manda. A verificacao da identidade do Discord e da sessao
// (WP-A): onde o teste precisa de um espectador "verificado", o resultado dela e escrito direto em rt.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.access.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test, type TestContext } from "node:test";

import { getState } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { ME_ID, pluginSettings, RelationshipStore } from "@test/fakes/vencord";
import {
    connectViewer, createRig, destroyRig, enterCall, logMark, removalsFrom, repliesTo, screenOptions, seconds, setMembers, type StreamingRig,
    streamsTo, turns, windowOptions
} from "@test/helpers/wpb-streaming";

import { computePasswordProof } from "./access";
import { rt } from "./context";
import {
    APPROVAL_TIMEOUT_MS, approveViewer, declineViewer, getStreamAccess, getStreamPassword, kickViewer, onApprovalPolicyChanged, reviewPendingApprovals,
    setStreamAccess, startStreaming, stopStreaming, unblockViewer
} from "./streaming";

const PASSWORD = "pipoca-42";

let rig: StreamingRig;
let seq = 0;

/** Um espectador novo na call (peerId e discordUserId unicos no arquivo). */
async function viewer(name: string, opts: { verified?: boolean; presence?: boolean; } = {}) {
    seq++;
    const peerId = `p${name}`;
    const discordUserId = String(900_000_000_000_000_000n + BigInt(seq));
    await connectViewer(rig, peerId, discordUserId, name, { presence: opts.presence });
    // resultado da prova de identidade (session.ts → applyPeerIdentity), que estes testes nao refazem
    if (opts.verified) rt.peers.get(peerId)!.identity = "verified";
    return { peerId, discordUserId, label: `${name} (${peerId.slice(0, 6)})` };
}

type Viewer = Awaited<ReturnType<typeof viewer>>;

const ask = (v: Viewer, proof?: string) => rig.room.receive("watch", proof ? { op: "start", proof } : { op: "start" }, v.peerId);
const stopAsking = (v: Viewer) => rig.room.receive("watch", { op: "stop" }, v.peerId);
const lastReply = (v: Viewer) => repliesTo(rig.room, v.peerId).at(-1);
const watching = (v: Viewer) => !!rt.local?.viewers.has(v.peerId);
const pendingIds = () => [...rt.pending.keys()];

/** A prova da senha para o ultimo desafio que `v` recebeu (o que o Telinha do espectador calcula). */
async function proofFor(v: Viewer, password = PASSWORD) {
    const { nonce } = lastReply(v);
    return computePasswordProof({ password, nonce, streamerId: ME_ID, viewerId: v.discordUserId });
}

/** Manda a prova e espera a resposta (a conferencia e assincrona: crypto.subtle). */
async function sendProof(v: Viewer, proof: string) {
    const replies = repliesTo(rig.room, v.peerId).length;
    const sent = streamsTo(rig.room, v.peerId).length;
    ask(v, proof);
    await eventually(() => repliesTo(rig.room, v.peerId).length > replies || streamsTo(rig.room, v.peerId).length > sent);
}

/**
 * Para o teste que mexe no estado ENQUANTO a prova e conferida e depois confere que nada aconteceu (sem resposta para
 * esperar). A conferencia (core/access.ts → verifyPasswordProof) termina num HMAC de crypto.subtle, que roda na
 * threadpool do libuv em TEMPO REAL: nenhum numero fixo de turns() garante que ela acabou (no CI com cobertura, sob
 * carga, 30 nao bastaram e a assercao rodou antes dela). Conta cada HMAC que termina neste teste e devolve
 * `whileChecking(n, act)`: faz `act` (que manda `n` provas) e espera os `n` HMACs delas terminarem. Depois do HMAC o
 * transmissor so tem microtasks, entao o que ele faz com a prova ja aconteceu quando a espera acaba.
 */
function trackProofChecks(t: TestContext) {
    let finished = 0;
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    t.mock.method(crypto.subtle, "sign", (...args: Parameters<SubtleCrypto["sign"]>) => sign(...args).finally(() => finished++));
    return async (n: number, act: () => void) => {
        const before = finished;
        act();
        await eventually(() => finished >= before + n);
    };
}

before(async () => {
    rig = createRig();
    await enterCall(rig, []);
});

after(() => destroyRig(rig));

afterEach(() => {
    stopStreaming();
    pluginSettings.set("requireVerifiedIdentity", true);
    rig.room.actions.get("watch")!.sendImpl = null;
});

describe("Todos da call, Permitir e Recusar", () => {
    test("nao verificado com 'Exigir identidade verificada': espera Permitir; verificado entra direto", async () => {
        const ana = await viewer("ana");
        const bia = await viewer("bia", { verified: true });
        await startStreaming(screenOptions({ access: "all" }));
        const since = logMark();

        ask(ana);
        assert.deepEqual(lastReply(ana), { op: "pending" });
        await turns(1);
        const [pending] = getState().local!.pendingViewers!;
        assert.deepEqual({ ...pending, expiresAt: undefined }, { peerId: ana.peerId, discordUserId: ana.discordUserId, username: "ana", expiresAt: undefined, identity: "unverified" });
        assert.equal(pending.expiresAt, rig.clock.epoch() + APPROVAL_TIMEOUT_MS);

        // pedir de novo esperando: a mesma resposta, um pedido so
        ask(ana);
        assert.deepEqual(repliesTo(rig.room, ana.peerId), [{ op: "pending" }, { op: "pending" }]);
        assert.deepEqual(pendingIds(), [ana.peerId]);

        ask(bia);
        assert.equal(streamsTo(rig.room, bia.peerId).length, 1, "verificada: sem esperar");
        assert.deepEqual(repliesTo(rig.room, bia.peerId), []);

        assert.equal(approveViewer(ana.peerId), true);
        assert.equal(streamsTo(rig.room, ana.peerId).length, 1);
        assert.deepEqual(pendingIds(), []);
        assert.equal(approveViewer(ana.peerId), false, "ja nao esta pendente");
        assert.deepEqual(since().filter(l => !l.startsWith("Enviando") && !l.startsWith("Envio")), [
            `${ana.label} (discord ${ana.discordUserId}) pediu para assistir sem identidade verificada: esperando a sua aprovação`,
            `Você permitiu ${ana.label} assistir`
        ]);
    });

    test("Recusar: responde 'declined' e bloqueia so ate esta transmissao acabar", async () => {
        const caio = await viewer("caio", { presence: false });
        await startStreaming(screenOptions({ access: "approval" }));
        const since = logMark();
        ask(caio);
        await turns(1);
        assert.equal(getState().local!.pendingViewers![0].username, "caio", "sem presenca: o nome do handshake");
        assert.ok(since().includes(`${caio.label} (discord ${caio.discordUserId}) pediu para assistir: esperando a sua aprovação`), "no modo aprovacao, sem falar de identidade");

        assert.equal(declineViewer(caio.peerId), true);
        assert.deepEqual(lastReply(caio), { op: "denied", reason: "declined" });
        await turns(1);
        assert.deepEqual(getState().blocked, [{ discordUserId: caio.discordUserId, username: "caio", reason: "declined" }]);
        assert.equal(declineViewer(caio.peerId), false, "ja nao esta pendente");

        ask(caio);
        assert.deepEqual(lastReply(caio), { op: "denied", reason: "declined" });
        assert.ok(since().includes(`${caio.label} pediu para assistir, mas foi recusado por você nesta transmissão: recusado`));

        // transmissao nova: pode pedir de novo
        stopStreaming();
        await turns(1);
        assert.deepEqual(getState().blocked, []);
        await startStreaming(screenOptions({ access: "approval" }));
        ask(caio);
        assert.deepEqual(lastReply(caio), { op: "pending" });
    });

    test("pedido sem resposta por 60 s: recusado sozinho ('timeout'), e pode pedir de novo", async () => {
        const duda = await viewer("duda");
        await startStreaming(screenOptions({ access: "approval" }));
        ask(duda);
        const since = logMark();
        await seconds(rig, 59);
        assert.deepEqual(pendingIds(), [duda.peerId]);
        await seconds(rig, 1);
        assert.deepEqual(pendingIds(), []);
        assert.deepEqual(lastReply(duda), { op: "denied", reason: "timeout" });
        assert.ok(since().includes(`Pedido de ${duda.label} para assistir não foi respondido em 60 s: recusado (pode pedir de novo)`));
        await turns(1);
        assert.deepEqual(getState().local?.pendingViewers, []);
        assert.deepEqual(getState().blocked, [], "expirar nao bloqueia");

        ask(duda);
        assert.deepEqual(lastReply(duda), { op: "pending" });
    });

    test("quem desiste do pedido pendente: o pedido some sem resposta", async () => {
        const eva = await viewer("eva");
        await startStreaming(screenOptions({ access: "approval" }));
        ask(eva);
        const since = logMark();
        stopAsking(eva);
        assert.deepEqual(pendingIds(), []);
        assert.deepEqual(repliesTo(rig.room, eva.peerId), [{ op: "pending" }]);
        assert.deepEqual(since(), [`${eva.label} desistiu do pedido para assistir`]);
    });

    test("resposta que nao chega ao espectador: so vira aviso no log", async () => {
        const fred = await viewer("fred");
        await startStreaming(screenOptions({ access: "approval" }));
        rig.room.actions.get("watch")!.sendImpl = () => Promise.reject(new Error("canal fechado"));
        const since = logMark();
        ask(fred);
        await turns();
        assert.ok(since().includes(`Falha ao responder ${fred.label}: Error: canal fechado`));
        assert.deepEqual(pendingIds(), [fred.peerId], "o pedido continua valendo");
    });
});

describe("Expulsar e Liberar", () => {
    test("expulsar quem assiste: para agora, vale ate sair da call (mesmo em outra transmissao); Liberar devolve", async () => {
        pluginSettings.set("requireVerifiedIdentity", false);
        const gil = await viewer("gil");
        await startStreaming(screenOptions());
        ask(gil);
        assert.ok(watching(gil));
        const since = logMark();

        assert.equal(kickViewer(gil.peerId), true);
        assert.deepEqual(lastReply(gil), { op: "denied", reason: "kicked" });
        assert.equal(removalsFrom(rig.room, gil.peerId).length, 1);
        assert.equal(watching(gil), false);
        await turns(1);
        assert.deepEqual(getState().blocked, [{ discordUserId: gil.discordUserId, username: "gil", reason: "kicked" }]);
        assert.ok(since().includes(`${gil.label} (discord ${gil.discordUserId}) foi expulso por você: não recebe a sua transmissão até você sair da call`));

        // outra transmissao: continua expulso
        stopStreaming();
        await startStreaming(screenOptions());
        ask(gil);
        assert.deepEqual(lastReply(gil), { op: "denied", reason: "kicked" });

        assert.equal(unblockViewer(gil.discordUserId), true);
        assert.ok(since().includes(`Você liberou de novo gil (discord ${gil.discordUserId}) para pedir para assistir`));
        assert.equal(unblockViewer(gil.discordUserId), false, "ja liberado");
        ask(gil);
        assert.ok(watching(gil));
        assert.equal(kickViewer("ninguem"), false, "conexao desconhecida");
    });

    test("expulsar quem esta pendente: o pedido some com 'kicked'; recusado e depois expulso fica expulso", async () => {
        const hugo = await viewer("hugo");
        const iris = await viewer("iris");
        await startStreaming(screenOptions({ access: "approval" }));
        ask(hugo);
        assert.equal(kickViewer(hugo.peerId), true);
        assert.deepEqual(repliesTo(rig.room, hugo.peerId), [{ op: "pending" }, { op: "denied", reason: "kicked" }], "uma resposta so");
        assert.deepEqual(pendingIds(), []);

        ask(iris);
        declineViewer(iris.peerId);
        kickViewer(iris.peerId);
        await turns(1);
        assert.equal(getState().blocked?.find(b => b.discordUserId === iris.discordUserId)?.reason, "kicked", "o motivo mais forte vence");
        stopStreaming();
        await turns(1);
        assert.deepEqual(getState().blocked?.map(b => b.reason), ["kicked", "kicked"], "expulsao continua depois da transmissao");
        unblockViewer(hugo.discordUserId);
        unblockViewer(iris.discordUserId);
    });
});

describe("So meus amigos do Discord", () => {
    afterEach(() => {
        RelationshipStore.setFriends();
    });

    test("amigo verificado entra direto; nao amigo e nao verificado sao recusados, cada um com o motivo", async () => {
        const amigo = await viewer("amigo", { verified: true });
        const estranho = await viewer("estranho", { verified: true });
        const semProva = await viewer("semprova");
        RelationshipStore.setFriends(amigo.discordUserId, semProva.discordUserId);
        await startStreaming(screenOptions({ access: "friends" }));
        const since = logMark();

        ask(amigo);
        assert.ok(watching(amigo));
        ask(estranho);
        assert.deepEqual(lastReply(estranho), { op: "denied", reason: "friendsOnly" });
        ask(semProva);
        assert.deepEqual(lastReply(semProva), { op: "denied", reason: "notVerified" });
        const lines = since();
        assert.ok(lines.includes(`${estranho.label} pediu para assistir, mas a transmissão é só para amigos e essa pessoa não é sua amiga no Discord: recusado`));
        assert.ok(lines.includes(`${semProva.label} pediu para assistir, mas a transmissão é só para amigos e essa pessoa não provou a identidade do Discord (não verificado): recusado`));
        assert.deepEqual(getState().blocked ?? [], [], "recusa por modo nao bloqueia");
    });

    test("RelationshipStore quebrado: ninguem e tratado como amigo", async t => {
        const lia = await viewer("lia", { verified: true });
        RelationshipStore.setFriends(lia.discordUserId);
        t.mock.method(RelationshipStore, "isFriend", () => {
            throw new Error("store indisponivel");
        });
        await startStreaming(screenOptions({ access: "friends" }));
        ask(lia);
        assert.deepEqual(lastReply(lia), { op: "denied", reason: "friendsOnly" });
    });
});

describe("Com senha", () => {
    test("desafio e prova certa: a senha nunca trafega, so a prova; acertou, recebe", async () => {
        const mel = await viewer("mel");
        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));
        const since = logMark();
        ask(mel);
        const challenge = lastReply(mel);
        assert.deepEqual({ ...challenge, nonce: undefined }, { op: "password", nonce: undefined, attemptsLeft: 5 });
        assert.match(challenge.nonce, /^[A-Za-z0-9_-]{22}$/);
        assert.ok(!JSON.stringify(rig.room.sent).includes(PASSWORD), "a senha nunca vai para a rede");

        await sendProof(mel, await proofFor(mel));
        assert.ok(watching(mel));
        assert.deepEqual(since().filter(l => !l.startsWith("Envio para")), [
            `${mel.label} pediu para assistir: a transmissão é com senha, pedindo a senha (restam 5 tentativas). `
            + "Se ele usa uma versão antiga do Telinha (v0.1.0), ela não entende o pedido de senha: o pedido dele expira sem resposta.",
            `${mel.label} acertou a senha`,
            `Enviando para ${mel.label}: codec VP9 (automático: o espectador não decodifica H.264 por hardware → VP9)`
        ]);

        // a mesma prova de novo (desafio ja usado) depois de parar: nao conta como erro, vai um desafio novo
        stopAsking(mel);
        await sendProof(mel, await proofFor(mel));
        assert.equal(watching(mel), false);
        assert.deepEqual({ ...lastReply(mel), nonce: undefined }, { op: "password", nonce: undefined, attemptsLeft: 5 });
        assert.notEqual(lastReply(mel).nonce, challenge.nonce);
    });

    test("senha errada: novo desafio com as tentativas que restam; na 5a, bloqueado ate a transmissao acabar", async () => {
        const nina = await viewer("nina");
        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));
        ask(nina);
        const since = logMark();
        for (const left of [4, 3, 2, 1]) {
            await sendProof(nina, await proofFor(nina, "senha-errada"));
            assert.deepEqual({ ...lastReply(nina), nonce: undefined }, { op: "password", nonce: undefined, attemptsLeft: left, wrong: true });
        }
        await sendProof(nina, await proofFor(nina, "senha-errada"));
        assert.deepEqual(lastReply(nina), { op: "denied", reason: "tooManyAttempts" });
        await turns(1);
        assert.deepEqual(getState().blocked, [{ discordUserId: nina.discordUserId, username: "nina", reason: "tooManyAttempts" }]);
        assert.deepEqual(since().filter(l => l.includes("errou") || l.includes("bloqueado")), [
            `${nina.label} errou a senha (restam 4 tentativas)`,
            `${nina.label} errou a senha (restam 3 tentativas)`,
            `${nina.label} errou a senha (restam 2 tentativas)`,
            `${nina.label} errou a senha (resta 1 tentativa)`,
            `${nina.label} (discord ${nina.discordUserId}) foi bloqueado por errar a senha 5 vezes: não recebe a sua transmissão até esta transmissão acabar`
        ]);

        // bloqueada: pedir de novo so ouve o motivo
        ask(nina);
        assert.deepEqual(lastReply(nina), { op: "denied", reason: "tooManyAttempts" });
        // liberada: ganha as tentativas de novo
        unblockViewer(nina.discordUserId);
        ask(nina);
        assert.equal(lastReply(nina).attemptsLeft, 5);
        // e o bloqueio por senha acaba com a transmissao
        for (let i = 0; i < 5; i++) await sendProof(nina, await proofFor(nina, "senha-errada"));
        assert.deepEqual(lastReply(nina), { op: "denied", reason: "tooManyAttempts" });
        stopStreaming();
        await turns(1);
        assert.deepEqual(getState().blocked, []);
    });

    test("prova sem desafio valido (nunca pediu, ou o desafio venceu em 2 min): nao conta como erro, vai um desafio novo", async () => {
        const otto = await viewer("otto");
        const paty = await viewer("paty");
        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));

        // prova sem pedido antes: o Telinha dele lembrava a senha de outra transmissao
        await sendProof(otto, "A".repeat(43));
        assert.deepEqual({ ...lastReply(otto), nonce: undefined }, { op: "password", nonce: undefined, attemptsLeft: 5 });

        ask(paty);
        const proof = await proofFor(paty);
        await seconds(rig, 121);
        await sendProof(paty, proof);
        assert.equal(watching(paty), false);
        assert.deepEqual({ ...lastReply(paty), nonce: undefined }, { op: "password", nonce: undefined, attemptsLeft: 5 }, "nem entrou, nem perdeu tentativa");
    });

    test("o modo ou a senha mudam enquanto a prova e conferida: a prova vira um pedido novo com a regra nova", async () => {
        const rui = await viewer("rui");
        const sol = await viewer("sol");
        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));

        // senha trocada no meio: a prova (certa para a senha antiga) nao vale; desafio novo, sem contar erro
        ask(rui);
        const replies = repliesTo(rig.room, rui.peerId).length;
        ask(rui, await proofFor(rui));
        setStreamAccess("password", "outra-senha");
        await eventually(() => repliesTo(rig.room, rui.peerId).length > replies);
        assert.equal(watching(rui), false);
        assert.deepEqual({ ...lastReply(rui), nonce: undefined }, { op: "password", nonce: undefined, attemptsLeft: 5 });
        assert.equal(getStreamPassword(), "outra-senha");

        // modo trocado no meio para "so quem eu aprovar": vira pedido pendente
        ask(sol);
        const solProof = await proofFor(sol, "outra-senha");
        const solReplies = repliesTo(rig.room, sol.peerId).length;
        ask(sol, solProof);
        setStreamAccess("approval");
        await eventually(() => repliesTo(rig.room, sol.peerId).length > solReplies);
        assert.deepEqual(lastReply(sol), { op: "pending" });
        assert.equal(getStreamPassword(), null, "sem modo senha, sem senha");
    });

    test("a transmissao acaba, o espectador sai da sala ou da call enquanto a prova e conferida: nada e enviado", async t => {
        const whileChecking = trackProofChecks(t);
        const tito = await viewer("tito");
        const ugo = await viewer("ugo");
        const vivi = await viewer("vivi");
        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));
        ask(tito);
        const titoProof = await proofFor(tito);
        const titoReplies = repliesTo(rig.room, tito.peerId).length;
        const since = logMark();

        await whileChecking(1, () => {
            ask(tito, titoProof);
            stopStreaming();
        });
        assert.equal(repliesTo(rig.room, tito.peerId).length, titoReplies, "nenhuma resposta nova");
        assert.equal(streamsTo(rig.room, tito.peerId).length, 0);

        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));
        ask(ugo);
        ask(vivi);
        const [ugoProof, viviProof] = await Promise.all([proofFor(ugo), proofFor(vivi)]);
        await whileChecking(2, () => {
            ask(ugo, ugoProof);
            rig.room.disconnectPeer(ugo.peerId);
            ask(vivi, viviProof);
            setMembers(rig, [...rig.members].filter(id => id !== vivi.discordUserId)); // saiu do canal de voz: nao esta mais admitido
        });
        assert.equal(streamsTo(rig.room, ugo.peerId).length, 0);
        assert.equal(streamsTo(rig.room, vivi.peerId).length, 0);
        assert.ok(since().includes(`${vivi.label} pediu para assistir, mas não está admitido: ignorado`));
    });

    // trocar de fonte com uma escolha nova de "Quem pode assistir" (startStreaming com `access` e uma transmissao no ar)
    // vale como setStreamAccess. Antes da correcao a prova feita com a senha antiga para um desafio antigo contava como
    // ERRO na senha nova, e os erros e pedidos pendentes atravessavam a troca. A UI de hoje nao passa `access` ao
    // trocar de fonte (SourcePickerModal), entao so a API chegava aqui.
    test("trocar de fonte com outra senha: a prova de um desafio antigo vira desafio novo, sem contar erro (como em setStreamAccess)", async () => {
        const ari = await viewer("ari");
        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));
        ask(ari);
        await sendProof(ari, await proofFor(ari, "errada-1")); // 1 erro com a senha antiga
        assert.equal(lastReply(ari).attemptsLeft, 4);
        const proof = await proofFor(ari); // a senha antiga, para o desafio antigo
        await startStreaming(screenOptions({ access: "password", password: "senha-nova" }));
        await sendProof(ari, proof);
        assert.deepEqual({ ...lastReply(ari), nonce: undefined }, { op: "password", nonce: undefined, attemptsLeft: 5 }, "desafio novo, erros zerados");
        assert.equal(watching(ari), false);
    });

    test("trocar de fonte com outro modo: quem espera aprovacao e decidido de novo; quem assiste continua e fica aprovado", async () => {
        const bela = await viewer("bela", { verified: true });
        const davi = await viewer("davi", { verified: true });
        await startStreaming(screenOptions({ access: "approval" }));
        ask(davi);
        approveViewer(davi.peerId);
        ask(bela);
        assert.deepEqual(pendingIds(), [bela.peerId]);

        await startStreaming(windowOptions({ access: "all" }));
        assert.deepEqual(pendingIds(), [], "verificada e 'Todos da call': nao precisa mais de Permitir");
        assert.ok(watching(bela));
        assert.ok(watching(davi));
        assert.ok(rt.approved.has(davi.peerId));
    });

    test("a mesma senha chegando duas vezes (clique duplo): o stream vai uma vez so", async t => {
        const whileChecking = trackProofChecks(t);
        const zoe = await viewer("zoe");
        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));
        // desafios previsiveis: pedindo de novo antes da resposta, ele recebe o mesmo nonce, e as duas provas
        // chegam antes de a primeira ser conferida
        t.mock.method(crypto, "getRandomValues", <T extends ArrayBufferView | null>(array: T): T => {
            if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
            return array;
        });
        ask(zoe);
        const proof = await proofFor(zoe);
        // as duas conferencias acabam antes de contar (a segunda nao pode mandar outro stream, nem chegar no teste seguinte)
        await whileChecking(2, () => {
            ask(zoe, proof);
            ask(zoe);
            ask(zoe, proof);
        });
        assert.equal(streamsTo(rig.room, zoe.peerId).length, 1);
        assert.ok(watching(zoe));
        assert.equal(repliesTo(rig.room, zoe.peerId).filter(r => r.op !== "password").length, 0, "nenhuma recusa");
    });

    test("prova fora do modo senha: vale como um pedido comum; quem para de assistir com desafio pendente perde o desafio", async () => {
        const xuxa = await viewer("xuxa");
        const yara = await viewer("yara");
        await startStreaming(screenOptions({ access: "approval" }));
        ask(xuxa, "A".repeat(43));
        assert.deepEqual(lastReply(xuxa), { op: "pending" });

        await startStreaming(screenOptions({ access: "password", password: PASSWORD }));
        ask(yara);
        const proof = await proofFor(yara);
        stopAsking(yara);
        await sendProof(yara, proof);
        assert.equal(watching(yara), false, "o desafio de antes do 'stop' nao vale mais");
        assert.equal(lastReply(yara).op, "password");
    });
});

describe("trocar o modo no ar e reavaliar pedidos", () => {
    test("setStreamAccess: validacao, nada muda com o mesmo modo, e o modo novo vale para pedidos novos", async () => {
        assert.throws(() => setStreamAccess("all"), { message: "Você não está transmitindo." });
        const zeca = await viewer("zeca");
        const alan = await viewer("alan");
        pluginSettings.set("requireVerifiedIdentity", false);
        await startStreaming(screenOptions({ access: "all" }));
        ask(zeca);
        assert.ok(watching(zeca));

        assert.throws(() => setStreamAccess("todos" as never), { message: "Opção de \"Quem pode assistir\" inválida." });
        assert.throws(() => setStreamAccess("password"), { message: "Digite ou gere uma senha para esta transmissão." });
        const presences = rig.room.sentOn("presence", zeca.peerId).length;
        const since = logMark();
        setStreamAccess("all");
        assert.deepEqual(since(), [], "mesmo modo: nada");
        assert.equal(rig.room.sentOn("presence", zeca.peerId).length, presences);

        setStreamAccess("approval");
        assert.equal(getStreamAccess(), "approval");
        assert.equal(rig.room.sentOn("presence", zeca.peerId).at(-1)?.data.stream.access, "approval", "a presenca anuncia o modo novo");
        assert.deepEqual(since(), ["Quem pode assistir agora: Só quem eu aprovar (vale para novos pedidos; quem já assiste continua)"]);
        assert.ok(watching(zeca), "quem ja assiste continua");
        ask(alan);
        assert.deepEqual(lastReply(alan), { op: "pending" }, "pedido novo segue o modo novo");

        // quem assistia quando o modo mudou fica aprovado: parar e pedir de novo entra direto
        stopAsking(zeca);
        ask(zeca);
        assert.ok(watching(zeca));

        // o pendente e decidido de novo: no modo senha, recebe o desafio
        setStreamAccess("password", PASSWORD);
        assert.deepEqual(pendingIds(), []);
        assert.equal(lastReply(alan).op, "password");
        assert.equal(getStreamPassword(), PASSWORD);

        setStreamAccess("password", "nova-senha");
        assert.ok(since().includes("Senha da transmissão trocada (vale para novos pedidos; quem já assiste continua)"));
        assert.equal(getStreamPassword(), "nova-senha");
    });

    test("desligar 'Exigir identidade verificada' com pedidos pendentes: os nao verificados entram", async () => {
        const bela = await viewer("bela");
        await startStreaming(screenOptions({ access: "all" }));
        ask(bela);
        assert.deepEqual(pendingIds(), [bela.peerId]);
        pluginSettings.set("requireVerifiedIdentity", false);
        assert.deepEqual(pendingIds(), []);
        assert.ok(watching(bela));
    });

    test("a identidade de quem espera foi verificada: reviewPendingApprovals manda o stream sem Permitir", async () => {
        const cris = await viewer("cris");
        const davi = await viewer("davi");
        await startStreaming(screenOptions({ access: "all" }));
        ask(cris);
        ask(davi);
        rt.peers.get(cris.peerId)!.identity = "verified";
        reviewPendingApprovals();
        assert.ok(watching(cris));
        assert.deepEqual(pendingIds(), [davi.peerId], "o outro continua esperando");
        onApprovalPolicyChanged();
        assert.deepEqual(pendingIds(), [davi.peerId], "nada mudou para ele");
    });
});

describe("identidade duplicada e identidade sendo conferida", () => {
    test("outra conexao diz ser quem assiste ou espera: param de receber, e nada volta sozinho", async () => {
        pluginSettings.set("requireVerifiedIdentity", false);
        const edu = await viewer("edu");
        await startStreaming(screenOptions({ access: "all" }));
        ask(edu);
        assert.ok(watching(edu));
        const since = logMark();

        // a mesma conta numa segunda conexao (pode ser alguem se passando por ele)
        await connectViewer(rig, "pedu2", edu.discordUserId, "edu");
        assert.equal(watching(edu), false);
        assert.deepEqual(lastReply(edu), { op: "denied", reason: "duplicate" });
        assert.ok(since().includes(`${edu.label} deixou de receber a transmissão (identidade duplicada: outra conexão diz ser a mesma pessoa)`));

        // pendente no modo aprovacao
        const fabi = await viewer("fabi");
        setStreamAccess("approval");
        ask(fabi);
        await connectViewer(rig, "pfabi2", fabi.discordUserId, "fabi");
        assert.deepEqual(pendingIds(), []);
        assert.deepEqual(lastReply(fabi), { op: "denied", reason: "duplicate" });

        // a outra conexao sai: o conflito acaba, mas ele precisa pedir de novo
        rig.room.disconnectPeer("pedu2");
        await seconds(rig, 1);
        assert.equal(watching(edu), false);
        setStreamAccess("all");
        ask(edu);
        assert.ok(watching(edu));
    });

    test("pedido de quem ainda esta com a identidade sendo conferida: ignorado, sem resposta", async () => {
        const gabi = await viewer("gabi");
        await startStreaming(screenOptions());
        // o que a sessao faz enquanto confere o id_token (identity "pending" nao e admitido)
        const entry = rt.peers.get(gabi.peerId)!;
        entry.identity = "pending";
        entry.admitted = false;
        const since = logMark();
        ask(gabi);
        assert.deepEqual(repliesTo(rig.room, gabi.peerId), []);
        assert.deepEqual(since(), [`${gabi.label} pediu para assistir enquanto a identidade ainda é conferida: ignorado`]);
        entry.identity = "unverified";
        entry.admitted = true;
    });
});
