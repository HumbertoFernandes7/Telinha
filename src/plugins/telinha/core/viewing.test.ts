/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes de quem assiste (core/viewing.ts): o pedido ao transmissor, as respostas dele (aguardando aprovacao, recusa),
// a chegada do stream, o primeiro quadro, as estatisticas e o fim da transmissao. A sala, o transmissor e a conexao
// dele sao falsos (test/helpers/wpc-viewing.ts, test/fakes); o tempo e o relogio falso, entao os prazos de 20 s, 75 s e
// 45 s sao testados no segundo exato. O que o usuario ve e a ViewerSession publicada em getState().viewing.
// A senha (desafio/prova) fica em viewing.password.test.ts; a ligacao com o Trystero em viewing.session.test.ts.
// Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import type { ViewDeniedReason } from "@plugins/telinha/types";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { FakeMediaStream, videoReceiverStats, videoTrack } from "@test/fakes/webrtc";
import { addStreamer, closeRoom, incomingStream, logMark, openRoom, receiveOn, viewerOf } from "@test/helpers/wpc-viewing";

import { clearAll, onIdentityInvalid, onPeerGone, onPeerStream, onPresence, onWatchReply, sampleStats, unwatch, watch } from "./viewing";

const INVALID_IDENTITY = "Essa conexão apresentou uma prova de identidade falsa (pode ser alguém se passando pelo seu amigo). A transmissão dela foi bloqueada.";

let room: FakeRoom;

beforeEach(() => {
    room = openRoom();
});

afterEach(() => {
    closeRoom();
});

const starts = () => room.sentOn("watch").map(m => [m.data, m.target]);

