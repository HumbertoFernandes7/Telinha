/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pagina de teste do spike P2P do PeerLive, fora do Discord. Fala EXATAMENTE o mesmo
// protocolo do plugin src/plugins/peerLiveP2PTest (mesmo app id, sala, senha, relays,
// acoes e mensagens), entao uma aba aqui e um Discord com o plugin se enxergam se o
// guildId/channelId digitados forem os do canal de voz.

import { getRelaySockets, joinRoom, selfId } from "https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm";

// ============================================================================
// PROTOCOLO — COPIA de src/plugins/peerLiveP2PTest/protocol.ts.
// AS DUAS COPIAS PRECISAM FICAR EM SINCRONIA (app id, sala, relays, ICE, acoes,
// formato das mensagens, versao). Mudou la, mude aqui.
// ============================================================================
const PROTOCOL_VERSION = 1;
const APP_ID = "peerlive-p2p-test-v1";
const ROOM_PREFIX = "peerlive-test-v1";
const RELAY_URLS = [
    "wss://relay.nostr.dev.br",
    "wss://cdn.satellite.earth",
    "wss://nostr.red5d.dev",
    "wss://nostrcity-club.fly.dev",
    "wss://relay.snort.social",
    "wss://nostr-pub.wellorder.net",
    "wss://nos.lol",
    "wss://relay.primal.net"
];
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
];
const ACTION_PRESENCE = "presence";
const ACTION_WATCH = "watch";
const HELLO_TYPE = "peerlive-hello";
const STREAM_KIND_TEST_PATTERN = "test-pattern";

