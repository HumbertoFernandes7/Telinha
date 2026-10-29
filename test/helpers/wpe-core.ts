/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Helpers do pacote WP-E (UI de assistir). Sobe o nucleo de verdade (como test/harness.test.ts) com um amigo que
// ja esta transmitindo, para os testes de componente poderem clicar em "Assistir" / "Parar de assistir" / enviar a
// senha e conferir o que o nucleo mandou de fato pela sala (room.sentOn("watch", ...)), em vez de so olhar o estado.

import "@test/fakes/dom";

import { startSession, stopSession } from "@plugins/telinha/actions";
import { buildHello, PROTOCOL_VERSION, type StreamAccess, type WatchReplyMessage } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { FRIEND_ID, joinVoice, makeUser, ME_ID, setVoiceMembers, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";

export const STREAMER_PEER = "peerA";

export interface StreamerOptions {
    access?: StreamAccess;
    hasAudio?: boolean;
    username?: string;
}

export interface Streamer {
    room: FakeRoom;
    peerId: string;
    /** O transmissor responde ao pedido de assistir (pending / password / denied), como pela rede */
    reply(message: WatchReplyMessage): void;
    /** Mensagens que o nucleo mandou na acao "watch" para o transmissor ({ op: "start" | "stop" }) */
    watchMessages(): { op: string; proof?: string; }[];
    /** Muda a presenca do transmissor (para de transmitir, troca de modo...) */
    announce(patch: { streaming?: boolean; access?: StreamAccess; hasAudio?: boolean; }): void;
    /** Um segundo amigo (outra conexao e outro usuario do Discord) entra no canal ja transmitindo */
    addFriend(peerId: string, discordUserId: string, username: string): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Entra num canal de voz com um amigo ("amigo", discordUserId FRIEND_ID, conexao "peerA") que ja transmite.
 * Devolve quando o estado do plugin lista o amigo transmitindo. `stop()` sai da sala e desfaz os fakes.
 */
export async function startStreamer(opts: StreamerOptions = {}): Promise<Streamer> {
    const username = opts.username ?? "amigo";
    let rtc: WebRtcEnv | null = installWebRtc();
    let native: NativeEnv | null = installNative();
    UserStore.addUsers(makeUser(FRIEND_ID, username));

    startSession();
    joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
    const room = await eventually(() => trystero.lastRoom);
    await eventually(() => getState().inRoom);
    await room.connectPeer(STREAMER_PEER, { hello: buildHello(FRIEND_ID, username) });

    const presenceOf = (discordUserId: string, name: string, patch: { streaming?: boolean; access?: StreamAccess; hasAudio?: boolean; }) => ({
        v: PROTOCOL_VERSION,
        discordUserId,
        username: name,
        streaming: patch.streaming ?? true,
        ...((patch.streaming ?? true)
            ? { stream: { kind: "screen", title: "Tela", hasAudio: patch.hasAudio ?? opts.hasAudio ?? false, width: 1920, height: 1080, fps: 60, ...(patch.access ?? opts.access ? { access: patch.access ?? opts.access } : {}) } }
            : {}),
        caps: { h264HwDecode: false }
    });
    const announce = (patch: { streaming?: boolean; access?: StreamAccess; hasAudio?: boolean; }) => {
        room.receive("presence", presenceOf(FRIEND_ID, username, patch), STREAMER_PEER);
    };
    const members = [ME_ID, FRIEND_ID];
    announce({});
    await eventually(() => getState().peers.find(p => p.peerId === STREAMER_PEER)?.streaming);

    return {
        room,
        peerId: STREAMER_PEER,
        reply: message => void room.receive("watch", message, STREAMER_PEER),
        watchMessages: () => room.sentOn("watch", STREAMER_PEER).map(m => m.data),
        announce,
        async addFriend(peerId, discordUserId, name) {
            UserStore.addUsers(makeUser(discordUserId, name));
            members.push(discordUserId);
            setVoiceMembers(VOICE_CHANNEL_ID, members);
            await room.connectPeer(peerId, { hello: buildHello(discordUserId, name) });
            room.receive("presence", presenceOf(discordUserId, name, {}), peerId);
            await eventually(() => getState().peers.find(p => p.peerId === peerId)?.streaming);
        },
        async stop() {
            stopSession();
            await eventually(() => room.left);
            native?.restore();
            rtc?.restore();
            native = rtc = null;
        }
    };
}

/** Um desafio de senha valido (nonce base64url de 22 caracteres, como o transmissor manda) */
export const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
