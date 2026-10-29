/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";
import { getRelaySockets, type HandshakeReceiver, type HandshakeSender, joinRoom, type MessageAction, type Room, selfId } from "trystero";

import { logEvent, recordConnection, recordRelayState, recordStats, recordTiming } from "./diagnostics";
import {
    ACTION_PRESENCE, ACTION_WATCH, APP_ID, deriveRoomId, HELLO_TYPE, type HelloMessage, ICE_SERVERS, isHelloMessage, isPresenceMessage,
    isWatchMessage, type PresenceMessage, PROTOCOL_VERSION, RELAY_URLS, STREAM_KIND_TEST_PATTERN, type WatchMessage
} from "./protocol";
import { settings } from "./settings";
import { type CandidatePairInfo, describeSelectedPair, type InboundSample, type OutboundSample, pairLabel, samePair, StatsSampler } from "./stats";
import { createTestPattern, PATTERN_FPS, TEST_MAX_BITRATE_KBPS, type TestPattern } from "./testPattern";

export type Admission = "ok" | "fora-do-canal" | "sem-id" | "sem-verificacao";

export type PeerView = {
    peerId: string;
    /** ms desde a entrada na sala ate o peer ficar ativo */
    seenAfterMs: number;
    hello?: HelloMessage;
    presence?: PresenceMessage;
    admission: Admission;
    pair?: CandidatePairInfo | null;
    pingMs?: number;
};

export type WatchView = {
    peerId: string;
    requestedAt: number;
    stream: MediaStream | null;
    iceMs?: number | null;
    iceNote?: string;
    streamMs?: number;
    firstFrameMs?: number;
    renderedMs?: number;
    last?: InboundSample;
    ended?: string;
};

