/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Ajustes na descricao REMOTA (o SDP que recebemos do outro lado): codec e opus so nas m-sections em
// que NOS enviamos midia para aquele peer; a banda inicial/maxima em todas as de video (RemoteSdpPlan.bitrate).
// Mexer na descricao remota e permitido pelo Chromium
// (o "munging" da descricao local e que esta sendo descontinuado).
//
// Por que funciona: no libwebrtc, o codec e os limites de bitrate de ENVIO saem da descricao remota
// (o primeiro codec da lista do outro lado que nos suportamos; x-google-* do fmtp desse codec).

export type VideoCodecName = "h264" | "h265" | "vp8" | "vp9" | "av1";

export const CODEC_RTP_NAME: Record<VideoCodecName, string> = { h264: "H264", h265: "H265", vp8: "VP8", vp9: "VP9", av1: "AV1" };

const NON_MEDIA_CODECS = /^(rtx|red|ulpfec|flexfec)$/i;

/** profile-level-id (minusculo) de um fmtp H.264, ou null. Aceita so os parametros ou a linha a=fmtp inteira. */
export function h264ProfileLevelId(fmtp: string): string | null {
    const m = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp);
    return m ? m[1].toLowerCase() : null;
}

/** H.264 packetization-mode=1 (o Chromium nunca codifica packetization-mode=0 por hardware). */
export function isPacketizationMode1(fmtp: string): boolean {
    return /packetization-mode=1(?!\d)/.test(fmtp);
}

/** O mesmo perfil H.264: mesmos profile_idc e profile_iop (os 4 primeiros digitos do profile-level-id); o nivel nao importa. */
export function sameH264Profile(a: string | null | undefined, b: string | null | undefined): boolean {
    return !!a && !!b && a.slice(0, 4).toLowerCase() === b.slice(0, 4).toLowerCase();
}

/**
 * H.264 High (profile_idc 100 sem restricoes: "6400" + nivel, ex.: 640032). O Chromium oferece 6400xx para os encoders
 * de placa de video e nunca 640c (Constrained High); 640c1f e outro perfil e nunca conta como High aqui.
 */
export function isH264High(profileLevelId: string | null | undefined): boolean {
    return /^6400[0-9a-f]{2}$/i.test(profileLevelId ?? "");
}

/**
 * Ordem das variantes H.264 (menor vai antes): 0 = o perfil por hardware deste PC com packetization-mode=1 (mesmo perfil
 * = sameH264Profile; o nivel nao importa); com `backup` (o High escolhido e o Baseline da placa como reserva), 1 = o
 * perfil reserva; depois os outros packetization-mode=1; por ultimo o resto. Sem perfil por hardware, so
 * packetization-mode=1 na frente. Sem reserva, os valores sao os de antes (0, 1, 2).
 */
export function h264Rank(fmtp: string, hwProfile: string | null | undefined, backup?: string | null): number {
    const extra = backup ? 1 : 0;
    if (!isPacketizationMode1(fmtp)) return 2 + extra;
    const profile = h264ProfileLevelId(fmtp);
    if (sameH264Profile(profile, hwProfile)) return 0;
    return backup && sameH264Profile(profile, backup) ? 1 : 1 + extra;
}

/**
 * H.265 Main (profile-id=1, ou sem profile-id: o padrao do RFC 7798 e Main) com tx-mode SRST (ou sem tx-mode), o que o
 * Chromium oferece para o encoder da placa de video. Medido no Chrome 156 (RTX 3070): o sender oferece so
 * "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST" (Main, nivel 4.1); o receiver, Main e Main 10 em level-id=180.
 */
export function isH265Main(fmtp: string): boolean {
    const profile = /profile-id=(\d+)/.exec(fmtp)?.[1];
    const tx = /tx-mode=([a-z]+)/i.exec(fmtp)?.[1];
    return (profile === undefined || profile === "1") && (tx === undefined || tx.toUpperCase() === "SRST");
}

/** Ordem das variantes H.265 (menor vai antes): Main/SRST, depois o resto (Main 10 nunca na frente: o envio e 8 bits). */
export function h265Rank(fmtp: string): number {
    return isH265Main(fmtp) ? 0 : 1;
}