describe("pedido para assistir", () => {
    test("manda start so para esse transmissor e fica conectando", async t => {
        useFakeClock(t);
        addStreamer(room, "peerA");
        addStreamer(room, "peerB");
        const lines = logMark();
        watch("peerA");

        assert.deepEqual(starts(), [[{ op: "start" }, "peerA"]]);
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "connecting");
        assert.equal(v?.stream, null);
        assert.equal(v?.awaitingApproval, undefined);
        assert.equal(await viewerOf("peerB"), undefined, "o outro peer nao e afetado");
        assert.ok(lines().some(l => /Assistir amigo \(peerA\): pedido enviado/.test(l)));
    });

    test("pedir de novo enquanto a sessao esta de pe nao manda outro start", async t => {
        useFakeClock(t);
        addStreamer(room, "peerA");
        watch("peerA");
        watch("peerA");
        assert.equal(room.sentOn("watch").length, 1);
        assert.equal((await viewerOf("peerA"))?.status, "connecting");
    });

    const refusals: { name: string; text: string; setup(): void; }[] = [
        {
            name: "sem sala (fora de uma call)",
            text: "Você não está em um canal de voz com o Telinha ativo.",
            setup() {
                addStreamer(room, "peerA");
                rt.room = null;
                rt.watchAction = null;
            }
        },
        { name: "o amigo nao esta mais na sala", text: "Esse amigo não está mais na call.", setup() { } },
        { name: "handshake incompativel", text: "Esse amigo não está mais na call.", setup: () => void addStreamer(room, "peerA", { incompatible: true }) },
        { name: "identidade falsa", text: INVALID_IDENTITY, setup: () => void addStreamer(room, "peerA", { identity: "invalid" }) },
        {
            name: "identidade ainda sendo conferida",
            text: "Ainda conferindo a identidade desse amigo no Discord. Tente de novo em instantes.",
            setup: () => void addStreamer(room, "peerA", { identity: "pending" })
        },
        { name: "fora do canal de voz", text: "Essa pessoa não está no seu canal de voz.", setup: () => void addStreamer(room, "peerA", { admitted: false }) },
        { name: "o amigo nao esta transmitindo", text: "Esse amigo não está transmitindo agora.", setup: () => void addStreamer(room, "peerA", { streaming: false }) }
    ];
    for (const { name, text, setup } of refusals) {
        test(`recusa na hora: ${name}`, async t => {
            useFakeClock(t);
            setup();
            const lines = logMark();
            watch("peerA");

            const v = await viewerOf("peerA");
            assert.equal(v?.status, "error");
            assert.equal(v?.error, text);
            assert.equal(room.sentOn("watch").length, 0, "nada foi enviado");
            assert.ok(lines().some(l => l.includes(text)), "o motivo vai para o diagnostico");
        });
    }

    test("falha ao enviar o pedido: a sessao vira erro com o motivo", async t => {
        useFakeClock(t);
        addStreamer(room, "peerA");
        room.makeAction("watch").sendImpl = () => Promise.reject(new Error("canal fechado"));
        watch("peerA");
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.error, "Falha ao pedir a transmissão: Error: canal fechado");
    });

    test("a falha de um pedido que ja foi cancelado nao mexe em nada", async t => {
        useFakeClock(t);
        addStreamer(room, "peerA");
        const fails: (() => void)[] = [];
        room.makeAction("watch").sendImpl = () => new Promise<void>((_, reject) => { fails.push(() => reject(new Error("tarde demais"))); });
        const lines = logMark();
        watch("peerA");
        unwatch("peerA");
        assert.equal(fails.length, 2, "o start e o stop ainda estao no ar");
        for (const fail of fails) fail();
        await flushPromises();
        assert.equal(await viewerOf("peerA"), undefined);
        assert.ok(!lines().some(l => /tarde demais/.test(l)), "sem erro para uma sessao que nao existe mais");
    });

    test("sem resposta em 20 s: desiste com a frase do pedido", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerA");
        watch("peerA");
        clock.tick(19_999);
        assert.equal((await viewerOf("peerA"))?.status, "connecting", "ate 19,999 s ainda espera");
        clock.tick(1);
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.error, "O amigo não respondeu ao pedido para assistir.");
    });

    test("pedir de novo depois de um erro manda um start novo e a sessao velha nao interfere", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerA");
        watch("peerA");
        clock.tick(20_000);
        assert.equal((await viewerOf("peerA"))?.status, "error");

        watch("peerA");
        assert.equal(room.sentOn("watch").length, 2);
        assert.equal((await viewerOf("peerA"))?.status, "connecting");
        assert.equal((await viewerOf("peerA"))?.error, undefined, "o erro anterior sumiu");
    });

    test("assistir ja em andamento (conectando, esperando quadro, tocando) nao refaz o pedido", async t => {
        useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        receiveOn(pc, fake);
        onPeerStream("peerA", stream, undefined);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame");
        watch("peerA");
        assert.equal(room.sentOn("watch").length, 1);
    });
});

