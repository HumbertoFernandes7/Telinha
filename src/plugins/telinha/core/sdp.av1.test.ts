/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O SDP remoto com AV1 (core/sdp.ts → mungeRemoteSdp com codec "av1"): o AV1 Main na frente, o H.264 reserva (o que iria
// sem o AV1: High e Baseline da placa) logo depois, o resto na ordem do Chromium. Sem AV1 do outro lado, a reserva H.264
// vai na frente (nunca o VP8 que o Chromium lista primeiro). O SDP tem a cara de uma resposta do Chromium 152 de quem so
// recebe, com as duas variantes AV1 do receiver (profile=0 e profile=1, level-idx=5).
// Rodar:  pnpm test:file src/plugins/telinha/core/sdp.av1.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mungeRemoteSdp, type RemoteSdpPlan } from "./sdp";

const HEAD = ["v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 1"];
type Line = [pt: number, rtx: number, name: string, fmtp: string];
const H264 = (mode: 0 | 1, profile: string) => `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}`;
const MAIN = "level-idx=5;profile=0;tier=0";
const HIGH444 = "level-idx=5;profile=1;tier=0";

/** As variantes do receiver do Chromium 152 (Edge 156 medido), na ordem dele, cada uma com o rtx: o profile=1 antes do Main. */
const CHROMIUM: Line[] = [
    [96, 97, "VP8", ""], [98, 99, "VP9", "profile-id=0"], [103, 104, "H264", H264(1, "42001f")], [107, 108, "H264", H264(0, "42001f")],
    [109, 114, "H264", H264(1, "42e01f")], [47, 48, "AV1", HIGH444], [45, 46, "AV1", MAIN], [119, 120, "H264", H264(1, "64001f")]
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

describe("mungeRemoteSdp: AV1 com o H.264 reserva", () => {
    const AV1 = { codec: "av1" as const, h264Profile: "64001f", h264Backup: "42001f" };

    test("AV1 Main, AV1 profile=1, depois o H.264 reserva (High, Baseline, os outros mode 1, mode 0), depois o resto", () => {
        const sdp = sdpOf(video());
        const res = mungeRemoteSdp(sdp, plan(AV1));
        assert.deepEqual(res.changes, ["mid 1: AV1 primeiro, H264 reserva (perfil 64001f) logo depois"]);
        assert.deepEqual(res.notes, []);
        const out = payloads(res.sdp);
        assert.deepEqual(out.slice(0, 6), ["45", "47", "119", "103", "109", "107"]);
        assert.deepEqual(out.slice(6, 10), ["96", "97", "98", "99"], "o resto fica na ordem do Chromium (VP8, VP9 e os rtx)");
        assert.equal(res.sdp.replace(/^m=video.*$/m, ""), sdp.replace(/^m=video.*$/m, ""), "so a linha m= muda");
    });

    test("sem reserva H.264 (o espectador sem H.264 na placa): so o AV1 na frente", () => {
        const res = mungeRemoteSdp(sdpOf(video()), plan({ codec: "av1", h264Profile: null }));
        assert.deepEqual(res.changes, ["mid 1: AV1 primeiro"]);
        assert.deepEqual(payloads(res.sdp).slice(0, 3), ["45", "47", "96"]);
    });

    test("o outro lado sem AV1: o H.264 reserva na frente, nunca o VP8; e uma nota", () => {
        const noAv1 = CHROMIUM.filter(([, , n]) => n !== "AV1");
        const res = mungeRemoteSdp(sdpOf(video(noAv1)), plan(AV1));
        assert.deepEqual(res.notes, ["AV1 ausente no SDP do outro lado; fica o H.264 reserva"]);
        assert.deepEqual(res.changes, ["mid 1: H264 reserva (perfil 64001f) primeiro"]);
        assert.deepEqual(payloads(res.sdp).slice(0, 2), ["119", "103"]);
        const nothing = mungeRemoteSdp(sdpOf(video(noAv1)), plan({ codec: "av1" }));
        assert.deepEqual([nothing.changes, nothing.notes], [[], ["AV1 ausente no SDP do outro lado; fica o codec padrão"]]);
    });

    test("so o profile=1 do outro lado: ele vai, com uma nota (o envio fica no Main que o encoder escolher)", () => {
        const onlyHigh = CHROMIUM.filter(([pt]) => pt !== 45);
        const res = mungeRemoteSdp(sdpOf(video(onlyHigh)), plan(AV1));
        assert.deepEqual(res.notes, ["AV1 Main ausente no SDP do outro lado; fica outra variante AV1"]);
        assert.equal(payloads(res.sdp)[0], "47");
    });

    test("ja na ordem: nada muda; a banda continua em todas as variantes", () => {
        const once = mungeRemoteSdp(sdpOf(video()), plan(AV1)).sdp;
        assert.deepEqual(mungeRemoteSdp(once, plan(AV1)).changes, [], "a 2a vez (uma renegociacao) nao muda nada");
        const res = mungeRemoteSdp(sdpOf(video()), plan({ ...AV1, bitrate: { startKbps: 4000, maxKbps: 20000 } }));
        assert.match(res.sdp, /a=fmtp:45 level-idx=5;profile=0;tier=0;x-google-start-bitrate=4000;x-google-max-bitrate=20000/);
    });
});
