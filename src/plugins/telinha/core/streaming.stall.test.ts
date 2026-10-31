/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do H.264 que nao sai (core/streaming.ts → checkStall, no tick): com a conexao e a captura no ar, nada do video
// de um envio H.264 sai do PC. Dois casos vistos em 31/10 numa placa AMD: o encoder nao codifica nenhum quadro
// ("Codificando para ...: video/H264" sem encoderImplementation, 0.2.6) e, as 02:54, o encoder sobe e codifica, mas nenhum
// pacote de video sai (o espectador so recebe o audio). Desde a v0.2.9, passados H264_STALL_MS a placa de video travou: o
// envio fica CONTIDO, sem trocar o codec (a troca destruia o envio e travava o Discord; containStuck), o H.264 automatico
// desliga na hora (sem esperar a 2a queda), o PC lembra, quem transmite ve o aviso e quem assiste recebe { op: "stuck" }.
// Um envio que sai de fato (SENT_MIN_BYTES), um encoder lento ou uma tela preta parada (poucos bytes por quadro) nunca
// sao culpados. Este PC "codifica H.264 na placa" pela sonda falsa e o espectador anuncia h264HwDecode, como em
// streaming.encoder.test.ts. O travamento desliga o H.264 automatico no processo: a ordem dos testes importa (primeiro
// os envios saudaveis, depois o 1o travamento no automatico, depois so com o codec fixado em H.264). O que nunca mexe no
// envio travado (parar, expulsar, trocar de fonte...) fica em streaming.stuck.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.stall.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { rt } from "@plugins/telinha/core/context";
import { pluginSettings } from "@test/fakes/vencord";
import { type FakeRTCPeerConnection, type FakeRTCRtpSender, type StatsEntry, videoSenderStats } from "@test/fakes/webrtc";
import {
    connectViewer, createRig, destroyRig, enterCall, logMark, removalsFrom, repliesTo, screenOptions, seconds, type StreamingRig, turns, videoSenderOf
} from "@test/helpers/wpb-streaming";

import { getLocalCaps } from "./codec";
import { isContained } from "./peerConnection";
import { STATS_LINE_RE } from "./statsLog";
import { H264_STALL_MS, sendPlanFor, SENT_MIN_BYTES, startStreaming, stopStreaming } from "./streaming";
import { STUCK_NOTICE, STUCK_NOTICE_PINNED, stuckEncoderDiagnostics, stuckRecord } from "./stuckEncoder";

/** O encoder do log das 02:54 (placa AMD, Telinha 0.2.6). */
const AMD = "MediaFoundationVideoEncodeAccelerator (AMDh264Encoder)";

let rig: StreamingRig;
let seq = 0;

interface TestViewer {
    peerId: string;
    label: string;
    pc: FakeRTCPeerConnection;
    sender: FakeRTCRtpSender;
}

/** Um espectador novo (decodifica H.264 por hardware) que pede para assistir. */
async function watcher(name: string): Promise<TestViewer> {
    seq++;
    const peerId = `s${name}`;
    const pc = await connectViewer(rig, peerId, String(810_000_000_000_000_000n + BigInt(seq)), name, { h264HwDecode: true });
    rig.room.receive("watch", { op: "start" }, peerId);
    await turns();
    return { peerId, label: `${name} (${peerId.slice(0, 6)})`, pc, sender: videoSenderOf(pc)! };
}

interface EncoderPlan {
    /** quadros por segundo que a captura entrega (media-source); 0 = parada (janela minimizada) */
    sourceFps?: number;
    /** ms (desde agora) em que o encoder solta o 1o quadro; ausente = nunca */
    encodesAfterMs?: number;
    /** bytes de video que saem por quadro codificado (padrao 2000: ~1 Mbps a 60 fps; uma tela preta parada: poucos) */
    bytesPerFrame?: number;
    /** teto do bytesSent: passado dele, nada mais sai (0 = nada sai nunca, o log das 02:54) */
    sentCap?: number;
    /** framesSent sempre 0 (um navegador que so conta o que saiu); sem isto, igual ao framesEncoded, como no libwebrtc */
    framesSentZero?: boolean;
    /** contadores do que saiu que o navegador nao relata: "bytes" (so o bytesSent) ou "all" (bytesSent e framesSent) */
    unreported?: "bytes" | "all";
}