describe("respostas do transmissor", () => {
    test("pending: mostra 'aguardando aprovacao' e espera ate 75 s", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerA");
        const lines = logMark();
        watch("peerA");
        onWatchReply("peerA", { op: "pending" });

        let v = await viewerOf("peerA");
        assert.equal(v?.status, "connecting");
        assert.equal(v?.awaitingApproval, true);
        assert.ok(lines().some(l => /esperando o transmissor aprovar o pedido/.test(l)));

        clock.tick(74_999);
        v = await viewerOf("peerA");
        assert.equal(v?.status, "connecting", "o prazo de 20 s foi trocado pelo de 75 s");
        assert.equal(v?.awaitingApproval, true);
        clock.tick(1);
        v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.error, "O transmissor não respondeu ao pedido a tempo.");
        assert.equal(v?.awaitingApproval, undefined, "erro nao mostra mais 'aguardando'");
    });

    test("um segundo pending nao renova o prazo", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerA");
        watch("peerA");
        onWatchReply("peerA", { op: "pending" });
        clock.tick(50_000);
        onWatchReply("peerA", { op: "pending" });
        clock.tick(25_000);
        assert.equal((await viewerOf("peerA"))?.status, "error", "75 s depois do primeiro pending");
    });

    test("pending de quem nao estava pedindo, ou depois do erro, e ignorado", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerA");
        onWatchReply("peerA", { op: "pending" });
        assert.equal(await viewerOf("peerA"), undefined);

        watch("peerA");
        clock.tick(20_000);
        onWatchReply("peerA", { op: "pending" });
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.awaitingApproval, undefined);
    });

    const DENIED: [ViewDeniedReason, string][] = [
        ["kicked", "O transmissor encerrou a sua visualização."],
        ["declined", "O transmissor recusou o seu pedido para assistir."],
        ["timeout", "O transmissor não respondeu ao pedido a tempo. Você pode pedir de novo."],
        ["duplicate", "Outra conexão na call diz ser você, então o transmissor bloqueou as duas por segurança. Se você acabou de reabrir o Discord, espere alguns segundos e tente de novo."],
        ["friendsOnly", "Quem transmite escolheu \"Só meus amigos do Discord\": só amigos dessa pessoa no Discord, com a identidade verificada, assistem."],
        ["notVerified", "Esta transmissão é só para amigos com a identidade do Discord verificada. Autorize o Telinha no Discord (uma vez só) e tente de novo."],
        ["tooManyAttempts", "Você errou a senha vezes demais. Só dá para tentar de novo quando esta transmissão acabar (ou se o transmissor liberar você)."]
    ];
    for (const [reason, text] of DENIED) {
        test(`denied ${reason}: a UI recebe o motivo e a frase pronta`, async t => {
            const clock = useFakeClock(t);
            addStreamer(room, "peerA");
            watch("peerA");
            onWatchReply("peerA", { op: "denied", reason });

            const v = await viewerOf("peerA");
            assert.equal(v?.status, "error");
            assert.equal(v?.denied, reason);
            assert.equal(v?.error, text);

            clock.tick(100_000);
            assert.equal((await viewerOf("peerA"))?.error, text, "nenhum prazo antigo sobrescreve o motivo");
        });
    }

    test("denied no meio da transmissao: para de tocar, solta o stream e as estatisticas", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        const rx = receiveOn(pc, fake, { framesDecoded: 10 });
        onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });
        await clock.tickAsync(300);
        sampleStats();
        await flushPromises();
        clock.tick(2000);
        rx.stats = videoReceiverStats({ framesDecoded: 130, bytesReceived: 250_000 });
        sampleStats();
        assert.ok((await viewerOf("peerA"))?.stats, "ja havia estatisticas");

        onWatchReply("peerA", { op: "denied", reason: "kicked" });
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.stream, null);
        assert.equal(v?.stats, undefined);
        assert.equal(v?.denied, "kicked");
    });

    test("resposta de um peer que nao estamos assistindo e ignorada", async () => {
        addStreamer(room, "peerA");
        onWatchReply("peerA", { op: "denied", reason: "kicked" });
        onWatchReply("peerA", { op: "password", nonce: "a".repeat(22) });
        assert.equal(await viewerOf("peerA"), undefined);
    });
});