const READY_STATES = ["conectando", "aberto", "fechando", "fechado"];
const short = (id: string) => id.slice(0, 6);
const host = (url: string) => url.replace(/^wss:\/\//, "");

// ---------------------------------------------------------------- estado

let room: Room | null = null;
let presenceAction: MessageAction<PresenceMessage> | null = null;
let watchAction: MessageAction<WatchMessage> | null = null;
let currentKey = "";
let joinSeq = 0;

let status: "fora" | "entrando" | "na-sala" = "fora";
let guildId: string | null = null;
let channelId: string | null = null;
let roomId: string | null = null;
let joinedAt = 0;
let firstPeerMs: number | null = null;

const peers = new Map<string, PeerView>();
const helloByPeer = new Map<string, HelloMessage>();
const relays: Record<string, string> = {};
const relayFirstOpen = new Set<string>();

let pattern: TestPattern | null = null;
const viewers = new Set<string>();
const outbound: Record<string, OutboundSample> = {};
const outSamplers = new Map<string, StatsSampler>();

let watching: WatchView | null = null;
let inSampler = new StatsSampler();
let firstFramePoll: ReturnType<typeof setInterval> | null = null;
let iceCleanup: (() => void) | null = null;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let passwordTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
export function onSessionChange(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
function emit() {
    listeners.forEach(fn => {
        try { fn(); } catch { }
    });
}

export function getSessionView() {
    return {
        status,
        guildId,
        channelId,
        roomId,
        firstPeerMs,
        selfId,
        hasPassword: !!settings.store.groupPassword,
        peers: [...peers.values()],
        relays: { ...relays },
        streaming: !!pattern,
        viewers: [...viewers],
        outbound: { ...outbound },
        watching
    };
}

export const isStreaming = () => !!pattern;

// ---------------------------------------------------------------- identidade / admissao

function me() {
    const user = UserStore.getCurrentUser();
    return { id: user?.id ?? "?", username: user?.username ?? "?" };
}

function selfHello(): HelloMessage {
    const { id, username } = me();
    return { type: HELLO_TYPE, discordUserId: id, username, version: PROTOCOL_VERSION };
}

function selfPresence(): PresenceMessage {
    const { id, username } = me();
    return { discordUserId: id, username, streaming: !!pattern, version: PROTOCOL_VERSION };
}

function checkAdmission(userId: string | undefined): Admission {
    if (!userId) return "sem-id";
    if (!channelId) return "sem-verificacao";
    const states = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    return Object.prototype.hasOwnProperty.call(states, userId) ? "ok" : "fora-do-canal";
}

function peerName(peerId: string) {
    const p = peers.get(peerId);
    const name = p?.presence?.username ?? p?.hello?.username ?? helloByPeer.get(peerId)?.username;
    return name ? `${name} (${short(peerId)})` : short(peerId);
}

/** Reavalia a admissao de todos os peers (chamado quando o VoiceStateStore muda). */
export function reevaluateAdmission() {
    let changed = false;
    for (const p of peers.values()) {
        const adm = checkAdmission(p.presence?.discordUserId ?? p.hello?.discordUserId);
        if (adm !== p.admission) {
            logEvent(adm === "ok" ? "info" : "warn", "admissao", `${peerName(p.peerId)}: admissão mudou ${p.admission} → ${adm}`);
            p.admission = adm;
            changed = true;
        }
    }
    if (changed) emit();
}

// ---------------------------------------------------------------- sala

/** Entra/sai/troca de sala conforme o canal de voz atual. */
export function syncVoiceRoom(reason: string) {
    const vc = SelectedChannelStore.getVoiceChannelId() ?? null;
    const gid = vc ? ChannelStore.getChannel(vc)?.guild_id ?? null : null;
    const key = vc ? `${gid ?? "dm"}|${vc}|${settings.store.groupPassword ?? ""}` : "";
    if (key === currentKey) return;
    currentKey = key;
    void switchRoom(gid, vc, reason);
}

export function onPasswordChanged() {
    if (passwordTimer) clearTimeout(passwordTimer);
    passwordTimer = setTimeout(() => {
        passwordTimer = null;
        syncVoiceRoom("senha do grupo alterada");
    }, 800);
}

/** Sai e entra de novo na mesma sala (util para medir de novo o tempo ate o primeiro peer). */
export function rejoin() {
    currentKey = "";
    syncVoiceRoom("reentrada manual");
}

async function switchRoom(gid: string | null, vc: string | null, reason: string) {
    const seq = ++joinSeq;
    if (room) await leaveRoom(`troca de sala: ${reason}`);
    if (seq !== joinSeq) return;
    if (!vc) {
        status = "fora";
        guildId = channelId = roomId = null;
        emit();
        return;
    }

    status = "entrando";
    guildId = gid;
    channelId = vc;
    emit();
    const rid = await deriveRoomId(gid, vc);
    if (seq !== joinSeq) return;
    joinNow(rid, reason);
}

function joinNow(rid: string, reason: string) {
    roomId = rid;
    firstPeerMs = null;
    joinedAt = performance.now();
    const password = settings.store.groupPassword || undefined;

    logEvent("info", "sala", `Entrando na sala ${rid.slice(0, 12)}… (${reason})`, {
        guildId: guildId ?? "dm", channelId, roomId: rid, password: !!password, selfId
    });

    const r = joinRoom(
        {
            appId: APP_ID,
            password,
            relayConfig: { urls: RELAY_URLS },
            rtcConfig: { iceServers: ICE_SERVERS }
        },
        rid,
        {
            onJoinError: details => {
                const hint = /password/i.test(details.error) ? " — senha do grupo diferente?" : /connect|ice|turn/i.test(details.error) ? " — sem caminho P2P direto (precisaria de TURN?)" : "";
                logEvent("error", "join", `Falha com peer ${peerName(details.peerId)}: ${details.error}${hint}`, { peerId: details.peerId, error: details.error });
            },
            onPeerHandshake: handshake,
            handshakeTimeoutMs: 15000
        }
    );

    presenceAction = r.makeAction<PresenceMessage>(ACTION_PRESENCE);
    watchAction = r.makeAction<WatchMessage>(ACTION_WATCH);
    presenceAction.onMessage = onPresence;
    watchAction.onMessage = onWatch;
    r.onPeerJoin = onPeerJoin;
    r.onPeerLeave = onPeerLeave;
    r.onPeerStream = onPeerStream;
    room = r;
    status = "na-sala";

    if (!tickTimer) tickTimer = setInterval(tick, 1000);
    tick();
    emit();
}

export async function leaveRoom(reason: string) {
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
    emit();

    try {
        await r.leave();
    } catch (e) {
        logEvent("error", "sala", "Erro ao sair da sala: " + e);
    }
}

export async function shutdown() {
    joinSeq++;
    currentKey = "";
    if (passwordTimer) clearTimeout(passwordTimer);
    passwordTimer = null;
    await leaveRoom("plugin parado");
    stopTestStream();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    guildId = channelId = roomId = null;
    for (const k of Object.keys(relays)) delete relays[k];
    relayFirstOpen.clear();
}

async function handshake(peerId: string, send: HandshakeSender, receive: HandshakeReceiver) {
    const t = performance.now();
    await send(selfHello());
    const { data } = await receive();
    if (!isHelloMessage(data)) {
        logEvent("warn", "admissao", `Peer ${short(peerId)} mandou handshake inválido (versão antiga ou outro app?)`);
        if (settings.store.enforceAdmission) throw new Error("handshake inválido");
        return;
    }
    helloByPeer.set(peerId, data);
    const adm = checkAdmission(data.discordUserId);
    const enforce = settings.store.enforceAdmission;
    const who = `${data.username} (discord ${data.discordUserId}, peer ${short(peerId)})`;
    if (adm === "ok") {
        logEvent("info", "admissao", `Handshake ok com ${who} em ${Math.round(performance.now() - t)} ms — está no canal de voz`);
    } else {
        logEvent("warn", "admissao", `${enforce ? "REJEITADO" : "ACEITO MAS MARCADO"}: ${who} — ${adm === "fora-do-canal" ? "NÃO está no seu canal de voz" : adm}`);
        if (enforce) throw new Error(`peer fora do canal de voz (${adm})`);
    }
    if (data.version !== PROTOCOL_VERSION) logEvent("warn", "admissao", `${who} usa protocolo v${data.version}, eu uso v${PROTOCOL_VERSION}`);
}

// ---------------------------------------------------------------- eventos da sala

function onPeerJoin(peerId: string) {
    const afterMs = performance.now() - joinedAt;
    const hello = helloByPeer.get(peerId);
    const p: PeerView = {
        peerId,
        seenAfterMs: Math.round(afterMs),
        hello,
        admission: checkAdmission(hello?.discordUserId),
        pair: null
    };
    peers.set(peerId, p);
    logEvent("info", "peer", `Peer ${peerName(peerId)} ativo ${Math.round(afterMs)} ms após entrar na sala`);
    if (firstPeerMs == null) {
        firstPeerMs = afterMs;
        recordTiming("sala → primeiro peer visto", afterMs, peerId);
    }

    presenceAction?.send(selfPresence(), { target: peerId }).catch(e => logEvent("error", "presenca", "Falha ao enviar presença: " + e));
    void inspectConnection(peerId, "peer-entrou");
    room?.ping(peerId).then(ms => {
        const cur = peers.get(peerId);
        if (!cur) return;
        cur.pingMs = Math.round(ms);
        logEvent("info", "peer", `Ping (canal de dados) com ${peerName(peerId)}: ${cur.pingMs} ms`);
        emit();
    }).catch(() => { });
    emit();
}

function onPeerLeave(peerId: string) {
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
    emit();
}

function onPresence(data: PresenceMessage, { peerId }: { peerId: string; }) {
    if (!isPresenceMessage(data)) {
        logEvent("warn", "presenca", `Presença inválida de ${short(peerId)}`);
        return;
    }
    let p = peers.get(peerId);
    if (!p) {
        // pode chegar antes do onPeerJoin em casos raros
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
        logEvent(p.admission === "ok" ? "info" : "warn", "presenca",
            `${data.username} (discord ${data.discordUserId}) — no canal de voz: ${p.admission === "ok" ? "sim" : "NÃO (" + p.admission + ")"} — transmitindo: ${data.streaming ? "sim" : "não"}`);
    } else if (prev.streaming !== data.streaming) {
        logEvent("info", "presenca", `${data.username} ${data.streaming ? "começou" : "parou"} de transmitir`);
    }

    if (!data.streaming && watching?.peerId === peerId && !watching.ended) {
        watching.ended = "a transmissão foi encerrada pelo peer";
        stopFirstFramePoll();
    }
    emit();
}

function onWatch(data: WatchMessage, { peerId }: { peerId: string; }) {
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
            try { r.removeStream(pattern.stream, { target: peerId }); } catch (e) {
                logEvent("error", "midia", "Falha ao remover stream: " + e);
            }
        }
        outSamplers.delete(peerId);
        delete outbound[peerId];
        logEvent("info", "midia", `${peerName(peerId)} parou de assistir`);
    }
    emit();
}

