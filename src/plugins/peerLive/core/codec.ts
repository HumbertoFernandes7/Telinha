/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { H264_PROBE } from "@plugins/peerLive/protocol";
import type { CodecSetting } from "@plugins/peerLive/settings";

import { errorText, log } from "./log";
import { CODEC_RTP_NAME, type VideoCodecName } from "./sdp";

type Codec = RTCRtpCapabilities["codecs"][number];

export interface LocalCodecCaps {
    /** decodificacao H.264 eficiente (hardware); vai na presenca como caps.h264HwDecode */
    h264HwDecode: boolean;
    /** codificacao H.264 eficiente (hardware) neste PC */
    h264HwEncode: boolean;
    /** codecs de video que este cliente sabe enviar (vazio = desconhecido) */
    sendable: Set<VideoCodecName>;
}

export interface CodecDecision {
    codec: VideoCodecName;
    reason: string;
}

let localCaps: LocalCodecCaps = { h264HwDecode: false, h264HwEncode: false, sendable: new Set() };
let probing: Promise<LocalCodecCaps> | null = null;

export function getLocalCaps(): LocalCodecCaps {
    return localCaps;
}

function sleep(ms: number) {
    return new Promise<null>(resolve => setTimeout(() => resolve(null), ms));
}

async function probePowerEfficient(kind: "decodingInfo" | "encodingInfo"): Promise<boolean> {
    try {
        const mc = navigator.mediaCapabilities as any;
        if (typeof mc?.[kind] !== "function") return false;
        const res = await Promise.race([mc[kind]({ ...H264_PROBE, video: { ...H264_PROBE.video } }), sleep(3000)]);
        return res?.powerEfficient === true;
    } catch {
        return false;
    }
}

function sendableCodecs() {
    const out = new Set<VideoCodecName>();
    try {
        for (const c of RTCRtpSender.getCapabilities("video")?.codecs ?? []) {
            const name = c.mimeType.replace(/^video\//i, "").toUpperCase();
            for (const [key, rtp] of Object.entries(CODEC_RTP_NAME)) if (rtp === name) out.add(key as VideoCodecName);
        }
    } catch { }
    return out;
}

/** Mede uma vez por sessao do Discord (H.264 por hardware para decodificar/codificar + codecs de envio). */
export function probeLocalCaps(): Promise<LocalCodecCaps> {
    return probing ??= (async () => {
        const [h264HwDecode, h264HwEncode] = await Promise.all([probePowerEfficient("decodingInfo"), probePowerEfficient("encodingInfo")]);
        localCaps = { h264HwDecode, h264HwEncode, sendable: sendableCodecs() };
        log.info(`Capacidades locais: H.264 por hardware — decodifica: ${h264HwDecode ? "sim" : "não"}, codifica: ${h264HwEncode ? "sim" : "não"}; envia: ${[...localCaps.sendable].join(", ") || "?"}`);
        return localCaps;
    })();
}

/**
 * Codec de video para enviar a UM espectador. Unico ponto de decisao (ajustar aqui com dados de teste).
 *
 * Medido no Discord com aceleracao de GPU desligada (1080p60, receptor novo por codec):
 * VP9 264 ms ate o 1o quadro / 58 fps / CPU 182% (melhor); VP8 327 ms / 56 fps / 249%; AV1 280 ms /
 * 52 fps / 283%; H.264 por software (OpenH264 → FFmpeg) 17,6 s e 106 PLIs (trava). Com GPU ligada,
 * H.264 NVIDIA → D3D11 nao trava e custa ~7x menos. Por isso "auto" = H.264 SO quando o espectador
 * decodifica e este PC codifica H.264 por hardware; senao VP9.
 */
export function chooseCodec(viewerCaps: { h264HwDecode: boolean; } | undefined, setting: CodecSetting, local: LocalCodecCaps = localCaps): CodecDecision {
    const canSend = (c: VideoCodecName) => local.sendable.size === 0 || local.sendable.has(c);
    const fallback = (why: string): CodecDecision => canSend("vp9")
        ? { codec: "vp9", reason: `${why} → VP9` }
        : { codec: "vp8", reason: `${why}; VP9 indisponível → VP8` };

    if (setting && setting !== "auto") {
        if (canSend(setting)) return { codec: setting, reason: "fixado nas configurações" };
        return fallback(`${setting.toUpperCase()} (configurações) indisponível neste cliente`);
    }

    const viewerHw = viewerCaps?.h264HwDecode === true;
    if (viewerHw && local.h264HwEncode && canSend("h264"))
        return { codec: "h264", reason: "automático: H.264 por hardware nos dois lados" };

    return fallback(`automático: ${!viewerHw ? "o espectador não decodifica H.264 por hardware" : "este PC não codifica H.264 por hardware"}`);
}

/** Variantes do codec escolhido primeiro (H.264 packetization-mode=1 e VP9 perfil 0 na frente); o resto fica como alternativa. */
function sortCodecs(codecs: Codec[], codec: VideoCodecName) {
    const wanted = `video/${CODEC_RTP_NAME[codec]}`.toLowerCase();
    const isWanted = (c: Codec) => c.mimeType.toLowerCase() === wanted;
    const rank = (c: Codec) => {
        const fmtp = c.sdpFmtpLine ?? "";
        if (codec === "h264") return /packetization-mode=1/.test(fmtp) ? 0 : 1;
        if (codec === "vp9") return /profile-id=[1-3]/.test(fmtp) ? 1 : 0;
        return 0;
    };
    const preferred = codecs.filter(isWanted).sort((a, b) => rank(a) - rank(b));
    return { sorted: [...preferred, ...codecs.filter(c => !isWanted(c))], matched: preferred.length };
}

/**
 * setCodecPreferences no transceiver de envio (antes da oferta/resposta). Tenta as capacidades do
 * sender e depois as do receiver (o Chromium ja aceitou so as do receiver). Devolve uma descricao.
 */
export function applyCodecPreferences(transceiver: RTCRtpTransceiver, codec: VideoCodecName): string {
    const sources = [
        ["sender", () => RTCRtpSender.getCapabilities("video")?.codecs],
        ["receiver", () => RTCRtpReceiver.getCapabilities("video")?.codecs]
    ] as const;

    let lastError = "";
    for (const [name, get] of sources) {
        const caps = get();
        if (!caps?.length) continue;
        const { sorted, matched } = sortCodecs(caps, codec);
        if (!matched) {
            lastError = `${CODEC_RTP_NAME[codec]} ausente em ${name}.getCapabilities`;
            continue;
        }
        try {
            transceiver.setCodecPreferences(sorted);
            return `${CODEC_RTP_NAME[codec]} primeiro (${matched} variante(s), capacidades do ${name})`;
        } catch (e) {
            lastError = errorText(e);
        }
    }
    return `setCodecPreferences não aplicado (${lastError || "sem capacidades"})`;
}
