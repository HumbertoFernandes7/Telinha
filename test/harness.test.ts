/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Self-test of the harness (test/fakes): the whole core driven only through the fakes, as the work packages will.
// Join a voice channel → the room → a friend's handshake and presence → stream → the friend asks to watch → approve
// → the stream goes to his connection with the sender parameters applied → stop. Also a template to copy from.

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { approveViewer, startSession, startStreaming, stopSession, stopStreaming } from "@plugins/telinha/actions";
import { buildHello, PROTOCOL_VERSION } from "@plugins/telinha/protocol";
import { settings } from "@plugins/telinha/settings";
import { getEventLog, getState } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { trystero } from "@test/fakes/trystero";
import { FluxDispatcher, FRIEND_ID, joinVoice, makeUser, ME_ID, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";

describe("harness: the core through the fakes", () => {
    let rtc: WebRtcEnv;
    let native: NativeEnv;

    before(() => {
        rtc = installWebRtc();
        native = installNative();
        UserStore.addUsers(makeUser(FRIEND_ID, "amigo"));
    });

    after(() => {
        stopSession();
        native.restore();
        rtc.restore();
    });

    test("settings come with Vencord's defaults", () => {
        assert.equal(settings.store.defaultQuality, "1080p60");
        assert.equal(settings.store.rejectOutsiders, true);
        assert.equal(settings.store.codec, "auto");
    });

    test("join a voice channel: the session enters the channel's room", async () => {
        startSession();
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 1);
        joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
        const room = await eventually(() => trystero.lastRoom);
        assert.equal(room.config.appId, "telinha-v1");
        assert.ok(room.config.rtcPolyfill, "the plugin's RTCPeerConnection goes to Trystero");
        await eventually(() => getState().inRoom && getState().channelId === VOICE_CHANNEL_ID);
    });

    test("a friend's handshake and presence: he is admitted and listed", async () => {
        const room = trystero.lastRoom!;
        const { sentHello } = await room.connectPeer("peerA", { hello: buildHello(FRIEND_ID, "amigo") });
        assert.deepEqual({ ...sentHello as object, idToken: undefined }, { type: "telinha-hello", v: PROTOCOL_VERSION, discordUserId: ME_ID, username: "eu", idToken: undefined });
        assert.equal(room.sentOn("presence", "peerA").length, 1, "our presence went to him");

        room.receive("presence", { v: PROTOCOL_VERSION, discordUserId: FRIEND_ID, username: "amigo", streaming: false, caps: { h264HwDecode: false } }, "peerA");
        const peer = await eventually(() => getState().peers.find(p => p.peerId === "peerA"));
        assert.equal(peer.admitted, true);
        assert.equal(peer.identity, "unverified", "no id_token in his hello");
    });

    test("stream, the friend asks to watch, approve: the stream goes to his connection", async () => {
        const room = trystero.lastRoom!;
        await startStreaming({ source: { id: "screen:0:0", name: "Tela", kind: "screen" }, quality: "1080p60", withAudio: false, access: "all" });
        assert.deepEqual(native.calls.map(c => c.name).slice(0, 2), ["prepareDisplayMedia", "finishDisplayMedia"]);
        assert.equal(rtc.mediaDevices.displayMediaCalls.length, 1);
        assert.ok(room.sentOn("presence", "peerA").some(m => m.data.streaming === true), "presence says we are streaming");

        // unverified + "Exigir identidade verificada" (default on): the request waits for Permitir/Recusar
        room.receive("watch", { op: "start" }, "peerA");
        assert.deepEqual(room.sentOn("watch", "peerA").at(-1)?.data, { op: "pending" });
        await eventually(() => getState().local?.pendingViewers?.length === 1);

        assert.equal(approveViewer("peerA"), true);
        assert.equal(room.streamsAdded.length, 1);
        const pc = room.peers.get("peerA") as unknown as FakeRTCPeerConnection;
        const sender = await eventually(() => pc.getSenders().find(s => s.setCalls.length));
        assert.equal(sender.encoding.maxBitrate, 20_000_000);
        assert.equal(sender.params.degradationPreference, "maintain-framerate");
        await eventually(() => getState().local?.viewers.includes("peerA"));
    });

    test("stop streaming and leave: the stream is removed and the room left", async () => {
        const room = trystero.lastRoom!;
        stopStreaming();
        assert.equal(room.streamsRemoved.length, 1);
        stopSession();
        await eventually(() => room.left); // Trystero's leave() is chained after the sync part of the exit
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 0);
        assert.ok(getEventLog().some(e => /Sessão encerrada/.test(e.msg)));
    });
});