describe("parar de assistir", () => {
    test("unwatch avisa o transmissor, some da lista e cancela o prazo do pedido", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerA");
        const lines = logMark();
        watch("peerA");
        unwatch("peerA");

        assert.deepEqual(starts(), [[{ op: "start" }, "peerA"], [{ op: "stop" }, "peerA"]]);
        assert.equal(await viewerOf("peerA"), undefined);
        assert.ok(lines().some(l => /Parou de assistir amigo \(peerA\)/.test(l)));

        clock.tick(30_000);
        assert.ok(!lines().some(l => /nao respondeu|não respondeu/.test(l)), "o prazo de 20 s foi cancelado");
    });

    test("unwatch sem sessao nao faz nada; com o amigo ja fora da sala nao manda stop", async t => {
        useFakeClock(t);
        addStreamer(room, "peerA");
        unwatch("peerA");
        assert.equal(room.sentOn("watch").length, 0);

        watch("peerA");
        rt.peers.delete("peerA");
        unwatch("peerA");
        assert.deepEqual(starts(), [[{ op: "start" }, "peerA"]], "so o start: o peer nao existe mais");
    });

    test("sala ja fechada (sem a acao 'watch'): parar de assistir so limpa, sem mandar nada", async t => {
        useFakeClock(t);
        addStreamer(room, "peerA");
        watch("peerA");
        const sentBefore = room.sent.length;
        rt.watchAction = null;
        unwatch("peerA");
        assert.equal(room.sent.length, sentBefore);
        assert.equal(await viewerOf("peerA"), undefined);
    });

    test("um ouvinte do stream que se recusa a sair nao impede de parar; o fim tardio desse stream e ignorado", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake, video } = incomingStream();
        receiveOn(pc, fake);
        fake.removeEventListener = () => {
            throw new Error("nao sai");
        };
        onPeerStream("peerA", stream, undefined);
        await clock.tickAsync(300);

        unwatch("peerA");
        assert.equal(await viewerOf("peerA"), undefined, "a sessao saiu mesmo assim");
        const lines = logMark();
        video.end(); // o ouvinte do track continua la: o fim chega a uma sessao que nao existe mais
        assert.equal(await viewerOf("peerA"), undefined);
        assert.deepEqual(lines(), []);
    });

    test("clearAll descarta todas as sessoes sem avisar ninguem e desarma os prazos", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        addStreamer(room, "peerB");
        watch("peerA");
        watch("peerB");
        const { stream, fake, video } = incomingStream();
        receiveOn(pc, fake);
        onPeerStream("peerA", stream, undefined);
        const lines = logMark();
        const sentBefore = room.sent.length;

        clearAll();
        assert.equal(await viewerOf("peerA"), undefined);
        assert.equal(await viewerOf("peerB"), undefined);
        assert.equal(room.sent.length, sentBefore, "nada foi enviado");

        await clock.tickAsync(60_000);
        video.end();
        assert.deepEqual(lines(), [], "nem prazo, nem quadro, nem fim do track fazem barulho depois");
    });
});

