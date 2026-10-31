/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do ciclo de vida da sala (core/session.ts) com o Trystero e o Discord falsos: entrar/sair/trocar conforme
// o canal de voz, a senha do grupo (espera de 800 ms), a checagem dos relays (10 s), erros de entrada, a saida da sala
// anterior em andamento (`leaving`), entradas atropeladas e a limpeza do stopSession.
// Rodar:  pnpm test:file src/plugins/telinha/core/session.rooms.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { deriveRoomId, ICE_SERVERS, RELAY_URLS } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import { eventually, useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import {
    dataStoreImpl, FluxDispatcher, FRIEND_ID, GUILD_ID, joinVoice, ME_ID, pluginSettings, SelectedChannelStore, setVoiceMembers, VOICE_CHANNEL_ID
} from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, installWebRtc, videoTrack, type WebRtcEnv } from "@test/fakes/webrtc";
import { logged, logMark, macrotask, settleImmediates } from "@test/helpers/wpa-session";

import { rt } from "./context";
import { getLocalCertificate } from "./identity/certificate";
import { getPeerConnectionClass } from "./peerConnection";
import { isSessionActive, onAdmissionSettingChanged, onPasswordChanged, startSession, stopSession } from "./session";
import { startStreaming } from "./streaming";

const TOKENS_KEY = "telinha-identity-tokens-v1";
const VC2 = "500000000000000006";
const VC3 = "500000000000000007";
const VC4 = "500000000000000008";
const DM = "600000000000000001";
const SCREEN = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, withAudio: false, access: "all" as const };

/** A proxima sala que o plugin abrir (timers reais). */
const nextRoom = (after: FakeRoom | undefined) => eventually(() => trystero.lastRoom !== after && trystero.lastRoom);

