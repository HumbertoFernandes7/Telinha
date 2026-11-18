/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O som da tela inteira pelo proprio Chromium do Discord (sem o telinha-audio.exe, que o Smart App Control pode barrar).
// O main (core/screenAudioFlagMain.ts, native.ts) grava o pedido para a PROXIMA partida do Discord e diz se o som pelo
// Chromium vale AGORA (screenAudioChromiumStatus). Aqui, no renderer: a ligacao automatica quando o ajudante falha por
// bloqueio/ausencia (nunca liga se ja esta salvo, nunca desliga sozinho), o interruptor das configuracoes, o motivo do
// seletor de fonte e a linha do diagnostico.

import { showToast } from "@webpack/common";

import type { ScreenAudioHelperProblem } from "./audio/types";
import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";
import type { ScreenAudioFlagStatus } from "./screenAudioFlagMain";

export interface ScreenAudioChromium {
    available: boolean;
    reason: string;
}

let flag: ScreenAudioFlagStatus | null = null;
let chromium: ScreenAudioChromium | null = null;
/** Ja ligou o pedido sozinho nesta partida (so tenta uma vez, mesmo se o arquivo nao gravou). */
let autoTried = false;
const listeners = new Set<() => void>();

function changed() {
    for (const fn of [...listeners]) fn();
}

