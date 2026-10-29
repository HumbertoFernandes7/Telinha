/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-C: a room with streamers in it, without the session. core/viewing.ts only needs what core/session.ts leaves in
// `rt` (the room, the "watch" action, the peers with their presence and the peers' connections), so the viewer tests
// put exactly that there and drive the module through its own exports, the fakes and the fake clock. The wiring from
// Trystero's callbacks to these exports is covered end to end in core/viewing.session.test.ts.
//
//   const room = openRoom();
//   const pc = addStreamer(room, "peerA");
//   watch("peerA");
//   room.sentOn("watch", "peerA")        // [{ op: "start" }]
//   await viewerOf("peerA")              // the ViewerSession the UI sees (after the microtask that publishes it)

import { clearAll } from "@plugins/telinha/core/viewing";
import { type PeerEntry, rt } from "@plugins/telinha/core/context";
import { buildHello, PROTOCOL_VERSION } from "@plugins/telinha/protocol";
import { getEventLog, getState, resetState } from "@plugins/telinha/store";
import type { ViewerSession } from "@plugins/telinha/types";
import { flushPromises } from "@test/fakes/clock";
import { type FakeRoom, joinRoom } from "@test/fakes/trystero";
import { FRIEND_ID } from "@test/fakes/vencord";
import { audioTrack, FakeMediaStream, FakeRTCPeerConnection, type FakeRTCRtpReceiver, videoReceiverStats, videoTrack } from "@test/fakes/webrtc";

export interface StreamerOptions {
    discordUserId?: string;
    username?: string;
    streaming?: boolean;
    admitted?: boolean;
    incompatible?: boolean;
    identity?: PeerEntry["identity"];
    /** no hello at all (a peer whose handshake was garbled) */
    noHello?: boolean;
}

/** A room as session.ts leaves it in `rt` (room + "watch" action). Call closeRoom() after the test. */
export function openRoom(): FakeRoom {
    const room = joinRoom({ appId: "telinha-v1" }, "wpc-room");
    rt.room = room as unknown as typeof rt.room;
    rt.watchAction = room.makeAction("watch") as unknown as typeof rt.watchAction;
    return room;
}

/** Forgets every viewer session and the room (what leaving the call does), and the published state. */
export function closeRoom() {
    clearAll();
    rt.room = null;
    rt.watchAction = null;
    rt.peers.clear();
    resetState();
}

/** A peer in the room, by default admitted and streaming. Returns its connection (the one getPc() finds). */
export function addStreamer(room: FakeRoom, peerId: string, opts: StreamerOptions = {}): FakeRTCPeerConnection {
    const pc = new FakeRTCPeerConnection({});
    room.peers.set(peerId, pc as unknown as RTCPeerConnection);
    const discordUserId = opts.discordUserId ?? FRIEND_ID;
    const username = opts.username ?? "amigo";
    const hello = opts.noHello ? null : buildHello(discordUserId, username);
    rt.peers.set(peerId, {
        peerId,
        hello,
        presence: opts.streaming === false
            ? { v: PROTOCOL_VERSION, discordUserId, username, streaming: false, caps: { h264HwDecode: false } }
            : { v: PROTOCOL_VERSION, discordUserId, username, streaming: true, caps: { h264HwDecode: false }, stream: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60 } },
        inVoice: true,
        incompatible: !!opts.incompatible,
        admitted: opts.admitted ?? true,
        duplicate: false,
        impostor: false,
        claimsSelf: false,
        identity: opts.identity ?? "unverified",
        identityChecking: false,
        identityCheckedAt: 0
    });
    return pc;
}

/** The ViewerSession the UI sees for `peerId` (waits for core/context.ts publish(), which runs in a microtask). */
export async function viewerOf(peerId: string): Promise<ViewerSession | undefined> {
    await flushPromises();
    return getState().viewing[peerId];
}

/** The core's event log lines written after this call (older lines of the same file are left out). */
export function logMark() {
    const start = getEventLog().length;
    return () => getEventLog().slice(start).map(e => e.msg);
}

/** What arrives from a streamer: a stream with one video track (and, with `audio`, an audio one). */
export function incomingStream(opts: { audio?: boolean; } = {}) {
    const video = videoTrack();
    const audio = opts.audio ? audioTrack() : null;
    const fake = new FakeMediaStream(audio ? [video, audio] : [video]);
    return { stream: fake as unknown as MediaStream, video, audio, fake };
}

/**
 * The receiving side of `stream` on the streamer's connection: one receiver per track, with the stats Chromium would
 * report (video: inbound-rtp with framesDecoded...). Returns the video receiver; set `.stats` to move the counters.
 */
export function receiveOn(pc: FakeRTCPeerConnection, stream: FakeMediaStream, init: Parameters<typeof videoReceiverStats>[0] = {}): FakeRTCRtpReceiver {
    let video: FakeRTCRtpReceiver | undefined;
    for (const track of stream.getTracks()) {
        const t = pc.addReceivingTrack(track);
        if (track.kind === "video") {
            t.receiver.stats = videoReceiverStats(init);
            video = t.receiver;
        }
    }
    if (!video) throw new Error("receiveOn: the stream has no video track");
    return video;
}

/**
 * Waits, one real macrotask at a time (setImmediate: it keeps working under useFakeClock), until `check()` is truthy.
 * For flows that wait on crypto.subtle, which settles off the event loop.
 */
export async function until<T>(check: () => T | null | undefined | false | 0 | "", ms = 3000): Promise<T> {
    const deadline = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
    for (;;) {
        const value = check();
        if (value) return value;
        if (process.hrtime.bigint() > deadline) throw new Error(`until: still false after ${ms} ms: ${check.toString().slice(0, 160)}`);
        await new Promise(resolve => setImmediate(resolve));
    }
}
