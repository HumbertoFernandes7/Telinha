/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Quem pode assistir": a decisao sobre cada pedido para assistir, a prova da senha (desafio-resposta HMAC), os
// desafios de uso unico e a migracao da opcao antiga approveViewers. PURO (sem Discord/Vencord/DOM; so WebCrypto,
// que o Node tambem tem): os testes (access.test.ts) rodam no Node. Quem chama (core/streaming.ts) le o estado da
// sessao, decide aqui e aplica o resultado. O formato das mensagens esta em protocol.ts (passo 7).
//
// Ordem da decisao (decideWatch), igual para os 4 modos:
//   1. nao admitido (fora do canal de voz com "Recusar quem não está na call", identidade falsa ou ainda
//      conferindo)                                                        → ignorar (nenhuma resposta)
//   2. expulso / recusado / senha errada 5x (pela conexao ou pelo id)    → denied (o motivo do bloqueio)
//   3. identidade duplicada                                              → denied "duplicate"
//   4. ja aprovado nesta transmissao (Permitir, ou assistia quando a regra mudou) → enviar
//   5. pelo modo:
//      all       verificado, ou sem "Exigir identidade verificada"        → enviar; senao → Permitir/Recusar
//      friends   nao verificado → denied "notVerified"; verificado e nao amigo → denied "friendsOnly";
//                verificado e amigo → enviar   (sem Client ID no build: Permitir/Recusar, nunca "enviar direto")
//      approval  → Permitir/Recusar
//      password  prova certa → enviar (mesmo nao verificado: a senha e a porta); prova errada → novo desafio com
//                "errada" e as tentativas que restam, ou denied "tooManyAttempts" + bloqueio na 5a; sem prova ou
//                com desafio vencido/ja usado → novo desafio (nao conta como erro)

import { isStreamAccess, type StreamAccess, type WatchDeniedReason } from "@plugins/telinha/protocol";

import { base64UrlDecode, base64UrlEncode, utf8 } from "./identity/encoding";
import { identityRequiresApproval, type PeerIdentity } from "./identity/policy";

export type AccessMode = StreamAccess;

/** Erros de senha (por discordUserId, nesta transmissao) ate o bloqueio "tooManyAttempts". */
export const MAX_PASSWORD_ATTEMPTS = 5;
/** Validade de um desafio de senha (nonce). */
export const PASSWORD_NONCE_TTL_MS = 120_000;
/** Maior senha aceita (depois de normalizada). */
export const PASSWORD_MAX_CHARS = 64;
/** Rotulo da mensagem assinada pela prova (muda se o formato mudar). */
export const PASSWORD_PROOF_LABEL = "telinha-pw-v1";

/** Rotulos pt-BR dos modos (seletor, barra do Telinha, configuracoes). */
export const ACCESS_LABEL: Record<AccessMode, string> = {
    all: "Todos da call",
    friends: "Só meus amigos do Discord",
    approval: "Só quem eu aprovar",
    password: "Com senha"
};

/** Etiqueta curta mostrada para quem vai assistir; null = sem etiqueta ("all"). */
export const ACCESS_BADGE: Record<AccessMode, string | null> = {
    all: null,
    friends: "👥 só amigos",
    approval: "✋ com aprovação",
    password: "🔒 com senha"
};

// #region decisao

/**
 * Estado da prova de senha deste pedido: "none" = pedido sem prova; "ok"/"wrong" = prova conferida contra o
 * desafio pendente; "stale" = veio prova, mas nao havia desafio valido (vencido, ja usado, senha trocada).
 */
export type ProofState = "none" | "ok" | "wrong" | "stale";

/** Bloqueio que vale para esta conexao/pessoa (rt.blocked). */
export type AccessBlock = "kicked" | "declined" | "tooManyAttempts";

export interface WatchAccessInput {
    /** prova de identidade ligada no build (Client ID) */
    configured: boolean;
    mode: AccessMode;
    identity: PeerIdentity;
    /** politica de admissao (canal de voz, identidade nao falsa/conferindo): presence.computeAdmitted */
    admitted: boolean;
    blocked: AccessBlock | null;
    /** outra conexao viva diz ter o mesmo discordUserId (e esta nao e a verificada) */
    duplicate: boolean;
    /** aprovado nesta transmissao (Permitir, ou ja assistia quando a regra mudou) */
    approved: boolean;
    /** opcao "Exigir identidade verificada" (so pesa no modo "all") */
    requireVerified: boolean;
    /** o discordUserId anunciado e amigo de quem transmite no Discord (RelationshipStore) */
    friend: boolean;
    proof: ProofState;
    /** erros de senha desta pessoa nesta transmissao, JA contando este pedido se proof = "wrong" */
    wrongAttempts: number;
}

