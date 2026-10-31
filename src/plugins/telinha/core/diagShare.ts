/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Diagnostico compartilhado (protocol.ts, passo 9; opcao "Compartilhar diagnóstico para ajudar a depurar"). Com a opcao
// ligada nas duas pontas, quem esta na mesma call (admitido, no canal de voz, identidade do Discord verificada) pode
// pedir o registro do Telinha deste PC, sem precisar pedir para a pessoa reproduzir o problema e colar o "Copiar
// diagnóstico". Os dois papeis ficam aqui:
// - quem manda: ao receber "subscribe" de quem passa nas regras (diagEligible), manda o fim da sessao anterior (o
//   registro em arquivo, core/diagLog.ts, que so grava com a opcao ligada), o mesmo texto do "Copiar diagnóstico" e,
//   dali em diante, cada linha nova do log do Telinha (core/log.ts → store.ts subscribeEvents), no maximo
//   DIAG_MAX_LINES_PER_SECOND por segundo (no tick da sessao). Nunca pergunta nem mostra aviso: so a linha
//   "Enviando diagnóstico para ..." na pagina do plugin e uma linha no log;
// - quem pede: "Receber diagnóstico" (pagina do plugin) manda "subscribe" a cada conexao dessa pessoa que passa nas
//   regras e escreve as linhas que chegam no console, com o prefixo "[Telinha] [diag <nome>]" (vai para o
//   renderer_js.log do Discord, que e onde o desenvolvedor le).
// Tudo o que sai daqui passa por maskPrivate (sem IPs, pasta do usuario nem tokens) e e cortado em DIAG_MAX_LINE_CHARS.
// As regras sao conferidas de novo a cada segundo: quem sai da sala ou do canal, perde a caps.diag ou deixa de passar
// nas regras para de receber (e de pedir) sozinho. Nada roda no carregamento do modulo.

import {
    DIAG_MAX_LINE_CHARS, DIAG_MAX_LINES_PER_MESSAGE, DIAG_MAX_LINES_PER_SECOND, type DiagLevel, type DiagLine, type DiagMessage
} from "@plugins/telinha/protocol";
import { settings } from "@plugins/telinha/settings";
import { formatDiagnostics, subscribeEvents, type TelinhaEvent } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import type { MessageAction } from "trystero";

import { type DiagSubscriber, type PeerEntry, peerLabel, publish, rt } from "./context";
import { clearDiagLog, readPreviousSession, startDiagLog, stopDiagLog, type StoredLine } from "./diagLog";
import { isIdentityConfigured } from "./identity/config";
import { errorText, log, logThrottled, maskPrivate, shortId } from "./log";
import { sendPresence } from "./presence";

/** O texto do "Copiar diagnóstico" (index.tsx registra o completo com setDiagnosticsSource; sem ele, o do store). */
export interface DiagnosticsSource {
    /** le o que o texto precisa do processo main (status da atualizacao, main.log) */
    refresh(): Promise<unknown>;
    /** o texto, na hora */
    format(): string;
}

/** O "Copiar diagnóstico" completo sai de novo para a mesma pessoa no maximo uma vez neste intervalo (o resto: so ao vivo). */
export const DIAG_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
/** espera maxima pelo refresh do texto do "Copiar diagnóstico" (o processo main pode estar ocupado) */
export const DIAG_REFRESH_TIMEOUT_MS = 5000;
/** linhas do texto do "Copiar diagnóstico" mandadas no maximo (o texto tem ~450) */
export const DIAG_MAX_SNAPSHOT_LINES = 1000;
/** linhas novas guardadas ate o proximo envio; o que sai desta janela antes de ir conta como descartado */
export const DIAG_LIVE_BUFFER_LINES = 300;
/** limite de recepcao (quem pede): um balde de DIAG_RECEIVE_BURST linhas que enche DIAG_RECEIVE_PER_SECOND por segundo */
export const DIAG_RECEIVE_BURST = 3000;
export const DIAG_RECEIVE_PER_SECOND = 60;
/** mensagens esperando o canal, por conexao (a primeira parte tem no maximo 8); alem disso, as linhas so contam em dropped */
export const DIAG_MAX_QUEUED_MESSAGES = 10;

