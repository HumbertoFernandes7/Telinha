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
// Para comparar com e sem (A/B), cada transmissao comeca com uma linha "Modo da captura: ..." no log; o "fonte N" das
// linhas do envio (core/statsLog.ts) e quantos quadros por segundo a captura entregou.

import { settings } from "@plugins/telinha/settings";

import type { GpuCaptureStatus } from "./captureBoostMain";
import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";

const GPU_CAPTURE = "Captura pela placa de vídeo";

/** O que o main disse da "Captura pela placa de vídeo" (null: ainda nao lido, ou a parte nativa nao tem a opcao). */
let gpuCapture: GpuCaptureStatus | null = null;
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

/**
 * Inicio do plugin: le o estado e acerta o arquivo com a opcao salva no Vencord (a opcao pode ter mudado sem a parte
 * nativa, ou o arquivo pode ter sumido). Loga o modo da captura desta partida quando a opcao esta em uso. Nunca lanca.
 */
export async function startCaptureBoost(): Promise<void> {
    const st = await refreshGpuCapture();
    const on = gpuCaptureOn();
    if (st?.loader && st.saved !== on) await saveGpuCapture(on);
    if (on || st?.requested) log.info(`Modo da captura nesta partida do Discord: ${captureModeText(gpuCapture)}`);
}

/** Uma transmissao acabou de comecar (core/streaming.ts): a linha do modo da captura, para comparar com e sem. */
export function noteCaptureStarted(): void {
    log.info(`Modo da captura: ${captureModeText(gpuCapture)}`);
}

/** As linhas da pagina do plugin, logo abaixo das opcoes. */
export function captureBoostLines(): string[] {
    const capture = gpuCaptureState(gpuCapture, gpuCaptureOn());
    return capture ? [`${GPU_CAPTURE}: ${capture}.`] : [];
}

/** Alguma opcao espera o Discord reiniciar (a pagina do plugin mostra o botao). */
export function captureBoostNeedsRestart(): boolean {
    return gpuCaptureNeedsRestart(gpuCapture, gpuCaptureOn());
}

/** Para o "Copiar diagnóstico". Nunca lanca (as configuracoes podem nao estar disponiveis). */
export function captureBoostDiagnostics(): string {
    try {
        return gpuCaptureDiagnostics(gpuCapture);
    } catch (e) {
        return `captura pela placa de vídeo: diagnóstico indisponível (${e instanceof Error ? e.message : String(e)})`;
    }
}

/** So para testes: esquece o estado lido do main e os ouvintes. */
export function resetCaptureBoostForTests() {
    gpuCapture = null;
    listeners.clear();
}
