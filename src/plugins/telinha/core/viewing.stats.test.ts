/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do log de estatisticas de quem assiste (core/viewing.ts → sampleStats + core/statsLog.ts): com a leitura de 2 s
// que ja alimenta a tela, uma linha a cada 10 s por transmissao assistida e o resumo quando ela acaba. A conta e o texto
// das linhas ficam em core/statsLog.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.stats.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { PROTOCOL_VERSION, STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { type FakeClock, flushPromises, useFakeClock } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { FRIEND_ID } from "@test/fakes/vencord";
import { audioReceiverStats, type FakeMediaStreamTrack, type FakeRTCPeerConnection, videoReceiverStats } from "@test/fakes/webrtc";
import { addStreamer, closeRoom, incomingStream, logMark, openRoom, receiveOn } from "@test/helpers/wpc-viewing";

import { STATS_LINE_RE } from "./statsLog";
import { onPeerStream, onPresence, sampleStats, unwatch, watch } from "./viewing";

let room: FakeRoom;

beforeEach(() => {
    room = openRoom();
});

afterEach(() => {
    closeRoom();
});

/**
 * Um stream de "peerA" com video e audio cujos contadores seguem o relogio: 30 fps, 1000 kbps, 1% de perda, 50 ms no
 * jitter buffer, 0,1% do audio ocultado.
 */
function playing(clock: FakeClock, pc: FakeRTCPeerConnection) {
    const { stream, fake, audio } = incomingStream({ audio: true });
    const video = receiveOn(pc, fake);
    const sound = pc.getReceivers().find(r => r.track === (audio as FakeMediaStreamTrack))!;
    const start = clock.now();
    const s = () => (clock.now() - start) / 1000;
    video.stats = () => videoReceiverStats({
        framesDecoded: 30 * s(), framesReceived: 30 * s(), bytesReceived: 125_000 * s(), frameWidth: 1280, frameHeight: 720,
        extra: {
            framesDropped: 0, freezeCount: 0, totalFreezesDuration: 0, jitterBufferDelay: 30 * s() * 0.05, jitterBufferEmittedCount: 30 * s(),
            totalInterFrameDelay: s(), totalSquaredInterFrameDelay: s() / 30, packetsLost: s(), packetsReceived: 99 * s(), nackCount: s(), pliCount: 0
        }
    });
    sound.stats = () => audioReceiverStats({ totalSamplesReceived: 48_000 * s(), concealedSamples: 48 * s() });
    onPeerStream("peerA", stream, { kind: STREAM_KIND_SCREEN });
}

/** Uma leitura agora (sampleStats, o que o tick da sessao chama a cada 2 s). */
async function read() {
    sampleStats();
    await flushPromises();
}

/** `n` leituras, a cada 2 s. */
async function every2s(clock: FakeClock, n: number) {
    for (let i = 0; i < n; i++) {
        clock.tick(2000);
        await read();
    }
}

test("assistindo: uma linha a cada 10 s com a leitura de 2 s e o resumo ao parar de assistir", async t => {
    const clock = useFakeClock(t);
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const lines = logMark();
    playing(clock, pc);

    await read();
    await every2s(clock, 4);
    assert.deepEqual(lines().filter(l => STATS_LINE_RE.test(l)), [], "8 s: a janela ainda nao fechou");
    await every2s(clock, 1);
    const line = "Recepção de amigo (peerA): VP9 libvpx 1280x720 · 30,0 fps decodificados de 30,0 recebidos, 0 descartados · congelou 0x · buffer 50 ms · "
        + "σ entre quadros 0 ms · perda 1,0% · nack 10 pli 0 · 1000 kbps · áudio ocultado 0,1%";
    assert.deepEqual(lines().filter(l => STATS_LINE_RE.test(l)), [line]);

    unwatch("peerA");
    const all = lines();
    const summary = "Resumo da recepção de amigo (peerA): 10 s · VP9 libvpx 1280x720 · 30,0 fps em média · congelou 0x · 0 descartados · perda média 1,0% · "
        + "mediana 1000 kbps · buffer médio 50 ms · áudio ocultado 0,1%";
    assert.deepEqual(all.slice(-2), [summary, "Parou de assistir amigo (peerA)"], "o resumo antes do fim");
});

test("o amigo para de transmitir: o resumo sai uma vez, e nada mais depois", async t => {
    const clock = useFakeClock(t);
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    playing(clock, pc);
    await read();
    await every2s(clock, 1);
    const lines = logMark();
    onPresence("peerA", { v: PROTOCOL_VERSION, discordUserId: FRIEND_ID, username: "amigo", streaming: false, caps: { h264HwDecode: false } });
    assert.equal(lines().filter(l => l.startsWith("Resumo da recepção de amigo (peerA): 2 s · ")).length, 1);
    unwatch("peerA");
    await every2s(clock, 6);
    assert.deepEqual(lines().filter(l => STATS_LINE_RE.test(l)).length, 1);
});

test("sem transmissao assistida: nenhuma linha", async t => {
    const clock = useFakeClock(t);
    addStreamer(room, "peerA");
    const lines = logMark();
    await every2s(clock, 10);
    watch("peerA");
    await every2s(clock, 9);
    assert.deepEqual(lines().filter(l => STATS_LINE_RE.test(l)), [], "pedido sem stream: nada a medir");
});