export type WatchDecision =
    /** nao responde nada (quem esta fora nao fica sabendo nem que existe uma transmissao) */
    | { kind: "ignore"; }
    /** manda o stream */
    | { kind: "send"; }
    /** vira um pedido pendente (Permitir/Recusar) */
    | { kind: "approval"; }
    /** recusa; block = bloquear a conexao e o discordUserId ate a transmissao acabar */
    | { kind: "deny"; reason: WatchDeniedReason; block?: true; }
    /** pede a senha (desafio novo) */
    | { kind: "password"; wrong: boolean; attemptsLeft: number; };

/** O modo que vale de fato: "friends" depende da prova de identidade; sem Client ID vira "approval" (o mais seguro). */
export function effectiveAccess(mode: AccessMode, configured: boolean): AccessMode {
    return mode === "friends" && !configured ? "approval" : mode;
}

/** Decide o que fazer com um pedido para assistir (ordem no topo do arquivo). Nunca lanca. */
export function decideWatch(input: WatchAccessInput): WatchDecision {
    const { configured, identity } = input;
    if (!input.admitted) return { kind: "ignore" };
    // redundante com `admitted` (isAdmitted ja barra), mas a regra e absoluta: prova falsa nunca entra
    if (configured && (identity === "invalid" || identity === "pending")) return { kind: "ignore" };
    if (input.blocked) return { kind: "deny", reason: input.blocked };
    if (input.duplicate) return { kind: "deny", reason: "duplicate" };
    if (input.approved) return { kind: "send" };

    switch (effectiveAccess(input.mode, configured)) {
        case "all":
            return identityRequiresApproval({ configured, identity, requireVerified: input.requireVerified }) ? { kind: "approval" } : { kind: "send" };
        case "friends":
            if (identity !== "verified") return { kind: "deny", reason: "notVerified" };
            return input.friend ? { kind: "send" } : { kind: "deny", reason: "friendsOnly" };
        case "password": {
            if (input.proof === "ok") return { kind: "send" };
            const used = Math.max(0, Math.floor(input.wrongAttempts));
            if (input.proof === "wrong" && used >= MAX_PASSWORD_ATTEMPTS) return { kind: "deny", reason: "tooManyAttempts", block: true };
            return { kind: "password", wrong: input.proof === "wrong", attemptsLeft: Math.max(0, MAX_PASSWORD_ATTEMPTS - used) };
        }
        case "approval":
        default:
            return { kind: "approval" };
    }
}

// #endregion

// #region senha

/** A forma canonica da senha: NFC (o mesmo "ã" de teclados diferentes) e sem espacos nas pontas. */
export function normalizePassword(raw: string): string {
    return typeof raw === "string" ? raw.normalize("NFC").trim() : "";
}

/** Senha normalizada com 1 a 64 caracteres. */
export function isValidPassword(password: string): boolean {
    return typeof password === "string" && password.length > 0 && password.length <= PASSWORD_MAX_CHARS && normalizePassword(password) === password;
}

/** A mensagem que a prova assina: amarra a senha a este desafio e a este par transmissor/espectador. */
export function passwordProofMessage(nonce: string, streamerId: string, viewerId: string): string {
    return `${PASSWORD_PROOF_LABEL}|${nonce}|${streamerId}|${viewerId}`;
}

export interface PasswordProofInput {
    /** a senha JA normalizada (normalizePassword) */
    password: string;
    nonce: string;
    /** discordUserId de quem transmite */
    streamerId: string;
    /** discordUserId de quem quer assistir */
    viewerId: string;
}

async function proofBytes({ password, nonce, streamerId, viewerId }: PasswordProofInput): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("raw", utf8(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(passwordProofMessage(nonce, streamerId, viewerId))));
}

/** proof = base64url(HMAC-SHA256(chave = UTF-8 da senha, msg = passwordProofMessage)). A senha nunca sai daqui. */
export async function computePasswordProof(input: PasswordProofInput): Promise<string> {
    if (!isValidPassword(input.password)) throw new Error("senha inválida");
    return base64UrlEncode(await proofBytes(input));
}

/** Compara dois blocos de bytes sem sair cedo (o tempo nao depende de onde eles diferem). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
}

/** A prova recebida confere com a senha? Entrada hostil: formato errado = false. Nunca lanca. */
export async function verifyPasswordProof(input: PasswordProofInput & { proof: unknown; }): Promise<boolean> {
    try {
        if (typeof input.proof !== "string" || input.proof.length !== 43 || !isValidPassword(input.password)) return false;
        const got = base64UrlDecode(input.proof);
        if (!got || got.length !== 32) return false;
        return constantTimeEqual(await proofBytes(input), got);
    } catch {
        return false;
    }
}

/**
 * Vetor de teste compartilhado com o amigo virtual (tools/telinha-peer/password-proof.js tem o MESMO): os dois
 * lados precisam calcular exatamente esta prova. Senha com acento para cobrir o UTF-8.
 */
