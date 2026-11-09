/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do Teredo (core/teredo.ts): a classificacao dos enderecos (IPv4, IPv6, Teredo, mDNS), o par em uso nas
// estatisticas e o filtro de candidatos de uma conexao (TeredoFilter): sai/entra so quando nao ha outro caminho, os
// candidatos que chegam aos poucos (trickle) e os do SDP (renegociacao, reinicio do ICE), e a regra do IPv6 deste PC so
// no Teredo. A ligacao com a RTCPeerConnection fica em peerConnection.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/teredo.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { useFakeClock } from "@test/fakes/clock";
import { FakeStatsReport } from "@test/fakes/webrtc";
import { logged, logMark } from "@test/helpers/wpa-session";

import {
    addressKind, overlayName, overlayText, pairOverlay, pairTeredo, parseCandidate, selectedPair, TEREDO_HOLD_MS, TEREDO_TEXT, TeredoFilter, teredoSide
} from "./teredo";

/** Enderecos de documentacao (RFC 5737 / 3849) e um Teredo como o Windows atribui (2001:0:servidor:flags:porta:cliente). */
const V4 = "203.0.113.7";
const V6 = "2001:db8:5b80::1";
const TEREDO = "2001:0:4136:e378:8000:63bf:3fff:fdd2";
const MDNS = "2b5c6a37-2f1e-4bd6-8a5e-6c1d0c9f2a10.local";

/** Uma linha de candidato como o Chromium manda. */
const cand = (address: string, type = "srflx", component = 1) => `candidate:842163049 ${component} udp 1677729535 ${address} 46154 typ ${type} generation 0 ufrag abcd network-cost 999`;

describe("addressKind", () => {
    test("IPv4, IPv6 de verdade e Teredo (2001:0000::/32), escrito por extenso ou comprimido", () => {
        assert.equal(addressKind(V4), "ipv4");
        assert.equal(addressKind("192.168.0.10"), "ipv4");
        assert.equal(addressKind(V6), "ipv6");
        assert.equal(addressKind("2001:db8::"), "ipv6");
        assert.equal(addressKind("2804:14c:5b80:9c00::1"), "ipv6");
        assert.equal(addressKind("::1"), "ipv6-local", "loopback");
        assert.equal(addressKind("fd12:3456:789a::1"), "ipv6-local", "ULA (fc00::/7)");
        assert.equal(addressKind("fe80::1c2b:3a4d:5e6f:7a8b%12"), "ipv6-local", "link-local");
        assert.equal(addressKind(TEREDO), "teredo");
        assert.equal(addressKind("2001:0000:4136:e378:8000:63bf:3fff:fdd2"), "teredo");
        assert.equal(addressKind("2001::5ef5:79fd"), "teredo", "o 2o grupo zero comprimido");
        assert.equal(addressKind("[2001:0:4136:e378:8000:63bf:3fff:fdd2]"), "teredo", "entre colchetes");
        assert.equal(addressKind("2001:0:4136:e378:8000:63bf:3fff:fdd2%12"), "teredo", "com zona");
        assert.equal(addressKind("2001:1::1"), "ipv6", "2001:1::/32 nao e Teredo");
        assert.equal(addressKind("2002:cb00:7107::1"), "ipv6", "6to4 nao e Teredo");
        assert.equal(addressKind("::ffff:203.0.113.7"), "ipv6-local", "IPv4 dentro do IPv6");
    });

    test("mDNS (host oculto pelo Chromium), vazio, invalido ou nao texto: desconhecido, nunca Teredo", () => {
        for (const a of [MDNS, "", "localhost", "1.2.3", "1.2.3.256", "2001:0:zzzz::1", "1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8", null, undefined, 42])
            assert.equal(addressKind(a), "unknown", String(a));
    });
});

