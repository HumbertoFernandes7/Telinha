/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ciclo de vida da sessao: uma sala Trystero (Nostr) por canal de voz, entrando/saindo/trocando
// conforme o canal de voz atual; handshake + admissao; prova de identidade do Discord (docs/identity.md);
// presenca; despacho para streaming/viewing.

import {
    ACTION_IDENTITY, ACTION_PRESENCE, ACTION_WATCH, APP_ID, deriveRoomId, type HelloMessage, ICE_SERVERS, type IdentityMessage, isIdentityMessage,
    isPresenceMessage, parseHello, parseWatchReply, parseWatchRequest, type PresenceMessage, PROTOCOL_VERSION, RELAY_URLS, sanitizePresence,
    type WatchActionMessage
} from "@plugins/telinha/protocol";
import { settings } from "@plugins/telinha/settings";
import { resetState } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import { ChannelStore, FluxDispatcher, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";
import { getRelaySockets, type HandshakeReceiver, type HandshakeSender, joinRoom, type JsonValue } from "trystero";

import { probeLocalCaps } from "./codec";
import { getPc, type PeerEntry, peerLabel, publish, rt, setLastError } from "./context";
import { getLocalIdToken, type PreparedIdentity, prepareIdentity, type RemoteIdentity, renewIdentity, subscribeLocalIdentity, verifyRemoteIdentity } from "./identity";
import { isIdentityConfigured } from "./identity/config";
import { type DuplicateCandidate, type DuplicateGroup, findDuplicates, IDENTITY_FAILURE_TEXT, initialPeerIdentity, nextPeerIdentity, type PeerIdentity } from "./identity/policy";
import { errorText, log, logThrottled, shortId } from "./log";
import { getNativeOrNull } from "./nativeApi";
import { getPeerConnectionClass, setPcHooks } from "./peerConnection";
import { computeAdmitted, me, selfHello, sendPresence } from "./presence";
import * as streaming from "./streaming";
import * as viewing from "./viewing";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const RELAY_CHECK_MS = 10_000;
const PASSWORD_DEBOUNCE_MS = 800;
/** preparar o certificado/token antes de entrar na sala nunca pode segurar a entrada (IndexedDB travado...) */
const IDENTITY_PREPARE_TIMEOUT_MS = 3000;
/** verificacao de um peer (JWKS na rede + estatisticas da conexao): passou disto, fica "nao verificado" */
const IDENTITY_CHECK_TIMEOUT_MS = 10_000;
/** fingerprint DTLS ainda indisponivel logo no onPeerJoin: confere mais uma vez depois disto */
const IDENTITY_RETRY_MS = 1500;
/** acao "identity" do mesmo peer: no maximo uma verificacao neste intervalo */
const IDENTITY_RENEWAL_MIN_MS = 10_000;
const NO_IDENTITY: PreparedIdentity = { certificates: [], fingerprint: null };

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
/** id_token que cada peer ja recebeu de nos nesta sala (hello ou acao "identity"): nunca o mesmo duas vezes */
const announcedTo = new Map<PeerId, string>();
let unsubscribeIdentity: (() => void) | null = null;

// #region admissao

function isInMyVoiceChannel(userId: string) {
    const channel = rt.channelId;
    if (!channel || !userId) return false;
    const states = VoiceStateStore.getVoiceStatesForChannel(channel) ?? {};
    return Object.prototype.hasOwnProperty.call(states, userId);
}

/** Reavalia quem esta no canal de voz / a politica de admissao. Chamado em mudancas de voz, da opcao e da identidade. */
function reevaluateAdmission() {
    let changed = false;
    for (const p of rt.peers.values()) {
        if (p.incompatible || !p.hello) continue;
        const inVoice = isInMyVoiceChannel(p.hello.discordUserId);
        const wasInVoice = p.inVoice;
        const wasAdmitted = p.admitted;
        p.inVoice = inVoice;
        p.admitted = computeAdmitted(p);
        if (p.admitted === wasAdmitted) continue;
        changed = true;
        if (p.admitted) {
            log.info(`${peerLabel(p.peerId)} agora está admitido${inVoice && !wasInVoice ? " (entrou no seu canal de voz)" : ""}`);
            sendPresence(p.peerId);
        } else {
            const why = p.identity === "invalid" && isIdentityConfigured() ? " (prova de identidade falsa)" : inVoice ? "" : " (fora do seu canal de voz)";
            log.info(`${peerLabel(p.peerId)} não está mais admitido${why}`);
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
 * Conexoes vivas dizendo ter o mesmo discordUserId (regras em identity/policy.ts → findDuplicates):
 * - sem prova de identidade (ou sem Client ID): uma pode ser falsa, todas ficam marcadas;
 * - se uma delas PROVOU a identidade, so as nao verificadas ficam marcadas (sao as impostoras);
 * - verificada nunca e marcada (duas verificadas = a mesma pessoa em dois PCs).
 * Quem fica marcado e estava recebendo a transmissao para de receber (streaming.onIdentityConflict) e nada
 * volta sozinho quando o conflito some: a pessoa precisa pedir para assistir de novo.
 * Chamado na entrada/saida de peers, quando uma identidade e conferida e a cada segundo (o estado das
 * conexoes muda sem evento da sala).
 */
function checkIdentities() {
    const candidates: DuplicateCandidate[] = [];
    for (const p of rt.peers.values()) {
        if (p.incompatible || !p.hello) continue;
        candidates.push({ peerId: p.peerId, discordUserId: p.hello.discordUserId, identity: p.identity, live: isLive(p.peerId) });
    }
    const groups = findDuplicates(candidates, isIdentityConfigured());
    const groupOf = new Map<PeerId, DuplicateGroup>();
    for (const g of groups) for (const id of g.flagged) groupOf.set(id, g);

    const started: PeerEntry[] = [];
    const resolved = new Set<string>();
    let changed = false;
    for (const p of rt.peers.values()) {
        const g = groupOf.get(p.peerId);
        const dup = !!g;
        const impostor = !!g?.verified.length;
        if (dup === p.duplicate && impostor === p.impostor) continue;
        changed = true;
        const was = p.duplicate;
        p.duplicate = dup;
        p.impostor = impostor;
        if (dup && !was) started.push(p);
        else if (!dup && was && p.hello) resolved.add(p.hello.discordUserId);
    }
    if (!changed) return;

    const startedIds = new Set(started.map(p => p.peerId));
    for (const g of groups) {
        if (!g.flagged.some(id => startedIds.has(id))) continue;
        const name = rt.peers.get(g.flagged[0])?.hello?.username ?? "?";
        const ids = g.flagged.map(shortId).join(", ");
        if (g.verified.length) {
            const n = g.flagged.length;
            log.warn(`${n === 1 ? "Uma conexão não verificada" : `${n} conexões não verificadas`} (${ids}) ${n === 1 ? "diz" : "dizem"} ser ${name} (discord ${g.discordUserId}), que provou a identidade em ${g.verified.map(shortId).join(", ")}: só ${n === 1 ? "a não verificada fica bloqueada" : "as não verificadas ficam bloqueadas"}.`);
        } else {
            log.warn(`Duas conexões dizem ser ${name} (discord ${g.discordUserId}): ${ids} — uma pode ser falsa. Nenhuma recebe a sua transmissão enquanto isso durar.`);
        }
    }
    for (const id of resolved) {
        if (groups.some(g => g.discordUserId === id)) continue;
        log.info(`Conflito de identidade do discord ${id} acabou (uma das conexões saiu ou provou a identidade). Quem quiser assistir precisa pedir de novo.`);
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
        let identity = NO_IDENTITY;
        if (isIdentityConfigured()) {
            // o certificado precisa estar pronto ANTES do joinRoom: o Trystero cria ofertas logo na entrada
            identity = await withTimeout(prepareIdentity(), IDENTITY_PREPARE_TIMEOUT_MS, NO_IDENTITY);
            if (seq !== joinSeq || !active) return;
            // so faz algo se ja autorizou e o token falta/esta vencendo (refresh_token; modal "none" no maximo 1x/24 h)
            renewIdentity({ interactive: true }).catch(e => log.warn("Identidade: renovação falhou: " + errorText(e)));
        }
        joinNow(roomId, reason, identity);
    } catch (e) {
        log.error("Falha ao entrar na sala: " + errorText(e));
        setLastError("Não foi possível entrar na sala do Telinha: " + errorText(e));
    }
}

function joinNow(roomId: string, reason: string, identity: PreparedIdentity) {
    const password = settings.store.groupPassword || undefined;
    log.info(`Entrando na sala ${roomId.slice(0, 12)}… (${reason}${password ? ", com senha" : ""})`);

    // antes do joinRoom: o hello (selfHello) so leva o token amarrado a este certificado
    rt.certFingerprint = identity.fingerprint;
    const room = joinRoom(
        {
            appId: APP_ID,
            password,
            relayConfig: { urls: RELAY_URLS },
            // certificado DTLS persistente em TODAS as conexoes (o nonce do id_token aponta para ele); sem ele, o do Chromium
            rtcConfig: { iceServers: ICE_SERVERS, ...(identity.certificates.length ? { certificates: identity.certificates } : {}) },
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
    if (isIdentityConfigured()) {
        rt.identityAction = room.makeAction<IdentityMessage>(ACTION_IDENTITY);
        rt.identityAction.onMessage = onIdentity;
    }
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
    rt.presenceAction = rt.watchAction = rt.identityAction = null;
    rt.certFingerprint = null;
    rt.peers.clear();
    helloByPeer.clear();
    selfClaims.clear();
    announcedTo.clear();
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
    const own = selfHello();
    await send(own);
    if (own.idToken) announcedTo.set(peerId, own.idToken);
    const { data } = await receive();

    // parseHello nunca lanca e so copia campos conhecidos (o idToken e conferido depois, no onPeerJoin)
    const hello = parseHello(data);
    if (!hello || hello.v !== PROTOCOL_VERSION) {
        helloByPeer.set(peerId, null);
        const v = data && typeof data === "object" && "v" in data ? ` (v${String((data as Record<string, unknown>).v)})` : "";
        logThrottled(`hs-bad:${peerId}`, "warn", `Peer ${shortId(peerId)} usa outra versão do Telinha${v}; ignorado`, 60_000);
        return;
    }
    if (hello.discordUserId === me().id) {
        // guardado so para o alerta "uma conexão diz ser você"; o peer fica incompativel (nunca e aceito)
        selfClaims.add(peerId);
        helloByPeer.set(peerId, withoutToken(hello));
        logThrottled(`hs-self:${peerId}`, "warn", `Peer ${shortId(peerId)} diz ser você (discord ${hello.discordUserId}): pode ser alguém tentando se passar por você; ignorado`, 60_000);
        return;
    }
    helloByPeer.set(peerId, hello);
}

/** O hello sem o id_token: o token so serve para a verificacao e nao fica guardado no estado da sessao. */
function withoutToken(hello: HelloMessage): HelloMessage {
    return { type: hello.type, v: hello.v, discordUserId: hello.discordUserId, username: hello.username };
}

function onPeerJoin(peerId: PeerId) {
    const received = helloByPeer.get(peerId) ?? null;
    const claimsSelf = selfClaims.has(peerId);
    const configured = isIdentityConfigured();
    const idToken = configured && received && !claimsSelf ? received.idToken : undefined;
    const hello = received && withoutToken(received);
    if (received) helloByPeer.set(peerId, hello);
    const entry: PeerEntry = {
        peerId,
        hello,
        presence: null,
        inVoice: hello && !claimsSelf ? isInMyVoiceChannel(hello.discordUserId) : false,
        incompatible: !hello || claimsSelf,
        admitted: false,
        duplicate: false,
        impostor: false,
        claimsSelf,
        identity: initialPeerIdentity({ configured, hasToken: !!idToken }),
        ...(configured && hello && !claimsSelf && !idToken ? { identityReason: "missing" as const } : {}),
        identityChecking: false,
        identityCheckedAt: 0
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

    if (idToken && entry.identity === "pending") {
        // so depois do DTLS conectado (o handshake do Trystero ja rodou pelo data channel) e antes de admitir:
        // presenca e transmissao so vao para admitidos
        log.info(`${peerLabel(peerId)} entrou na sala; conferindo a identidade do Discord…`);
        void checkPeerIdentity(peerId, idToken, true);
    } else if (entry.admitted) {
        log.info(`${peerLabel(peerId)} entrou na sala${entry.inVoice ? "" : " (fora do seu canal de voz, aceito porque a recusa está desligada)"}`);
        sendPresence(peerId);
    } else {
        logThrottled(`outsider:${hello.discordUserId}`, "warn", `${peerLabel(peerId)} (discord ${hello.discordUserId}) entrou na sala, mas não está no seu canal de voz: ignorado`);
    }
    // o nosso token pode ter ficado pronto depois que o hello para este peer saiu
    if (configured) announceLocalIdentity();
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
    announcedTo.delete(peerId);
    checkIdentities();
    publish();
}

/** Apresentou prova de identidade falsa: nada que venha dela e ouvido, e ela nao recebe nada. */
function isFake(entry: PeerEntry) {
    return entry.identity === "invalid" && isIdentityConfigured();
}

function onPresence(data: PresenceMessage, { peerId }: { peerId: string; }) {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible || isFake(entry)) return;
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
    // dado do peer e hostil: so campos conhecidos (parse*), e nada lanca para fora do handler do Trystero
    try {
        const entry = rt.peers.get(peerId);
        if (!entry?.hello || entry.incompatible || isFake(entry)) return;
        const request = parseWatchRequest(data);
        if (request) {
            streaming.onWatchRequest(peerId, request);
            return;
        }
        // resposta do transmissor a um pedido nosso (pending/denied/password); so mexe na sessao que assiste esse peer
        const reply = parseWatchReply(data);
        if (reply) viewing.onWatchReply(peerId, reply);
    } catch (e) {
        logThrottled(`watch-msg:${peerId}`, "warn", `Mensagem "watch" de ${peerLabel(peerId)} ignorada: ${errorText(e)}`);
    }
}

function onPeerStream(stream: MediaStream, peerId: string, metadata?: JsonValue) {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible || isFake(entry)) return;
    viewing.onPeerStream(peerId, stream, metadata);
}

// #endregion

// #region prova de identidade dos peers (docs/identity.md)

const CHECK_TIMED_OUT: RemoteIdentity = { verdict: "unverified", result: { ok: false, reason: "timeout" } };

/** A promessa, ou `fallback` se ela demorar mais que `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            e => {
                clearTimeout(timer);
                reject(e);
            }
        );
    });
}

/** Ultimas falhas de verificacao (diagnostico: nunca tokens nem IPs). */
const identityFailures: { at: number; peer: string; name: string; verdict: PeerIdentity; reason: string; }[] = [];

function noteIdentityFailure(entry: PeerEntry, verdict: PeerIdentity, reason: string) {
    identityFailures.push({ at: Date.now(), peer: shortId(entry.peerId), name: entry.hello?.username ?? "?", verdict, reason });
    if (identityFailures.length > 10) identityFailures.splice(0, identityFailures.length - 10);
}

/**
 * Confere o id_token que o peer mandou (hello ou acao "identity") contra o certificado DTLS que ele usou
 * NESTA conexao. Nunca lanca (dado do peer e hostil; uma excecao aqui so viraria log). `retry`: com o
 * fingerprint ainda indisponivel, confere mais uma vez em IDENTITY_RETRY_MS.
 */
async function checkPeerIdentity(peerId: PeerId, idToken: string, retry: boolean): Promise<void> {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible || entry.identityChecking || !isIdentityConfigured()) return;
    entry.identityChecking = true;
    entry.identityCheckedAt = Date.now();
    let remote: RemoteIdentity;
    try {
        const check = verifyRemoteIdentity({ pc: getPc(peerId), idToken, claimedUserId: entry.hello.discordUserId });
        remote = await withTimeout(check, IDENTITY_CHECK_TIMEOUT_MS, CHECK_TIMED_OUT);
    } catch (e) {
        logThrottled("identity-check-error", "warn", "Identidade: erro ao conferir um peer: " + errorText(e));
        remote = CHECK_TIMED_OUT;
    } finally {
        entry.identityChecking = false;
    }
    if (rt.peers.get(peerId) !== entry) return; // saiu, ou a sala mudou no meio

    if (retry && !remote.result.ok && remote.result.reason === "no-fingerprint" && entry.identity === "pending") {
        setTimeout(() => void checkPeerIdentity(peerId, idToken, false), IDENTITY_RETRY_MS);
        return;
    }
    try {
        applyPeerIdentity(entry, remote);
    } catch (e) {
        log.warn("Identidade: erro ao aplicar a verificação de um peer: " + errorText(e));
    }
}

function applyPeerIdentity(entry: PeerEntry, remote: RemoteIdentity) {
    const { hello, peerId } = entry;
    if (!hello) return;
    const before = entry.identity;
    const next = nextPeerIdentity(before, remote.verdict);
    const reason = remote.result.ok ? undefined : remote.result.reason;
    const why = reason ? IDENTITY_FAILURE_TEXT[reason] : "";
    if (next === before) {
        // verificada continua verificada (renovacao ruim nao rebaixa); falsa continua falsa
        if (before === "verified" && reason) log.info(`${peerLabel(peerId)}: prova de identidade renovada não conferiu (${why}); continua verificada nesta conexão`);
        if (before === "unverified" && reason) {
            entry.identityReason = reason;
            noteIdentityFailure(entry, next, reason);
        }
        return;
    }
    entry.identity = next;
    entry.identityReason = reason;

    if (next === "verified") {
        log.info(`${peerLabel(peerId)}: identidade do Discord verificada`);
    } else if (next === "unverified") {
        log.info(`${peerLabel(peerId)}: identidade do Discord não verificada (${why})`);
        noteIdentityFailure(entry, next, reason ?? "?");
    } else if (next === "invalid") {
        noteIdentityFailure(entry, next, reason ?? "?");
        // uma vez por conexao (e no maximo 1x/10 min por conta anunciada, se a conexao ficar voltando)
        logThrottled(`id-fake:${hello.discordUserId}`, "warn",
            `Uma conexão (${shortId(peerId)}) apresentou uma prova de identidade falsa de ${hello.username} (discord ${hello.discordUserId}): ${why}. `
            + "Pode ser alguém se passando por essa pessoa: ela não vê sua presença, não recebe sua transmissão nem respostas.", 10 * 60_000);
        entry.presence = null;
        viewing.onIdentityInvalid(peerId);
    }
    checkIdentities();
    reevaluateAdmission();
    streaming.reviewPendingApprovals();
    publish();
}

/** Acao "identity": token novo/renovado de um peer (ele autorizou o Telinha no meio da call). */
function onIdentity(data: IdentityMessage, { peerId }: { peerId: string; }) {
    try {
        if (!isIdentityConfigured() || !isIdentityMessage(data)) return;
        const entry = rt.peers.get(peerId);
        if (!entry?.hello || entry.incompatible) return;
        // verificada fica ate a conexao cair; falsa nao ganha outra chance nesta conexao
        if (entry.identity === "verified" || entry.identity === "invalid") return;
        if (entry.identityChecking || Date.now() - entry.identityCheckedAt < IDENTITY_RENEWAL_MIN_MS) return;
        void checkPeerIdentity(peerId, data.idToken, true);
    } catch (e) {
        logThrottled("identity-msg", "warn", "Identidade: mensagem de identidade ignorada: " + errorText(e));
    }
}

/**
 * O nosso token ficou pronto/mudou: manda para todo peer compativel que ainda nao o recebeu (nao so os
 * admitidos: eles precisam do nosso token para NOS admitir). Uma mensagem por token novo por peer.
 */
function announceLocalIdentity() {
    const action = rt.identityAction;
    if (!action || !rt.room) return;
    try {
        const idToken = getLocalIdToken({ fingerprint: rt.certFingerprint });
        if (!idToken) return;
        const targets = [...rt.peers.values()]
            .filter(p => p.hello && !p.incompatible && !isFake(p) && announcedTo.get(p.peerId) !== idToken)
            .map(p => p.peerId);
        if (!targets.length) return;
        for (const id of targets) announcedTo.set(id, idToken);
        action.send({ idToken }, { target: targets })
            .catch(e => logThrottled("identity-send", "warn", "Falha ao enviar a prova de identidade: " + errorText(e)));
    } catch (e) {
        logThrottled("identity-announce", "warn", "Identidade: falha ao anunciar o token: " + errorText(e));
    }
}

const IDENTITY_TEXT: Record<PeerIdentity, string> = {
    pending: "conferindo",
    verified: "verificado",
    unverified: "não verificado",
    invalid: "identidade falsa"
};

/** Linhas do "Copiar diagnóstico" sobre os peers. Sem tokens nem IPs. Vazio sem Client ID. */
export function peerIdentityDiagnostics(): string {
    if (!isIdentityConfigured()) return "";
    const time = (at: number) => new Date(at).toISOString().slice(11, 19);
    const peers = [...rt.peers.values()]
        .filter(p => p.hello && !p.claimsSelf && !p.incompatible)
        .map(p => `${p.hello!.username} (${shortId(p.peerId)})=${IDENTITY_TEXT[p.identity]}${p.identityReason && p.identity !== "verified" ? ` [${p.identityReason}]` : ""}${p.impostor ? " (impostor)" : ""}`);
    return [
        `exigir identidade verificada: ${settings.store.requireVerifiedIdentity !== false ? "sim" : "não"}`,
        `identidade dos peers: ${peers.join(", ") || "nenhum"}`,
        `últimas falhas de verificação: ${identityFailures.map(f => `${time(f.at)} ${f.name} (${f.peer}) ${IDENTITY_TEXT[f.verdict]} [${f.reason}]`).join("; ") || "nenhuma"}`
    ].join("\n");
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

    if (isIdentityConfigured()) {
        // token novo/renovado no meio da sala: os peers ja conectados recebem pela acao "identity"
        unsubscribeIdentity = subscribeLocalIdentity(() => announceLocalIdentity());
        // carrega o estado local (aviso na barra e pagina do plugin) sem esperar a primeira call
        prepareIdentity().catch(e => log.warn("Identidade: falha ao carregar: " + errorText(e)));
    }

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
    unsubscribeIdentity?.();
    unsubscribeIdentity = null;
    identityFailures.length = 0;

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
