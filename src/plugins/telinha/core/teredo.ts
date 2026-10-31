/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Teredo: o tunel IPv6-sobre-UDP do Windows (prefixo 2001:0000::/32, passando por servidores da Microsoft). Um amigo
// com fibra assistia a ~1,5-2,6 Mbps porque a conexao dele com o Telinha ia pelo Teredo. Por que o WebRTC escolhe esse
// caminho: o endereco Teredo e um candidato "host" (tipo 126), que vence os pares IPv4 "srflx" (tipo 100) na prioridade
// do ICE, mesmo com a precedencia de endereco do libwebrtc baixa para o Teredo (5 contra 30 do IPv4).
//
// Este modulo:
// - classifica enderecos (addressKind) e diz se o par de candidatos em uso passa pelo Teredo (pairTeredo), para o aviso
//   (session.ts), as linhas do log de estatisticas e o diagnostico. Nunca devolve nem loga o endereco, so o fato;
// - filtra candidatos ICE (TeredoFilter, usado pela RTCPeerConnection do Telinha, peerConnection.ts): um candidato pelo
//   Teredo so sai (o nosso) ou entra (o do outro lado) se nao houver outro caminho para o mesmo componente. O Trystero
//   manda os candidatos aos poucos (trickle); um candidato Teredo que chega antes de qualquer outro espera ate
//   TEREDO_HOLD_MS: se nesse tempo aparece um candidato direto, ele e descartado; senao, passa (sem outro caminho, o
//   Teredo e melhor que nada). Os SDPs (renegociacoes, reinicio do ICE) levam os candidatos ja coletados: filterSdp.
//
// Regra a mais, so para o lado remoto: se o IPv6 DESTE PC e so Teredo (visto nos nossos candidatos: algum Teredo e
// nenhum IPv6 de verdade), um IPv6 normal do outro lado so e alcancado pelo nosso tunel, entao conta como Teredo tambem.
// Sem ela, o PC com Teredo continuaria formando o par (Teredo deste PC x IPv6 do amigo) e o filtro nao adiantaria.

import { logThrottled } from "./log";

export type AddressKind = "teredo" | "ipv4" | "ipv6" | "unknown";

/** Qual lado do par em uso esta no Teredo. */
export type TeredoSide = "local" | "remote" | "both";

/** Texto do marcador nas linhas do log e no diagnostico (sem endereco). */
export const TEREDO_TEXT: Record<TeredoSide, string> = {
    local: "via Teredo (este PC)",
    remote: "via Teredo (o outro PC)",
    both: "via Teredo (os dois PCs)"
};

/** Candidato Teredo sem outro caminho conhecido espera isto por um candidato direto antes de passar. */
export const TEREDO_HOLD_MS = 2500;

const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HEXTET_RE = /^[0-9a-f]{1,4}$/;

/**
 * Tipo do endereco de um candidato. Nome mDNS (host oculto pelo Chromium: "<uuid>.local"), vazio ou invalido: "unknown"
 * (nao da para saber, nunca e tratado como Teredo).
 */
export function addressKind(address: unknown): AddressKind {
    if (typeof address !== "string") return "unknown";
    const a = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
    if (IPV4_RE.test(a)) return "ipv4";
    if (!a.includes(":")) return "unknown";
    const halves = a.split("::");
    if (halves.length > 2) return "unknown";
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    // IPv4 no fim (ex.: ::ffff:1.2.3.4) conta como dois grupos
    const last = tail.length ? tail : head;
    const v4Tail = last.length > 0 && IPV4_RE.test(last[last.length - 1]);
    if (v4Tail) last.pop();
    const groups = head.length + tail.length + (v4Tail ? 2 : 0);
    if (![...head, ...tail].every(g => HEXTET_RE.test(g))) return "unknown";
    if (halves.length === 1 ? groups !== 8 : groups > 7) return "unknown";
    // 2001:0000::/32: o 1o grupo e 2001 e o 2o e zero (escrito, ou comprimido em "2001::")
    const second = head.length > 1 ? head[1] : "0";
    return head[0] === "2001" && parseInt(second, 16) === 0 ? "teredo" : "ipv6";
}

/** O lado do par no Teredo; null = nenhum (ou desconhecido). */
export function teredoSide(local: AddressKind, remote: AddressKind): TeredoSide | null {
    if (local === "teredo") return remote === "teredo" ? "both" : "local";
    return remote === "teredo" ? "remote" : null;
}

