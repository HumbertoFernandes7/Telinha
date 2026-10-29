/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Amigo virtual" do PeerLive: pagina fora do Discord que fala EXATAMENTE o protocolo P2P v1
// do plugin src/plugins/peerLive (mesmo app id, sala, senha, relays, acoes e mensagens), entao
// uma aba aqui e um Discord com o plugin se enxergam se o guildId/channelId digitados forem os
// do canal de voz. Serve para testar o plugin sem uma segunda pessoa: esta pagina transmite
// (padrao de teste ou tela/aba) e assiste a transmissao do plugin.

import { getRelaySockets, joinRoom, selfId } from "https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm";

// ============================================================================
// PROTOCOLO v1 — COPIA de src/plugins/peerLive/protocol.ts.
// AS DUAS COPIAS PRECISAM FICAR EM SINCRONIA (app id, derivacao da sala, relays, ICE,
// nomes das acoes, formato das mensagens, versao, metadado do stream). Mudou la, mude aqui.
//
//   handshake  { type: "peerlive-hello", v: 1, discordUserId, username }
//   "presence" { v: 1, discordUserId, username, streaming, stream?: { kind: "screen" | "window",
//                title, hasAudio, width, height, fps }, caps: { h264HwDecode } }
//   "watch"    { op: "start" | "stop" }   (espectador -> transmissor)
//   stream     room.addStream(stream, { target, metadata: { kind: "peerlive-screen" } })
//              (API do Trystero 0.26: o alvo e o metadado vao num objeto de opcoes)
// ============================================================================
const PROTOCOL_VERSION = 1;
const APP_ID = "peerlive-v1";
const ROOM_PREFIX = "peerlive-v1";
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
const STREAM_METADATA_KIND = "peerlive-screen";
// Parametros de envio aplicados a cada espectador (iguais aos do plugin).
const MAX_BITRATE_BPS = 8_000_000;
const MAX_FPS = 60;

async function deriveRoomId(guildId, voiceChannelId) {
    const input = `${ROOM_PREFIX}|${guildId ?? "dm"}|${voiceChannelId}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
const isHelloMessage = d => !!d && typeof d === "object" && d.type === HELLO_TYPE && typeof d.discordUserId === "string";
const isPresenceMessage = d => !!d && typeof d === "object" && d.v === PROTOCOL_VERSION && typeof d.discordUserId === "string" && typeof d.streaming === "boolean";
const isWatchMessage = d => !!d && typeof d === "object" && (d.op === "start" || d.op === "stop");
// ============================================================================

const TRYSTERO_VERSION = "0.26.0";
const PATTERN_W = 1920;
const PATTERN_H = 1080;
const PATTERN_FPS = 60;
const PATTERN_TITLE = "Padrão de teste";
const LOG_PREFIX = "[PeerLive peer]";
const READY_STATES = ["conectando", "aberto", "fechando", "fechado"];
const short = id => String(id).slice(0, 6);
const host = url => url.replace(/^wss:\/\//, "");
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const fmtMs = n => (n == null ? "—" : `${Math.round(n)} ms`);
const val = (n, suffix = "") => (n == null || n === "" ? "—" : `${n}${suffix}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yesNo = b => (b ? "sim" : "não");

// ---------------------------------------------------------------- stats

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
// Nunca devolve enderecos IP: so tipo de candidato, protocolo e familia.
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

// Codec negociado de um RTP (mimeType + parametros fmtp, ex.: video/H264 + profile-level-id).
function codecOf(report, rtp) {
    const c = rtp?.codecId ? report.get(rtp.codecId) : undefined;
    if (!c) return {};
    const profile = /profile-level-id=([0-9a-f]+)/i.exec(c.sdpFmtpLine ?? "");
    return { codec: String(c.mimeType ?? "").replace(/^video\//i, "") || undefined, codecProfile: profile?.[1] };
}

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
            out.powerEfficientDecoder = video.powerEfficientDecoder;
            Object.assign(out, codecOf(report, video));
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
            out.powerEfficientEncoder = video.powerEfficientEncoder;
            Object.assign(out, codecOf(report, video));
        }
        if (remoteIn && typeof remoteIn.fractionLost === "number") out.remoteLossPct = round(remoteIn.fractionLost * 100, 2);
        return out;
    }
}

// ---------------------------------------------------------------- capacidades (caps.h264HwDecode)

// Mesma consulta que o plugin deve fazer: decodificacao WebRTC de H.264 1080p60 8 Mbps eficiente
// em energia = decodificador de hardware. false em qualquer erro.
async function detectH264HwDecode() {
    try {
        const info = await navigator.mediaCapabilities.decodingInfo({
            type: "webrtc",
            video: { contentType: "video/h264", width: 1920, height: 1080, bitrate: 8e6, framerate: 60 }
        });
        return { value: info.powerEfficient === true, supported: info.supported, smooth: info.smooth, powerEfficient: info.powerEfficient };
    } catch (e) {
        return { value: false, error: String(e) };
    }
}

