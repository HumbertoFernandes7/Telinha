/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do pedido de VP9 de quem assiste (core/viewing.ts → askForVp9, acao "codec", protocol.ts passo 8): o stream
// chegou, o video vem em H.264 (ou nenhum pacote de video chegou: codec desconhecido, o log das 02:54 de 31/10) e nenhum
// quadro foi decodificado em NO_FRAME_HINT_MS: pede ao transmissor para mandar VP9, e repete a cada NO_FRAME_HINT_MS
// enquanto nenhum quadro chega (o transmissor pode ter ignorado: a captura dele parada naquela hora), no maximo 4 ate o
// aviso de 45 s; o pedido e por stream (um stream novo pode pedir de novo). Video em outro codec, nao pede. O aviso de
// 45 s continua igual. O lado de quem transmite (so troca um envio em H.264, com o codec no automatico e a captura no
// ar) fica em streaming.codecRequest.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.codecRequest.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { useFakeClock } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { audioReceiverStats, videoReceiverStats } from "@test/fakes/webrtc";
import { addStreamer, closeRoom, incomingStream, logMark, openRoom, receiveOn, viewerOf } from "@test/helpers/wpc-viewing";

import { NO_FRAME_HINT_MS, onPeerStream, unwatch, watch } from "./viewing";

let room: FakeRoom;

beforeEach(() => {
    room = openRoom();
});

afterEach(() => {
    closeRoom();
});

/** O que pedimos ao transmissor na acao "codec". */
const requests = () => room.sentOn("codec").map(m => [m.data, m.target]);

/** "peerA" transmite; pedimos para assistir e o stream chega com estas estatisticas de video. */
function streamArrives(init: Parameters<typeof videoReceiverStats>[0]) {
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { stream, fake } = incomingStream();
    const rx = receiveOn(pc, fake, init);
    onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });
    return rx;
}

/** Linhas dos pedidos de VP9: o 1o (warn, com os detalhes) e as repeticoes (info, curtas). */
const firstAsks = (lines: string[]) => lines.filter(l => l.endsWith("pedindo ao transmissor para mandar VP9"));
const repeatAsks = (lines: string[]) => lines.filter(l => l.endsWith("pedindo VP9 de novo ao transmissor"));

test("H.264 chegando e nenhum quadro: pede VP9 aos 10 s e repete a cada 10 s (sem chamar a mao), no maximo 4 ate o aviso de 45 s", async t => {
    const clock = useFakeClock(t);
    const lines = logMark();
    streamArrives({ mimeType: "video/H264", framesDecoded: 0, framesReceived: 0, bytesReceived: 250_000, decoderImplementation: "D3D11VideoDecoder" });
    await clock.tickAsync(NO_FRAME_HINT_MS - 300, 150);
    assert.deepEqual(requests(), [], "antes de 10 s: espera");
    await clock.tickAsync(450, 150);
    assert.deepEqual(requests(), [[{ codec: "vp9" }, "peerA"]]);
    assert.deepEqual(firstAsks(lines()), ["Assistir amigo (peerA): nenhum quadro do vídeo em H.264 decodificado em 10 s (0 quadros recebidos, "
        + "decodificador D3D11VideoDecoder); pedindo ao transmissor para mandar VP9"]);

    // o transmissor ignorou (ex.: a captura dele parada naquela hora): ainda sem quadro, o 2o pedido sai sozinho aos 20 s
    await clock.tickAsync(NO_FRAME_HINT_MS - 300, 150);
    assert.equal(requests().length, 1, "19,85 s: ainda nao");
    await clock.tickAsync(300, 150);
    assert.deepEqual(requests(), [[{ codec: "vp9" }, "peerA"], [{ codec: "vp9" }, "peerA"]]);
    assert.deepEqual(repeatAsks(lines()), ["Assistir amigo (peerA): ainda nenhum quadro em 20 s; pedindo VP9 de novo ao transmissor"]);

    // sem spam: 30 s e 40 s, e nenhum depois do aviso de 45 s
    await clock.tickAsync(26_000, 150);
    const v = await viewerOf("peerA");
    assert.equal(v?.status, "error");
    assert.equal(v?.error, "Nenhum quadro de vídeo chegou em 45 s (rede ou decodificador travado). Continua tentando.");
    assert.equal(requests().length, 4, "10, 20, 30 e 40 s");
    await clock.tickAsync(60_000, 150);
    assert.equal(requests().length, 4, "nada depois dos 45 s");
    assert.equal(firstAsks(lines()).length, 1, "so o 1o em warn");
    assert.equal(repeatAsks(lines()).length, 3);
});

