/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do pedido de VP9 de quem assiste (core/viewing.ts → askForVp9, acao "codec", protocol.ts passo 8): o stream
// chegou, o video vem em H.264 e nenhum quadro foi decodificado em NO_FRAME_HINT_MS: pede ao transmissor (uma vez por
// "assistir") para mandar VP9. O aviso de 45 s continua igual. O lado de quem transmite fica em
// streaming.codecRequest.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.codecRequest.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { useFakeClock } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { videoReceiverStats } from "@test/fakes/webrtc";
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

test("H.264 chegando e nenhum quadro decodificado em 10 s: pede VP9 ao transmissor, uma vez; o aviso de 45 s continua", async t => {
    const clock = useFakeClock(t);
    const lines = logMark();
    streamArrives({ mimeType: "video/H264", framesDecoded: 0, framesReceived: 0, bytesReceived: 250_000, decoderImplementation: "D3D11VideoDecoder" });
    await clock.tickAsync(NO_FRAME_HINT_MS - 300, 150);
    assert.deepEqual(requests(), [], "antes de 10 s: espera");
    await clock.tickAsync(450, 150);
    assert.deepEqual(requests(), [[{ codec: "vp9" }, "peerA"]]);
    assert.ok(lines().includes("Assistir amigo (peerA): nenhum quadro do vídeo em H.264 decodificado em 10 s (0 quadros recebidos, "
        + "decodificador D3D11VideoDecoder); pedindo ao transmissor para mandar VP9"), lines().join("\n"));

    await clock.tickAsync(36_000, 150);
    assert.equal(requests().length, 1, "um pedido por assistir");
    const v = await viewerOf("peerA");
    assert.equal(v?.status, "error");
    assert.equal(v?.error, "Nenhum quadro de vídeo chegou em 45 s (rede ou decodificador travado). Continua tentando.");
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

test("sem pedido: o video em VP9, sem codec nas estatisticas (nenhum pacote) ou o 1o quadro antes de 10 s", async t => {
    const clock = useFakeClock(t);
    streamArrives({ mimeType: "video/VP9", framesDecoded: 0 });
    await clock.tickAsync(NO_FRAME_HINT_MS + 1000, 150);
    assert.deepEqual(requests(), [], "VP9");
    unwatch("peerA");

    const rx = streamArrives({ framesDecoded: 0 });
    rx.stats = () => videoReceiverStats({ framesDecoded: 0 }).filter(e => e.type !== "codec").map(e => ({ ...e, codecId: undefined }));
    await clock.tickAsync(NO_FRAME_HINT_MS + 1000, 150);
    assert.deepEqual(requests(), [], "sem codec");
    unwatch("peerA");

    const late = streamArrives({ mimeType: "video/H264", framesDecoded: 0 });
    await clock.tickAsync(3000, 150);
    late.stats = videoReceiverStats({ mimeType: "video/H264", framesDecoded: 5 });
    await clock.tickAsync(300, 150);
    assert.equal((await viewerOf("peerA"))?.status, "playing");
    await clock.tickAsync(NO_FRAME_HINT_MS + 1000, 150);
    assert.deepEqual(requests(), [], "o quadro chegou");
});
