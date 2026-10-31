/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Quem passa pelo Teredo (core/teredo.ts): a cada TEREDO_CHECK_MS (session.ts → tick) le o par de candidatos em uso de
// cada conexao e guarda o lado no Teredo em PeerEntry.teredo (vai para o estado: RemotePeer.teredo, o aviso da UI em
// ui/notices.ts e o "Copiar diagnóstico"). O log ganha uma linha por pessoa e lado, uma vez por sessao do Discord. So o
// fato: nenhum endereco sai daqui.

import { getPc, peerLabel, publish, rt } from "./context";
import { log } from "./log";
import { pairTeredo, selectedPair, type TeredoSide } from "./teredo";

/** Intervalo entre duas leituras do par em uso de cada conexao. */
export const TEREDO_CHECK_MS = 10_000;

/** "discordUserId:lado" ja avisados no log nesta sessao do Discord. */
const warned = new Set<string>();

/** O PC deste lado do par no Teredo ("local" ou "both") pede o passo a passo; so o do outro lado, um pedido para ele. */
export function teredoLogText(name: string, side: TeredoSide): string {
    return side === "remote"
        ? `A conexão com ${name} passa pelo Teredo do PC dele (um túnel lento do Windows): peça para ele desligar (ele também recebe o aviso no Telinha dele)`
        : `A conexão com ${name} passa pelo Teredo deste PC (um túnel lento do Windows) e a live pode ficar ruim. Para desligar: menu Iniciar → `
        + "digite cmd → botão direito → Executar como administrador → cole netsh interface teredo set state disabled e aperte Enter";
}

/** Le o par em uso de cada conexao e atualiza PeerEntry.teredo. Nunca lanca. */
export async function checkTeredoRoutes(): Promise<void> {
    let changed = false;
    for (const entry of [...rt.peers.values()]) {
        const pc = getPc(entry.peerId);
        if (!pc || pc.connectionState !== "connected") continue;
        let side: TeredoSide | null = null;
        try {
            const report = await pc.getStats();
            side = pairTeredo(report, selectedPair(report));
        } catch {
            continue;
        }
        if (rt.peers.get(entry.peerId) !== entry || (entry.teredo ?? null) === side) continue;
        entry.teredo = side ?? undefined;
        changed = true;
        const id = entry.hello?.discordUserId;
        if (!side || !id) continue;
        const key = `${id}:${side === "remote" ? "remote" : "local"}`;
        if (warned.has(key)) continue;
        warned.add(key);
        log.warn(teredoLogText(peerLabel(entry.peerId), side));
    }
    if (changed) publish();
}

/** Esquece os avisos ja dados (testes). */
export function resetTeredoWarnings() {
    warned.clear();
}
