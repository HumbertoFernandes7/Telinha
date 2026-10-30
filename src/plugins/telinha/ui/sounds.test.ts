/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos sons de entrar/sair (ui/sounds.ts): a ligacao entre o estado do Telinha, as regras puras (soundEvents.ts, testadas
// em soundEvents.test.ts) e o som que toca: o modulo de sons do proprio Discord (achado pelo texto "Unable to find sound for
// pack name", com a checagem de sons desligados do Discord) e, se ele nao responde, o acorde proprio feito com WebAudio.
// O estado entra pelo store, o tempo e o relogio falso, o Discord e o WebAudio sao os fakes de test/fakes. Nao entra no build
// (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/ui/sounds.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { getEventLog, resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { audioEnv, installWebAudio, type WebAudioEnv } from "@test/fakes/audio";
import { type FakeClock, useFakeClock } from "@test/fakes/clock";
import { FRIEND_ID, OTHER_ID, pluginSettings, resetVencordFakes, webpackModules } from "@test/fakes/vencord";

import { LEFT_DEBOUNCE_MS, MIN_GAP_MS, PEER_SETTLE_MS } from "./soundEvents";
import { startSounds, stopSounds } from "./sounds";

const EMPTY: TelinhaState = { inRoom: true, channelId: "500000000000000005", peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };
const LOCAL = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, hasAudio: false, startedAt: 0, access: "all" as const };

const peer = (peerId: string, over: Partial<RemotePeer> = {}): RemotePeer => ({ peerId, discordUserId: FRIEND_ID, username: "amigo", streaming: false, admitted: true, inVoice: true, ...over });
const state = (over: Partial<TelinhaState>): TelinhaState => ({ ...EMPTY, ...over });
const live = (...viewers: string[]) => ({ ...LOCAL, viewers });
/** the core's log lines written since the current test started (the log is shared by the whole file) */
let logFrom = 0;
const logs = () => getEventLog().slice(logFrom).map(e => e.msg);

let clock: FakeClock;
let audio: WebAudioEnv | null = null;
/** Discord's sound module: (name, volume) */
let playSound: ReturnType<typeof mock.fn<(name: string, volume?: number) => unknown>>;
let disabled: (name: string) => boolean;
let checked: string[];

function provideDiscord() {
    playSound = mock.fn((_name: string, _volume?: number): unknown => ({}));
    checked = [];
    disabled = () => false;
    webpackModules.provideByCode("Unable to find sound for pack name", playSound);
    webpackModules.provideStore("NotificationSettingsStore", { isSoundDisabled: (name: string) => (checked.push(name), disabled(name)) });
}

/** A friend who was not streaming and has been in the call for a while, then starts streaming. */
function friendStartsStreaming() {
    setState(state({ peers: [peer("peerA")] }));
    clock.tick(PEER_SETTLE_MS + 1000);
    setState(state({ peers: [peer("peerA", { streaming: true })] }));
}