describe("chegada do stream e primeiro quadro", () => {
    test("o stream vira 'esperando o primeiro quadro' e o primeiro quadro decodificado vira 'tocando'", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream({ audio: true });
        const rx = receiveOn(pc, fake, { framesDecoded: 0 });
        const lines = logMark();
        onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });

        let v = await viewerOf("peerA");
        assert.equal(v?.status, "waiting-first-frame");
        assert.equal(v?.stream, stream);
        assert.ok(lines().some(l => /stream recebido em \d+ ms \(1 vídeo, 1 áudio\)/.test(l)));

        await clock.tickAsync(1000);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame", "sem quadro decodificado continua esperando");

        rx.stats = videoReceiverStats({ framesDecoded: 3, mimeType: "video/H264", decoderImplementation: "D3D11VideoDecoder", powerEfficientDecoder: true });
        await clock.tickAsync(300);
        v = await viewerOf("peerA");
        assert.equal(v?.status, "playing");
        assert.equal(v?.error, undefined);
        assert.ok(lines().some(l => /primeiro quadro em \d+ ms \(video\/H264, 1920x1080, decodificador D3D11VideoDecoder \(hardware\)\)/.test(l)));

        // tocando: o relogio de 150 ms parou, nao ha mais consulta de estatisticas por conta propria
        let reads = 0;
        rx.stats = () => {
            reads++;
            return [];
        };
        await clock.tickAsync(1000);
        assert.equal(reads, 0);
    });

    test("estatisticas incompletas (Chromium antigo): o primeiro quadro vale mesmo sem codec, tamanho e decodificador", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        const rx = receiveOn(pc, fake);
        rx.stats = [
            { id: "I1", type: "inbound-rtp", kind: "video", framesDecoded: 2, powerEfficientDecoder: "sim", codecId: "sem-esse-codec" },
            { id: "I2", type: "inbound-rtp", kind: "audio", bytesReceived: 10 }, // um inbound de audio no receiver de video nao vira estatistica de video
            { id: "O1", type: "outbound-rtp", kind: "video", framesDecoded: 99 }
        ];
        const lines = logMark();
        onPeerStream("peerA", stream, undefined);
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
        assert.ok(lines().some(l => /primeiro quadro em \d+ ms \(codec \?, 0x0\)$/.test(l)), lines().join("\n"));

        // as leituras seguintes: sem bytes, sem tamanho (tudo 0), fps pelos quadros
        sampleStats();
        await flushPromises();
        clock.tick(2000);
        rx.stats = [{ id: "I1", type: "inbound-rtp", kind: "video", framesDecoded: 62 }];
        sampleStats();
        assert.deepEqual((await viewerOf("peerA"))?.stats, { width: 0, height: 0, fps: 30, kbps: 0 });

        // um inbound-rtp vazio (nem quadros decodificados): conta como zero, sem quebrar
        clock.tick(2000);
        rx.stats = [{ id: "I1", type: "inbound-rtp", kind: "video" }];
        sampleStats();
        assert.deepEqual((await viewerOf("peerA"))?.stats, { width: 0, height: 0, fps: 0, kbps: 0 });
    });

    test("o track de video ainda nao esta na conexao: nao ha o que medir e a espera continua", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerA");
        watch("peerA");
        onPeerStream("peerA", incomingStream().stream, undefined);
        await clock.tickAsync(600);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame");
    });

    test("decodificador por software: o log nao diz 'hardware'", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        receiveOn(pc, fake, { framesDecoded: 1, decoderImplementation: "libvpx" });
        const lines = logMark();
        onPeerStream("peerA", stream, undefined);
        await clock.tickAsync(300);
        const line = lines().find(l => /primeiro quadro/.test(l));
        assert.match(line ?? "", /decodificador libvpx\)$/);
    });

    test("so audio (sem track de video): nunca ha primeiro quadro e ao fim de 45 s vira erro", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const audioOnly = new FakeMediaStream([]);
        const track = incomingStream({ audio: true }).audio!;
        audioOnly.addTrack(track);
        pc.addReceivingTrack(track);
        onPeerStream("peerA", audioOnly as unknown as MediaStream, undefined);
        await clock.tickAsync(10_000);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame");
        await clock.tickAsync(36_000);
        assert.equal((await viewerOf("peerA"))?.status, "error");
    });

    test("metadado de outro tipo e ignorado; sem metadado ou com um que nao e objeto, vale", async t => {
        useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const lines = logMark();
        const other = incomingStream();
        receiveOn(pc, other.fake);
        onPeerStream("peerA", other.stream, { kind: "outra-coisa" });
        assert.equal((await viewerOf("peerA"))?.status, "connecting", "ignorado");
        assert.ok(lines().some(l => /tipo desconhecido \(outra-coisa\); ignorado/.test(l)));

        onPeerStream("peerA", other.stream, []);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame", "um array nao e um objeto de metadado: vale");
        unwatch("peerA");

        watch("peerA");
        onPeerStream("peerA", other.stream, null);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame", "null: vale");
    });

    test("stream sem pedido (ou depois de parar de assistir): pede para o transmissor parar", async t => {
        useFakeClock(t);
        addStreamer(room, "peerA");
        const lines = logMark();
        onPeerStream("peerA", incomingStream().stream, { kind: STREAM_KIND_SCREEN });

        assert.deepEqual(starts(), [[{ op: "stop" }, "peerA"]]);
        assert.equal(await viewerOf("peerA"), undefined, "nao cria sessao");
        assert.ok(lines().some(l => /sem pedido; pedindo para parar/.test(l)));
    });

    test("o mesmo stream entregue duas vezes nao reinicia a espera", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        receiveOn(pc, fake, { framesDecoded: 5 });
        onPeerStream("peerA", stream, undefined);
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
        const lines = logMark();
        onPeerStream("peerA", stream, undefined);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
        assert.deepEqual(lines(), []);
    });

    test("um stream novo (o transmissor trocou de fonte) recomeca a espera e solta os ouvintes do velho", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const first = incomingStream();
        receiveOn(pc, first.fake, { framesDecoded: 5 });
        onPeerStream("peerA", first.stream, undefined);
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");

        const second = incomingStream();
        const rx2 = receiveOn(pc, second.fake, { framesDecoded: 0 });
        onPeerStream("peerA", second.stream, undefined);
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "waiting-first-frame");
        assert.equal(v?.stream, second.stream);
        assert.equal(v?.stats, undefined);

        first.video.end();
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame", "o fim do track velho nao derruba o novo");
        rx2.stats = videoReceiverStats({ framesDecoded: 2 });
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
    });

    test("45 s sem nenhum quadro: avisa, mantem o stream e se recupera quando o quadro chega", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        const rx = receiveOn(pc, fake, { framesDecoded: 0 });
        onPeerStream("peerA", stream, undefined);

        await clock.tickAsync(44_900);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame");
        await clock.tickAsync(400);
        let v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.error, "Nenhum quadro de vídeo chegou em 45 s (rede ou decodificador travado). Continua tentando.");
        assert.equal(v?.stream, stream, "o stream continua anexado");

        // o 'sampleStats' de 2 em 2 s do session.ts tambem vigia sessoes em erro: o quadro chegou tarde
        rx.stats = videoReceiverStats({ framesDecoded: 9 });
        sampleStats();
        v = await viewerOf("peerA");
        assert.equal(v?.status, "playing");
        assert.equal(v?.error, undefined);
    });

    test("uma leitura de estatisticas que falha nao derruba a espera do primeiro quadro", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        const rx = receiveOn(pc, fake);
        rx.stats = () => {
            throw new Error("getStats quebrou");
        };
        onPeerStream("peerA", stream, undefined);
        await clock.tickAsync(600);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame");

        rx.stats = videoReceiverStats({ framesDecoded: 1 });
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
    });

    test("uma leitura lenta nao empilha outras: so uma consulta por vez", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const { stream, fake } = incomingStream();
        const rx = receiveOn(pc, fake);
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        rx.stats = async () => {
            calls++;
            await gate;
            return videoReceiverStats({ framesDecoded: 1 });
        };
        onPeerStream("peerA", stream, undefined);
        await clock.tickAsync(900);
        assert.equal(calls, 1, "6 voltas do relogio, uma consulta so");
        release();
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
    });
});