test("o 1o quadro encerra os pedidos; um stream novo em H.264 sem quadro (ele trocou de janela) pede de novo", async t => {
    const clock = useFakeClock(t);
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const first = incomingStream();
    const rx = receiveOn(pc, first.fake, { mimeType: "video/H264", framesDecoded: 0 });
    onPeerStream("peerA", first.stream, { kind: STREAM_KIND_SCREEN });
    await clock.tickAsync(NO_FRAME_HINT_MS + 300, 150);
    assert.equal(requests().length, 1);

    // o transmissor atendeu: o envio virou VP9 e o 1o quadro chegou aos 15 s; nenhum pedido depois
    await clock.tickAsync(4700, 150);
    rx.stats = videoReceiverStats({ mimeType: "video/VP9", framesDecoded: 3 });
    await clock.tickAsync(300, 150);
    assert.equal((await viewerOf("peerA"))?.status, "playing");
    await clock.tickAsync(40_000, 150);
    assert.equal(requests().length, 1, "nenhum pedido depois do 1o quadro");

    // ele trocou de janela: o stream novo volta a H.264 (um pedido atendido nao conta como queda) e de novo sem quadro
    const second = incomingStream();
    receiveOn(pc, second.fake, { mimeType: "video/H264", framesDecoded: 0 });
    onPeerStream("peerA", second.stream, { kind: STREAM_KIND_SCREEN });
    await clock.tickAsync(NO_FRAME_HINT_MS - 300, 150);
    assert.equal(requests().length, 1, "o novo stream tambem espera 10 s");
    await clock.tickAsync(450, 150);
    assert.deepEqual(requests(), [[{ codec: "vp9" }, "peerA"], [{ codec: "vp9" }, "peerA"]], "o pedido e por stream");
});

test("sem contador de quadros recebidos (Chromium antigo): o pedido diz os kB; a sala sem a acao \"codec\": nada e mandado", async t => {
    const clock = useFakeClock(t);
    const lines = logMark();
    const rx = streamArrives({ mimeType: "video/H264", framesDecoded: 0, bytesReceived: 250_000 });
    rx.stats = () => videoReceiverStats({ mimeType: "video/H264", framesDecoded: 0, bytesReceived: 250_000 }).map(e => {
        const { framesReceived: _, ...rest } = e as Record<string, unknown>;
        return rest as typeof e;
    });
    await clock.tickAsync(NO_FRAME_HINT_MS + 300, 150);
    assert.deepEqual(requests(), [[{ codec: "vp9" }, "peerA"]]);
    assert.ok(lines().some(l => l.endsWith("decodificado em 10 s (250 kB recebidos, decodificador libvpx); pedindo ao transmissor para mandar VP9")), lines().join("\n"));
    unwatch("peerA");

    // sala sem a acao (ex.: fechando): nada e mandado
    rt.codecAction = null;
    room.sent.length = 0;
    streamArrives({ mimeType: "video/H264", framesDecoded: 0 });
    await clock.tickAsync(NO_FRAME_HINT_MS + 300, 150);
    assert.deepEqual(requests(), []);
});

test("log das 02:54: nenhum pacote de video (sem codec, so o audio chega) e nenhum quadro em 10 s: pede VP9 (e repete)", async t => {
    const clock = useFakeClock(t);
    const lines = logMark();
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { stream, fake, audio } = incomingStream({ audio: true });
    const rx = receiveOn(pc, fake);
    rx.stats = []; // o Chromium so cria o inbound-rtp do video com o 1o pacote
    pc.getReceivers().find(r => r.track === audio)!.stats = audioReceiverStats({ bytesReceived: 1250 });
    onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });
    await clock.tickAsync(NO_FRAME_HINT_MS - 300, 150);
    assert.deepEqual(requests(), [], "antes de 10 s: espera");
    await clock.tickAsync(450, 150);
    assert.deepEqual(requests(), [[{ codec: "vp9" }, "peerA"]]);
    assert.ok(lines().includes("Assistir amigo (peerA): nenhum quadro de vídeo decodificado em 10 s e nenhum pacote de vídeo identificado "
        + "(codec desconhecido, 1 kB recebidos); pedindo ao transmissor para mandar VP9"), lines().join("\n"));

    await clock.tickAsync(36_000, 150);
    assert.equal(requests().length, 4, "repetido a cada 10 s ate o aviso de 45 s");
    assert.equal((await viewerOf("peerA"))?.status, "error", "o aviso de 45 s continua");
    unwatch("peerA");

    // o inbound-rtp do video sem codecId (sem o codec nas estatisticas): o mesmo pedido, com o que chegou
    room.sent.length = 0;
    const bare = streamArrives({ framesDecoded: 0, framesReceived: 3 });
    bare.stats = () => videoReceiverStats({ framesDecoded: 0, framesReceived: 3 }).filter(e => e.type !== "codec").map(e => ({ ...e, codecId: undefined }));
    await clock.tickAsync(NO_FRAME_HINT_MS + 300, 150);
    assert.deepEqual(requests(), [[{ codec: "vp9" }, "peerA"]]);
    assert.ok(lines().some(l => l.endsWith("nenhum pacote de vídeo identificado (codec desconhecido, 3 quadros recebidos, decodificador libvpx); "
        + "pedindo ao transmissor para mandar VP9")), lines().join("\n"));
});

test("sem pedido: o video em VP9 ou o 1o quadro antes de 10 s", async t => {
    const clock = useFakeClock(t);
    streamArrives({ mimeType: "video/VP9", framesDecoded: 0 });
    await clock.tickAsync(NO_FRAME_HINT_MS + 1000, 150);
    assert.deepEqual(requests(), [], "VP9");
    unwatch("peerA");

    const late = streamArrives({ mimeType: "video/H264", framesDecoded: 0 });
    await clock.tickAsync(3000, 150);
    late.stats = videoReceiverStats({ mimeType: "video/H264", framesDecoded: 5 });
    await clock.tickAsync(300, 150);
    assert.equal((await viewerOf("peerA"))?.status, "playing");
    await clock.tickAsync(NO_FRAME_HINT_MS + 1000, 150);
    assert.deepEqual(requests(), [], "o quadro chegou");
});
