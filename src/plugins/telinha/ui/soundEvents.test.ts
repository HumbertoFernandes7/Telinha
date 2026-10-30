/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes das regras PURAS dos sons de entrar/sair (ui/soundEvents.ts): so o diff de estado e o tempo, sem som nenhum.
// Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/soundEvents.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    advanceSounds, flushSounds, LEFT_DEBOUNCE_MS, MIN_GAP_MS, PEER_SETTLE_MS, SOUND_DEFS, type SoundInput, type SoundMemory, type SoundName, type SoundStep
} from "./soundEvents";

type Peer = SoundInput["peers"][number];

const peer = (peerId: string, discordUserId: string, over: Partial<Peer> = {}): Peer => ({ peerId, discordUserId, streaming: false, admitted: true, inVoice: true, ...over });
const input = (over: Partial<SoundInput> = {}): SoundInput => ({ local: null, peers: [], ...over });
const live = (...viewers: string[]) => ({ viewers });

/** Plays the role of ui/sounds.ts: keeps the memory, feeds snapshots and fires the timer when its wake time is reached */
function sim() {
    let memory: SoundMemory | null = null;
    let wakeAt: number | null = null;
    const played: { at: number; name: SoundName; }[] = [];
    const record = (step: SoundStep, at: number) => {
        memory = step.memory;
        wakeAt = step.wakeAt;
        for (const name of step.events) played.push({ at, name });
        return step.events;
    };
    return {
        played,
        get memory() { return memory!; },
        get wakeAt() { return wakeAt; },
        /** a new snapshot at `now` */
        feed: (state: SoundInput, now: number) => record(advanceSounds(memory, state, now), now),
        /** the clock reaches `now`: fires the timer once if it was due (like setTimeout(wakeAt - now)) */
        tick(now: number) {
            return memory && wakeAt != null && wakeAt <= now ? record(flushSounds(memory, now), now) : [];
        },
        names: () => played.map(p => p.name)
    };
}

describe("first snapshot", () => {
    test("is silent, even with viewers and streamers already there", () => {
        const s = sim();
        const events = s.feed(input({ local: live("p1"), peers: [peer("p1", "u1"), peer("p2", "u2", { streaming: true })] }), 1000);
        assert.deepEqual(events, []);
        assert.equal(s.wakeAt, null);
        assert.deepEqual(s.names(), []);
    });
    test("an empty first snapshot, then the same state again, stays silent", () => {
        const s = sim();
        assert.deepEqual(s.feed(input(), 0), []);
        assert.deepEqual(s.feed(input(), 5000), []);
    });
});

