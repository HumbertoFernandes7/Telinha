/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ciclo de vida da sessao: uma sala Trystero (Nostr) por canal de voz, entrando/saindo/trocando
// conforme o canal de voz atual; handshake + admissao; presenca; despacho para streaming/viewing.

import {
    ACTION_PRESENCE, ACTION_WATCH, APP_ID, deriveRoomId, HELLO_TYPE, type HelloMessage, ICE_SERVERS, isHelloMessage, isPresenceMessage,
    isWatchMessage, parseWatchReply, type PresenceMessage, PROTOCOL_VERSION, RELAY_URLS, sanitizePresence, truncateName, type WatchActionMessage
} from "@plugins/telinha/protocol";
import { settings } from "@plugins/telinha/settings";
import { resetState } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import { ChannelStore, FluxDispatcher, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";
import { getRelaySockets, type HandshakeReceiver, type HandshakeSender, joinRoom, type JsonValue } from "trystero";

import { probeLocalCaps } from "./codec";
import { getPc, type PeerEntry, peerLabel, publish, rt, setLastError } from "./context";
import { errorText, log, logThrottled, shortId } from "./log";
import { getNativeOrNull } from "./nativeApi";
import { getPeerConnectionClass, setPcHooks } from "./peerConnection";
import { computeAdmitted, me, selfHello, sendPresence } from "./presence";
import * as streaming from "./streaming";
import * as viewing from "./viewing";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const RELAY_CHECK_MS = 10_000;
const PASSWORD_DEBOUNCE_MS = 800;

let active = false;
let currentKey = "";
let joinSeq = 0;
/** saida da sala anterior em andamento: entrar de novo na MESMA sala antes disso devolveria a sala velha */
let leaving: Promise<void> = Promise.resolve();
let ticker: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let passwordTimer: ReturnType<typeof setTimeout> | null = null;
let relayTimer: ReturnType<typeof setTimeout> | null = null;

/** hello recebido no handshake, guardado ate o onPeerJoin (null = incompativel) */
const helloByPeer = new Map<PeerId, HelloMessage | null>();
/** peers cujo handshake anunciou o SEU discordUserId (o hello fica guardado so para o alerta) */
const selfClaims = new Set<PeerId>();
const pcPeerIds = new WeakMap<RTCPeerConnection, PeerId>();

// #region admissao

function isInMyVoiceChannel(userId: string) {
    const channel = rt.channelId;
    if (!channel || !userId) return false;
    const states = VoiceStateStore.getVoiceStatesForChannel(channel) ?? {};
    return Object.prototype.hasOwnProperty.call(states, userId);
}

/** Reavalia quem esta no canal de voz / a politica de admissao. Chamado em mudancas de voz e da opcao. */
function reevaluateAdmission() {
    let changed = false;
    for (const p of rt.peers.values()) {
        if (p.incompatible || !p.hello) continue;
        const inVoice = isInMyVoiceChannel(p.hello.discordUserId);
        const wasAdmitted = p.admitted;
        p.inVoice = inVoice;
        p.admitted = computeAdmitted(p);
        if (p.admitted === wasAdmitted) continue;
        changed = true;
        if (p.admitted) {
            log.info(`${peerLabel(p.peerId)} agora está admitido${inVoice ? " (entrou no seu canal de voz)" : ""}`);
            sendPresence(p.peerId);
        } else {
            log.info(`${peerLabel(p.peerId)} não está mais admitido${inVoice ? "" : " (fora do seu canal de voz)"}`);
            streaming.onAdmissionLost(p.peerId);
        }
    }
    if (changed) publish();
}

export function onAdmissionSettingChanged() {
    if (active) reevaluateAdmission();
}

// #endregion

// #region identidade duplicada

/**
 * Conexao viva para a checagem de identidade: a que caiu (ex.: o amigo reabriu o Discord e a conexao velha
 * ainda nao saiu da sala) nao conta, senao toda reconexao pareceria uma identidade duplicada.
 */
function isLive(peerId: PeerId) {
    const state = getPc(peerId)?.connectionState;
    return state !== "disconnected" && state !== "failed" && state !== "closed";
}

/**
 * Duas conexoes vivas dizendo ter o mesmo discordUserId: uma pode ser falsa (a identidade e so anunciada).
 * Marca as duas; quem esta recebendo a transmissao para de receber (streaming.onIdentityConflict) e nada
 * volta sozinho quando o conflito some: a pessoa precisa pedir para assistir de novo.
 * Chamado na entrada/saida de peers e a cada segundo (o estado das conexoes muda sem evento da sala).
 */
function checkIdentities() {
    const byUser = new Map<string, PeerEntry[]>();
    for (const p of rt.peers.values()) {
        if (p.incompatible || !p.hello || !isLive(p.peerId)) continue;
        const list = byUser.get(p.hello.discordUserId);
        if (list) list.push(p);
        else byUser.set(p.hello.discordUserId, [p]);
    }

    const started: PeerEntry[] = [];
    const resolved = new Set<string>();
    for (const p of rt.peers.values()) {
        const id = p.hello?.discordUserId;
        const dup = !!id && !p.incompatible && (byUser.get(id)?.length ?? 0) > 1 && isLive(p.peerId);
        if (dup === p.duplicate) continue;
        p.duplicate = dup;
        if (dup) started.push(p);
        else if (id) resolved.add(id);
    }
    if (!started.length && !resolved.size) return;

    for (const id of new Set(started.map(p => p.hello!.discordUserId))) {
        const list = byUser.get(id) ?? [];
        log.warn(`Duas conexões dizem ser ${list[0]?.hello?.username ?? "?"} (discord ${id}): ${list.map(p => shortId(p.peerId)).join(", ")} — uma pode ser falsa. Nenhuma recebe a sua transmissão enquanto isso durar.`);
    }
    for (const id of resolved) {
        if (byUser.get(id)?.some(p => p.duplicate)) continue;
        log.info(`Conflito de identidade do discord ${id} acabou (uma das conexões saiu). Quem quiser assistir precisa pedir de novo.`);
    }
    if (started.length) streaming.onIdentityConflict(started.map(p => p.peerId));
    publish();
}

// #endregion

// #region sala

function syncVoiceRoom(reason: string) {
    if (!active) return;
    const vc = SelectedChannelStore.getVoiceChannelId() ?? null;
    const gid = vc ? ChannelStore.getChannel(vc)?.guild_id ?? null : null;
    const key = vc ? `${gid ?? "dm"}|${vc}|${settings.store.groupPassword ?? ""}` : "";
    if (key === currentKey) return;
    currentKey = key;
    void switchRoom(gid, vc, reason);
}

export function onPasswordChanged() {
    if (!active) return;
    if (passwordTimer) clearTimeout(passwordTimer);
    passwordTimer = setTimeout(() => {
        passwordTimer = null;
        syncVoiceRoom("senha do grupo alterada");
    }, PASSWORD_DEBOUNCE_MS);
}

async function switchRoom(gid: string | null, vc: string | null, reason: string) {
    const seq = ++joinSeq;
    const channelChanged = vc !== rt.channelId;
    if (rt.room) {
        const wasStreaming = !!rt.local;
        leaveRoom(channelChanged ? "você saiu do canal de voz" : reason);
        if (wasStreaming) rt.lastError = channelChanged
            ? "A transmissão foi encerrada porque você saiu do canal de voz."
            : "A transmissão foi encerrada porque a sala mudou (senha do grupo alterada).";
    }
    rt.channelId = vc;
    rt.guildId = gid;
    publish();
    if (!vc) return;

    try {
        const roomId = await deriveRoomId(gid, vc);
        await leaving;
        if (seq !== joinSeq || !active) return;
        joinNow(roomId, reason);
    } catch (e) {
        log.error("Falha ao entrar na sala: " + errorText(e));
        setLastError("Não foi possível entrar na sala do Telinha: " + errorText(e));
    }
}

function joinNow(roomId: string, reason: string) {
    const password = settings.store.groupPassword || undefined;
    log.info(`Entrando na sala ${roomId.slice(0, 12)}… (${reason}${password ? ", com senha" : ""})`);

    const room = joinRoom(
        {
            appId: APP_ID,
            password,
            relayConfig: { urls: RELAY_URLS },
            rtcConfig: { iceServers: ICE_SERVERS },
            rtcPolyfill: getPeerConnectionClass()
        },
        roomId,
        {
            onJoinError: details => {
                const hint = /password|decrypt/i.test(details.error) ? " (senha do grupo diferente?)"
                    : /connect|ice|turn/i.test(details.error) ? " (sem caminho P2P direto entre as redes)" : "";
                logThrottled(`join-error:${details.peerId}`, "warn", `Falha de conexão com o peer ${shortId(details.peerId)}: ${details.error}${hint}`);
            },
            onPeerHandshake: handshake,
            handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS
        }
    );

    rt.room = room;
    rt.presenceAction = room.makeAction<PresenceMessage>(ACTION_PRESENCE);
    rt.watchAction = room.makeAction<WatchActionMessage>(ACTION_WATCH);
    rt.presenceAction.onMessage = onPresence;
    rt.watchAction.onMessage = onWatch;
    room.onPeerJoin = onPeerJoin;
    room.onPeerLeave = onPeerLeave;
    room.onPeerStream = onPeerStream;
    if (rt.lastError?.startsWith("Não foi possível entrar")) rt.lastError = null;

    if (relayTimer) clearTimeout(relayTimer);
    relayTimer = setTimeout(() => checkRelays(room), RELAY_CHECK_MS);
    publish();
}

/** Sai da sala atual (parte sincrona agora; o leave() do Trystero fica encadeado em `leaving`). */
function leaveRoom(reason: string) {
    const { room } = rt;
    if (!room) return;
    streaming.onRoomClosing(reason);
    viewing.clearAll();
    rt.room = null;
    rt.presenceAction = rt.watchAction = null;
    rt.peers.clear();
    helloByPeer.clear();
    selfClaims.clear();
    if (relayTimer) clearTimeout(relayTimer);
    relayTimer = null;
    log.info(`Saindo da sala (${reason})`);
    publish();
    leaving = leaving.then(() => room.leave()).catch(e => log.warn("Erro ao sair da sala: " + errorText(e)));
}

function checkRelays(room: NonNullable<typeof rt.room>) {
    relayTimer = null;
    if (rt.room !== room) return;
    let open = 0;
    try {
        const sockets = (getRelaySockets() ?? {}) as Record<string, WebSocket>;
        open = Object.values(sockets).filter(ws => ws?.readyState === 1).length;
    } catch { }
    log.info(`Relays de descoberta conectados: ${open}/${RELAY_URLS.length}`);
    if (!open) setLastError("Não foi possível falar com os servidores de descoberta. Feche o Discord por completo (inclusive da bandeja) e abra de novo; se continuar, a rede pode estar bloqueando.");
}

// #endregion

// #region handshake e eventos da sala

/**
 * Nunca rejeita: se o handshake lanca, o Trystero tenta o mesmo peer de novo em loop (~100x/s),
 * gastando CPU e rede. Em vez disso o transporte e aceito e o peer fica marcado: incompativel
 * (ignorado por completo) ou fora do canal de voz (nao recebe presenca nem transmissao enquanto a
 * opcao "recusar quem esta fora" estiver ligada). A admissao e reavaliada a cada mudanca de voz.
 */
async function handshake(peerId: string, send: HandshakeSender, receive: HandshakeReceiver) {
    await send(selfHello());
    const { data } = await receive();

    if (!isHelloMessage(data) || data.v !== PROTOCOL_VERSION) {
        helloByPeer.set(peerId, null);
        const v = data && typeof data === "object" && "v" in data ? ` (v${String((data as Record<string, unknown>).v)})` : "";
        logThrottled(`hs-bad:${peerId}`, "warn", `Peer ${shortId(peerId)} usa outra versão do Telinha${v}; ignorado`, 60_000);
        return;
    }
    const hello: HelloMessage = { type: HELLO_TYPE, v: data.v, discordUserId: data.discordUserId, username: truncateName(data.username) };
    if (data.discordUserId === me().id) {
        // guardado so para o alerta "uma conexão diz ser você"; o peer fica incompativel (nunca e aceito)
        selfClaims.add(peerId);
        helloByPeer.set(peerId, hello);
        logThrottled(`hs-self:${peerId}`, "warn", `Peer ${shortId(peerId)} diz ser você (discord ${data.discordUserId}): pode ser alguém tentando se passar por você; ignorado`, 60_000);
        return;
    }
    helloByPeer.set(peerId, hello);
}

function onPeerJoin(peerId: PeerId) {
    const hello = helloByPeer.get(peerId) ?? null;
    const claimsSelf = selfClaims.has(peerId);
    const entry: PeerEntry = {
        peerId,
        hello,
        presence: null,
        inVoice: hello && !claimsSelf ? isInMyVoiceChannel(hello.discordUserId) : false,
        incompatible: !hello || claimsSelf,
        admitted: false,
        duplicate: false,
        claimsSelf
    };
    entry.admitted = computeAdmitted(entry);
    rt.peers.set(peerId, entry);
    if (claimsSelf) {
        logThrottled("self-claim-join", "warn", `Uma conexão (${shortId(peerId)}) diz ser você: ela não vê sua presença nem recebe sua transmissão`, 60_000);
        publish();
        return;
    }
    if (!hello) return;
    checkIdentities();

    if (entry.admitted) {
        log.info(`${peerLabel(peerId)} entrou na sala${entry.inVoice ? "" : " (fora do seu canal de voz, aceito porque a recusa está desligada)"}`);
        sendPresence(peerId);
    } else {
        logThrottled(`outsider:${hello.discordUserId}`, "warn", `${peerLabel(peerId)} (discord ${hello.discordUserId}) entrou na sala, mas não está no seu canal de voz: ignorado`);
    }
    publish();
}

function onPeerLeave(peerId: PeerId) {
    const entry = rt.peers.get(peerId);
    if (entry?.hello && entry.admitted) log.info(`${peerLabel(peerId)} saiu da sala`);
    streaming.onPeerGone(peerId);
    viewing.onPeerGone(peerId);
    rt.peers.delete(peerId);
    helloByPeer.delete(peerId);
    selfClaims.delete(peerId);
    checkIdentities();
    publish();
}

function onPresence(data: PresenceMessage, { peerId }: { peerId: string; }) {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible) return;
    if (!isPresenceMessage(data)) {
        logThrottled(`presence-bad:${peerId}`, "warn", `Presença inválida de ${peerLabel(peerId)}; ignorada`);
        return;
    }
    if (data.discordUserId !== entry.hello.discordUserId) {
        logThrottled(`presence-id:${peerId}`, "warn", `${peerLabel(peerId)}: ID da presença (${data.discordUserId}) difere do handshake (${entry.hello.discordUserId}); ignorada`);
        return;
    }

    const presence = sanitizePresence(data);
    const prev = entry.presence;
    entry.presence = presence;
    if (entry.admitted) {
        if (!prev) {
            log.info(`${peerLabel(peerId)}: ${presence.streaming ? `transmitindo ${presence.stream ? `${presence.stream.kind === "screen" ? "tela" : "janela"} ${presence.stream.width}x${presence.stream.height}@${presence.stream.fps}` : ""}` : "não está transmitindo"}; H.264 por hardware: ${presence.caps.h264HwDecode ? "sim" : "não"}`);
        } else if (prev.streaming !== presence.streaming) {
            log.info(`${peerLabel(peerId)} ${presence.streaming ? "começou" : "parou"} de transmitir`);
        }
    }
    viewing.onPresence(peerId, presence);
    publish();
}

