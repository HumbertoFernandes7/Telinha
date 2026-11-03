/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da navegacao da tela da call (ui/callView/callNav.ts): saber se saiu da tela da call e voltar para ela
// (abre o canal de voz e foca a tile do amigo) com os stores falsos do Discord (test/fakes/vencord).
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/callNav.test.ts

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { getEventLog, resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { ChannelRouter, ChannelRTCStore, FluxDispatcher, FRIEND_ID, loggerLines, NavigationRouter, resetVencordFakes, SelectedChannelStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";

import { isAwayFromCallScreen, returnToCall } from "./callNav";

const PEER = "peerA";
const EMPTY: TelinhaState = { inRoom: true, channelId: null, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };

function friend(): RemotePeer {
    return {
        peerId: PEER, discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, inVoice: true, identity: "verified",
        stream: { kind: "screen", title: "Tela", hasAudio: true, width: 1920, height: 1080, fps: 60, access: "all" }
    };
}

const selects = () => FluxDispatcher.dispatched.filter(a => a.type === "CHANNEL_RTC_SELECT_PARTICIPANT");

describe("callNav", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
        setState({ ...EMPTY, peers: [friend()] });
    });

    describe("isAwayFromCallScreen", () => {
        test("sem call de voz: false", () => {
            SelectedChannelStore.setChannel("text");
            assert.equal(isAwayFromCallScreen(), false);
        });

        test("a tela principal e a call: false", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel(VOICE_CHANNEL_ID);
            assert.equal(isAwayFromCallScreen(), false);
        });

        test("a tela principal mostra outro canal: true", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel("text");
            assert.equal(isAwayFromCallScreen(), true);
        });

        test("nenhum canal na tela principal: true", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel(null);
            assert.equal(isAwayFromCallScreen(), true);
        });

        test("o store lanca: false", t => {
            t.mock.method(SelectedChannelStore, "getVoiceChannelId", () => {
                throw new Error("store quebrado");
            });
            assert.equal(isAwayFromCallScreen(), false);
        });
    });

    describe("returnToCall", () => {
        test("vai para o canal de voz e foca a tile do amigo", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel("text");
            assert.equal(returnToCall(PEER), true);
            assert.deepEqual(ChannelRouter.transitions, [VOICE_CHANNEL_ID]);
            assert.deepEqual(selects().map(a => [a.channelId, a.id]), [[VOICE_CHANNEL_ID, FRIEND_ID]]);
        });

        test("ja na tela da call: nao navega, mas foca a tile", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel(VOICE_CHANNEL_ID);
            assert.equal(returnToCall(PEER), true);
            assert.deepEqual(ChannelRouter.transitions, []);
            assert.equal(selects().length, 1);
        });

        test("tile ja focada: nao despacha de novo", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel("text");
            ChannelRTCStore.selectParticipant(VOICE_CHANNEL_ID, FRIEND_ID);
            assert.equal(returnToCall(PEER), true);
            assert.deepEqual(ChannelRouter.transitions, [VOICE_CHANNEL_ID]);
            assert.equal(selects().length, 0);
        });

        test("sem canal de voz, usa o canal da sala do estado", () => {
            setState({ ...EMPTY, channelId: "room-channel", peers: [friend()] });
            assert.equal(returnToCall(PEER), true);
            assert.deepEqual(ChannelRouter.transitions, ["room-channel"]);
        });

        test("sem canal de voz e sem canal no estado: false e avisa", () => {
            assert.equal(returnToCall(PEER), false);
            assert.deepEqual(ChannelRouter.transitions, []);
            assert.equal(selects().length, 0);
            assert.ok(loggerLines.some(l => l.level === "warn"), "deixou um aviso");
        });

        test("amigo desconhecido: navega, mas nao foca", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel("text");
            assert.equal(returnToCall("desconhecido"), true);
            assert.deepEqual(ChannelRouter.transitions, [VOICE_CHANNEL_ID]);
            assert.equal(selects().length, 0);
        });

        test("deixa a linha no diagnostico", () => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel("text");
            returnToCall(PEER);
            assert.ok(getEventLog().some(e => e.msg.startsWith("Janelinha: voltando para a call de ")));
        });

        test("o roteador falha: abre pela rota do canal", t => {
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            SelectedChannelStore.setChannel("text");
            t.mock.method(ChannelRouter, "transitionToChannel", () => {
                throw new Error("sem modulo");
            });
            assert.equal(returnToCall(PEER), true);
            assert.deepEqual(NavigationRouter.paths, [`/channels/@me/${VOICE_CHANNEL_ID}`]);
        });
    });
});
