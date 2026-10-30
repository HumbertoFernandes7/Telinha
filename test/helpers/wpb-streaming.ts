/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-B: harness of core/streaming.ts shared by its test files (streaming*.test.ts). The whole core runs through the
// fakes, like test/harness.test.ts, but with ONE fake clock for the whole file (createRig turns it on before
// startSession): the session's 1 s ticker (→ streaming.tick) then only runs when a test advances the clock, so the
// encoder checks, the refusals and the auto quality (every 2 ticks) happen exactly when the test says. Real timers
// would fire that ticker in the middle of a test.
//
// With the fake clock, `eventually()` cannot be used (it waits with setTimeout): `waitFor()` below waits with
// setImmediate only (promises, crypto.subtle and the fakes' async methods settle in real macrotasks).

import "@test/fakes/dom";

import { rt } from "@plugins/telinha/core/context";
import { startSession, stopSession } from "@plugins/telinha/core/session";
import { stopStreaming } from "@plugins/telinha/core/streaming";
import { buildHello, PROTOCOL_VERSION } from "@plugins/telinha/protocol";
import { getEventLog, type TelinhaEvent } from "@plugins/telinha/store";
import type { StreamOptions } from "@plugins/telinha/types";
import { type FakeClock, useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { joinVoice, ME_ID, setVoiceMembers, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, type FakeRTCRtpSender, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";

// the DOM fakes the streaming tests drive (the capture monitor's <video> and canvas): re-exported so a test file needs
// only the side-effect `import "@test/fakes/dom"` at its top (that import must load before @test/fakes/webrtc)
export { canvas2d, media } from "@test/fakes/dom";

/** Lets `n` real macrotask turns run (promise chains, crypto.subtle, the fakes' async methods). */
export async function turns(n = 10): Promise<void> {
    for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve));
}

/** Like eventually(), but waits with setImmediate only (works with the fake clock on). Rejects after `timeoutMs` of wall time. */
export async function waitFor<T>(check: () => T | null | undefined | false | 0 | "", timeoutMs = 2000): Promise<T> {
    const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
    for (;;) {
        const value = check();
        if (value) return value;
        if (process.hrtime.bigint() > deadline) throw new Error(`waitFor: condition still false after ${timeoutMs} ms: ${check.toString().slice(0, 200)}`);
        await new Promise(resolve => setImmediate(resolve));
    }
}

/** Log lines (getEventLog) written since this call: `const since = logMark(); ...; since()`. */
export function logMark(): () => string[] {
    const seen = new Set<TelinhaEvent>(getEventLog());
    return () => getEventLog().filter(e => !seen.has(e)).map(e => e.msg);
}

export interface StreamingRig {
    rtc: WebRtcEnv;
    native: NativeEnv;
    clock: FakeClock;
    /** the room of the current voice channel (set by enterCall) */
    room: FakeRoom;
    /** discord ids in the voice channel besides ME_ID */
    readonly members: Set<string>;
}

/**
 * Fakes + the fake clock + startSession (not in a call yet). `beforeSession` runs before startSession, e.g. to say
 * this PC encodes H.264 on the GPU (the session probes the codecs once, at start).
 */
export function createRig(opts: { beforeSession?: (rtc: WebRtcEnv) => void; } = {}): StreamingRig {
    const rtc = installWebRtc();
    const native = installNative();
    const clock = useFakeClock();
    opts.beforeSession?.(rtc);
    startSession();
    return { rtc, native, clock, room: null as unknown as FakeRoom, members: new Set() };
}

export async function destroyRig(rig: StreamingRig) {
    stopStreaming();
    stopSession();
    await turns();
    rig.clock.restore();
    rig.native.restore();
    rig.rtc.restore();
}

