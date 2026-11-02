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

import { CODEC_RTP_NAME, h264ProfileLevelId, h264Rank, isH264High, isPacketizationMode1, mungeRemoteSdp, type RemoteSdpPlan, sameH264Profile } from "./sdp";

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
        assert.deepEqual(res.changes, ["mid 0: opus estéreo 192 kbps", "mid 1: H264 (perfil 42001f) primeiro"]);
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
    test("m-section sem mid ou rejeitada (porta 0) fica igual; numa em que nao enviamos so entra a banda (o codec e o opus, nao)", () => {
        const noMid = videoSection("1").filter(l => !l.startsWith("a=mid:"));
        const rejected = videoSection("3", 0);
        const notOurs = videoSection("4");
        const sdp = sdpOf([noMid, rejected, notOurs, audioSection("5")]);
        const p = plan({ videoMids: new Set(["1", "3"]), audioMids: new Set(["0"]), codec: "h264", bitrate: { startKbps: 1, maxKbps: 2 } });
        const res = mungeRemoteSdp(sdp, p);
        assert.deepEqual(res.changes, ["mid 4: x-google-start-bitrate=1;x-google-max-bitrate=2 em VP8/H264/VP9"], "a banda inicial da conexao e uma so: vai em toda m-section de video");
        const alone = mungeRemoteSdp(sdpOf([notOurs]), { ...p, codec: null }).sdp.split("\r\n").slice(HEAD.length, -1);
        assert.ok(alone.some(l => l.includes("x-google-start-bitrate=1")));
        assert.equal(res.sdp, sdpOf([noMid, rejected, alone, audioSection("5")]), "as outras ficam iguais");
        assert.deepEqual(mungeRemoteSdp(sdp, { ...p, bitrate: null }), { sdp, changes: [], notes: [] }, "sem a banda: nada nelas");
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
    const STEREO = "stereo=1;sprop-stereo=1;maxaveragebitrate=192000";

    test("fmtp do opus ganha estereo a 192 kbps", () => {
        const res = mungeRemoteSdp(sdpOf([audioSection()]), plan({ videoMids: new Set() }));
        assert.deepEqual(res.changes, ["mid 0: opus estéreo 192 kbps"]);
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

describe("H.264 High: perfil, nivel e reserva", () => {
    test("isH264High: so 6400 + nivel (o Chromium nunca oferece 640c); sameH264Profile ignora o nivel", () => {
        for (const p of ["640032", "64001f", "640034", "64002A"]) assert.equal(isH264High(p), true, p);
        for (const p of ["640c1f", "4d0032", "42001f", "42e01f", "6400", "6400321", "", null, undefined]) assert.equal(isH264High(p), false, String(p));
        assert.equal(sameH264Profile("640032", "64001F"), true);
        assert.equal(sameH264Profile("640032", "640c32"), false, "Constrained High e outro perfil");
        assert.equal(sameH264Profile("42001f", null), false);
        assert.equal(sameH264Profile(undefined, "42001f"), false);
    });

    test("rank com reserva: 0 = High, 1 = o Baseline da placa, 2 = outro mode 1, 3 = o resto", () => {
        const fmtp = (mode: number, profile: string) => `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`;
        assert.equal(h264Rank(fmtp(1, "64001f"), "640032", "42001f"), 0, "outro nivel do High");
        assert.equal(h264Rank(fmtp(1, "42001f"), "640032", "42001f"), 1);
        assert.equal(h264Rank(fmtp(1, "42e01f"), "640032", "42001f"), 2);
        assert.equal(h264Rank(fmtp(1, "640c1f"), "640032", "42001f"), 2, "640c1f nao e High");
        assert.equal(h264Rank(fmtp(0, "640032"), "640032", "42001f"), 3);
        assert.equal(h264Rank(fmtp(0, "42001f"), "640032", null), 2, "sem reserva: os valores de antes");
    });
});

describe("mungeRemoteSdp: H.264 High no SDP do Chromium 152", () => {
    type H264Line = [pt: number, rtx: number, mode: 0 | 1, profile: string];
    /** As variantes H.264 que o Chromium 152 lista com a placa de video (o 6400xx so com o High por hardware), com o rtx de cada uma. */
    const CHROMIUM_H264: H264Line[] = [
        [103, 104, 1, "42001f"], [107, 108, 0, "42001f"], [109, 114, 1, "42e01f"], [115, 116, 0, "42e01f"],
        [117, 118, 1, "4d001f"], [39, 40, 0, "4d001f"], [119, 120, 1, "640032"], [49, 50, 0, "640032"]
    ];
    const fb = (pt: number) => ["goog-remb", "transport-cc", "ccm fir", "nack", "nack pli"].map(f => `a=rtcp-fb:${pt} ${f}`);

    /**
     * m-section de video de uma resposta do Chromium 152 (Discord, Electron 44) de quem so recebe: as variantes H.264 de
     * `h264`, na ordem dada, entre VP8 e AV1/VP9, com rtx, red e ulpfec, extmaps e as linhas de ICE/DTLS.
     */
    function chromium152Video(h264: H264Line[] = CHROMIUM_H264, mid = "1") {
        const pts = [96, 97, ...h264.flatMap(([pt, rtx]) => [pt, rtx]), 45, 46, 98, 99, 100, 101, 123, 124, 125];
        return [
            `m=video 9 UDP/TLS/RTP/SAVPF ${pts.join(" ")}`,
            "c=IN IP4 0.0.0.0",
            "a=rtcp:9 IN IP4 0.0.0.0",
            "a=ice-ufrag:Hd8x",
            "a=ice-pwd:qYb0WvG1aR9m3jJ2XoVwZt7p",
            "a=ice-options:trickle",
            "a=fingerprint:sha-256 4A:1D:93:0C:7E:21:B8:55:9F:02:6A:C4:3E:88:17:D0:5B:E9:41:7C:20:AF:66:13:CE:58:09:B2:74:3D:E1:90",
            "a=setup:active",
            `a=mid:${mid}`,
            "a=extmap:14 urn:ietf:params:rtp-hdrext:toffset",
            "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
            "a=extmap:13 urn:3gpp:video-orientation",
            "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
            "a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
            "a=recvonly",
            "a=rtcp-mux",
            "a=rtcp-rsize",
            "a=rtpmap:96 VP8/90000", ...fb(96),
            "a=rtpmap:97 rtx/90000", "a=fmtp:97 apt=96",
            ...h264.flatMap(([pt, rtx, mode, profile]) => [
                `a=rtpmap:${pt} H264/90000`, ...fb(pt), `a=fmtp:${pt} level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`,
                `a=rtpmap:${rtx} rtx/90000`, `a=fmtp:${rtx} apt=${pt}`
            ]),
            "a=rtpmap:45 AV1/90000", ...fb(45), "a=fmtp:45 level-idx=5;profile=0;tier=0",
            "a=rtpmap:46 rtx/90000", "a=fmtp:46 apt=45",
            "a=rtpmap:98 VP9/90000", ...fb(98), "a=fmtp:98 profile-id=0",
            "a=rtpmap:99 rtx/90000", "a=fmtp:99 apt=98",
            "a=rtpmap:100 VP9/90000", ...fb(100), "a=fmtp:100 profile-id=2",
            "a=rtpmap:101 rtx/90000", "a=fmtp:101 apt=100",
            "a=rtpmap:123 red/90000",
            "a=rtpmap:124 rtx/90000", "a=fmtp:124 apt=123",
            "a=rtpmap:125 ulpfec/90000"
        ];
    }

    const HIGH = { codec: "h264" as const, h264Profile: "640032", h264Backup: "42001f", audioMids: new Set<string>() };
    /** Os payloads de video que nao sao H.264, na ordem do Chromium. */
    const REST = (h264: H264Line[] = CHROMIUM_H264) => ["96", "97", ...h264.map(([, rtx]) => String(rtx)), "45", "46", "98", "99", "100", "101", "123", "124", "125"];

    test("decisao High (640032, reserva 42001f): 6400xx, 42001f, os outros mode 1, os mode 0, e o resto na ordem do Chromium", () => {
        const sdp = sdpOf([audioSection(), chromium152Video(), DATA]);
        const res = mungeRemoteSdp(sdp, plan(HIGH));
        assert.deepEqual(res.changes, ["mid 1: H264 (perfil 640032) primeiro"]);
        assert.deepEqual(res.notes, []);
        assert.deepEqual(payloads(res.sdp, "1"), ["119", "103", "109", "117", "107", "115", "39", "49", ...REST()]);
        assert.equal(res.sdp.replace(/^m=video.*$/m, ""), sdp.replace(/^m=video.*$/m, ""), "so a linha m= muda");
        assert.deepEqual(mungeRemoteSdp(res.sdp, plan(HIGH)), { sdp: res.sdp, changes: [], notes: [] }, "de novo: intacto");
    });

    test("decisao Baseline com o High na lista (o espectador nao anunciou High): exatamente a ordem de antes", () => {
        const res = mungeRemoteSdp(sdpOf([chromium152Video()]), plan({ codec: "h264", h264Profile: "42001f", audioMids: new Set() }));
        assert.deepEqual(res.notes, []);
        assert.deepEqual(payloads(res.sdp, "1").slice(0, 8), ["103", "109", "117", "119", "107", "115", "39", "49"], "o 6400xx nao sobe");
        assert.deepEqual(res.changes, ["mid 1: H264 (perfil 42001f) primeiro"]);
    });

    test("o outro lado sem 6400xx e com 42e01f primeiro: fica o reserva 42001f (placa de video), nunca o 42e01f (OpenH264)", () => {
        const noHigh: H264Line[] = [[109, 114, 1, "42e01f"], [115, 116, 0, "42e01f"], [103, 104, 1, "42001f"], [107, 108, 0, "42001f"], [117, 118, 1, "4d001f"], [39, 40, 0, "4d001f"]];
        const res = mungeRemoteSdp(sdpOf([chromium152Video(noHigh)]), plan(HIGH));
        assert.deepEqual(payloads(res.sdp, "1").slice(0, 6), ["103", "109", "117", "115", "107", "39"]);
        assert.deepEqual(res.changes, ["mid 1: H264 (perfil 42001f) primeiro"]);
        assert.deepEqual(res.notes, ["perfil H.264 640032 (placa de vídeo) ausente no SDP do outro lado; fica o perfil reserva 42001f"]);
        // sem reserva (nunca acontece com High, mas a regra de antes vale): outra variante mode 1, na ordem do outro lado
        const bare = mungeRemoteSdp(sdpOf([chromium152Video(noHigh)]), plan({ ...HIGH, h264Backup: null }));
        assert.deepEqual(bare.notes, ["perfil H.264 640032 (placa de vídeo) ausente no SDP do outro lado; fica outra variante H.264"]);
        assert.equal(payloads(bare.sdp, "1")[0], "109");
    });

    test("High em outro nivel (64001f) vale; 640c1f (Constrained High) nunca conta como High", () => {
        const levels: H264Line[] = [[103, 104, 1, "42001f"], [109, 114, 1, "42e01f"], [121, 122, 1, "640c1f"], [117, 118, 1, "4d001f"], [119, 120, 1, "64001f"]];
        const res = mungeRemoteSdp(sdpOf([chromium152Video(levels)]), plan(HIGH));
        assert.deepEqual(payloads(res.sdp, "1").slice(0, 5), ["119", "103", "109", "121", "117"]);
        assert.deepEqual(res.changes, ["mid 1: H264 (perfil 640032) primeiro"]);

        const constrainedOnly: H264Line[] = [[121, 122, 1, "640c1f"], [109, 114, 1, "42e01f"], [103, 104, 1, "42001f"]];
        const c = mungeRemoteSdp(sdpOf([chromium152Video(constrainedOnly)]), plan(HIGH));
        assert.deepEqual(payloads(c.sdp, "1").slice(0, 3), ["103", "121", "109"]);
        assert.deepEqual(c.notes, ["perfil H.264 640032 (placa de vídeo) ausente no SDP do outro lado; fica o perfil reserva 42001f"]);
    });

    test("High com a banda: as duas mudancas; reserva igual ao High e ignorada", () => {
        const res = mungeRemoteSdp(sdpOf([chromium152Video()]), plan({ ...HIGH, bitrate: { startKbps: 4000, maxKbps: 20_000 } }));
        assert.equal(res.changes[0], "mid 1: H264 (perfil 640032) primeiro");
        assert.match(res.changes[1], /^mid 1: x-google-start-bitrate=4000;x-google-max-bitrate=20000 em VP8\/H264\/AV1\/VP9$/);
        assert.ok(res.sdp.includes("a=fmtp:119 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032;x-google-start-bitrate=4000;x-google-max-bitrate=20000"));
        const same = mungeRemoteSdp(sdpOf([chromium152Video()]), plan({ ...HIGH, h264Backup: "640034" }));
        assert.deepEqual(payloads(same.sdp, "1").slice(0, 4), ["119", "103", "109", "117"], "sem reserva de verdade: High e depois os mode 1 na ordem");
    });
});