// ---------------------------------------------------------------- padrao de teste (1920x1080 @ 60 fps)

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

// Fonte "padrao de teste": canvas 1920x1080 a 60 fps com padrao em movimento, relogio grande
// (ms) e contador de quadros, mais um tom baixo de 220 Hz como trilha de audio.
function createTestPatternSource(label) {
    const W = PATTERN_W, H = PATTERN_H;
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
        const offset = (t * 360) % barW;
        for (let i = -1; i < 9; i++) {
            ctx.fillStyle = `hsl(${(i * 45 + t * 30) % 360} 70% 32%)`;
            ctx.fillRect(i * barW + offset, 0, barW + 1, H);
        }
        const bx = (Math.sin(t * 1.7) * 0.5 + 0.5) * (W - 180);
        const by = Math.abs(Math.sin(t * 2.3)) * (H - 180);
        ctx.fillStyle = "#fff";
        ctx.fillRect(bx, by, 180, 180);
        ctx.save();
        ctx.translate(W - 160, 180);
        ctx.rotate(t * Math.PI * 2);
        ctx.fillStyle = "#ffeb3b";
        ctx.fillRect(-6, -130, 12, 130);
        ctx.restore();
        ctx.fillStyle = "rgba(0,0,0,0.78)";
        ctx.fillRect(0, H / 2 - 170, W, 340);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 220px Consolas, 'Courier New', monospace";
        ctx.fillText(formatClock(), W / 2, H / 2 - 40);
        ctx.font = "bold 72px Consolas, 'Courier New', monospace";
        ctx.fillText(`quadro ${frame}`, W / 2, H / 2 + 110);
        ctx.font = "bold 36px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(0, 0, W, 64);
        ctx.fillStyle = "#fff";
        ctx.fillText(`PeerLive · padrão de teste ${W}x${H} @ ${PATTERN_FPS} fps · ${label}`, 20, 14);
    };
    draw();
    const stopTicker = startTicker(PATTERN_FPS, draw);
    const stream = canvas.captureStream(PATTERN_FPS);
    let audioCtx = null;
    try {
        audioCtx = new AudioContext();
        audioCtx.resume().catch(() => { });
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
        type: "pattern",
        stream,
        preview: canvas,
        info: { kind: "screen", title: PATTERN_TITLE, hasAudio: stream.getAudioTracks().length > 0, width: W, height: H, fps: PATTERN_FPS },
        stop() {
            stopTicker();
            stream.getTracks().forEach(track => track.stop());
            audioCtx?.close().catch(() => { });
        }
    };
}

// Fonte "tela/aba do navegador" via getDisplayMedia (com audio, se o navegador/usuario oferecer).
async function createDisplaySource() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: MAX_FPS } }, audio: true });
    const [vt] = stream.getVideoTracks();
    const s = vt?.getSettings?.() ?? {};
    // "monitor" -> tela inteira; "window" e "browser" (aba) -> janela
    const kind = s.displaySurface === "window" || s.displaySurface === "browser" || s.displaySurface === "application" ? "window" : "screen";
    const rawLabel = vt?.label ?? "";
    const fallbackTitle = s.displaySurface === "browser" ? "Aba do navegador" : kind === "window" ? "Janela" : "Tela inteira";
    const title = !rawLabel || /^(screen|window|web-contents-media-stream):/i.test(rawLabel) ? fallbackTitle : rawLabel;
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch(() => { });
    const src = {
        type: "display",
        stream,
        preview: video,
        info: {
            kind,
            title,
            hasAudio: stream.getAudioTracks().length > 0,
            width: Math.round(s.width ?? 0),
            height: Math.round(s.height ?? 0),
            fps: Math.round(s.frameRate ?? 30)
        },
        stop() {
            stream.getTracks().forEach(track => track.stop());
            video.srcObject = null;
        }
    };
    // O tamanho real so aparece depois do primeiro quadro; corrige a presenca se divergir.
    video.addEventListener("resize", () => {
        if (source !== src || !video.videoWidth) return;
        if (video.videoWidth !== src.info.width || video.videoHeight !== src.info.height) {
            src.info.width = video.videoWidth;
            src.info.height = video.videoHeight;
            broadcastPresence();
            render();
        }
    });
    vt?.addEventListener("ended", () => {
        if (source === src) stopStreaming("o navegador encerrou o compartilhamento");
    });
    return src;
}

