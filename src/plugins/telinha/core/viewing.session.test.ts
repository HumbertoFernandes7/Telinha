/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Assistir de ponta a ponta pela sessao de verdade (core/session.ts liga o Trystero ao core/viewing.ts): entra no
// canal de voz, o amigo chega e anuncia que transmite, a pessoa pede, o amigo responde "pending", o stream chega, o
// primeiro quadro e detectado (relogio real de 150 ms) e o amigo para de transmitir. Tambem confere que o que vem da
// rede e hostil: resposta com formato errado e stream com tipo desconhecido nao fazem nada.
// Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/core/viewing.session.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { startSession, stopSession } from "@plugins/telinha/actions";
import { buildHello, PROTOCOL_VERSION, STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { FRIEND_ID, joinVoice, makeUser, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { captureStream, type FakeRTCPeerConnection, installWebRtc, videoReceiverStats, type WebRtcEnv } from "@test/fakes/webrtc";

import { unwatch, watch } from "./viewing";

const presence = (streaming: boolean) => ({
    v: PROTOCOL_VERSION,
    discordUserId: FRIEND_ID,
    username: "amigo",
    streaming,
    ...(streaming ? { stream: { kind: "screen", title: "Tela", hasAudio: false, width: 1920, height: 1080, fps: 60 } } : {}),
    caps: { h264HwDecode: false }
});

describe("assistir pela sessao", () => {
    let rtc: WebRtcEnv;
    let native: NativeEnv;
    let room: FakeRoom;
    let pc: FakeRTCPeerConnection;

    before(async () => {
        rtc = installWebRtc();
        native = installNative();
        UserStore.addUsers(makeUser(FRIEND_ID, "amigo"));
        startSession();
        joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
        room = await eventually(() => trystero.lastRoom);
        ({ pc } = await room.connectPeer("peerA", { hello: buildHello(FRIEND_ID, "amigo") }) as unknown as { pc: FakeRTCPeerConnection; });
    });

    after(() => {
        stopSession();
        native.restore();
        rtc.restore();
    });

    const view = () => getState().viewing.peerA;
    const sentToPeer = () => room.sentOn("watch", "peerA").map(m => m.data);

    test("o amigo ainda nao transmite: pedir falha com a frase da tela", async () => {
        room.receive("presence", presence(false), "peerA");
        await eventually(() => getState().peers.find(p => p.peerId === "peerA")?.admitted);
        watch("peerA");
        await eventually(() => view()?.status === "error");
        assert.equal(view()?.error, "Esse amigo não está transmitindo agora.");
        unwatch("peerA");
    });

    test("pedir, o amigo responde 'pending', o stream chega e o primeiro quadro e detectado", async () => {
        room.receive("presence", presence(true), "peerA");
        await eventually(() => getState().peers.find(p => p.peerId === "peerA")?.streaming);

        watch("peerA");
        assert.deepEqual(sentToPeer().at(-1), { op: "start" });
        await eventually(() => view()?.status === "connecting");

        room.receive("watch", { op: "pending" }, "peerA");
        await eventually(() => view()?.awaitingApproval === true);

        const stream = captureStream();
        const sender = pc.addReceivingTrack(stream.getVideoTracks()[0]).receiver;
        sender.stats = videoReceiverStats({ framesDecoded: 4 });
        room.emitStream("peerA", stream as unknown as MediaStream, { kind: STREAM_KIND_SCREEN });
        await eventually(() => view()?.status === "playing");
        assert.equal(view()?.awaitingApproval, undefined);
        assert.equal(view()?.stream, stream);
    });

    test("o amigo para de transmitir: a sessao acaba", async () => {
        room.receive("presence", presence(false), "peerA");
        await eventually(() => view()?.status === "ended");
        assert.equal(view()?.stream, null);
        unwatch("peerA");
        await eventually(() => view() === undefined);
    });

    test("uma recusa pela rede chega a tela com o motivo", async () => {
        room.receive("presence", presence(true), "peerA");
        await eventually(() => getState().peers.find(p => p.peerId === "peerA")?.streaming);
        watch("peerA");
        room.receive("watch", { op: "denied", reason: "friendsOnly" }, "peerA");
        await eventually(() => view()?.denied === "friendsOnly");
        assert.equal(view()?.status, "error");
        unwatch("peerA");
    });

    test("dado hostil da rede e ignorado: resposta malformada, stream de outro tipo, stream sem pedido", async () => {
        watch("peerA");
        await eventually(() => view()?.status === "connecting");
        room.receive("watch", { op: "password", nonce: "curto" }, "peerA"); // nonce fora do formato: nao e uma resposta valida
        room.receive("watch", { op: "denied", reason: { toString: () => "kicked" } }, "peerA"); // motivo que nao e texto: vira "declined", nunca excecao
        room.emitStream("peerA", captureStream() as unknown as MediaStream, { kind: "outra-coisa" });
        await eventually(() => view()?.denied === "declined");
        assert.equal(view()?.stream, null, "o stream de outro tipo nao foi aceito");
        unwatch("peerA");

        const before = sentToPeer().length;
        room.emitStream("peerA", captureStream() as unknown as MediaStream, { kind: STREAM_KIND_SCREEN });
        assert.deepEqual(sentToPeer().slice(before), [{ op: "stop" }], "sem pedido: manda o transmissor parar");
    });
});