/**
 * O Chromium limita o video a ~2,5 Mbps por padrao, o que esconderia a capacidade real do link.
 * Sobe o teto do encoder para TEST_MAX_BITRATE_KBPS (o controle de congestionamento continua valendo).
 */
async function applyMaxBitrate(peerId: string, stream: MediaStream) {
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

function onPeerStream(stream: MediaStream, peerId: string) {
    const w = watching;
    if (!w || w.peerId !== peerId) {
        logEvent("warn", "midia", `Stream recebido de ${peerName(peerId)} sem ter pedido (ignorado)`);
        return;
    }
    w.stream = stream;
    w.streamMs = performance.now() - w.requestedAt;
    recordTiming("Assistir → stream recebido (ontrack)", w.streamMs, peerId, `${stream.getVideoTracks().length} vídeo, ${stream.getAudioTracks().length} áudio`);
    emit();
}

// ---------------------------------------------------------------- transmitir / assistir

export function startTestStream() {
    if (pattern) return;
    pattern = createTestPattern(me().username);
    logEvent("info", "midia", "Transmitindo padrão de teste (canvas 1280x720 @ 60 fps + tom de 220 Hz). Espectadores pedem com \"Assistir\".");
    presenceAction?.send(selfPresence()).catch(() => { });
    emit();
}

export function stopTestStream() {
    if (!pattern) return;
    const p = pattern;
    if (room && viewers.size) {
        try { room.removeStream(p.stream, { target: [...viewers] }); } catch (e) {
            logEvent("error", "midia", "Falha ao remover stream: " + e);
        }
    }
    viewers.clear();
    outSamplers.clear();
    for (const k of Object.keys(outbound)) delete outbound[k];
    p.stop();
    pattern = null;
    logEvent("info", "midia", "Transmissão do padrão de teste encerrada");
    presenceAction?.send(selfPresence()).catch(() => { });
    emit();
}

export function toggleTestStream() {
    if (pattern) stopTestStream();
    else startTestStream();
}

export function watch(peerId: string) {
    const r = room;
    if (!r) return;
    if (watching) stopWatchingInternal(true);

    const w: WatchView = { peerId, requestedAt: performance.now(), stream: null };
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
                iceCleanup?.();
                emit();
            }
        };
        pc.addEventListener("iceconnectionstatechange", onIce);
        iceCleanup = () => {
            pc.removeEventListener("iceconnectionstatechange", onIce);
            iceCleanup = null;
        };
    }

    watchAction?.send({ op: "start" }, { target: peerId }).catch(e => logEvent("error", "midia", "Falha ao pedir stream: " + e));
    startFirstFramePoll(w);
    emit();
}

