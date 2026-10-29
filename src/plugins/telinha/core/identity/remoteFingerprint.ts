/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fingerprint do certificado DTLS que o peer remoto REALMENTE usou nesta RTCPeerConnection.
// Sem efeitos de topo; so usa a API da RTCPeerConnection recebida (testavel com um objeto falso).
//
// Fontes, da mais forte para a mais fraca (todas as disponiveis precisam concordar):
// 1. RTCDtlsTransport.getRemoteCertificates() (Chromium): o DER do certificado do handshake DTLS.
// 2. getStats(): transport.remoteCertificateId -> certificate.fingerprint (padrao W3C).
// 3. a=fingerprint do SDP remoto aplicado. O WebRTC so completa o DTLS se o certificado bater com
//    esse fingerprint, entao com o DTLS "connected" ele tambem e confiavel.
// Exige DTLS "connected": antes disso o fingerprint do SDP ainda nao foi provado por ninguem.

import { fingerprintOfDer, normalizeFingerprint, singleSdpFingerprint } from "./fingerprint";

export type RemoteFingerprintResult =
    | { fingerprint: string; sources: ("certificate" | "stats" | "sdp")[]; }
    | { fingerprint: null; reason: "dtls-not-connected" | "unavailable" | "ambiguous" | "mismatch"; };

type DtlsWithCerts = RTCDtlsTransport & { getRemoteCertificates?: () => ArrayBuffer[]; };

function dtlsTransportOf(pc: RTCPeerConnection): DtlsWithCerts | null {
    // Trystero sempre abre um data channel e usa BUNDLE: um unico transporte DTLS por conexao
    const viaSctp = pc.sctp?.transport;
    if (viaSctp) return viaSctp;
    for (const t of pc.getTransceivers?.() ?? []) {
        const tr = t.receiver?.transport ?? t.sender?.transport;
        if (tr) return tr;
    }
    return null;
}

async function fromStats(pc: RTCPeerConnection): Promise<Set<string> | null> {
    let report: RTCStatsReport;
    try {
        report = await pc.getStats();
    } catch {
        return null;
    }
    const found = new Set<string>();
    report.forEach((s: Record<string, unknown>) => {
        if (s.type !== "transport" || typeof s.remoteCertificateId !== "string") return;
        const cert = report.get(s.remoteCertificateId) as Record<string, unknown> | undefined;
        const fp = normalizeFingerprint(cert?.fingerprintAlgorithm, cert?.fingerprint);
        found.add(fp ?? "invalid");
    });
    return found;
}

export async function getRemoteDtlsFingerprint(pc: RTCPeerConnection): Promise<RemoteFingerprintResult> {
    const transport = dtlsTransportOf(pc);
    if (!transport || transport.state !== "connected") return { fingerprint: null, reason: "dtls-not-connected" };

    const values: { source: "certificate" | "stats" | "sdp"; fp: string; }[] = [];

    try {
        const certs = typeof transport.getRemoteCertificates === "function" ? transport.getRemoteCertificates() : null;
        // o primeiro e o certificado folha (o do peer); WebRTC usa certificado autoassinado unico
        if (certs?.length) values.push({ source: "certificate", fp: await fingerprintOfDer(certs[0]) });
    } catch { }

    const stats = await fromStats(pc);
    if (stats && stats.size > 1) return { fingerprint: null, reason: "ambiguous" };
    if (stats?.size === 1) {
        const [fp] = stats;
        if (fp === "invalid") return { fingerprint: null, reason: "ambiguous" };
        values.push({ source: "stats", fp });
    }

    const sdp = pc.currentRemoteDescription?.sdp ?? pc.remoteDescription?.sdp;
    if (sdp) {
        const fp = singleSdpFingerprint(sdp);
        if (!fp) return { fingerprint: null, reason: "ambiguous" };
        values.push({ source: "sdp", fp });
    }

    if (!values.length) return { fingerprint: null, reason: "unavailable" };
    const fingerprint = values[0].fp;
    if (values.some(v => v.fp !== fingerprint)) return { fingerprint: null, reason: "mismatch" };
    return { fingerprint, sources: values.map(v => v.source) };
}

/** Fingerprint SHA-256 normalizado de um RTCCertificate local (getFingerprints, padrao W3C). */
export function localCertificateFingerprint(certificate: RTCCertificate): string {
    for (const f of certificate.getFingerprints()) {
        const fp = normalizeFingerprint(f.algorithm, f.value);
        if (fp) return fp;
    }
    throw new Error("o certificado DTLS não tem fingerprint SHA-256");
}