async function deriveRoomId(guildId, voiceChannelId) {
    const input = `${ROOM_PREFIX}|${guildId ?? "dm"}|${voiceChannelId}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
const isHelloMessage = d => !!d && typeof d === "object" && d.type === HELLO_TYPE && typeof d.discordUserId === "string";
const isPresenceMessage = d => !!d && typeof d === "object" && typeof d.discordUserId === "string" && typeof d.streaming === "boolean";
const isWatchMessage = d => !!d && typeof d === "object" && (d.op === "start" || d.op === "stop");
// ============================================================================

const TRYSTERO_VERSION = "0.26.0";
const PATTERN_FPS = 60;
const TEST_MAX_BITRATE_KBPS = 8000; // igual a testPattern.ts
const LOG_PREFIX = "[PeerLive P2P]";
const READY_STATES = ["conectando", "aberto", "fechando", "fechado"];
const short = id => String(id).slice(0, 6);
const host = url => url.replace(/^wss:\/\//, "");
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const fmtMs = n => (n == null ? "—" : `${Math.round(n)} ms`);
const val = (n, suffix = "") => (n == null || n === "" ? "—" : `${n}${suffix}`);

// ---------------------------------------------------------------- stats (copia de stats.ts)

function addressFamily(address) {
    if (typeof address !== "string" || !address) return "desconhecido";
    if (address.endsWith(".local")) return "mDNS";
    if (address.includes(":")) return "IPv6";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return "IPv4";
    return "desconhecido";
}
function findSelectedPair(report) {
    let pair;
    report.forEach(s => {
        if (!pair && s.type === "transport" && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
    });
    if (pair) return pair;
    report.forEach(s => {
        if (s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded"))) pair ??= s;
    });
    return pair;
}
// O Chromium esconde o endereco de candidatos host nas stats (vem ""): procura a linha
// a=candidate com a mesma porta/protocolo/tipo no SDP so para descobrir a familia.
function familyFromSdp(sdp, cand) {
    if (!sdp || typeof cand?.port !== "number") return "desconhecido";
    for (const line of sdp.split(/\r?\n/)) {
        const m = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/i.exec(line);
        if (!m || Number(m[3]) !== cand.port) continue;
        if (cand.protocol && m[1].toLowerCase() !== String(cand.protocol).toLowerCase()) continue;
        if (cand.candidateType && m[4] !== cand.candidateType) continue;
        return addressFamily(m[2]);
    }
    return "desconhecido";
}
function candidateFamily(cand, sdp) {
    const fromStats = addressFamily(cand.address ?? cand.ip);
    return fromStats !== "desconhecido" ? fromStats : familyFromSdp(sdp, cand);
}
function describeSelectedPair(report, pc) {
    const pair = findSelectedPair(report);
    if (!pair) return null;
    const local = report.get(pair.localCandidateId) ?? {};
    const remote = report.get(pair.remoteCandidateId) ?? {};
    return {
        localType: local.candidateType ?? "?",
        remoteType: remote.candidateType ?? "?",
        protocol: local.protocol ?? remote.protocol ?? "?",
        localFamily: candidateFamily(local, pc?.localDescription?.sdp),
        remoteFamily: candidateFamily(remote, pc?.remoteDescription?.sdp),
        relayProtocol: local.relayProtocol,
        networkType: local.networkType,
        rttMs: typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : undefined
    };
}
const samePair = (a, b) => (!a || !b ? a === b : a.localType === b.localType && a.remoteType === b.remoteType
    && a.protocol === b.protocol && a.localFamily === b.localFamily && a.remoteFamily === b.remoteFamily);
function pairLabel(p) {
    if (!p) return "—";
    const relay = p.relayProtocol ? ` via TURN/${p.relayProtocol}` : "";
    return `${p.localType} ↔ ${p.remoteType} · ${String(p.protocol).toUpperCase()} · ${p.localFamily}/${p.remoteFamily}${relay}`;
}
const round = (n, d = 0) => (typeof n === "number" && isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : undefined);

class StatsSampler {
    prev = new Map();
    rate(key, bytes, ts) {
        if (typeof bytes !== "number") return undefined;
        const prev = this.prev.get(key);
        this.prev.set(key, { bytes, ts });
        if (!prev || ts <= prev.ts || bytes < prev.bytes) return undefined;
        return ((bytes - prev.bytes) * 8) / (ts - prev.ts);
    }
    inbound(report) {
        const out = { dir: "in" };
        let video, audio;
        report.forEach(s => {
            if (s.type !== "inbound-rtp") return;
            if (s.kind === "video" && (!video || (s.bytesReceived ?? 0) > (video.bytesReceived ?? 0))) video = s;
            if (s.kind === "audio" && !audio) audio = s;
        });
        const pair = findSelectedPair(report);
        if (pair && typeof pair.currentRoundTripTime === "number") out.rttMs = round(pair.currentRoundTripTime * 1000, 1);
        if (video) {
            out.fps = round(video.framesPerSecond, 1);
            out.width = video.frameWidth;
            out.height = video.frameHeight;
            out.kbps = round(this.rate("in-video", video.bytesReceived, video.timestamp));
            out.packetsLost = video.packetsLost;
            const total = (video.packetsReceived ?? 0) + (video.packetsLost ?? 0);
            out.lossPct = total > 0 ? round(((video.packetsLost ?? 0) / total) * 100, 2) : undefined;
            out.jitterMs = typeof video.jitter === "number" ? round(video.jitter * 1000, 1) : undefined;
            out.framesDecoded = video.framesDecoded;
            out.framesDropped = video.framesDropped;
            out.freezeCount = video.freezeCount;
            out.decoder = video.decoderImplementation;
        }
        if (audio) out.audioKbps = round(this.rate("in-audio", audio.bytesReceived, audio.timestamp));
        return out;
    }
    outbound(report) {
        const out = { dir: "out" };
        let video, remoteIn;
        report.forEach(s => {
            if (s.type === "outbound-rtp" && s.kind === "video" && (!video || (s.bytesSent ?? 0) > (video.bytesSent ?? 0))) video = s;
            if (s.type === "remote-inbound-rtp" && s.kind === "video") remoteIn = s;
        });
        const pair = findSelectedPair(report);
        if (pair && typeof pair.currentRoundTripTime === "number") out.rttMs = round(pair.currentRoundTripTime * 1000, 1);
        if (video) {
            out.fps = round(video.framesPerSecond, 1);
            out.width = video.frameWidth;
            out.height = video.frameHeight;
            out.kbps = round(this.rate("out-video", video.bytesSent, video.timestamp));
            out.qualityLimitation = video.qualityLimitationReason;
            out.nackCount = video.nackCount;
            out.pliCount = video.pliCount;
            out.encoder = video.encoderImplementation;
        }
        if (remoteIn && typeof remoteIn.fractionLost === "number") out.remoteLossPct = round(remoteIn.fractionLost * 100, 2);
        return out;
    }
}

// ---------------------------------------------------------------- padrao de teste (copia de testPattern.ts)

function formatClock(d = new Date()) {
    const p = (n, l = 2) => String(n).padStart(l, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Relogio de quadros num Worker: rAF para com a aba oculta e setInterval na thread principal
// cai para ~1 Hz em segundo plano; timers de Worker nao. Fallback: setInterval.
function startTicker(fps, onTick) {
    let fallback = null;
    const useInterval = () => { fallback ??= setInterval(onTick, 1000 / fps); };
    let worker = null;
    try {
        const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${1000 / fps});`], { type: "text/javascript" }));
        worker = new Worker(url);
        URL.revokeObjectURL(url);
        worker.onmessage = () => onTick();
        worker.onerror = () => {
            console.warn(LOG_PREFIX, "Worker do relógio falhou; usando setInterval");
            worker?.terminate();
            worker = null;
            useInterval();
        };
    } catch {
        useInterval();
    }
    return () => {
        worker?.terminate();
        if (fallback) clearInterval(fallback);
    };
}

function createTestPattern(label) {
    const W = 1280, H = 720, FPS = PATTERN_FPS;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const t0 = performance.now();
    let frame = 0;
    const draw = () => {
        const t = (performance.now() - t0) / 1000;
        frame++;
        const barW = W / 8;
        const offset = (t * 240) % barW;
        for (let i = -1; i < 9; i++) {
            ctx.fillStyle = `hsl(${(i * 45 + t * 30) % 360} 70% 32%)`;
            ctx.fillRect(i * barW + offset, 0, barW + 1, H);
        }
        const bx = (Math.sin(t * 1.7) * 0.5 + 0.5) * (W - 120);
        const by = Math.abs(Math.sin(t * 2.3)) * (H - 120);
        ctx.fillStyle = "#fff";
        ctx.fillRect(bx, by, 120, 120);
        ctx.save();
        ctx.translate(W - 110, 110);
        ctx.rotate(t * Math.PI * 2);
        ctx.fillStyle = "#ffeb3b";
        ctx.fillRect(-4, -90, 8, 90);
        ctx.restore();
        ctx.fillStyle = "rgba(0,0,0,0.78)";
        ctx.fillRect(0, H / 2 - 110, W, 220);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 150px Consolas, 'Courier New', monospace";
        ctx.fillText(formatClock(), W / 2, H / 2);
        ctx.font = "bold 28px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(0, 0, W, 48);
        ctx.fillStyle = "#fff";
        ctx.fillText(`PeerLive P2P · padrão de teste · ${label}`, 16, 10);
        ctx.textAlign = "right";
        ctx.fillText(`quadro ${frame}`, W - 16, 10);
    };
    draw();
    const stopTicker = startTicker(FPS, draw);
    const stream = canvas.captureStream(FPS);
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) videoTrack.contentHint = "motion";
    let audioCtx = null;
    try {
        audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 220;
        const gain = audioCtx.createGain();
        gain.gain.value = 0.015;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        osc.start();
        dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    } catch (e) {
        console.warn(LOG_PREFIX, "sem trilha de áudio de teste:", e);
    }
    return {
        stream,
        canvas,
        stop() {
            stopTicker();
            stream.getTracks().forEach(track => track.stop());
            audioCtx?.close().catch(() => { });
        }
    };
}