// ---------------------------------------------------------------- diagnostico (mesmo formato do spike)

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
    logFileName = `peerlive-peer-${now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "")}.json`;
    log = {
        tool: "PeerLive peer (amigo virtual)",
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

const MAX_EVENTS = 20000;
function logEvent(level, type, msg, data) {
    const cleanMsg = scrubIps(msg);
    const ev = { t: since(), at: new Date().toISOString(), level, type, msg: cleanMsg };
    if (data !== undefined) ev.data = scrubData(data);
    log.events.push(ev);
    if (log.events.length > MAX_EVENTS) log.events.splice(0, log.events.length - MAX_EVENTS);
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
// O Trystero tenta reconectar sem parar com um peer recusado no handshake (dezenas de vezes por
// segundo). Loga a primeira ocorrencia por chave e depois no maximo uma a cada 10 s, com a contagem.
const repeating = new Map();
function logRepeating(key, level, type, msg, data) {
    const now = performance.now();
    const r = repeating.get(key) ?? { lastAt: -Infinity, suppressed: 0 };
    repeating.set(key, r);
    if (now - r.lastAt < 10000) {
        r.suppressed++;
        return;
    }
    const extra = r.suppressed ? ` (+${r.suppressed} tentativas repetidas omitidas)` : "";
    r.lastAt = now;
    r.suppressed = 0;
    logEvent(level, type, msg + extra, data);
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

// ---------------------------------------------------------------- sessao

let room = null;
let presenceAction = null;
let watchAction = null;
let status = "fora";
let roomId = null;
let joinedAt = 0;
let firstPeerMs = null;
let identity = { id: "", username: "", guildId: "", channelId: "", password: "", members: [], enforce: false, h264: false };
let capsReady = null;
let capsInfo = null;

const peers = new Map();
const helloByPeer = new Map();
const relays = {};
const relayFirstOpen = new Set();
let source = null; // fonte da minha transmissao: { type, stream, preview, info, stop }
const viewers = new Set(); // peers que pediram para assistir a mim
const outbound = {};
const outSamplers = new Map();
const watches = new Map(); // peerId -> assistindo (um card/video por peer)
let tickTimer = null;
let tickCount = 0;

const selfHello = () => ({ type: HELLO_TYPE, v: PROTOCOL_VERSION, discordUserId: identity.id, username: identity.username });
function selfPresence() {
    const msg = {
        v: PROTOCOL_VERSION,
        discordUserId: identity.id,
        username: identity.username,
        streaming: !!source,
        caps: { h264HwDecode: identity.h264 }
    };
    if (source) msg.stream = { ...source.info };
    return msg;
}
// Envia a presenca atual para todos (mudanca) ou so para um peer (peer novo).
function sendPresence(target) {
    const action = presenceAction;
    if (!action) return;
    const p = target ? action.send(selfPresence(), { target }) : action.send(selfPresence());
    Promise.resolve(p).catch(e => logEvent("error", "presenca", "Falha ao enviar presença: " + e));
}
const broadcastPresence = () => sendPresence();

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
    await capsReady;
    readForm();
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
                logRepeating(`join-${d.peerId}`, "error", "join", `Falha com peer ${peerName(d.peerId)}: ${d.error}${hint}`, { peerId: d.peerId, error: d.error });
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
    tick();
    render();
}

async function leave(reason) {
    const r = room;
    if (!r) return;
    room = null;
    presenceAction = watchAction = null;
    logEvent("info", "sala", `Saindo da sala (${reason})`);
    for (const peerId of [...watches.keys()]) removeWatch(peerId, false);
    viewers.clear();
    outSamplers.clear();
    for (const k of Object.keys(outbound)) delete outbound[k];
    peers.clear();
    helloByPeer.clear();
    status = "fora";
    render();
    try { await r.leave(); } catch (e) { logEvent("error", "sala", "Erro ao sair da sala: " + e); }
}

// Handshake v1: troca "peerlive-hello"; so aceita peers com v === 1. Quem nao fala v1 e recusado.
async function handshake(peerId, send, receive) {
    const t = performance.now();
    await send(selfHello());
    const { data } = await receive();
    if (!isHelloMessage(data)) {
        logRepeating(`hs-${peerId}`, "warn", "admissao", `Peer ${short(peerId)} mandou handshake inválido (outro app ou protocolo antigo?) — recusado`);
        throw new Error("handshake inválido");
    }
    if (data.v !== PROTOCOL_VERSION) {
        logRepeating(`hs-${peerId}`, "warn", "admissao", `Peer ${short(peerId)} usa protocolo v${data.v}, eu uso v${PROTOCOL_VERSION} — recusado`);
        throw new Error(`protocolo v${data.v} não suportado`);
    }
    helloByPeer.set(peerId, data);
    const adm = checkAdmission(data.discordUserId);
    const who = `${data.username} (discord ${data.discordUserId}, peer ${short(peerId)})`;
    if (adm === "ok" || adm === "sem-verificacao") {
        logEvent("info", "admissao", `Handshake ok com ${who} em ${Math.round(performance.now() - t)} ms — admissão: ${adm}`);
    } else {
        logRepeating(`hs-${peerId}`, "warn", "admissao", `${identity.enforce ? "REJEITADO" : "ACEITO MAS MARCADO"}: ${who} — ${adm === "fora-do-canal" ? "NÃO está na lista simulada do canal" : adm}`);
        if (identity.enforce) throw new Error(`peer fora do canal de voz (${adm})`);
    }
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
    sendPresence(peerId);
    inspectConnection(peerId, "peer-entrou");
    pingPeer(peerId, true);
    render();
}

function pingPeer(peerId, announce) {
    room?.ping(peerId).then(ms => {
        const cur = peers.get(peerId);
        if (!cur) return;
        cur.pingMs = Math.round(ms);
        if (announce) logEvent("info", "peer", `Ping (canal de dados) com ${peerName(peerId)}: ${cur.pingMs} ms`);
    }).catch(() => { });
}

function onPeerLeave(peerId) {
    logEvent("info", "peer", `Peer ${peerName(peerId)} saiu`);
    peers.delete(peerId);
    helloByPeer.delete(peerId);
    viewers.delete(peerId);
    outSamplers.delete(peerId);
    delete outbound[peerId];
    const w = watches.get(peerId);
    if (w && !w.ended) endWatch(w, "o peer saiu da sala");
    render();
}

function onPresence(data, { peerId }) {
    if (!isPresenceMessage(data)) return logEvent("warn", "presenca", `Presença inválida de ${short(peerId)} (v diferente de ${PROTOCOL_VERSION}?)`, data);
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
            `${data.username} (discord ${data.discordUserId}) — admissão: ${p.admission} — transmitindo: ${yesNo(data.streaming)} — H.264 HW: ${yesNo(data.caps?.h264HwDecode)}`, data);
    } else if (prev.streaming !== data.streaming) {
        logEvent("info", "presenca", `${data.username} ${data.streaming ? "começou" : "parou"} de transmitir${data.stream ? ` (${describeStream(data.stream)})` : ""}`, data.stream);
    } else if (prev.caps?.h264HwDecode !== data.caps?.h264HwDecode) {
        logEvent("info", "presenca", `${data.username}: H.264 HW mudou para ${yesNo(data.caps?.h264HwDecode)}`);
    }
    const w = watches.get(peerId);
    if (!data.streaming && w && !w.ended) endWatch(w, "a transmissão foi encerrada pelo peer");
    render();
}

