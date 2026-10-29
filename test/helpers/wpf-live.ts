/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-F helper: a live Telinha session for the UI tests that need the REAL core behind a button (approve/decline/kick,
// "Aplicar" on the access picker, "Parar transmissão"...): joined voice channel, a Trystero room, friends who connect
// and ask to watch, and a stream going out. Everything runs through the fakes, like test/harness.test.ts.
//
//   const scene = await openLiveScene();            // in before()
//   await scene.connect("peerA", FRIEND_ID, "amigo");
//   await scene.goLive({ access: "approval" });
//   scene.askToWatch("peerA");
//   ...
//   scene.close();                                  // in after()
//
// Do NOT call resetVencordFakes() between tests of a live scene (it would empty the voice channel the core joined):
// use scene.resetUi() for the toasts and modals.

import { startSession, startStreaming, stopSession, stopStreaming } from "@plugins/telinha/actions";
import { buildHello, PROTOCOL_VERSION } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import type { AccessMode, Quality, RemotePeer } from "@plugins/telinha/types";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { FRIEND_ID, joinVoice, makeUser, modals, OTHER_ID, toasts, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";

export interface GoLiveOptions {
    access?: AccessMode;
    password?: string;
    quality?: Quality;
    kind?: "screen" | "window";
}

export interface LiveScene {
    rtc: WebRtcEnv;
    native: NativeEnv;
    room: FakeRoom;
    /** A friend's connection arrives: handshake (no id_token: "não verificado") and a presence that says "not streaming". */
    connect(peerId: string, userId?: string, username?: string): Promise<RemotePeer>;
    /** The connection of a peer that connected (stats, senders...). */
    pc(peerId: string): FakeRTCPeerConnection;
    /** Starts streaming (the capture picker's "Transmitir"). */
    goLive(opts?: GoLiveOptions): Promise<void>;
    /** The peer presses "Assistir": the request reaches the streamer (waits for Permitir in most modes). */
    askToWatch(peerId: string): void;
    /** Empties the toasts and the open modals (what resetVencordFakes does for them, without touching the voice channel). */
    resetUi(): void;
    /** Stops the stream, leaves the session, puts the fakes back. */
    close(): void;
}

/** Joins the voice channel with two friends in it and waits for the room. */
export async function openLiveScene(): Promise<LiveScene> {
    const rtc = installWebRtc();
    const native = installNative();
    UserStore.addUsers(makeUser(FRIEND_ID, "amigo", { globalName: "Amigo" }), makeUser(OTHER_ID, "outro"));

    startSession();
    joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID, OTHER_ID] });
    const room = await eventually(() => trystero.lastRoom);
    await eventually(() => getState().inRoom && getState().channelId === VOICE_CHANNEL_ID);

    const pcOf = (peerId: string) => room.peers.get(peerId) as unknown as FakeRTCPeerConnection;

    return {
        rtc,
        native,
        room,
        async connect(peerId, userId = FRIEND_ID, username = "amigo") {
            await room.connectPeer(peerId, { hello: buildHello(userId, username) });
            room.receive("presence", { v: PROTOCOL_VERSION, discordUserId: userId, username, streaming: false, caps: { h264HwDecode: false } }, peerId);
            return eventually(() => getState().peers.find(p => p.peerId === peerId));
        },
        pc: pcOf,
        async goLive({ access = "all", password, quality = "1080p60", kind = "screen" }: GoLiveOptions = {}) {
            const source = kind === "screen"
                ? { id: "screen:0:0", name: "Tela inteira", kind: "screen" as const }
                : { id: "window:1234:0", name: "Jogo", kind: "window" as const };
            await startStreaming({ source, quality, withAudio: false, access, ...(password !== undefined ? { password } : {}) });
            await eventually(() => getState().local);
        },
        askToWatch(peerId) {
            room.receive("watch", { op: "start" }, peerId);
        },
        resetUi() {
            toasts.length = 0;
            modals.reset();
        },
        close() {
            stopStreaming();
            stopSession();
            native.restore();
            rtc.restore();
        }
    };
}
