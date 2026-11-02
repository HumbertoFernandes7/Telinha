/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O AV1 da placa de video (so com "AV1" fixado no formato de video; core/codec.ts). No Windows, o WebRTC do Chromium 152
// so usa o encoder AV1 da placa com o recurso WebRtcAV1HWEncode, desligado por padrao no Windows: sem ele, o AV1 do
// WebRTC e o libaom por software, pesado demais para 1080p60 com um jogo, e o Telinha nunca manda isso. O recurso so vale a
// partir da partida do Discord: o main (core/av1FlagMain.ts) grava o pedido num arquivo que o loader do add-on le antes
// do app ficar pronto.
//
// Por que so com o AV1 fixado (e nao sempre ligado): o Chromium o deixa desligado no Windows de proposito (encoders AV1 de
// placa com bugs de driver), e ele so serve quando o AV1 e o codec de envio, o que hoje so acontece fixado. Ligado sempre,
// todo PC passaria a ter o encoder AV1 da placa na lista do WebRTC sem ganho nenhum. Quando o AV1 entrar no automatico
// (core/codec.ts → AUTO_HW_ONLY), av1FlagWanted passa a pedir o recurso sem ele fixado.
//
// Aqui: grava o pedido quando o formato de video muda (e no inicio do plugin, se o arquivo nao bate), conta ao
// core/codec.ts se o recurso esta ligado NESTA partida (setAv1HwFeature: sem ele, o AV1 fixado cai no automatico com
// "reinicie o Discord"), e diz na pagina do plugin o que falta (ui/CodecStatus.tsx).

import { type CodecSetting, settings } from "@plugins/telinha/settings";

import type { Av1FlagStatus } from "./av1FlagMain";
import { getLocalCaps, hwOnlyWanted, setAv1HwFeature, whyNoHwOnlyHere } from "./codec";
import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";

/** O que o main disse do WebRtcAV1HWEncode (null: ainda nao lido, ou a parte nativa nao tem a funcao). */
let status: Av1FlagStatus | null = null;
const listeners = new Set<() => void>();

function changed() {
    for (const fn of [...listeners]) fn();
}