/**
 * AV1 Main (profile=0, ou sem profile: o padrao do RTP payload format do AV1 e Main), o que o encoder da placa de video
 * codifica. Medido no Edge 156 (RTX 3070): o sender oferece so "level-idx=5;profile=0;tier=0"; o receiver, profile=0 e
 * profile=1 (High, 4:4:4), os dois em level-idx=5.
 */
export function isAv1Main(fmtp: string): boolean {
    const profile = /(?:^|[;\s])profile=(\d+)/.exec(fmtp)?.[1];
    return profile === undefined || profile === "0";
}

/** Ordem das variantes AV1 (menor vai antes): Main, depois o resto (o High 4:4:4 nunca na frente). */
export function av1Rank(fmtp: string): number {
    return isAv1Main(fmtp) ? 0 : 1;
}

/** Os codecs so da placa de video e so fixados (o automatico nunca os escolhe; core/codec.ts → chooseCodec): H.265 e AV1. */
export type HwOnlyCodec = "h265" | "av1";

export const isHwOnlyCodec = (codec: string | null | undefined): codec is HwOnlyCodec => codec === "h265" || codec === "av1";

/** Ordem das variantes de um codec so da placa (h265Rank ou av1Rank). */
export function hwOnlyRank(codec: HwOnlyCodec, fmtp: string): number {
    return codec === "av1" ? av1Rank(fmtp) : h265Rank(fmtp);
}

const HW_ONLY_MAIN: Record<HwOnlyCodec, string> = { h265: "H.265 Main", av1: "AV1 Main" };

