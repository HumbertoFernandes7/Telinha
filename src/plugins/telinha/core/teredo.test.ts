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
    addressKind, pairTeredo, parseCandidate, selectedPair, TEREDO_HOLD_MS, TEREDO_TEXT, TeredoFilter, teredoSide
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
        assert.deepEqual(parseCandidate(cand(TEREDO)), { component: "1", kind: "teredo" });
        assert.deepEqual(parseCandidate(`a=${cand(V4, "host", 2)}`), { component: "2", kind: "ipv4" });
        assert.deepEqual(parseCandidate(cand(MDNS, "host")), { component: "1", kind: "unknown" });
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
