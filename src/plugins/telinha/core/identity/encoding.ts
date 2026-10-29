/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Utilitarios PUROS de codificacao (base64url, hex, UTF-8, SHA-256). Rodam no renderer e no Node.

const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export function utf8(text: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(text);
}

/** Decodifica UTF-8 estrito (null se invalido). */
export function utf8Decode(bytes: Uint8Array): string | null {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

export function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodifica base64url sem padding; rejeita qualquer caractere fora do alfabeto (null). */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
    if (typeof text !== "string" || !BASE64URL_RE.test(text) || text.length % 4 === 1) return null;
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
    let bin: string;
    try {
        bin = atob(b64);
    } catch {
        return null;
    }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function toHex(data: ArrayBuffer | Uint8Array): string {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** String aleatoria base64url com `bytes` bytes de entropia (state, code_verifier). */
export function randomUrlSafe(bytes = 32): string {
    return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
