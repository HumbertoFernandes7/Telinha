/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ajustes na descricao REMOTA (o SDP que recebemos do outro lado), aplicados so nas m-sections em
// que NOS enviamos midia para aquele peer. Mexer na descricao remota e permitido pelo Chromium
// (o "munging" da descricao local e que esta sendo descontinuado).
//
// Por que funciona: no libwebrtc, o codec e os limites de bitrate de ENVIO saem da descricao remota
// (o primeiro codec da lista do outro lado que nos suportamos; x-google-* do fmtp desse codec).

export type VideoCodecName = "h264" | "vp8" | "vp9" | "av1";

export const CODEC_RTP_NAME: Record<VideoCodecName, string> = { h264: "H264", vp8: "VP8", vp9: "VP9", av1: "AV1" };

const NON_MEDIA_CODECS = /^(rtx|red|ulpfec|flexfec)$/i;

export interface RemoteSdpPlan {
    /** mids das m-sections de video em que enviamos para este peer */
    videoMids: Set<string>;
    /** mids das m-sections de audio em que enviamos para este peer */
    audioMids: Set<string>;
    /** codec de video que queremos ENVIAR (vai para o inicio da lista) */
    codec: VideoCodecName | null;
    /** x-google-start/max-bitrate em kbps nos codecs de video reais */
    bitrate: { startKbps: number; maxKbps: number; } | null;
}

export interface MungeResult {
    sdp: string;
    /** o que mudou (SDP so e reescrito se houver algo aqui) */
    changes: string[];
    /** observacoes sem mudanca (ex.: codec escolhido ausente do outro lado) */
    notes: string[];
}

interface Rtpmap {
    pt: string;
    name: string;
    line: number;
}

function parseRtpmaps(lines: string[]) {
    const maps: Rtpmap[] = [];
    lines.forEach((line, i) => {
        const m = /^a=rtpmap:(\d+) ([^/\s]+)\//.exec(line);
        if (m) maps.push({ pt: m[1], name: m[2], line: i });
    });
    return maps;
}

function fmtpIndex(lines: string[], pt: string) {
    return lines.findIndex(l => l.startsWith(`a=fmtp:${pt} `));
}

/** Poe as variantes do codec escolhido no inicio da linha m= (H.264 packetization-mode=1 e VP9 perfil 0 primeiro). */
function reorderVideoCodecs(lines: string[], codec: VideoCodecName, notes: string[]): string | null {
    const parts = lines[0].split(" ");
    if (parts.length < 4) return null;
    const pts = parts.slice(3);
    const wantedName = CODEC_RTP_NAME[codec];
    const names = new Map(parseRtpmaps(lines).map(r => [r.pt, r.name.toUpperCase()]));
    const fmtp = (pt: string) => lines[fmtpIndex(lines, pt)] ?? "";

    const rank = (pt: string) => {
        if (codec === "h264") return /packetization-mode=1/.test(fmtp(pt)) ? 0 : 1;
        if (codec === "vp9") return /profile-id=[1-3]/.test(fmtp(pt)) ? 1 : 0;
        return 0;
    };

    const wanted = pts.filter(pt => names.get(pt) === wantedName).sort((a, b) => rank(a) - rank(b));
    if (!wanted.length) {
        notes.push(`${wantedName} ausente no SDP do outro lado; fica o codec padrão`);
        return null;
    }

    const next = [...wanted, ...pts.filter(pt => !wanted.includes(pt))];
    if (next.every((pt, i) => pt === pts[i])) return null;

    lines[0] = [...parts.slice(0, 3), ...next].join(" ");
    return `${wantedName} primeiro`;
}

function addVideoBitrate(lines: string[], startKbps: number, maxKbps: number): string | null {
    const params = `x-google-start-bitrate=${startKbps};x-google-max-bitrate=${maxKbps}`;
    const touched: string[] = [];

    for (const map of parseRtpmaps(lines)) {
        if (NON_MEDIA_CODECS.test(map.name)) continue;
        const idx = fmtpIndex(lines, map.pt);
        if (idx >= 0) {
            if (lines[idx].includes("x-google-")) continue;
            lines[idx] += `;${params}`;
        } else {
            // a linha de rtpmap pode ter mudado de posicao por insercoes anteriores
            const at = lines.findIndex(l => l.startsWith(`a=rtpmap:${map.pt} `));
            lines.splice(at + 1, 0, `a=fmtp:${map.pt} ${params}`);
        }
        touched.push(map.name);
    }

    return touched.length ? `${params} em ${[...new Set(touched)].join("/")}` : null;
}

/** Opus estereo a ate 128 kbps (o padrao do Chromium e mono ~32 kbps, ruim para jogo/musica). */
function addOpusStereo(lines: string[]): string | null {
    const opus = parseRtpmaps(lines).find(m => /^opus$/i.test(m.name));
    if (!opus) return null;
    const idx = fmtpIndex(lines, opus.pt);
    const params = "stereo=1;sprop-stereo=1;maxaveragebitrate=128000";
    if (idx >= 0) {
        if (/stereo=/.test(lines[idx])) return null;
        lines[idx] += `;${params}`;
    } else {
        lines.splice(opus.line + 1, 0, `a=fmtp:${opus.pt} ${params}`);
    }
    return "opus estéreo 128 kbps";
}

/** Aplica o plano nas m-sections em que enviamos. Lanca em SDP inesperado (quem chama cai para o original). */
export function mungeRemoteSdp(sdp: string, plan: RemoteSdpPlan): MungeResult {
    const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
    const head: string[] = [];
    const sections: string[][] = [];
    for (const line of sdp.split(eol)) {
        if (line.startsWith("m=")) sections.push([line]);
        else if (sections.length) sections[sections.length - 1].push(line);
        else head.push(line);
    }

    const changes: string[] = [];
    const notes: string[] = [];
    for (const lines of sections) {
        const kind = /^m=(\w+)/.exec(lines[0])?.[1];
        const mid = lines.find(l => l.startsWith("a=mid:"))?.slice(6).trim();
        if (!mid || /^m=\w+ 0 /.test(lines[0])) continue; // sem mid ou m-section rejeitada

        if (kind === "video" && plan.videoMids.has(mid)) {
            if (plan.codec) {
                const c = reorderVideoCodecs(lines, plan.codec, notes);
                if (c) changes.push(`mid ${mid}: ${c}`);
            }
            if (plan.bitrate) {
                const b = addVideoBitrate(lines, plan.bitrate.startKbps, plan.bitrate.maxKbps);
                if (b) changes.push(`mid ${mid}: ${b}`);
            }
        } else if (kind === "audio" && plan.audioMids.has(mid)) {
            const a = addOpusStereo(lines);
            if (a) changes.push(`mid ${mid}: ${a}`);
        }
    }

    if (!changes.length) return { sdp, changes, notes };
    return { sdp: [...head, ...sections.flat()].join(eol), changes, notes };
}