describe("sons do Discord", () => {
    beforeEach(() => {
        resetVencordFakes();
        logFrom = getEventLog().length;
        resetState();
        clock = useFakeClock();
        provideDiscord();
    });

    afterEach(() => {
        stopSounds();
        clock.restore();
    });

    test("o amigo comeca a transmitir: toca stream_started pelo modulo do Discord, no volume que o Discord usa", () => {
        startSounds();
        friendStartsStreaming();
        assert.deepEqual(playSound.mock.calls.map(c => c.arguments), [["stream_started", 0.4]]);
        assert.deepEqual(checked, ["stream_started"], "pergunta ao Discord se esse som esta desligado nas configuracoes dele");
        assert.equal(logs().filter(l => l === "Sons: usando os sons do Discord").length, 1);
    });

    test("o primeiro retrato do estado e so lembrado: quem ja transmitia ao ligar nao faz barulho", () => {
        setState(state({ peers: [peer("peerA", { streaming: true })], local: live("peerA") }));
        startSounds();
        clock.tick(60_000);
        assert.equal(playSound.mock.callCount(), 0);
    });

    test("alguem comeca a assistir a minha transmissao: stream_user_joined; ao sair, stream_user_left so depois da espera", () => {
        setState(state({ peers: [peer("peerA")], local: live() }));
        startSounds();

        setState(state({ peers: [peer("peerA")], local: live("peerA") }));
        assert.deepEqual(playSound.mock.calls.map(c => c.arguments[0]), ["stream_user_joined"]);

        clock.tick(MIN_GAP_MS + 1);
        setState(state({ peers: [peer("peerA")], local: live() }));
        clock.tick(LEFT_DEBOUNCE_MS - 1);
        assert.equal(playSound.mock.callCount(), 1, "ainda dentro da espera");
        clock.tick(1);
        assert.deepEqual(playSound.mock.calls.map(c => c.arguments[0]), ["stream_user_joined", "stream_user_left"]);
    });

    test("a pessoa que saiu e volta dentro da espera: nenhum som de saida", () => {
        setState(state({ peers: [peer("peerA")], local: live("peerA") }));
        startSounds();
        setState(state({ peers: [peer("peerA")], local: live() }));
        clock.tick(500);
        setState(state({ peers: [peer("peerA")], local: live("peerA") }));
        clock.tick(5000);
        assert.equal(playSound.mock.callCount(), 0);
    });

    test("dois sons no mesmo instante: toca um so (limite de 400 ms)", () => {
        setState(state({ peers: [peer("peerA"), peer("peerB", { discordUserId: OTHER_ID })], local: live() }));
        startSounds();
        setState(state({ peers: [peer("peerA"), peer("peerB", { discordUserId: OTHER_ID })], local: live("peerA", "peerB") }));
        assert.equal(playSound.mock.callCount(), 1);
    });

    test("o amigo para de transmitir: stream_ended", () => {
        setState(state({ peers: [peer("peerA", { streaming: true })] }));
        startSounds();
        setState(state({ peers: [peer("peerA")] }));
        assert.deepEqual(playSound.mock.calls.map(c => c.arguments[0]), ["stream_ended"]);
    });

    test("som desligado nas configuracoes do Discord: nao toca e nem cai no acorde proprio", () => {
        audio = installWebAudio();
        try {
            startSounds();
            disabled = name => name === "stream_started";
            friendStartsStreaming();
            assert.equal(playSound.mock.callCount(), 0);
            assert.equal(audioEnv.contexts.length, 0);
            assert.ok(!logs().some(l => /Sons: usando/.test(l)), "nem 'usando os sons do Discord': nada foi tocado");
        } finally {
            audio.restore();
            audio = null;
        }
    });

    test("o Discord devolve undefined (Modo Streamer cala os sons): conta como tratado, sem acorde proprio", () => {
        audio = installWebAudio();
        try {
            playSound.mock.mockImplementation(() => undefined);
            startSounds();
            friendStartsStreaming();
            assert.equal(playSound.mock.callCount(), 1);
            assert.equal(audioEnv.contexts.length, 0);
        } finally {
            audio.restore();
            audio = null;
        }
    });

    test("a loja de configuracoes de notificacao nao foi achada: toca mesmo assim (a checagem e cortesia do Discord)", () => {
        webpackModules.reset();
        webpackModules.provideByCode("Unable to find sound for pack name", playSound);
        startSounds();
        friendStartsStreaming();
        assert.equal(playSound.mock.callCount(), 1);
    });

    test("a loja lanca ao ser consultada: toca mesmo assim", () => {
        webpackModules.provideStore("NotificationSettingsStore", { isSoundDisabled: () => { throw new Error("quebrou"); } });
        startSounds();
        friendStartsStreaming();
        assert.equal(playSound.mock.callCount(), 1);
    });

    test("'Sons de entrar e sair' desligado: nada toca, e ao ligar de novo o que passou nao e tocado depois", () => {
        startSounds();
        pluginSettings.set("playSounds", false);
        friendStartsStreaming();
        assert.equal(playSound.mock.callCount(), 0);

        pluginSettings.set("playSounds", true);
        clock.tick(5000);
        assert.equal(playSound.mock.callCount(), 0, "nao toca o que aconteceu enquanto estava desligado");

        setState(state({ peers: [peer("peerA")] }));
        assert.deepEqual(playSound.mock.calls.map(c => c.arguments[0]), ["stream_ended"], "e os novos voltam a tocar");
    });

    test("ligar duas vezes nao duplica o som", () => {
        startSounds();
        startSounds();
        friendStartsStreaming();
        assert.equal(playSound.mock.callCount(), 1);
    });

    test("desligar: some a assinatura e o 'saiu' que estava esperando nunca toca", () => {
        setState(state({ peers: [peer("peerA")], local: live("peerA") }));
        startSounds();
        setState(state({ peers: [peer("peerA")], local: live() }));
        stopSounds();
        clock.tick(10_000);
        setState(state({ peers: [peer("peerA", { streaming: true })] }));
        assert.equal(playSound.mock.callCount(), 0);
    });

    test("depois de desligar e ligar de novo o Discord volta a ser tentado (e o aviso 'usando os sons do Discord' sai de novo)", () => {
        startSounds();
        friendStartsStreaming();
        stopSounds();
        resetState();
        startSounds();
        friendStartsStreaming();
        assert.equal(playSound.mock.callCount(), 2);
        assert.equal(logs().filter(l => l === "Sons: usando os sons do Discord").length, 2);
    });
});