// ---------------------------------------------------------------- diagnostico (mesmo formato do plugin)

let log;
let t0 = performance.now();
let logFileName = "";
const since = () => Math.round(performance.now() - t0);

function scrubIps(s) {
    return String(s)
        .replace(/a=candidate:[^\r\n"]*/g, "a=candidate:[removido]")
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip]")
        .replace(/\b(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}\b/gi, "[ip]");
}
function scrubData(data) {
    if (data == null) return data;
    try { return JSON.parse(scrubIps(JSON.stringify(data))); } catch { return String(data); }
}

function newLog(client) {
    const now = new Date();
    t0 = performance.now();
    logFileName = `p2p-${now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "")}.json`;
    log = {
        tool: "PeerLive P2P spike",
        protocolVersion: PROTOCOL_VERSION,
        appId: APP_ID,
        relays: RELAY_URLS,
        iceServers: ICE_SERVERS.map(s => String(s.urls)),
        startedAt: now.toISOString(),
        client,
        events: [],
        relayTimeline: [],
        timings: [],
        connections: [],
        stats: []
    };
    render();
}

function logEvent(level, type, msg, data) {
    const cleanMsg = scrubIps(msg);
    const ev = { t: since(), at: new Date().toISOString(), level, type, msg: cleanMsg };
    if (data !== undefined) ev.data = scrubData(data);
    log.events.push(ev);
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    if (ev.data !== undefined) fn(LOG_PREFIX, `[${type}]`, cleanMsg, ev.data);
    else fn(LOG_PREFIX, `[${type}]`, cleanMsg);
    render();
}
function recordTiming(name, ms, peer, note) {
    const rounded = ms == null ? null : Math.round(ms);
    const timing = { t: since(), name, ms: rounded };
    if (peer) timing.peer = peer;
    if (note) timing.note = note;
    log.timings.push(timing);
    logEvent("info", "tempo", `${name}: ${rounded == null ? "n/d" : rounded + " ms"}${note ? ` (${note})` : ""}`, peer ? { peer } : undefined);
}
const recordRelayState = (relay, state) => log.relayTimeline.push({ t: since(), relay, state });
const recordConnection = (peer, reason, info) => log.connections.push({ t: since(), peer, reason, ...info });
function recordStats(peer, sample) {
    log.stats.push({ t: since(), peer, ...sample });
    if (log.stats.length > 7200) log.stats.splice(0, log.stats.length - 7200);
}

function downloadLog() {
    const blob = new Blob([JSON.stringify(log, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = logFileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- sessao (porta de session.ts)

let room = null;
let presenceAction = null;
let watchAction = null;
let status = "fora";
let roomId = null;
let joinedAt = 0;
let firstPeerMs = null;
let identity = { id: "", username: "", guildId: "", channelId: "", password: "", members: [], enforce: false };

const peers = new Map();
const helloByPeer = new Map();
const relays = {};
const relayFirstOpen = new Set();
let pattern = null;
const viewers = new Set();
const outbound = {};
const outSamplers = new Map();
let watching = null;
let inSampler = new StatsSampler();
let firstFramePoll = null;
let tickTimer = null;
let tickCount = 0;

const selfHello = () => ({ type: HELLO_TYPE, discordUserId: identity.id, username: identity.username, version: PROTOCOL_VERSION });
const selfPresence = () => ({ discordUserId: identity.id, username: identity.username, streaming: !!pattern, version: PROTOCOL_VERSION });

// Sem Discord aqui: a "lista de quem esta no canal" e simulada pelo campo do formulario.
function checkAdmission(userId) {
    if (!userId) return "sem-id";
    if (!identity.members.length) return "sem-verificacao";
    return identity.members.includes(userId) ? "ok" : "fora-do-canal";
}
function peerName(peerId) {
    const p = peers.get(peerId);
    const name = p?.presence?.username ?? p?.hello?.username ?? helloByPeer.get(peerId)?.username;
    return name ? `${name} (${short(peerId)})` : short(peerId);
}
function reevaluateAdmission() {
    for (const p of peers.values()) {
        const adm = checkAdmission(p.presence?.discordUserId ?? p.hello?.discordUserId);
        if (adm !== p.admission) {
            logEvent(adm === "ok" ? "info" : "warn", "admissao", `${peerName(p.peerId)}: admissão mudou ${p.admission} → ${adm}`);
            p.admission = adm;
        }
    }
    render();
}

async function join() {
    if (room) await leave("reentrada");
    status = "entrando";
    render();
    const guild = identity.guildId.trim() || null;
    roomId = await deriveRoomId(guild === "dm" ? null : guild, identity.channelId.trim());
    firstPeerMs = null;
    joinedAt = performance.now();
    const password = identity.password || undefined;
    logEvent("info", "sala", `Entrando na sala ${roomId.slice(0, 12)}…`, { guildId: guild ?? "dm", channelId: identity.channelId, roomId, password: !!password, selfId });

    const r = joinRoom(
        { appId: APP_ID, password, relayConfig: { urls: RELAY_URLS }, rtcConfig: { iceServers: ICE_SERVERS } },
        roomId,
        {
            onJoinError: d => {
                const hint = /password/i.test(d.error) ? " — senha do grupo diferente?" : /connect|ice|turn/i.test(d.error) ? " — sem caminho P2P direto (precisaria de TURN?)" : "";
                logEvent("error", "join", `Falha com peer ${peerName(d.peerId)}: ${d.error}${hint}`, { peerId: d.peerId, error: d.error });
            },
            onPeerHandshake: handshake,
            handshakeTimeoutMs: 15000
        }
    );
    presenceAction = r.makeAction(ACTION_PRESENCE);
    watchAction = r.makeAction(ACTION_WATCH);
    presenceAction.onMessage = onPresence;
    watchAction.onMessage = onWatch;
    r.onPeerJoin = onPeerJoin;
    r.onPeerLeave = onPeerLeave;
    r.onPeerStream = onPeerStream;
    room = r;
    status = "na-sala";
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
    tick();
    render();
}

async function leave(reason) {
    const r = room;
    if (!r) return;
    room = null;
    presenceAction = watchAction = null;
    logEvent("info", "sala", `Saindo da sala (${reason})`);
    stopWatchingInternal(false);
    viewers.clear();
    outSamplers.clear();
    for (const k of Object.keys(outbound)) delete outbound[k];
    peers.clear();
    helloByPeer.clear();
    status = "fora";
    render();
    try { await r.leave(); } catch (e) { logEvent("error", "sala", "Erro ao sair da sala: " + e); }
}

async function handshake(peerId, send, receive) {
    const t = performance.now();
    await send(selfHello());
    const { data } = await receive();
    if (!isHelloMessage(data)) {
        logEvent("warn", "admissao", `Peer ${short(peerId)} mandou handshake inválido (versão antiga ou outro app?)`);
        if (identity.enforce) throw new Error("handshake inválido");
        return;
    }
    helloByPeer.set(peerId, data);
    const adm = checkAdmission(data.discordUserId);
    const who = `${data.username} (discord ${data.discordUserId}, peer ${short(peerId)})`;
    if (adm === "ok" || adm === "sem-verificacao") {
        logEvent("info", "admissao", `Handshake ok com ${who} em ${Math.round(performance.now() - t)} ms — admissão: ${adm}`);
    } else {
        logEvent("warn", "admissao", `${identity.enforce ? "REJEITADO" : "ACEITO MAS MARCADO"}: ${who} — ${adm === "fora-do-canal" ? "NÃO está na lista simulada do canal" : adm}`);
        if (identity.enforce) throw new Error(`peer fora do canal de voz (${adm})`);
    }
    if (data.version !== PROTOCOL_VERSION) logEvent("warn", "admissao", `${who} usa protocolo v${data.version}, eu uso v${PROTOCOL_VERSION}`);
}

function onPeerJoin(peerId) {
    const afterMs = performance.now() - joinedAt;
    const hello = helloByPeer.get(peerId);
    peers.set(peerId, { peerId, seenAfterMs: Math.round(afterMs), hello, admission: checkAdmission(hello?.discordUserId), pair: null });
    logEvent("info", "peer", `Peer ${peerName(peerId)} ativo ${Math.round(afterMs)} ms após entrar na sala`);
    if (firstPeerMs == null) {
        firstPeerMs = afterMs;
        recordTiming("sala → primeiro peer visto", afterMs, peerId);
    }
    presenceAction?.send(selfPresence(), { target: peerId }).catch(e => logEvent("error", "presenca", "Falha ao enviar presença: " + e));
    inspectConnection(peerId, "peer-entrou");
    room?.ping(peerId).then(ms => {
        const cur = peers.get(peerId);
        if (!cur) return;
        cur.pingMs = Math.round(ms);
        logEvent("info", "peer", `Ping (canal de dados) com ${peerName(peerId)}: ${cur.pingMs} ms`);
    }).catch(() => { });
    render();
}

function onPeerLeave(peerId) {
    logEvent("info", "peer", `Peer ${peerName(peerId)} saiu`);
    peers.delete(peerId);
    helloByPeer.delete(peerId);
    viewers.delete(peerId);
    outSamplers.delete(peerId);
    delete outbound[peerId];
    if (watching?.peerId === peerId && !watching.ended) {
        watching.ended = "o peer saiu da sala";
        stopFirstFramePoll();
    }
    render();
}

function onPresence(data, { peerId }) {
    if (!isPresenceMessage(data)) return logEvent("warn", "presenca", `Presença inválida de ${short(peerId)}`);
    let p = peers.get(peerId);
    if (!p) {
        p = { peerId, seenAfterMs: Math.round(performance.now() - joinedAt), admission: "sem-id", pair: null };
        peers.set(peerId, p);
    }
    const prev = p.presence;
    p.presence = data;
    p.admission = checkAdmission(data.discordUserId);
    const hello = p.hello ?? helloByPeer.get(peerId);
    if (hello && hello.discordUserId !== data.discordUserId)
        logEvent("warn", "admissao", `${short(peerId)}: ID na presença (${data.discordUserId}) difere do handshake (${hello.discordUserId})`);
    if (!prev) {
        logEvent(p.admission === "fora-do-canal" ? "warn" : "info", "presenca",
            `${data.username} (discord ${data.discordUserId}) — admissão: ${p.admission} — transmitindo: ${data.streaming ? "sim" : "não"}`);
    } else if (prev.streaming !== data.streaming) {
        logEvent("info", "presenca", `${data.username} ${data.streaming ? "começou" : "parou"} de transmitir`);
    }
    if (!data.streaming && watching?.peerId === peerId && !watching.ended) {
        watching.ended = "a transmissão foi encerrada pelo peer";
        stopFirstFramePoll();
    }
    render();
}

function onWatch(data, { peerId }) {
    const r = room;
    if (!r || !isWatchMessage(data)) return;
    if (data.op === "start") {
        if (!pattern) {
            logEvent("warn", "midia", `${peerName(peerId)} pediu para assistir, mas não estou transmitindo`);
            presenceAction?.send(selfPresence(), { target: peerId }).catch(() => { });
            return;
        }
        viewers.add(peerId);
        outSamplers.set(peerId, new StatsSampler());
        logEvent("info", "midia", `Enviando o padrão de teste para ${peerName(peerId)}`);
        const { stream } = pattern;
        Promise.all(r.addStream(stream, { target: peerId, metadata: { kind: STREAM_KIND_TEST_PATTERN } }))
            .then(() => applyMaxBitrate(peerId, stream))
            .catch(e => logEvent("error", "midia", `Falha ao adicionar stream para ${peerName(peerId)}: ${e}`));
    } else {
        if (viewers.delete(peerId) && pattern) {
            try { r.removeStream(pattern.stream, { target: peerId }); } catch (e) { logEvent("error", "midia", "Falha ao remover stream: " + e); }
        }
        outSamplers.delete(peerId);
        delete outbound[peerId];
        logEvent("info", "midia", `${peerName(peerId)} parou de assistir`);
    }
    render();
}

/**
 * O Chromium limita o video a ~2,5 Mbps por padrao, o que esconderia a capacidade real do link.
 * Sobe o teto do encoder para TEST_MAX_BITRATE_KBPS (o controle de congestionamento continua valendo).
 */
async function applyMaxBitrate(peerId, stream) {
    const pc = room?.getPeers()[peerId];
    if (!pc) return;
    const tracks = stream.getVideoTracks();
    const senders = pc.getSenders().filter(s => s.track && tracks.includes(s.track));
    if (!senders.length) {
        logEvent("warn", "midia", `Sem RTCRtpSender de vídeo para ${peerName(peerId)}; teto de bitrate não aplicado`);
        return;
    }
    for (const sender of senders) {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = TEST_MAX_BITRATE_KBPS * 1000;
        params.encodings[0].maxFramerate = PATTERN_FPS;
        await sender.setParameters(params);
    }
    logEvent("info", "midia", `Teto do encoder para ${peerName(peerId)}: ${TEST_MAX_BITRATE_KBPS} kbps @ ${PATTERN_FPS} fps`);
}

function onPeerStream(stream, peerId) {
    const w = watching;
    if (!w || w.peerId !== peerId) {
        logEvent("warn", "midia", `Stream recebido de ${peerName(peerId)} sem ter pedido (ignorado)`);
        return;
    }
    w.stream = stream;
    w.streamMs = performance.now() - w.requestedAt;
    recordTiming("Assistir → stream recebido (ontrack)", w.streamMs, peerId, `${stream.getVideoTracks().length} vídeo, ${stream.getAudioTracks().length} áudio`);
    attachVideo(w);
    render();
}

function startTestStream() {
    if (pattern) return;
    pattern = createTestPattern(identity.username || "navegador");
    $("#preview").replaceChildren(pattern.canvas);
    logEvent("info", "midia", "Transmitindo padrão de teste (canvas 1280x720 @ 60 fps + tom de 220 Hz). Espectadores pedem com \"Assistir\".");
    presenceAction?.send(selfPresence()).catch(() => { });
    render();
}

function stopTestStream() {
    if (!pattern) return;
    const p = pattern;
    if (room && viewers.size) {
        try { room.removeStream(p.stream, { target: [...viewers] }); } catch (e) { logEvent("error", "midia", "Falha ao remover stream: " + e); }
    }
    viewers.clear();
    outSamplers.clear();
    for (const k of Object.keys(outbound)) delete outbound[k];
    p.stop();
    pattern = null;
    $("#preview").replaceChildren();
    logEvent("info", "midia", "Transmissão do padrão de teste encerrada");
    presenceAction?.send(selfPresence()).catch(() => { });
    render();
}

function watch(peerId) {
    const r = room;
    if (!r) return;
    if (watching) stopWatchingInternal(true);
    const w = { peerId, requestedAt: performance.now(), stream: null };
    watching = w;
    inSampler = new StatsSampler();
    logEvent("info", "midia", `Assistir ${peerName(peerId)}: pedido enviado`);
    const pc = r.getPeers()[peerId];
    if (!pc) {
        logEvent("error", "midia", `Sem RTCPeerConnection para ${peerName(peerId)}`);
    } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        w.iceMs = 0;
        w.iceNote = "já estava conectado desde a entrada do peer (canal de dados)";
        recordTiming("Assistir → ICE conectado", 0, peerId, w.iceNote);
    } else {
        const onIce = () => {
            if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
                w.iceMs = performance.now() - w.requestedAt;
                recordTiming("Assistir → ICE conectado", w.iceMs, peerId);
                pc.removeEventListener("iceconnectionstatechange", onIce);
            }
        };
        pc.addEventListener("iceconnectionstatechange", onIce);
    }
    watchAction?.send({ op: "start" }, { target: peerId }).catch(e => logEvent("error", "midia", "Falha ao pedir stream: " + e));
    startFirstFramePoll(w);
    attachVideo(null);
    render();
}

function stopWatching() {
    stopWatchingInternal(true);
    render();
}

function stopWatchingInternal(notify) {
    const w = watching;
    if (!w) return;
    watching = null;
    stopFirstFramePoll();
    attachVideo(null);
    if (notify && !w.ended) watchAction?.send({ op: "stop" }, { target: w.peerId }).catch(() => { });
    logEvent("info", "midia", `Parou de assistir ${peerName(w.peerId)}`);
}

function attachVideo(w) {
    const video = $("#remote");
    video.srcObject = w?.stream ?? null;
    if (!w?.stream) return;
    video.play().catch(() => { });
    const onFrame = () => {
        if (watching !== w || w.renderedMs != null) return;
        w.renderedMs = performance.now() - w.requestedAt;
        recordTiming("Assistir → primeiro quadro na tela", w.renderedMs, w.peerId);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
    else video.addEventListener("loadeddata", onFrame, { once: true });
}

function startFirstFramePoll(w) {
    stopFirstFramePoll();
    firstFramePoll = setInterval(async () => {
        if (watching !== w) return stopFirstFramePoll();
        if (performance.now() - w.requestedAt > 30000) {
            stopFirstFramePoll();
            logEvent("error", "midia", `Nenhum quadro decodificado em 30 s vindo de ${peerName(w.peerId)}`);
            recordTiming("Assistir → primeiro quadro decodificado", null, w.peerId, "timeout 30 s");
            return;
        }
        const pc = room?.getPeers()[w.peerId];
        if (!pc) return;
        try {
            const report = await pc.getStats();
            let decoded = 0;
            report.forEach(s => {
                if (s.type === "inbound-rtp" && s.kind === "video") decoded = Math.max(decoded, s.framesDecoded ?? 0);
            });
            if (decoded > 0 && watching === w && w.firstFrameMs == null) {
                w.firstFrameMs = performance.now() - w.requestedAt;
                stopFirstFramePoll();
                recordTiming("Assistir → primeiro quadro decodificado", w.firstFrameMs, w.peerId);
            }
        } catch { }
    }, 100);
}
function stopFirstFramePoll() {
    if (firstFramePoll) clearInterval(firstFramePoll);
    firstFramePoll = null;
}

async function inspectConnection(peerId, reason) {
    const pc = room?.getPeers()[peerId];
    if (!pc) return;
    try {
        const info = describeSelectedPair(await pc.getStats(), pc);
        const p = peers.get(peerId);
        if (!p) return;
        if (!info) {
            if (reason === "peer-entrou") logEvent("warn", "ice", `${peerName(peerId)}: ainda sem par de candidatos selecionado`);
            return;
        }
        if (!samePair(p.pair, info)) {
            const isChange = !!p.pair;
            p.pair = info;
            recordConnection(peerId, isChange ? "par-mudou" : reason, info);
            logEvent("info", "ice", `${isChange ? "Par ICE mudou" : "Conexão"} com ${peerName(peerId)}: ${pairLabel(info)}`, info);
        } else if (p.pair && info.rttMs != null) {
            p.pair.rttMs = info.rttMs;
        }
    } catch (e) {
        logEvent("error", "ice", `getStats falhou para ${short(peerId)}: ${e}`);
    }
}

const hookedSockets = new WeakSet();
function pollRelays() {
    let sockets = {};
    try { sockets = getRelaySockets() ?? {}; } catch { }
    for (const url of RELAY_URLS) {
        const ws = sockets[url] ?? sockets[url + "/"];
        if (ws && !hookedSockets.has(ws)) {
            hookedSockets.add(ws);
            ws.addEventListener("open", pollRelays);
            ws.addEventListener("close", pollRelays);
        }
        const st = ws ? READY_STATES[ws.readyState] ?? String(ws.readyState) : "não iniciado";
        if (relays[url] !== st) {
            const prev = relays[url];
            relays[url] = st;
            recordRelayState(url, st);
            if (prev !== undefined || st !== "não iniciado")
                logEvent(st === "aberto" || st === "conectando" ? "info" : "warn", "relay", `${host(url)}: ${prev ?? "—"} → ${st}`);
            if (st === "aberto" && !relayFirstOpen.has(url) && room) {
                relayFirstOpen.add(url);
                recordTiming(`sala → relay aberto (${host(url)})`, performance.now() - joinedAt);
            }
            render();
        }
    }
}

function tick() {
    tickCount++;
    pollRelays();
    const r = room;
    if (!r) return render();
    const pcs = r.getPeers();
    const w = watching;
    if (w && !w.ended && pcs[w.peerId]) {
        pcs[w.peerId].getStats().then(report => {
            if (watching !== w) return;
            w.last = inSampler.inbound(report);
            recordStats(w.peerId, w.last);
            render();
        }).catch(() => { });
    }
    for (const v of viewers) {
        const pc = pcs[v];
        const sampler = outSamplers.get(v);
        if (!pc || !sampler) continue;
        pc.getStats().then(report => {
            if (!viewers.has(v)) return;
            outbound[v] = sampler.outbound(report);
            recordStats(v, outbound[v]);
            render();
        }).catch(() => { });
    }
    if (tickCount % 5 === 0) for (const peerId of peers.keys()) inspectConnection(peerId, "verificacao");
    render();
}

// ---------------------------------------------------------------- UI

const ADMISSION_HTML = {
    "ok": "<span class=ok>✓ no canal</span>",
    "fora-do-canal": "<b class=err>⚠ FORA DO CANAL</b>",
    "sem-id": "<b class=warn>? sem ID</b>",
    "sem-verificacao": "<span class=warn>? não verificado</span>"
};

let renderQueued = false;
function render() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => {
        renderQueued = false;
        renderNow();
    }, 100);
}

function grid(items) {
    return `<div class=grid>${items.map(([k, v]) => `<div><div class=muted>${esc(k)}</div><div class=mono>${esc(v)}</div></div>`).join("")}</div>`;
}

function renderNow() {
    if (!log) return;
    $("#status").innerHTML = `Estado: <b>${status === "na-sala" ? "na sala" : status === "entrando" ? "entrando…" : "fora"}</b>`
        + (roomId ? ` · sala <span class=mono>${roomId.slice(0, 12)}…</span>` : "")
        + ` · senha: ${identity.password ? "sim" : "não"} · sala → 1º peer: <b>${fmtMs(firstPeerMs)}</b>`
        + `<div class=muted>Meu peer id (Trystero): <span class=mono>${esc(selfId)}</span> · log: <span class=mono>${esc(logFileName)}</span> (botão "Baixar log")</div>`;
    $("#join").textContent = room ? "Sair da sala" : "Entrar na sala";
    $("#stream").textContent = pattern ? "Parar padrão de teste" : "Transmitir padrão de teste";

    $("#relays").innerHTML = RELAY_URLS.map(url => {
        const st = relays[url] ?? "não iniciado";
        return `<tr><td class=mono>${esc(url)}</td><td class=${st === "aberto" ? "ok" : st === "conectando" ? "warn" : "err"}>${esc(st)}</td></tr>`;
    }).join("");

    const list = [...peers.values()];
    $("#peers-title").textContent = `Peers na sala (${list.length})`;
    $("#peers").innerHTML = list.length ? list.map(p => {
        const streaming = !!p.presence?.streaming;
        const isWatching = watching?.peerId === p.peerId;
        const btn = streaming
            ? (isWatching ? `<button data-stop>Parar</button>` : `<button class=positive data-watch="${esc(p.peerId)}">Assistir</button>`)
            : "<span class=muted>não transmite</span>";
        return `<tr>
            <td><b>${esc(p.presence?.username ?? p.hello?.username ?? "?")}</b><div class=muted>discord ${esc(p.presence?.discordUserId ?? p.hello?.discordUserId ?? "?")} · peer ${esc(short(p.peerId))}</div></td>
            <td>${ADMISSION_HTML[p.admission] ?? esc(p.admission)}</td>
            <td>${esc(pairLabel(p.pair))}<div class=muted>visto ${p.seenAfterMs} ms após entrar · ping ${fmtMs(p.pingMs)} · RTT ICE ${fmtMs(p.pair?.rttMs)}</div></td>
            <td style="text-align:right">${btn}</td></tr>`;
    }).join("") : "<tr><td class=muted>Ninguém ainda. Abra outra janela (lado a lado, não aba) com o mesmo guild/canal/senha.</td></tr>";

    const w = watching;
    $("#watch").hidden = !w;
    if (w) {
        const s = w.last ?? {};
        const peer = peers.get(w.peerId);
        $("#watch-title").textContent = `Assistindo ${peer?.presence?.username ?? short(w.peerId)}` + (w.ended ? ` — encerrado: ${w.ended}` : "");
        $("#watch-stats").innerHTML = grid([
            ["Assistir → ICE conectado", w.iceNote ? `${fmtMs(w.iceMs)} (já conectado)` : fmtMs(w.iceMs)],
            ["Assistir → stream (ontrack)", fmtMs(w.streamMs)],
            ["Assistir → 1º quadro decodificado", fmtMs(w.firstFrameMs)],
            ["Assistir → 1º quadro na tela", fmtMs(w.renderedMs)],
            ["Resolução", s.width ? `${s.width}x${s.height}` : "—"],
            ["FPS recebido", val(s.fps)],
            ["Bitrate vídeo", val(s.kbps, " kbps")],
            ["Bitrate áudio", val(s.audioKbps, " kbps")],
            ["RTT", val(s.rttMs, " ms")],
            ["Perda de pacotes", s.lossPct != null ? `${s.lossPct}% (${s.packetsLost})` : "—"],
            ["Jitter", val(s.jitterMs, " ms")],
            ["Quadros perdidos / travadas", `${val(s.framesDropped)} / ${val(s.freezeCount)}`],
            ["Decoder", val(s.decoder)],
            ["Conexão", pairLabel(peer?.pair)]
        ]);
    }

    $("#out").hidden = !pattern;
    if (pattern) {
        $("#out-title").textContent = `Minha transmissão → espectadores (${viewers.size})`;
        $("#out-stats").innerHTML = viewers.size ? [...viewers].map(id => {
            const o = outbound[id] ?? {};
            return `<b>${esc(peers.get(id)?.presence?.username ?? short(id))}</b>` + grid([
                ["Resolução enviada", o.width ? `${o.width}x${o.height}` : "—"],
                ["FPS enviado", val(o.fps)],
                ["Bitrate", val(o.kbps, " kbps")],
                ["RTT", val(o.rttMs, " ms")],
                ["Perda (lado dele)", val(o.remoteLossPct, "%")],
                ["Limitação", val(o.qualityLimitation)],
                ["Encoder", val(o.encoder)]
            ]);
        }).join("") : "<div class=muted>Ninguém assistindo ainda.</div>";
    }

    $("#timings").innerHTML = log.timings.slice(-12).reverse()
        .map(t => `<tr><td>${esc(t.name)}${t.note ? ` <span class=muted>(${esc(t.note)})</span>` : ""}</td><td class=mono style="text-align:right">${fmtMs(t.ms)}</td></tr>`).join("");
    $("#events").innerHTML = log.events.slice(-80).reverse()
        .map(e => `<div class=${e.level === "error" ? "err" : e.level === "warn" ? "warn" : ""}>${(e.t / 1000).toFixed(1).padStart(7)}s [${esc(e.type)}] ${esc(e.msg)}</div>`).join("");
}

// ---------------------------------------------------------------- formulario

const FIELDS = ["userId", "username", "guildId", "channelId", "password", "members"];

function readForm() {
    const f = Object.fromEntries(FIELDS.map(k => [k, $("#" + k).value]));
    identity = {
        id: f.userId.trim(),
        username: f.username.trim() || "navegador",
        guildId: f.guildId,
        channelId: f.channelId,
        password: f.password,
        members: f.members.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
        enforce: $("#enforce").checked
    };
    try { localStorage.setItem("peerlive-p2p-test", JSON.stringify({ ...f, password: undefined })); } catch { }
}

function initForm() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("peerlive-p2p-test") ?? "{}"); } catch { }
    const params = new URLSearchParams(location.search);
    const randomId = String(Math.floor(1e17 + Math.random() * 9e17));
    const defaults = { userId: randomId, username: "navegador-" + randomId.slice(-4), guildId: "", channelId: "", password: "", members: "" };
    for (const k of FIELDS) {
        // a senha nunca vem da URL nem do localStorage
        const fromUrl = k === "password" ? null : params.get(k);
        $("#" + k).value = fromUrl ?? (k === "password" ? "" : saved[k]) ?? defaults[k];
    }
    // ID aleatorio por janela, a menos que venha da URL (duas janelas = dois usuarios)
    if (!params.get("userId")) {
        $("#userId").value = randomId;
        if (!params.get("username")) $("#username").value = defaults.username;
    }
}