/**
 * Estatisticas de um envio H.264 que seguem o relogio. Sem quadro codificado, como no log de 31/10 (0.2.6):
 * framesEncoded, framesSent e bytesSent 0, sem encoderImplementation, powerEfficientEncoder nem tamanho. Depois do 1o
 * quadro: o encoder AMD a 60 fps e o que sai dele (bytesPerFrame, ate sentCap). A captura (media-source) entrega
 * `sourceFps` por segundo. Mudar o plano no meio (plan.sourceFps = ...) vale dali em diante.
 */
function h264Stats(plan: EncoderPlan) {
    let at = rig.clock.now();
    let source = 0;
    const start = at;
    const omitSent = plan.unreported ? ["bytesSent" as const] : [];
    const withFramesSent = (entries: StatsEntry[], framesSent: number) => {
        if (plan.unreported !== "all") entries[0].framesSent = framesSent;
        return entries;
    };
    return (): StatsEntry[] => {
        const now = rig.clock.now();
        source += Math.round((now - at) / 1000 * (plan.sourceFps ?? 60));
        at = now;
        const encodedFor = plan.encodesAfterMs == null ? -1 : now - start - plan.encodesAfterMs;
        if (encodedFor < 0) {
            return withFramesSent(videoSenderStats({
                mimeType: "video/H264", framesEncoded: 0, bytesSent: 0, sourceFrames: source, sourceFps: plan.sourceFps ?? 60,
                omit: ["encoderImplementation", "powerEfficientEncoder", "frameWidth", "frameHeight", ...omitSent]
            }), 0);
        }
        const encoded = 1 + Math.round(encodedFor / 1000 * 60);
        return withFramesSent(videoSenderStats({
            mimeType: "video/H264", encoderImplementation: AMD, powerEfficientEncoder: true, framesEncoded: encoded,
            bytesSent: Math.min(encoded * (plan.bytesPerFrame ?? 2000), plan.sentCap ?? Infinity),
            sourceFrames: source, sourceFps: plan.sourceFps ?? 60, omit: omitSent
        }), plan.framesSentZero ? 0 : encoded);
    };
}

/** Linhas do log sobre este espectador (sem as do log de estatisticas). */
const about = (lines: string[], v: TestViewer) => lines.filter(l => l.includes(v.label) && !STATS_LINE_RE.test(l));

/** So os avisos de H.264 que nao sai deste espectador. */
const stalls = (lines: string[], v: TestViewer) => about(lines, v).filter(l => l.includes("não codificou") || l.includes("nenhum saiu"));

/** O codec fixado no encodings[0] do envio (undefined = o negociado). */
const sentCodec = (sender: FakeRTCRtpSender) => sender.encoding.codec?.mimeType;

const stalled = (v: TestViewer, seconds: number, source: number) =>
    `O encoder H.264 para ${v.label} não codificou nenhum quadro em ${seconds} s, com a conexão no ar e a captura entregando quadros `
    + `(${source} quadros da captura, 0 codificados, 0 enviados, 0,0 kB enviados, encoder não informado pelo Chromium, tamanho desconhecido)`;

/** O fim da linha de log de um envio contido (containStuck). */
const contained = (v: TestViewer) => `: a placa de vídeo travou com H.264. O envio para ${v.label} fica como está até o Discord reiniciar `
    + "(trocar o codec, parar ou fechar a conexão travaria o Discord inteiro). O H.264 automático fica desligado neste PC até o driver, o Discord ou a placa mudarem.";

/** O envio ficou contido: nenhum codec trocado, o plano continua H.264, a conexao contida e o espectador avisado. */
function assertContained(v: TestViewer) {
    assert.equal(v.sender.encoding.codec, undefined, "o codec nunca foi trocado (setParameters com codec destruiria o envio)");
    assert.ok(v.sender.setCalls.every(p => !(p.encodings[0] as { codec?: unknown; }).codec), "nenhum setParameters com codec");
    assert.equal(sendPlanFor(v.peerId)?.codec, "h264", "send.decision nao mudou: renegociar nao troca o codec");
    assert.ok(isContained(v.pc as unknown as RTCPeerConnection), "a conexao ficou contida");
    assert.deepEqual(repliesTo(rig.room, v.peerId).filter(m => m.op === "stuck"), [{ op: "stuck" }], "quem assiste foi avisado uma vez");
}

