/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Non-blocking heads-up for things the streamer must see even when the voice bar is out of view (e.g. in a game):
// a watch request waiting for approval (Permitir/Recusar), a new suspicious identity, and a connection that goes through
// Teredo (Windows' slow IPv6 tunnel; core/teredoWatch.ts), once per person and side per Discord session. Uses Vencord's notifications
// (in-app popup, or the system notification when Discord isn't focused, per the user's Vencord settings). The answer
// itself (Permitir/Recusar) is in the voice bar and in "Quem está assistindo"; clicking the notification opens it.
// Nothing runs at module load: start()/stop() are called by the plugin.

import { showNotification } from "@api/Notifications";
import { getState, subscribe } from "@plugins/telinha/store";

import { avatarUrl, displayName, identityAlertBlocksAll, identityAlertText, logger } from "./common";
import { openViewersModal } from "./ViewersModal";

let unsubscribe: (() => void) | null = null;
const seenPending = new Set<string>();
const seenAlerts = new Set<string>();
/** "discordUserId:local|remote" already shown this session (never cleared while the plugin runs) */
const seenTeredo = new Set<string>();

/** The Teredo notice: this PC on Teredo gets the steps to turn it off; only the friend's, a short line asking him. */
export function teredoNotice(name: string, side: "local" | "remote" | "both"): { title: string; body: string; } {
    return side === "remote"
        ? { title: "Telinha: conexão do amigo pelo Teredo", body: `A conexão de ${name} passa pelo Teredo, um túnel lento do Windows. Peça para ele desligar (ele também recebe o aviso no Telinha dele).` }
        : {
            title: "Telinha: conexão lenta pelo Teredo",
            body: `Sua conexão com ${name} está passando pelo Teredo, um túnel lento do Windows, e a live pode ficar ruim. Para desligar: menu Iniciar → `
                + "digite cmd → botão direito → Executar como administrador → cole netsh interface teredo set state disabled e aperte Enter."
        };
}

function notify(title: string, body: string, icon: string | undefined, onClick: (() => void) | null = openViewersModal) {
    showNotification({ title, body, icon, noPersist: true, onClick: onClick ?? undefined }).catch(e => logger.warn("Notificação do Telinha falhou", e));
}

function onState() {
    const state = getState();

    const pending = state.local?.pendingViewers ?? [];
    for (const p of pending) {
        if (seenPending.has(p.peerId)) continue;
        seenPending.add(p.peerId);
        const name = displayName(p.discordUserId, p.username);
        const unverified = p.identity === "unverified" ? " (não verificado: não provou ser essa conta do Discord)" : "";
        notify("Telinha: pedido para assistir", `${name}${unverified} quer assistir sua transmissão. Permita ou recuse na barra do Telinha (recusado sozinho em 60 s).`, avatarUrl(p.discordUserId, 64));
    }
    for (const id of [...seenPending]) if (!pending.some(p => p.peerId === id)) seenPending.delete(id);

    const alerts = state.identityAlerts ?? [];
    const keys = alerts.map(a => `${a.self ? "self" : a.kind ?? "dup"}:${a.discordUserId}`);
    alerts.forEach((a, i) => {
        if (seenAlerts.has(keys[i])) return;
        seenAlerts.add(keys[i]);
        notify("Telinha: identidade suspeita", `${identityAlertText(a)}.${identityAlertBlocksAll(a) ? " Nenhuma delas recebe a sua transmissão enquanto isso durar." : ""}`, avatarUrl(a.discordUserId, 64));
    });
    for (const k of [...seenAlerts]) if (!keys.includes(k)) seenAlerts.delete(k);

    for (const p of state.peers) {
        if (!p.teredo) continue;
        const key = `${p.discordUserId}:${p.teredo === "remote" ? "remote" : "local"}`;
        if (seenTeredo.has(key)) continue;
        seenTeredo.add(key);
        const { title, body } = teredoNotice(displayName(p.discordUserId, p.username), p.teredo);
        notify(title, body, avatarUrl(p.discordUserId, 64), null);
    }
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
    seenTeredo.clear();
}