describe("o stream acaba por conta propria", () => {
    async function playing(peerId = "peerA") {
        const pc = addStreamer(room, peerId);
        watch(peerId);
        const incoming = incomingStream({ audio: true });
        receiveOn(pc, incoming.fake, { framesDecoded: 5 });
        onPeerStream(peerId, incoming.stream, undefined);
        return { pc, ...incoming };
    }

    test("o track de video termina: a sessao acaba, sem erro", async t => {
        const clock = useFakeClock(t);
        const { video } = await playing();
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
        const lines = logMark();
        video.end();
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "ended");
        assert.equal(v?.stream, null);
        assert.equal(v?.error, undefined);
        assert.ok(lines().some(l => /a transmissão foi encerrada/.test(l)));
    });

    test("o track de video e removido: acaba; se ainda sobra um track de video vivo, continua", async t => {
        const clock = useFakeClock(t);
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const a = videoTrack();
        const b = videoTrack();
        const stream = new FakeMediaStream([a, b]);
        receiveOn(pc, stream, { framesDecoded: 5 });
        onPeerStream("peerA", stream as unknown as MediaStream, undefined);
        await clock.tickAsync(300);

        stream.emitRemoveTrack(a);
        assert.equal((await viewerOf("peerA"))?.status, "playing", "o outro track de video continua vivo");
        b.stop();
        stream.emitRemoveTrack(videoTrack());
        assert.equal((await viewerOf("peerA"))?.status, "ended", "nenhum track de video vivo");
    });

    test("o fim de um stream que ja foi trocado nao conta", async t => {
        const clock = useFakeClock(t);
        const first = await playing();
        await clock.tickAsync(300);
        const second = incomingStream();
        onPeerStream("peerA", second.stream, undefined);
        first.fake.emitRemoveTrack(first.video);
        assert.equal((await viewerOf("peerA"))?.status, "waiting-first-frame");
    });

    test("o amigo para de transmitir: acaba e esquece o stream; repetir o aviso nao faz barulho", async t => {
        const clock = useFakeClock(t);
        await playing();
        await clock.tickAsync(300);
        const lines = logMark();
        const gone = { v: 1, discordUserId: "200000000000000002", username: "amigo", streaming: false, caps: { h264HwDecode: false } };
        onPresence("peerA", gone);
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "ended");
        assert.equal(v?.stream, null);
        assert.deepEqual(lines().filter(l => /parou de transmitir/.test(l)).length, 1);

        onPresence("peerA", gone);
        await flushPromises();
        assert.deepEqual(lines().filter(l => /parou de transmitir/.test(l)).length, 1, "ja tinha acabado");
    });

    test("presenca 'transmitindo' (o amigo continua) e de quem nao assistimos nao muda nada", async t => {
        const clock = useFakeClock(t);
        await playing();
        await clock.tickAsync(300);
        onPresence("peerA", { v: 1, discordUserId: "200000000000000002", username: "amigo", streaming: true, caps: { h264HwDecode: false } });
        onPresence("peerZ", { v: 1, discordUserId: "300000000000000003", username: "outro", streaming: false, caps: { h264HwDecode: false } });
        assert.equal((await viewerOf("peerA"))?.status, "playing");
        assert.equal(await viewerOf("peerZ"), undefined);
    });

    test("o amigo sai da call: acaba; de quem nao assistimos nao faz nada", async t => {
        const clock = useFakeClock(t);
        await playing();
        await clock.tickAsync(300);
        const lines = logMark();
        onPeerGone("peerZ");
        onPeerGone("peerA");
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "ended");
        assert.ok(lines().some(l => /o amigo saiu da call/.test(l)));

        onPeerGone("peerA");
        assert.equal(lines().filter(l => /o amigo saiu da call/.test(l)).length, 1, "ja tinha acabado: nao avisa duas vezes");
    });

    test("prova de identidade falsa: para de assistir com a frase de seguranca, solta o stream", async t => {
        const clock = useFakeClock(t);
        await playing();
        await clock.tickAsync(300);
        onIdentityInvalid("peerZ");
        onIdentityInvalid("peerA");
        const v = await viewerOf("peerA");
        assert.equal(v?.status, "error");
        assert.equal(v?.error, INVALID_IDENTITY);
        assert.equal(v?.stream, null);
    });
});

