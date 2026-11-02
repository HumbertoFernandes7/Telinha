/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A live com um jogo que usa a placa de video toda (experimental, desligado por padrao). Com o jogo em tela cheia
// saturando a placa, a captura do Chromium entrega ~10 quadros por segundo: cada quadro espera atras do jogo para ser
// copiado da placa de video para o processador (um Map bloqueante), e o laco da captura dorme o mesmo tempo que gastou.
//
// "Captura pela placa de vídeo" (settings.ts → gpuCapture): liga o WebRtcAllowWgcUsingTexture do Chromium, que deixa o
// quadro na placa de video. So vale a partir da proxima partida do Discord: a opcao e gravada pelo main
// (core/captureBoostMain.ts) num arquivo que o loader do add-on le antes do app ficar pronto. Windows 11 24H2 ou mais novo.
//
// "Prioridade da captura na placa de vídeo" (settings.ts → gpuPriority): enquanto transmite, o processo principal do
// Discord (a captura e a copia de cada quadro) e o da GPU (conversao e codificacao) sobem para a classe HIGH da placa de
// video, para nao esperar atras do jogo; quem ja esta em HIGH ou acima (o REALTIME que o Discord da ao processo da GPU)
// fica como esta: o Telinha nunca abaixa. Vale do inicio ao fim de cada transmissao (core/streaming.ts →
// noteCaptureStarted / noteCaptureStopped); no fim, so o que subiu volta para a classe que tinha. O log e a pagina do
// plugin dizem o que aconteceu em cada processo ("NORMAL→HIGH", "já estava REALTIME"). Sem administrador; se o Windows
// recusar, so o log e a pagina do plugin dizem ("não foi possível (precisa de administrador)").
//
// Para comparar com e sem (A/B), cada transmissao comeca com uma linha "Modo da captura: ..." no log (o modo e a
// prioridade) e a resposta da prioridade logo depois; o "fonte N" das linhas do envio (core/statsLog.ts) e quantos
// quadros por segundo a captura entregou.

import { settings } from "@plugins/telinha/settings";

import type { GpuCaptureStatus, GpuPriorityReport, GpuPriorityTarget } from "./captureBoostMain";
import { rt } from "./context";
import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";

const GPU_CAPTURE = "Captura pela placa de vídeo";
const GPU_PRIORITY = "Prioridade da captura na placa de vídeo";

/** O que o main disse da "Captura pela placa de vídeo" (null: ainda nao lido, ou a parte nativa nao tem a opcao). */
let gpuCapture: GpuCaptureStatus | null = null;
/** O ultimo "high" respondido pelo main nesta partida (null: nenhum ainda). */
let lastRaise: GpuPriorityReport | null = null;
/** A prioridade foi pedida para a transmissao atual e ainda nao voltou ao normal. */
let priorityActive = false;
const listeners = new Set<() => void>();

function changed() {
    for (const fn of [...listeners]) fn();
}

