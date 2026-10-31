/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do "Colchão contra engasgos" (core/viewing.ts → applyCushion, settings.jitterCushion): o jitterBufferTarget dos
// receivers de video E de audio do stream assistido, aplicado quando o stream chega, de novo quando a renegociacao troca
// ou zera o receiver (a cada leitura de 2 s) e quando a opcao muda; Chromium sem a propriedade ou que recusa o valor.
// Tambem o marcador do Teredo na linha de recepcao.
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.cushion.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import type { FakeRoom } from "@test/fakes/trystero";
import { pluginSettings } from "@test/fakes/vencord";
import { type FakeMediaStreamTrack, type FakeRTCPeerConnection, type FakeRTCRtpReceiver, videoReceiverStats } from "@test/fakes/webrtc";
import { addStreamer, closeRoom, incomingStream, logMark, openRoom, receiveOn } from "@test/helpers/wpc-viewing";

import { STATS_LINE_RE } from "./statsLog";
import { cushionMs, DEFAULT_CUSHION_MS, onJitterCushionChanged, onPeerStream, sampleStats, watch } from "./viewing";

let room: FakeRoom;

beforeEach(() => {
    room = openRoom();
});

afterEach(() => {
    closeRoom();
    pluginSettings.set("jitterCushion", DEFAULT_CUSHION_MS);
});

/** O stream de `peerId` chegando, com um receiver de video e um de audio. */
function arrive(pc: FakeRTCPeerConnection, peerId = "peerA") {
    const { stream, fake, audio } = incomingStream({ audio: true });
    const video = receiveOn(pc, fake);
    const sound = pc.getReceivers().find(r => r.track === (audio as FakeMediaStreamTrack))!;
    return { stream, video, sound, go: () => onPeerStream(peerId, stream, { kind: STREAM_KIND_SCREEN }) };
}

const targets = (...rs: FakeRTCRtpReceiver[]) => rs.map(r => r.jitterBufferTarget);

test("o padrao e 0,2 s, aplicado no video e no audio quando o stream chega (uma linha no log)", () => {
    assert.equal(DEFAULT_CUSHION_MS, 200);
    assert.equal(cushionMs(), 200);
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { video, sound, go } = arrive(pc);
    const lines = logMark();
    go();
    assert.deepEqual(targets(video, sound), [200, 200]);
    assert.deepEqual(lines().filter(l => l.includes("colchão")), ["Assistir amigo (peerA): colchão contra engasgos de 0,2 s no vídeo e no áudio"]);
});

test("a opcao muda: vale ja para o que esta sendo assistido; Desligado volta ao padrao do Chromium (null)", () => {
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { video, sound, go } = arrive(pc);
    go();
    const lines = logMark();
    pluginSettings.set("jitterCushion", 400);
    assert.deepEqual(targets(video, sound), [400, 400]);
    pluginSettings.set("jitterCushion", 0);
    assert.equal(cushionMs(), null);
    assert.deepEqual(targets(video, sound), [null, null]);
    assert.deepEqual(lines().filter(l => l.includes("colchão")), [
        "Assistir amigo (peerA): colchão contra engasgos de 0,4 s no vídeo e no áudio",
        "Assistir amigo (peerA): colchão contra engasgos desligado"
    ]);
    // valor estranho salvo (ou maior que o Chromium aceita): o padrao / o maximo; negativo: desligado
    pluginSettings.set("jitterCushion", "x" as unknown as number);
    assert.equal(cushionMs(), 200);
    pluginSettings.set("jitterCushion", 9000);
    assert.equal(cushionMs(), 4000);
    pluginSettings.set("jitterCushion", -5);
    assert.equal(cushionMs(), null);
});

test("renegociacao: um receiver novo (ou que voltou ao padrao) recebe o colchao na leitura seguinte, sem repetir o log", async t => {
    useFakeClock(t);
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { fake, video: track } = incomingStream({ audio: true });
    const video = receiveOn(pc, fake);
    onPeerStream("peerA", fake as unknown as MediaStream, { kind: STREAM_KIND_SCREEN });
    const lines = logMark();
    video.jitterBufferTarget = null;
    const fresh = pc.addReceivingTrack(track).receiver;
    fresh.stats = videoReceiverStats();
    sampleStats();
    await flushPromises();
    assert.deepEqual(targets(video, fresh), [200, 200]);
    assert.deepEqual(lines().filter(l => l.includes("colchão")), []);
});

