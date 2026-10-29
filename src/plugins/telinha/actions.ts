/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// API do nucleo para a UI. Tudo aqui e seguro de importar no topo de um modulo: nada roda no carregamento.

import { getScreenAudioStatus as fetchScreenAudioStatus } from "./core/audio/screenAudio";
import { publish, rt, setLastError } from "./core/context";
import { errorText, log } from "./core/log";
import { getNative } from "./core/nativeApi";
import * as session from "./core/session";
import * as streaming from "./core/streaming";
import * as viewing from "./core/viewing";
import { getState } from "./store";
import type { CaptureSource, PeerId, RemotePeer, StreamOptions } from "./types";

/**
 * O plugin sabe transmitir o audio da tela inteira (todo o som do PC, menos o do Discord, via
 * telinha-audio.exe). Se ESTE PC consegue, e outra pergunta: getScreenAudioStatus().
 */
export const screenAudioSupported = true as const;

/** O ajudante de audio da tela inteira esta disponivel? Se nao, `reason` (pt-BR) explica por que a tela vai sem som. */
export function getScreenAudioStatus(): Promise<{ available: boolean; reason?: string; }> {
    return fetchScreenAudioStatus();
}

const THUMB_W = 320;
const THUMB_H = 180;

/** Chamado pelo start() do plugin: entra (e acompanha) a sala do canal de voz atual. */
export function startSession(): void {
    session.startSession();
}

/** Chamado pelo stop() do plugin: para transmissao, para de assistir, sai da sala e limpa tudo. */
export function stopSession(): void {
    session.stopSession();
}

/** Telas e janelas disponiveis (com miniatura em data URL), via desktopCapturer no processo main. */
export async function listSources(): Promise<CaptureSource[]> {
    try {
        const result = await getNative().listSources(THUMB_W, THUMB_H);
        if (result.error) log.warn("Listar fontes: " + result.error);
        return result.sources.map(s => ({ id: s.id, name: s.name, kind: s.kind, ...(s.thumbnail ? { thumbnail: s.thumbnail } : {}) }));
    } catch (e) {
        const msg = e instanceof Error && /nativa/.test(e.message) ? e.message : "Não foi possível listar telas e janelas: " + errorText(e);
        log.error(msg);
        setLastError(msg);
        return [];
    }
}

/**
 * Comeca (ou troca a fonte de) a transmissao. Chame direto do clique do usuario: o Discord so libera a
 * captura logo apos um gesto. Rejeita com mensagem em pt-BR (tambem vai para lastError).
 */
export function startStreaming(opts: StreamOptions): Promise<void> {
    return streaming.startStreaming(opts);
}

export function stopStreaming(): void {
    streaming.stopStreaming();
}

/** Pede o stream desse peer. Acompanhe getState().viewing[peerId].status. */
export function watch(peerId: PeerId): void {
    viewing.watch(peerId);
}

/** Para de assistir e remove a entrada de getState().viewing. */
export function unwatch(peerId: PeerId): void {
    viewing.unwatch(peerId);
}

export function findPeerByDiscordId(id: string): RemotePeer | undefined {
    return getState().peers.find(p => p.discordUserId === id);
}

/** Stream da captura local (previa da sua propria transmissao), ou null se voce nao esta transmitindo. Toque sempre mudo. */
export function getLocalPreviewStream(): MediaStream | null {
    return rt.local?.stream ?? null;
}

/** Limpa lastError (ex.: quando a UI fecha o aviso). */
export function clearLastError(): void {
    if (rt.lastError == null) return;
    rt.lastError = null;
    publish();
}