/** Avisa quando o estado muda (a pagina do plugin). Devolve o cancelamento. */
export function subscribeScreenAudioChromium(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

function isFlag(v: unknown): v is ScreenAudioFlagStatus {
    return !!v && typeof v === "object" && typeof (v as ScreenAudioFlagStatus).loader === "boolean" && typeof (v as ScreenAudioFlagStatus).saved === "boolean";
}

/** O ultimo estado lido do main (null: ainda nao lido, ou a parte nativa nao tem a funcao). */
export function screenAudioFlagState(): ScreenAudioFlagStatus | null {
    return flag;
}

/** Le do main o pedido salvo e o que vale nesta partida, e se o som pelo Chromium esta disponivel. Nunca lanca. */
export async function refreshScreenAudioChromium(): Promise<ScreenAudioChromium | null> {
    const native = getNativeOrNull();
    if (typeof native?.screenAudioFlagStatus === "function") {
        try {
            const st = await native.screenAudioFlagStatus();
            flag = isFlag(st) ? st : null;
        } catch (e) {
            log.warn(`Som da tela pelo Chromium: não consegui ler o estado (${errorText(e)})`);
        }
    }
    if (typeof native?.screenAudioChromiumStatus === "function") {
        try {
            const st = await native.screenAudioChromiumStatus();
            chromium = { available: st?.available === true, reason: typeof st?.reason === "string" ? st.reason : "" };
        } catch (e) {
            chromium = { available: false, reason: "não consegui conferir o som da tela pelo Chromium: " + errorText(e) };
        }
    }
    changed();
    return chromium;
}

/** O interruptor das configuracoes: grava o pedido para a proxima partida do Discord. Nunca lanca. */
export async function setScreenAudioChromiumWanted(on: boolean): Promise<void> {
    const native = getNativeOrNull();
    if (typeof native?.setScreenAudioFlag !== "function") return;
    try {
        const st = await native.setScreenAudioFlag(on);
        flag = isFlag(st) ? st : flag;
        if (flag?.saveError) log.warn(`Som da tela pelo Chromium: ${flag.saveError}`);
    } catch (e) {
        log.warn(`Som da tela pelo Chromium: não consegui salvar o pedido (${errorText(e)})`);
    }
    await refreshScreenAudioChromium();
}

/**
 * O ajudante de audio falhou por bloqueio ou ausencia: liga o pedido do som pelo Chromium para a proxima partida (so se
 * ainda nao esta salvo, uma vez) e avisa. Nunca desliga. Nunca lanca. Devolve true se gravou agora.
 */
export async function onScreenAudioHelperProblem(problem: ScreenAudioHelperProblem): Promise<boolean> {
    if (autoTried) return false;
    const native = getNativeOrNull();
    if (typeof native?.screenAudioFlagStatus !== "function" || typeof native.setScreenAudioFlag !== "function") return false;
    try {
        const before = await native.screenAudioFlagStatus();
        if (!isFlag(before) || !before.loader) {
            log.info("Som da tela pelo Chromium: o carregador do add-on desta partida não sabe ligar o pedido; nada a fazer");
            return false;
        }
        flag = before;
        if (before.saved) {
            autoTried = true;
            log.info("Som da tela pelo Chromium: o pedido já está salvo; não gravo de novo");
            return false;
        }
        autoTried = true;
        const after = await native.setScreenAudioFlag(true);
        flag = isFlag(after) ? after : flag;
        if (!flag?.saved) {
            log.warn(`Som da tela pelo Chromium: não consegui salvar o pedido${flag?.saveError ? ` (${flag.saveError})` : ""}`);
            return false;
        }
        log.info(`Ajudante de áudio ${problem === "blocked" ? "bloqueado" : "ausente"}: liguei o pedido do som da tela pelo Chromium para a próxima partida do Discord`);
        showToast({
            text: problem === "blocked"
                ? "O Windows bloqueou o ajudante de áudio do Telinha. Reabra o Discord para o som da tela passar a sair pelo próprio Discord."
                : "O ajudante de áudio do Telinha não está instalado. Reabra o Discord para o som da tela passar a sair pelo próprio Discord.",
            variant: "default"
        });
        await refreshScreenAudioChromium();
        return true;
    } catch (e) {
        log.warn(`Som da tela pelo Chromium: não consegui ligar o pedido (${errorText(e)})`);
        return false;
    }
}

/** Uma linha de estado para as configuracoes (ligado nesta partida / pedido para a proxima / desligado), em pt-BR. */
export function screenAudioChromiumLine(st: ScreenAudioFlagStatus | null = flag): string {
    if (!st) return "Som da tela pelo próprio Discord: estado ainda não lido.";
    if (!st.loader) return "Som da tela pelo próprio Discord: só funciona com o Telinha instalado pelo TelinhaInstaller.";
    if (st.saveError) return `Som da tela pelo próprio Discord: ${st.saveError}.`;
    if (st.requested && st.applied === true && st.saved) return "Som da tela pelo próprio Discord: ligado nesta partida do Discord.";
    if (st.requested && st.applied === true) return "Som da tela pelo próprio Discord: ligado nesta partida; desligado para a próxima (reabra o Discord para desligar).";
    if (st.requested && st.applied === false) return "Som da tela pelo próprio Discord: pedido, mas não ligou nesta partida (outro programa pode ter mudado as opções do Discord); reabra o Discord.";
    if (st.saved) return "Som da tela pelo próprio Discord: pedido para a próxima partida; reabra o Discord para ligar.";
    return "Som da tela pelo próprio Discord: desligado.";
}

/** O Discord precisa reabrir para o pedido valer (pedido salvo e ainda nao aplicado, ou o contrario). */
export function screenAudioChromiumNeedsRestart(st: ScreenAudioFlagStatus | null = flag): boolean {
    return !!st?.loader && !st.saveError && st.saved !== (st.requested && st.applied === true);
}

/** A linha do "Copiar diagnóstico". */
export function screenAudioChromiumDiagnostics(): string {
    const st = flag;
    const session = !st ? "parte nativa sem a opção (ou ainda não lida)"
        : [
            `nesta partida ${!st.loader ? "sem o loader do add-on" : !st.requested ? "não pedido" : st.applied === true ? "aplicado" : st.applied === false ? "pedido mas NÃO aplicado" : "pedido"}`,
            `salvo para a próxima: ${!st.loader ? "sem o loader do add-on" : st.saved ? "ligado" : "desligado"}`,
            st.saveError
        ].filter(Boolean).join("; ");
    const avail = chromium ? (chromium.available ? "disponível" : `indisponível (${chromium.reason})`) : "não conferido";
    return `Som da tela pelo Chromium (loopbackWithoutChrome): ${session}; ${avail}`;
}

/** So para testes. */
export function resetScreenAudioChromiumForTests() {
    flag = null;
    chromium = null;
    autoTried = false;
    listeners.clear();
}