export function stopWatching() {
    stopWatchingInternal(true);
    emit();
}

function stopWatchingInternal(notify: boolean) {
    const w = watching;
    if (!w) return;
    watching = null;
    stopFirstFramePoll();
    iceCleanup?.();
    if (notify && !w.ended) watchAction?.send({ op: "stop" }, { target: w.peerId }).catch(() => { });
    logEvent("info", "midia", `Parou de assistir ${peerName(w.peerId)}`);
}

/** Chamado pela UI quando o elemento <video> mostra o primeiro quadro. */
export function reportFirstRenderedFrame(peerId: string) {
    const w = watching;
    if (!w || w.peerId !== peerId || w.renderedMs != null) return;
    w.renderedMs = performance.now() - w.requestedAt;
    recordTiming("Assistir → primeiro quadro na tela", w.renderedMs, peerId);
    emit();
}

function startFirstFramePoll(w: WatchView) {
    stopFirstFramePoll();
    firstFramePoll = setInterval(async () => {
        if (watching !== w) return stopFirstFramePoll();
        const elapsed = performance.now() - w.requestedAt;
        if (elapsed > 30000) {
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
            report.forEach((s: any) => {
                if (s.type === "inbound-rtp" && s.kind === "video") decoded = Math.max(decoded, s.framesDecoded ?? 0);
            });
            if (decoded > 0 && watching === w && w.firstFrameMs == null) {
                w.firstFrameMs = performance.now() - w.requestedAt;
                stopFirstFramePoll();
                recordTiming("Assistir → primeiro quadro decodificado", w.firstFrameMs, w.peerId);
                emit();
            }
        } catch { }
    }, 100);
}

