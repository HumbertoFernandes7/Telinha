/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do ajuste do SDP remoto (core/sdp.ts): ordem dos codecs de video (H.264 com o perfil por hardware, VP9
// perfil 0), x-google-start/max-bitrate, opus estereo, e o que nunca e mexido (m-section sem mid, rejeitada, ou em
// que nao enviamos).
// Rodar:  pnpm test:file src/plugins/telinha/core/sdp.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CODEC_RTP_NAME, h264ProfileLevelId, h264Rank, isPacketizationMode1, mungeRemoteSdp, type RemoteSdpPlan } from "./sdp";

const HEAD = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1 2"];

/** m-section de video como o Chromium oferece: VP8, rtx, H.264 (mode 0, 42e01f, 42001f), VP9 perfil 2 e 0, red, ulpfec. */
function videoSection(mid = "1", port = 9) {
    return [
        `m=video ${port} UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 102 103 104`,
        "c=IN IP4 0.0.0.0",
        `a=mid:${mid}`,
        "a=sendrecv",
        "a=rtpmap:96 VP8/90000",
        "a=rtpmap:97 rtx/90000",
        "a=fmtp:97 apt=96",
        "a=rtpmap:98 H264/90000",
        "a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f",
        "a=rtpmap:99 H264/90000",
        "a=fmtp:99 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        "a=rtpmap:100 H264/90000",
        "a=fmtp:100 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
        "a=rtpmap:101 VP9/90000",
        "a=fmtp:101 profile-id=2",
        "a=rtpmap:102 VP9/90000",
        "a=fmtp:102 profile-id=0",
        "a=rtpmap:103 red/90000",
        "a=rtpmap:104 ulpfec/90000"
    ];
}

function audioSection(mid = "0", fmtp: string | null = "minptime=10;useinbandfec=1") {
    return [
        "m=audio 9 UDP/TLS/RTP/SAVPF 111 0",
        "c=IN IP4 0.0.0.0",
        `a=mid:${mid}`,
        "a=rtpmap:111 opus/48000/2",
        ...(fmtp != null ? [`a=fmtp:111 ${fmtp}`] : []),
        "a=rtpmap:0 PCMU/8000"
    ];
}

const DATA = ["m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0", "a=mid:2", "a=sctp-port:5000"];

const sdpOf = (sections: string[][], eol = "\r\n") => [...HEAD, ...sections.flat(), ""].join(eol);

function plan(over: Partial<RemoteSdpPlan> = {}): RemoteSdpPlan {
    return { videoMids: new Set(["1"]), audioMids: new Set(["0"]), codec: null, h264Profile: null, bitrate: null, ...over };
}

/** Linha m= da m-section com o mid dado, depois do ajuste. */
function mLine(sdp: string, mid: string) {
    const lines = sdp.split(/\r?\n/);
    const at = lines.indexOf(`a=mid:${mid}`);
    for (let i = at; i >= 0; i--) if (lines[i].startsWith("m=")) return lines[i];
    return "";
}

const payloads = (sdp: string, mid: string) => mLine(sdp, mid).split(" ").slice(3);

describe("H.264: perfil e packetization-mode", () => {
    test("profile-level-id do fmtp (minusculo), com ou sem o 'a=fmtp:'", () => {
        assert.equal(h264ProfileLevelId("level-asymmetry-allowed=1;profile-level-id=42E01F"), "42e01f");
        assert.equal(h264ProfileLevelId("a=fmtp:100 profile-level-id=4d001f;packetization-mode=1"), "4d001f");
        assert.equal(h264ProfileLevelId("packetization-mode=1"), null);
    });

    test("packetization-mode=1 exato", () => {
        assert.equal(isPacketizationMode1("packetization-mode=1;profile-level-id=42e01f"), true);
        assert.equal(isPacketizationMode1("profile-level-id=42e01f;packetization-mode=1"), true);
        assert.equal(isPacketizationMode1("packetization-mode=0"), false);
        assert.equal(isPacketizationMode1("packetization-mode=10"), false);
        assert.equal(isPacketizationMode1(""), false);
    });

    test("rank: 0 = perfil por hardware (o nivel nao importa), 1 = outro mode 1, 2 = o resto", () => {
        assert.equal(h264Rank("packetization-mode=1;profile-level-id=42001f", "42001f"), 0);
        assert.equal(h264Rank("packetization-mode=1;profile-level-id=42002a", "42001F"), 0, "mesmo perfil, outro nivel; perfil maiusculo");
        assert.equal(h264Rank("packetization-mode=1;profile-level-id=42e01f", "42001f"), 1);
        assert.equal(h264Rank("packetization-mode=1;profile-level-id=42e01f", null), 1);
        assert.equal(h264Rank("packetization-mode=1", "42001f"), 1, "sem profile-level-id");
        assert.equal(h264Rank("packetization-mode=0;profile-level-id=42001f", "42001f"), 2);
        assert.equal(CODEC_RTP_NAME.h264, "H264");
    });
});

describe("mungeRemoteSdp: ordem dos codecs de video", () => {
    test("H.264 com perfil por hardware: 42001f, depois 42e01f, depois mode 0, depois o resto na ordem original", () => {
        const sdp = sdpOf([audioSection(), videoSection(), DATA]);
        const res = mungeRemoteSdp(sdp, plan({ codec: "h264", h264Profile: "42001f" }));
        assert.deepEqual(res.changes, ["mid 0: opus estéreo 128 kbps", "mid 1: H264 (perfil 42001f) primeiro"]);
        assert.deepEqual(res.notes, []);
        assert.deepEqual(payloads(res.sdp, "1"), ["100", "99", "98", "96", "97", "101", "102", "103", "104"]);
        assert.ok(res.sdp.includes("\r\n") && !/[^\r]\n/.test(res.sdp), "mantem o CRLF");
        assert.ok(res.sdp.startsWith(HEAD.join("\r\n")), "cabecalho intacto");
        assert.equal(mLine(res.sdp, "0"), "m=audio 9 UDP/TLS/RTP/SAVPF 111 0", "a ordem do audio nunca muda");
        assert.ok(res.sdp.endsWith("a=sctp-port:5000\r\n"), "data channel intacto");
    });

    test("perfil por hardware ausente do outro lado: fica outra variante H.264, com uma observacao", () => {
        const res = mungeRemoteSdp(sdpOf([videoSection()]), plan({ codec: "h264", h264Profile: "4d001f", audioMids: new Set() }));
        assert.deepEqual(res.changes, ["mid 1: H264 primeiro"]);
        assert.deepEqual(res.notes, ["perfil H.264 4d001f (placa de vídeo) ausente no SDP do outro lado; fica outra variante H.264"]);
        assert.deepEqual(payloads(res.sdp, "1").slice(0, 3), ["99", "100", "98"], "mode 1 na ordem do outro lado, depois mode 0");
    });

    test("H.264 sem perfil por hardware: so packetization-mode=1 na frente", () => {
        const res = mungeRemoteSdp(sdpOf([videoSection()]), plan({ codec: "h264" }));
        assert.deepEqual(res.notes, []);
        assert.deepEqual(payloads(res.sdp, "1").slice(0, 3), ["99", "100", "98"]);
    });

    test("VP9: perfil 0 antes do perfil 2", () => {
        const res = mungeRemoteSdp(sdpOf([videoSection()]), plan({ codec: "vp9" }));
        assert.deepEqual(res.changes, ["mid 1: VP9 primeiro"]);
        assert.deepEqual(payloads(res.sdp, "1").slice(0, 2), ["102", "101"]);
    });

    test("VP8 ja e o primeiro: nada muda e o SDP volta o mesmo texto", () => {
        const sdp = sdpOf([videoSection()]);
        const res = mungeRemoteSdp(sdp, plan({ codec: "vp8" }));
        assert.deepEqual(res, { sdp, changes: [], notes: [] });
    });

    test("codec ausente do outro lado: observacao, sem mudanca", () => {
        const sdp = sdpOf([videoSection()]);
        const res = mungeRemoteSdp(sdp, plan({ codec: "av1" }));
        assert.equal(res.sdp, sdp);
        assert.deepEqual(res.changes, []);
        assert.deepEqual(res.notes, ["AV1 ausente no SDP do outro lado; fica o codec padrão"]);
    });

    test("variantes sem fmtp: VP9 sem fmtp conta como perfil 0, H.264 sem fmtp vai para o fim; varias VP8 ficam na ordem", () => {
        const section = [
            "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101",
            "a=mid:1",
            "a=rtpmap:96 VP8/90000", "a=rtpmap:97 VP8/90000",
            "a=rtpmap:98 VP9/90000", "a=fmtp:98 profile-id=2", "a=rtpmap:99 VP9/90000",
            "a=rtpmap:100 H264/90000", "a=rtpmap:101 H264/90000", "a=fmtp:101 packetization-mode=1;profile-level-id=42e01f"
        ];
        const sdp = sdpOf([section]);
        assert.deepEqual(payloads(mungeRemoteSdp(sdp, plan({ codec: "vp9" })).sdp, "1").slice(0, 2), ["99", "98"]);
        assert.deepEqual(payloads(mungeRemoteSdp(sdp, plan({ codec: "h264" })).sdp, "1").slice(0, 2), ["101", "100"]);
        assert.deepEqual(mungeRemoteSdp(sdp, plan({ codec: "vp8" })).changes, [], "VP8 ja na frente, empate mantem a ordem");
    });

    test("linha m= sem payloads: nao reordena", () => {
        const section = ["m=video 9 UDP/TLS/RTP/SAVPF", "a=mid:1", "a=rtpmap:96 VP8/90000"];
        const sdp = sdpOf([section]);
        assert.deepEqual(mungeRemoteSdp(sdp, plan({ codec: "vp8" })).changes, []);
    });
});

describe("mungeRemoteSdp: o que nunca e mexido", () => {
    test("m-section sem mid, rejeitada (porta 0) ou em que nao enviamos fica igual", () => {
        const noMid = videoSection("1").filter(l => !l.startsWith("a=mid:"));
        const rejected = videoSection("3", 0);
        const notOurs = videoSection("4");
        const sdp = sdpOf([noMid, rejected, notOurs, audioSection("5")]);
        const res = mungeRemoteSdp(sdp, plan({ videoMids: new Set(["1", "3"]), audioMids: new Set(["0"]), codec: "h264", bitrate: { startKbps: 1, maxKbps: 2 } }));
        assert.deepEqual(res, { sdp, changes: [], notes: [] });
    });

    test("sem codec nem bitrate: o video fica igual", () => {
        const sdp = sdpOf([videoSection()]);
        assert.deepEqual(mungeRemoteSdp(sdp, plan()).changes, []);
    });
});

describe("mungeRemoteSdp: bitrate de envio", () => {
    test("x-google-* em todos os codecs de video reais (fmtp existente ou novo), nunca em rtx/red/ulpfec", () => {
        const res = mungeRemoteSdp(sdpOf([videoSection()]), plan({ bitrate: { startKbps: 6000, maxKbps: 20000 }, audioMids: new Set() }));
        const params = "x-google-start-bitrate=6000;x-google-max-bitrate=20000";
        assert.deepEqual(res.changes, [`mid 1: ${params} em VP8/H264/VP9`]);
        const lines = res.sdp.split("\r\n");
        // VP8 nao tinha fmtp: entra logo depois do rtpmap
        assert.equal(lines[lines.indexOf("a=rtpmap:96 VP8/90000") + 1], `a=fmtp:96 ${params}`);
        assert.ok(lines.includes(`a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f;${params}`));
        assert.ok(lines.includes(`a=fmtp:102 profile-id=0;${params}`));
        assert.ok(lines.includes("a=fmtp:97 apt=96"), "rtx intocado");
        assert.ok(!lines.some(l => /^a=fmtp:10[34] /.test(l)), "red/ulpfec sem fmtp novo");
    });

    test("varios codecs sem fmtp seguidos: cada fmtp novo fica depois do seu rtpmap", () => {
        const section = ["m=video 9 UDP/TLS/RTP/SAVPF 96 98 100", "a=mid:1", "a=rtpmap:96 VP8/90000", "a=rtpmap:98 VP9/90000", "a=rtpmap:100 AV1/90000"];
        const res = mungeRemoteSdp(sdpOf([section], "\n"), plan({ bitrate: { startKbps: 1, maxKbps: 2 }, audioMids: new Set() }));
        const lines = res.sdp.split("\n");
        assert.ok(!res.sdp.includes("\r"), "mantem o LF");
        const p = "x-google-start-bitrate=1;x-google-max-bitrate=2";
        assert.deepEqual(lines.slice(lines.indexOf("a=mid:1") + 1, lines.indexOf("a=mid:1") + 7), [
            "a=rtpmap:96 VP8/90000", `a=fmtp:96 ${p}`, "a=rtpmap:98 VP9/90000", `a=fmtp:98 ${p}`, "a=rtpmap:100 AV1/90000", `a=fmtp:100 ${p}`
        ]);
    });

    test("ja tem x-google-*: nao repete; so codecs auxiliares: nada a fazer", () => {
        const already = ["m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1", "a=rtpmap:96 VP8/90000", "a=fmtp:96 x-google-max-bitrate=1"];
        assert.deepEqual(mungeRemoteSdp(sdpOf([already]), plan({ bitrate: { startKbps: 1, maxKbps: 2 } })).changes, []);
        const auxOnly = ["m=video 9 UDP/TLS/RTP/SAVPF 97 103", "a=mid:1", "a=rtpmap:97 rtx/90000", "a=rtpmap:103 red/90000"];
        assert.deepEqual(mungeRemoteSdp(sdpOf([auxOnly]), plan({ bitrate: { startKbps: 1, maxKbps: 2 } })).changes, []);
    });

    test("codec e bitrate juntos: as duas mudancas na mesma m-section", () => {
        const res = mungeRemoteSdp(sdpOf([videoSection()]), plan({ codec: "vp9", bitrate: { startKbps: 1, maxKbps: 2 }, audioMids: new Set() }));
        assert.equal(res.changes.length, 2);
        assert.match(res.changes[0], /^mid 1: VP9 primeiro$/);
        assert.match(res.changes[1], /^mid 1: x-google-start-bitrate=1;x-google-max-bitrate=2 em /);
    });
});

describe("mungeRemoteSdp: opus estereo", () => {
    const STEREO = "stereo=1;sprop-stereo=1;maxaveragebitrate=128000";

    test("fmtp do opus ganha estereo a 128 kbps", () => {
        const res = mungeRemoteSdp(sdpOf([audioSection()]), plan({ videoMids: new Set() }));
        assert.deepEqual(res.changes, ["mid 0: opus estéreo 128 kbps"]);
        assert.ok(res.sdp.includes(`a=fmtp:111 minptime=10;useinbandfec=1;${STEREO}\r\n`));
    });

    test("opus sem fmtp: a linha e criada depois do rtpmap", () => {
        const res = mungeRemoteSdp(sdpOf([audioSection("0", null)]), plan({ videoMids: new Set() }));
        assert.ok(res.sdp.includes(`a=rtpmap:111 opus/48000/2\r\na=fmtp:111 ${STEREO}\r\n`));
    });

    test("ja estereo, ou sem opus: nada muda", () => {
        const sdp = sdpOf([audioSection("0", "minptime=10;stereo=0")]);
        assert.deepEqual(mungeRemoteSdp(sdp, plan()).changes, []);
        const pcmu = ["m=audio 9 UDP/TLS/RTP/SAVPF 0", "a=mid:0", "a=rtpmap:0 PCMU/8000"];
        assert.deepEqual(mungeRemoteSdp(sdpOf([pcmu]), plan()).changes, []);
    });
});