export const PASSWORD_PROOF_TEST_VECTOR = {
    password: "pão-42",
    nonce: "AAECAwQFBgcICQoLDA0ODw",
    streamerId: "123456789012345678",
    viewerId: "876543210987654321",
    proof: "O2kVBWolXI-E8eiZaxqTqmoqedhm54yG9iZnU9cXM64"
} as const;

/** Nonce de um desafio: 16 bytes aleatorios em base64url (22 caracteres). */
export function newPasswordNonce(): string {
    return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

const PASSWORD_WORDS = [
    "pipoca", "sofa", "tela", "controle", "cinema", "novela", "pastel", "coxinha", "brigadeiro", "guarana",
    "tapioca", "farofa", "caju", "goiaba", "jabuti", "tucano", "capivara", "pinguim", "foguete", "cometa",
    "lanterna", "bicicleta", "pandeiro", "violao", "sorvete", "biscoito", "abacaxi", "melancia", "chinelo", "rede",
    "janela", "pirata"
];

/** Senha curta e aleatoria, facil de ditar: "palavra-NN" (32 palavras x 90 numeros). */
export function generatePassword(random: (n: number) => Uint32Array = n => crypto.getRandomValues(new Uint32Array(n))): string {
    const [a, b] = random(2);
    return `${PASSWORD_WORDS[a % PASSWORD_WORDS.length]}-${10 + (b % 90)}`;
}

interface Challenge {
    nonce: string;
    issuedAt: number;
    expiresAt: number;
}

/**
 * Desafios de senha pendentes, um por conexao: cada `issue` gera um nonce novo (substitui o anterior) e `take`
 * consome o nonce (uso unico) se ainda estiver valido. `now` e injetavel para os testes.
 */
export class PasswordChallenges {
    private readonly map = new Map<string, Challenge>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly ttlMs = PASSWORD_NONCE_TTL_MS,
        private readonly makeNonce: () => string = newPasswordNonce
    ) { }

    /** Desafio novo para esta conexao (o anterior deixa de valer). */
    issue(peerId: string): { nonce: string; expiresAt: number; } {
        const at = this.now();
        const c = { nonce: this.makeNonce(), issuedAt: at, expiresAt: at + this.ttlMs };
        this.map.set(peerId, c);
        return { nonce: c.nonce, expiresAt: c.expiresAt };
    }

    /** O nonce pendente desta conexao, consumido (uso unico); null se nao houver ou se venceu. */
    take(peerId: string): string | null {
        const c = this.map.get(peerId);
        if (!c) return null;
        this.map.delete(peerId);
        return this.now() < c.expiresAt ? c.nonce : null;
    }

    has(peerId: string): boolean {
        const c = this.map.get(peerId);
        return !!c && this.now() < c.expiresAt;
    }

    delete(peerId: string) {
        this.map.delete(peerId);
    }

    clear() {
        this.map.clear();
    }

    /** Tira os desafios vencidos e devolve de quem eram (para o log "nao respondeu ao pedido de senha"). */
    sweep(): string[] {
        const now = this.now();
        const gone: string[] = [];
        for (const [peerId, c] of this.map) {
            if (now < c.expiresAt) continue;
            this.map.delete(peerId);
            gone.push(peerId);
        }
        return gone;
    }

    get size() {
        return this.map.size;
    }
}

// #endregion

// #region configuracao

export interface StoredAccessSettings {
    /** opcao antiga (v0.1.0): "Aprovar quem vai assistir" */
    approveViewers?: unknown;
    /** opcao nova: "Quem pode assistir (padrão)" */
    defaultAccess?: unknown;
}

/**
 * Migracao da opcao booleana approveViewers (v0.1.0) para defaultAccess. `defaultAccess` = o valor a gravar (null =
 * nao mexer); `dropApproveViewers` = apagar a chave antiga. Uma escolha nova ja gravada sempre vence.
 */
export function migrateAccessSetting(stored: StoredAccessSettings | null | undefined): { defaultAccess: AccessMode | null; dropApproveViewers: boolean; } {
    const s = stored ?? {};
    const hasOld = Object.prototype.hasOwnProperty.call(s, "approveViewers");
    if (isStreamAccess(s.defaultAccess)) return { defaultAccess: null, dropApproveViewers: hasOld };
    if (s.approveViewers === true) return { defaultAccess: "approval", dropApproveViewers: true };
    return { defaultAccess: null, dropApproveViewers: hasOld };
}

/** O modo que o seletor ja traz marcado: o padrao das configuracoes, valido e disponivel neste build. */
export function initialAccess(setting: unknown, configured: boolean): AccessMode {
    return effectiveAccess(isStreamAccess(setting) ? setting : "all", configured);
}

// #endregion
