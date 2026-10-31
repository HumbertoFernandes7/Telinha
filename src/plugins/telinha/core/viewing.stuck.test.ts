/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do aviso de placa de video travada do lado de quem assiste (protocol.ts passo 10 → core/viewing.ts → onStuck):
// o transmissor responde { op: "stuck" } quando o encoder H.264 da placa dele trava no envio para nos (e a cada
// "assistir" ou pedido de VP9 enquanto isso durar). Quem assiste para de esperar com a frase certa ("A placa de vídeo de
// X travou; ele precisa reiniciar o Discord.") em vez do aviso generico de 45 s, e para de pedir VP9. Versoes antigas
// ignoram o op (parseWatchReply devolve null), e um { op: "stuck" } nunca e um pedido do espectador.
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.stuck.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { parseWatchReply, parseWatchRequest, STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { useFakeClock } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { videoReceiverStats } from "@test/fakes/webrtc";
import { addStreamer, closeRoom, incomingStream, logMark, openRoom, receiveOn, viewerOf } from "@test/helpers/wpc-viewing";

import { onPeerGone, onPeerStream, onWatchReply, sampleStats, stuckText, watch } from "./viewing";

const STUCK = "A placa de vídeo de amigo travou; ele precisa reiniciar o Discord.";

let room: FakeRoom;

beforeEach(() => {
    room = openRoom();
});

afterEach(() => {
    closeRoom();
});

/** o { op: "stuck" } do transmissor, como core/session.ts entrega (parseWatchReply → onWatchReply) */
const stuck = () => onWatchReply("peerA", parseWatchReply({ op: "stuck" })!);

test("protocolo: { op: \"stuck\" } e uma resposta do transmissor (sem campos a mais), nunca um pedido do espectador", () => {
    assert.deepEqual(parseWatchReply({ op: "stuck" }), { op: "stuck" });
    assert.deepEqual(parseWatchReply({ op: "stuck", reason: "x".repeat(1000) }), { op: "stuck" });
    assert.equal(parseWatchRequest({ op: "stuck" }), null, "o transmissor ignora");
});

test("o stream chegou sem quadro e o transmissor avisa que a placa travou: a frase certa na hora, sem pedir VP9, e o aviso de 45 s nao a troca", async t => {
    const clock = useFakeClock(t);
    const lines = logMark();
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { stream, fake } = incomingStream();
    receiveOn(pc, fake, { mimeType: "video/H264", framesDecoded: 0, framesReceived: 0, bytesReceived: 0 });
    onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });
    await clock.tickAsync(9000, 150);
    stuck();
    let v = await viewerOf("peerA");
    assert.equal(v?.status, "error");
    assert.equal(v?.error, STUCK);
    assert.ok(v?.stream, "o stream fica (o audio dele continua)");
    assert.equal(stuckText("peerA"), STUCK);
    assert.ok(lines().includes(`Assistir amigo (peerA): ${STUCK}`));

    // repetido: nada novo; passados os 45 s: continua a frase da placa, e nenhum pedido de VP9
    stuck();
    await clock.tickAsync(50_000, 150);
    v = await viewerOf("peerA");
    assert.equal(v?.error, STUCK);
    assert.deepEqual(room.sentOn("codec"), [], "pedir VP9 nao adianta: quem transmite nao troca o codec de um envio travado");
    assert.equal(lines().filter(l => l.endsWith(STUCK)).length, 1);
});

test("o aviso generico de 45 s ja saiu e o { op: \"stuck\" } chega depois: troca pela frase da placa", async t => {
    const clock = useFakeClock(t);
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { stream, fake } = incomingStream();
    const rx = receiveOn(pc, fake, { mimeType: "video/VP9", framesDecoded: 0 });
    onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });
    await clock.tickAsync(46_000, 150);
    assert.match((await viewerOf("peerA"))?.error ?? "", /^Nenhum quadro de vídeo chegou em 45 s/);
    stuck();
    assert.equal((await viewerOf("peerA"))?.error, STUCK);

    // a imagem chega depois (a leitura de 2 s da sessao recupera o erro): um aviso atrasado e ignorado
    rx.stats = videoReceiverStats({ mimeType: "video/VP9", framesDecoded: 5 });
    sampleStats();
    await clock.tickAsync(300, 150);
    stuck();
    assert.equal((await viewerOf("peerA"))?.status, "playing");
});

test("o nome na frase: o da presenca, senao o do handshake, senao \"quem transmite\"", () => {
    addStreamer(room, "peerA");
    const entry = rt.peers.get("peerA")!;
    entry.presence = { ...entry.presence!, username: "Gupi" };
    assert.equal(stuckText("peerA"), "A placa de vídeo de Gupi travou; ele precisa reiniciar o Discord.");
    entry.presence = null;
    assert.equal(stuckText("peerA"), STUCK, "o nome do handshake");
    assert.equal(stuckText("ninguem"), "A placa de vídeo de quem transmite travou; ele precisa reiniciar o Discord.");
});

test("assistir enquanto a placa dele continua travada: a resposta e o { op: \"stuck\" }, sem esperar 20 s", async () => {
    addStreamer(room, "peerA");
    watch("peerA");
    stuck();
    const v = await viewerOf("peerA");
    assert.equal(v?.status, "error");
    assert.equal(v?.error, STUCK);
    assert.equal(v?.stream, null);
});

test("a conexao com ele cai depois do aviso (ele recusa renegociar a conexao travada): continua a frase da placa, nao \"saiu da call\"", async () => {
    addStreamer(room, "peerA");
    watch("peerA");
    stuck();
    onPeerGone("peerA");
    let v = await viewerOf("peerA");
    assert.equal(v?.status, "error");
    assert.equal(v?.error, STUCK);

    // sem o aviso antes: "saiu da call", como sempre
    addStreamer(room, "peerB");
    watch("peerB");
    onPeerGone("peerB");
    v = await viewerOf("peerB");
    assert.equal(v?.status, "ended");
});

test("com a imagem chegando, o aviso e ignorado; sem sessao para esse peer, tambem", async t => {
    const clock = useFakeClock(t);
    stuck();
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { stream, fake } = incomingStream();
    receiveOn(pc, fake, { mimeType: "video/H264", framesDecoded: 4 });
    onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });
    await clock.tickAsync(600, 150);
    assert.equal((await viewerOf("peerA"))?.status, "playing");
    stuck();
    assert.equal((await viewerOf("peerA"))?.status, "playing");
});