function onWatch(data: WatchActionMessage, { peerId }: { peerId: string; }) {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible) return;
    if (isWatchMessage(data)) {
        streaming.onWatchRequest(peerId, data.op);
        return;
    }
    // resposta do transmissor a um pedido nosso (pending/denied); so mexe na sessao que assiste esse peer
    const reply = parseWatchReply(data);
    if (reply) viewing.onWatchReply(peerId, reply);
}

function onPeerStream(stream: MediaStream, peerId: string, metadata?: JsonValue) {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible) return;
    viewing.onPeerStream(peerId, stream, metadata);
}

// #endregion

// #region ganchos do Discord

interface VoiceStateUpdate {
    userId: string;
    channelId?: string | null;
}

function onVoiceChannelSelect() {
    // deixa o SelectedChannelStore processar a acao antes de ler o canal
    setTimeout(() => syncVoiceRoom("canal de voz selecionado"), 0);
}

function onVoiceStateUpdates({ voiceStates }: { voiceStates?: VoiceStateUpdate[]; }) {
    const myId = UserStore.getCurrentUser()?.id;
    setTimeout(() => {
        if (!active) return;
        if (voiceStates?.some(s => s.userId === myId)) syncVoiceRoom("estado de voz mudou");
        reevaluateAdmission();
    }, 0);
}

