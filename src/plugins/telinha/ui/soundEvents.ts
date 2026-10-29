/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PURE rules for the join/leave sounds: which sound (if any) a state change should play. ui/sounds.ts subscribes to the
// store, calls advanceSounds() on every snapshot and plays what comes back. Nothing here imports Vencord, webpack or the
// DOM, so soundEvents.test.ts runs under plain node (type imports only). Time is a parameter (`now`, ms) and the pending
// "left" timers are plain data (SoundMemory.pendingLeft + SoundStep.wakeAt): the caller schedules ONE timer for wakeAt
// and calls flushSounds() when it fires.
//
// What plays (names are Discord's own sound names):
//  - stream_user_joined / stream_user_left: someone starts/stops watching MY stream (local.viewers). Viewers are tracked by
//    discordUserId (a reconnect gets a new peerId); "left" waits LEFT_DEBOUNCE_MS and is dropped if the same person is back.
//  - stream_started / stream_ended: a peer that is admitted and in my voice channel flips streaming false -> true / true -> false.
// What stays silent: the first snapshot, my own stream ending (nobody "left" then), a peer already streaming when first seen,
// a streamer that leaves the room or stops being admitted/in voice, and anything within MIN_GAP_MS of the previous sound.

import type { PeerId } from "@plugins/telinha/types";

export type SoundName = "stream_user_joined" | "stream_user_left" | "stream_started" | "stream_ended";

/**
 * How each event sounds. Four events, four different sounds, never one shared sound for both directions:
 *  - `discord`: Discord's own sound file name (a separate file per event)
 *  - `chime`: the WebAudio fallback. joined = two short bright notes going UP, left = two lower, softer notes going DOWN,
 *    started = three quick notes UP, ended = three quick notes DOWN; the waveform differs too (triangle/sine/square/triangle)
 */
export interface ChimeSpec {
    /** Hz, in order */
    notes: readonly number[];
    wave: "sine" | "triangle" | "square";
    /** gain at the top of each note (soft; square is perceptually louder, so it is lower) */
    peak: number;
    /** length of each note and the time between two note starts, seconds (the whole chime stays under ~250 ms) */
    noteS: number;
    stepS: number;
}

export const SOUND_DEFS: Readonly<Record<SoundName, { discord: string; chime: ChimeSpec; }>> = {
    stream_user_joined: { discord: "stream_user_joined", chime: { notes: [660, 990], wave: "triangle", peak: 0.07, noteS: 0.1, stepS: 0.09 } },
    stream_user_left: { discord: "stream_user_left", chime: { notes: [520, 350], wave: "sine", peak: 0.06, noteS: 0.13, stepS: 0.1 } },
    stream_started: { discord: "stream_started", chime: { notes: [440, 587.33, 880], wave: "square", peak: 0.03, noteS: 0.07, stepS: 0.06 } },
    stream_ended: { discord: "stream_ended", chime: { notes: [587.33, 440, 293.66], wave: "triangle", peak: 0.06, noteS: 0.07, stepS: 0.06 } }
};

/** "left" is held this long; the same Discord user coming back inside the window cancels it (nothing plays at all) */
export const LEFT_DEBOUNCE_MS = 1500;
/** at most one sound per this window, whatever the event */
export const MIN_GAP_MS = 400;
/**
 * A peer that becomes eligible (admitted + in voice) may already be streaming, but its presence reaches us a moment later
 * (the snapshot shows streaming:false until then, up to the identity check timeout), so a false -> true flip this soon after
 * we first saw the peer is its initial presence, not a stream that just started.
 */
export const PEER_SETTLE_MS = 10_000;

/** The part of TelinhaState the rules read (TelinhaState is assignable to it) */
export interface SoundInput {
    local: { viewers: readonly PeerId[]; } | null;
    peers: readonly { peerId: PeerId; discordUserId: string; streaming: boolean; admitted: boolean; inVoice?: boolean; }[];
}

export interface SoundMemory {
    /** my stream was on */
    live: boolean;
    /** Discord ids watching my stream (empty unless live) */
    viewers: ReadonlySet<string>;
    /** admitted peers in my voice channel: whether they stream, and when we first saw them like that (ms) */
    peers: ReadonlyMap<PeerId, { streaming: boolean; since: number; }>;
    /** Discord id of someone who stopped watching -> when their "left" sound is due, unless they are back first (ms) */
    pendingLeft: ReadonlyMap<string, number>;
    /** when the last sound was let through (ms; -Infinity = none yet) */
    lastPlayedAt: number;
}

export interface SoundStep {
    memory: SoundMemory;
    /** sounds to play now, already rate limited (so at most one) */
    events: SoundName[];
    /** when to call flushSounds() next (ms), or null when nothing is pending */
    wakeAt: number | null;
}

