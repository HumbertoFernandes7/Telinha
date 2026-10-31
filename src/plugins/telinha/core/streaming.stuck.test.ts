/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do envio travado na placa de video (core/streaming.ts → containStuck; core/peerConnection.ts →
// containPeerConnection): desmontar esse envio trava o Discord inteiro (o Chromium espera o encoder travado para sempre
// na thread que todas as conexoes usam), entao NENHUM caminho pode mexer no sender, no transceiver ou na conexao dele:
// a qualidade automatica, parar de assistir, expulsar, sair do canal de voz, assistir de novo, pedir VP9, trocar de fonte,
// trocar a senha, parar de transmitir, a sala fechar e o Trystero fechando a conexao (close/removeTrack) ou renegociando.
// Quem assiste e avisado ({ op: "stuck" }); o audio para quem saiu e cortado so com replaceTrack(null) no sender de audio.
// Um envio saudavel continua sendo desmontado normalmente. O codec fica fixado em H.264 no arquivo todo: cada espectador
// novo comeca em H.264 (o 1o travamento desliga o automatico do processo).
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.stuck.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { pluginSettings } from "@test/fakes/vencord";
import { type FakeMediaStreamTrack, type FakeRTCPeerConnection, type FakeRTCRtpSender, videoSenderStats } from "@test/fakes/webrtc";
import {
    connectViewer, createRig, destroyRig, enterCall, leaveCall, logMark, removalsFrom, repliesTo, seconds, setMembers, type StreamingRig, streamsTo, turns,
    videoSenderOf, windowOptions
} from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { containedCount, isContained } from "./peerConnection";
import { H264_STALL_MS, kickViewer, sendPlanFor, setStreamAccess, startStreaming, stopStreaming } from "./streaming";

let rig: StreamingRig;
let seq = 0;

/** SDP do espectador: m=video (mid 0, o nosso envio de video) com o VP8 primeiro, e o audio (mid 1). */
const REMOTE_SDP = [
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 102 98", "a=mid:0", "a=rtpmap:96 VP8/90000", "a=rtpmap:102 H264/90000",
    "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", "a=rtpmap:98 VP9/90000", "a=fmtp:98 profile-id=0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:1", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10",
    ""
].join("\r\n");

interface TestViewer {
    peerId: string;
    discordUserId: string;
    label: string;
    pc: FakeRTCPeerConnection;
    sender: FakeRTCRtpSender;
    audio: FakeRTCRtpSender | null;
    /** getParameters() no sender de video desde que travou */
    getParams: number;
    /** setParameters aceitos ate travar */
    setCallsAtStuck: number;
}

/** Um espectador novo que assiste (H.264, fixado) e cuja 1a negociacao ja aconteceu (o SDP dele passou pelo nosso ajuste). */
async function watcher(name: string): Promise<TestViewer> {
    seq++;
    const peerId = `t${name}`;
    const discordUserId = String(830_000_000_000_000_000n + BigInt(seq));
    const pc = await connectViewer(rig, peerId, discordUserId, name, { h264HwDecode: true });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    // a oferta do addStream (preferencia de codec no transceiver) e a resposta dele (SDP ajustado)
    await (pc as unknown as RTCPeerConnection).setLocalDescription();
    await (pc as unknown as RTCPeerConnection).setRemoteDescription({ type: "answer", sdp: REMOTE_SDP });
    const sender = videoSenderOf(pc)!;
    const audio = pc.getSenders().find(s => s.track?.kind === "audio") ?? null;
    const v: TestViewer = { peerId, discordUserId, label: `${name} (${peerId.slice(0, 6)})`, pc, sender, audio, getParams: 0, setCallsAtStuck: 0 };
    const get = sender.getParameters.bind(sender);
    sender.getParameters = () => {
        v.getParams++;
        return get();
    };
    return v;
}

/** Um espectador cujo H.264 trava: nenhum quadro em H264_STALL_MS (o log de 31/10). */
async function stuckWatcher(name: string): Promise<TestViewer> {
    const v = await watcher(name);
    let frames = 0;
    v.sender.stats = () => videoSenderStats({
        mimeType: "video/H264", framesEncoded: 0, bytesSent: 0, sourceFrames: (frames += 60), sourceFps: 60,
        omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight"]
    });
    await seconds(rig, H264_STALL_MS / 1000 + 2);
    assert.ok(isContained(v.pc as unknown as RTCPeerConnection), `${name}: travou e ficou contido`);
    v.getParams = 0;
    v.setCallsAtStuck = v.sender.setCalls.length;
    return v;
}

/** Um espectador saudavel (o H.264 sai). */
async function healthyWatcher(name: string): Promise<TestViewer> {
    const v = await watcher(name);
    v.sender.stats = videoSenderStats({ mimeType: "video/H264", encoderImplementation: "NVENC", powerEfficientEncoder: true, framesEncoded: 600, bytesSent: 5_000_000 });
    return v;
}

/** Nada mexeu no envio travado: nenhum setParameters/getParameters, nenhum removeStream, a conexao aberta, o video no sender. */
function assertUntouched(v: TestViewer, why: string) {
    assert.equal(v.sender.setCalls.length, v.setCallsAtStuck, `${why}: nenhum setParameters`);
    assert.equal(v.getParams, 0, `${why}: nenhum getParameters`);
    assert.deepEqual(removalsFrom(rig.room, v.peerId), [], `${why}: nenhum removeStream`);
    assert.notEqual(v.pc.connectionState, "closed", `${why}: a conexao continua aberta`);
    assert.ok(v.sender.track, `${why}: a faixa de video continua no sender`);
    assert.equal(sendPlanFor(v.peerId)?.codec ?? "h264", "h264", `${why}: o codec do envio nunca muda`);
    assert.ok(isContained(v.pc as unknown as RTCPeerConnection), `${why}: continua contida`);
}

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            rtc.mediaCapabilities.hwEncode = ["42001f"];
            rtc.mediaCapabilities.hwDecode = ["42001f"];
        }
    });
    for (let i = 0; i < 200 && !getLocalCaps().h264HwEncode; i++) await turns(1);
    await enterCall(rig, []);
    pluginSettings.set("requireVerifiedIdentity", false);
    pluginSettings.set("codec", "h264");
    await startStreaming(windowOptions({ withAudio: true }));
    assert.equal(rt.local?.info.hasAudio, true);
});

