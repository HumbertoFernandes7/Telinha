/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da sessao (core/session.ts) dentro de uma sala, com peers falsos (Trystero falso) e o Discord falso:
// handshake (versao, lixo, "diz ser voce"), admissao (canal de voz, "recusar quem esta fora"), presenca, pedidos
// "watch", streams, identidade duplicada (inclusive pelo tick de 1 s), o alerta do CSP, o gancho da RTCPeerConnection
// e o diagnostico. Ninguem aqui tem prova de identidade (session.identity.test.ts cobre a prova).
// Rodar:  pnpm test:file src/plugins/telinha/core/session.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { buildHello, RELAY_URLS } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { FRIEND_ID, joinVoice, ME_ID, OTHER_ID, pluginSettings, setVoiceMembers, VOICE_CHANNEL_ID, VoiceStateStore } from "@test/fakes/vencord";
import { FakeMediaStream, type FakeRTCPeerConnection, installWebRtc, videoTrack, type WebRtcEnv } from "@test/fakes/webrtc";
import { hello, logged, logMark, macrotask, presence } from "@test/helpers/wpa-session";

import { rt } from "./context";
import { getPeerConnectionClass } from "./peerConnection";
import { onAdmissionSettingChanged, peerIdentityDiagnostics, startSession, stopSession } from "./session";
import { startStreaming, stopStreaming } from "./streaming";
import { unwatch, watch } from "./viewing";

const DUP_ID = "200000000000000009";
const AMIGO = "peerAmigo1";
const OUTRO = "peerOutro1";
const SCREEN = { source: { id: "screen:0:0", name: "Tela", kind: "screen" as const }, quality: "1080p60" as const, withAudio: false, access: "all" as const };

const peerOf = (peerId: string) => getState().peers.find(p => p.peerId === peerId);
const lastWatchTo = (room: FakeRoom, peerId: string) => room.sentOn("watch", peerId).at(-1)?.data;

