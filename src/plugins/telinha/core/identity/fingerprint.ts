/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fingerprints DTLS e o nonce que amarra o id_token ao certificado. PURO.
//
// Formato normalizado: "sha-256:" + 64 hex minusculos (sem ":"). So SHA-256: e o que o Chromium usa
// no SDP e no getStats, e aceitar outros algoritmos so abriria espaco para ambiguidade.

import { NONCE_CONTEXT } from "./config";
import { base64UrlEncode, sha256, toHex, utf8 } from "./encoding";

const HEX64_RE = /^[0-9a-f]{64}$/;
const NORMALIZED_RE = /^sha-256:[0-9a-f]{64}$/;
const SDP_FINGERPRINT_RE = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)$/;

/** Normaliza (algoritmo, valor "AB:CD:...") para "sha-256:abcd..."; null se nao for SHA-256 valido. */
export function normalizeFingerprint(algorithm: unknown, value: unknown): string | null {
    if (typeof algorithm !== "string" || typeof value !== "string") return null;
    if (algorithm.trim().toLowerCase() !== "sha-256") return null;
    const hex = value.trim().replace(/:/g, "").toLowerCase();
    return HEX64_RE.test(hex) ? `sha-256:${hex}` : null;
}

/**
 * Aceita um fingerprint ja normalizado ("sha-256:abcd...") ou no formato do SDP
 * ("sha-256 AB:CD:..."). null se invalido.
 */
export function asNormalizedFingerprint(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const text = input.trim();
    if (NORMALIZED_RE.test(text)) return text;
    const m = /^(\S+)\s+([0-9A-Fa-f:]+)$/.exec(text);
    return m ? normalizeFingerprint(m[1], m[2]) : null;
}

/** Todos os `a=fingerprint` distintos do SDP (normalizados; algoritmos nao suportados viram "unsupported:<alg>"). */
export function parseSdpFingerprints(sdp: string): string[] {
    const found = new Set<string>();
    for (const raw of sdp.split(/\r?\n/)) {
        const m = SDP_FINGERPRINT_RE.exec(raw.trim());
        if (!m) continue;
        found.add(normalizeFingerprint(m[1], m[2]) ?? `unsupported:${m[1].toLowerCase()}`);
    }
    return [...found];
}

/** O unico fingerprint do SDP; null se nao houver, se houver mais de um distinto ou se nao for SHA-256. */
export function singleSdpFingerprint(sdp: string | null | undefined): string | null {
    if (!sdp) return null;
    const all = parseSdpFingerprints(sdp);
    return all.length === 1 && NORMALIZED_RE.test(all[0]) ? all[0] : null;
}

/** Fingerprint SHA-256 de um certificado em DER (RFC 8122: hash do DER). */
export async function fingerprintOfDer(der: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
    return `sha-256:${toHex(await sha256(der))}`;
}

/** nonce do id_token para um certificado DTLS. Lanca se o fingerprint for invalido. */
export async function nonceForFingerprint(fingerprint: string): Promise<string> {
    const normalized = asNormalizedFingerprint(fingerprint);
    if (!normalized) throw new Error("fingerprint DTLS inválido");
    return base64UrlEncode(await sha256(utf8(`${NONCE_CONTEXT}|${normalized}`)));
}