function nextWake(pendingLeft: ReadonlyMap<string, number>): number | null {
    let wake: number | null = null;
    for (const due of pendingLeft.values()) if (wake == null || due < wake) wake = due;
    return wake;
}

/** Splits the pending "left" entries into those due at `now` and the rest */
function takeDue(pendingLeft: ReadonlyMap<string, number>, now: number) {
    const rest = new Map<string, number>();
    let due = 0;
    for (const [user, at] of pendingLeft) {
        if (at <= now) due++;
        else rest.set(user, at);
    }
    return { rest, due };
}

/** Keeps at most one candidate, and only if the previous sound is old enough */
function rateLimit(candidates: SoundName[], lastPlayedAt: number, now: number) {
    if (!candidates.length || now - lastPlayedAt < MIN_GAP_MS) return { events: [] as SoundName[], lastPlayedAt };
    return { events: [candidates[0]], lastPlayedAt: now };
}

/**
 * One state change. `prev` null = the first snapshot: it is only remembered (silent). `input` is the new state.
 * Returns what to play now and the memory to pass back next time.
 */
export function advanceSounds(prev: SoundMemory | null, input: SoundInput, now: number): SoundStep {
    const live = input.local != null;

    // who watches me, by Discord id (a peerId missing from peers would be a bug; keyed by the peerId so it still counts once)
    const viewers = new Set<string>();
    if (input.local) {
        const userOf = new Map(input.peers.map(p => [p.peerId, p.discordUserId]));
        for (const id of input.local.viewers) viewers.add(userOf.get(id) ?? `peer:${id}`);
    }

    // peers that count for "stream started/ended": admitted and in my voice channel. Anyone else is ignored (as if gone)
    const peers = new Map<PeerId, { streaming: boolean; since: number; }>();
    for (const p of input.peers) {
        if (!p.admitted || !p.inVoice) continue;
        peers.set(p.peerId, { streaming: p.streaming, since: prev?.peers.get(p.peerId)?.since ?? now });
    }

    if (!prev) {
        return { memory: { live, viewers, peers, pendingLeft: new Map(), lastPlayedAt: Number.NEGATIVE_INFINITY }, events: [], wakeAt: null };
    }

    const candidates: SoundName[] = [];

    // 1) people who joined/left a live room
    let pendingLeft = new Map<string, number>();
    let dueLeft = 0;
    // (my stream off, or just stopped: nobody "left", and anything still waiting is dropped)
    if (live) {
        const taken = takeDue(prev.pendingLeft, now);
        pendingLeft = taken.rest;
        dueLeft = taken.due;
        if (prev.live) {
            for (const user of viewers) {
                if (prev.viewers.has(user)) continue;
                if (pendingLeft.delete(user)) continue; // back inside the window: nothing at all
                candidates.push("stream_user_joined");
            }
            for (const user of prev.viewers) {
                if (!viewers.has(user) && !pendingLeft.has(user)) pendingLeft.set(user, now + LEFT_DEBOUNCE_MS);
            }
        }
        // (a stream that just started only baselines: viewers cannot be there before it exists)
    }

    // 2) peers that started/stopped streaming. A peer first seen (or first seen eligible) is only remembered
    const peerSounds: SoundName[] = [];
    for (const [id, cur] of peers) {
        const before = prev.peers.get(id);
        if (!before) continue;
        if (!before.streaming && cur.streaming && now - before.since >= PEER_SETTLE_MS) peerSounds.push("stream_started");
        else if (before.streaming && !cur.streaming) peerSounds.push("stream_ended");
    }

    // priority when several land in the same step: the stream itself, then viewers, then a "left" that came due
    const all = [...peerSounds, ...candidates];
    if (dueLeft) all.push("stream_user_left");

    const limited = rateLimit(all, prev.lastPlayedAt, now);
    return {
        memory: { live, viewers, peers, pendingLeft, lastPlayedAt: limited.lastPlayedAt },
        events: limited.events,
        wakeAt: nextWake(pendingLeft)
    };
}

/** The caller's timer for SoundStep.wakeAt fired: plays the "left" sounds that are due (no state change involved) */
export function flushSounds(prev: SoundMemory, now: number): SoundStep {
    const { rest, due } = takeDue(prev.pendingLeft, now);
    const limited = rateLimit(due && prev.live ? ["stream_user_left"] : [], prev.lastPlayedAt, now);
    return {
        memory: { ...prev, pendingLeft: rest, lastPlayedAt: limited.lastPlayedAt },
        events: limited.events,
        wakeAt: nextWake(rest)
    };
}
