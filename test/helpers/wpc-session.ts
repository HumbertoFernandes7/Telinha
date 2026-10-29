/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-C: the real session in a voice call, as test/harness.test.ts builds it, for the tests that check what a setting
// or an action does to the live core (settings wiring, actions). Real timers: wait with eventually().
//
//   const call = await joinCall();                      // plugin started, in the voice channel, room joined
//   await friendArrives(call.room, "peerA");            // handshake + presence, admitted
//   await goLive();                                     // startStreaming (screen, 1080p60, everybody)
//   call.close();                                       // in after(): stops everything the call started

import { startSession, startStreaming, stopSession } from "@plugins/telinha/actions";
import { buildHello, PROTOCOL_VERSION } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import type { StreamOptions } from "@plugins/telinha/types";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { FRIEND_ID, joinVoice, makeUser, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";

export interface Call {
    room: FakeRoom;
    rtc: WebRtcEnv;
    native: NativeEnv;
    /** stops the plugin and puts the globals back */
    close(): void;
}

/** Starts the plugin, joins the voice channel with `users` and waits for the room. */
export async function joinCall(opts: { users?: string[]; native?: Parameters<typeof installNative>[0]; } = {}): Promise<Call> {
    const rtc = installWebRtc();
    const native = installNative(opts.native);
    UserStore.addUsers(makeUser(FRIEND_ID, "amigo"));
    const roomsBefore = trystero.rooms.length;
    startSession();
    joinVoice(VOICE_CHANNEL_ID, { users: opts.users ?? [FRIEND_ID] });
    const room = await eventually(() => trystero.rooms.length > roomsBefore && trystero.lastRoom);
    await eventually(() => getState().inRoom);
    return {
        room, rtc, native,
        close() {
            stopSession();
            native.restore();
            rtc.restore();
        }
    };
}

/** A friend arrives: handshake, join and a presence message; resolves with his connection once the plugin lists him. */
export async function friendArrives(
    room: FakeRoom, peerId: string, opts: { discordUserId?: string; username?: string; streaming?: boolean; } = {}
): Promise<FakeRTCPeerConnection> {
    const discordUserId = opts.discordUserId ?? FRIEND_ID;
    const username = opts.username ?? "amigo";
    const { pc } = await room.connectPeer(peerId, { hello: buildHello(discordUserId, username) });
    room.receive("presence", {
        v: PROTOCOL_VERSION, discordUserId, username, streaming: !!opts.streaming,
        ...(opts.streaming ? { stream: { kind: "screen", title: "Tela", hasAudio: false, width: 1920, height: 1080, fps: 60 } } : {}),
        caps: { h264HwDecode: false }
    }, peerId);
    await eventually(() => getState().peers.find(p => p.peerId === peerId));
    return pc as unknown as FakeRTCPeerConnection;
}

/** Starts streaming the whole screen (what the source picker's "Transmitir" does). */
export function goLive(opts: Partial<StreamOptions> = {}) {
    return startStreaming({ source: { id: "screen:0:0", name: "Tela", kind: "screen" }, quality: "1080p60", withAudio: false, access: "all", ...opts });
}
