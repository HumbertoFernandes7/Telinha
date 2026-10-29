/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { buildHello, type HelloMessage, type PresenceMessage, PROTOCOL_VERSION, truncateName } from "@plugins/telinha/protocol";
import { settings } from "@plugins/telinha/settings";
import type { PeerId } from "@plugins/telinha/types";
import { UserStore } from "@webpack/common";

import { getLocalCaps } from "./codec";
import { type PeerEntry, rt } from "./context";
import { getLocalIdToken } from "./identity";
import { isIdentityConfigured } from "./identity/config";
import { isAdmitted } from "./identity/policy";
import { errorText, logThrottled } from "./log";

export function me() {
    const user = UserStore.getCurrentUser();
    return { id: user?.id ?? "", username: truncateName(user?.username || "?") };
}

/** O nosso hello: com o id_token so se houver um amarrado ao certificado desta sala (sem Client ID: nunca). */
export function selfHello(): HelloMessage {
    const { id, username } = me();
    let idToken: string | null = null;
    try {
        idToken = getLocalIdToken({ fingerprint: rt.certFingerprint });
    } catch { }
    return buildHello(id, username, idToken);
}

export function selfPresence(): PresenceMessage {
    const { id, username } = me();
    const { local } = rt;
    return {
        v: PROTOCOL_VERSION,
        discordUserId: id,
        username,
        streaming: !!local,
        ...(local ? { stream: { ...local.info } } : {}),
        caps: { h264HwDecode: getLocalCaps().h264HwDecode }
    };
}

/**
 * Politica de admissao: peer compativel e (no nosso canal de voz OU a opcao "recusar de fora" desligada); com
 * Client ID, nunca quem apresentou prova de identidade falsa nem quem ainda esta sendo conferido (policy.ts).
 */
export function computeAdmitted(entry: PeerEntry) {
    if (entry.incompatible || !entry.hello) return false;
    return isAdmitted({ configured: isIdentityConfigured(), identity: entry.identity, inVoice: entry.inVoice, rejectOutsiders: !!settings.store.rejectOutsiders });
}

/** Envia a presenca para um peer, ou para todos os admitidos. Peers nao admitidos nunca recebem. */
export function sendPresence(target?: PeerId) {
    const action = rt.presenceAction;
    if (!action) return;
    const targets = target
        ? (rt.peers.get(target)?.admitted ? [target] : [])
        : [...rt.peers.values()].filter(p => p.admitted).map(p => p.peerId);
    if (!targets.length) return;
    action.send(selfPresence(), { target: targets }).catch(e => logThrottled("presence-send", "warn", "Falha ao enviar presença: " + errorText(e)));
}