describe("overlayName: VPNs overlay pelo endereco", () => {
    test("Radmin, Hamachi e Tailscale (IPv4 e IPv6, sem diferenciar maiusculas, com colchetes e zone id)", () => {
        const yes: [string, string][] = [
            ["26.40.111.45", "Radmin"], ["26.0.0.1", "Radmin"], ["fdfd::1a28:6f2d", "Radmin"], ["FDFD::1A28:6F2D", "Radmin"],
            ["[fdfd::1a28:6f2d]", "Radmin"], ["fdfd::1a28:6f2d%5", "Radmin"], ["fdfd:0:0:0:0:0:1a28:6f2d", "Radmin"],
            ["25.1.2.3", "Hamachi"], ["2620:9b::1900:1", "Hamachi"], ["2620:009b:0000:0000:0000:0000:1900:0001", "Hamachi"],
            ["fd7a:115c:a1e0::1", "Tailscale"], ["fd7a:115c:a1e0:ab12::5", "Tailscale"], ["fdfd::26.40.111.45", "Radmin"]
        ];
        for (const [a, name] of yes) assert.equal(overlayName(a), name, a);
    });

    test("todo o resto e null (outras ULA, CGNAT, Teredo, mDNS, faixas privadas, lixo)", () => {
        for (const a of ["27.0.0.1", "126.1.1.1", "10.26.0.1", "fd00::1", "fdfd:1::1", "fdfe::1", "100.64.0.1", "2001:0:abcd::1", "abc.local", "", "garbage", "192.168.0.26", "2620:9b:1::1", "fd7a:115c:a1e1::1", "25.1.2", "::ffff:26.1.2.3", "0:0:0:0:0:ffff:1a01:203"])
            assert.equal(overlayName(a), null, a);
        for (const a of [undefined, null, 26, {}]) assert.equal(overlayName(a), null);
    });
});