function describeStream(s) {
    if (!s) return "—";
    return `${s.kind} “${s.title}” ${s.width}x${s.height}@${s.fps} · áudio ${yesNo(s.hasAudio)}`;
}

// ---- lado transmissor: espectador pede "watch start/stop"

function onWatch(data, { peerId }) {
    const r = room;
    if (!r || !isWatchMessage(data)) return;
    if (data.op === "start") {
        if (!source) {
            logEvent("warn", "midia", `${peerName(peerId)} pediu para assistir, mas não estou transmitindo`);
            sendPresence(peerId);
            return;
        }
        if (viewers.has(peerId)) {
            logEvent("warn", "midia", `${peerName(peerId)} pediu para assistir de novo; já estou enviando (ignorado)`);
            return;
        }
        viewers.add(peerId);
        outSamplers.set(peerId, new StatsSampler());
        logEvent("info", "midia", `Enviando “${source.info.title}” para ${peerName(peerId)}`);
        const { stream } = source;
        Promise.all([].concat(r.addStream(stream, { target: peerId, metadata: { kind: STREAM_METADATA_KIND } })))
            .then(() => applySenderParams(peerId, stream))
            .catch(e => logEvent("error", "midia", `Falha ao adicionar stream para ${peerName(peerId)}: ${e}`));
    } else {
        if (viewers.delete(peerId) && source) {
            try { r.removeStream(source.stream, { target: peerId }); } catch (e) { logEvent("error", "midia", "Falha ao remover stream: " + e); }
        }
        outSamplers.delete(peerId);
        delete outbound[peerId];
        logEvent("info", "midia", `${peerName(peerId)} parou de assistir`);
    }
    render();
}

/**
 * Parametros de envio por espectador: contentHint="motion" (na trilha, ja aplicado ao criar a
 * fonte), teto do encoder em MAX_BITRATE_BPS e MAX_FPS. O Chromium limita o video a ~2,5 Mbps
 * por padrao; o controle de congestionamento continua valendo. setParameters pode falhar logo
 * depois do addTrack (negociacao ainda em andamento), entao tenta algumas vezes.
 */