describe("viewers of my stream", () => {
    test("a viewer joining plays stream_user_joined", () => {
        const s = sim();
        s.feed(input({ local: live(), peers: [peer("p1", "u1")] }), 0);
        assert.deepEqual(s.feed(input({ local: live("p1"), peers: [peer("p1", "u1")] }), 5000), ["stream_user_joined"]);
    });

    test("a viewer leaving plays stream_user_left only after the debounce", () => {
        const s = sim();
        const peers = [peer("p1", "u1")];
        s.feed(input({ local: live("p1"), peers }), 0);
        assert.deepEqual(s.feed(input({ local: live(), peers }), 10_000), []);
        assert.equal(s.wakeAt, 10_000 + LEFT_DEBOUNCE_MS);
        assert.deepEqual(s.tick(10_000 + LEFT_DEBOUNCE_MS - 1), []);
        assert.deepEqual(s.tick(10_000 + LEFT_DEBOUNCE_MS), ["stream_user_left"]);
        assert.equal(s.wakeAt, null);
        assert.deepEqual(s.tick(60_000), []);
    });

    test("a viewer who leaves the room (peer gone too) still counts as stopping to watch", () => {
        const s = sim();
        s.feed(input({ local: live("p1"), peers: [peer("p1", "u1")] }), 0);
        assert.deepEqual(s.feed(input({ local: live(), peers: [] }), 10_000), []);
        assert.deepEqual(s.tick(10_000 + LEFT_DEBOUNCE_MS), ["stream_user_left"]);
    });

    test("a viewer whose connection is not in the peer list yet counts once, by his connection id", () => {
        const s = sim();
        s.feed(input({ local: live(), peers: [] }), 0);
        assert.deepEqual(s.feed(input({ local: live("ghost"), peers: [] }), 5000), ["stream_user_joined"]);
        assert.deepEqual(s.feed(input({ local: live("ghost"), peers: [] }), 6000), [], "the same viewer again is not a new join");
    });

    test("reconnect with a new peerId for the same Discord user inside the window is silent", () => {
        const s = sim();
        s.feed(input({ local: live("p1"), peers: [peer("p1", "u1")] }), 0);
        // the old connection drops first
        assert.deepEqual(s.feed(input({ local: live(), peers: [] }), 10_000), []);
        // the new one (other peerId, same user) is back 800 ms later
        assert.deepEqual(s.feed(input({ local: live("p2"), peers: [peer("p2", "u1")] }), 10_800), []);
        assert.equal(s.wakeAt, null);
        assert.deepEqual(s.tick(10_000 + LEFT_DEBOUNCE_MS), []);
        assert.deepEqual(s.tick(60_000), []);
        assert.deepEqual(s.names(), []);
    });

    test("old and new connection swapped in the same snapshot is silent too", () => {
        const s = sim();
        s.feed(input({ local: live("p1"), peers: [peer("p1", "u1")] }), 0);
        assert.deepEqual(s.feed(input({ local: live("p2"), peers: [peer("p2", "u1")] }), 10_000), []);
        assert.equal(s.wakeAt, null);
    });

    test("coming back after the window: the left sound already played, then the join plays", () => {
        const s = sim();
        s.feed(input({ local: live("p1"), peers: [peer("p1", "u1")] }), 0);
        s.feed(input({ local: live(), peers: [] }), 10_000);
        assert.deepEqual(s.tick(10_000 + LEFT_DEBOUNCE_MS), ["stream_user_left"]);
        assert.deepEqual(s.feed(input({ local: live("p2"), peers: [peer("p2", "u1")] }), 10_000 + LEFT_DEBOUNCE_MS + MIN_GAP_MS), ["stream_user_joined"]);
    });

    test("one person with two connections counts once", () => {
        const s = sim();
        const peers = [peer("p1", "u1"), peer("p2", "u1")];
        s.feed(input({ local: live(), peers }), 0);
        assert.deepEqual(s.feed(input({ local: live("p1", "p2"), peers }), 5000), ["stream_user_joined"]);
        // one connection drops, the person is still watching: nothing
        assert.deepEqual(s.feed(input({ local: live("p2"), peers }), 10_000), []);
        assert.equal(s.wakeAt, null);
    });

    test("my own stream ending is silent: no left for each viewer", () => {
        const s = sim();
        const peers = [peer("p1", "u1"), peer("p2", "u2")];
        s.feed(input({ local: live("p1", "p2"), peers }), 0);
        assert.deepEqual(s.feed(input({ local: null, peers }), 10_000), []);
        assert.equal(s.wakeAt, null);
        assert.deepEqual(s.tick(60_000), []);
        assert.deepEqual(s.names(), []);
    });

    test("viewers emptied a moment before local goes null (stop sequence) stays silent", () => {
        const s = sim();
        const peers = [peer("p1", "u1"), peer("p2", "u2")];
        s.feed(input({ local: live("p1", "p2"), peers }), 0);
        s.feed(input({ local: live(), peers }), 10_000);
        assert.notEqual(s.wakeAt, null);
        assert.deepEqual(s.feed(input({ local: null, peers }), 10_200), []);
        assert.equal(s.wakeAt, null);
        assert.deepEqual(s.tick(60_000), []);
    });

    test("a pending left is dropped when the stream stops, and not replayed by the next stream", () => {
        const s = sim();
        const peers = [peer("p1", "u1")];
        s.feed(input({ local: live("p1"), peers }), 0);
        s.feed(input({ local: live(), peers }), 10_000);
        s.feed(input({ local: null, peers }), 10_100);
        s.feed(input({ local: live(), peers }), 20_000);
        assert.deepEqual(s.tick(60_000), []);
        assert.deepEqual(s.names(), []);
    });

    test("a stream that just started only baselines its viewers; the next join plays", () => {
        const s = sim();
        const peers = [peer("p1", "u1"), peer("p2", "u2")];
        s.feed(input({ local: null, peers }), 0);
        assert.deepEqual(s.feed(input({ local: live("p1"), peers }), 5000), []);
        assert.deepEqual(s.feed(input({ local: live("p1", "p2"), peers }), 6000), ["stream_user_joined"]);
    });
});