describe("sessao: sala do canal de voz", () => {
    let rtc: WebRtcEnv;
    let native: NativeEnv | null = null;

    before(() => {
        rtc = installWebRtc();
        trystero.reset();
    });

    after(() => {
        stopSession();
        pluginSettings.reset();
        native?.restore();
        rtc.restore();
    });

    test("sem a parte nativa (Discord nao reiniciado): erro explicando o que fazer", async () => {
        const mark = logMark();
        startSession();
        assert.equal(isSessionActive(), true);
        startSession();
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 1, "iniciar duas vezes nao assina duas vezes");
        await eventually(() => getState().lastError);
        assert.match(getState().lastError!, /^O Telinha foi instalado\/atualizado com o Discord aberto\. Feche o Discord por completo/);
        assert.equal(logged(/^A parte nativa do plugin não está carregada/, mark).length, 1);

        stopSession();
        stopSession();
        assert.equal(isSessionActive(), false);
        await macrotask();
        assert.equal(getState().lastError, null);
        assert.equal(getState().inRoom, false);

        // iniciar e parar na mesma volta: a medicao do codec termina com a sessao ja parada (sem presenca)
        native = installNative();
        startSession();
        stopSession();
        await macrotask();
    });

    describe("com a sessao ligada (timers reais)", () => {
        before(() => {
            startSession();
        });

        after(() => stopSession());

        test("fora de call: nenhuma sala; entrar no canal de voz entra na sala dele", async () => {
            await macrotask();
            assert.equal(trystero.rooms.length, 0);
            assert.equal(getState().inRoom, false);
            // uma RTCPeerConnection negociando fora de sala: sem plano de envio
            const pc = new (getPeerConnectionClass())({}) as unknown as FakeRTCPeerConnection & RTCPeerConnection;
            pc.addSendingTrack(videoTrack());
            await pc.setLocalDescription();
            assert.equal(pc.getTransceivers()[0].codecPreferences, null);
            const mark = logMark();

            joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
            const room = await nextRoom(undefined);
            assert.equal(room.roomId, await deriveRoomId(GUILD_ID, VOICE_CHANNEL_ID));
            assert.equal(room.config.appId, "telinha-v1");
            assert.equal(room.config.password, undefined);
            assert.deepEqual(room.config.relayConfig, { urls: RELAY_URLS });
            assert.equal(room.config.rtcConfig.iceServers, ICE_SERVERS);
            const cert = await getLocalCertificate();
            assert.deepEqual(room.config.rtcConfig.certificates, [cert.certificate], "o certificado persistente em todas as conexoes");
            assert.equal(rt.certFingerprint, cert.fingerprint);
            assert.equal(room.config.rtcPolyfill, getPeerConnectionClass());
            assert.equal(room.callbacks.handshakeTimeoutMs, 15_000);
            assert.deepEqual([...room.actions.keys()].sort(), ["codec", "diag", "identity", "presence", "watch"]);
            assert.equal(typeof room.onPeerJoin, "function");
            assert.equal(typeof room.onPeerStream, "function");
            await eventually(() => getState().inRoom && getState().channelId === VOICE_CHANNEL_ID);
            assert.equal(logged(/^Entrando na sala [0-9a-f]{12}… \(canal de voz selecionado\)$/, mark).length, 1);
        });

        test("call em DM, canal desconhecido e saida da call", async () => {
            const first = trystero.lastRoom!;
            const mark = logMark();
            joinVoice(DM, { guildId: null });
            const dm = await nextRoom(first);
            assert.equal(dm.roomId, await deriveRoomId(null, DM));
            await eventually(() => first.left);
            assert.equal(logged(/^Saindo da sala \(você saiu do canal de voz\)$/, mark).length, 1);

            // canal que o ChannelStore nao conhece: sala "dm" desse canal
            SelectedChannelStore.setVoiceChannel(VC4);
            void FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", channelId: VC4 });
            const unknown = await nextRoom(dm);
            assert.equal(unknown.roomId, await deriveRoomId(null, VC4));

            joinVoice(null);
            await eventually(() => unknown.left);
            await eventually(() => !getState().inRoom && getState().channelId === null);
            assert.equal(trystero.lastRoom, unknown, "fora de call: nenhuma sala nova");
        });

        test("trocar de canal transmitindo: a transmissao acaba, com o motivo na barra", async () => {
            joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
            const room = await nextRoom(trystero.lastRoom);
            await eventually(() => (rt.room as unknown) === room);
            await startStreaming(SCREEN);
            assert.ok(rt.local);

            joinVoice(VC2);
            const next = await nextRoom(room);
            assert.equal(rt.local, null);
            await eventually(() => getState().lastError === "A transmissão foi encerrada porque você saiu do canal de voz." && getState().channelId === VC2);
            assert.equal(next.roomId, await deriveRoomId(GUILD_ID, VC2));
        });

        test("erros de conexao com um peer: dica pela mensagem, uma linha por peer a cada 10 s", async () => {
            const room = trystero.lastRoom!;
            const mark = logMark();
            room.joinError("peerSenha1", "Failed to decrypt the offer");
            room.joinError("peerSenha1", "Failed to decrypt the offer");
            room.joinError("peerIce001", "ICE connection failed");
            room.joinError("peerOutro1", "algo estranho");
            assert.deepEqual(logged(/^Falha de conexão com o peer/, mark).map(e => e.msg), [
                "Falha de conexão com o peer peerSe: Failed to decrypt the offer (senha do grupo diferente?)",
                "Falha de conexão com o peer peerIc: ICE connection failed (sem caminho P2P direto entre as redes)",
                "Falha de conexão com o peer peerOu: algo estranho"
            ]);
            assert.equal(logged(/peerSe/, mark)[0].level, "warn");
        });

        test("joinRoom lanca: erro na barra; a proxima entrada que der certo limpa o erro", async () => {
            const before = trystero.lastRoom;
            trystero.joinRoomImpl = () => {
                throw new Error("relay recusou");
            };
            const mark = logMark();
            joinVoice(VC3);
            await eventually(() => getState().lastError === "Não foi possível entrar na sala do Telinha: Error: relay recusou");
            assert.equal(logged(/^Falha ao entrar na sala: Error: relay recusou$/, mark)[0]?.level, "error");
            assert.equal(rt.room, null);

            trystero.joinRoomImpl = null;
            joinVoice(VOICE_CHANNEL_ID);
            await nextRoom(before);
            await eventually(() => getState().inRoom && getState().lastError === null);
        });

        test("entrada atropelada: o canal mudou enquanto a identidade carregava; so a sala do canal novo e aberta", async t => {
            const realGet = dataStoreImpl.get.bind(dataStoreImpl);
            const waiting: (() => void)[] = [];
            let holding = true;
            t.mock.method(dataStoreImpl, "get", (key: string) =>
                key === TOKENS_KEY && holding ? new Promise(resolve => waiting.push(() => resolve(undefined))) : realGet(key));
            const before = trystero.rooms.length;

            joinVoice(VC2);
            await eventually(() => waiting.length >= 1);
            joinVoice(VC3);
            await eventually(() => waiting.length >= 2);
            holding = false;
            for (const release of waiting.splice(0)) release();

            const room = await eventually(() => trystero.rooms.length > before && trystero.lastRoom);
            await macrotask();
            await macrotask();
            assert.equal(trystero.rooms.length, before + 1);
            assert.equal(room.roomId, await deriveRoomId(GUILD_ID, VC3));
        });

        test("saida da sala anterior em andamento: a entrada seguinte espera; a atropelada desiste; erro ao sair so vira aviso", async t => {
            const old = trystero.lastRoom!;
            let releaseLeave!: () => void;
            t.mock.method(old, "leave", () => new Promise<void>(resolve => {
                releaseLeave = resolve;
            }));
            const before = trystero.rooms.length;

            joinVoice(VC2);
            await eventually(() => releaseLeave);
            await settleImmediates();
            await macrotask();
            assert.equal(trystero.rooms.length, before, "esperando a sala velha sair");
            joinVoice(VOICE_CHANNEL_ID);
            await macrotask();
            releaseLeave();

            const room = await eventually(() => trystero.rooms.length > before && trystero.lastRoom);
            await macrotask();
            await macrotask();
            assert.equal(trystero.rooms.length, before + 1, "a entrada no VC2 desistiu (ja estava velha)");
            assert.equal(room.roomId, await deriveRoomId(GUILD_ID, VOICE_CHANNEL_ID));

            t.mock.method(room, "leave", () => Promise.reject(new Error("relay caiu")));
            const mark = logMark();
            joinVoice(VC2);
            await nextRoom(room);
            await eventually(() => logged(/^Erro ao sair da sala: Error: relay caiu$/, mark).length === 1);
        });
    });

    describe("com o relogio falso", () => {
        test("senha do grupo: espera 800 ms parada; a sala nova usa a senha; a transmissao acaba com o motivo", async t => {
            const clock = useFakeClock(t);
            startSession();
            joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
            clock.tick(1);
            const room1 = await eventually(() => rt.room);
            await startStreaming(SCREEN);
            const mark = logMark();

            pluginSettings.set("groupPassword", "um");
            clock.tick(500);
            pluginSettings.set("groupPassword", "dois");
            clock.tick(799);
            await settleImmediates();
            assert.equal(rt.room, room1, "ainda digitando");

            clock.tick(1);
            const room2 = await eventually(() => rt.room !== room1 && rt.room) as unknown as FakeRoom;
            assert.equal(room2.config.password, "dois");
            assert.equal(room2.roomId, (room1 as unknown as FakeRoom).roomId, "mesmo canal: o roomId e o mesmo, a senha vai para o Trystero");
            await eventually(() => (room1 as unknown as FakeRoom).left);
            assert.equal(rt.local, null);
            assert.equal(rt.lastError, "A transmissão foi encerrada porque a sala mudou (senha do grupo alterada).");
            assert.equal(logged(/^Saindo da sala \(senha do grupo alterada\)$/, mark).length, 1);
            assert.equal(logged(/^Entrando na sala [0-9a-f]{12}… \(senha do grupo alterada, com senha\)$/, mark).length, 1);

            // senha apagada: sala sem senha
            pluginSettings.set("groupPassword", "");
            clock.tick(800);
            const room3 = await eventually(() => (rt.room as unknown) !== room2 && rt.room) as unknown as FakeRoom;
            assert.equal(room3.config.password, undefined);

            // opcao sem valor (configuracao antiga): o mesmo que vazia, a sala nao muda
            pluginSettings.set("groupPassword", undefined);
            clock.tick(800);
            await settleImmediates();
            assert.equal(rt.room, room3 as unknown as typeof rt.room);

            // parar com a espera pendente: nada acontece depois
            pluginSettings.set("groupPassword", "tres");
            stopSession();
            clock.tick(1000);
            await settleImmediates();
            assert.equal(trystero.lastRoom, room3);
            pluginSettings.reset();
        });

        test("relays: 10 s depois de entrar, conta os conectados; nenhum = erro na barra", async t => {
            const clock = useFakeClock(t);
            startSession();
            joinVoice(VOICE_CHANNEL_ID);
            clock.tick(1);
            const room1 = await eventually(() => rt.room);
            const mark = logMark();
            clock.tick(9_999);
            assert.equal(logged(/Relays de descoberta/, mark).length, 0);
            clock.tick(1);
            assert.deepEqual(logged(/Relays de descoberta/, mark).map(e => e.msg), [`Relays de descoberta conectados: 1/${RELAY_URLS.length}`]);
            assert.equal(rt.lastError, null);

            // nenhum aberto (um conectando, um nulo)
            trystero.relaySockets = { a: { readyState: 0 }, b: null as unknown as { readyState: number; } };
            pluginSettings.set("groupPassword", "x");
            clock.tick(800);
            const room2 = await eventually(() => rt.room !== room1 && rt.room);
            clock.tick(10_000);
            assert.equal(logged(/Relays de descoberta conectados: 0\//, mark).length, 1);
            assert.match(rt.lastError ?? "", /^Não foi possível falar com os servidores de descoberta\. Feche o Discord por completo/);

            // ler os sockets lancando: conta zero, sem estourar
            trystero.relaySockets = Object.defineProperty({}, "boom", {
                enumerable: true,
                get() {
                    throw new Error("sockets indisponiveis");
                }
            });
            pluginSettings.set("groupPassword", "y");
            clock.tick(800);
            const room3 = await eventually(() => rt.room !== room2 && rt.room);
            clock.tick(10_000);
            assert.equal(logged(/Relays de descoberta conectados: 0\//, mark).length, 2);

            // o Trystero ainda sem mapa de sockets
            trystero.relaySockets = null as unknown as typeof trystero.relaySockets;
            pluginSettings.set("groupPassword", "z");
            clock.tick(800);
            await eventually(() => rt.room !== room3 && rt.room);
            clock.tick(10_000);
            assert.equal(logged(/Relays de descoberta conectados: 0\//, mark).length, 3);

            stopSession();
            trystero.relaySockets = { "wss://relay.fake": { readyState: 1 } };
            pluginSettings.reset();
        });

        test("identidade que nao carrega (IndexedDB travado): entra depois de 3 s, sem o certificado proprio", async t => {
            const clock = useFakeClock(t);
            const realGet = dataStoreImpl.get.bind(dataStoreImpl);
            const get = t.mock.method(dataStoreImpl, "get", (key: string) => (key === TOKENS_KEY ? new Promise(() => { }) : realGet(key)));
            const tokenReads = () => get.mock.calls.filter(c => c.arguments[0] === TOKENS_KEY).length;
            const before = trystero.lastRoom;
            startSession();
            await eventually(() => tokenReads() >= 1);
            joinVoice(VC2);
            clock.tick(1);
            await eventually(() => tokenReads() >= 2);
            await settleImmediates();
            assert.equal(trystero.lastRoom, before, "ainda esperando a identidade");

            clock.tick(3000);
            const room = await eventually(() => trystero.lastRoom !== before && trystero.lastRoom);
            assert.equal("certificates" in room.config.rtcConfig, false, "sem certificado: o Chromium gera um por conexao");
            assert.equal(rt.certFingerprint, null);
            stopSession();
        });
    });

    test("stopSession: sai da sala, cancela as assinaturas, limpa o estado; nada responde depois", async () => {
        startSession();
        joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID] });
        const room = await eventually(() => rt.room) as unknown as FakeRoom;
        native!.calls.length = 0;
        native!.telinha.resetDisplayMedia = async () => {
            throw new Error("main ocupado");
        };

        // eventos do Discord ja na fila quando o plugin para (o Telinha reage num setTimeout 0)
        setVoiceMembers(VOICE_CHANNEL_ID, [ME_ID]);
        joinVoice(VC3);
        const mark = logMark();
        stopSession();
        await macrotask();
        assert.equal(isSessionActive(), false);
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 0);
        assert.equal(FluxDispatcher.listenerCount("VOICE_STATE_UPDATES"), 0);
        assert.deepEqual(native!.calls.map(c => c.name), ["resetDisplayMedia"]);
        await eventually(() => room.left);
        assert.equal(rt.room, null);
        assert.equal(rt.peers.size, 0);
        assert.deepEqual(getState(), { inRoom: false, channelId: null, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] });
        assert.deepEqual(logged(/Sessão encerrada|Saindo da sala/, mark).map(e => e.msg), ["Saindo da sala (plugin desligado)", "Sessão encerrada"]);

        // desligada: mudancas de opcao, de voz e o CSP nao fazem nada
        onPasswordChanged();
        onAdmissionSettingChanged();
        joinVoice(VC2);
        document.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI: RELAY_URLS[0] }));
        await macrotask();
        assert.equal(trystero.lastRoom, room);
        assert.equal(logged(/CSP/, mark).length, 0);
    });
});