/** Endereco de uma estatistica de candidato (address; Chromium antigo: ip). */
const statsAddress = (c: any): unknown => c?.address ?? c?.ip;

/**
 * O par de candidatos em uso (o selectedCandidatePairId do transport; sem ele, o nomeado e bem-sucedido) de um
 * RTCStatsReport. null = ainda nenhum.
 */
export function selectedPair(report: RTCStatsReport): any {
    let pair: any = null;
    report.forEach((s: any) => {
        if (!pair && s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId) ?? null;
    });
    if (!pair) report.forEach((s: any) => {
        if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
    });
    return pair;
}

/** O par `pair` (das estatisticas `report`) passa pelo Teredo? null = nao, ou nao da para saber. */
export function pairTeredo(report: RTCStatsReport, pair: any): TeredoSide | null {
    if (!pair) return null;
    return teredoSide(addressKind(statsAddress(report.get(pair.localCandidateId))), addressKind(statsAddress(report.get(pair.remoteCandidateId))));
}

// #region filtro de candidatos

/** Partes de uma linha de candidato ("candidate:..." ou "a=candidate:...") que o filtro usa. */
export interface ParsedCandidate {
    component: string;
    kind: AddressKind;
}

/** "candidate:<fundacao> <componente> <transporte> <prioridade> <endereco> <porta> typ <tipo> ..." */
export function parseCandidate(line: unknown): ParsedCandidate | null {
    if (typeof line !== "string") return null;
    const parts = line.trim().replace(/^a=/, "").split(/\s+/);
    if (!/^candidate:/.test(parts[0]) || parts.length < 8) return null;
    return { component: parts[1], kind: addressKind(parts[4]) };
}

/** O IPv6 deste PC visto nos nossos candidatos (todas as conexoes desta sessao do Discord). */
const machine = { teredo: false, native: false };

/** O IPv6 deste PC e so Teredo (algum candidato nosso no Teredo e nenhum IPv6 de verdade). */
export function ipv6IsOnlyTeredo(): boolean {
    return machine.teredo && !machine.native;
}

/** Esquece o que foi visto do IPv6 deste PC (testes). */
export function resetTeredoMemory() {
    machine.teredo = machine.native = false;
}

type Side = "local" | "remote";
type Route = "teredo" | "direct" | "unknown";

/** O caminho de um candidato: pelo Teredo, direto (IPv4 ou IPv6 de verdade) ou desconhecido (mDNS). */
function routeOf(side: Side, kind: AddressKind): Route {
    if (kind === "teredo") return "teredo";
    if (kind === "unknown") return "unknown";
    // regra do lado remoto: com o IPv6 deste PC so no Teredo, o IPv6 do outro lado so e alcancado por ele
    return side === "remote" && kind === "ipv6" && ipv6IsOnlyTeredo() ? "teredo" : "direct";
}

interface Held<T> {
    items: T[];
    /** para onde os segurados vao quando passam */
    pass: (item: T) => void;
    timer: ReturnType<typeof setTimeout>;
}

class SideState<T> {
    /** chaves (ufrag|mid|componente) com algum candidato direto ja visto */
    readonly direct = new Set<string>();
    readonly held = new Map<string, Held<T>>();
}

const keyOf = (ufrag: string | null | undefined, mid: string | number | null | undefined, component: string) => `${ufrag ?? ""}|${mid ?? ""}|${component}`;

/**
 * Filtro de candidatos de UMA RTCPeerConnection (ver o topo). `label()`: nome do peer para o log (uma linha por conexao
 * e lado, sem enderecos).
 */
export class TeredoFilter {
    private readonly local = new SideState<RTCPeerConnectionIceEvent>();
    private readonly remote = new SideState<RTCIceCandidateInit>();
    private readonly id = Math.random().toString(36).slice(2, 10);

    constructor(private readonly label: () => string) { }

    /** Candidato nosso (onicecandidate): `emit` agora, depois (segurado) ou nunca (descartado). null = fim da coleta. */
    localCandidate(event: RTCPeerConnectionIceEvent, emit: (event: RTCPeerConnectionIceEvent) => void) {
        const c = event.candidate;
        if (!c) {
            this.releaseAll(this.local);
            emit(event);
            return;
        }
        const parsed = parseCandidate(c.candidate);
        if (!parsed) return emit(event);
        this.learn(parsed.kind);
        this.route("local", this.local, keyOf(c.usernameFragment, c.sdpMid ?? c.sdpMLineIndex, parsed.component), routeOf("local", parsed.kind), event, emit);
    }