async function applySenderParams(peerId, stream) {
    let lastError = "sem RTCRtpSender de vídeo";
    for (let attempt = 1; attempt <= 6; attempt++) {
        const pc = room?.getPeers()[peerId];
        if (!pc || !viewers.has(peerId)) return;
        const tracks = stream.getVideoTracks();
        const senders = pc.getSenders().filter(s => s.track && tracks.includes(s.track));
        if (senders.length) {
            try {
                for (const sender of senders) {
                    const params = sender.getParameters();
                    if (!params.encodings?.length) params.encodings = [{}];
                    params.encodings[0].maxBitrate = MAX_BITRATE_BPS;
                    params.encodings[0].maxFramerate = MAX_FPS;
                    await sender.setParameters(params);
                }
                const hint = tracks[0]?.contentHint;
                logEvent("info", "midia", `Parâmetros de envio para ${peerName(peerId)}: contentHint=${hint || "—"}, ${MAX_BITRATE_BPS / 1000} kbps, ${MAX_FPS} fps`);
                return;
            } catch (e) {
                lastError = String(e);
            }
        }
        await sleep(300 * attempt);
    }
    logEvent("warn", "midia", `Parâmetros de envio NÃO aplicados para ${peerName(peerId)}: ${lastError}`);
}

function setStream(src) {
    if (source) stopStreaming("trocando a fonte"); // espectadores veem streaming:false e depois true; precisam pedir "Assistir" de novo
    source = src;
    const [vt] = src.stream.getVideoTracks();
    if (vt) vt.contentHint = "motion";
    $("#preview").replaceChildren(src.preview);
    logEvent("info", "midia", `Transmitindo: ${describeStream(src.info)}. Espectadores pedem com "Assistir".`);
    broadcastPresence();
    render();
}

function startPatternStream() {
    if (source?.type === "pattern") return;
    readForm();
    setStream(createTestPatternSource(identity.username));
}

async function startDisplayStream() {
    readForm();
    let src;
    try {
        src = await createDisplaySource();
    } catch (e) {
        logEvent("warn", "midia", `Compartilhamento de tela cancelado/indisponível: ${e?.name ?? ""} ${e?.message ?? e}`.trim());
        return;
    }
    setStream(src);
}

// Para a transmissao: presenca streaming:false, remove o stream de todos os espectadores e so
// entao para as trilhas.
function stopStreaming(reason) {
    if (!source) return;
    const s = source;
    source = null;
    broadcastPresence();
    if (room && viewers.size) {
        try { room.removeStream(s.stream, { target: [...viewers] }); } catch (e) { logEvent("error", "midia", "Falha ao remover stream: " + e); }
    }
    viewers.clear();
    outSamplers.clear();
    for (const k of Object.keys(outbound)) delete outbound[k];
    s.stop();
    $("#preview").replaceChildren();
    logEvent("info", "midia", `Transmissão encerrada (${reason})`);
    render();
}

// ---- lado espectador: "Assistir" -> watch start; stream chega em onPeerStream

function onPeerStream(stream, peerId, metadata) {
    const w = watches.get(peerId);
    if (!w || w.ended) {
        logEvent("warn", "midia", `Stream recebido de ${peerName(peerId)} sem ter pedido (ignorado)`);
        return;
    }
    if (metadata?.kind !== STREAM_METADATA_KIND) logEvent("warn", "midia", `Stream de ${peerName(peerId)} com metadado inesperado: ${JSON.stringify(metadata)}`);
    w.stream = stream;
    w.streamMs = performance.now() - w.requestedAt;
    stream.addEventListener("removetrack", () => logEvent("info", "midia", `Trilha removida do stream de ${peerName(peerId)}`));
    stream.getTracks().forEach(track => {
        track.addEventListener("mute", () => logEvent("info", "midia", `Trilha ${track.kind} de ${peerName(peerId)} sem dados (mute)`));
        track.addEventListener("unmute", () => logEvent("info", "midia", `Trilha ${track.kind} de ${peerName(peerId)} voltou a receber dados`));
        track.addEventListener("ended", () => logEvent("info", "midia", `Trilha ${track.kind} de ${peerName(peerId)} encerrada`));
    });
    recordTiming("Assistir → stream recebido (ontrack)", w.streamMs, peerId, `${stream.getVideoTracks().length} vídeo, ${stream.getAudioTracks().length} áudio`);
    attachVideo(w);
    render();
}

function watch(peerId) {
    const r = room;
    if (!r) return;
    if (watches.has(peerId)) removeWatch(peerId, true);
    const w = { peerId, requestedAt: performance.now(), stream: null, sampler: new StatsSampler(), poll: null };
    makeCard(w);
    watches.set(peerId, w);
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
    render();
}

function stopWatching(peerId) {
    removeWatch(peerId, true);
    render();
}

function endWatch(w, why) {
    w.ended = why;
    stopFirstFramePoll(w);
    logEvent("info", "midia", `Transmissão de ${peerName(w.peerId)} encerrada: ${why}`);
}

function removeWatch(peerId, notify) {
    const w = watches.get(peerId);
    if (!w) return;
    watches.delete(peerId);
    stopFirstFramePoll(w);
    w.card.video.srcObject = null;
    w.card.el.remove();
    if (notify && !w.ended) watchAction?.send({ op: "stop" }, { target: peerId }).catch(() => { });
    logEvent("info", "midia", `Parou de assistir ${peerName(peerId)}`);
}

