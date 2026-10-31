/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da RTCPeerConnection do Telinha (core/peerConnection.ts) sobre a RTCPeerConnection falsa: preferencia de
// codec antes do setLocalDescription implicito, ajuste do SDP remoto (sdp.ts) e a volta ao SDP original quando o
// Chromium recusa o ajustado.
// Rodar:  pnpm test:file src/plugins/telinha/core/peerConnection.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { audioTrack, type FakeRTCPeerConnection, installWebRtc, videoTrack, type WebRtcEnv } from "@test/fakes/webrtc";
import { logged, logMark } from "@test/helpers/wpa-session";

import { containPeerConnection, getPeerConnectionClass, isContained, type SendPlan, setPcHooks } from "./peerConnection";

type TestPc = FakeRTCPeerConnection & RTCPeerConnection;

/** primeiro codec preferido do transceiver (funcao: o assert.equal estrito estreita o tipo do campo) */
const firstPref = (t: { codecPreferences: RTCRtpCodec[] | null; }) => t.codecPreferences?.[0];

const REMOTE_SDP = [
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 98", "a=mid:1", "a=rtpmap:96 VP8/90000", "a=rtpmap:98 VP9/90000", "a=fmtp:98 profile-id=0",
    ""
].join("\r\n");

describe("TelinhaPeerConnection", () => {
    let rtc: WebRtcEnv;
    let plan: SendPlan | null;
    let planCalls: RTCPeerConnection[];

    before(() => {
        rtc = installWebRtc();
    });

    after(() => {
        setPcHooks(null);
        rtc.restore();
    });

    beforeEach(() => {
        plan = null;
        planCalls = [];
        setPcHooks({
            planFor: pc => {
                planCalls.push(pc);
                return plan;
            }
        });
    });

    function newPc(): TestPc {
        const Pc = getPeerConnectionClass();
        return new Pc({}) as unknown as TestPc;
    }

    /** pc com um transceiver de video e um de audio que ENVIAM (mids "0" e "1"), mais um de video so recebendo. */
    function sendingPc() {
        const pc = newPc();
        const video = pc.addSendingTrack(videoTrack(), { direction: "sendrecv" });
        const audio = pc.addSendingTrack(audioTrack());
        const receiving = pc.addReceivingTrack(videoTrack());
        // mids como no SDP remoto: audio 0, video 1
        audio.mid = "0";
        video.mid = "1";
        receiving.mid = "2";
        return { pc, video, audio, receiving };
    }

    test("a classe e criada uma vez, sob demanda, por cima da RTCPeerConnection global", () => {
        const Pc = getPeerConnectionClass();
        assert.equal(getPeerConnectionClass(), Pc);
        assert.equal(Pc.name, "TelinhaPeerConnection");
        const pc = new Pc({ iceServers: [] }) as unknown as TestPc;
        assert.ok(rtc.peerConnections.includes(pc), "e uma RTCPeerConnection (falsa) de verdade");
        assert.deepEqual(pc.getConfiguration(), { iceServers: [] });
    });

    describe("setLocalDescription implicito: preferencia de codec", () => {
        test("sem ganchos: so repassa", async () => {
            setPcHooks(null);
            const { pc, video } = sendingPc();
            await pc.setLocalDescription();
            assert.equal(video.codecPreferences, null);
            assert.equal(pc.descriptionCalls.length, 1);
            assert.equal(pc.localDescription?.type, "offer");
        });

        test("sem plano, ou plano sem codec: nada", async () => {
            const { pc, video } = sendingPc();
            await pc.setLocalDescription();
            plan = { codec: null, bitrate: null, label: "amigo" };
            await pc.setLocalDescription();
            assert.equal(planCalls.length, 2);
            assert.equal(video.codecPreferences, null);
        });

        test("so nos transceivers de video que ENVIAM; uma vez por codec:perfil", async () => {
            const { pc, video, audio, receiving } = sendingPc();
            const stopped = pc.addSendingTrack(videoTrack());
            stopped.stop();
            const mark = logMark();

            plan = { codec: "vp9", bitrate: null, label: "amigo (peerAA)" };
            await pc.setLocalDescription();
            assert.equal(firstPref(video)?.mimeType, "video/VP9");
            assert.equal(audio.codecPreferences, null, "audio fica de fora");
            assert.equal(receiving.codecPreferences, null, "so recebendo fica de fora");
            assert.equal(stopped.codecPreferences, null, "parado fica de fora");
            assert.equal(logged(/^amigo \(peerAA\): preferência de codec VP9 primeiro/, mark).length, 1);

            // mesmo plano: nao reaplica
            video.codecPreferences = null;
            await pc.setLocalDescription();
            assert.equal(video.codecPreferences, null);

            // perfil H.264 diferente: reaplica, com o perfil por hardware na frente
            plan = { codec: "h264", h264Profile: "4d001f", bitrate: null, label: "amigo (peerAA)" };
            await pc.setLocalDescription();
            assert.equal(firstPref(video)?.sdpFmtpLine, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f");
            assert.equal(logged(/preferência de codec H264 \(perfil 4d001f\) primeiro/, mark).length, 1);
        });

        test("descricao explicita (com sdp) ou rollback: nao mexe; oferta sem sdp: prepara", async () => {
            const { pc, video } = sendingPc();
            plan = { codec: "vp8", bitrate: null, label: "x" };
            await pc.setLocalDescription({ type: "answer", sdp: "v=0\r\n" });
            await pc.setLocalDescription({ type: "rollback" });
            assert.equal(planCalls.length, 0);
            assert.equal(video.codecPreferences, null);
            await pc.setLocalDescription({ type: "offer" });
            assert.equal(planCalls.length, 1);
            assert.equal(firstPref(video)?.mimeType, "video/VP8");
        });

        test("gancho que lanca: aviso e a descricao segue normalmente", async () => {
            setPcHooks({
                planFor: () => {
                    throw new Error("plano quebrado");
                }
            });
            const pc = newPc();
            const mark = logMark();
            await pc.setLocalDescription();
            assert.equal(pc.descriptionCalls.length, 1);
            assert.equal(logged(/^Falha ao preparar a preferência de codec: Error: plano quebrado$/, mark).length, 1);
        });
    });

    describe("setRemoteDescription: SDP ajustado", () => {
        const remote = (type: RTCSdpType = "offer", sdp: string | undefined = REMOTE_SDP) => ({ type, sdp }) as RTCSessionDescriptionInit;

        test("ajusta so as m-sections em que enviamos: codec, bitrate e opus estereo; loga uma vez por resumo", async () => {
            const { pc } = sendingPc();
            plan = { codec: "vp9", bitrate: { startKbps: 6000, maxKbps: 20000 }, label: "amigo" };
            const mark = logMark();
            await pc.setRemoteDescription(remote("offer"));
            const applied = pc.descriptionCalls.at(-1)!.description!;
            assert.equal(applied.type, "offer");
            assert.match(applied.sdp!, /m=video 9 UDP\/TLS\/RTP\/SAVPF 98 96\r\n/);
            assert.match(applied.sdp!, /a=fmtp:96 x-google-start-bitrate=6000;x-google-max-bitrate=20000\r\n/);
            assert.match(applied.sdp!, /a=fmtp:111 minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n/);
            assert.equal(logged(/^amigo: SDP remoto \(offer\) ajustado — mid 0: opus estéreo 128 kbps; mid 1: VP9 primeiro; mid 1: x-google/, mark).length, 1);

            // o mesmo ajuste de novo (ex.: renegociacao): nao repete o log
            await pc.setRemoteDescription(remote("answer"));
            assert.equal(logged(/SDP remoto/, mark).length, 1);
            assert.match(pc.descriptionCalls.at(-1)!.description!.sdp!, /98 96\r\n/);
        });

        test("so observacoes (codec ausente): loga, mas aplica o original", async () => {
            const { pc } = sendingPc();
            plan = { codec: "av1", bitrate: null, label: "amigo2" };
            const mark = logMark();
            const original = remote("pranswer", REMOTE_SDP.replace("a=rtpmap:111 opus/48000/2", "a=rtpmap:111 PCMU/8000"));
            await pc.setRemoteDescription(original);
            assert.equal(pc.descriptionCalls.at(-1)!.description!.sdp, original.sdp);
            assert.equal(logged(/^amigo2: SDP remoto \(pranswer\) ajustado — AV1 ausente no SDP do outro lado/, mark).length, 1);
        });

        test("nada a fazer: rollback, sem sdp, sem plano, sem transceivers que enviam", async () => {
            const { pc } = sendingPc();
            plan = { codec: "vp9", bitrate: null, label: "x" };
            await pc.setRemoteDescription({ type: "rollback" } as RTCSessionDescriptionInit);
            await pc.setRemoteDescription({ type: "offer" } as RTCSessionDescriptionInit);
            assert.equal(planCalls.length, 0, "nem pergunta o plano");

            plan = null;
            await pc.setRemoteDescription(remote());
            assert.equal(pc.descriptionCalls.at(-1)!.description!.sdp, REMOTE_SDP);

            const idle = newPc();
            idle.addReceivingTrack(videoTrack());
            const noMid = idle.addSendingTrack(videoTrack());
            noMid.mid = null;
            plan = { codec: "vp9", bitrate: { startKbps: 1, maxKbps: 2 }, label: "x" };
            await idle.setRemoteDescription(remote());
            assert.equal(idle.descriptionCalls.at(-1)!.description!.sdp, REMOTE_SDP, "transceiver sem mid nao conta");
        });

        test("ajuste que lanca: aviso e o original", async () => {
            const { pc } = sendingPc();
            setPcHooks({
                planFor: () => {
                    throw new Error("sem plano");
                }
            });
            const mark = logMark();
            await pc.setRemoteDescription(remote());
            assert.equal(pc.descriptionCalls.at(-1)!.description!.sdp, REMOTE_SDP);
            assert.equal(logged(/^Falha ao ajustar o SDP remoto \(usando o original\): Error: sem plano$/, mark).length, 1);
        });

        test("o Chromium recusa o SDP ajustado: aplica o original; se o original tambem falhar, o erro sobe", async () => {
            const { pc } = sendingPc();
            plan = { codec: "vp9", bitrate: { startKbps: 1, maxKbps: 2 }, label: "amigo" };
            pc.setRemoteDescriptionImpl = d => {
                if (d.sdp?.includes("x-google")) throw new DOMException("Failed to parse SessionDescription", "OperationError");
            };
            const mark = logMark();
            await pc.setRemoteDescription(remote());
            const calls = pc.descriptionCalls.filter(c => c.method === "setRemoteDescription");
            assert.equal(calls.length, 2);
            assert.match(calls[0].description!.sdp!, /x-google/);
            assert.equal(calls[1].description!.sdp, REMOTE_SDP);
            assert.equal(pc.remoteDescription?.sdp, REMOTE_SDP);
            assert.equal(logged(/^O Chromium recusou o SDP ajustado; aplicando o original: OperationError: Failed to parse/, mark).length, 1);

            pc.setRemoteDescriptionImpl = () => {
                throw new Error("SDP invalido");
            };
            await assert.rejects(pc.setRemoteDescription(remote()), /SDP invalido/);
        });
    });
});

// Conexao contida (envio travado na placa de video; streaming.ts → containStuck): o resto em streaming.stuck.test.ts.
describe("conexao contida", () => {
    let rtc: WebRtcEnv;

    before(() => {
        rtc = installWebRtc();
    });

    after(() => {
        setPcHooks(null);
        rtc.restore();
    });

    /** pc que envia video (mid "1", como no SDP remoto) e audio (mid "0"). */
    function sendingPc() {
        const pc = new (getPeerConnectionClass())({}) as unknown as TestPc;
        const video = pc.addSendingTrack(videoTrack());
        const audio = pc.addSendingTrack(audioTrack());
        video.mid = "1";
        audio.mid = "0";
        return { pc, video };
    }

    const videoLine = (pc: TestPc) => /^m=video .*$/m.exec(pc.descriptionCalls.at(-1)!.description!.sdp!)?.[0];

    test("close e removeTrack viram nada so na contida; conter de novo guarda tudo junto", () => {
        const free = sendingPc();
        const stuck = sendingPc();
        containPeerConnection(stuck.pc as unknown as RTCPeerConnection, ["sender"]);
        containPeerConnection(stuck.pc as unknown as RTCPeerConnection, ["stream"]);
        assert.equal(isContained(stuck.pc as unknown as RTCPeerConnection), true);
        assert.equal(isContained(free.pc as unknown as RTCPeerConnection), false);
        assert.equal(isContained(null), false);

        free.pc.removeTrack(free.video.sender);
        stuck.pc.removeTrack(stuck.video.sender);
        assert.equal(free.video.sender.track, null, "a saudavel tira a faixa");
        assert.ok(stuck.video.sender.track, "a contida nao");
        free.pc.close();
        stuck.pc.close();
        assert.equal(free.pc.connectionState, "closed");
        assert.equal(stuck.pc.connectionState, "connected");
    });

    test("renegociar na contida: setRemoteDescription e setLocalDescription recusados (nada chega ao Chromium), so o rollback passa", async () => {
        setPcHooks({ planFor: () => ({ codec: "vp9", bitrate: { startKbps: 5000, maxKbps: 20000 }, label: "amigo" }) });
        const free = sendingPc();
        const stuck = sendingPc();
        containPeerConnection(stuck.pc as unknown as RTCPeerConnection);
        const mark = logMark();
        await assert.rejects(stuck.pc.setRemoteDescription({ type: "offer", sdp: REMOTE_SDP }), (e: DOMException) => e.name === "InvalidStateError");
        await assert.rejects(stuck.pc.setLocalDescription(), /setLocalDescription recusado/);
        await assert.rejects(stuck.pc.setLocalDescription({ type: "answer", sdp: REMOTE_SDP }), /setLocalDescription recusado/);
        assert.equal(stuck.pc.descriptionCalls.length, 0, "o Chromium nao viu nenhuma");
        assert.equal(stuck.video.codecPreferences, null, "nem preferencia de codec");
        await stuck.pc.setLocalDescription({ type: "rollback" });
        assert.deepEqual(stuck.pc.descriptionCalls.map(c => c.description?.type), ["rollback"]);
        assert.equal(logged(/^setRemoteDescription recusado na conexão com o envio travado pela placa de vídeo/, mark).length, 1, "um aviso por minuto");

        // a saudavel negocia como sempre
        await free.pc.setRemoteDescription({ type: "offer", sdp: REMOTE_SDP });
        assert.equal(videoLine(free.pc), "m=video 9 UDP/TLS/RTP/SAVPF 98 96");
    });
});