/** Avisa quando o estado muda (a pagina do plugin). Devolve o cancelamento. */
export function subscribeAv1Flag(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

/** O AV1 da placa vale com o formato de video de agora (fixado em AV1, ou o AV1 no automatico: codec.ts → hwOnlyWanted). */
export function av1FlagWanted(): boolean {
    try {
        return hwOnlyWanted("av1", settings.store.codec as CodecSetting);
    } catch {
        return false;
    }
}

function isStatus(v: unknown): v is Av1FlagStatus {
    return !!v && typeof v === "object" && typeof (v as Av1FlagStatus).loader === "boolean" && typeof (v as Av1FlagStatus).requested === "boolean";
}

/**
 * O recurso nesta partida, para o core/codec.ts: true = ligado (o loader pediu e ele estava no enable-features no app
 * ready); false = desligado (nao pedido, ou pedido e trocado depois); null = sem o loader que conhece a chave (build do
 * fork, loader antigo): desconhecido, o encodingInfo decide sozinho.
 */
export function featureOf(st: Av1FlagStatus | null): boolean | null {
    if (!st?.loader) return null;
    return st.requested && st.applied !== false;
}

function keep(st: unknown) {
    status = isStatus(st) ? st : null;
    setAv1HwFeature(featureOf(status));
    changed();
}

/** Le do main o estado do WebRtcAV1HWEncode. Nunca lanca. */
export async function refreshAv1Flag(): Promise<Av1FlagStatus | null> {
    const native = getNativeOrNull();
    if (typeof native?.av1FlagStatus !== "function") return null;
    try {
        keep(await native.av1FlagStatus());
    } catch (e) {
        log.warn(`AV1 da placa: não consegui ler o estado (${errorText(e)})`);
    }
    return status;
}

/** Grava o pedido para a proxima partida do Discord. Nunca lanca. */
async function save(on: boolean): Promise<void> {
    const native = getNativeOrNull();
    if (typeof native?.setAv1Flag !== "function") return;
    try {
        keep(await native.setAv1Flag(on));
        if (status?.saveError) log.warn(`AV1 da placa: ${status.saveError}`);
    } catch (e) {
        log.warn(`AV1 da placa: não consegui salvar o pedido (${errorText(e)})`);
    }
}

/**
 * Inicio do plugin: le o que o loader fez nesta partida (antes da 1a transmissao; o core/codec.ts passa a saber se o
 * recurso esta ligado) e, se o arquivo nao bate com o formato de video, grava de novo. Nunca lanca.
 */
export async function startAv1Flag(): Promise<void> {
    const st = await refreshAv1Flag();
    const on = av1FlagWanted();
    if (st?.loader && st.saved !== on) await save(on);
    if (on) log.info(`AV1 fixado no formato de vídeo: ${av1FlagState(status, true) ?? "o AV1 da placa está ligado nesta partida do Discord"}`);
}

/** O formato de video mudou (settings.ts → codec.onChange): grava o pedido do recurso para a proxima partida. Nunca lanca. */
export async function onAv1SettingChanged(): Promise<void> {
    const on = av1FlagWanted();
    if (!on && !status?.saved) return;
    await save(on);
    if (on) log.info(`AV1 fixado no formato de vídeo: ${av1FlagState(status, true) ?? "o AV1 da placa já está ligado nesta partida do Discord"}`);
}

/**
 * O que falta para o AV1 fixado ir (o lado deste PC), em pt-BR, ou null: nada a dizer (o AV1 nao esta fixado, ou este
 * PC esta pronto; o espectador ainda precisa decodificar AV1 na placa).
 */
export function av1FlagState(st: Av1FlagStatus | null, on: boolean): string | null {
    if (!on) return null;
    if (st?.saveError) return st.saveError;
    if (st && !st.loader) return "o AV1 da placa de vídeo só funciona com o Telinha instalado pelo TelinhaInstaller; vai o do Automático";
    if (st && !st.requested) return "reinicie o Discord para ligar o AV1 da placa de vídeo; até lá, vai o do Automático";
    if (st?.applied === false) return "o AV1 da placa de vídeo não ligou nesta partida do Discord (detalhes em \"Copiar diagnóstico\"); vai o do Automático";
    const why = whyNoHwOnlyHere("av1", getLocalCaps());
    return why ? `${why}; vai o do Automático` : null;
}

/** Falta so reiniciar o Discord para o recurso ligar (o botao "Reiniciar o Discord agora"). */
export function av1FlagNeedsRestart(st: Av1FlagStatus | null = status, on = av1FlagWanted()): boolean {
    return on && !!st?.loader && !st.saveError && !st.requested;
}

/** As linhas da pagina do plugin, logo abaixo do formato de video (ui/CodecStatus.tsx). Vazio = nada a dizer. */
export function codecStatusLines(): string[] {
    const on = av1FlagWanted();
    if (!on) return [];
    const state = av1FlagState(status, on);
    return [state ? `AV1: ${state}.` : "AV1: este PC codifica AV1 na placa de vídeo; vai AV1 para quem também decodifica AV1 na placa (senão, vai o do Automático)."];
}

/** So para testes: esquece o que o main disse (e o recurso volta a desconhecido no core/codec.ts). */
export function resetAv1FlagForTests() {
    status = null;
    listeners.clear();
    setAv1HwFeature(null);
}

/** A linha do "Copiar diagnóstico". */
export function av1FlagDiagnostics(): string {
    const st = status;
    const session = !st ? "parte nativa sem a opção (ou ainda não lida)"
        : [
            `nesta partida ${!st.loader ? "sem o loader do add-on" : !st.requested ? "não pedido" : st.applied === true ? "aplicado" : st.applied === false ? "pedido mas NÃO aplicado" : "pedido"}`,
            `salvo para a próxima: ${!st.loader ? "sem o loader do add-on" : st.saved ? "ligado" : "desligado"}`,
            st.saveError
        ].filter(Boolean).join("; ");
    return `AV1 da placa (WebRtcAV1HWEncode): ${av1FlagWanted() ? "AV1 fixado" : "AV1 não fixado"}; ${session}`;
}