$("#join").addEventListener("click", async () => {
    if (room) return leave("botão");
    readForm();
    if (!identity.channelId.trim()) return alert("Informe o channelId (qualquer texto serve para teste; para falar com o Discord use o ID real do canal de voz).");
    await join();
});
$("#stream").addEventListener("click", () => {
    readForm();
    if (pattern) stopTestStream();
    else startTestStream();
});
$("#download").addEventListener("click", downloadLog);
$("#members").addEventListener("change", () => {
    readForm();
    reevaluateAdmission();
});
$("#peers").addEventListener("click", e => {
    const target = e.target.closest("button");
    if (!target) return;
    if (target.dataset.watch) watch(target.dataset.watch);
    else if ("stop" in target.dataset) stopWatching();
});
$("#stop-watch").addEventListener("click", stopWatching);
setInterval(() => { $("#clock").textContent = formatClock(); }, 31);
document.addEventListener("securitypolicyviolation", e => logEvent("error", "csp", `CSP bloqueou ${e.blockedURI}`));

initForm();
readForm();
newLog({ app: "browser", page: "tools/p2p-test", trystero: TRYSTERO_VERSION, userAgent: navigator.userAgent, discordUserId: identity.id, username: identity.username });
logEvent("info", "pagina", `Trystero ${TRYSTERO_VERSION} carregado do CDN · selfId ${selfId}`);
tickTimer = setInterval(tick, 1000);

// para automacao/inspecao pelo console
window.peerlive = {
    state: () => ({ status, roomId, firstPeerMs, selfId, peers: [...peers.values()], relays: { ...relays }, streaming: !!pattern, viewers: [...viewers], watching }),
    log: () => log,
    join: async opts => {
        for (const [k, v] of Object.entries(opts ?? {})) if ($("#" + k)) $("#" + k).value = v;
        readForm();
        await join();
    },
    leave: () => leave("console"),
    getPeers: () => room?.getPeers() ?? {},
    startTestStream,
    stopTestStream,
    watch,
    stopWatching
};
