/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Prova da senha de uma transmissao "com senha" (protocolo, passo 7). COPIA de computePasswordProof /
// verifyPasswordProof em src/plugins/telinha/core/access.ts: as duas PRECISAM dar o mesmo resultado, e o vetor de
// teste abaixo e o MESMO de PASSWORD_PROOF_TEST_VECTOR la (pnpm test:access confere as duas com ele).
// Sem dependencias: so WebCrypto (navegador e Node 22). A senha nunca trafega, so a prova.
//
//   proof = base64url(HMAC-SHA256(chave = UTF-8 da senha normalizada (NFC, sem espacos nas pontas),
//           msg = "telinha-pw-v1|" + nonce + "|" + discordUserId do transmissor + "|" + discordUserId do espectador))

export const PASSWORD_PROOF_LABEL = "telinha-pw-v1";
export const MAX_PASSWORD_ATTEMPTS = 5;
export const PASSWORD_NONCE_TTL_MS = 120_000;
export const PASSWORD_MAX_CHARS = 64;
export const PASSWORD_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const PASSWORD_PROOF_RE = /^[A-Za-z0-9_-]{43}$/;

export const TEST_VECTOR = Object.freeze({
    password: "pão-42",
    nonce: "AAECAwQFBgcICQoLDA0ODw",
    streamerId: "123456789012345678",
    viewerId: "876543210987654321",
    proof: "O2kVBWolXI-E8eiZaxqTqmoqedhm54yG9iZnU9cXM64"
});

const enc = text => new TextEncoder().encode(text);

function b64url(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export const normalizePassword = raw => (typeof raw === "string" ? raw.normalize("NFC").trim() : "");
export const isValidPassword = p => typeof p === "string" && p.length > 0 && p.length <= PASSWORD_MAX_CHARS && normalizePassword(p) === p;

async function proofBytes({ password, nonce, streamerId, viewerId }) {
    const key = await crypto.subtle.importKey("raw", enc(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc(`${PASSWORD_PROOF_LABEL}|${nonce}|${streamerId}|${viewerId}`)));
}

/** A prova para o desafio `nonce` (password ja normalizada). */
export async function computePasswordProof(input) {
    if (!isValidPassword(input.password)) throw new Error("senha inválida");
    return b64url(await proofBytes(input));
}

/** A prova recebida confere? Comparacao sem sair cedo. Nunca lanca. */
export async function verifyPasswordProof(input) {
    try {
        if (typeof input.proof !== "string" || !PASSWORD_PROOF_RE.test(input.proof) || !isValidPassword(input.password)) return false;
        const got = unb64url(input.proof);
        const want = await proofBytes(input);
        if (!got || got.length !== want.length) return false;
        let diff = 0;
        for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i];
        return diff === 0;
    } catch {
        return false;
    }
}

export const newPasswordNonce = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** Confere o vetor de teste (a pagina roda isto ao carregar e mostra no log). */
export async function selfTest() {
    const proof = await computePasswordProof(TEST_VECTOR);
    return proof === TEST_VECTOR.proof && await verifyPasswordProof(TEST_VECTOR);
}