/** Codec fixado em H.264 durante `fn`. */
async function pinnedH264(fn: () => Promise<void>) {
    pluginSettings.set("codec", "h264");
    try {
        await fn();
    } finally {
        pluginSettings.set("codec", "auto");
    }
}

before(async () => {
    rig = createRig({
        beforeSession: rtc => {
            rtc.mediaCapabilities.hwEncode = ["42001f"];
            rtc.mediaCapabilities.hwDecode = ["42001f"];
        }
    });
    for (let i = 0; i < 200 && !getLocalCaps().h264HwEncode; i++) await turns(1);
    assert.equal(getLocalCaps().h264HwProfile, "42001f", "a sonda achou o H.264 na placa");
    await enterCall(rig, []);
    pluginSettings.set("autoQuality", false);
    pluginSettings.set("requireVerifiedIdentity", false);
    await startStreaming(screenOptions());
});

after(async () => {
    stopStreaming();
    await destroyRig(rig);
});

describe("H.264 que nao sai do PC (checkStall)", () => {
    test("encoder lento que solta o 1o quadro aos 5 s: nunca e culpado, nem depois", async () => {
        const v = await watcher("lento");
        const plan: EncoderPlan = { encodesAfterMs: 5000 };
        v.sender.stats = h264Stats(plan);
        const since = logMark();
        await seconds(rig, 20);
        assert.equal(v.sender.encoding.codec, undefined);
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        assert.deepEqual(about(since(), v).filter(l => !l.startsWith("Codificando para")), []);
        assert.equal(isContained(v.pc as unknown as RTCPeerConnection), false);
        assert.equal(getLocalCaps().h264HwEncode, true);
    });

    test("H.264 saindo de verdade nunca e culpado; uma tela preta parada, com poucos bytes por quadro, tambem nao", async () => {
        const healthy = await watcher("saudavel");
        healthy.sender.stats = h264Stats({ encodesAfterMs: 0 });
        // ~5 bytes por quadro: abaixo de SENT_MIN_BYTES por mais de um minuto, mas o bytesSent anda a cada leitura
        const black = await watcher("preta");
        black.sender.stats = h264Stats({ encodesAfterMs: 0, bytesPerFrame: 5 });
        const since = logMark();
        await seconds(rig, 30);
        for (const v of [healthy, black]) {
            assert.equal(v.sender.encoding.codec, undefined, v.label);
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264", v.label);
            assert.deepEqual(about(since(), v), [`Codificando para ${v.label}: video/H264 (${AMD}, hardware)`], v.label);
        }
        assert.ok(31 * 60 * 5 < SENT_MIN_BYTES, "a tela preta ainda nao tinha passado de SENT_MIN_BYTES");
        assert.equal(getLocalCaps().h264HwEncode, true);
    });

    test("captura parada (janela minimizada) ou conexao ainda nao conectada: nao culpa o encoder", async () => {
        const idle = await watcher("parada");
        idle.sender.stats = h264Stats({ sourceFps: 0 });
        const connecting = await watcher("conectando");
        connecting.pc.setConnectionState("connecting");
        connecting.sender.stats = h264Stats({});
        const since = logMark();
        await seconds(rig, 30);
        for (const v of [idle, connecting]) {
            assert.equal(v.sender.encoding.codec, undefined, v.label);
            assert.deepEqual(about(since(), v).filter(l => !l.startsWith("Codificando para")), [], v.label);
        }
        connecting.pc.setConnectionState("connected");
        stopWatching(connecting);
        stopWatching(idle);
        await turns();
        assert.equal(rt.lastError, null, "nenhum aviso de placa travada");
    });

    test("log de 31/10 (0.2.6): nenhum quadro em 8 s com a captura no ar → travou, contido (sem trocar o codec); o H.264 automatico desliga ja na 1a", async () => {
        const v = await watcher("gupi");
        const other = await watcher("leo");
        other.sender.stats = videoSenderStats({ mimeType: "video/H264", encoderImplementation: AMD, powerEfficientEncoder: true, framesEncoded: 600 });
        assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
        v.sender.stats = h264Stats({});
        const since = logMark();
        await seconds(rig, 1); // 1a leitura: comeca a contar
        await seconds(rig, H264_STALL_MS / 1000 - 1);
        assert.equal(rt.lastError, null, "7 s: ainda esperando");
        assert.deepEqual(about(since(), v), [`Codificando para ${v.label}: video/H264`], "o mesmo que o log de 31/10 mostrou");

        await seconds(rig, 1);
        assertContained(v);
        assert.deepEqual(about(since(), v).slice(1), [`${stalled(v, 8, 480)}${contained(v)}`], "nada de \"trocando para VP9\"");
        assert.equal(rt.lastError, STUCK_NOTICE, "o aviso na barra do Telinha");
        assert.equal(getLocalCaps().h264HwEncode, false, "H.264 automatico desligado na hora, sem esperar a 2a queda");
        assert.ok(stuckRecord(), "lembrado neste PC");
        assert.equal(other.sender.encoding.codec, undefined, "o outro espectador continua em H.264");
        assert.equal(sendPlanFor(other.peerId)?.codec, "h264");

        // o tick nao le mais esse envio (nem as estatisticas: nada mais e conferido nele)
        const reads = v.sender.getStatsCalls;
        await seconds(rig, 10);
        assert.equal(v.sender.getStatsCalls, reads);
        assert.equal(stalls(since(), v).length, 1);
        assertContained(v);

        assert.ok(stuckEncoderDiagnostics().includes("travou nesta sessão: sim (1 conexão contida)"));

        // os proximos ja comecam em VP9 (nenhum encoder H.264 da placa e criado)
        const next = await watcher("depois");
        assert.equal(sendPlanFor(next.peerId)?.codec, "vp9");

        // ele para de assistir: sem removeStream (a transmissao e so de tela, sem audio para cortar)
        stopWatching(v);
        await turns();
        assert.equal(removalsFrom(rig.room, v.peerId).length, 0);
        assert.ok(v.sender.track, "a faixa continua no envio travado");
    });

    test("log das 02:54 (codec fixado em H.264): o encoder AMD codifica, mas nada sai (0 enviados, 0 kB) → travou, contido; o aviso pede o Automatico", async () => {
        await pinnedH264(async () => {
            const v = await watcher("tobitsu");
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            v.sender.stats = h264Stats({ encodesAfterMs: 0, sentCap: 0, framesSentZero: true });
            const since = logMark();
            await seconds(rig, 1);
            await seconds(rig, H264_STALL_MS / 1000 - 1);
            assert.deepEqual(about(since(), v), [`Codificando para ${v.label}: video/H264 (${AMD}, hardware)`], "o mesmo que o log das 02:54 mostrou");

            await seconds(rig, 1);
            assertContained(v);
            assert.deepEqual(about(since(), v).slice(1), [
                `O H.264 para ${v.label} codificou quadros, mas nenhum saiu deste PC em 8 s, com a conexão no ar e a captura entregando quadros `
                + `(480 quadros da captura, 541 codificados, 0 enviados, 0,0 kB enviados, encoder ${AMD}, 1920x1080)${contained(v)}`
            ]);
            assert.equal(rt.lastError, STUCK_NOTICE_PINNED);
        });
    });

    test("com o libwebrtc (framesSent = framesEncoded): o bytesSent parado tambem e nada saindo", async () => {
        await pinnedH264(async () => {
            const v = await watcher("libwebrtc");
            v.sender.stats = h264Stats({ encodesAfterMs: 0, sentCap: 0 });
            const since = logMark();
            await seconds(rig, H264_STALL_MS / 1000 + 1);
            assert.deepEqual(stalls(since(), v), [
                `O H.264 para ${v.label} codificou quadros, mas nenhum saiu deste PC em 8 s, com a conexão no ar e a captura entregando quadros `
                + `(480 quadros da captura, 541 codificados, 541 enviados, 0,0 kB enviados, encoder ${AMD}, 1920x1080)${contained(v)}`
            ]);
            assertContained(v);
        });
    });

    test("so o comeco sai (8 kB) e depois nada: pego 8 s depois do ultimo byte; com 20 kB ou mais saindo, a checagem acaba", async () => {
        await pinnedH264(async () => {
            // o 1o quadro sai aos 2 s e o resto para em 8 kB (aos 3 s): a janela recomeca a cada byte que sai
            const small = await watcher("chave");
            small.sender.stats = h264Stats({ encodesAfterMs: 2000, sentCap: 8000 });
            const big = await watcher("grande");
            big.sender.stats = h264Stats({ encodesAfterMs: 2000, sentCap: SENT_MIN_BYTES + 10_000 });
            const since = logMark();
            await seconds(rig, 3 + H264_STALL_MS / 1000 - 1);
            assert.deepEqual(stalls(since(), small), [], "conta do ultimo byte que saiu, nao do comeco");
            await seconds(rig, 1);
            assert.deepEqual(stalls(since(), small), [
                `O H.264 para ${small.label} codificou quadros, mas nenhum saiu deste PC em 8 s, com a conexão no ar e a captura entregando quadros `
                + `(480 quadros da captura, 541 codificados, 541 enviados, 8,0 kB enviados, encoder ${AMD}, 1920x1080)${contained(small)}`
            ]);
            assertContained(small);

            // passou de SENT_MIN_BYTES: o video saiu de fato e a checagem acabou (se o espectador nao decodifica, ele pede VP9)
            await seconds(rig, 20);
            assert.deepEqual(stalls(since(), big), []);
            assert.equal(isContained(big.pc as unknown as RTCPeerConnection), false);
            assert.equal(stalls(since(), small).length, 1, "uma vez por espectador");
        });
    });

    test("codec fixado em H.264: a captura volta depois de parada e conta 8 s dali; travou = contido, continua em H.264", async () => {
        await pinnedH264(async () => {
            const v = await watcher("volta");
            assert.equal(sendPlanFor(v.peerId)?.codec, "h264");
            const plan: EncoderPlan = { sourceFps: 0 };
            v.sender.stats = h264Stats(plan);
            const since = logMark();
            await seconds(rig, 6);
            plan.sourceFps = 30; // a janela foi restaurada
            await seconds(rig, H264_STALL_MS / 1000 - 1);
            assert.deepEqual(stalls(since(), v), [], "conta do momento em que a captura voltou, nao de quando parou");
            await seconds(rig, 1);
            assert.deepEqual(stalls(since(), v), []);
            await seconds(rig, 1);
            const lines = stalls(since(), v);
            assert.equal(lines.length, 1);
            assert.match(lines[0], /^O encoder H\.264 para volta \(svolta\) não codificou nenhum quadro em 8 s, com a conexão no ar e a captura entregando quadros \(2\d0 quadros/);
            assert.ok(lines[0].endsWith(contained(v)), lines[0]);
            assertContained(v);
        });
    });

    test("sem bytesSent nas estatisticas vale o framesSent; sem nenhum dos dois, o 1o quadro codificado (como antes)", async () => {
        await pinnedH264(async () => {
            // so o framesSent, parado em 0 com o encoder codificando: nada sai
            const framesOnly = await watcher("quadros");
            framesOnly.sender.stats = h264Stats({ encodesAfterMs: 0, framesSentZero: true, unreported: "bytes" });
            // nenhum contador do que saiu: o 1o quadro codificado (aos 5 s) encerra a checagem
            const late = await watcher("antigo");
            late.sender.stats = h264Stats({ encodesAfterMs: 5000, unreported: "all" });
            // nenhum contador e nenhum quadro: o caso de 31/10 (0.2.6), o aviso sem os enviados
            const none = await watcher("nada");
            none.sender.stats = h264Stats({ unreported: "all" });
            const since = logMark();
            await seconds(rig, H264_STALL_MS / 1000 + 1);
            assert.deepEqual(stalls(since(), framesOnly), [
                `O H.264 para ${framesOnly.label} codificou quadros, mas nenhum saiu deste PC em 8 s, com a conexão no ar e a captura entregando quadros `
                + `(480 quadros da captura, 541 codificados, 0 enviados, encoder ${AMD}, 1920x1080)${contained(framesOnly)}`
            ]);
            assert.deepEqual(stalls(since(), none), [
                `O encoder H.264 para ${none.label} não codificou nenhum quadro em 8 s, com a conexão no ar e a captura entregando quadros `
                + `(480 quadros da captura, 0 codificados, encoder não informado pelo Chromium, tamanho desconhecido)${contained(none)}`
            ]);
            await seconds(rig, 15);
            assert.deepEqual(stalls(since(), late), []);
            assert.equal(isContained(late.pc as unknown as RTCPeerConnection), false);
        });
    });
});

function stopWatching(v: TestViewer) {
    rig.room.receive("watch", { op: "stop" }, v.peerId);
}