after(async () => {
    pluginSettings.set("codec", "auto");
    stopStreaming();
    await destroyRig(rig);
});

describe("envio travado na placa de video: nada desmonta", () => {
    test("a qualidade automatica (setParameters a cada mudanca) deixa o envio travado de fora; o saudavel continua", async () => {
        const a = await stuckWatcher("qa");
        const b = await healthyWatcher("qb");
        await seconds(rig, 4);
        const before = b.sender.setCalls.length;
        // a opcao muda: a qualidade automatica reaplica o degrau de todos os espectadores que ela cuida
        pluginSettings.set("autoQuality", false);
        pluginSettings.set("autoQuality", true);
        await turns();
        assert.ok(b.sender.setCalls.length > before, "o saudavel recebeu setParameters");
        await seconds(rig, 6);
        assertUntouched(a, "qualidade automatica");
        assert.equal(rt.local?.autoQuality?.viewers[a.peerId], undefined, "fora da qualidade automatica");
    });

    test("parar de assistir, expulsar e sair do canal de voz: sem removeStream; so o audio dele e cortado (replaceTrack(null) no sender de audio)", async () => {
        const stop = await stuckWatcher("parou");
        const kicked = await stuckWatcher("expulso");
        const outside = await stuckWatcher("saiu");
        const healthy = await healthyWatcher("normal");
        const since = logMark();

        rig.room.receive("watch", { op: "stop" }, stop.peerId);
        assert.equal(kickViewer(kicked.peerId), true);
        setMembers(rig, [...rig.members].filter(id => id !== outside.discordUserId));
        await turns();
        rig.room.receive("watch", { op: "stop" }, healthy.peerId);
        await turns();

        for (const v of [stop, kicked, outside]) {
            assertUntouched(v, v.label);
            assert.equal(v.audio?.track, null, `${v.label}: o audio parou`);
            assert.equal(rt.local?.viewers.has(v.peerId), false, `${v.label}: nao e mais espectador`);
        }
        assert.deepEqual(repliesTo(rig.room, kicked.peerId).at(-1), { op: "denied", reason: "kicked" });
        assert.equal(removalsFrom(rig.room, healthy.peerId).length, 1, "o saudavel sai como sempre");
        assert.ok(since().includes(`${stop.label} deixou de receber a transmissão (parou de assistir)`));
    });

    test("assistir de novo e pedir VP9: recusados com { op: \"stuck\" }, sem faixa nova nem troca de codec", async () => {
        const v = await stuckWatcher("denovo");
        const added = streamsTo(rig.room, v.peerId).length;
        await seconds(rig, 6);
        rig.room.receive("codec", { codec: "vp9" }, v.peerId);
        await turns();
        rig.room.receive("watch", { op: "stop" }, v.peerId);
        await turns();
        const since = logMark();
        rig.room.receive("watch", { op: "start" }, v.peerId);
        await turns();
        assert.equal(streamsTo(rig.room, v.peerId).length, added, "nenhum addStream: renegociaria a conexao travada");
        assert.deepEqual(repliesTo(rig.room, v.peerId).filter(m => m.op === "stuck").length, 3, "travou + pedido de VP9 + assistir de novo");
        assert.ok(since().some(l => l.startsWith(`${v.label} pediu para assistir, mas a placa de vídeo travou no envio para ele`)));
        assertUntouched(v, "assistir de novo");
    });

    test("o Trystero fechando a conexao (close) ou tirando a faixa (removeTrack): nada acontece; as saudaveis fecham", async () => {
        const v = await stuckWatcher("trystero");
        const healthy = await healthyWatcher("fecha");
        const since = logMark();
        (v.pc as unknown as RTCPeerConnection).removeTrack(v.sender as unknown as RTCRtpSender);
        (v.pc as unknown as RTCPeerConnection).close();
        (healthy.pc as unknown as RTCPeerConnection).close();
        assertUntouched(v, "close/removeTrack");
        assert.equal(healthy.pc.connectionState, "closed");
        assert.ok(since().some(l => l.startsWith("Uma conexão com o envio travado pela placa de vídeo não foi fechada")));
        assert.ok(since().some(l => l.startsWith("Uma faixa da conexão com o envio travado pela placa de vídeo não foi removida")));
    });

    test("renegociacao pedida pelo outro lado (ele passa a transmitir para nos, ou reinicia o ICE): recusada, nada chega ao envio travado", async () => {
        const v = await stuckWatcher("renegocia");
        const negotiations = v.pc.descriptionCalls.length;
        const prefs = v.pc.getTransceivers().map(t => t.codecPreferences);
        const pc = v.pc as unknown as RTCPeerConnection;
        // o que o signal() do Trystero faz com uma oferta: SRD e SLD; a recusa vai para o handler de erro dele
        await assert.rejects(pc.setRemoteDescription({ type: "offer", sdp: REMOTE_SDP }), (e: DOMException) => e.name === "InvalidStateError");
        await assert.rejects(pc.setLocalDescription(), /recusado/);
        assert.equal(v.pc.descriptionCalls.length, negotiations, "o Chromium nao viu nenhuma");
        assert.deepEqual(v.pc.getTransceivers().map(t => t.codecPreferences), prefs, "nenhum setCodecPreferences novo");

        // mesmo depois de ele parar de assistir
        rig.room.receive("watch", { op: "stop" }, v.peerId);
        await turns();
        // desde a 0.2.10 todo peer tem plano (so a banda, START_KBPS); quem nao assiste, sem codec
        assert.equal(sendPlanFor(v.peerId)?.codec, null, "nao e mais espectador");
        await assert.rejects(pc.setRemoteDescription({ type: "offer", sdp: REMOTE_SDP }));
        assert.equal(v.pc.descriptionCalls.length, negotiations);
        assertUntouched(v, "renegociacao");
    });

    test("trocar a senha e trocar de fonte: o envio travado fica de fora (sem removeStream, sem addStream da fonte nova)", async () => {
        const v = await stuckWatcher("fonte");
        const healthy = await healthyWatcher("segue");
        const added = streamsTo(rig.room, v.peerId).length;
        const healthyAdded = streamsTo(rig.room, healthy.peerId).length;
        setStreamAccess("password", "abacaxi");
        await turns();
        assertUntouched(v, "trocar a senha");

        const oldTracks = rt.local!.stream.getTracks() as unknown as FakeMediaStreamTrack[];
        await startStreaming(windowOptions({ withAudio: true, source: { id: "window:999:0", name: "Outro", kind: "window" }, access: "all" }));
        await turns();
        assert.equal(streamsTo(rig.room, v.peerId).length, added, "a fonte nova nao vai para a conexao travada");
        assert.equal(streamsTo(rig.room, healthy.peerId).length, healthyAdded + 1, "o saudavel recebe a fonte nova");
        assert.ok(oldTracks.every(t => t.readyState === "ended"), "a captura antiga parou (tambem a faixa do encoder travado)");
        assert.deepEqual(repliesTo(rig.room, v.peerId).at(-1), { op: "stuck" });
        assertUntouched(v, "trocar de fonte");
    });

    test("parar de transmitir e a sala fechar (o Trystero fecha todas as conexoes): so as saudaveis saem e fecham", async () => {
        const v = await stuckWatcher("fim");
        const healthy = await healthyWatcher("fimok");
        const tracks = rt.local!.stream.getTracks() as unknown as FakeMediaStreamTrack[];
        const since = logMark();
        stopStreaming();
        assert.ok(tracks.every(t => t.readyState === "ended"), "a captura para (track.stop() so para de entregar quadros)");
        assert.equal(removalsFrom(rig.room, healthy.peerId).length, 1);
        assert.ok(since().some(l => l.startsWith(`Envio travado pela placa de vídeo deixado como está para ${v.label}`)));
        assertUntouched(v, "parar de transmitir");

        const { room } = rig;
        await leaveCall(rig);
        assert.equal(room.left, true);
        // o leave() do Trystero destroi cada peer: pc.close()
        for (const p of [v.pc, healthy.pc]) (p as unknown as RTCPeerConnection).close();
        assert.equal(healthy.pc.connectionState, "closed");
        assert.notEqual(v.pc.connectionState, "closed");
        assert.ok(containedCount() >= 8, "todas as conexoes travadas continuam guardadas");
    });
});
