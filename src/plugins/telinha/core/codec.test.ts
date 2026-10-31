/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do codec de envio (core/codec.ts + a ordem dos codecs no SDP remoto, core/sdp.ts): sonda de H.264 por hardware
// por perfil, chooseCodec, ordem das variantes e a checagem do encoder no ar. RTCRtpSender/RTCRtpReceiver e
// navigator.mediaCapabilities sao falsos em globalThis. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/core/codec.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    applyCodecPreferences, chooseCodec, type CodecDecision, describeLocalCaps, type EncoderReport, getLocalCaps, h264Candidates, h264HwAcceptsSize,
    isSoftwareH264, isTransientSoftwareH264, type LocalCodecCaps, measureLocalCaps, noteH264Fallback, pickNegotiatedCodec, probeLocalCaps,
    softwareFallback, sortCodecs
} from "./codec";
import { h264ProfileLevelId, h264Rank, mungeRemoteSdp } from "./sdp";

type Codec = RTCRtpCodec;

const h264 = (mode: 0 | 1, profile: string): Codec => ({
    mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`
});
const plain = (name: string, fmtp?: string): Codec => ({ mimeType: `video/${name}`, clockRate: 90000, ...(fmtp ? { sdpFmtpLine: fmtp } : {}) });

/** Como o Chromium 152 lista as capacidades de video (rtx/red/ulpfec sem fmtp). */
const CHROMIUM_CAPS: Codec[] = [
    h264(1, "42001f"), plain("rtx"), plain("VP8"), h264(0, "42001f"), h264(1, "42e01f"), h264(0, "42e01f"),
    h264(1, "4d001f"), h264(0, "4d001f"), plain("AV1", "level-idx=5;profile=0;tier=0"), plain("VP9", "profile-id=0"),
    plain("VP9", "profile-id=2"), h264(1, "640032"), h264(0, "640032"), plain("H265", "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST"),
    plain("red"), plain("ulpfec")
];

const g = globalThis as any;

function setCaps(sender: Codec[] | null, receiver: Codec[] | null = sender) {
    const api = (codecs: Codec[] | null) => (codecs ? { getCapabilities: (kind: string) => (kind === "video" ? { codecs, headerExtensions: [] } : null) } : undefined);
    g.RTCRtpSender = api(sender);
    g.RTCRtpReceiver = api(receiver);
}

interface FakeMc {
    /** perfis (profile-level-id) que o falso diz serem por hardware com packetization-mode=1 */
    encode?: string[];
    decode?: string[];
    /** perfis cuja consulta nunca responde */
    hang?: string[];
    /** perfis cuja consulta lanca */
    throws?: string[];
}

interface ProbeCall {
    kind: "encodingInfo" | "decodingInfo";
    config: any;
    profile: string | null;
}

/** navigator.mediaCapabilities falso; devolve a lista de consultas feitas. */
function setMediaCapabilities(fake: FakeMc | null): ProbeCall[] {
    const calls: ProbeCall[] = [];
    const answer = (kind: ProbeCall["kind"], hw: string[]) => (config: any) => {
        const { contentType } = config.video as { contentType: string; };
        const profile = h264ProfileLevelId(contentType);
        calls.push({ kind, config, profile });
        if (profile && fake?.throws?.includes(profile)) throw new TypeError("configuração inválida");
        if (profile && fake?.hang?.includes(profile)) return new Promise(() => { });
        const powerEfficient = !!profile && hw.includes(profile) && /packetization-mode=1/.test(contentType);
        return Promise.resolve({ supported: true, smooth: true, powerEfficient });
    };
    const mediaCapabilities = fake ? { encodingInfo: answer("encodingInfo", fake.encode ?? []), decodingInfo: answer("decodingInfo", fake.decode ?? []) } : undefined;
    Object.defineProperty(globalThis, "navigator", { value: { mediaCapabilities }, configurable: true, writable: true });
    return calls;
}

/** RTX 3070 (spike): codifica por hardware em 42001f, 4d001f e 640032 (packetization-mode=1); decodifica tudo. */
const RTX_3070: FakeMc = { encode: ["42001f", "4d001f", "640032"], decode: ["42001f", "42e01f", "4d001f", "640032"] };

const FAST = { callMs: 40, totalMs: 1000 };

const encodeCalls = (calls: ProbeCall[]) => calls.filter(c => c.kind === "encodingInfo");

function caps(over: Partial<LocalCodecCaps> = {}): LocalCodecCaps {
    return { h264HwDecode: true, h264HwEncode: true, h264HwProfile: "42001f", sendable: new Set(["h264", "vp8", "vp9", "av1"]), ...over };
}

describe("sonda de H.264 por hardware, por perfil", () => {
    test("RTX 3070: 42001f por hardware (o primeiro packetization-mode=1 da lista); a sonda para nele", async () => {
        setCaps(CHROMIUM_CAPS);
        const calls = setMediaCapabilities(RTX_3070);
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h264HwEncode, true);
        assert.equal(local.h264HwProfile, "42001f");
        assert.equal(local.h264HwDecode, true);
        assert.deepEqual([...local.sendable].sort(), ["av1", "h264", "vp8", "vp9"]);
        const enc = encodeCalls(calls);
        assert.equal(enc.length, 1);
        assert.deepEqual(enc[0].config, {
            type: "webrtc",
            video: { contentType: "video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", width: 1920, height: 1080, bitrate: 8e6, framerate: 60 }
        });
    });

    test("so 42001f por hardware, lista com 42e01f primeiro: pula o 42e01f", async () => {
        setCaps([h264(1, "42e01f"), h264(0, "42e01f"), h264(0, "42001f"), h264(1, "42001f"), plain("VP9", "profile-id=0")]);
        const calls = setMediaCapabilities({ encode: ["42001f"], decode: ["42001f"] });
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h264HwProfile, "42001f");
        assert.deepEqual(encodeCalls(calls).map(c => c.profile), ["42e01f", "42001f"]);
    });

    test("hardware so no High: percorre os packetization-mode=1 em ordem e nunca consulta packetization-mode=0", async () => {
        setCaps(CHROMIUM_CAPS);
        const calls = setMediaCapabilities({ encode: ["640032"], decode: [] });
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h264HwProfile, "640032");
        assert.equal(local.h264HwDecode, false);
        assert.deepEqual(encodeCalls(calls).map(c => c.profile), ["42001f", "42e01f", "4d001f", "640032"]);
        for (const c of calls) assert.match(c.config.video.contentType, /packetization-mode=1/);
    });

    test("nenhum perfil por hardware: codifica nao, perfil null", async () => {
        setCaps(CHROMIUM_CAPS);
        const calls = setMediaCapabilities({ encode: [], decode: ["42001f"] });
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h264HwEncode, false);
        assert.equal(local.h264HwProfile, null);
        assert.equal(local.h264HwDecode, true);
        assert.equal(encodeCalls(calls).length, 4);
        assert.match(describeLocalCaps(local), /codifica: não; envia: /);
    });

    test("consulta que nao responde conta como nao (timeout por consulta) e a sonda segue", async () => {
        setCaps(CHROMIUM_CAPS);
        setMediaCapabilities({ ...RTX_3070, hang: ["42001f"] });
        const started = Date.now();
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h264HwProfile, "4d001f");
        assert.ok(Date.now() - started < 600, "uma consulta travada custa so callMs");
    });

    test("teto da sonda inteira: tudo travado termina em totalMs, sem hardware", async () => {
        setCaps(CHROMIUM_CAPS);
        const calls = setMediaCapabilities({ hang: ["42001f", "42e01f", "4d001f", "640032"] });
        const started = Date.now();
        const local = await measureLocalCaps({ callMs: 60, totalMs: 100 });
        const elapsed = Date.now() - started;
        assert.equal(local.h264HwEncode, false);
        assert.equal(local.h264HwDecode, false);
        assert.ok(elapsed < 500, `demorou ${elapsed} ms`);
        assert.ok(encodeCalls(calls).length <= 2, "parou antes de consultar todos os perfis");
    });

    test("consulta que lanca conta como nao", async () => {
        setCaps(CHROMIUM_CAPS);
        setMediaCapabilities({ ...RTX_3070, throws: ["42001f"] });
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h264HwProfile, "4d001f");
    });

    test("sem mediaCapabilities ou sem RTCRtpSender: tudo nao", async () => {
        setCaps(CHROMIUM_CAPS);
        setMediaCapabilities(null);
        assert.deepEqual({ ...(await measureLocalCaps(FAST)), sendable: null }, { h264HwDecode: false, h264HwEncode: false, h264HwProfile: null, sendable: null });
        setCaps(null);
        setMediaCapabilities(RTX_3070);
        const local = await measureLocalCaps(FAST);
        assert.equal(local.h264HwEncode, false);
        assert.equal(local.sendable.size, 0);
    });

    test("decodifica: uma consulta, no primeiro packetization-mode=1 do RECEIVER", async () => {
        setCaps(CHROMIUM_CAPS, [h264(0, "42e01f"), h264(1, "4d001f"), h264(1, "42001f")]);
        const calls = setMediaCapabilities({ decode: ["4d001f"] });
        const local = await measureLocalCaps(FAST);
        const dec = calls.filter(c => c.kind === "decodingInfo");
        assert.deepEqual(dec.map(c => c.profile), ["4d001f"]);
        assert.equal(dec[0].config.type, "webrtc");
        assert.equal(local.h264HwDecode, true);
    });

    test("h264Candidates: um fmtp por perfil, so packetization-mode=1, na ordem", () => {
        assert.deepEqual(h264Candidates([...CHROMIUM_CAPS, h264(1, "42001f")]).map(f => h264ProfileLevelId(f)), ["42001f", "42e01f", "4d001f", "640032"]);
    });

    test("linha de log com o perfil", () => {
        assert.equal(
            describeLocalCaps(caps({ sendable: new Set(["h264", "vp9"]) })),
            "Capacidades locais: H.264 por hardware — decodifica: sim, codifica: sim (perfil 42001f); envia: h264, vp9"
        );
    });
});

describe("chooseCodec", () => {
    const HW = { h264HwDecode: true };
    const NO_HW = { h264HwDecode: false };

    test("automatico", () => {
        const both = chooseCodec(HW, "auto", caps());
        assert.equal(both.codec, "h264");
        assert.equal(both.h264Profile, "42001f");
        assert.match(both.reason, /hardware nos dois lados \(perfil 42001f\)/);

        assert.deepEqual(chooseCodec(NO_HW, "auto", caps()), { codec: "vp9", reason: "automático: o espectador não decodifica H.264 por hardware → VP9" });
        assert.equal(chooseCodec(undefined, "auto", caps()).codec, "vp9");
        assert.deepEqual(chooseCodec(HW, "auto", caps({ h264HwEncode: false, h264HwProfile: null })), { codec: "vp9", reason: "automático: este PC não codifica H.264 por hardware → VP9" });
        // perfil achado, mas o encoder caiu para software no ar (h264HwEncode desligado)
        assert.equal(chooseCodec(HW, "auto", caps({ h264HwEncode: false })).codec, "vp9");
        assert.equal(chooseCodec(HW, "auto", caps({ sendable: new Set(["vp8", "vp9"]) })).codec, "vp9");
        assert.deepEqual(chooseCodec(NO_HW, "auto", caps({ sendable: new Set(["h264", "vp8"]) })).codec, "vp8");
        // sendable vazio = desconhecido: nao bloqueia
        assert.equal(chooseCodec(HW, "auto", caps({ sendable: new Set() })).codec, "h264");
    });

    test("fixado nas configuracoes", () => {
        assert.deepEqual(chooseCodec(NO_HW, "h264", caps()), { codec: "h264", h264Profile: "42001f", reason: "fixado nas configurações" });
        assert.deepEqual(chooseCodec(NO_HW, "h264", caps({ h264HwEncode: false, h264HwProfile: null })), { codec: "h264", h264Profile: null, reason: "fixado nas configurações" });
        assert.deepEqual(chooseCodec(HW, "av1", caps()), { codec: "av1", reason: "fixado nas configurações" });
        assert.deepEqual(chooseCodec(HW, "av1", caps({ sendable: new Set(["h264", "vp9"]) })), { codec: "vp9", reason: "AV1 (configurações) indisponível neste cliente → VP9" });
    });
});

describe("ordem das variantes (setCodecPreferences)", () => {
    const fmtps = (list: Codec[]) => list.map(c => `${c.mimeType.slice(6)} ${c.sdpFmtpLine ?? ""}`.trim());
    const REMOTE_ORDER: Codec[] = [h264(1, "42e01f"), h264(0, "42001f"), plain("VP8"), h264(1, "42001f"), h264(1, "4d001f"), h264(0, "42e01f"), plain("VP9", "profile-id=2"), plain("VP9", "profile-id=0")];

    test("H.264: o perfil por hardware primeiro, depois os outros packetization-mode=1, depois o resto", () => {
        const { sorted, matched } = sortCodecs(REMOTE_ORDER, "h264", "42001f");
        assert.equal(matched, 5);
        assert.deepEqual(fmtps(sorted), [
            "H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
            "H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
            "H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
            "H264 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f",
            "H264 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f",
            "VP8",
            "VP9 profile-id=2",
            "VP9 profile-id=0"
        ]);
    });

    test("H.264 sem perfil por hardware: so packetization-mode=1 na frente (como na v0.2.0)", () => {
        assert.deepEqual(fmtps(sortCodecs(REMOTE_ORDER, "h264").sorted).slice(0, 3), [
            "H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
            "H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
            "H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f"
        ]);
    });

    test("perfil compara profile_idc + profile_iop, nao o nivel", () => {
        assert.equal(h264Rank("packetization-mode=1;profile-level-id=640034", "640032"), 0);
        assert.equal(h264Rank("packetization-mode=1;profile-level-id=42E01F", "42001f"), 1);
        assert.equal(h264Rank("packetization-mode=0;profile-level-id=42001f", "42001f"), 2);
        assert.equal(h264Rank("a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", "42001f"), 0);
    });

    test("VP9: perfil 0 na frente", () => {
        assert.deepEqual(fmtps(sortCodecs(REMOTE_ORDER, "vp9").sorted).slice(0, 2), ["VP9 profile-id=0", "VP9 profile-id=2"]);
    });

    test("applyCodecPreferences: perfil por hardware primeiro; cai para as capacidades do receiver", () => {
        setCaps(REMOTE_ORDER);
        let applied: Codec[] = [];
        const ok = { setCodecPreferences: (list: Codec[]) => { applied = list; } } as unknown as RTCRtpTransceiver;
        assert.equal(applyCodecPreferences(ok, "h264", "42001f"), "H264 (perfil 42001f) primeiro (5 variante(s), capacidades do sender)");
        assert.equal(applied[0].sdpFmtpLine, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f");

        let tries = 0;
        const picky = {
            setCodecPreferences: (list: Codec[]) => {
                if (tries++ === 0) throw new DOMException("codec do sender recusado", "InvalidModificationError");
                applied = list;
            }
        } as unknown as RTCRtpTransceiver;
        assert.equal(applyCodecPreferences(picky, "vp9"), "VP9 primeiro (2 variante(s), capacidades do receiver)");
        assert.equal(applied[0].sdpFmtpLine, "profile-id=0");

        setCaps([plain("VP8")]);
        assert.equal(applyCodecPreferences(ok, "h264", "42001f"), "setCodecPreferences não aplicado (H264 ausente em receiver.getCapabilities)");
    });
});

describe("SDP remoto (mungeRemoteSdp)", () => {
    // resposta de um espectador que lista 42e01f (OpenH264 aqui) antes de 42001f (placa de video)
    const REMOTE = [
        "v=0",
        "o=- 1 2 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0",
        "m=video 9 UDP/TLS/RTP/SAVPF 108 109 114 102 103 104 116 96 98",
        "c=IN IP4 0.0.0.0",
        "a=mid:0",
        "a=recvonly",
        "a=rtpmap:108 H264/90000",
        "a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        "a=rtpmap:109 rtx/90000",
        "a=fmtp:109 apt=108",
        "a=rtpmap:114 H264/90000",
        "a=fmtp:114 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f",
        "a=rtpmap:102 H264/90000",
        "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
        "a=rtpmap:103 rtx/90000",
        "a=fmtp:103 apt=102",
        "a=rtpmap:104 H264/90000",
        "a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f",
        "a=rtpmap:116 H264/90000",
        "a=fmtp:116 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
        "a=rtpmap:96 VP8/90000",
        "a=rtpmap:98 VP9/90000",
        "a=fmtp:98 profile-id=0",
        ""
    ].join("\r\n");
    const plan = (h264Profile: string | null) => ({ videoMids: new Set(["0"]), audioMids: new Set<string>(), codec: "h264" as const, h264Profile, bitrate: null });
    const mLine = (sdp: string) => sdp.split("\r\n").find(l => l.startsWith("m=video"));

    test("o outro lado lista 42e01f primeiro: 42001f (hardware) vai na frente", () => {
        const r = mungeRemoteSdp(REMOTE, plan("42001f"));
        assert.equal(mLine(r.sdp), "m=video 9 UDP/TLS/RTP/SAVPF 102 108 116 114 104 109 103 96 98");
        assert.deepEqual(r.changes, ["mid 0: H264 (perfil 42001f) primeiro"]);
        assert.deepEqual(r.notes, []);
        // so a linha m= muda; CRLF mantido
        assert.equal(r.sdp.replace(/^m=video.*$/m, ""), REMOTE.replace(/^m=video.*$/m, ""));
    });

    test("sem perfil por hardware: so packetization-mode=1 na frente (como na v0.2.0)", () => {
        assert.equal(mLine(mungeRemoteSdp(REMOTE, plan(null)).sdp), "m=video 9 UDP/TLS/RTP/SAVPF 108 102 116 114 104 109 103 96 98");
    });

    test("perfil por hardware ausente do outro lado: avisa e fica outra variante H.264", () => {
        const r = mungeRemoteSdp(REMOTE, plan("640032"));
        assert.equal(mLine(r.sdp), "m=video 9 UDP/TLS/RTP/SAVPF 108 102 116 114 104 109 103 96 98");
        assert.deepEqual(r.notes, ["perfil H.264 640032 (placa de vídeo) ausente no SDP do outro lado; fica outra variante H.264"]);
    });

    test("ja na ordem certa: SDP intacto; m-section em que nao enviamos: intacta", () => {
        const once = mungeRemoteSdp(REMOTE, plan("42001f")).sdp;
        assert.deepEqual(mungeRemoteSdp(once, plan("42001f")), { sdp: once, changes: [], notes: [] });
        assert.deepEqual(mungeRemoteSdp(REMOTE, { ...plan("42001f"), videoMids: new Set(["1"]) }), { sdp: REMOTE, changes: [], notes: [] });
    });
});

describe("checagem do encoder no ar", () => {
    const OPENH264: EncoderReport = { mimeType: "video/H264", implementation: "OpenH264", powerEfficient: false, framesEncoded: 30 };
    const NVIDIA: EncoderReport = { mimeType: "video/H264", implementation: "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)", powerEfficient: true, framesEncoded: 30 };
    const HW = { h264HwDecode: true };

    test("isSoftwareH264 so com evidencia", () => {
        assert.equal(isSoftwareH264(OPENH264), true);
        assert.equal(isSoftwareH264({ ...OPENH264, powerEfficient: undefined }), true, "sem powerEfficientEncoder: pelo nome");
        assert.equal(isSoftwareH264({ ...NVIDIA, powerEfficient: false }), true, "powerEfficientEncoder false manda");
        assert.equal(isSoftwareH264(NVIDIA), false);
        assert.equal(isSoftwareH264({ ...OPENH264, framesEncoded: 0 }), false, "encoder ainda sem quadros");
        assert.equal(isSoftwareH264({ mimeType: "video/H264", framesEncoded: 30 }), false, "sem captura no ar o Chromium nao expoe os campos");
        assert.equal(isSoftwareH264({ ...OPENH264, mimeType: "video/VP9", implementation: "libvpx" }), false);
    });

    test("softwareFallback: H.264 por software → VP9, uma vez por espectador", () => {
        const local = caps();
        const next = softwareFallback(OPENH264, false, HW, "auto", local) as CodecDecision;
        assert.deepEqual(next, { codec: "vp9", reason: "automático: este PC não codifica H.264 por hardware → VP9" });
        assert.equal(local.h264HwEncode, true, "nao mexe no objeto recebido");
        assert.equal(softwareFallback(OPENH264, true, HW, "auto", local), null, "ja tratado: nunca de novo");
        assert.equal(softwareFallback(NVIDIA, false, HW, "auto", local), null);
        assert.equal(softwareFallback({ ...OPENH264, mimeType: "video/VP9" }, false, HW, "auto", local), null, "ja em VP9: nao repete");
        assert.equal(softwareFallback(OPENH264, false, HW, "auto", caps({ sendable: new Set(["h264", "vp8"]) }))?.codec, "vp8");
    });

    test("softwareFallback: H.264 fixado nas configuracoes continua H.264", () => {
        assert.deepEqual(softwareFallback(OPENH264, false, HW, "h264", caps()), { codec: "h264", h264Profile: "42001f", reason: "fixado nas configurações" });
    });

    test("tamanhos que a placa de video aceita para H.264 (medidos no Chromium 152, RTX 3070)", () => {
        for (const [w, h] of [[1920, 1080], [1280, 720], [960, 540], [800, 450], [768, 432], [714, 500], [640, 360], [1000, 700]])
            assert.equal(h264HwAcceptsSize(w, h), true, `${w}x${h} na placa`);
        for (const [w, h] of [[853, 480], [1136, 639], [1001, 701], [480, 270], [427, 240], [320, 180], [640, 358]])
            assert.equal(h264HwAcceptsSize(w, h), false, `${w}x${h} no OpenH264`);
    });

    test("OpenH264 de passagem: o WebRTC reduziu a resolucao para um tamanho que a placa nao aceita", () => {
        const sw = (width: number, height: number, limitation?: string): EncoderReport => ({ ...OPENH264, width, height, limitation });
        // log de 29/10: banda ~0,5 Mbps + degrau 720p → 853x480 (largura impar), depois 427x240 / 320x180 (abaixo de 360p)
        assert.equal(isTransientSoftwareH264(sw(853, 480, "bandwidth")), true);
        assert.equal(isTransientSoftwareH264(sw(480, 270, "bandwidth")), true);
        assert.equal(isTransientSoftwareH264(sw(427, 240, "cpu")), true);
        assert.equal(softwareFallback(sw(853, 480, "bandwidth"), false, HW, "auto", caps()), null, "nao e queda: nao troca o codec");
        assert.equal(softwareFallback(sw(320, 180, "bandwidth"), false, HW, "h264", caps()), null);

        // queda de verdade: OpenH264 num tamanho que a placa aceita
        assert.equal(isTransientSoftwareH264(sw(1280, 720, "bandwidth")), false, "1280x720 a placa aceita");
        assert.equal(isTransientSoftwareH264({ ...OPENH264, limitation: "bandwidth" }), false, "sem tamanho: como antes");
        assert.equal(isTransientSoftwareH264({ ...NVIDIA, width: 427, height: 240, limitation: "bandwidth" }), false, "na placa nao e software");
        assert.equal(softwareFallback(sw(1280, 720, "bandwidth"), false, HW, "auto", caps())?.codec, "vp9");
        assert.equal(softwareFallback(sw(1920, 1080, "none"), false, HW, "auto", caps())?.codec, "vp9");
    });

    test("tamanho que a placa nao aceita nunca e queda, seja qual for o qualityLimitationReason (log de 31/10)", () => {
        const sw = (width: number, height: number, limitation?: string): EncoderReport => ({ ...OPENH264, width, height, limitation });
        // o WebRTC reduziu por banda e o motivo voltou para "none" com o 853x480 / 427x240 ainda no ar
        for (const [w, h] of [[853, 480], [427, 240]]) {
            for (const limitation of ["none", undefined, "other"]) {
                assert.equal(isTransientSoftwareH264(sw(w, h, limitation)), true, `${w}x${h} ${limitation}`);
                assert.equal(softwareFallback(sw(w, h, limitation), false, HW, "auto", caps()), null, `${w}x${h} ${limitation}: nao troca`);
            }
        }
        // uma reducao nossa com largura impar (evenScale evita) tambem nao e a placa falhando
        assert.equal(softwareFallback(sw(1199, 720, "none"), false, HW, "auto", caps()), null);
    });

    test("pickNegotiatedCodec: variante certa entre os ja negociados, so os campos de RTCRtpCodec", () => {
        const negotiated: RTCRtpCodecParameters[] = [
            { payloadType: 108, ...h264(1, "42e01f") },
            { payloadType: 102, ...h264(1, "42001f") },
            { payloadType: 100, mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=2;x-google-max-bitrate=8000" },
            { payloadType: 98, mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=0;x-google-max-bitrate=8000" }
        ];
        assert.deepEqual(pickNegotiatedCodec(negotiated, { codec: "vp9", reason: "" }), { mimeType: "video/VP9", clockRate: 90000, sdpFmtpLine: "profile-id=0;x-google-max-bitrate=8000" });
        assert.equal(pickNegotiatedCodec(negotiated, { codec: "h264", h264Profile: "42001f", reason: "" })?.sdpFmtpLine, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f");
        assert.equal(pickNegotiatedCodec(negotiated, { codec: "av1", reason: "" }), null);
    });

    test("sessao: 1a queda tira so aquele espectador do H.264; a 2a desliga o H.264 automatico; fixado continua H.264", async () => {
        setCaps(CHROMIUM_CAPS);
        setMediaCapabilities(RTX_3070);
        const lines: string[] = [];
        const first = probeLocalCaps(line => lines.push(line));
        assert.equal(probeLocalCaps(line => lines.push(line)), first, "memorizado");
        await first;
        assert.deepEqual(lines, ["Capacidades locais: H.264 por hardware — decodifica: sim, codifica: sim (perfil 42001f); envia: h264, vp8, av1, vp9"]);

        const viewer = { h264HwDecode: true };
        const hwH264 = { codec: "h264", h264Profile: "42001f", reason: "automático: H.264 por hardware nos dois lados (perfil 42001f)" };
        assert.deepEqual(chooseCodec(viewer, "auto"), hwH264);

        // 1a queda (espectador A): so A vai para VP9; quem entra depois (B) ainda recebe H.264 pela placa
        assert.equal(softwareFallback(OPENH264, false, viewer, "auto")?.codec, "vp9", "A sai do H.264");
        assert.deepEqual(noteH264Fallback(), { count: 1, disabledNow: false });
        assert.equal(getLocalCaps().h264HwEncode, true, "a sessao continua com H.264 automatico");
        assert.deepEqual(chooseCodec(viewer, "auto"), hwH264, "B: H.264 pela placa");
        assert.equal(softwareFallback(OPENH264, true, viewer, "auto"), null, "A: uma vez por espectador");

        // 2a queda (espectador B): B vai para VP9 e o H.264 automatico desliga no resto da sessao
        assert.equal(softwareFallback(OPENH264, false, viewer, "auto")?.codec, "vp9", "B sai do H.264");
        assert.deepEqual(noteH264Fallback(), { count: 2, disabledNow: true });
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.equal(getLocalCaps().h264HwProfile, "42001f");
        assert.equal(chooseCodec(viewer, "auto").codec, "vp9", "C, que entra depois: VP9");
        assert.deepEqual(noteH264Fallback(), { count: 3, disabledNow: false }, "ja desligado: nao muda de novo");

        // codec fixado em H.264: nao troca (nem depois de desligado o automatico)
        assert.equal(chooseCodec(viewer, "h264").codec, "h264");
        assert.deepEqual(softwareFallback(OPENH264, false, viewer, "h264"), { codec: "h264", h264Profile: "42001f", reason: "fixado nas configurações" });
    });

    test("sem framesEncoded relatado: sem evidencia, nao e software", () => {
        assert.equal(isSoftwareH264({ ...OPENH264, framesEncoded: undefined }), false);
    });
});

describe("casos de borda das capacidades e da ordem", () => {
    test("getCapabilities que lanca ou nao tem video: como sem capacidades", async () => {
        g.RTCRtpSender = { getCapabilities: () => { throw new Error("nao implementado"); } };
        g.RTCRtpReceiver = { getCapabilities: () => null };
        setMediaCapabilities(RTX_3070);
        const local = await measureLocalCaps(FAST);
        assert.deepEqual({ ...local, sendable: [...local.sendable] }, { h264HwDecode: false, h264HwEncode: false, h264HwProfile: null, sendable: [] });
    });

    test("uma entrada estragada na lista do sender nao derruba a sonda (fica o que ja foi lido)", async () => {
        setCaps([plain("VP8"), { clockRate: 90000 } as unknown as Codec, plain("VP9", "profile-id=0"), h264(1, "42001f")]);
        setMediaCapabilities(RTX_3070);
        const local = await measureLocalCaps(FAST);
        assert.deepEqual([...local.sendable], ["vp8"]);
        assert.equal(local.h264HwProfile, "42001f");
    });

    test("linha de log sem perfil e sem lista de envio; motivo automatico sem perfil", () => {
        assert.equal(
            describeLocalCaps(caps({ h264HwDecode: false, h264HwProfile: null, sendable: new Set() })),
            "Capacidades locais: H.264 por hardware — decodifica: não, codifica: sim; envia: ?"
        );
        assert.equal(chooseCodec({ h264HwDecode: true }, "auto", caps({ h264HwProfile: null })).reason, "automático: H.264 por hardware nos dois lados");
    });

    test("ordem: variantes sem fmtp, e codecs sem preferencia de perfil (VP8/AV1) ficam na ordem original", () => {
        const list: Codec[] = [plain("VP8"), plain("H264"), h264(1, "42001f"), plain("VP9"), plain("VP8", "x=1")];
        assert.deepEqual(sortCodecs(list, "h264", "42001f").sorted.map(c => c.sdpFmtpLine ?? "-"), [
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f", "-", "-", "-", "x=1"
        ]);
        assert.deepEqual(sortCodecs(list, "vp9").sorted[0], plain("VP9"));
        const vp8 = sortCodecs(list, "vp8");
        assert.equal(vp8.matched, 2);
        assert.deepEqual(vp8.sorted.slice(0, 2), [plain("VP8"), plain("VP8", "x=1")]);
    });

    test("applyCodecPreferences: lista vazia no sender, perfil ausente, erro que nao e Error, nenhuma capacidade", () => {
        let applied: Codec[] = [];
        const ok = { setCodecPreferences: (list: Codec[]) => { applied = list; } } as unknown as RTCRtpTransceiver;
        setCaps([], [h264(1, "42e01f")]);
        assert.equal(applyCodecPreferences(ok, "h264", "42001f"), "H264 primeiro (1 variante(s), capacidades do receiver)", "sem 42001f: sem '(perfil ...)'");
        assert.equal(applied.length, 1);
        setCaps([plain("H264")]);
        assert.equal(applyCodecPreferences(ok, "h264", "42001f"), "H264 primeiro (1 variante(s), capacidades do sender)", "H.264 sem fmtp: sem perfil");

        const throwsString = { setCodecPreferences: () => { throw "recusado"; } } as unknown as RTCRtpTransceiver;
        setCaps([plain("VP9")]);
        assert.equal(applyCodecPreferences(throwsString, "vp9"), "setCodecPreferences não aplicado (recusado)");

        g.RTCRtpSender = g.RTCRtpReceiver = { getCapabilities: () => null };
        assert.equal(applyCodecPreferences(ok, "vp9"), "setCodecPreferences não aplicado (sem capacidades)");
        setCaps([]);
        assert.equal(applyCodecPreferences(ok, "vp9"), "setCodecPreferences não aplicado (sem capacidades)");
    });

    test("pickNegotiatedCodec: leva channels quando existe e omite o fmtp ausente", () => {
        const negotiated = [{ payloadType: 96, mimeType: "video/VP8", clockRate: 90000, channels: 1 }] as RTCRtpCodecParameters[];
        assert.deepEqual(pickNegotiatedCodec(negotiated, { codec: "vp8", reason: "" }), { mimeType: "video/VP8", clockRate: 90000, channels: 1 });
    });
});