/** Joins the voice channel (with `members` in it) and waits for the session to enter its room. */
export async function enterCall(rig: StreamingRig, members: string[] = [...rig.members]): Promise<FakeRoom> {
    for (const id of members) rig.members.add(id);
    const before = trystero.rooms.length;
    joinVoice(VOICE_CHANNEL_ID, { users: [...rig.members] });
    rig.clock.tick(1); // the session reacts in a setTimeout(0)
    rig.room = await waitFor(() => trystero.rooms.length > before && (rt.room as unknown) === trystero.lastRoom && trystero.lastRoom);
    return rig.room;
}

/** Leaves the voice channel (the session closes the room in a setTimeout(0)). */
export async function leaveCall(rig: StreamingRig) {
    joinVoice(null);
    rig.clock.tick(1);
    await waitFor(() => !rt.room);
}

/** Who is in the voice channel now (besides ME_ID); the session re-evaluates admission in a setTimeout(0). */
export function setMembers(rig: StreamingRig, ids: string[]) {
    rig.members.clear();
    for (const id of ids) rig.members.add(id);
    setVoiceMembers(VOICE_CHANNEL_ID, [ME_ID, ...ids]);
    rig.clock.tick(1);
}

export interface ViewerOptions {
    /** what his presence says about H.264 decoding (default false) */
    h264HwDecode?: boolean;
    /** false = not in the voice channel (not admitted with "Recusar quem não está na call") */
    inVoice?: boolean;
    /** false = no presence message (username only from the hello) */
    presence?: boolean;
}

/** A peer arrives in the room: in the voice channel (unless inVoice: false), handshake, join, presence. */
export async function connectViewer(rig: StreamingRig, peerId: string, discordUserId: string, username: string, opts: ViewerOptions = {}): Promise<FakeRTCPeerConnection> {
    if (opts.inVoice !== false && !rig.members.has(discordUserId)) setMembers(rig, [...rig.members, discordUserId]);
    const { pc } = await rig.room.connectPeer(peerId, { hello: buildHello(discordUserId, username) });
    if (opts.presence !== false) {
        rig.room.receive("presence", { v: PROTOCOL_VERSION, discordUserId, username, streaming: false, caps: { h264HwDecode: opts.h264HwDecode === true } }, peerId);
    }
    return pc as unknown as FakeRTCPeerConnection;
}

/** What we answered `peerId` on the "watch" action, oldest first. */
export function repliesTo(room: FakeRoom, peerId: string): any[] {
    return room.sentOn("watch", peerId).filter(m => m.target === peerId).map(m => m.data);
}

/** addStream calls that targeted `peerId`. */
export function streamsTo(room: FakeRoom, peerId: string) {
    return room.streamsAdded.filter(c => c.target === peerId);
}

/** removeStream calls that targeted `peerId` (alone or in a list). */
export function removalsFrom(room: FakeRoom, peerId: string) {
    return room.streamsRemoved.filter(c => c.target === peerId || (Array.isArray(c.target) && c.target.includes(peerId)));
}

/** The sender that currently sends our video track to this connection (null if none). */
export function videoSenderOf(pc: FakeRTCPeerConnection): FakeRTCRtpSender | null {
    return [...pc.getSenders()].reverse().find(s => s.track?.kind === "video") ?? null;
}

/** One second of the session's ticker (streaming.tick) per `n`, letting the promises it starts settle. */
export async function seconds(rig: StreamingRig, n = 1) {
    for (let i = 0; i < n; i++) {
        rig.clock.tick(1000);
        await turns();
    }
}

/** Stream options: the whole screen at 1080p60, no audio, "Todos da call" (override any field). */
export function screenOptions(over: Partial<StreamOptions> = {}): StreamOptions {
    return { source: { id: "screen:0:0", name: "Tela inteira", kind: "screen" }, quality: "1080p60", withAudio: false, access: "all", ...over };
}

/** A window source (its audio comes with getDisplayMedia). */
export function windowOptions(over: Partial<StreamOptions> = {}): StreamOptions {
    return { source: { id: "window:1234:0", name: "Jogo", kind: "window" }, quality: "1080p60", withAudio: false, access: "all", ...over };
}