export interface RemoteSdpPlan {
    /** mids das m-sections de video em que enviamos para este peer */
    videoMids: Set<string>;
    /** mids das m-sections de audio em que enviamos para este peer */
    audioMids: Set<string>;
    /** codec de video que queremos ENVIAR (vai para o inicio da lista) */
    codec: VideoCodecName | null;
    /**
     * H.264: perfil por hardware deste PC (profile-level-id), na frente das outras variantes H.264. H.265 e AV1: o perfil do
     * H.264 reserva (o que iria sem eles), com as variantes H.264 logo depois das H.265/AV1
     */
    h264Profile?: string | null;
    /** H.264 High: o perfil Baseline da placa, logo depois do High (se o outro lado nao tiver High, fica ele, nunca o 42e01f) */
    h264Backup?: string | null;
    /**
     * x-google-start/max-bitrate em kbps nos codecs de video reais de TODAS as m-sections de video (as que enviamos e as que
     * so recebemos): a banda da conexao e uma so, e cada m-section de video reaplica a dela quando o codec muda; uma sem o
     * inicio no meio faria a proxima com ele reiniciar a estimativa (streaming.ts → START_KBPS)
     */
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

/**
 * Poe as variantes do codec escolhido no inicio da linha m= (H.264: o perfil por hardware, depois o reserva, depois
 * packetization-mode=1; VP9 perfil 0 primeiro). Ex.: o outro lado lista 42e01f (OpenH264 aqui) antes de 42001f (placa de
 * video): 42001f vai na frente. Com High (640032) e reserva 42001f: 6400xx, depois 42001f, depois o resto.
 * H.265: H.265 Main, depois as variantes H.264 na ordem do H.264 reserva (`h264Profile`/`h264Backup`), depois o resto.
 * Sem H.265 do outro lado, o H.264 reserva vai na frente (nunca o VP8 que o Chromium lista primeiro). AV1: o mesmo, com o
 * AV1 Main no lugar do H.265 Main.
 */
function reorderVideoCodecs(lines: string[], codec: VideoCodecName, h264Profile: string | null | undefined, h264Backup: string | null | undefined, notes: string[]): string | null {
    const parts = lines[0].split(" ");
    if (parts.length < 4) return null;
    const pts = parts.slice(3);
    const names = new Map(parseRtpmaps(lines).map(r => [r.pt, r.name.toUpperCase()]));
    const fmtp = (pt: string) => lines[fmtpIndex(lines, pt)] ?? "";
    const pick = (name: string, rank: (pt: string) => number) => pts.filter(pt => names.get(pt) === name).sort((a, b) => rank(a) - rank(b));

    if (isHwOnlyCodec(codec)) {
        const name = CODEC_RTP_NAME[codec];
        const hw = pick(name, pt => hwOnlyRank(codec, fmtp(pt)));
        const reserve = h264Profile && !sameH264Profile(h264Profile, h264Backup) ? h264Backup : null;
        const h264 = h264Profile ? pick("H264", pt => h264Rank(fmtp(pt), h264Profile, reserve)) : [];
        if (!hw.length) notes.push(`${name} ausente no SDP do outro lado; ${h264.length ? "fica o H.264 reserva" : "fica o codec padrão"}`);
        else if (hwOnlyRank(codec, fmtp(hw[0])) !== 0) notes.push(`${HW_ONLY_MAIN[codec]} ausente no SDP do outro lado; fica outra variante ${codec === "av1" ? "AV1" : "H.265"}`);
        const front = [...hw, ...h264];
        const next = [...front, ...pts.filter(pt => !front.includes(pt))];
        if (!front.length || next.every((pt, i) => pt === pts[i])) return null;
        lines[0] = [...parts.slice(0, 3), ...next].join(" ");
        const reserveText = `H264 reserva${h264Profile ? ` (perfil ${h264Profile})` : ""}`;
        return hw.length ? `${name} primeiro${h264.length ? `, ${reserveText} logo depois` : ""}` : `${reserveText} primeiro`;
    }

    const wantedName = CODEC_RTP_NAME[codec];
    const backup = codec === "h264" && h264Profile && !sameH264Profile(h264Profile, h264Backup) ? h264Backup : null;

    const rank = (pt: string) => {
        if (codec === "h264") return h264Rank(fmtp(pt), h264Profile, backup);
        if (codec === "vp9") return /profile-id=[1-3]/.test(fmtp(pt)) ? 1 : 0;
        return 0;
    };

    const wanted = pick(wantedName, rank);
    if (!wanted.length) {
        notes.push(`${wantedName} ausente no SDP do outro lado; fica o codec padrão`);
        return null;
    }
    const hwFirst = codec === "h264" && !!h264Profile && rank(wanted[0]) === 0;
    const backupFirst = !hwFirst && !!backup && rank(wanted[0]) === 1;
    if (codec === "h264" && h264Profile && !hwFirst) {
        notes.push(`perfil H.264 ${h264Profile} (placa de vídeo) ausente no SDP do outro lado; ${backupFirst ? `fica o perfil reserva ${backup}` : "fica outra variante H.264"}`);
    }

    const next = [...wanted, ...pts.filter(pt => !wanted.includes(pt))];
    if (next.every((pt, i) => pt === pts[i])) return null;

    lines[0] = [...parts.slice(0, 3), ...next].join(" ");
    return `${wantedName}${hwFirst ? ` (perfil ${h264Profile})` : backupFirst ? ` (perfil ${backup})` : ""} primeiro`;
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

/** Opus estereo a ate 192 kbps (o padrao do Chromium e mono ~32 kbps, ruim para jogo/musica). */
function addOpusStereo(lines: string[]): string | null {
    const opus = parseRtpmaps(lines).find(m => /^opus$/i.test(m.name));
    if (!opus) return null;
    const idx = fmtpIndex(lines, opus.pt);
    const params = "stereo=1;sprop-stereo=1;maxaveragebitrate=192000";
    if (idx >= 0) {
        if (/stereo=/.test(lines[idx])) return null;
        lines[idx] += `;${params}`;
    } else {
        lines.splice(opus.line + 1, 0, `a=fmtp:${opus.pt} ${params}`);
    }
    return "opus estéreo 192 kbps";
}

/** Aplica o plano (codec e opus nas m-sections em que enviamos; banda em todas as de video). Lanca em SDP inesperado (quem chama cai para o original). */
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

        if (kind === "video") {
            if (plan.codec && plan.videoMids.has(mid)) {
                const c = reorderVideoCodecs(lines, plan.codec, plan.h264Profile, plan.h264Backup, notes);
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