/** Avisa quando o estado das opcoes muda (a pagina do plugin). Devolve o cancelamento. */
export function subscribeCaptureBoost(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

const gpuCaptureOn = () => settings.store.gpuCapture === true;

function isGpuCaptureStatus(v: unknown): v is GpuCaptureStatus {
    return !!v && typeof v === "object" && typeof (v as GpuCaptureStatus).loader === "boolean" && typeof (v as GpuCaptureStatus).build === "number";
}

function keepGpuCapture(st: unknown) {
    gpuCapture = isGpuCaptureStatus(st) ? st : null;
    changed();
}

// #region captura pela placa de video

/** Le do main o estado da "Captura pela placa de vídeo". Nunca lanca. */
export async function refreshGpuCapture(): Promise<GpuCaptureStatus | null> {
    const native = getNativeOrNull();
    if (typeof native?.gpuCaptureStatus !== "function") return null;
    try {
        keepGpuCapture(await native.gpuCaptureStatus());
    } catch (e) {
        log.warn(`${GPU_CAPTURE}: não consegui ler o estado (${errorText(e)})`);
    }
    return gpuCapture;
}

/** Grava a opcao para a proxima partida do Discord. Nunca lanca. */
async function saveGpuCapture(on: boolean): Promise<void> {
    const native = getNativeOrNull();
    if (typeof native?.setGpuCapture !== "function") return;
    try {
        keepGpuCapture(await native.setGpuCapture(on));
        if (gpuCapture?.saveError) log.warn(`${GPU_CAPTURE}: ${gpuCapture.saveError}`);
    } catch (e) {
        log.warn(`${GPU_CAPTURE}: não consegui salvar a opção (${errorText(e)})`);
    }
}

/** A opcao mudou na pagina do plugin (settings.ts): grava para a proxima partida e diz o que acontece. Nunca lanca. */
export async function onGpuCaptureSettingChanged(): Promise<void> {
    const on = gpuCaptureOn();
    await saveGpuCapture(on);
    log.info(`${GPU_CAPTURE} ${on ? "ligada" : "desligada"} nas configurações: ${gpuCaptureState(gpuCapture, on) ?? "nada muda nesta partida"}`);
}

/**
 * Como a opcao esta: ligada, reinicie para ligar/desligar, nao faz nada neste PC... null = nada a dizer (desligada e sem
 * nada pendente).
 */
export function gpuCaptureState(st: GpuCaptureStatus | null, on: boolean): string | null {
    if (st?.saveError) return st.saveError;
    if (!st?.loader) return on ? "só funciona com o Telinha instalado pelo TelinhaInstaller" : null;
    if (!st.supported) return `não faz nada neste PC (precisa do Windows 11 24H2 ou mais novo${st.build ? `; este é o build ${st.build}` : ""})`;
    if (on) {
        if (!st.requested) return "reinicie o Discord para ligar";
        return st.applied === false ? "não ligou nesta partida do Discord (detalhes em \"Copiar diagnóstico\")" : "ligada";
    }
    return gpuCaptureNeedsRestart(st, on) ? "reinicie o Discord para desligar" : null;
}

/** A opcao so muda depois de reiniciar o Discord, e isso esta pendente agora (o botao "Reiniciar o Discord"). */
export function gpuCaptureNeedsRestart(st: GpuCaptureStatus | null, on: boolean): boolean {
    if (!st?.loader || !st.supported || st.saveError) return false;
    return on ? !st.requested : st.requested && st.applied !== false;
}

/** O modo da captura desta partida, para o log. */
function captureModeText(st: GpuCaptureStatus | null): string {
    if (st?.loader && st.requested && st.applied !== false) return "pela placa de vídeo (WebRtcAllowWgcUsingTexture ligado nesta partida)";
    const pending = gpuCaptureOn() ? gpuCaptureState(st, true) : null;
    return `padrão (cópia pelo processador)${pending ? `; ${GPU_CAPTURE.toLowerCase()}: ${pending}` : ""}`;
}

function gpuCaptureDiagnostics(st: GpuCaptureStatus | null): string {
    let session = "parte nativa sem a opção";
    if (st) {
        const asked = !st.requested ? "não pedida" : st.applied === true ? "aplicada" : st.applied === false ? "pedida mas NÃO aplicada" : "pedida";
        session = [
            `nesta partida ${asked}`,
            `salva para a próxima: ${!st.loader ? "sem o loader do add-on" : st.saved ? "ligada" : "desligada"}`,
            `Windows build ${st.build || "?"} (${st.supported ? "suporta" : "não suporta"})`,
            st.loaderNote && `loader: ${st.loaderNote}`,
            st.enableFeatures && `enable-features: ${st.enableFeatures}`,
            st.saveError
        ].filter(Boolean).join("; ");
    }
    return `captura pela placa de vídeo (WebRtcAllowWgcUsingTexture): opção ${gpuCaptureOn() ? "ligada" : "desligada"}; ${session}`;
}

// #endregion

// #region prioridade na placa de video

const gpuPriorityOn = () => settings.store.gpuPriority === true;
const hasPriorityNative = () => typeof getNativeOrNull()?.setGpuPriority === "function";

function isPriorityReport(v: unknown): v is GpuPriorityReport {
    const r = v as GpuPriorityReport;
    return !!v && typeof v === "object" && Array.isArray(r.targets) && typeof r.ok === "boolean" && Array.isArray(r.notes);
}

/**
 * Pede ao main ("high" ou "restore") e loga as notas que vieram junto (o processo da GPU reiniciou...). null: sem a funcao
 * na parte nativa, ou o pedido falhou (fica no log).
 */
async function askPriority(mode: "high" | "restore"): Promise<GpuPriorityReport | null> {
    const native = getNativeOrNull();
    if (typeof native?.setGpuPriority !== "function") return null;
    try {
        const report = await native.setGpuPriority(mode);
        if (!isPriorityReport(report)) return null;
        for (const note of report.notes) log.info(`${GPU_PRIORITY}: ${note}`);
        return report;
    } catch (e) {
        log.warn(`${GPU_PRIORITY}: o pedido falhou (${errorText(e)})`);
        return null;
    }
}

const roleText = (t: GpuPriorityTarget) => (t.role === "GPU" ? "GPU do Discord" : "Discord");

/** "NORMAL→HIGH", "já estava REALTIME" (o Telinha nao mexeu: nunca abaixa) ou o erro do helper */
const targetResult = (t: GpuPriorityTarget) => t.error ?? (t.kept ? `já estava ${t.after}` : `${t.before}→${t.after}`);

/** "Discord 1234 NORMAL→HIGH, GPU do Discord 5678 já estava REALTIME" ("" quando o helper nem rodou) */
function targetsText(r: GpuPriorityReport): string {
    return r.targets
        .filter(t => t.error || t.after)
        .map(t => `${roleText(t)} ${t.pid} ${targetResult(t)}`)
        .join(", ");
}

/** Para a pagina do plugin, sem os pids: " — Discord NORMAL→HIGH, GPU do Discord já estava REALTIME" ("" sem resposta de nenhum). */
function targetsSummary(r: GpuPriorityReport): string {
    if (!r.targets.some(t => t.after)) return "";
    return ` — ${r.targets.map(t => `${roleText(t)} ${t.after && !t.error ? targetResult(t) : "não mudou"}`).join(", ")}`;
}

const withTargets = (r: GpuPriorityReport) => {
    const text = targetsText(r);
    return text ? ` — ${text}` : "";
};

const HAGS_TEXT: Record<string, string> = { on: "HAGS ligado", off: "HAGS desligado" };
const hagsText = (r: GpuPriorityReport) => HAGS_TEXT[r.hags ?? ""] ?? "HAGS desconhecido";

/** Sem administrador funciona na maioria dos PCs; quando o Windows recusa, pode ser isso (nunca e certeza). */
const REFUSED = "o Windows recusou (talvez precise de administrador)";

/** O resultado de um "high", curto: "alta", "não foi possível: o Windows recusou (talvez precise de administrador)"... */
function raiseOutcome(r: GpuPriorityReport): string {
    if (r.ok) return "alta";
    const why = r.reason ?? (r.refused ? REFUSED : null);
    if (r.done) return `alta em ${r.done} de ${r.targets.length} processos do Discord${why ? `; no resto, ${why}` : ""}`;
    return `não foi possível: ${why ?? "detalhes em \"Copiar diagnóstico\""}`;
}

/** Uma linha do log: info quando deu certo, aviso quando nao (nunca mais que isso: a falha e silenciosa). */
function logPriority(r: GpuPriorityReport, text: string) {
    const line = `${GPU_PRIORITY}: ${text}${withTargets(r)}; ${hagsText(r)}`;
    if (r.ok) log.info(line);
    else log.warn(line);
}

/**
 * A volta ao normal: o que voltou, ou que nao deu e sera tentado de novo (o main guarda o que falhou). Uma falha repetida
 * do mesmo jeito (quiet) nao ganha outra linha.
 */
function logRestore(r: GpuPriorityReport | null, why: string) {
    if (!r?.targets.length || r.quiet) return;
    const why2 = r.reason ?? (r.refused ? REFUSED : null);
    logPriority(r, r.ok ? `de volta ao normal (${why})`
        : `não voltou tudo ao normal (${why}${why2 ? `; ${why2}` : ""}); tento de novo na próxima transmissão ou ao reabrir o Discord`);
}

async function raisePriority(): Promise<void> {
    priorityActive = true;
    changed();
    const report = await askPriority("high");
    if (!report) return;
    lastRaise = report;
    changed();
    logPriority(report, raiseOutcome(report));
}

async function restorePriority(why: string): Promise<void> {
    if (!priorityActive) return;
    priorityActive = false;
    changed();
    logRestore(await askPriority("restore"), why);
}

/** O que a prioridade faz nesta transmissao, para a linha "Modo da captura". */
function priorityModeText(): string {
    if (!gpuPriorityOn()) return "normal (opção desligada)";
    if (!hasPriorityNative()) return "normal (só funciona com o Telinha instalado pelo TelinhaInstaller)";
    return priorityActive ? "alta (continua da fonte anterior)" : "pedindo alta";
}

/** A opcao mudou na pagina do plugin (settings.ts): no ar, vale na hora; senao, na proxima transmissao. */
export function onGpuPrioritySettingChanged(): void {
    const on = gpuPriorityOn();
    log.info(`${GPU_PRIORITY} ${on ? "ligada" : "desligada"} nas configurações${on && !rt.local ? ": vale na próxima transmissão" : ""}`);
    if (!on) void restorePriority("opção desligada");
    else if (rt.local && hasPriorityNative() && !priorityActive) void raisePriority();
    changed();
}

/**
 * Como a opcao esta: vale quando transmitir, alta nesta transmissao, nao foi possivel (precisa de administrador)..., com o
 * que a ultima subida fez em cada processo. null = desligada.
 */
export function gpuPriorityState(on: boolean, native: boolean, active: boolean, last: GpuPriorityReport | null): string | null {
    if (!on) return null;
    if (!native) return "só funciona com o Telinha instalado pelo TelinhaInstaller";
    if (!last) return active ? "pedindo prioridade alta" : "vale quando você transmitir";
    const state = !last.ok ? raiseOutcome(last) : active ? "alta nesta transmissão" : "vale quando você transmitir (na última vez ficou alta)";
    return state + targetsSummary(last);
}

function gpuPriorityDiagnostics(): string {
    const last = lastRaise;
    return [
        `prioridade da captura na placa de vídeo: opção ${gpuPriorityOn() ? "ligada" : "desligada"}`,
        `agora ${priorityActive ? "alta (pedida nesta transmissão)" : "normal"}`,
        !hasPriorityNative() && "parte nativa sem a opção",
        last ? `última: ${raiseOutcome(last)}${withTargets(last)}; ${hagsText(last)}` : "nenhuma tentativa nesta partida"
    ].filter(Boolean).join("; ");
}

// #endregion

/**
 * Inicio do plugin: le o estado e acerta o arquivo com a opcao salva no Vencord (a opcao pode ter mudado sem a parte
 * nativa, ou o arquivo pode ter sumido). Loga o modo da captura desta partida quando a opcao esta em uso. Nunca lanca.
 */
export async function startCaptureBoost(): Promise<void> {
    const st = await refreshGpuCapture();
    const on = gpuCaptureOn();
    if (st?.loader && st.saved !== on) await saveGpuCapture(on);
    if (on || st?.requested) log.info(`Modo da captura nesta partida do Discord: ${captureModeText(gpuCapture)}`);
    // o renderer recarregou no meio de uma transmissao, ou uma volta falhou antes: o main ainda tem o Discord em HIGH e tenta
    // de novo (sem nada a voltar, nao faz nada)
    logRestore(await askPriority("restore"), "início do Telinha");
}

/**
 * A captura terminou sozinha (core/streaming.ts, evento "ended" da faixa) com a captura pela placa de video valendo nesta
 * partida: o Chromium encerra a captura quando a placa de video reinicia ou troca (processo da GPU reiniciado, TDR, troca
 * de placa num notebook), sem voltar para a copia pelo processador. null = a opcao nao vale nesta partida (a mensagem de
 * sempre). Recomecar sozinho nao da: o getDisplayMedia precisa de um clique novo.
 */
export function captureEndedText(kind: "screen" | "window"): { log: string; message: string; } | null {
    const st = gpuCapture;
    if (!st?.loader || !st.requested || st.applied === false) return null;
    return kind === "screen"
        ? {
            log: "A captura terminou sozinha com a captura pela placa de vídeo ligada: provavelmente a placa de vídeo reiniciou ou trocou (o Chromium não volta sozinho nesse caso)",
            message: "A transmissão parou: a placa de vídeo provavelmente reiniciou. É só transmitir de novo."
        }
        : {
            log: "A captura terminou sozinha com a captura pela placa de vídeo ligada: a janela foi fechada, ou a placa de vídeo reiniciou ou trocou (o Chromium não volta sozinho nesse caso)",
            message: "A transmissão parou: a janela foi fechada ou a placa de vídeo reiniciou. É só transmitir de novo."
        };
}

/**
 * Uma transmissao acabou de comecar (core/streaming.ts): a linha do modo da captura e da prioridade, para comparar com e
 * sem; com a opcao ligada, pede a prioridade alta (a resposta vem numa linha logo depois). Trocar de fonte no ar mantem.
 */
export function noteCaptureStarted(): void {
    log.info(`Modo da captura: ${captureModeText(gpuCapture)} · prioridade na placa de vídeo: ${priorityModeText()}`);
    if (gpuPriorityOn() && hasPriorityNative() && !priorityActive) void raisePriority();
}

/** A transmissao acabou (core/streaming.ts → stopStreaming): a prioridade volta ao que era. */
export function noteCaptureStopped(): void {
    void restorePriority("transmissão encerrada");
}

/** As linhas da pagina do plugin, logo abaixo das opcoes. */
export function captureBoostLines(): string[] {
    const capture = gpuCaptureState(gpuCapture, gpuCaptureOn());
    const priority = gpuPriorityState(gpuPriorityOn(), hasPriorityNative(), priorityActive, lastRaise);
    return [capture && `${GPU_CAPTURE}: ${capture}.`, priority && `${GPU_PRIORITY}: ${priority}.`].filter((l): l is string => !!l);
}

/** Alguma opcao espera o Discord reiniciar (a pagina do plugin mostra o botao). */
export function captureBoostNeedsRestart(): boolean {
    return gpuCaptureNeedsRestart(gpuCapture, gpuCaptureOn());
}

/** Para o "Copiar diagnóstico". Nunca lanca (as configuracoes podem nao estar disponiveis). */
export function captureBoostDiagnostics(): string {
    try {
        return `${gpuCaptureDiagnostics(gpuCapture)}\n${gpuPriorityDiagnostics()}`;
    } catch (e) {
        return `captura pela placa de vídeo: diagnóstico indisponível (${e instanceof Error ? e.message : String(e)})`;
    }
}

/** So para testes: esquece o estado lido do main e os ouvintes. */
export function resetCaptureBoostForTests() {
    gpuCapture = null;
    lastRaise = null;
    priorityActive = false;
    listeners.clear();
}
