/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Non-blocking heads-up for things the streamer must see even when the voice bar is out of view (e.g. in a game):
// a watch request waiting for approval (approveViewers) and a new suspicious identity. Uses Vencord's notifications
// (in-app popup, or the system notification when Discord isn't focused, per the user's Vencord settings). The answer
// itself (Permitir/Recusar) is in the voice bar and in "Quem está assistindo"; clicking the notification opens it.
// Nothing runs at module load: start()/stop() are called by the plugin.

import { showNotification } from "@api/Notifications";
import { getState, subscribe } from "@plugins/telinha/store";

import { avatarUrl, displayName, identityAlertText, logger } from "./common";
import { openViewersModal } from "./ViewersModal";

let unsubscribe: (() => void) | null = null;
const seenPending = new Set<string>();
const seenAlerts = new Set<string>();

function notify(title: string, body: string, icon: string | undefined) {
    showNotification({ title, body, icon, noPersist: true, onClick: openViewersModal }).catch(e => logger.warn("Notificação do Telinha falhou", e));
}

function onState() {
    const state = getState();

    const pending = state.local?.pendingViewers ?? [];
    for (const p of pending) {
        if (seenPending.has(p.peerId)) continue;
        seenPending.add(p.peerId);
        const name = displayName(p.discordUserId, p.username);
        notify("Telinha: pedido para assistir", `${name} quer assistir sua transmissão. Permita ou recuse na barra do Telinha (recusado sozinho em 60 s).`, avatarUrl(p.discordUserId, 64));
    }
    for (const id of [...seenPending]) if (!pending.some(p => p.peerId === id)) seenPending.delete(id);

    const alerts = state.identityAlerts ?? [];
    const keys = alerts.map(a => `${a.self ? "self" : "dup"}:${a.discordUserId}`);
    alerts.forEach((a, i) => {
        if (seenAlerts.has(keys[i])) return;
        seenAlerts.add(keys[i]);
        notify("Telinha: identidade suspeita", `${identityAlertText(a)}.${a.self ? "" : " Nenhuma delas recebe a sua transmissão enquanto isso durar."}`, avatarUrl(a.discordUserId, 64));
    });
    for (const k of [...seenAlerts]) if (!keys.includes(k)) seenAlerts.delete(k);
}

export function startNotices() {
    if (unsubscribe) return;
    unsubscribe = subscribe(onState);
}

export function stopNotices() {
    unsubscribe?.();
    unsubscribe = null;
    seenPending.clear();
    seenAlerts.clear();
}