test("Chromium sem jitterBufferTarget: uma linha (info) e nada muda; um receiver que recusa o valor: aviso, o outro fica com ele", async () => {
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const old = arrive(pc);
    delete (old.video as { jitterBufferTarget?: unknown; }).jitterBufferTarget;
    const lines = logMark();
    old.go();
    onJitterCushionChanged();
    sampleStats();
    await flushPromises();
    assert.deepEqual(lines().filter(l => l.includes("colchão")), ["Assistir amigo (peerA): este Discord não tem o colchão contra engasgos (jitterBufferTarget)"]);
    assert.equal(old.sound.jitterBufferTarget, null, "nem o audio, para os dois ficarem juntos");

    closeRoom();
    room = openRoom();
    const pc2 = addStreamer(room, "peerA");
    watch("peerA");
    const picky = arrive(pc2);
    Object.defineProperty(picky.sound, "jitterBufferTarget", {
        configurable: true,
        get: () => null,
        set: () => {
            throw new RangeError("value out of range");
        }
    });
    const lines2 = logMark();
    picky.go();
    assert.equal(picky.video.jitterBufferTarget, 200);
    assert.deepEqual(lines2().filter(l => l.includes("colchão")), [
        "Assistir amigo (peerA): o colchão contra engasgos não foi aplicado no áudio (RangeError: value out of range)",
        "Assistir amigo (peerA): colchão contra engasgos de 0,2 s no vídeo e no áudio"
    ]);

    // o video recusando (e o audio sem o colchao, entao nada foi aplicado): so o aviso
    closeRoom();
    room = openRoom();
    const pc3 = addStreamer(room, "peerB");
    watch("peerB");
    const both = arrive(pc3, "peerB");
    for (const r of [both.video, both.sound]) {
        Object.defineProperty(r, "jitterBufferTarget", {
            configurable: true,
            get: () => null,
            set: () => {
                throw new RangeError("value out of range");
            }
        });
    }
    const lines3 = logMark();
    both.go();
    assert.deepEqual(lines3().filter(l => l.includes("colchão")), [
        "Assistir amigo (peerB): o colchão contra engasgos não foi aplicado no vídeo (RangeError: value out of range)"
    ], "o do audio fica para daqui a 10 min (o mesmo aviso por espectador)");
});

test("sem conexao ou sem stream: nada a aplicar", () => {
    addStreamer(room, "peerA");
    watch("peerA");
    room.peers.delete("peerA");
    onJitterCushionChanged();
    assert.ok(true);
});

test("linha de recepcao com a rota pelo Teredo (o par em uso nas estatisticas do receiver), sem endereco", async t => {
    const clock = useFakeClock(t);
    const pc = addStreamer(room, "peerA");
    watch("peerA");
    const { video, go } = arrive(pc);
    const start = clock.now();
    const s = () => (clock.now() - start) / 1000;
    video.stats = () => [
        ...videoReceiverStats({ framesDecoded: 30 * s(), bytesReceived: 125_000 * s() }),
        { id: "T", type: "transport", selectedCandidatePairId: "CP" },
        { id: "CP", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" },
        { id: "L", type: "local-candidate", address: "2001:0:4136:e378:8000:63bf:3fff:fdd2" },
        { id: "R", type: "remote-candidate", address: "203.0.113.7" }
    ];
    go();
    const lines = logMark();
    for (let i = 0; i <= 5; i++) {
        if (i) clock.tick(2000);
        sampleStats();
        await flushPromises();
    }
    const [line] = lines().filter(l => STATS_LINE_RE.test(l));
    assert.match(line, / · colchão 200 ms · .* · rota via Teredo \(este PC\)$/);
    assert.doesNotMatch(line, /2001|203\.0/);
});