describe("acorde proprio (o modulo do Discord nao responde)", () => {
    beforeEach(() => {
        resetVencordFakes();
        logFrom = getEventLog().length;
        resetState();
        clock = useFakeClock();
        audio = installWebAudio();
    });

    afterEach(() => {
        stopSounds();
        audio?.restore();
        audio = null;
        clock.restore();
    });

    test("modulo nao encontrado: toca as 3 notas de 'comecou a transmitir' (quadrada, subindo) e diz por que", () => {
        startSounds();
        friendStartsStreaming();

        assert.equal(audioEnv.contexts.length, 1);
        const ctx = audioEnv.contexts[0];
        assert.deepEqual(ctx.oscillators.map(o => o.frequency.value), [440, 587.33, 880]);
        assert.ok(ctx.oscillators.every(o => o.type === "square"));
        assert.ok(ctx.oscillators.every(o => o.started != null && o.stopped != null && o.stopped > o.started), "cada nota tem inicio e fim");
        const starts = ctx.oscillators.map(o => o.started!);
        assert.ok(starts[0] < starts[1] && starts[1] < starts[2], "uma depois da outra");
        assert.ok(logs().some(l => /^Sons: usando o som próprio do Telinha \(o módulo de sons do Discord não respondeu: .*nothing provided/.test(l)));
    });

    test("o contexto de audio suspenso (politica de autoplay) e retomado, e as notas se desligam sozinhas ao acabar", () => {
        startSounds();
        friendStartsStreaming();
        const ctx = audioEnv.contexts[0];
        assert.equal(ctx.state, "running");

        const [first] = ctx.oscillators;
        first.onended?.();
        assert.equal(first.disconnected, true);
    });

    test("cada evento tem o seu acorde: entrou (2 notas subindo) e saiu (2 notas descendo)", () => {
        setState(state({ peers: [peer("peerA")], local: live() }));
        startSounds();
        setState(state({ peers: [peer("peerA")], local: live("peerA") }));
        clock.tick(MIN_GAP_MS + 1);
        setState(state({ peers: [peer("peerA")], local: live() }));
        clock.tick(LEFT_DEBOUNCE_MS);

        const [ctx] = audioEnv.contexts;
        assert.equal(audioEnv.contexts.length, 1, "o mesmo contexto serve para todos");
        assert.deepEqual(ctx.oscillators.map(o => [o.type, o.frequency.value]), [["triangle", 660], ["triangle", 990], ["sine", 520], ["sine", 350]]);
    });

    test("depois da primeira falha o Discord nao e mais tentado", () => {
        startSounds();
        friendStartsStreaming();
        const discord = mock.fn();
        webpackModules.provideByCode("Unable to find sound for pack name", discord);
        clock.tick(5000);
        setState(state({ peers: [peer("peerA")] }));
        assert.equal(discord.mock.callCount(), 0);
        assert.equal(audioEnv.contexts[0].oscillators.length, 3 + 3, "stream_ended tem 3 notas e tocou no acorde proprio");
        assert.equal(logs().filter(l => /Sons: usando o som próprio/.test(l)).length, 1, "o aviso sai uma vez so");
    });

    test("desligar fecha o contexto de audio", () => {
        startSounds();
        friendStartsStreaming();
        const [ctx] = audioEnv.contexts;
        stopSounds();
        assert.equal(ctx.state, "closed");
    });
});

describe("sem nenhum som possivel", () => {
    test("sem o modulo do Discord e sem WebAudio: so um aviso no diagnostico, o plugin segue", t => {
        resetVencordFakes();
        logFrom = getEventLog().length;
        resetState();
        clock = useFakeClock(t);
        startSounds();
        try {
            friendStartsStreaming();
            assert.ok(logs().some(l => /^Sons: não consegui tocar o som próprio: /.test(l)));
        } finally {
            stopSounds();
        }
    });
});

describe("falhas que nao sao Error", () => {
    beforeEach(() => {
        resetVencordFakes();
        logFrom = getEventLog().length;
        resetState();
        clock = useFakeClock();
    });

    afterEach(() => {
        stopSounds();
        clock.restore();
    });

    test("o modulo do Discord lanca um texto solto: o motivo sai como texto e cai no acorde proprio", () => {
        audio = installWebAudio();
        try {
            provideDiscord();
            playSound.mock.mockImplementation(() => {
                throw "texto solto";
            });
            startSounds();
            friendStartsStreaming();
            assert.ok(logs().includes("Sons: usando o som próprio do Telinha (o módulo de sons do Discord não respondeu: texto solto)"));
            assert.equal(audioEnv.contexts[0].oscillators.length, 3);
        } finally {
            audio.restore();
            audio = null;
        }
    });

    test("o contexto de audio nao pode ser criado e lanca um texto solto: so um aviso", () => {
        const g = globalThis as { AudioContext?: unknown; };
        const before = Object.getOwnPropertyDescriptor(g, "AudioContext");
        g.AudioContext = class {
            constructor() {
                throw "sem placa de som";
            }
        };
        try {
            startSounds();
            friendStartsStreaming();
            assert.ok(logs().includes("Sons: não consegui tocar o som próprio: sem placa de som"));
        } finally {
            if (before) Object.defineProperty(g, "AudioContext", before);
            else delete g.AudioContext;
        }
    });
});