describe("friends streaming in the call", () => {
    test("a peer already streaming when first seen is silent", () => {
        const s = sim();
        s.feed(input(), 0);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 5000), []);
        // and still nothing while it keeps streaming
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 6000), []);
    });

    test("a peer whose presence arrives a moment after it joined (streaming false, then true) is silent", () => {
        const s = sim();
        s.feed(input(), 0);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1")] }), 5000), []);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 5000 + 300), []);
        assert.deepEqual(s.names(), []);
    });

    test("an eligible peer that starts streaming plays stream_started; stopping plays stream_ended", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1")] }), 0);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), PEER_SETTLE_MS + 1), ["stream_started"]);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1")] }), PEER_SETTLE_MS + 60_000), ["stream_ended"]);
    });

    test("the settle window: a flip just inside it is silent, later ones play", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1")] }), 1000);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 1000 + PEER_SETTLE_MS - 1), []);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1")] }), 1000 + PEER_SETTLE_MS + 5000), ["stream_ended"]);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 1000 + PEER_SETTLE_MS + 10_000), ["stream_started"]);
    });

    test("a streamer leaving the room is silent (no stream_ended)", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 0);
        assert.deepEqual(s.feed(input({ peers: [] }), 30_000), []);
        assert.deepEqual(s.names(), []);
    });

    test("a streamer that stops being admitted or leaves the voice channel is silent", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1"), peer("p2", "u2")] }), 0);
        s.feed(input({ peers: [peer("p1", "u1", { streaming: true }), peer("p2", "u2", { streaming: true })] }), 30_000);
        assert.deepEqual(s.names(), ["stream_started"]); // 1 sound for two starts in the same snapshot (rate limit)
        const before = s.names().length;
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true, admitted: false }), peer("p2", "u2", { streaming: true, inVoice: false })] }), 60_000), []);
        assert.equal(s.names().length, before);
    });

    test("a peer that returns while streaming (was gone or ineligible) is silent", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 0);
        s.feed(input({ peers: [peer("p1", "u1", { streaming: true, admitted: false })] }), 30_000);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 60_000), []);
    });

    test("not-admitted peers are ignored", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1", { admitted: false })] }), 0);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { admitted: false, streaming: true })] }), 30_000), []);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { admitted: false })] }), 60_000), []);
    });

    test("not-in-voice peers (inVoice false or missing) are ignored", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1", { inVoice: false }), peer("p2", "u2", { inVoice: undefined })] }), 0);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { inVoice: false, streaming: true }), peer("p2", "u2", { inVoice: undefined, streaming: true })] }), 30_000), []);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { inVoice: false }), peer("p2", "u2", { inVoice: undefined })] }), 60_000), []);
    });

    test("a peer that becomes eligible while already streaming is silent (it was not seen idle)", () => {
        const s = sim();
        s.feed(input({ peers: [peer("p1", "u1", { inVoice: false, streaming: true })] }), 0);
        assert.deepEqual(s.feed(input({ peers: [peer("p1", "u1", { streaming: true })] }), 30_000), []);
    });
});