function makeCard(w) {
    const el = document.createElement("div");
    el.className = "watch-card";
    el.innerHTML = `<h3 data-title></h3><video autoplay playsinline controls></video>
        <div data-stats></div>
        <div><button class="secondary" data-stop>Parar</button></div>`;
    el.querySelector("[data-stop]").addEventListener("click", () => stopWatching(w.peerId));
    $("#watches").append(el);
    w.card = { el, video: el.querySelector("video"), title: el.querySelector("[data-title]"), stats: el.querySelector("[data-stats]") };
}

async function playVideo(video) {
    try {
        await video.play();
    } catch (e) {
        // autoplay com som bloqueado: toca mudo (o usuario liga o som nos controles do video)
        if (e?.name !== "NotAllowedError") return;
        video.muted = true;
        logEvent("warn", "midia", "Autoplay com som bloqueado pelo navegador; vídeo iniciado mudo (use os controles para ligar o som)");
        video.play().catch(() => { });
    }
}

function attachVideo(w) {
    const video = w.card.video;
    video.srcObject = w.stream;
    playVideo(video);
    const onFrame = () => {
        if (watches.get(w.peerId) !== w || w.renderedMs != null) return;
        w.renderedMs = performance.now() - w.requestedAt;
        recordTiming("Assistir → primeiro quadro na tela", w.renderedMs, w.peerId);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
    else video.addEventListener("loadeddata", onFrame, { once: true });
}

function startFirstFramePoll(w) {
    stopFirstFramePoll(w);
    w.poll = setInterval(async () => {
        if (watches.get(w.peerId) !== w) return stopFirstFramePoll(w);
        if (performance.now() - w.requestedAt > 30000) {
            stopFirstFramePoll(w);
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
            if (decoded > 0 && watches.get(w.peerId) === w && w.firstFrameMs == null) {
                w.firstFrameMs = performance.now() - w.requestedAt;
                stopFirstFramePoll(w);
                recordTiming("Assistir → primeiro quadro decodificado", w.firstFrameMs, w.peerId);
            }
        } catch { }
    }, 100);
}
function stopFirstFramePoll(w) {
    if (w.poll) clearInterval(w.poll);
    w.poll = null;
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
    for (const w of watches.values()) {
        const pc = pcs[w.peerId];
        if (w.ended || !pc) continue;
        pc.getStats().then(report => {
            if (watches.get(w.peerId) !== w) return;
            w.last = w.sampler.inbound(report);
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
    if (tickCount % 10 === 0) for (const peerId of peers.keys()) pingPeer(peerId, false);
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

const codecLabel = s => (s.codec ? `${s.codec}${s.codecProfile ? ` (${s.codecProfile})` : ""}` : "—");

function renderNow() {
    if (!log) return;
    $("#status").innerHTML = `Estado: <b>${status === "na-sala" ? "na sala" : status === "entrando" ? "entrando…" : "fora"}</b>`
        + (roomId ? ` · sala <span class=mono>${roomId.slice(0, 12)}…</span>` : "")
        + ` · senha: ${identity.password ? "sim" : "não"} · sala → 1º peer: <b>${fmtMs(firstPeerMs)}</b>`
        + `<div class=muted>Meu peer id (Trystero): <span class=mono>${esc(selfId)}</span> · log: <span class=mono>${esc(logFileName)}</span> (botão "Baixar log")</div>`;
    $("#join").textContent = room ? "Sair da sala" : "Entrar na sala";
    $("#stream-pattern").disabled = source?.type === "pattern";
    $("#stream-stop").hidden = !source;

    $("#relays").innerHTML = RELAY_URLS.map(url => {
        const st = relays[url] ?? "não iniciado";
        return `<tr><td class=mono>${esc(url)}</td><td class=${st === "aberto" ? "ok" : st === "conectando" ? "warn" : "err"}>${esc(st)}</td></tr>`;
    }).join("");

    const list = [...peers.values()];
    $("#peers-title").textContent = `Peers na sala (${list.length})`;
    $("#peers").innerHTML = list.length ? list.map(p => {
        const pres = p.presence;
        const streaming = !!pres?.streaming;
        const w = watches.get(p.peerId);
        const isWatching = !!w && !w.ended;
        const btn = streaming
            ? (isWatching ? `<button data-stop="${esc(p.peerId)}">Parar</button>` : `<button class=positive data-watch="${esc(p.peerId)}">Assistir</button>`)
            : "<span class=muted>não transmite</span>";
        const streamInfo = streaming
            ? `<div><b class=ok>● transmitindo</b> <span class=mono>${esc(describeStream(pres.stream))}</span></div>`
            : "";
        const caps = pres ? `H.264 HW: ${yesNo(pres.caps?.h264HwDecode)}` : "";
        return `<tr>
            <td><b>${esc(pres?.username ?? p.hello?.username ?? "?")}</b><div class=muted>discord ${esc(pres?.discordUserId ?? p.hello?.discordUserId ?? "?")} · peer ${esc(short(p.peerId))}${caps ? ` · ${esc(caps)}` : ""}</div>${streamInfo}</td>
            <td>${ADMISSION_HTML[p.admission] ?? esc(p.admission)}</td>
            <td>${esc(pairLabel(p.pair))}<div class=muted>visto ${p.seenAfterMs} ms após entrar · ping ${fmtMs(p.pingMs)} · RTT ICE ${fmtMs(p.pair?.rttMs)}</div></td>
            <td style="text-align:right">${btn}</td></tr>`;
    }).join("") : "<tr><td class=muted>Ninguém ainda. Entre na sala com o mesmo guildId/canal/senha do Discord (ou de outra janela deste teste, lado a lado).</td></tr>";

    $("#watch").hidden = !watches.size;
    $("#watch-title").textContent = `Assistindo (${watches.size})`;
    for (const w of watches.values()) {
        const s = w.last ?? {};
        const peer = peers.get(w.peerId);
        w.card.title.textContent = `${peer?.presence?.username ?? short(w.peerId)}` + (w.ended ? ` — encerrado: ${w.ended}` : "");
        w.card.stats.innerHTML = grid([
            ["Resolução", s.width ? `${s.width}x${s.height}` : "—"],
            ["FPS recebido", val(s.fps)],
            ["Bitrate vídeo", val(s.kbps, " kbps")],
            ["Codec", codecLabel(s)],
            ["Assistir → 1º quadro decodificado", fmtMs(w.firstFrameMs)],
            ["Assistir → 1º quadro na tela", fmtMs(w.renderedMs)],
            ["Assistir → stream (ontrack)", fmtMs(w.streamMs)],
            ["Assistir → ICE conectado", w.iceNote ? `${fmtMs(w.iceMs)} (já conectado)` : fmtMs(w.iceMs)],
            ["Decoder", s.decoder ? `${s.decoder}${s.powerEfficientDecoder != null ? ` (${s.powerEfficientDecoder ? "eficiente/HW" : "software"})` : ""}` : "—"],
            ["Bitrate áudio", val(s.audioKbps, " kbps")],
            ["RTT", val(s.rttMs, " ms")],
            ["Perda de pacotes", s.lossPct != null ? `${s.lossPct}% (${s.packetsLost})` : "—"],
            ["Jitter", val(s.jitterMs, " ms")],
            ["Quadros perdidos / travadas", `${val(s.framesDropped)} / ${val(s.freezeCount)}`],
            ["Conexão", pairLabel(peer?.pair)]
        ]);
    }

    $("#out").hidden = !source;
    if (source) {
        $("#out-title").textContent = `Minha transmissão (${source.info.title}) → espectadores (${viewers.size})`;
        $("#out-stats").innerHTML = viewers.size ? [...viewers].map(id => {
            const o = outbound[id] ?? {};
            return `<b>${esc(peers.get(id)?.presence?.username ?? short(id))}</b>` + grid([
                ["Resolução enviada", o.width ? `${o.width}x${o.height}` : "—"],
                ["FPS enviado", val(o.fps)],
                ["Bitrate", val(o.kbps, " kbps")],
                ["Codec", codecLabel(o)],
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

// campo do formulario -> parametros de URL aceitos (o primeiro e o "oficial")
const FIELDS = {
    userId: ["user", "userId"],
    username: ["name", "username"],
    guildId: ["guild", "guildId"],
    channelId: ["channel", "channelId"],
    password: ["password", "pass"],
    members: ["members"]
};
const STORE_KEY = "peerlive-peer-v1";

function readForm() {
    const f = Object.fromEntries(Object.keys(FIELDS).map(k => [k, $("#" + k).value]));
    identity = {
        id: f.userId.trim(),
        username: f.username.trim() || "Amigo virtual",
        guildId: f.guildId,
        channelId: f.channelId,
        password: f.password,
        members: f.members.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
        enforce: $("#enforce").checked,
        h264: $("#h264").checked
    };
    // a senha nunca vai para o localStorage; o ID falso e por aba (sessionStorage), os demais sao "ultimo usado"
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ username: f.username, guildId: f.guildId, channelId: f.channelId, members: f.members })); } catch { }
    try { sessionStorage.setItem(STORE_KEY, f.userId); } catch { }
}

function initForm(params) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}"); } catch { }
    let sessionId = null;
    try { sessionId = sessionStorage.getItem(STORE_KEY); } catch { }
    const randomId = String(Math.floor(1e17 + Math.random() * 9e17));
    const defaults = { userId: sessionId || randomId, username: "Amigo virtual", guildId: "", channelId: "", password: "", members: "" };
    for (const [k, names] of Object.entries(FIELDS)) {
        const fromUrl = names.map(n => params.get(n)).find(v => v != null);
        // o ID falso nao vem do "ultimo usado": duas janelas = dois usuarios distintos
        const fromSaved = k === "userId" || k === "password" ? undefined : saved[k];
        $("#" + k).value = fromUrl ?? fromSaved ?? defaults[k];
    }
}

function setCapsUi(info) {
    capsInfo = info;
    $("#h264").checked = info.value;
    $("#h264").disabled = false;
    $("#h264-detected").textContent = info.error ? `${yesNo(false)} (erro: ${info.error})` : `${yesNo(info.value)}`;
}

$("#join").addEventListener("click", async () => {
    if (room) return leave("botão");
    readForm();
    if (!identity.channelId.trim()) return alert("Informe o channelId do canal de voz (para falar com o Discord use o ID real; para testar duas janelas, qualquer texto igual nas duas).");
    await join();
});
$("#stream-pattern").addEventListener("click", startPatternStream);
$("#stream-display").addEventListener("click", startDisplayStream);
$("#stream-stop").addEventListener("click", () => stopStreaming("botão"));
$("#download").addEventListener("click", downloadLog);
$("#members").addEventListener("change", () => {
    readForm();
    reevaluateAdmission();
});
$("#username").addEventListener("change", () => {
    readForm();
    broadcastPresence();
});
$("#h264").addEventListener("change", () => {
    readForm();
    logEvent("info", "caps", `caps.h264HwDecode anunciado: ${yesNo(identity.h264)}${capsInfo && identity.h264 !== capsInfo.value ? " (sobrescrito; o detectado é " + yesNo(capsInfo.value) + ")" : ""}`);
    broadcastPresence();
});
$("#h264-reset").addEventListener("click", () => {
    if (!capsInfo) return;
    $("#h264").checked = capsInfo.value;
    $("#h264").dispatchEvent(new Event("change"));
});
$("#peers").addEventListener("click", e => {
    const target = e.target.closest("button");
    if (!target) return;
    if (target.dataset.watch) watch(target.dataset.watch);
    else if (target.dataset.stop) stopWatching(target.dataset.stop);
});
document.addEventListener("securitypolicyviolation", e => logEvent("error", "csp", `CSP bloqueou ${e.blockedURI}`));

const urlParams = new URLSearchParams(location.search);
initForm(urlParams);
readForm();
newLog({ app: "browser", page: "tools/peerlive-peer", trystero: TRYSTERO_VERSION, userAgent: navigator.userAgent, discordUserId: identity.id, username: identity.username });
logEvent("info", "pagina", `Protocolo v${PROTOCOL_VERSION} · appId ${APP_ID} · Trystero ${TRYSTERO_VERSION} carregado do CDN · selfId ${selfId}`);
tickTimer = setInterval(tick, 1000);

capsReady = detectH264HwDecode().then(info => {
    setCapsUi(info);
    readForm();
    logEvent("info", "caps", `h264HwDecode detectado: ${yesNo(info.value)}`, info);
});

// atalhos de URL para automacao: ?autojoin=1 entra na sala sozinho; ?autostream=1 (ou "pattern") transmite o padrao
if (urlParams.get("autojoin") === "1") {
    if (identity.channelId.trim()) join();
    else logEvent("warn", "pagina", "autojoin ignorado: informe o channelId (?channel=...)");
}
if (["1", "pattern"].includes(urlParams.get("autostream"))) capsReady.then(startPatternStream);

// para automacao/inspecao pelo console
window.peerlive = {
    state: () => ({
        status,
        roomId,
        firstPeerMs,
        selfId,
        identity: { ...identity, password: undefined },
        peers: [...peers.values()],
        relays: { ...relays },
        streaming: source ? { type: source.type, ...source.info } : null,
        viewers: [...viewers],
        outbound: { ...outbound },
        watching: [...watches.values()].map(w => ({
            peerId: w.peerId, ended: w.ended, hasStream: !!w.stream, last: w.last,
            streamMs: w.streamMs, firstFrameMs: w.firstFrameMs, renderedMs: w.renderedMs,
            video: { width: w.card.video.videoWidth, height: w.card.video.videoHeight, paused: w.card.video.paused, muted: w.card.video.muted }
        }))
    }),
    log: () => log,
    join: async opts => {
        for (const [k, v] of Object.entries(opts ?? {})) if ($("#" + k)) $("#" + k).value = v;
        readForm();
        await join();
    },
    leave: () => leave("console"),
    getPeers: () => room?.getPeers() ?? {},
    startTestStream: startPatternStream,
    startDisplayStream,
    stopStream: () => stopStreaming("console"),
    watch,
    stopWatching
};