describe("sessao: dentro da sala", () => {
    let rtc: WebRtcEnv;
    let native: NativeEnv;
    let room: FakeRoom;

    before(async () => {
        rtc = installWebRtc();
        native = installNative();
        trystero.reset();
        startSession();
        joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID, DUP_ID] });
        room = await eventually(() => trystero.lastRoom);
        await eventually(() => (rt.room as unknown) === room);
    });

    after(() => {
        stopSession();
        pluginSettings.reset();
        native.restore();
        rtc.restore();
    });

    describe("handshake", () => {
        test("amigo no canal de voz: o nosso hello vai sem token (nunca autorizou); ele e admitido e recebe a presenca", async () => {
            const mark = logMark();
            const { sentHello } = await room.connectPeer(AMIGO, { hello: hello(FRIEND_ID, "amigo") });
            assert.deepEqual(sentHello, buildHello(ME_ID, "eu"));
            assert.equal(room.sentOn("presence", AMIGO).length, 1);
            assert.equal(rt.peers.get(AMIGO)?.identityReason, "missing");
            const p = await eventually(() => peerOf(AMIGO));
            assert.deepEqual({ admitted: p.admitted, inVoice: p.inVoice, identity: p.identity }, { admitted: true, inVoice: true, identity: "unverified" });
            assert.equal(logged(/^amigo \(peerAm\) entrou na sala$/, mark).length, 1);
        });

        test("hello ilegivel ou de outra versao: incompativel e ignorado (nunca lanca: o Trystero tentaria em loop)", async () => {
            const mark = logMark();
            await room.connectPeer("peerLixo01", { hello: null });
            await room.connectPeer("peerVer2xx", { hello: { ...hello(OTHER_ID, "futuro"), v: 2 } });
            await room.connectPeer("peerVxxxxx", { hello: { v: "x" } });
            assert.deepEqual(logged(/usa outra versão do Telinha/, mark).map(e => e.msg), [
                "Peer peerLi usa outra versão do Telinha; ignorado",
                "Peer peerVe usa outra versão do Telinha (v2); ignorado",
                "Peer peerVx usa outra versão do Telinha (vx); ignorado"
            ]);
            for (const id of ["peerLixo01", "peerVer2xx", "peerVxxxxx"]) assert.equal(rt.peers.get(id)?.incompatible, true);
            await macrotask();
            assert.equal(getState().peers.some(p => ["peerLixo01", "peerVer2xx", "peerVxxxxx"].includes(p.peerId)), false);
            assert.equal(room.sentOn("presence", "peerVer2xx").filter(m => m.target != null).length, 0);

            // nada do que eles mandam e ouvido
            room.receive("presence", presence(OTHER_ID, "futuro"), "peerVer2xx");
            room.receive("watch", { op: "start" }, "peerVer2xx");
            room.emitStream("peerVer2xx", new FakeMediaStream([videoTrack()]));
            assert.equal(room.sentOn("watch", "peerVer2xx").length, 0);
            assert.equal(rt.peers.get("peerVer2xx")?.presence, null);
        });

        test("uma conexao diz ser VOCE: alerta, nunca e aceita, e o token dela nao fica guardado", async () => {
            const mark = logMark();
            await room.connectPeer("peerEuFalso", { hello: hello(ME_ID, "eu", "a.b.c") });
            assert.equal(logged(/^Peer peerEu diz ser você \(discord 100000000000000001\): pode ser alguém tentando se passar por você; ignorado$/, mark).length, 1);
            assert.equal(logged(/^Uma conexão \(peerEu\) diz ser você: ela não vê sua presença nem recebe sua transmissão$/, mark).length, 1);
            const entry = rt.peers.get("peerEuFalso")!;
            assert.deepEqual({ claimsSelf: entry.claimsSelf, incompatible: entry.incompatible, admitted: entry.admitted }, { claimsSelf: true, incompatible: true, admitted: false });
            assert.equal(entry.hello && "idToken" in entry.hello, false);
            await eventually(() => getState().identityAlerts?.some(a => a.self));
            assert.deepEqual(getState().identityAlerts?.find(a => a.self), { discordUserId: ME_ID, username: "eu", peerIds: ["peerEuFalso"], self: true });
            assert.equal(room.sentOn("presence", "peerEuFalso").filter(m => m.target != null).length, 0);
            assert.equal(peerIdentityDiagnostics().includes("peerEu"), false, "fora do diagnostico dos peers");

            room.disconnectPeer("peerEuFalso");
            await eventually(() => !getState().identityAlerts?.length);
        });
    });

    describe("admissao", () => {
        test("fora do canal de voz: ignorado; entra no canal: admitido e recebe a presenca; sai: perde", async () => {
            const mark = logMark();
            await room.connectPeer(OUTRO, { hello: hello(OTHER_ID, "outro") });
            assert.equal(rt.peers.get(OUTRO)?.admitted, false);
            assert.equal(room.sentOn("presence", OUTRO).filter(m => m.target != null).length, 0);
            assert.equal(logged(/^outro \(peerOu\) \(discord 300000000000000003\) entrou na sala, mas não está no seu canal de voz: ignorado$/, mark).length, 1);

            setVoiceMembers(VOICE_CHANNEL_ID, [ME_ID, FRIEND_ID, DUP_ID, OTHER_ID]);
            await eventually(() => rt.peers.get(OUTRO)?.admitted);
            assert.equal(logged(/^outro \(peerOu\) agora está admitido \(entrou no seu canal de voz\)$/, mark).length, 1);
            assert.equal(room.sentOn("presence", OUTRO).length >= 1, true);

            setVoiceMembers(VOICE_CHANNEL_ID, [ME_ID, FRIEND_ID, DUP_ID]);
            await eventually(() => rt.peers.get(OUTRO)?.admitted === false);
            assert.equal(logged(/^outro \(peerOu\) não está mais admitido \(fora do seu canal de voz\)$/, mark).length, 1);
            assert.equal(peerOf(OUTRO)?.admitted, false);
        });

        test("o Discord sem estados de voz para o canal: ninguem conta como dentro (e volta quando aparecem)", t => {
            const states = t.mock.method(VoiceStateStore, "getVoiceStatesForChannel", () => undefined);
            onAdmissionSettingChanged();
            assert.equal(rt.peers.get(AMIGO)?.admitted, false);
            states.mock.restore();
            onAdmissionSettingChanged();
            assert.equal(rt.peers.get(AMIGO)?.admitted, true);
        });

        test("'recusar quem esta fora' desligado: aceito mesmo fora do canal; religado: perde de novo", async () => {
            const mark = logMark();
            pluginSettings.set("rejectOutsiders", false);
            assert.equal(rt.peers.get(OUTRO)?.admitted, true);
            assert.equal(logged(/^outro \(peerOu\) agora está admitido$/, mark).length, 1);

            await room.connectPeer("peerLonge1", { hello: hello("300000000000000004", "longe") });
            assert.equal(logged(/^longe \(peerLo\) entrou na sala \(fora do seu canal de voz, aceito porque a recusa está desligada\)$/, mark).length, 1);

            pluginSettings.set("rejectOutsiders", true);
            assert.equal(rt.peers.get(OUTRO)?.admitted, false);
            assert.equal(rt.peers.get("peerLonge1")?.admitted, false);
            // ninguem mudou: reavaliar de novo nao loga nada
            const again = logMark();
            pluginSettings.set("rejectOutsiders", false);
            pluginSettings.set("rejectOutsiders", true);
            assert.equal(logged(/admitido/, again).length, 4);
            room.disconnectPeer("peerLonge1");
        });
    });

    describe("mensagens dos peers", () => {
        test("presenca: invalida ou de outro id e ignorada; a valida entra no estado com os logs de transmitir", async () => {
            const mark = logMark();
            room.receive("presence", "lixo", AMIGO);
            room.receive("presence", presence(OTHER_ID, "outro"), AMIGO);
            room.receive("presence", presence(FRIEND_ID, "amigo"), "desconhecido");
            assert.equal(logged(/^Presença inválida de amigo \(peerAm\); ignorada$/, mark).length, 1);
            assert.equal(logged(/^amigo \(peerAm\): ID da presença \(300000000000000003\) difere do handshake \(200000000000000002\); ignorada$/, mark).length, 1);
            assert.equal(rt.peers.get(AMIGO)?.presence, null);

            room.receive("presence", presence(FRIEND_ID, "amigo"), AMIGO);
            assert.equal(logged(/^amigo \(peerAm\): não está transmitindo; H\.264 por hardware: não$/, mark).length, 1);
            room.receive("presence", presence(FRIEND_ID, "amigo", { streaming: true, stream: { kind: "screen", title: "Tela", hasAudio: false, width: 1920, height: 1080, fps: 60 } }), AMIGO);
            assert.equal(logged(/^amigo \(peerAm\) começou de transmitir$/, mark).length, 1);
            await eventually(() => peerOf(AMIGO)?.streaming);
            assert.equal(peerOf(AMIGO)?.stream?.width, 1920);
            room.receive("presence", presence(FRIEND_ID, "amigo", { streaming: true, stream: { kind: "screen", title: "Tela", hasAudio: false, width: 1280, height: 720, fps: 60 } }), AMIGO);
            assert.equal(logged(/transmitir/, mark).length, 1, "so a resolucao mudou: sem log");

            // primeira presenca ja transmitindo (janela, com H.264 por hardware) e sem os dados do stream
            await room.connectPeer("peerDup000A", { hello: hello(DUP_ID, "dup") });
            room.receive("presence", presence(DUP_ID, "dup", { streaming: true, stream: { kind: "window", title: "Jogo", hasAudio: true, width: 1280, height: 720, fps: 30 }, caps: { h264HwDecode: true } }), "peerDup000A");
            assert.equal(logged(/^dup \(peerDu\): transmitindo janela 1280x720@30; H\.264 por hardware: sim$/, mark).length, 1);
            room.receive("presence", presence(DUP_ID, "dup", { streaming: false }), "peerDup000A");
            assert.equal(logged(/^dup \(peerDu\) parou de transmitir$/, mark).length, 1);
            room.disconnectPeer("peerDup000A");
            await room.connectPeer("peerDup000A", { hello: hello(DUP_ID, "dup") });
            room.receive("presence", presence(DUP_ID, "dup", { streaming: true }), "peerDup000A");
            assert.equal(logged(/^dup \(peerDu\): transmitindo ; H\.264 por hardware: não$/, mark).length, 1);
            room.disconnectPeer("peerDup000A");
            await room.connectPeer("peerDup000A", { hello: hello(DUP_ID, "dup") });
            room.receive("presence", presence(DUP_ID, "dup", { streaming: true, stream: { kind: "screen", title: "Tela", hasAudio: false, width: 2560, height: 1440, fps: 60 } }), "peerDup000A");
            assert.equal(logged(/^dup \(peerDu\): transmitindo tela 2560x1440@60; H\.264 por hardware: não$/, mark).length, 1);
            room.disconnectPeer("peerDup000A");

            // de quem nao esta admitido: guardada, sem log
            room.receive("presence", presence(OTHER_ID, "outro", { streaming: true }), OUTRO);
            assert.equal(rt.peers.get(OUTRO)?.presence?.streaming, true);
            assert.equal(logged(/^outro/, mark).length, 0);
        });

        test("watch: pedido sem transmissao, resposta do transmissor, lixo e mensagem que lanca", async () => {
            const mark = logMark();
            const before = room.sentOn("presence", AMIGO).length;
            room.receive("watch", { op: "start" }, AMIGO);
            assert.equal(logged(/^amigo \(peerAm\) pediu para assistir, mas você não está transmitindo$/, mark).length, 1);
            assert.equal(room.sentOn("presence", AMIGO).length, before + 1, "manda a presenca de novo");

            watch(AMIGO);
            assert.deepEqual(lastWatchTo(room, AMIGO), { op: "start" });
            room.receive("watch", { op: "pending" }, AMIGO);
            await eventually(() => getState().viewing[AMIGO]?.awaitingApproval);

            room.receive("watch", { op: "nada" }, AMIGO);
            room.receive("watch", { op: "start" }, "desconhecido");
            room.receive("watch", {
                get op(): string {
                    throw new Error("getter hostil");
                }
            }, AMIGO);
            assert.equal(logged(/^Mensagem "watch" de amigo \(peerAm\) ignorada: Error: getter hostil$/, mark).length, 1);
            unwatch(AMIGO);
            assert.deepEqual(lastWatchTo(room, AMIGO), { op: "stop" });
        });

        test("stream sem pedido: pede para parar; de peer desconhecido: ignorado", () => {
            const mark = logMark();
            room.emitStream(AMIGO, new FakeMediaStream([videoTrack()]), { kind: "telinha-screen" });
            assert.deepEqual(lastWatchTo(room, AMIGO), { op: "stop" });
            assert.equal(logged(/^Stream de amigo \(peerAm\) sem pedido; pedindo para parar$/, mark).length, 1);
            const sent = room.sent.length;
            room.emitStream("desconhecido", new FakeMediaStream([videoTrack()]));
            assert.equal(room.sent.length, sent);
        });
    });

    describe("identidade duplicada (ninguem com prova)", () => {
        test("duas conexoes dizem ser a mesma pessoa: as duas marcadas e o pedido pendente recusado; uma cai: acaba no tick", async () => {
            await startStreaming(SCREEN);
            await room.connectPeer("dupA000001", { hello: hello(DUP_ID, "dup") });
            // nao verificado + "Exigir identidade verificada": espera Permitir
            room.receive("watch", { op: "start" }, "dupA000001");
            assert.deepEqual(lastWatchTo(room, "dupA000001"), { op: "pending" });

            const mark = logMark();
            const { pc } = await room.connectPeer("dupB000001", { hello: hello(DUP_ID, "dup") });
            assert.equal(rt.peers.get("dupA000001")?.duplicate, true);
            assert.equal(rt.peers.get("dupB000001")?.duplicate, true);
            assert.equal(logged(/^Duas conexões dizem ser dup \(discord 200000000000000009\): dupA00, dupB00 — uma pode ser falsa\. Nenhuma recebe a sua transmissão enquanto isso durar\.$/, mark).length, 1);
            assert.deepEqual(lastWatchTo(room, "dupA000001"), { op: "denied", reason: "duplicate" });
            await eventually(() => getState().identityAlerts?.some(a => a.discordUserId === DUP_ID));
            assert.deepEqual(getState().identityAlerts?.find(a => a.discordUserId === DUP_ID), { discordUserId: DUP_ID, username: "dup", peerIds: ["dupA000001", "dupB000001"], self: false });
            assert.match(peerIdentityDiagnostics(), /dup \(dupA00\)=não verificado \[missing\]/);

            // a conexao B caiu (o amigo reabriu o Discord) mas ainda nao saiu da sala: o tick de 1 s percebe
            (pc as unknown as FakeRTCPeerConnection).setConnectionState("failed");
            await eventually(() => rt.peers.get("dupA000001")?.duplicate === false, { timeoutMs: 2500 });
            assert.equal(logged(/^Conflito de identidade do discord 200000000000000009 acabou \(uma das conexões saiu ou provou a identidade\)\. Quem quiser assistir precisa pedir de novo\.$/, mark).length, 1);
            await eventually(() => !getState().identityAlerts?.some(a => a.discordUserId === DUP_ID));

            room.disconnectPeer("dupB000001");
            room.disconnectPeer("dupA000001");
            stopStreaming();
        });
    });

    test("CSP do Discord bloqueando um relay: erro claro na barra (so para os relays do Telinha)", async () => {
        const mark = logMark();
        const violation = (blockedURI?: string) => document.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), blockedURI ? { blockedURI } : {}));
        violation("https://evil.example/x");
        violation();
        assert.equal(rt.lastError, null);
        violation(`${RELAY_URLS[2]}/`);
        violation(RELAY_URLS[3]);
        assert.deepEqual(logged(/CSP/, mark).map(e => [e.level, e.msg]), [["error", `O CSP do Discord bloqueou um relay (${RELAY_URLS[2]}/). Feche o Discord por completo e abra de novo.`]]);
        assert.equal(rt.lastError, "O Discord precisa ser fechado por completo (inclusive da bandeja) e aberto de novo para o Telinha se conectar.");
        rt.lastError = null;
    });

    test("gancho da RTCPeerConnection: a conexao de um espectador recebe o plano de envio dele", async () => {
        pluginSettings.set("requireVerifiedIdentity", false);
        await startStreaming(SCREEN);
        room.receive("watch", { op: "start" }, AMIGO);
        await eventually(() => rt.local?.viewers.has(AMIGO));
        const pc = room.peers.get(AMIGO) as unknown as FakeRTCPeerConnection & RTCPeerConnection;
        const sending = pc.getTransceivers().find(t => t.sender.track?.kind === "video")!;
        const mark = logMark();
        await pc.setLocalDescription();
        assert.equal(sending.codecPreferences?.[0].mimeType, "video/VP9", "VP9: nenhum dos lados codifica H.264 por hardware");
        assert.equal(logged(/^amigo \(peerAm\): preferência de codec VP9 primeiro/, mark).length, 1);
        await pc.setLocalDescription();
        assert.equal(logged(/preferência de codec/, mark).length, 1, "mesma conexao (cache), mesmo plano: nada de novo");

        // conexao que nao e de ninguem da sala: sem plano
        const stray = new (getPeerConnectionClass())({}) as unknown as FakeRTCPeerConnection & RTCPeerConnection;
        stray.addSendingTrack(videoTrack());
        await stray.setLocalDescription();
        assert.equal(stray.getTransceivers()[0].codecPreferences, null);
        stopStreaming();
        pluginSettings.set("requireVerifiedIdentity", true);
    });

    test("diagnostico dos peers: so compativeis, sem tokens; a opcao 'exigir identidade verificada'", () => {
        const text = peerIdentityDiagnostics();
        assert.match(text, /^exigir identidade verificada: sim\nidentidade dos peers: .*amigo \(peerAm\)=não verificado \[missing\].*\núltimas falhas de verificação: nenhuma$/);
        assert.equal(/peerLi|peerVe/.test(text), false, "incompativeis fora");
        pluginSettings.set("requireVerifiedIdentity", false);
        assert.match(peerIdentityDiagnostics(), /^exigir identidade verificada: não/);
        pluginSettings.set("requireVerifiedIdentity", true);
    });

    test("o peer sai: some da lista (com log so para quem estava admitido)", async () => {
        const mark = logMark();
        room.disconnectPeer(AMIGO);
        room.disconnectPeer(OUTRO);
        assert.deepEqual(logged(/saiu da sala/, mark).map(e => e.msg), ["amigo (peerAm) saiu da sala"]);
        await eventually(() => !peerOf(AMIGO) && !peerOf(OUTRO));
    });
});