describe("rate limit", () => {
    test("two events in the same snapshot play one sound", () => {
        const s = sim();
        const idle = [peer("p1", "u1"), peer("p2", "u2")];
        s.feed(input({ local: live(), peers: idle }), 0);
        // both friends join my viewers at once
        assert.deepEqual(s.feed(input({ local: live("p1", "p2"), peers: idle }), 30_000), ["stream_user_joined"]);
        // a viewer joining and a friend starting to stream at once: the stream wins
        const s2 = sim();
        s2.feed(input({ local: live(), peers: idle }), 0);
        assert.deepEqual(s2.feed(input({ local: live("p1"), peers: [peer("p1", "u1"), peer("p2", "u2", { streaming: true })] }), 30_000), ["stream_started"]);
    });

    test("a second sound inside MIN_GAP_MS is dropped, one at the limit plays", () => {
        const s = sim();
        const peers = [peer("p1", "u1"), peer("p2", "u2"), peer("p3", "u3")];
        s.feed(input({ local: live(), peers }), 0);
        assert.deepEqual(s.feed(input({ local: live("p1"), peers }), 30_000), ["stream_user_joined"]);
        assert.deepEqual(s.feed(input({ local: live("p1", "p2"), peers }), 30_000 + MIN_GAP_MS - 1), []);
        assert.deepEqual(s.feed(input({ local: live("p1", "p2", "p3"), peers }), 30_000 + MIN_GAP_MS), ["stream_user_joined"]);
        assert.equal(s.names().length, 2);
    });

    test("a due left inside the gap is dropped, not delayed", () => {
        const s = sim();
        const peers = [peer("p1", "u1"), peer("p2", "u2")];
        s.feed(input({ local: live("p1"), peers }), 0);
        s.feed(input({ local: live(), peers }), 30_000); // p1 leaves: left due at 31_500
        assert.deepEqual(s.feed(input({ local: live("p2"), peers }), 31_400), ["stream_user_joined"]);
        assert.deepEqual(s.tick(31_500), []);
        assert.equal(s.wakeAt, null);
        assert.deepEqual(s.names(), ["stream_user_joined"]);
    });

    test("nothing is held back by silent steps: the limit only counts sounds that played", () => {
        const s = sim();
        const peers = [peer("p1", "u1")];
        s.feed(input({ local: live(), peers }), 0);
        s.feed(input({ local: live(), peers }), 10_000);
        assert.deepEqual(s.feed(input({ local: live("p1"), peers }), 10_001), ["stream_user_joined"]);
    });
});

