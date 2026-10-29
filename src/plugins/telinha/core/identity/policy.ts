/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Politica da prova de identidade na sessao: admissao, aprovacao obrigatoria e identidade duplicada.
// PURA (sem Discord/Vencord/DOM): os testes rodam no Node. `configured` vem SEMPRE como parametro
// (isIdentityConfigured() no chamador), entao o caminho sem Client ID (recurso desligado = comportamento
// da v0.1.0) e testavel mesmo com o ID real em config.ts.

import type { IdentityFailure, IdentityVerdict } from "./verify";

/**
 * Estado da identidade de uma conexao:
 * pending    = mandou um id_token e a verificacao ainda roda (nao e admitida enquanto isso; leva ~100 ms);
 * verified   = provou ser o discordUserId anunciado NESTA conexao;
 * unverified = nao provou (sem token / versao antiga / vencido / falha transitoria / recurso desligado);
 * invalid    = apresentou prova FALSA (assinatura, conta ou certificado errados): nunca e aceita.
 */
export type PeerIdentity = "pending" | IdentityVerdict;

/** Identidade de uma conexao nova (onPeerJoin): so quem mandou token precisa esperar a verificacao. */
export function initialPeerIdentity({ configured, hasToken }: { configured: boolean; hasToken: boolean; }): PeerIdentity {
    return configured && hasToken ? "pending" : "unverified";
}

/**
 * Resultado de uma verificacao aplicado ao estado atual. "verified" fica ate a conexao cair (o binding DTLS
 * garante que do outro lado continua a mesma chave): uma renovacao ruim nao rebaixa. "invalid" tambem fica:
 * uma conexao que mostrou prova falsa nao vira confiavel depois.
 */
export function nextPeerIdentity(current: PeerIdentity, verdict: IdentityVerdict): PeerIdentity {
    if (current === "verified" || current === "invalid") return current;
    return verdict;
}

export interface AdmissionInput {
    configured: boolean;
    identity: PeerIdentity;
    /** o discordUserId anunciado esta no nosso canal de voz */
    inVoice: boolean;
    /** opcao "Recusar quem não está na call" */
    rejectOutsiders: boolean;
}

/**
 * Admitido = ve a nossa presenca, recebe respostas e pode pedir para assistir. Identidade falsa nunca;
 * verificacao em andamento ainda nao; o resto segue a regra do canal de voz (igual a v0.1.0).
 * "Exigir identidade verificada" NAO entra aqui: nao verificado no canal ve a presenca e so assiste com
 * aprovacao (watchNeedsApproval).
 */
export function isAdmitted({ configured, identity, inVoice, rejectOutsiders }: AdmissionInput): boolean {
    if (configured && (identity === "invalid" || identity === "pending")) return false;
    return inVoice || !rejectOutsiders;
}

export interface ApprovalInput {
    configured: boolean;
    identity: PeerIdentity;
    /** opcao "Exigir identidade verificada" */
    requireVerified: boolean;
}

/** A identidade obriga a aprovacao manual (Permitir/Recusar), mesmo com "Aprovar quem vai assistir" desligado. */
export function identityRequiresApproval({ configured, identity, requireVerified }: ApprovalInput): boolean {
    return configured && requireVerified && identity !== "verified";
}

/** O pedido para assistir vira um pedido pendente (aprovacao manual)? */
export function watchNeedsApproval(input: ApprovalInput & { approveViewers: boolean; }): boolean {
    return input.approveViewers || identityRequiresApproval(input);
}

// #region identidade duplicada

export interface DuplicateCandidate {
    peerId: string;
    /** discordUserId anunciado no hello */
    discordUserId: string;
    identity: PeerIdentity;
    /** conexao viva: a que caiu (ex.: o amigo reabriu o Discord) nao conta */
    live: boolean;
}

export interface DuplicateGroup {
    discordUserId: string;
    /** conexoes suspeitas: param de receber a transmissao e aparecem no alerta */
    flagged: string[];
    /** conexoes verificadas com o mesmo id (nunca suspeitas). Havendo alguma, as suspeitas sao impostoras. */
    verified: string[];
}

/**
 * Conexoes vivas que anunciam o mesmo discordUserId (passar so as compativeis, que nao dizem ser voce):
 * - verificada nunca e duplicada; duas verificadas = a mesma pessoa em dois PCs (nada a fazer);
 * - verificada + nao verificada(s): so as nao verificadas sao suspeitas (impostoras);
 * - duas ou mais nao verificadas: todas suspeitas (regra da v0.1.0: uma pode ser falsa);
 * - "invalid" e "pending" ficam de fora (nao sao admitidas de qualquer jeito; "invalid" tem alerta proprio).
 * Sem Client ID (configured = false) ninguem e verificado: exatamente a regra da v0.1.0.
 */
export function findDuplicates(peers: readonly DuplicateCandidate[], configured: boolean): DuplicateGroup[] {
    const byUser = new Map<string, DuplicateCandidate[]>();
    for (const p of peers) {
        if (!p.live || !p.discordUserId) continue;
        if (configured && (p.identity === "invalid" || p.identity === "pending")) continue;
        const list = byUser.get(p.discordUserId);
        if (list) list.push(p);
        else byUser.set(p.discordUserId, [p]);
    }
    const groups: DuplicateGroup[] = [];
    for (const [discordUserId, list] of byUser) {
        if (list.length < 2) continue;
        const verified = configured ? list.filter(p => p.identity === "verified").map(p => p.peerId) : [];
        const flagged = list.filter(p => !verified.includes(p.peerId)).map(p => p.peerId);
        if (flagged.length) groups.push({ discordUserId, flagged, verified });
    }
    return groups;
}

// #endregion

/** Motivo curto em pt-BR (log, diagnostico, dica na UI). Nunca contem o token. */
export const IDENTITY_FAILURE_TEXT: Record<IdentityFailure, string> = {
    "not-configured": "recurso desligado",
    "missing": "sem prova (não autorizou o Telinha ou versão antiga)",
    "malformed": "token malformado",
    "unsupported-alg": "algoritmo de assinatura não aceito",
    "unknown-key": "chave do Discord desconhecida",
    "bad-signature": "assinatura inválida",
    "wrong-issuer": "emissor errado",
    "wrong-audience": "token de outro aplicativo",
    "expired": "prova vencida",
    "not-yet-valid": "prova com data no futuro",
    "wrong-subject": "prova de outra conta do Discord",
    "no-fingerprint": "certificado da conexão indisponível",
    "fingerprint-mismatch": "prova de outra conexão (copiada)",
    "timeout": "verificação demorou demais"
};
