/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Small helpers shared by the Telinha UI. Nothing here touches Vencord/webpack at module load: stores are only
// read inside the functions, which run at render/click time.

import { ACCESS_BADGE, initialAccess } from "@plugins/telinha/core/access";
import { isIdentityConfigured } from "@plugins/telinha/core/identity/config";
import { settings } from "@plugins/telinha/settings";
import type { AccessMode, IdentityAlert, PeerId, Quality, RemotePeer, StreamInfo, TelinhaState, ViewDeniedReason } from "@plugins/telinha/types";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { SelectedChannelStore, showToast, UserStore } from "@webpack/common";

export const cl = classNameFactory("vc-telinha-");
export const logger = new Logger("Telinha UI", "#0b8a83");

/** Telinha's own accent (teal): distinct from Discord's red "AO VIVO" and from its blurple app/bot tags */
export const ACCENT = "#0b8a83";

export const QUALITY_OPTIONS: readonly { value: Quality; label: string; }[] = [
    { value: "1080p60", label: "1080p · 60 fps" },
    { value: "720p60", label: "720p · 60 fps" },
    { value: "1080p30", label: "1080p · 30 fps" }
];

export function errorText(e: unknown): string {
    if (e instanceof Error) return e.message || e.name;
    if (typeof e === "string") return e;
    try {
        return JSON.stringify(e);
    } catch {
        return String(e);
    }
}

/** Runs a core action that may return void or a Promise, reporting sync throws and async rejections the same way */
export function runAction(what: string, fn: () => unknown, onError?: (message: string) => void) {
    const fail = (e: unknown) => {
        const message = errorText(e);
        logger.error(`${what} falhou`, e);
        if (onError) onError(message);
        else showToast({ text: `Telinha: ${message}`, variant: "critical" });
    };

    try {
        const result = fn();
        if (result && typeof (result as Promise<unknown>).then === "function") {
            (result as Promise<unknown>).then(undefined, fail);
        }
    } catch (e) {
        fail(e);
    }
}

export function defaultQuality(): Quality {
    const value = settings.store.defaultQuality as string | undefined;
    return QUALITY_OPTIONS.some(o => o.value === value) ? value as Quality : "1080p60";
}

/** "Quem pode assistir" que o seletor ja traz marcado ("Só meus amigos" sem Client ID cai para "Só quem eu aprovar"). */
export function defaultAccess(): AccessMode {
    return initialAccess(settings.store.defaultAccess, isIdentityConfigured());
}

/** Etiqueta do modo para quem vai assistir ("🔒 com senha"...); null para "Todos da call" ou desconhecido. */
export function accessBadge(access: AccessMode | undefined): string | null {
    return access ? ACCESS_BADGE[access] ?? null : null;
}

export function shareAudioByDefault(): boolean {
    return settings.store.shareAudioByDefault !== false;
}

export function currentUserId(): string | undefined {
    return UserStore.getCurrentUser()?.id;
}

export function inVoiceChannel(): boolean {
    return SelectedChannelStore.getVoiceChannelId() != null;
}

/** Discord's display name for the user when known, else the name the peer announced */
export function displayName(discordUserId: string | undefined, fallback?: string): string {
    const user = discordUserId ? UserStore.getUser(discordUserId) : undefined;
    return user?.globalName || user?.username || fallback || "Alguém";
}

export function peerName(peer: RemotePeer | undefined): string {
    return peer ? displayName(peer.discordUserId, peer.username) : "Alguém";
}

export function findPeer(state: TelinhaState, peerId: PeerId): RemotePeer | undefined {
    return state.peers.find(p => p.peerId === peerId);
}

export function avatarUrl(discordUserId: string | undefined, size = 40): string | undefined {
    if (!discordUserId) return undefined;
    try {
        return UserStore.getUser(discordUserId)?.getAvatarURL(undefined, size);
    } catch {
        return undefined;
    }
}

export function pluralPeople(n: number, singular: string, plural: string) {
    return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

export function watchersLabel(n: number) {
    return n === 0 ? "ninguém assistindo ainda" : `${pluralPeople(n, "pessoa", "pessoas")} assistindo`;
}

/** Titulo do aviso quando o transmissor encerra/recusa a sua visualizacao (o detalhe vem em ViewerSession.error) */
export function deniedTitle(reason: ViewDeniedReason, streamerName: string): string {
    switch (reason) {
        case "kicked": return "O transmissor encerrou sua visualização";
        case "declined": return "O transmissor recusou sua visualização";
        case "timeout": return "O transmissor não respondeu ao seu pedido";
        case "duplicate": return "Transmissão bloqueada por segurança";
        case "friendsOnly": return `Esta transmissão é só para amigos de ${streamerName}`;
        case "notVerified": return "Autorize o Telinha no Discord para assistir";
        case "tooManyAttempts": return "Senha errada vezes demais";
        default: return "O transmissor recusou sua visualização";
    }
}

/** Aviso de identidade suspeita, ex.: "Duas conexões dizem ser Ana — uma pode ser falsa" */
export function identityAlertText(alert: IdentityAlert): string {
    if (alert.self) return "Uma conexão na call diz ser você — alguém pode estar se passando por você";
    const name = displayName(alert.discordUserId, alert.username);
    const n = alert.peerIds.length;
    if (alert.kind === "fake") {
        return `${n === 1 ? "Uma conexão apresentou" : `${n} conexões apresentaram`} uma prova de identidade falsa de ${name} — ${n === 1 ? "ignorada" : "ignoradas"}`;
    }
    if (alert.kind === "impostor") {
        return `${n === 1 ? "Uma conexão não verificada diz" : `${n} conexões não verificadas dizem`} ser ${name}, que já provou a identidade — só ${n === 1 ? "ela fica bloqueada" : "elas ficam bloqueadas"}`;
    }
    const count = n === 2 ? "Duas conexões" : `${n} conexões`;
    return `${count} dizem ser ${name} — uma pode ser falsa`;
}

/** Complemento do aviso quando voce transmite: so no conflito sem ninguem verificado as duas conexoes ficam sem a transmissao. */
export function identityAlertBlocksAll(alert: IdentityAlert): boolean {
    return !alert.self && (alert.kind ?? "duplicate") === "duplicate";
}

export function streamSummary(info: StreamInfo | undefined): string {
    if (!info) return "Transmitindo";

    const parts = [info.kind === "screen" ? "Tela inteira" : `Janela: ${info.title || "sem título"}`];
    if (info.width && info.height) parts.push(`${info.height}p${info.fps ? ` · ${info.fps} fps` : ""}`);
    parts.push(info.hasAudio ? "com som" : "sem som");
    return parts.join(" · ");
}