function stopFirstFramePoll() {
    if (firstFramePoll) clearInterval(firstFramePoll);
    firstFramePoll = null;
}

// ---------------------------------------------------------------- diagnostico periodico

async function inspectConnection(peerId: string, reason: string) {
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
            emit();
        } else if (p.pair && info.rttMs != null) {
            p.pair.rttMs = info.rttMs;
        }
    } catch (e) {
        logEvent("error", "ice", `getStats falhou para ${short(peerId)}: ${e}`);
    }
}

const hookedSockets = new WeakSet<WebSocket>();

/** Le o estado dos sockets dos relays. Tambem escuta open/close de cada socket para a marca de tempo ser precisa. */
function pollRelays() {
    let sockets: Record<string, WebSocket> = {};
    try {
        sockets = (getRelaySockets() ?? {}) as Record<string, WebSocket>;
    } catch { }
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
                logEvent(st === "aberto" ? "info" : st === "conectando" ? "info" : "warn", "relay", `${host(url)}: ${prev ?? "—"} → ${st}`);
            if (st === "aberto" && !relayFirstOpen.has(url) && room) {
                relayFirstOpen.add(url);
                recordTiming(`sala → relay aberto (${host(url)})`, performance.now() - joinedAt);
            }
            emit();
        }
    }
}

function tick() {
    tickCount++;
    pollRelays();

    const r = room;
    if (!r) return;
    const pcs = r.getPeers();

    // espectador: stats de entrada a cada 1s
    const w = watching;
    if (w && !w.ended && pcs[w.peerId]) {
        pcs[w.peerId].getStats().then(report => {
            if (watching !== w) return;
            const sample = inSampler.inbound(report);
            w.last = sample;
            recordStats(w.peerId, sample);
            emit();
        }).catch(() => { });
    }

    // transmissor: stats de saida por espectador
    for (const v of viewers) {
        const pc = pcs[v];
        const sampler = outSamplers.get(v);
        if (!pc || !sampler) continue;
        pc.getStats().then(report => {
            if (!viewers.has(v)) return;
            const sample = sampler.outbound(report);
            outbound[v] = sample;
            recordStats(v, sample);
            emit();
        }).catch(() => { });
    }

    // a cada 5s confere se o par ICE mudou e atualiza o RTT
    if (tickCount % 5 === 0) {
        for (const peerId of peers.keys()) void inspectConnection(peerId, "verificacao");
        emit();
    }
}

