/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Small helpers shared by the Telinha UI. Nothing here touches Vencord/webpack at module load: stores are only
// read inside the functions, which run at render/click time.

import { settings } from "@plugins/telinha/settings";
import type { PeerId, Quality, RemotePeer, StreamInfo, TelinhaState } from "@plugins/telinha/types";
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

export function streamSummary(info: StreamInfo | undefined): string {
    if (!info) return "Transmitindo";

    const parts = [info.kind === "screen" ? "Tela inteira" : `Janela: ${info.title || "sem título"}`];
    if (info.width && info.height) parts.push(`${info.height}p${info.fps ? ` · ${info.fps} fps` : ""}`);
    parts.push(info.hasAudio ? "com som" : "sem som");
    return parts.join(" · ");
}