function onCspViolation(e: SecurityPolicyViolationEvent) {
    if (!RELAY_URLS.some(url => e.blockedURI?.startsWith(url))) return;
    logThrottled("csp", "error", `O CSP do Discord bloqueou um relay (${e.blockedURI}). Feche o Discord por completo e abra de novo.`, 60_000);
    setLastError("O Discord precisa ser fechado por completo (inclusive da bandeja) e aberto de novo para o Telinha se conectar.");
}

function tick() {
    tickCount++;
    if (rt.room) checkIdentities();
    streaming.tick();
    if (tickCount % 2 === 0) viewing.sampleStats();
}

function peerIdOfPc(pc: RTCPeerConnection): PeerId | null {
    const cached = pcPeerIds.get(pc);
    if (cached) return cached;
    const peers = rt.room?.getPeers() ?? {};
    for (const id in peers) {
        if (peers[id] === pc) {
            pcPeerIds.set(pc, id);
            return id;
        }
    }
    return null;
}

// #endregion

export function startSession() {
    if (active) return;
    active = true;
    tickCount = 0;
    log.info("Sessão iniciada");

    if (!getNativeOrNull()) {
        log.error("A parte nativa do plugin não está carregada (relays bloqueados pelo CSP, sem captura).");
        setLastError("O Telinha foi instalado/atualizado com o Discord aberto. Feche o Discord por completo (inclusive da bandeja) e abra de novo.");
    }

    setPcHooks({ planFor: pc => streaming.sendPlanFor(peerIdOfPc(pc)) });
    void probeLocalCaps().then(() => {
        if (active) sendPresence();
    });

    FluxDispatcher.subscribe("VOICE_CHANNEL_SELECT", onVoiceChannelSelect);
    FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
    document.addEventListener("securitypolicyviolation", onCspViolation);
    ticker = setInterval(tick, 1000);

    syncVoiceRoom("plugin iniciado");
}

export function stopSession() {
    if (!active) return;
    leaveRoom("plugin desligado");
    active = false;
    joinSeq++;
    currentKey = "";

    FluxDispatcher.unsubscribe("VOICE_CHANNEL_SELECT", onVoiceChannelSelect);
    FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
    document.removeEventListener("securitypolicyviolation", onCspViolation);
    if (ticker) clearInterval(ticker);
    if (passwordTimer) clearTimeout(passwordTimer);
    if (relayTimer) clearTimeout(relayTimer);
    ticker = passwordTimer = relayTimer = null;

    streaming.stopStreaming("plugin desligado");
    viewing.clearAll();
    setPcHooks(null);
    getNativeOrNull()?.resetDisplayMedia().catch(() => { });

    rt.channelId = rt.guildId = rt.lastError = null;
    rt.peers.clear();
    helloByPeer.clear();
    selfClaims.clear();
    log.info("Sessão encerrada");
    resetState();
}

export function isSessionActive() {
    return active;
}
