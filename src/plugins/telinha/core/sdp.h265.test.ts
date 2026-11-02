/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O SDP remoto com H.265 (core/sdp.ts → mungeRemoteSdp com codec "h265"): o H.265 Main na frente, o H.264 reserva (o
// que iria sem o H.265: High e Baseline da placa) logo depois, o resto na ordem do Chromium. Sem H.265 do outro lado, a
// reserva H.264 vai na frente (nunca o VP8 que o Chromium lista primeiro). O SDP tem a cara de uma resposta do Chromium
// 152+ de quem so recebe, com as duas variantes H.265 do receiver (Main e Main 10, level-id=180, tx-mode=SRST).
// Rodar:  pnpm test:file src/plugins/telinha/core/sdp.h265.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mungeRemoteSdp, type RemoteSdpPlan } from "./sdp";

const HEAD = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 1"];
type Line = [pt: number, rtx: number, name: string, fmtp: string];
const H264 = (mode: 0 | 1, profile: string) => `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`;
const MAIN = "level-id=180;profile-id=1;tier-flag=0;tx-mode=SRST";
const MAIN10 = "level-id=180;profile-id=2;tier-flag=0;tx-mode=SRST";

/** As variantes do receiver do Chromium com H.264 High e H.265 na placa, na ordem dele, cada uma com o rtx. */
const CHROMIUM: Line[] = [
    [96, 97, "VP8", ""], [103, 104, "H264", H264(1, "42001f")], [107, 108, "H264", H264(0, "42001f")], [109, 114, "H264", H264(1, "42e01f")],
    [117, 118, "H264", H264(1, "4d001f")], [45, 46, "AV1", "level-idx=5;profile=0;tier=0"], [98, 99, "VP9", "profile-id=0"], [100, 101, "VP9", "profile-id=2"],
    [119, 120, "H264", H264(1, "640032")], [49, 50, "H265", MAIN], [51, 52, "H265", MAIN10]
];

function video(lines: Line[] = CHROMIUM, mid = "1") {
    const pts = [...lines.flatMap(([pt, rtx]) => [pt, rtx]), 123, 125];
    return [
        `m=video 9 UDP/TLS/RTP/SAVPF ${pts.join(" ")}`, "c=IN IP4 0.0.0.0", `a=mid:${mid}`, "a=recvonly", "a=rtcp-mux",
        ...lines.flatMap(([pt, rtx, name, fmtp]) => [
            `a=rtpmap:${pt} ${name}/90000`, `a=rtcp-fb:${pt} nack pli`, ...(fmtp ? [`a=fmtp:${pt} ${fmtp}`] : []), `a=rtpmap:${rtx} rtx/90000`, `a=fmtp:${rtx} apt=${pt}`
        ]),
        "a=rtpmap:123 red/90000", "a=rtpmap:125 ulpfec/90000"
    ];
}

const sdpOf = (section: string[]) => [...HEAD, ...section, ""].join("\r\n");
const plan = (over: Partial<RemoteSdpPlan>): RemoteSdpPlan => ({ videoMids: new Set(["1"]), audioMids: new Set(), codec: null, h264Profile: null, bitrate: null, ...over });
const payloads = (sdp: string) => (sdp.split("\r\n").find(l => l.startsWith("m=video")) ?? "").split(" ").slice(3);
/** Os payloads que nao sao H.264 nem H.265, na ordem do Chromium. */
const rest = (lines: Line[] = CHROMIUM) => [...lines.filter(([, , n]) => n !== "H264" && n !== "H265").map(([pt]) => String(pt)), ...lines.map(([, rtx]) => String(rtx))];

describe("mungeRemoteSdp: H.265 com o H.264 reserva", () => {
    const H265 = { codec: "h265" as const, h264Profile: "640032", h264Backup: "42001f" };

    test("H.265 Main, H.265 Main 10, depois o H.264 reserva (640032, 42001f, os outros mode 1, mode 0), depois o resto na ordem do Chromium", () => {
        const sdp = sdpOf(video());
        const res = mungeRemoteSdp(sdp, plan(H265));
        assert.deepEqual(res.changes, ["mid 1: H265 primeiro, H264 reserva (perfil 640032) logo depois"]);
        assert.deepEqual(res.notes, []);
        const out = payloads(res.sdp);
        assert.deepEqual(out.slice(0, 7), ["49", "51", "119", "103", "109", "117", "107"]);
        assert.deepEqual(out.slice(7).filter(pt => !["123", "125"].includes(pt)).sort(), rest().sort());
        assert.deepEqual(out.slice(7, 11), ["96", "97", "104", "108"], "o resto fica na ordem do Chromium (VP8 e os rtx)");
        assert.equal(res.sdp.replace(/^m=video.*$/m, ""), sdp.replace(/^m=video.*$/m, ""), "so a linha m= muda");
        assert.deepEqual(mungeRemoteSdp(res.sdp, plan(H265)), { sdp: res.sdp, changes: [], notes: [] }, "de novo: intacto");
    });

    test("so o Baseline de reserva (o espectador sem High): H.265, 42001f, os outros", () => {
        const res = mungeRemoteSdp(sdpOf(video()), plan({ codec: "h265", h264Profile: "42001f" }));
        assert.deepEqual(payloads(res.sdp).slice(0, 7), ["49", "51", "103", "109", "117", "119", "107"]);
        assert.deepEqual(res.changes, ["mid 1: H265 primeiro, H264 reserva (perfil 42001f) logo depois"]);
    });

    test("o outro lado sem H.265 (Chromium sem o recurso): o H.264 reserva na frente, nunca o VP8; com uma observacao", () => {
        const noH265 = CHROMIUM.filter(([, , n]) => n !== "H265");
        const res = mungeRemoteSdp(sdpOf(video(noH265)), plan(H265));
        assert.deepEqual(payloads(res.sdp).slice(0, 5), ["119", "103", "109", "117", "107"]);
        assert.deepEqual(res.changes, ["mid 1: H264 reserva (perfil 640032) primeiro"]);
        assert.deepEqual(res.notes, ["H265 ausente no SDP do outro lado; fica o H.264 reserva"]);
    });

    test("so o Main 10 do outro lado: ele vai na frente, com uma observacao (o encoder e 8 bits; o WebRTC decide)", () => {
        const main10Only = CHROMIUM.filter(([pt]) => pt !== 49);
        const res = mungeRemoteSdp(sdpOf(video(main10Only)), plan(H265));
        assert.equal(payloads(res.sdp)[0], "51");
        assert.deepEqual(res.notes, ["H.265 Main ausente no SDP do outro lado; fica outra variante H.265"]);
    });

    test("H.265 sem reserva H.264 (fixado, espectador sem H.264 na placa): so o H.265 sobe; sem nada: o codec padrao", () => {
        const res = mungeRemoteSdp(sdpOf(video()), plan({ codec: "h265" }));
        assert.deepEqual(payloads(res.sdp).slice(0, 3), ["49", "51", "96"]);
        assert.deepEqual(res.changes, ["mid 1: H265 primeiro"]);
        const bare = mungeRemoteSdp(sdpOf(video(CHROMIUM.filter(([, , n]) => n !== "H265"))), plan({ codec: "h265" }));
        assert.deepEqual(bare.changes, []);
        assert.deepEqual(bare.notes, ["H265 ausente no SDP do outro lado; fica o codec padrão"]);
    });

    test("com a banda: x-google-* tambem no H.265", () => {
        const res = mungeRemoteSdp(sdpOf(video()), plan({ ...H265, bitrate: { startKbps: 4000, maxKbps: 20_000 } }));
        assert.match(res.changes[1], /^mid 1: x-google-start-bitrate=4000;x-google-max-bitrate=20000 em VP8\/H264\/AV1\/VP9\/H265$/);
        assert.ok(res.sdp.includes(`a=fmtp:49 ${MAIN};x-google-start-bitrate=4000;x-google-max-bitrate=20000`));
    });

    test("decisao H.264 com H.265 na lista: o H.265 nao sobe (fica onde o Chromium o pos)", () => {
        const res = mungeRemoteSdp(sdpOf(video()), plan({ codec: "h264", h264Profile: "640032", h264Backup: "42001f" }));
        const out = payloads(res.sdp);
        assert.equal(out[0], "119");
        assert.ok(out.indexOf("49") > out.indexOf("98"), "o H.265 continua depois do VP9");
    });
});
