/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Compartilhar diagnóstico" on the plugin's settings page (protocol.ts step 9, core/diagShare.ts). With the option on:
// "Enviando diagnóstico para X" while someone gets this PC's log (never a popup), and one "Receber diagnóstico de X"
// switch per person in the call who has the option on too (verified identity, in your voice channel). With the option
// off, or without a Discord Client ID in the build (nobody can be verified), it renders nothing.

import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { identityEnabled, setDiagRequest } from "@plugins/telinha/actions";
import { settings } from "@plugins/telinha/settings";
import { useTelinhaState } from "@plugins/telinha/store";
import type { RemotePeer } from "@plugins/telinha/types";

import { cl } from "./common";

/** People who can be asked: the option on, in your voice channel, admitted and verified; one row per person. */
function askable(peers: RemotePeer[]): RemotePeer[] {
    const seen = new Set<string>();
    return peers.filter(p => {
        if (!p.diagShare || !p.admitted || !p.inVoice || p.identity !== "verified" || seen.has(p.discordUserId)) return false;
        seen.add(p.discordUserId);
        return true;
    });
}

export function DiagShareSection() {
    const { shareDiagnostics } = settings.use(["shareDiagnostics"]);
    const state = useTelinhaState();
    if (!identityEnabled() || !shareDiagnostics) return null;

    const sendingTo = state.diag?.sendingTo ?? [];
    const requested = state.diag?.requested ?? [];
    const receiving = state.diag?.receivingFrom ?? [];
    const friends = askable(state.peers);

    return (
        <div className={cl("diag")}>
            <Paragraph>
                <strong>Compartilhar diagnóstico</strong>: ligado neste PC
            </Paragraph>
            {sendingTo.length > 0 && (
                <Paragraph className={cl("diag-status")}>Enviando diagnóstico para {sendingTo.join(", ")}</Paragraph>
            )}
            {friends.length
                ? friends.map(p => {
                    const on = requested.includes(p.discordUserId);
                    const status = !on ? undefined
                        : receiving.includes(p.discordUserId) ? "Recebendo: vai para o console do Discord, nas linhas [Telinha] [diag …]"
                            : "Pedindo…";
                    return (
                        <FormSwitch
                            key={p.discordUserId}
                            title={`Receber diagnóstico de ${p.username}`}
                            description={status}
                            value={on}
                            onChange={v => setDiagRequest(p.discordUserId, p.username, v)}
                            hideBorder
                        />
                    );
                })
                : <Paragraph className={cl("diag-status")}>Ninguém na call está com esta opção ligada agora.</Paragraph>}
        </div>
    );
}
