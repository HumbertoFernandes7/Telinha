/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// API do nucleo para a UI. Tudo aqui e seguro de importar no topo de um modulo: nada roda no carregamento.

import { generatePassword } from "./core/access";
import { getScreenAudioStatus as fetchScreenAudioStatus } from "./core/audio/screenAudio";
import { publish, rt, setLastError } from "./core/context";
import * as diagShare from "./core/diagShare";
import { authorizeIdentity, forgetIdentity, getLocalIdentityState, type LocalIdentityState, subscribeLocalIdentity } from "./core/identity";
import { isIdentityConfigured } from "./core/identity/config";
import { errorText, log } from "./core/log";
import { getNative } from "./core/nativeApi";
import * as session from "./core/session";
import * as streaming from "./core/streaming";
import * as viewing from "./core/viewing";
import { getState } from "./store";
import type { AccessMode, CaptureSource, PeerId, RemotePeer, StreamOptions } from "./types";

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

/**
 * Expulsa um espectador: para de mandar a transmissao agora e ignora novos pedidos dessa conexao e de quem
 * diz ter o mesmo discordUserId ate voce sair da call. Devolve false se o peer nao existe mais.
 */
export function kickViewer(peerId: PeerId): boolean {
    return streaming.kickViewer(peerId);
}

/** "Permitir" num pedido pendente: vale ate a transmissao acabar. */
export function approveViewer(peerId: PeerId): boolean {
    return streaming.approveViewer(peerId);
}

/** "Recusar" num pedido pendente: igual a expulsar, mas so ate esta transmissao acabar. */
export function declineViewer(peerId: PeerId): boolean {
    return streaming.declineViewer(peerId);
}

/** Libera de novo quem foi expulso/recusado (ve getState().blocked). A pessoa precisa pedir para assistir outra vez. */
export function unblockViewer(discordUserId: string): boolean {
    return streaming.unblockViewer(discordUserId);
}

// #region quem pode assistir (core/access.ts)

/**
 * Troca "Quem pode assistir" com a transmissao no ar (vale para pedidos novos; quem ja assiste continua). Com
 * "password", `password` e obrigatoria. Lanca com a frase pronta em pt-BR.
 */
export function setStreamAccess(access: AccessMode, password?: string): void {
    streaming.setStreamAccess(access, password);
}

/** A senha da transmissao atual (so no modo "password"), para copiar de novo. Nunca vai para o estado/diagnostico. */
export function getStreamPassword(): string | null {
    return streaming.getStreamPassword();
}

/** Senha curta e aleatoria para o botao "Gerar" ("palavra-NN"). */
export function generateStreamPassword(): string {
    return generatePassword();
}

/** "Só meus amigos do Discord" depende da prova de identidade (Client ID no build). */
export function friendsAccessAvailable(): boolean {
    return isIdentityConfigured();
}

/**
 * Senha digitada para assistir ao peer (responde a ViewerSession.passwordPrompt). So a prova HMAC sai daqui.
 * false = nao havia pedido de senha, ou a senha e vazia/longa demais.
 */
export function submitWatchPassword(peerId: PeerId, password: string): boolean {
    return viewing.submitPassword(peerId, password);
}

/**
 * Recusado com "notVerified": abre o "Autorizar" do Discord e, se der certo, pede para assistir de novo depois
 * de alguns segundos (o tempo de o transmissor conferir a prova nova). true = autorizou.
 */
export async function authorizeAndRewatch(peerId: PeerId): Promise<boolean> {
    const ok = await authorizeIdentity();
    if (ok) {
        setTimeout(() => {
            const v = getState().viewing[peerId];
            if (v?.status === "error" && v.denied === "notVerified") viewing.watch(peerId);
        }, 2500);
    }
    return ok;
}

// #endregion

/** Tipo da conexao com o peer em pt-BR (ex.: "Conexão direta pela internet (P2P) · 35 ms"), sem IPs; null = sem conexao. */
export function getConnectionInfo(peerId: PeerId): Promise<string | null> {
    return streaming.connectionInfo(peerId).catch(() => null);
}

/** A conexao de quem tem esse discordUserId; havendo mais de uma, a que provou a identidade (se houver). */
export function findPeerByDiscordId(id: string): RemotePeer | undefined {
    const peers = getState().peers.filter(p => p.discordUserId === id);
    return peers.find(p => p.identity === "verified") ?? peers[0];
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

// #region prova de identidade do Discord (docs/identity.md)

export type { LocalIdentityState };

/** O recurso esta ligado (ha um Client ID do Discord no build)? Desligado = tudo como na v0.1.0, sem UI de identidade. */
export function identityEnabled(): boolean {
    return isIdentityConfigured();
}

/** Estado local: autorizado ("ready"), nao autorizado, vencido, autorizando, erro... */
export function getLocalIdentity(): LocalIdentityState {
    return getLocalIdentityState();
}

export function subscribeLocalIdentityState(listener: () => void): () => void {
    const off = subscribeLocalIdentity(() => listener());
    return () => void off();
}

/** Abre o modal "Autorizar" do proprio Discord. true = pronto; false = cancelado/falhou (o estado explica). */
export function authorizeTelinhaIdentity(): Promise<boolean> {
    return authorizeIdentity();
}

/** "Desvincular": esquece o token desta conta neste PC (quem ja conferiu continua ate reconectar). */
export function unlinkTelinhaIdentity(): Promise<void> {
    return forgetIdentity();
}

// #endregion

/**
 * "Receber diagnóstico" de uma pessoa da call (core/diagShare.ts; precisa de "Compartilhar diagnóstico" ligado aqui e
 * la). Ligado, as linhas dela vao para o console com o prefixo "[Telinha] [diag <nome>]". Acompanhe getState().diag.
 */
export function setDiagRequest(discordUserId: string, username: string, on: boolean): void {
    diagShare.setDiagRequest(discordUserId, username, on);
}