describe("four events, four different sounds", () => {
    const NAMES: SoundName[] = ["stream_user_joined", "stream_user_left", "stream_started", "stream_ended"];
    const chime = (n: SoundName) => SOUND_DEFS[n].chime;
    const sorted = (a: readonly number[], desc = false) => [...a].sort((x, y) => (desc ? y - x : x - y));

    test("every event has a definition, and nothing else", () => {
        assert.deepEqual(Object.keys(SOUND_DEFS).sort(), [...NAMES].sort());
    });

    test("Discord path: a distinct sound name per event, the very ones Discord ships", () => {
        const discord = NAMES.map(n => SOUND_DEFS[n].discord);
        assert.equal(new Set(discord).size, 4);
        assert.deepEqual(discord, ["stream_user_joined", "stream_user_left", "stream_started", "stream_ended"]);
    });

    test("fallback: four distinct note sequences, so joined/left and started/ended never share a sound", () => {
        assert.equal(new Set(NAMES.map(n => JSON.stringify(chime(n).notes))).size, 4);
        // the pairs differ in notes, not only in some other detail
        assert.notDeepEqual(chime("stream_user_joined").notes, chime("stream_user_left").notes);
        assert.notDeepEqual(chime("stream_started").notes, chime("stream_ended").notes);
        // and they are not just the same notes played in the other order (which would only be "up" vs "down" of one sound)
        assert.notDeepEqual(sorted(chime("stream_user_joined").notes), sorted(chime("stream_user_left").notes));
        assert.notDeepEqual(sorted(chime("stream_started").notes), sorted(chime("stream_ended").notes));
    });

    test("fallback direction: joined and started go UP, left and ended go DOWN", () => {
        assert.deepEqual(chime("stream_user_joined").notes, sorted(chime("stream_user_joined").notes));
        assert.deepEqual(chime("stream_started").notes, sorted(chime("stream_started").notes));
        assert.deepEqual(chime("stream_user_left").notes, sorted(chime("stream_user_left").notes, true));
        assert.deepEqual(chime("stream_ended").notes, sorted(chime("stream_ended").notes, true));
    });

    test("fallback shape: viewer sounds have 2 notes, stream sounds 3; joined is brighter than left", () => {
        assert.equal(chime("stream_user_joined").notes.length, 2);
        assert.equal(chime("stream_user_left").notes.length, 2);
        assert.equal(chime("stream_started").notes.length, 3);
        assert.equal(chime("stream_ended").notes.length, 3);
        // a clear gap, not a subtle one: the joined notes sit well above the left notes
        assert.ok(Math.min(...chime("stream_user_joined").notes) >= Math.max(...chime("stream_user_left").notes) + 100);
        // and the left sound is softer
        assert.ok(chime("stream_user_left").peak < chime("stream_user_joined").peak);
    });

    test("fallback waveform differs inside each pair", () => {
        assert.notEqual(chime("stream_user_joined").wave, chime("stream_user_left").wave);
        assert.notEqual(chime("stream_started").wave, chime("stream_ended").wave);
    });

    test("fallback stays short and soft (under 250 ms, gain well below 0.1)", () => {
        for (const n of NAMES) {
            const { notes, noteS, stepS, peak } = chime(n);
            const total = (notes.length - 1) * stepS + noteS;
            assert.ok(total >= 0.15 && total <= 0.25, `${n}: ${total}s`);
            assert.ok(peak > 0 && peak <= 0.08, `${n}: peak ${peak}`);
        }
    });

    test("the rules emit exactly these names: each way of the viewer/stream events maps to its own sound", () => {
        const s = sim();
        const idle = [peer("p1", "u1"), peer("p2", "u2")];
        s.feed(input({ local: live(), peers: idle }), 0);
        s.feed(input({ local: live("p1"), peers: idle }), 30_000);
        s.feed(input({ local: live(), peers: idle }), 40_000);
        s.tick(40_000 + LEFT_DEBOUNCE_MS);
        s.feed(input({ local: live(), peers: [peer("p1", "u1", { streaming: true }), peer("p2", "u2")] }), 60_000);
        s.feed(input({ local: live(), peers: idle }), 70_000);
        assert.deepEqual(s.names(), ["stream_user_joined", "stream_user_left", "stream_started", "stream_ended"]);
        assert.equal(new Set(s.names().map(n => SOUND_DEFS[n].discord)).size, 4);
    });
});

describe("the caller's timer (flushSounds) with several people waiting", () => {
    const memory = (over: Partial<SoundMemory> = {}): SoundMemory => ({
        live: true, viewers: new Set(), peers: new Map(), pendingLeft: new Map([["late", 2600], ["early", 2000]]), lastPlayedAt: Number.NEGATIVE_INFINITY, ...over
    });

    test("wakes at the EARLIEST due time whatever order they were stored in", () => {
        const step = flushSounds(memory(), 1000);
        assert.deepEqual(step.events, []);
        assert.equal(step.wakeAt, 2000);
    });

    test("plays one left when the first is due and keeps waiting for the other", () => {
        const step = flushSounds(memory(), 2500);
        assert.deepEqual(step.events, ["stream_user_left"]);
        assert.equal(step.wakeAt, 2600);
        assert.deepEqual([...step.memory.pendingLeft.keys()], ["late"]);

        const last = flushSounds({ ...step.memory, lastPlayedAt: 2500 }, 2600);
        assert.deepEqual(last.events, [], "the second one is inside the rate limit and is dropped, not delayed");
        assert.equal(last.wakeAt, null);
    });

    test("both due at once: a single sound", () => {
        const step = flushSounds(memory(), 5000);
        assert.deepEqual(step.events, ["stream_user_left"]);
        assert.equal(step.wakeAt, null);
    });

    test("my stream is no longer live when the timer fires: nothing plays, the wait is dropped", () => {
        const step = flushSounds(memory({ live: false }), 5000);
        assert.deepEqual(step.events, []);
        assert.equal(step.memory.pendingLeft.size, 0);
    });
});