    /** Candidato do outro lado (addIceCandidate): `add` agora, depois ou nunca. */
    remoteCandidate(init: RTCIceCandidateInit, add: (init: RTCIceCandidateInit) => void) {
        const parsed = parseCandidate(init.candidate);
        if (!parsed) return add(init);
        this.route("remote", this.remote, keyOf(init.usernameFragment, init.sdpMid ?? init.sdpMLineIndex, parsed.component), routeOf("remote", parsed.kind), init, add);
    }

    /**
     * Tira do SDP (`side`: o nosso, que vai para o outro lado, ou o recebido) as linhas de candidato pelo Teredo cujo
     * componente tem outro caminho (no proprio SDP ou ja visto por trickle). Os candidatos diretos do SDP passam a contar
     * para os que chegarem depois. Devolve o mesmo texto quando nada sai.
     */
    filterSdp(sdp: string, side: Side): string {
        const state = side === "local" ? this.local : this.remote;
        const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
        const lines = sdp.split(eol);
        const sessionUfrag = ufragIn(lines.slice(0, Math.max(0, lines.findIndex(l => l.startsWith("m=")))));
        // m-sections: [inicio, fim)
        const starts = lines.map((l, i) => (l.startsWith("m=") ? i : -1)).filter(i => i >= 0);
        const drop = new Set<number>();
        starts.forEach((start, n) => {
            const section = lines.slice(start, starts[n + 1] ?? lines.length);
            const ufrag = ufragIn(section) ?? sessionUfrag;
            const mid = section.find(l => l.startsWith("a=mid:"))?.slice(6).trim();
            const teredo: { at: number; key: string; }[] = [];
            section.forEach((line, i) => {
                const parsed = parseCandidate(line);
                if (!parsed) return;
                if (side === "local") this.learn(parsed.kind);
                const key = keyOf(ufrag, mid, parsed.component);
                const route = routeOf(side, parsed.kind);
                if (route === "direct") state.direct.add(key);
                else if (route === "teredo") teredo.push({ at: start + i, key });
            });
            for (const t of teredo) if (state.direct.has(t.key)) drop.add(t.at);
        });
        if (!drop.size) return sdp;
        this.noteDropped(side, drop.size);
        return lines.filter((_, i) => !drop.has(i)).join(eol);
    }

    private learn(kind: AddressKind) {
        if (kind === "teredo") machine.teredo = true;
        else if (kind === "ipv6") machine.native = true;
    }

    private route<T>(side: Side, state: SideState<T>, key: string, route: Route, item: T, pass: (item: T) => void) {
        if (route === "unknown") return pass(item);
        if (route === "direct") {
            state.direct.add(key);
            const held = state.held.get(key);
            if (held) {
                clearTimeout(held.timer);
                state.held.delete(key);
                this.noteDropped(side, held.items.length);
            }
            return pass(item);
        }
        if (state.direct.has(key)) return this.noteDropped(side, 1);
        const held = state.held.get(key);
        if (held) {
            held.items.push(item);
            return;
        }
        state.held.set(key, { items: [item], pass, timer: setTimeout(() => this.release(state, key), TEREDO_HOLD_MS) });
    }

    /** Segurado sem candidato direto ate o fim da espera (ou da coleta): passa (o Teredo e o unico caminho conhecido). */
    private release<T>(state: SideState<T>, key: string) {
        // a espera e cancelada sempre que a chave sai de `held`: aqui ela ainda esta la
        const held = state.held.get(key)!;
        clearTimeout(held.timer);
        state.held.delete(key);
        for (const item of held.items) held.pass(item);
    }

    /** Fim da coleta dos nossos candidatos: o que estava segurado passa agora. */
    private releaseAll<T>(state: SideState<T>) {
        for (const key of [...state.held.keys()]) this.release(state, key);
    }

    private noteDropped(side: Side, count: number) {
        logThrottled(`teredo-drop:${this.id}:${side}`, "info", `${this.label()}: ${count === 1 ? "um candidato" : `${count} candidatos`} `
            + `${side === "local" ? "deste PC" : "do outro PC"} pelo Teredo deixado${count === 1 ? "" : "s"} de fora (há outro caminho, mais rápido)`, 60_000);
    }
}

/** a=ice-ufrag de um trecho do SDP. */
function ufragIn(lines: string[]): string | null {
    return lines.find(l => l.startsWith("a=ice-ufrag:"))?.slice(12).trim() ?? null;
}

// #endregion