describe("estatisticas (a cada 2 s)", () => {
    async function liveSession(clock: ReturnType<typeof useFakeClock>, init: Parameters<typeof videoReceiverStats>[0] = { framesDecoded: 100 }) {
        const pc = addStreamer(room, "peerA");
        watch("peerA");
        const incoming = incomingStream({ audio: true });
        const rx = receiveOn(pc, incoming.fake, init);
        const audioRx = pc.getReceivers().find(r => r.track === incoming.audio)!;
        onPeerStream("peerA", incoming.stream, undefined);
        await clock.tickAsync(300);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
        return { pc, rx, audioRx, ...incoming };
    }

    const audioBytes = (bytesReceived: number) => [{ id: "IA", type: "inbound-rtp", kind: "audio", bytesReceived }];

    test("a primeira leitura so marca o ponto de partida; a segunda calcula kbps (video + audio), fps e tamanho", async t => {
        const clock = useFakeClock(t);
        const { rx, audioRx } = await liveSession(clock);
        audioRx.stats = audioBytes(0);

        sampleStats();
        assert.equal((await viewerOf("peerA"))?.stats, undefined);

        clock.tick(2000);
        rx.stats = videoReceiverStats({ framesDecoded: 220, bytesReceived: 400_000, frameWidth: 1280, frameHeight: 720, framesPerSecond: 58 });
        audioRx.stats = audioBytes(100_000);
        sampleStats();
        assert.deepEqual((await viewerOf("peerA"))?.stats, { width: 1280, height: 720, fps: 58, kbps: 2000 });
    });

    test("sem framesPerSecond nas estatisticas o fps vem dos quadros decodificados no intervalo", async t => {
        const clock = useFakeClock(t);
        const { rx } = await liveSession(clock);
        sampleStats();
        await flushPromises();
        clock.tick(2000);
        const entries = videoReceiverStats({ framesDecoded: 220, bytesReceived: 100_000 });
        delete entries[0].framesPerSecond;
        rx.stats = entries;
        sampleStats();
        assert.equal((await viewerOf("peerA"))?.stats?.fps, 60, "120 quadros em 2 s");
    });

    test("contadores que nao andam: fps 0 e kbps 0 (nunca negativos)", async t => {
        const clock = useFakeClock(t);
        const { rx } = await liveSession(clock, { framesDecoded: 500, bytesReceived: 900_000 });
        sampleStats();
        await flushPromises();
        clock.tick(2000);
        const entries = videoReceiverStats({ framesDecoded: 400, bytesReceived: 100_000 });
        delete entries[0].framesPerSecond;
        rx.stats = entries;
        sampleStats();
        const stats = (await viewerOf("peerA"))?.stats;
        assert.equal(stats?.fps, 0);
        assert.equal(stats?.kbps, 0);
    });

    test("duas leituras no mesmo instante nao publicam numeros (sem dividir por zero)", async t => {
        const clock = useFakeClock(t);
        await liveSession(clock);
        sampleStats();
        await flushPromises();
        sampleStats();
        assert.equal((await viewerOf("peerA"))?.stats, undefined);
    });

    test("so le quem tem stream: conexao em andamento e sessao encerrada nao fazem consulta", async t => {
        const clock = useFakeClock(t);
        addStreamer(room, "peerB");
        watch("peerB");
        const { rx } = await liveSession(clock);
        let reads = 0;
        rx.stats = () => {
            reads++;
            return videoReceiverStats({ framesDecoded: 9 });
        };
        onPresence("peerA", { v: 1, discordUserId: "200000000000000002", username: "amigo", streaming: false, caps: { h264HwDecode: false } });
        sampleStats();
        await flushPromises();
        assert.equal(reads, 0, "peerB so pediu e peerA ja acabou");
    });

    test("sem a conexao do peer (saiu da sala) a leitura e descartada", async t => {
        const clock = useFakeClock(t);
        await liveSession(clock);
        room.peers.delete("peerA");
        sampleStats();
        await flushPromises();
        assert.equal((await viewerOf("peerA"))?.stats, undefined);
        assert.equal((await viewerOf("peerA"))?.status, "playing");
    });

    test("uma leitura que falha nao derruba a sessao", async t => {
        const clock = useFakeClock(t);
        const { rx } = await liveSession(clock);
        rx.stats = () => {
            throw new Error("getStats quebrou");
        };
        sampleStats();
        await flushPromises();
        assert.equal((await viewerOf("peerA"))?.status, "playing");
    });

    for (const [name, change] of [
        ["o transmissor trocou de stream", () => onPeerStream("peerA", incomingStream().stream, undefined)],
        ["a sessao foi encerrada", () => unwatch("peerA")]
    ] as const) {
        test(`uma leitura que chega depois de mudar a sessao e descartada (${name})`, async t => {
            const clock = useFakeClock(t);
            const { rx } = await liveSession(clock);
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            rx.stats = async () => {
                await gate;
                return videoReceiverStats({ framesDecoded: 1000, bytesReceived: 1 });
            };
            sampleStats();
            change();
            release();
            await flushPromises();
            const v = await viewerOf("peerA");
            assert.equal(v?.stats, undefined, "os numeros do stream velho nao aparecem");
            assert.notEqual(v?.status, "playing");
        });
    }
});