const OFF_HERE = "\"Compartilhar diagnóstico\" desligado aqui";

let active = false;
let source: DiagnosticsSource = { refresh: () => Promise.resolve(), format: () => formatDiagnostics() };
let offEvents: (() => void) | null = null;
/** numero da ultima linha do log vista */
let seq = 0;
/** as linhas do log desde que alguem passou a receber (no maximo DIAG_LIVE_BUFFER_LINES) */
const live: { seq: number; event: TelinhaEvent; }[] = [];
/** discordUserId → Date.now() do ultimo "Copiar diagnóstico" completo mandado */
const lastSnapshotAt = new Map<string, number>();

const shareOn = () => settings.store.shareDiagnostics === true;

/** O texto completo do "Copiar diagnóstico" (index.tsx, no start do plugin). */
export function setDiagnosticsSource(next: DiagnosticsSource) {
    source = next;
}

// #region texto e hora

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Hora local "HH:MM:SS.mmm". */
export function localTime(at: number): string {
    const d = new Date(at);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Data e hora local "AAAA-MM-DD HH:MM:SS.mmm". */
export function localDateTime(at: number): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${localTime(at)}`;
}

/**
 * Uma linha que pode sair deste PC: numa linha so, sem caracteres de controle, sem dados privados (maskPrivate: IPs, pasta
 * do usuario, ids do Discord, nome da janela capturada, tokens), no maximo DIAG_MAX_LINE_CHARS. Sem caracteres de controle
 * (que o JSON escreve com 6 bytes), uma mensagem de 200 linhas fica abaixo de ~620 KB (session.ts → MAX_RECEIVE_BYTES).
 */
export function diagText(text: string): string {
    const clean = maskPrivate(text.replace(/\r?\n/g, " ⏎ ").replace(/\p{Cc}+/gu, " "));
    return clean.length > DIAG_MAX_LINE_CHARS ? clean.slice(0, DIAG_MAX_LINE_CHARS - 1) + "…" : clean;
}

const diagLine = (at: number, level: DiagLevel, text: string): DiagLine => ({ t: localTime(at), level, text: diagText(text) });

/** Nome no prefixo do console de quem pede: so letras sem acento, numeros, "_", "." e "-" (ate 32). */
export function diagName(username: string): string {
    return username.replace(/[^\w.-]+/g, "_").slice(0, 32) || "?";
}

/**
 * Uma linha recebida, no console de quem pede: "[Telinha] [diag <nome>] <hora de la> (aqui <hora daqui>) <nivel> <texto>".
 * O prefixo e fixo para o grep no renderer_js.log; caracteres de controle viram espaco.
 */
export function formatDiagReceived(name: string, line: DiagLine, at: number): string {
    return `[Telinha] [diag ${name}] ${line.t} (aqui ${localTime(at)}) ${line.level} ${line.text.replace(/\p{Cc}+/gu, " ")}`;
}

// #endregion

// #region regras

/** Por que essa conexao nao pode pedir nem mandar o diagnostico; null = pode. */
function whyNotEligible(entry: PeerEntry | undefined): string | null {
    if (!entry) return "saiu da sala";
    if (!entry.hello || entry.incompatible) return "conexão incompatível";
    if (!entry.inVoice) return "fora do seu canal de voz";
    if (!entry.admitted) return "não admitido na sala";
    if (!isIdentityConfigured() || entry.identity !== "verified") return "identidade do Discord não verificada";
    if (entry.presence?.caps.diag !== true) return "\"Compartilhar diagnóstico\" desligado do lado de lá";
    return null;
}

/**
 * As regras das duas pontas (quem manda confere quem pede, e vice-versa): conexao compativel, no nosso canal de voz,
 * admitida, com a identidade do Discord verificada e com "Compartilhar diagnóstico" ligado do lado de la (caps.diag).
 */
export function diagEligible(entry: PeerEntry | undefined): boolean {
    return whyNotEligible(entry) === null;
}

// #endregion

function send(action: MessageAction<DiagMessage>, peerId: PeerId, msg: DiagMessage): Promise<void> {
    return action.send(msg, { target: peerId });
}

// #region quem manda

/** Linha do log: guardada so enquanto alguem recebe (o "Copiar diagnóstico" cobre o que veio antes). O listener nao loga. */
function onEvent(event: TelinhaEvent) {
    seq++;
    if (!rt.diagSending.size) return;
    live.push({ seq, event });
    if (live.length > DIAG_LIVE_BUFFER_LINES) live.splice(0, live.length - DIAG_LIVE_BUFFER_LINES);
}

/**
 * Envios para a mesma conexao saem em ordem (a primeira parte pode ser mais de uma mensagem). Com DIAG_MAX_QUEUED_MESSAGES
 * na fila (o canal nao anda), a mensagem nova fica de fora e as linhas dela vao no `dropped` da proxima que couber.
 */
function enqueue(sub: DiagSubscriber, lines: DiagLine[], dropped = 0) {
    if (sub.queued >= DIAG_MAX_QUEUED_MESSAGES) {
        sub.dropped += lines.length + dropped;
        return;
    }
    const total = dropped + sub.dropped;
    sub.dropped = 0;
    sub.queued++;
    const msg: DiagMessage = { op: "lines", lines, ...(total ? { dropped: total } : {}) };
    sub.chain = sub.chain
        .then(() => {
            // parou de receber enquanto a mensagem esperava a vez. Recebendo, a sala (e a acao) existe: leaveRoom tira
            // todo mundo de rt.diagSending antes de soltar a acao
            if (rt.diagSending.get(sub.peerId) !== sub) return;
            return send(rt.diagAction as MessageAction<DiagMessage>, sub.peerId, msg);
        })
        .catch(e => logThrottled("diag-send", "warn", `Falha ao enviar o diagnóstico para ${sub.username}: ${errorText(e)}`, 60_000))
        .then(() => {
            sub.queued--;
        });
}

function enqueueLines(sub: DiagSubscriber, lines: DiagLine[]) {
    for (let i = 0; i < lines.length; i += DIAG_MAX_LINES_PER_MESSAGE) enqueue(sub, lines.slice(i, i + DIAG_MAX_LINES_PER_MESSAGE));
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>(resolve => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(value => {
            clearTimeout(timer);
            resolve(value);
        }, () => {
            clearTimeout(timer);
            resolve(fallback);
        });
    });
}

/** O texto do "Copiar diagnóstico", uma linha por linha (no maximo DIAG_MAX_SNAPSHOT_LINES). */
function snapshotLines(text: string): DiagLine[] {
    const now = Date.now();
    const all = text.split(/\r?\n/);
    const lines = all.slice(0, DIAG_MAX_SNAPSHOT_LINES).map(l => diagLine(now, "info", l));
    if (all.length > DIAG_MAX_SNAPSHOT_LINES) lines.push(diagLine(now, "warn", `(+${all.length - DIAG_MAX_SNAPSHOT_LINES} linhas do diagnóstico ficaram de fora)`));
    return lines;
}

/** O fim da sessao anterior, entre marcadores (ou uma linha dizendo que nao ha nada guardado). */
function previousLines(previous: StoredLine[] | null): DiagLine[] {
    const now = Date.now();
    if (!previous?.length) return [diagLine(now, "info", "--- sessão anterior: nada guardado neste PC (o registro em arquivo só grava com a opção ligada) ---")];
    return [
        diagLine(now, "info", `--- sessão anterior: as últimas ${previous.length} linhas do registro deste PC ---`),
        ...previous.map(l => ({ t: localDateTime(l.at), level: l.level, text: diagText(l.text) })),
        diagLine(now, "info", "--- fim da sessão anterior; agora, o \"Copiar diagnóstico\" desta sessão ---")
    ];
}

/**
 * A primeira parte, antes das linhas novas: o fim da sessao anterior e o texto do "Copiar diagnóstico" (depois de ler
 * do main o que eles precisam).
 * As linhas que entram no log enquanto isso esperam na janela e saem depois, no tick: as que o texto ja trouxe ficam
 * de fora (sentSeq no momento do texto). Pedido repetido em menos de DIAG_SNAPSHOT_MIN_INTERVAL_MS: so ao vivo.
 */
async function sendFirstPart(sub: DiagSubscriber) {
    const now = Date.now();
    const last = lastSnapshotAt.get(sub.discordUserId);
    let lines: DiagLine[];
    if (last !== undefined && now - last < DIAG_SNAPSHOT_MIN_INTERVAL_MS) {
        sub.sentSeq = seq;
        lines = [diagLine(now, "info", `--- o diagnóstico completo saiu há ${Math.round((now - last) / 1000)} s: daqui em diante, só as linhas novas ---`)];
    } else {
        const [previous] = await Promise.all([
            withTimeout(readPreviousSession(), DIAG_REFRESH_TIMEOUT_MS, null),
            withTimeout(source.refresh(), DIAG_REFRESH_TIMEOUT_MS, null)
        ]);
        if (rt.diagSending.get(sub.peerId) !== sub) return;
        let text: string;
        try {
            text = source.format();
        } catch (e) {
            text = "diagnóstico indisponível: " + errorText(e);
        }
        sub.sentSeq = seq;
        lines = [...previousLines(previous), ...snapshotLines(text), diagLine(Date.now(), "info", "--- ao vivo: cada linha nova do Telinha deste PC a partir daqui ---")];
        // so conta como enviado o que vai mesmo para a fila (um pedido cancelado no meio nao segura o proximo)
        lastSnapshotAt.set(sub.discordUserId, Date.now());
    }
    enqueueLines(sub, lines);
    sub.ready = true;
}

function onSubscribe(peerId: PeerId) {
    if (rt.diagSending.has(peerId)) return;
    if (!shareOn()) {
        logThrottled(`diag-off:${peerId}`, "info", `${peerLabel(peerId)} pediu o diagnóstico deste PC, mas ${OFF_HERE}: ignorado`, 60_000);
        return;
    }
    const entry = rt.peers.get(peerId);
    const why = whyNotEligible(entry);
    if (why !== null) {
        logThrottled(`diag-refused:${peerId}`, "warn", `Pedido de diagnóstico de ${peerLabel(peerId)} ignorado: ${why}`, 60_000);
        return;
    }
    // passou nas regras: a conexao existe e tem hello
    const { hello, presence } = entry!;
    const sub: DiagSubscriber = {
        peerId,
        discordUserId: hello!.discordUserId,
        username: presence!.username,
        ready: false,
        sentSeq: seq,
        chain: Promise.resolve(),
        queued: 0,
        dropped: 0
    };
    rt.diagSending.set(peerId, sub);
    log.info(`Enviando o diagnóstico deste PC para ${peerLabel(peerId)} (pedido pelo "Compartilhar diagnóstico", ligado aqui)`);
    publish();
    void sendFirstPart(sub);
}

function stopSending(peerId: PeerId, reason: string) {
    const sub = rt.diagSending.get(peerId);
    if (!sub) return;
    rt.diagSending.delete(peerId);
    log.info(`Parou de enviar o diagnóstico para ${sub.username} (${shortId(peerId)}): ${reason}`);
    publish();
}

/** Quem recebe e nao passa mais nas regras (saiu do canal, desligou a opcao la...) para de receber. */
function reviewSending() {
    for (const sub of [...rt.diagSending.values()]) {
        const why = shareOn() ? whyNotEligible(rt.peers.get(sub.peerId)) : OFF_HERE;
        if (why) stopSending(sub.peerId, why);
    }
}

/** As linhas novas desde o ultimo envio, para cada conexao que ja recebeu a primeira parte (no maximo DIAG_MAX_LINES_PER_SECOND). */
function flushLive() {
    if (!rt.diagSending.size) {
        live.length = 0;
        return;
    }
    for (const sub of rt.diagSending.values()) {
        if (!sub.ready) continue;
        const pending = live.filter(l => l.seq > sub.sentSeq);
        // as que sairam da janela antes de ir
        const lost = (pending.length ? pending[0].seq : seq + 1) - sub.sentSeq - 1;
        const lines = pending.slice(0, DIAG_MAX_LINES_PER_SECOND).map(({ event }) => diagLine(event.at, event.level, event.msg));
        const dropped = lost + pending.length - lines.length;
        sub.sentSeq = seq;
        // sub.dropped: o que ficou de fora da fila cheia sai assim que ela andar, mesmo sem linha nova
        if (lines.length || dropped || sub.dropped) enqueue(sub, lines, dropped);
    }
}

// #endregion

// #region quem pede

/**
 * "Receber diagnóstico" (pagina do plugin). Ligado: cada conexao dessa pessoa que passa nas regras recebe "subscribe",
 * agora e quando voltar (ex.: ela reabriu o Discord), ate desligar, sair da call ou desligar "Compartilhar diagnóstico".
 * Com a opcao desligada aqui, ligar nao faz nada.
 */
export function setDiagRequest(discordUserId: string, username: string, on: boolean): void {
    if (on) {
        if (!shareOn() || rt.diagRequested.has(discordUserId)) return;
        rt.diagRequested.set(discordUserId, username);
    } else if (!rt.diagRequested.delete(discordUserId)) {
        return;
    }
    reconcileRequests();
    publish();
}

/**
 * Manda "subscribe"/"unsubscribe" conforme os pedidos e as regras (no tick e quando um pedido muda). Fora de uma sala
 * nao ha o que mandar: o pedido fica guardado ate a proxima (leaveRoom ja esqueceu as conexoes da anterior).
 */
function reconcileRequests() {
    const action = rt.diagAction;
    if (!action) return;
    for (const s of [...rt.diagReceiving.values()]) {
        const entry = rt.peers.get(s.peerId);
        const why = !shareOn() ? OFF_HERE
            : !rt.diagRequested.has(s.discordUserId) ? "você desligou \"Receber diagnóstico\""
                : whyNotEligible(entry);
        if (!why) continue;
        rt.diagReceiving.delete(s.peerId);
        if (entry) send(action, s.peerId, { op: "unsubscribe" }).catch(e => logThrottled("diag-unsub", "warn", "Falha ao parar o diagnóstico: " + errorText(e), 60_000));
        log.info(`Parou de receber o diagnóstico de ${s.username} (${shortId(s.peerId)}): ${why}`);
        publish();
    }
    if (!shareOn() || !rt.diagRequested.size) return;
    for (const entry of rt.peers.values()) {
        const id = entry.hello?.discordUserId;
        if (!id || !rt.diagRequested.has(id) || rt.diagReceiving.has(entry.peerId) || !diagEligible(entry)) continue;
        rt.diagReceiving.set(entry.peerId, {
            peerId: entry.peerId,
            discordUserId: id,
            // passou nas regras: tem a presenca (caps.diag)
            username: entry.presence!.username,
            receiving: false,
            tokens: DIAG_RECEIVE_BURST,
            refilledAt: Date.now(),
            droppedPending: 0
        });
        send(action, entry.peerId, { op: "subscribe" }).catch(e => logThrottled("diag-sub", "warn", "Falha ao pedir o diagnóstico: " + errorText(e), 60_000));
        log.info(`Pedindo o diagnóstico de ${peerLabel(entry.peerId)}`);
        publish();
    }
}

/**
 * Linhas que chegaram: so de quem pedimos, dentro do limite de recepcao; cada uma vai para o console. O que ficou de fora
 * (o `dropped` de la e o que passou do balde) so soma: o aviso sai no tick, no maximo um por segundo por conexao.
 */
function onLines(peerId: PeerId, msg: Extract<DiagMessage, { op: "lines"; }>) {
    const s = rt.diagReceiving.get(peerId);
    if (!s) {
        logThrottled(`diag-unasked:${peerId}`, "warn", `Linhas de diagnóstico de ${peerLabel(peerId)} sem pedido: ignoradas`, 60_000);
        return;
    }
    const now = Date.now();
    s.tokens = Math.min(DIAG_RECEIVE_BURST, s.tokens + Math.max(0, now - s.refilledAt) / 1000 * DIAG_RECEIVE_PER_SECOND);
    s.refilledAt = now;
    const take = Math.min(msg.lines.length, Math.floor(s.tokens));
    s.tokens -= take;
    const name = diagName(s.username);
    for (const line of msg.lines.slice(0, take)) console.log(formatDiagReceived(name, line, now));
    s.droppedPending += (msg.dropped ?? 0) + msg.lines.length - take;
    if (!s.receiving) {
        s.receiving = true;
        log.info(`Recebendo o diagnóstico de ${peerLabel(peerId)}: no console do Discord (renderer_js.log), linhas "[Telinha] [diag ${name}]"`);
        publish();
    }
}

/** Um aviso por conexao com o que ficou de fora desde o ultimo (no tick: no maximo um por segundo, qualquer que seja o ritmo de la). */
function reportDropped() {
    const now = Date.now();
    for (const s of rt.diagReceiving.values()) {
        if (!s.droppedPending) continue;
        console.log(formatDiagReceived(diagName(s.username), { t: localTime(now), level: "warn", text: `(${s.droppedPending} linha(s) ficaram de fora pelos limites)` }, now));
        s.droppedPending = 0;
    }
}

// #endregion

// #region ganchos da sessao e da opcao

/** Mensagem da acao "diag" de um peer compativel (session.ts → onDiag, ja passada por parseDiagMessage). */
export function onDiagMessage(peerId: PeerId, msg: DiagMessage): void {
    if (msg.op === "subscribe") onSubscribe(peerId);
    else if (msg.op === "unsubscribe") stopSending(peerId, "parou de pedir");
    else onLines(peerId, msg);
}

/**
 * A cada segundo (session.ts → tick): confere as regras, pede/para de pedir, manda as linhas novas e avisa o que ficou de
 * fora do que chegou. A opcao desligada sem o onChange (configuracao sincronizada de outro PC) tambem para o arquivo.
 */
export function tickDiagShare(): void {
    if (!active) return;
    if (!shareOn()) stopDiagLog();
    reportDropped();
    reviewSending();
    reconcileRequests();
    flushLive();
}

/** A conexao saiu da sala (session.ts → onPeerLeave): para de mandar e de receber por ela. */
export function onDiagPeerGone(peerId: PeerId): void {
    stopSending(peerId, "saiu da sala");
    const s = rt.diagReceiving.get(peerId);
    if (!s) return;
    rt.diagReceiving.delete(peerId);
    log.info(`Parou de receber o diagnóstico de ${s.username} (${shortId(peerId)}): saiu da sala`);
    publish();
}

/** A sala acabou (session.ts → leaveRoom: saiu do canal de voz, senha do grupo mudou, plugin desligado). */
export function onDiagRoomClosing(): void {
    for (const peerId of [...rt.diagSending.keys()]) stopSending(peerId, "a sala fechou");
    for (const s of rt.diagReceiving.values()) log.info(`Parou de receber o diagnóstico de ${s.username} (${shortId(s.peerId)}): a sala fechou`);
    rt.diagReceiving.clear();
    rt.diagRequested.clear();
    publish();
}

/** session.ts → startSession. */
export function startDiagShare(): void {
    if (active) return;
    active = true;
    offEvents = subscribeEvents(onEvent);
    if (shareOn()) startDiagLog();
}

/** session.ts → stopSession (depois de sair da sala). */
export function stopDiagShare(): void {
    if (!active) return;
    onDiagRoomClosing();
    // ativo = inscrito no log (startDiagShare)
    offEvents!();
    offEvents = null;
    live.length = 0;
    lastSnapshotAt.clear();
    stopDiagLog();
    active = false;
}

/**
 * A opcao "Compartilhar diagnóstico" mudou (settings.ts): presenca nova (caps.diag); desligada, para tudo e apaga o
 * registro em arquivo (mesmo com o plugin parado). Parar o plugin nao apaga: so desligar a opcao.
 */
export function onShareDiagnosticsChanged(): void {
    if (!shareOn()) clearDiagLog();
    if (!active) return;
    if (shareOn()) {
        log.info("\"Compartilhar diagnóstico\" ligado: quem também ligou e está na call, com a identidade verificada, pode pedir o registro do Telinha deste PC");
        startDiagLog();
    } else {
        for (const peerId of [...rt.diagSending.keys()]) stopSending(peerId, "você desligou \"Compartilhar diagnóstico\"");
        rt.diagRequested.clear();
        reconcileRequests();
        log.info("\"Compartilhar diagnóstico\" desligado");
    }
    sendPresence();
    publish();
}

// #endregion