describe("pairOverlay: o par em uso numa VPN overlay", () => {
    const report = (local: string, remote: string) => new FakeStatsReport([
        { id: "T", type: "transport", selectedCandidatePairId: "CP" },
        { id: "CP", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" },
        { id: "L", type: "local-candidate", candidateType: "host", address: local },
        { id: "R", type: "remote-candidate", candidateType: "host", ip: remote }
    ]) as unknown as RTCStatsReport;
    const ov = (r: RTCStatsReport) => pairOverlay(r, selectedPair(r));

    test("os dois lados, so o nosso, so o do outro, nenhum; o Teredo continua como era", () => {
        assert.deepEqual(ov(report("26.1.1.1", "26.2.2.2")), { name: "Radmin", side: "both" });
        assert.deepEqual(ov(report("26.1.1.1", V4)), { name: "Radmin", side: "local" });
        assert.deepEqual(ov(report(V4, "fdfd::1a28:6f2d")), { name: "Radmin", side: "remote" });
        assert.equal(ov(report(V4, V6)), null);
        assert.equal(ov(report(MDNS, V4)), null);
        assert.equal(pairOverlay(report(V4, V4), null), null);
        const t = report(TEREDO, "26.1.1.1");
        assert.equal(pairTeredo(t, selectedPair(t)), "local");
        assert.deepEqual(ov(t), { name: "Radmin", side: "remote" });
    });

    test("o texto nunca tem endereco", () => {
        assert.equal(overlayText({ name: "Radmin", side: "both" }), "via VPN Radmin (os dois PCs)");
        assert.equal(overlayText({ name: "Hamachi", side: "local" }), "via VPN Hamachi (este PC)");
        assert.equal(overlayText({ name: "Tailscale", side: "remote" }), "via VPN Tailscale (o outro PC)");
    });
});

describe("par em uso nas estatisticas", () => {
    const report = (local: Record<string, unknown>, remote: Record<string, unknown>, transport = true) => new FakeStatsReport([
        ...(transport ? [{ id: "T", type: "transport", selectedCandidatePairId: "CP" }] : []),
        { id: "CP", type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" },
        { id: "L", type: "local-candidate", candidateType: "host", ...local },
        { id: "R", type: "remote-candidate", candidateType: "srflx", ...remote }
    ]) as unknown as RTCStatsReport;

    test("o lado no Teredo: este PC, o outro, os dois ou nenhum; endereco antigo em `ip`; mDNS e desconhecido", () => {
        const side = (r: RTCStatsReport) => pairTeredo(r, selectedPair(r));
        assert.equal(side(report({ address: TEREDO }, { address: V6 })), "local");
        assert.equal(side(report({ address: V4 }, { ip: TEREDO })), "remote");
        assert.equal(side(report({ address: TEREDO }, { address: "2001::5ef5:79fd" })), "both");
        assert.equal(side(report({ address: MDNS }, { address: V4 })), null);
        assert.equal(side(report({}, {})), null, "endereco escondido pelo Chromium");
        assert.equal(side(report({ address: TEREDO }, { address: V4 }, false)), "local", "sem transport: o par nomeado e bem-sucedido");
    });

    test("nenhum par ainda: null", () => {
        const empty = new FakeStatsReport([{ id: "T", type: "transport" }]) as unknown as RTCStatsReport;
        assert.equal(selectedPair(empty), null);
        const dangling = new FakeStatsReport([{ id: "T", type: "transport", selectedCandidatePairId: "sumiu" }]) as unknown as RTCStatsReport;
        assert.equal(selectedPair(dangling), null, "o par apontado pelo transport nao esta no relatorio");
        assert.equal(pairTeredo(empty, null), null);
        assert.equal(teredoSide("unknown", "ipv4"), null);
    });

    test("o texto do marcador nunca tem endereco", () => {
        for (const t of Object.values(TEREDO_TEXT)) assert.match(t, /^via Teredo \((este PC|o outro PC|os dois PCs)\)$/);
    });
});

describe("parseCandidate", () => {
    test("componente e tipo do endereco; aceita a linha do SDP (a=candidate); o resto e null", () => {
        assert.deepEqual(parseCandidate(cand(TEREDO)), { component: "1", kind: "teredo", overlay: null });
        assert.deepEqual(parseCandidate(`a=${cand(V4, "host", 2)}`), { component: "2", kind: "ipv4", overlay: null });
        assert.deepEqual(parseCandidate(cand("26.1.2.3", "host")), { component: "1", kind: "ipv4", overlay: "Radmin" });
        assert.deepEqual(parseCandidate(cand(MDNS, "host")), { component: "1", kind: "unknown", overlay: null });
        assert.equal(parseCandidate("a=ice-ufrag:abcd"), null);
        assert.equal(parseCandidate("candidate:1 1 udp 1"), null);
        assert.equal(parseCandidate(undefined), null);
    });
});

describe("TeredoFilter: candidatos que chegam aos poucos", () => {

    /** Um filtro e o que passou de cada lado. */
    function rig() {
        const filter = new TeredoFilter(() => "amigo (abc123)");
        const added: string[] = [];
        const emitted: (string | null)[] = [];
        const remote = (address: string, extra: Partial<RTCIceCandidateInit> = {}) =>
            filter.remoteCandidate({ candidate: cand(address), sdpMid: "0", usernameFragment: "r1", ...extra }, c => added.push(c.candidate!));
        const local = (address: string | null, extra: Record<string, unknown> = {}) =>
            filter.localCandidate({ candidate: address == null ? null : { candidate: cand(address), sdpMid: "0", usernameFragment: "l1", ...extra } } as unknown as RTCPeerConnectionIceEvent,
                e => emitted.push(e.candidate?.candidate ?? null));
        return { filter, added, emitted, remote, local };
    }

    test("do outro lado: o Teredo que chega antes de tudo espera; chegando um direto, ele sai (uma linha no log, sem endereco)", t => {
        const clock = useFakeClock(t);
        const r = rig();
        const mark = logMark();
        r.remote(TEREDO);
        assert.deepEqual(r.added, [], "segurado");
        r.remote(V4);
        assert.deepEqual(r.added, [cand(V4)]);
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(r.added, [cand(V4)], "o Teredo nunca entra");
        // depois de um direto, um Teredo novo sai na hora
        r.remote("2001::5ef5:79fd");
        assert.deepEqual(r.added, [cand(V4)]);
        const lines = logged(/Teredo/, mark).map(e => e.msg);
        assert.deepEqual(lines, ["amigo (abc123): um candidato do outro PC pelo Teredo deixado de fora (há outro caminho, mais rápido)"], "uma linha por minuto");
        assert.doesNotMatch(lines.join(" "), /2001|203\.0/);
    });

    test("do outro lado: so o Teredo (sem outro caminho): entra depois da espera; outro componente ou ufrag e outra conta", t => {
        const clock = useFakeClock(t);
        const r = rig();
        r.remote(V4, { usernameFragment: "velho" });
        r.remote(TEREDO);
        r.remote(TEREDO.replace("fdd2", "fdd3"));
        clock.tick(TEREDO_HOLD_MS - 1);
        assert.deepEqual(r.added, [cand(V4)]);
        clock.tick(1);
        assert.deepEqual(r.added, [cand(V4), cand(TEREDO), cand(TEREDO.replace("fdd2", "fdd3"))], "o reinicio do ICE (ufrag nova) nao tem o direto da antiga");
    });

    test("candidatos sem ufrag nem mid (Chromium antigo, ou so o indice da m-section): contam juntos pelo componente", t => {
        const clock = useFakeClock(t);
        const r = rig();
        r.filter.remoteCandidate({ candidate: cand(V4) }, c => r.added.push(c.candidate!));
        r.filter.remoteCandidate({ candidate: cand(TEREDO), sdpMid: null, sdpMLineIndex: null, usernameFragment: null }, c => r.added.push(c.candidate!));
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(r.added, [cand(V4)]);
        r.local(V4, { sdpMid: null, sdpMLineIndex: 0, usernameFragment: null });
        r.local(TEREDO, { sdpMid: null, sdpMLineIndex: 0, usernameFragment: null });
        assert.deepEqual(r.emitted, [cand(V4)]);
    });

    test("do outro lado: mDNS e linha que nao e candidato passam como vieram e nao contam como caminho", t => {
        const clock = useFakeClock(t);
        const r = rig();
        r.remote(MDNS);
        r.filter.remoteCandidate({ candidate: "", sdpMid: "0" }, c => r.added.push(String(c.candidate)));
        r.remote(TEREDO, { sdpMid: null, sdpMLineIndex: 0 });
        assert.deepEqual(r.added, [cand(MDNS), ""]);
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(r.added, [cand(MDNS), "", cand(TEREDO)]);
    });

    test("os nossos: o Teredo espera um direto; no fim da coleta (candidato null) o segurado sem alternativa sai antes do fim", t => {
        useFakeClock(t);
        const r = rig();
        const mark = logMark();
        r.local(TEREDO);
        r.local(TEREDO.replace("fdd2", "fdd3"));
        r.local(V4);
        assert.deepEqual(r.emitted, [cand(V4)], "com o IPv4, os dois Teredo nao saem");
        assert.deepEqual(logged(/Teredo/, mark).map(e => e.msg), ["amigo (abc123): 2 candidatos deste PC pelo Teredo deixados de fora (há outro caminho, mais rápido)"]);
        r.local(TEREDO, { usernameFragment: "l2" });
        r.local(null);
        assert.deepEqual(r.emitted, [cand(V4), cand(TEREDO), null], "ufrag nova so com o Teredo: sai no fim da coleta, antes do null");
        r.local(MDNS);
        assert.equal(r.emitted.at(-1), cand(MDNS));
        r.filter.localCandidate({ candidate: { candidate: "nada", sdpMid: "0" } } as unknown as RTCPeerConnectionIceEvent, e => r.emitted.push(e.candidate!.candidate));
        assert.equal(r.emitted.at(-1), "nada");
    });

    test("IPv6 deste PC so no Teredo: o IPv6 normal do outro lado tambem conta como Teredo (so entra sem outro caminho)", t => {
        const clock = useFakeClock(t);
        const r = rig();
        assert.equal(r.filter.ipv6OnlyTeredo(), false);
        r.local(TEREDO);
        // ULA e link-local nao sao um IPv6 que vai pela internet
        r.local("fd12:3456:789a::1");
        r.local("fe80::1c2b:3a4d:5e6f:7a8b");
        assert.equal(r.filter.ipv6OnlyTeredo(), true);
        assert.equal(rig().filter.ipv6OnlyTeredo(), false, "por conexao: outra comeca sem saber");
        r.remote(V6);
        assert.deepEqual(r.added, [], "o IPv6 dele so seria alcancado pelo nosso tunel");
        r.remote(V4);
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(r.added, [cand(V4)]);

        // com um IPv6 de verdade aqui, o IPv6 dele e direto de novo
        r.local(V6);
        assert.equal(r.filter.ipv6OnlyTeredo(), false);
        r.remote(V6, { usernameFragment: "r2" });
        assert.deepEqual(r.added, [cand(V4), cand(V6)]);
    });
});

describe("TeredoFilter: candidatos no SDP (renegociacao, reinicio do ICE)", () => {

    const sdp = (lines: string[], eol = "\r\n") => [
        "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=ice-ufrag:sess",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:0", ...lines,
        "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1", "a=ice-ufrag:vid", `a=${cand(TEREDO)}`, ""
    ].join(eol);

    test("o Teredo sai so da m-section que tem outro caminho para o mesmo componente; sem nada a tirar, o mesmo texto", () => {
        const f = new TeredoFilter(() => "x");
        const original = sdp([`a=${cand(TEREDO)}`, `a=${cand(V4)}`, `a=${cand(TEREDO, "host", 2)}`]);
        const out = f.filterSdp(original, "remote");
        assert.equal(out, sdp([`a=${cand(V4)}`, `a=${cand(TEREDO, "host", 2)}`]), "componente 2 e a outra m-section (ufrag dela) ficam com o Teredo");
        const lone = sdp([`a=${cand(TEREDO)}`], "\n");
        assert.equal(f.filterSdp(lone, "local"), lone, "sem caminho direto: igual");
        assert.equal(f.filterSdp("v=0\r\n", "local"), "v=0\r\n");
    });

    test("os diretos do SDP valem para os que chegam depois; o SDP local ensina o IPv6 deste PC", t => {
        useFakeClock(t);
        const f = new TeredoFilter(() => "x");
        f.filterSdp(sdp([`a=${cand(V4)}`]), "remote");
        const added: string[] = [];
        f.remoteCandidate({ candidate: cand(TEREDO), sdpMid: "0", usernameFragment: "sess" }, c => added.push(c.candidate!));
        assert.deepEqual(added, [], "descartado na hora");

        f.filterSdp(sdp([`a=${cand(TEREDO)}`]), "local");
        assert.equal(f.ipv6OnlyTeredo(), true);
        f.filterSdp(sdp([`a=${cand(V6)}`]), "local");
        assert.equal(f.ipv6OnlyTeredo(), false);
    });
});

describe("TeredoFilter: o resgate (o outro caminho nao funcionou)", () => {
    test("devolve o que ficou de fora (pelo trickle, segurado ou no SDP do outro lado), uma vez cada, e desliga o filtro", t => {
        const clock = useFakeClock(t);
        const f = new TeredoFilter(() => "x");
        const added: string[] = [];
        const emitted: string[] = [];
        const add = (c: RTCIceCandidateInit) => added.push(c.candidate!);
        const emit = (e: RTCPeerConnectionIceEvent) => emitted.push(e.candidate!.candidate);
        const local = (address: string) => ({ candidate: { candidate: cand(address), sdpMid: "0", usernameFragment: "l1" } }) as unknown as RTCPeerConnectionIceEvent;
        assert.equal(f.hasDropped(), false);
        assert.equal(f.releaseDropped(), 0, "nada a devolver");

        const g = new TeredoFilter(() => "x");
        // o nosso: segurado, e descartado quando o IPv4 chega
        g.localCandidate(local(TEREDO), emit);
        g.localCandidate(local(V4), emit);
        // o do outro lado: descartado na hora (o IPv4 dele ja veio pelo SDP), e o mesmo de novo no SDP seguinte
        const remoteSdp = ["v=0", "a=ice-ufrag:r1", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0", `a=${cand(V4)}`, `a=${cand(TEREDO)}`, ""].join("\r\n");
        g.filterSdp(remoteSdp, "remote", add);
        g.filterSdp(remoteSdp, "remote", add);
        g.remoteCandidate({ candidate: cand(TEREDO), sdpMid: "0", usernameFragment: "r1" }, add);
        // ainda segurado (outro componente, sem direto): o resgate tambem o solta
        g.remoteCandidate({ candidate: cand(TEREDO, "host", 2), sdpMid: "0", usernameFragment: "r1" }, add);
        assert.deepEqual([emitted, added], [[cand(V4)], []]);
        assert.equal(g.hasDropped(), true);

        assert.equal(g.releaseDropped(), 2, "o nosso e o do outro lado (o mesmo candidato do SDP e do trickle conta uma vez)");
        assert.deepEqual(emitted, [cand(V4), cand(TEREDO)]);
        assert.deepEqual(added, [cand(TEREDO, "host", 2), cand(TEREDO)]);
        // desligado: tudo passa, inclusive no SDP
        g.remoteCandidate({ candidate: cand("2001::5ef5:79fd"), sdpMid: "0", usernameFragment: "r1" }, add);
        assert.equal(added.at(-1), cand("2001::5ef5:79fd"));
        assert.equal(g.filterSdp(remoteSdp, "remote", add), remoteSdp);
        clock.tick(TEREDO_HOLD_MS);
        assert.equal(added.length, 3, "nada segurado sobrou");
    });
});

describe("TeredoFilter: onFirstDrop", () => {
    const local = (address: string) => ({ candidate: { candidate: cand(address), sdpMid: "0", usernameFragment: "l1" } }) as unknown as RTCPeerConnectionIceEvent;
    const sdp = ["v=0", "a=ice-ufrag:r1", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0", `a=${cand(V4)}`, `a=${cand(TEREDO)}`, ""].join("\r\n");

    test("trickle local: uma vez, no primeiro descartado", () => {
        let n = 0;
        const f = new TeredoFilter(() => "x", () => n++);
        f.localCandidate(local(V4), () => { });
        assert.equal(n, 0, "nada de fora");
        f.localCandidate(local(TEREDO), () => { });
        assert.equal(n, 1);
        f.localCandidate(local("26.1.2.3"), () => { });
        assert.equal(n, 1, "os seguintes nao chamam de novo");
    });

    test("trickle remoto e SDP com resgate", () => {
        let n = 0;
        const f = new TeredoFilter(() => "x", () => n++);
        f.remoteCandidate({ candidate: cand(V4), sdpMid: "0", usernameFragment: "r1" }, () => { });
        f.remoteCandidate({ candidate: cand(TEREDO), sdpMid: "0", usernameFragment: "r1" }, () => { });
        assert.equal(n, 1);
        let m = 0;
        const g = new TeredoFilter(() => "x", () => m++);
        g.filterSdp(sdp, "remote", () => { });
        assert.equal(m, 1);
        g.filterSdp(sdp.replace(TEREDO, "2001::5ef5:79fd"), "remote", () => { });
        assert.equal(m, 1);
    });

    test("nunca depois do resgate, e sem callback nao quebra", () => {
        let n = 0;
        const f = new TeredoFilter(() => "x", () => n++);
        f.releaseDropped();
        f.remoteCandidate({ candidate: cand(V4), sdpMid: "0", usernameFragment: "r1" }, () => { });
        f.remoteCandidate({ candidate: cand(TEREDO), sdpMid: "0", usernameFragment: "r1" }, () => { });
        assert.equal(n, 0);
        const g = new TeredoFilter(() => "x");
        g.remoteCandidate({ candidate: cand(V4), sdpMid: "0", usernameFragment: "r1" }, () => { });
        g.remoteCandidate({ candidate: cand(TEREDO), sdpMid: "0", usernameFragment: "r1" }, () => { });
    });
});

describe("TeredoFilter: VPNs overlay (Radmin, Hamachi, Tailscale) tratadas como o Teredo", () => {
    const RADMIN = "26.14.8.77";
    const RADMIN2 = "26.14.8.78";
    const RADMIN6 = "fdfd::1a2b";
    const HAMACHI6 = "2620:9b::1962:5d1c";
    const TAILSCALE6 = "fd7a:115c:a1e0:ab12:4843:cd96:6258:1a2b";
    const LAN = "192.168.0.10";
    const host = (address: string, component = 1) => cand(address, "host", component);

    function rig() {
        const filter = new TeredoFilter(() => "leozzyy");
        const added: string[] = [];
        const emitted: (string | null)[] = [];
        const remote = (address: string, type = "host") =>
            filter.remoteCandidate({ candidate: cand(address, type), sdpMid: "0", usernameFragment: "r1" }, c => added.push(c.candidate!));
        const local = (address: string | null, type = "host") =>
            filter.localCandidate({ candidate: address == null ? null : { candidate: cand(address, type), sdpMid: "0", usernameFragment: "l1" } } as unknown as RTCPeerConnectionIceEvent,
                e => emitted.push(e.candidate?.candidate ?? null));
        return { filter, added, emitted, remote, local };
    }

    test("lado local: o 26.x depois do 192.168 e descartado e guardado; antes, espera e e descartado quando o direto chega (log sem endereco)", t => {
        const clock = useFakeClock(t);
        const r = rig();
        const mark = logMark();
        r.local(LAN);
        r.local(RADMIN);
        assert.deepEqual(r.emitted, [host(LAN)]);
        assert.equal(r.filter.hasDropped(), true);

        const s = rig();
        s.local(RADMIN);
        assert.deepEqual(s.emitted, [], "segurado");
        s.local(LAN);
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(s.emitted, [host(LAN)], "nunca sai");

        const lines = logged(/VPN/, mark).map(e => e.msg);
        const one = "leozzyy: um candidato deste PC pela VPN Radmin deixado de fora (há outro caminho, mais rápido)";
        assert.deepEqual(lines, [one, one], "uma linha por filtro (r e s sao duas conexoes)");
        assert.doesNotMatch(lines.join(" "), /26\.14|192\.168/);
    });

    test("lado local: sem direto o 26.x passa depois da espera (dois Radmin sozinhos passam)", t => {
        const clock = useFakeClock(t);
        const r = rig();
        r.local(RADMIN);
        r.local(RADMIN2);
        clock.tick(TEREDO_HOLD_MS - 1);
        assert.deepEqual(r.emitted, []);
        clock.tick(1);
        assert.deepEqual(r.emitted, [host(RADMIN), host(RADMIN2)]);
    });

    test("lado remoto: descartado com direto; sem direto espera e passa", t => {
        const clock = useFakeClock(t);
        const r = rig();
        r.remote(LAN);
        r.remote(RADMIN);
        assert.deepEqual(r.added, [host(LAN)]);

        const s = rig();
        s.remote(RADMIN);
        assert.deepEqual(s.added, []);
        s.remote(LAN);
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(s.added, [host(LAN)]);

        const u = rig();
        u.remote(TAILSCALE6);
        u.remote(RADMIN);
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(u.added, [host(TAILSCALE6), host(RADMIN)], "so VPN: passam");
    });

    test("o caso da LAN: 192.168 host + 26.x host + srflx: o 192.168 e o srflx passam, o 26.x nao", () => {
        const r = rig();
        r.local(LAN);
        r.local(RADMIN);
        r.local(V4, "srflx");
        assert.deepEqual(r.emitted, [host(LAN), cand(V4, "srflx")]);
    });

    test("no log, Teredo e cada VPN tem a sua linha (um nao engole o outro); o texto do Teredo e o de sempre", t => {
        useFakeClock(t);
        const r = rig();
        const mark = logMark();
        r.local(LAN);
        r.local(TEREDO);
        r.local(RADMIN);
        r.local("2620:9b::7");
        r.remote(LAN);
        r.remote("25.1.2.3");
        r.remote("25.1.2.4");
        const lines = logged(/deixado/, mark).map(e => e.msg);
        assert.deepEqual(lines, [
            "leozzyy: um candidato deste PC pelo Teredo deixado de fora (há outro caminho, mais rápido)",
            "leozzyy: um candidato deste PC pela VPN Radmin deixado de fora (há outro caminho, mais rápido)",
            "leozzyy: um candidato deste PC pela VPN Hamachi deixado de fora (há outro caminho, mais rápido)",
            "leozzyy: um candidato do outro PC pela VPN Hamachi deixado de fora (há outro caminho, mais rápido)"
        ]);
        assert.doesNotMatch(lines.join(" "), /2001|26\.14|25\.1|2620|192\.168/);
    });

    test("varios de uma VPN e do Teredo de uma vez (segurados, SDP): uma linha por motivo, com a contagem", t => {
        useFakeClock(t);
        const f = new TeredoFilter(() => "leozzyy");
        const mark = logMark();
        const sdp = ["v=0", "a=ice-ufrag:r1", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0", `a=${host(LAN)}`, `a=${host(RADMIN)}`, `a=${host(RADMIN2)}`, `a=${host(TEREDO)}`, ""].join("\r\n");
        f.filterSdp(sdp, "remote");
        assert.deepEqual(logged(/deixado/, mark).map(e => e.msg), [
            "leozzyy: 2 candidatos do outro PC pela VPN Radmin deixados de fora (há outro caminho, mais rápido)",
            "leozzyy: um candidato do outro PC pelo Teredo deixado de fora (há outro caminho, mais rápido)"
        ]);
    });

    test("o IPv6 de uma VPN nao ensina o IPv6 deste PC; o ipv6OnlyTeredo vale com Teredo + Hamachi", t => {
        const clock = useFakeClock(t);
        const r = rig();
        r.local(HAMACHI6);
        r.local(RADMIN6);
        r.local(TAILSCALE6);
        assert.equal(r.filter.ipv6OnlyTeredo(), false, "sem Teredo");
        r.local(TEREDO);
        assert.equal(r.filter.ipv6OnlyTeredo(), true, "o Hamachi nao conta como IPv6 global");
        r.remote(V6);
        assert.deepEqual(r.added, [], "o IPv6 normal dele ainda e Teredo para nos");
        r.remote(V4);
        clock.tick(TEREDO_HOLD_MS);
        assert.deepEqual(r.added, [host(V4)]);
    });

    test("SDP: tira 26.x, fdfd::, 2620:9b:: e fd7a:115c:a1e0:: quando ha direto; mantem quando nao ha", () => {
        const sdp = (lines: string[]) => ["v=0", "a=ice-ufrag:sess", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0", ...lines.map(l => `a=${l}`), ""].join("\r\n");
        const vpns = [host(RADMIN), host(RADMIN6), host(HAMACHI6), host(TAILSCALE6)];
        assert.equal(new TeredoFilter(() => "x").filterSdp(sdp([host(LAN), ...vpns]), "remote"), sdp([host(LAN)]));
        assert.equal(new TeredoFilter(() => "x").filterSdp(sdp(vpns), "remote"), sdp(vpns));
        assert.equal(new TeredoFilter(() => "x").filterSdp(sdp([host(LAN), host(RADMIN)]), "local"), sdp([host(LAN)]));
    });

    test("o resgate devolve os candidatos de VPN pela funcao de cada lado, junto com o Teredo", t => {
        useFakeClock(t);
        const f = new TeredoFilter(() => "x");
        const added: string[] = [];
        const emitted: string[] = [];
        const add = (c: RTCIceCandidateInit) => added.push(c.candidate!);
        const emit = (e: RTCPeerConnectionIceEvent) => emitted.push(e.candidate!.candidate);
        const local = (address: string) => ({ candidate: { candidate: host(address), sdpMid: "0", usernameFragment: "l1" } }) as unknown as RTCPeerConnectionIceEvent;
        f.localCandidate(local(LAN), emit);
        f.localCandidate(local(RADMIN), emit);
        f.localCandidate(local(TEREDO), emit);
        const remoteSdp = ["v=0", "a=ice-ufrag:r1", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:0", `a=${host(LAN)}`, `a=${host(RADMIN)}`, ""].join("\r\n");
        f.filterSdp(remoteSdp, "remote", add);
        assert.deepEqual([emitted, added], [[host(LAN)], []]);
        assert.equal(f.releaseDropped(), 3);
        assert.deepEqual(emitted, [host(LAN), host(RADMIN), host(TEREDO)]);
        assert.deepEqual(added, [host(RADMIN)]);
    });
});
