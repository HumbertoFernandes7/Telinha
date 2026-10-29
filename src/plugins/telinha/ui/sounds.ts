/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Short sounds when someone starts/stops watching my stream and when a friend in the call starts/stops streaming with
// Telinha (like Discord's own Go Live sounds). The rules (what plays and when) are the pure functions in soundEvents.ts;
// this file subscribes to the store, schedules the one timer those rules ask for, and plays.
//
// Which sound: Discord's own (stream_user_joined / stream_user_left / stream_started / stream_ended), through the same
// function Discord calls for them: findByCodeLazy("Unable to find sound for pack name") is playSound(name, volume), and
// NotificationSettingsStore.isSoundDisabled(name) is the "sound turned off in Discord's settings" check Discord itself does.
// Fallback (module not found or it throws): a short two-note chime made with WebAudio.
// Nothing runs at module load: the finders are created inside the functions below, the first time a sound plays
// (start()/stop() are called by the plugin).

import { log } from "@plugins/telinha/core/log";
import { settings } from "@plugins/telinha/settings";
import { getState, subscribe } from "@plugins/telinha/store";
import { findByCodeLazy, findStoreLazy } from "@webpack";

import { advanceSounds, flushSounds, SOUND_DEFS, type SoundMemory, type SoundName, type SoundStep } from "./soundEvents";

/** The volume Discord's own hook uses for these sounds */
const DISCORD_VOLUME = 0.4;

/** playSound(name, volume) from Discord's sound module (returns the sound, or undefined when Streamer Mode mutes sounds) */
type DiscordPlaySound = (name: string, volume?: number) => unknown;
interface DiscordSoundDeps {
    playSound: DiscordPlaySound;
    notificationSettings: { isSoundDisabled(name: string): boolean; };
}

let unsubscribe: (() => void) | null = null;
let memory: SoundMemory | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

// #region Discord's sound module

let discord: DiscordSoundDeps | null = null;
let discordBroken = false;
let usingPath: "discord" | "own" | null = null;

/**
 * The module is Discord's SoundUtils: `function(name, volume = 1, onEnd?, soundpack?, options?)`, found by the log
 * message in its body (stable across releases, unlike the minified export names `Ak`/`Qh`/`aN`). The store is found by its
 * displayName. Both lookups are lazy proxies: they only search webpack when first used.
 */
function discordSounds(): DiscordSoundDeps {
    discord ??= {
        playSound: findByCodeLazy("Unable to find sound for pack name") as DiscordPlaySound,
        notificationSettings: findStoreLazy("NotificationSettingsStore")
    };
    return discord;
}

function announce(path: "discord" | "own", why?: string) {
    if (usingPath === path) return;
    usingPath = path;
    log.info(path === "discord" ? "Sons: usando os sons do Discord" : `Sons: usando o som próprio do Telinha${why ? ` (${why})` : ""}`);
}

/** Plays through Discord. true = handled (played, or Discord's own settings say that sound is off); false = use the fallback */
function playWithDiscord(name: SoundName): boolean {
    if (discordBroken) return false;
    try {
        const deps = discordSounds();
        let off = false;
        try {
            // the store is optional: if it cannot be found we just play (this check is Discord's courtesy, not ours)
            off = !!deps.notificationSettings.isSoundDisabled(name);
        } catch { }
        if (off) return true;
        deps.playSound(SOUND_DEFS[name].discord, DISCORD_VOLUME); // throws when the module was not found
        announce("discord");
        return true;
    } catch (e) {
        discordBroken = true;
        announce("own", `o módulo de sons do Discord não respondeu: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

// #endregion

// #region Fallback chime

let audioContext: AudioContext | null = null;

function playChime(name: SoundName) {
    audioContext ??= new AudioContext();
    const ctx = audioContext;
    if (ctx.state === "suspended") void ctx.resume().catch(() => { });

    // each event has its own notes, waveform and level (SOUND_DEFS): up/down and 2/3 notes tell the four apart by ear
    const { notes, wave, peak, noteS, stepS } = SOUND_DEFS[name].chime;
    const t0 = ctx.currentTime + 0.01;
    notes.forEach((hz, i) => {
        const start = t0 + i * stepS;
        const end = start + noteS;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = wave;
        osc.frequency.value = hz;
        // click-free envelope: 8 ms in, exponential fade out
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(end + 0.02);
        osc.onended = () => {
            osc.disconnect();
            gain.disconnect();
        };
    });
}

// #endregion

function play(name: SoundName) {
    // read at play time, so the toggle works without restarting (the rules keep tracking while it is off: turning it on
    // does not replay old events)
    if (settings.store.playSounds === false) return;
    if (playWithDiscord(name)) return;
    try {
        announce("own");
        playChime(name);
    } catch (e) {
        log.warn(`Sons: não consegui tocar o som próprio: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function run(step: SoundStep) {
    memory = step.memory;
    for (const name of step.events) play(name);

    if (timer != null) clearTimeout(timer);
    timer = null;
    if (step.wakeAt != null) {
        timer = setTimeout(() => {
            timer = null;
            if (memory) run(flushSounds(memory, Date.now()));
        }, Math.max(0, step.wakeAt - Date.now()));
    }
}

function onState() {
    run(advanceSounds(memory, getState(), Date.now()));
}

export function startSounds() {
    if (unsubscribe) return;
    unsubscribe = subscribe(onState);
    onState(); // first snapshot: remembered, silent
}

export function stopSounds() {
    unsubscribe?.();
    unsubscribe = null;
    if (timer != null) clearTimeout(timer);
    timer = null;
    memory = null;
    discord = null;
    discordBroken = false;
    usingPath = null;
    const ctx = audioContext;
    audioContext = null;
    void ctx?.close().catch(() => { });
}
