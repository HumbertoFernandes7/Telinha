/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Certificado DTLS persistente do Telinha (renderer). O MESMO RTCCertificate vai em TODAS as
// conexoes (Trystero: rtcConfig.certificates), e o id_token e pedido com nonce = hash do seu
// fingerprint. RTCCertificate e "serializable" (W3C webrtc-pc; o Chromium o grava no IndexedDB com a
// chave privada), entao fica no DataStore do Vencord (IndexedDB "VencordData").
//
// Nada roda no carregamento do modulo: RTCPeerConnection.generateCertificate so dentro das funcoes.

import * as DataStore from "@api/DataStore";

import { CERT_LIFETIME_MS, certificateNeedsRotation } from "./config";
import { localCertificateFingerprint } from "./remoteFingerprint";

const STORE_KEY = "telinha-identity-cert-v1";

export interface LocalCertificate {
    certificate: RTCCertificate;
    /** "sha-256:hex" */
    fingerprint: string;
    /** ms epoch (RTCCertificate.expires) */
    expiresAt: number;
    /** false = nao foi possivel gravar (vale so ate o Discord fechar) */
    persisted: boolean;
}

let pending: Promise<LocalCertificate> | null = null;

function describe(certificate: RTCCertificate, persisted: boolean): LocalCertificate {
    return { certificate, fingerprint: localCertificateFingerprint(certificate), expiresAt: certificate.expires, persisted };
}

async function generate(): Promise<RTCCertificate> {
    // ECDSA P-256 e o padrao do Chromium; `expires` e uma extensao do dicionario do keygen
    const keygen = { name: "ECDSA", namedCurve: "P-256", expires: CERT_LIFETIME_MS };
    return RTCPeerConnection.generateCertificate(keygen as AlgorithmIdentifier);
}

async function loadOrCreate(now: number): Promise<LocalCertificate> {
    let stored: unknown;
    try {
        stored = await DataStore.get(STORE_KEY);
    } catch { }
    if (stored instanceof RTCCertificate && !certificateNeedsRotation(stored.expires, now)) {
        try {
            return describe(stored, true);
        } catch { }
    }

    const certificate = await generate();
    let persisted = true;
    try {
        await DataStore.set(STORE_KEY, certificate);
    } catch {
        persisted = false;
    }
    return describe(certificate, persisted);
}

/**
 * Certificado atual (carrega, ou gera e grava). Chamar ANTES do joinRoom: o Trystero cria ofertas
 * logo no join e todas precisam usar este certificado.
 */
export function getLocalCertificate(now = Date.now()): Promise<LocalCertificate> {
    if (pending) {
        return pending.then(cur => certificateNeedsRotation(cur.expiresAt, now) ? (pending = loadOrCreate(now)) : cur);
    }
    pending = loadOrCreate(now);
    pending.catch(() => { pending = null; });
    return pending;
}

/** Apaga o certificado (o proximo getLocalCertificate gera outro; o token antigo deixa de valer). */
export async function forgetLocalCertificate(): Promise<void> {
    pending = null;
    await DataStore.del(STORE_KEY);
}
