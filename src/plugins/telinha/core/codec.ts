/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Codec de video de envio: a sonda de H.264 por hardware, a decisao por espectador (chooseCodec) e a ordem dos codecs
// na negociacao. Sem Discord/Vencord/log (as APIs do navegador so sao lidas dentro das funcoes): os testes
// (codec.test.ts) rodam no Node com RTCRtpSender/navigator.mediaCapabilities falsos. Quem chama loga.
//
// H.264 por hardware depende do PERFIL. Medido numa RTX 3070 (encodingInfo "video/H264;<fmtp>", 1080p60, 8 Mbps):
// powerEfficient em 42001f, 4d001f e 640032 com packetization-mode=1; nao em 42e01f (Constrained Baseline, o que um
// "video/h264" puro consulta) nem em packetization-mode=0. Negociado em 42e01f, o envio cai no OpenH264 (software) e
// trava. Por isso a sonda guarda o primeiro perfil por hardware, a negociacao poe ESSE perfil na frente (sortCodecs
// aqui, sdp.ts no SDP remoto) e o streaming.ts confere o encoder real no ar (softwareFallback). No ar, o Chromium
// tambem troca a placa pelo OpenH264 DE PROPOSITO em quadros de tamanho impar ou abaixo de 360p (ver
// isTransientSoftwareH264): isso nao e a placa falhando e nunca conta como queda.
//
// H.264 High (6400xx, desde depois da v0.3.2): CABAC e transformada 8x8, ~10-20% melhor por bit. O encoder da placa
// (MediaFoundation NVENC) codifica Main e High, e o RTCVideoEncoder do Chromium passa o perfil negociado para ele. So vai
// quando os dois lados tem High na placa: este PC codifica (encodingInfo do 6400xx do sender, h264HighHwProfile) com a
// sonda WebCodecs do High "ok" neste ambiente (core/stuckEncoder.ts → setH264HighProbeOk) E o espectador anuncia que
// decodifica (presenca caps.hwDecode.h264High, protocol.ts passo 11). Senao, exatamente o Baseline de antes. Tudo que
// desliga o H.264 da placa (travou, sonda rodando, quedas para software) desliga o High junto (h264HwEncode).
//
// H.265 (HEVC Main, depois da v0.3.3): ~25-40% menos bits que o H.264 na mesma qualidade, pelo mesmo encoder da placa
// (MediaFoundation NVENC). O Chromium nao tem H.265 por software (nem encoder, nem decoder): sem a placa dos DOIS lados
// nao ha imagem. E so MANUAL ("H.265" no formato de video): o automatico nunca o escolhe, porque com pouca banda o
// controle de taxa dele para no qp 42 e descarta quadros (medido no Chrome 156, RTX 3070: 13 fps a 3 Mbps, onde o H.264
// High ia a 46). Fixado, ele so vai quando, alem de tudo que o H.264 da placa precisa (h264HwEncode: nada travado, nenhuma
// sonda rodando, sem as quedas), este PC envia H.265 (sender.getCapabilities) e o codifica na placa (encodingInfo do fmtp
// Main do sender, h265HwFmtp), a sonda WebCodecs do H.265 deu "ok" neste ambiente (core/stuckEncoder.ts → setH265ProbeOk;
// ela so roda com o H.265 fixado) E o espectador anuncia que decodifica na placa (caps.hwDecode.h265, protocol.ts passo
// 11); senao, o que o automatico escolheria. Com H.265, o H.264 que o automatico escolheria vai logo depois na negociacao
// (h264Profile/h264Backup da decisao): se o outro lado nao negociar H.265, fica a placa em H.264.
//
// AV1 (Main, depois da v0.3.3): o mesmo desenho do H.265 (so MANUAL, "AV1" no formato de video; as mesmas redes de
// seguranca e a mesma reserva H.264), com duas diferencas. (1) O Chromium TEM AV1 por software (libaom), pesado demais para
// 1080p60 com um jogo: o AV1 so vai com o encoder da placa confirmado (encodingInfo "video/AV1;<fmtp Main do sender>"
// powerEfficient, av1HwFmtp, e a sonda WebCodecs do AV1 "ok"), e um AV1 no ar fora da placa sai dele na hora
// (isOffHardwareAv1; streaming.ts → leaveHwOnly). Nunca um AV1 por software no envio. (2) No Windows, o WebRTC do Chromium
// 152 so usa o encoder AV1 da placa com o recurso WebRtcAV1HWEncode (desligado por padrao no Windows, ligado nos outros
// sistemas; third_party/blink/renderer/platform/peerconnection/rtc_video_encoder_factory.cc): o loader do add-on o liga
// quando o Discord abre com o AV1 fixado (core/av1Flag.ts, addon/PAYLOAD.md 6.1). Sem ele, o encodingInfo diz
// powerEfficient false (o mesmo RTCVideoEncoderFactory) e o AV1 fixado cai no automatico, com o motivo
// (av1HwFeature false: "reinicie o Discord"). So a placa de quem transmite codifica: RTX 40/50, Radeon RX 7000, Intel Arc
// e mais novas. Quem assiste decodifica AV1 na placa a partir da RTX 30 (caps.hwDecode.av1).
//
// Para o AV1 (ou o H.265) entrar no automatico um dia, a troca e uma so: AUTO_HW_ONLY abaixo. A sonda (core/stuckEncoder.ts
// → hwOnlyWanted) e o recurso do loader (core/av1Flag.ts → av1FlagWanted) seguem a mesma lista.

import { H264_PROBE, HW_DECODE_CAPS_VERSION, type HwDecodeCaps } from "@plugins/telinha/protocol";
import type { CodecSetting } from "@plugins/telinha/settings";

import {
    CODEC_RTP_NAME, h264ProfileLevelId, h264Rank, type HwOnlyCodec, hwOnlyRank, isAv1Main, isH264High, isH265Main, isHwOnlyCodec, isPacketizationMode1, sameH264Profile,
    type VideoCodecName
} from "./sdp";

type Codec = RTCRtpCodec;

export interface LocalCodecCaps {
    /** decodificacao H.264 eficiente (hardware); vai na presenca como caps.h264HwDecode */
    h264HwDecode: boolean;
    /**
     * codificacao H.264 eficiente (hardware) neste PC; desligada no resto da sessao na 2a queda do encoder para software no
     * ar, e quando a placa de video travou com H.264 (setH264HwStuck: nesta sessao, ou neste PC com o mesmo ambiente)
     */
    h264HwEncode: boolean;
    /** profile-level-id (minusculo) do primeiro perfil H.264 que este PC codifica por hardware, ex.: "42001f"; null = nenhum */
    h264HwProfile: string | null;
    /** decodifica H.264 High (6400xx) por hardware; vai na presenca como caps.hwDecode.h264High */
    h264HighHwDecode: boolean;
    /** profile-level-id do High que este PC codifica por hardware, no nivel que o Chromium oferece (ex.: "640032"); null = nenhum */
    h264HighHwProfile: string | null;
    /** a sonda WebCodecs do High passou neste ambiente (core/stuckEncoder.ts); sem ela, nunca High */
    h264HighProbeOk: boolean;
    /** decodifica H.265 Main por hardware; vai na presenca como caps.hwDecode.h265 (ausente = medido antes desta versao) */
    h265HwDecode?: boolean;
    /** fmtp do H.265 Main do sender que este PC codifica por hardware (ex.: "level-id=123;profile-id=1;..."); null = nenhum */
    h265HwFmtp?: string | null;
    /** a sonda WebCodecs do H.265 passou neste ambiente (core/stuckEncoder.ts); sem ela, nunca H.265 */
    h265ProbeOk?: boolean;
    /** decodifica AV1 Main por hardware; vai na presenca como caps.hwDecode.av1 (ausente = medido antes desta versao) */
    av1HwDecode?: boolean;
    /** fmtp do AV1 Main do sender que este PC codifica por hardware (ex.: "level-idx=5;profile=0;tier=0"); null = nenhum */
    av1HwFmtp?: string | null;
    /** a sonda WebCodecs do AV1 passou neste ambiente (core/stuckEncoder.ts); sem ela, nunca AV1 */
    av1ProbeOk?: boolean;
    /**
     * o recurso WebRtcAV1HWEncode do Chromium nesta partida do Discord (core/av1Flag.ts, pelo loader do add-on): true = ligado;
     * false = desligado (sem ele o WebRTC so tem o AV1 por software); null/ausente = desconhecido (o encodingInfo decide)
     */
    av1HwFeature?: boolean | null;
    /** codecs de video que este cliente sabe enviar (vazio = desconhecido) */
    sendable: Set<VideoCodecName>;
}

export interface CodecDecision {
    codec: VideoCodecName;
    /**
     * H.264: perfil que vai na frente na negociacao (o por hardware); null/ausente = so packetization-mode=1 na frente.
     * H.265: o perfil do H.264 reserva (o que iria sem o H.265), logo depois das variantes H.265; ausente = sem reserva H.264
     */
    h264Profile?: string | null;
    /** H.264 High: o perfil Baseline da placa logo depois (se o outro lado nao negociar High, fica ele, nunca o 42e01f) */
    h264Backup?: string | null;
    reason: string;
}

/** O que importa do espectador na escolha: a presenca dele (caps). */
export interface ViewerCodecCaps {
    h264HwDecode: boolean;
    hwDecode?: HwDecodeCaps;
}

/** Limites da sonda: cada consulta ao mediaCapabilities e a sonda inteira (os perfis vao um de cada vez). */
export interface ProbeTiming {
    callMs: number;
    totalMs: number;
}

/**
 * Os codecs so da placa que o AUTOMATICO tenta antes do H.264 (na ordem), com as mesmas redes de seguranca do fixado.
 * Vazio: o H.265 (02/11: com internet fraca o H.265 da placa perde fps) e o AV1 (ninguem testou o AV1 da placa ainda) sao
 * so manuais. Promover o AV1 = ["av1"] aqui: a sonda dele (core/stuckEncoder.ts → hwOnlyWanted) e o WebRtcAV1HWEncode
 * do loader (core/av1Flag.ts → av1FlagWanted) passam a valer sem ele fixado.
 */
export const AUTO_HW_ONLY: readonly HwOnlyCodec[] = [];

/**
 * O H.265/AV1 vale com este formato de video: fixado nele, ou ele no automatico (AUTO_HW_ONLY). A sonda dele
 * (core/stuckEncoder.ts) e o WebRtcAV1HWEncode do loader (core/av1Flag.ts) seguem isto.
 */
export function hwOnlyWanted(codec: HwOnlyCodec, setting: CodecSetting | null | undefined): boolean {
    return setting === codec || ((setting ?? "auto") === "auto" && AUTO_HW_ONLY.includes(codec));
}

/** Menos que isto de prazo nao vale outra consulta. */
const MIN_CALL_MS = 10;
export const PROBE_TIMING: ProbeTiming = { callMs: 3000, totalMs: 6000 };

let localCaps: LocalCodecCaps = {
    h264HwDecode: false, h264HwEncode: false, h264HwProfile: null, h264HighHwDecode: false, h264HighHwProfile: null, h264HighProbeOk: false,
    h265HwDecode: false, h265HwFmtp: null, h265ProbeOk: false, av1HwDecode: false, av1HwFmtp: null, av1ProbeOk: false, av1HwFeature: null,
    sendable: new Set()
};
let probing: Promise<LocalCodecCaps> | null = null;
/** o que a sonda mediu (null = ainda nao mediu): o H.264 automatico volta para isto quando deixa de estar travado */
let measured: LocalCodecCaps | null = null;
/** a placa de video travou com H.264 nesta sessao, ou neste PC com o mesmo ambiente (core/stuckEncoder.ts) */
let h264HwStuck = false;
/** a sonda WebCodecs do H.264 da placa esta rodando (core/encoderProbe.ts): ate ela acabar, o automatico vai de VP9 */
let h264HwProbing = false;
/** a sonda WebCodecs do High passou neste ambiente (core/stuckEncoder.ts → setH264HighProbeOk) */
let h264HighProbeOk = false;
/** a sonda WebCodecs do H.265 passou neste ambiente (core/stuckEncoder.ts → setH265ProbeOk) */
let h265ProbeOk = false;
/** a sonda WebCodecs do AV1 passou neste ambiente (core/stuckEncoder.ts → setAv1ProbeOk) */
let av1ProbeOk = false;
/** o WebRtcAV1HWEncode nesta partida do Discord (core/av1Flag.ts → setAv1HwFeature); null = desconhecido */
let av1HwFeature: boolean | null = null;

export function getLocalCaps(): LocalCodecCaps {
    return localCaps;
}

/** Espera `promise` no maximo `ms` (null se estourar) sem deixar o timer pendurado. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function videoCodecs(side: "sender" | "receiver"): Codec[] {
    try {
        const api = side === "sender" ? globalThis.RTCRtpSender : globalThis.RTCRtpReceiver;
        return api?.getCapabilities("video")?.codecs ?? [];
    } catch {
        return [];
    }
}

/** fmtp das variantes H.264 packetization-mode=1, na ordem do Chromium, uma por profile-level-id. */
export function h264Candidates(codecs: readonly Codec[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of codecs) {
        const fmtp = c.sdpFmtpLine ?? "";
        const profile = h264ProfileLevelId(fmtp);
        if (!/^video\/h264$/i.test(c.mimeType) || !isPacketizationMode1(fmtp) || !profile || seen.has(profile)) continue;
        seen.add(profile);
        out.push(fmtp);
    }
    return out;
}

/** fmtp das variantes H.265 Main (sdp.ts → isH265Main), na ordem do Chromium, sem repetir. */
export function h265Candidates(codecs: readonly Codec[]): string[] {
    const out: string[] = [];
    for (const c of codecs) {
        const fmtp = c.sdpFmtpLine ?? "";
        if (/^video\/h265$/i.test(c.mimeType) && isH265Main(fmtp) && !out.includes(fmtp)) out.push(fmtp);
    }
    return out;
}

/** fmtp das variantes AV1 Main (sdp.ts → isAv1Main), na ordem do Chromium, sem repetir. */
export function av1Candidates(codecs: readonly Codec[]): string[] {
    const out: string[] = [];
    for (const c of codecs) {
        const fmtp = c.sdpFmtpLine ?? "";
        if (/^video\/av1$/i.test(c.mimeType) && isAv1Main(fmtp) && !out.includes(fmtp)) out.push(fmtp);
    }
    return out;
}

/**
 * Primeiro fmtp de `fmtps` (na ordem) que o mediaCapabilities diz ser eficiente (hardware), ou null. Uma consulta por
 * vez ("video/H264;<fmtp>", "video/H265;<fmtp>" ou "video/AV1;<fmtp>", 1080p60, 8 Mbps), cada uma com ate timing.callMs,
 * e todas juntas com ate timing.totalMs. Erro ou estouro = nao.
 */
async function firstPowerEfficient(kind: "decodingInfo" | "encodingInfo", fmtps: readonly string[], timing: ProbeTiming, mime = "H264"): Promise<string | null> {
    const mc = (globalThis.navigator as any)?.mediaCapabilities;
    if (typeof mc?.[kind] !== "function") return null;
    const deadline = Date.now() + timing.totalMs;
    for (const fmtp of fmtps) {
        const left = deadline - Date.now();
        // o timer do Windows acorda alguns ms antes do Date.now chegar ao prazo; uma consulta com tao pouco tempo nao responde
        if (left < MIN_CALL_MS) break;
        try {
            const config = { ...H264_PROBE, video: { ...H264_PROBE.video, contentType: `video/${mime};${fmtp}` } };
            const res = await withTimeout(Promise.resolve(mc[kind](config)), Math.min(timing.callMs, left));
            if (res?.powerEfficient === true) return fmtp;
        } catch { }
    }
    return null;
}

function sendableCodecs(codecs: readonly Codec[]) {
    const out = new Set<VideoCodecName>();
    try {
        for (const c of codecs) {
            const name = c.mimeType.replace(/^video\//i, "").toUpperCase();
            for (const [key, rtp] of Object.entries(CODEC_RTP_NAME)) if (rtp === name) out.add(key as VideoCodecName);
        }
    } catch { }
    return out;
}

/** So as variantes High (6400xx) de uma lista de h264Candidates. */
const highOnly = (fmtps: readonly string[]) => fmtps.filter(f => isH264High(h264ProfileLevelId(f)));

/**
 * Mede as capacidades (sem memorizar). Codifica: o primeiro perfil H.264 packetization-mode=1 do sender que o
 * encodingInfo diz ser por hardware. Decodifica: o primeiro perfil packetization-mode=1 do receiver (o que o Chromium
 * lista primeiro, em geral 42001f, o mesmo que uma placa NVIDIA codifica). High: as mesmas consultas so nas variantes
 * 6400xx (no nivel que o Chromium lista), em paralelo; sem 6400xx na lista, nenhuma consulta e High nao. H.265: as mesmas
 * consultas ("video/H265;<fmtp>") so nas variantes Main; sem H.265 na lista (Chromium sem o recurso, como o Edge 156),
 * nenhuma consulta e H.265 nao. AV1: o mesmo ("video/AV1;<fmtp>", so as variantes Main). O AV1 sempre esta na lista (o
 * libaom por software): sem o WebRtcAV1HWEncode, ou sem AV1 na placa, o encodingInfo diz powerEfficient false (medido no
 * Edge 156, RTX 3070: false com e sem o recurso; o decodingInfo diz true).
 */
export async function measureLocalCaps(timing: ProbeTiming = PROBE_TIMING): Promise<LocalCodecCaps> {
    const senderCodecs = videoCodecs("sender");
    const receiverCodecs = videoCodecs("receiver");
    const senderH264 = h264Candidates(senderCodecs);
    const receiverH264 = h264Candidates(receiverCodecs);
    const [decodeFmtp, encodeFmtp, highDecodeFmtp, highEncodeFmtp, h265DecodeFmtp, h265EncodeFmtp, av1DecodeFmtp, av1EncodeFmtp] = await Promise.all([
        firstPowerEfficient("decodingInfo", receiverH264.slice(0, 1), timing),
        firstPowerEfficient("encodingInfo", senderH264, timing),
        firstPowerEfficient("decodingInfo", highOnly(receiverH264).slice(0, 1), timing),
        firstPowerEfficient("encodingInfo", highOnly(senderH264), timing),
        firstPowerEfficient("decodingInfo", h265Candidates(receiverCodecs).slice(0, 1), timing, "H265"),
        firstPowerEfficient("encodingInfo", h265Candidates(senderCodecs), timing, "H265"),
        firstPowerEfficient("decodingInfo", av1Candidates(receiverCodecs).slice(0, 1), timing, "AV1"),
        firstPowerEfficient("encodingInfo", av1Candidates(senderCodecs), timing, "AV1")
    ]);
    const h264HwProfile = encodeFmtp ? h264ProfileLevelId(encodeFmtp) : null;
    return {
        h264HwDecode: decodeFmtp !== null, h264HwEncode: h264HwProfile !== null, h264HwProfile,
        h264HighHwDecode: highDecodeFmtp !== null, h264HighHwProfile: highEncodeFmtp ? h264ProfileLevelId(highEncodeFmtp) : null, h264HighProbeOk: false,
        h265HwDecode: h265DecodeFmtp !== null, h265HwFmtp: h265EncodeFmtp, h265ProbeOk: false,
        av1HwDecode: av1DecodeFmtp !== null, av1HwFmtp: av1EncodeFmtp, av1ProbeOk: false,
        sendable: sendableCodecs(senderCodecs)
    };
}

/**
 * Linha do log de inicio (ex.: "... codifica: sim (perfil 42001f); envia: h264, vp8, vp9, av1; H.264 High por hardware —
 * decodifica: sim, codifica: sim (perfil 640032); H.265 por hardware — decodifica: sim, codifica: sim (level-id=123;...);
 * AV1 por hardware — decodifica: sim, codifica: não; WebRtcAV1HWEncode desligado nesta partida").
 * O "codifica" do High, do H.265 e do AV1 e o do encodingInfo; as sondas deles vem depois.
 */
export function describeLocalCaps(caps: LocalCodecCaps): string {
    const encode = caps.h264HwEncode ? `sim${caps.h264HwProfile ? ` (perfil ${caps.h264HwProfile})` : ""}` : "não";
    const high = `H.264 High por hardware — decodifica: ${caps.h264HighHwDecode ? "sim" : "não"}, codifica: ${caps.h264HighHwProfile ? `sim (perfil ${caps.h264HighHwProfile})` : "não"}`;
    // H.265 so quando este Chromium o oferece ou mede (sem ele, a linha de antes)
    const h265 = caps.h265HwDecode || caps.h265HwFmtp || caps.sendable.has("h265")
        ? `; H.265 por hardware — decodifica: ${caps.h265HwDecode ? "sim" : "não"}, codifica: ${caps.h265HwFmtp ? `sim (${caps.h265HwFmtp})` : "não"}` : "";
    // AV1 so quando a placa o decodifica ou codifica, ou o loader disse do WebRtcAV1HWEncode (o AV1 sempre esta no "envia":
    // o libaom; sem nada disso, a linha de antes)
    const feature = caps.av1HwFeature === true ? "; WebRtcAV1HWEncode ligado nesta partida" : caps.av1HwFeature === false ? "; WebRtcAV1HWEncode desligado nesta partida" : "";
    const av1 = caps.av1HwDecode || caps.av1HwFmtp || caps.av1HwFeature != null
        ? `; AV1 por hardware — decodifica: ${caps.av1HwDecode ? "sim" : "não"}, codifica: ${caps.av1HwFmtp ? `sim (${caps.av1HwFmtp})` : "não"}${feature}` : "";
    return `Capacidades locais: H.264 por hardware — decodifica: ${caps.h264HwDecode ? "sim" : "não"}, codifica: ${encode}; envia: ${[...caps.sendable].join(", ") || "?"}; ${high}${h265}${av1}`;
}

/** Mede uma vez por sessao do Discord. `report` recebe a linha de log da medicao (so na primeira chamada). */
export function probeLocalCaps(report?: (line: string) => void): Promise<LocalCodecCaps> {
    return probing ??= measureLocalCaps().then(caps => {
        measured = caps;
        localCaps = { ...caps, h264HwEncode: caps.h264HwEncode && !h264HwStuck && !h264HwProbing, h264HighProbeOk, h265ProbeOk, av1ProbeOk, av1HwFeature };
        report?.(describeLocalCaps({ ...caps, av1HwFeature }));
        return caps;
    });
}

/**
 * A sonda WebCodecs do High neste ambiente (core/stuckEncoder.ts): true = passou (ok salvo neste ambiente, ou agora);
 * false = nao rodou, inconclusiva ou travou. Sem ela o automatico nunca escolhe High.
 */
export function setH264HighProbeOk(ok: boolean) {
    h264HighProbeOk = ok;
    if (localCaps.h264HighProbeOk !== ok) localCaps = { ...localCaps, h264HighProbeOk: ok };
}

/**
 * A sonda WebCodecs do H.265 neste ambiente (core/stuckEncoder.ts): true = passou; false = nao rodou, inconclusiva,
 * travou, ou um envio em H.265 falhou no ar nesta sessao. Sem ela, nem o H.265 fixado vai.
 */
export function setH265ProbeOk(ok: boolean) {
    h265ProbeOk = ok;
    if (localCaps.h265ProbeOk !== ok) localCaps = { ...localCaps, h265ProbeOk: ok };
}

/**
 * A sonda WebCodecs do AV1 neste ambiente (core/stuckEncoder.ts): true = passou; false = nao rodou, inconclusiva, travou,
 * ou um envio em AV1 falhou ou saiu da placa no ar nesta sessao. Sem ela, nem o AV1 fixado vai.
 */
export function setAv1ProbeOk(ok: boolean) {
    av1ProbeOk = ok;
    if (localCaps.av1ProbeOk !== ok) localCaps = { ...localCaps, av1ProbeOk: ok };
}

/**
 * O WebRtcAV1HWEncode do Chromium nesta partida do Discord (core/av1Flag.ts, o que o loader do add-on fez): true = ligado,
 * false = desligado (o AV1 fixado cai no automatico, com "reinicie o Discord"), null = desconhecido (sem o loader: build do
 * fork, ou um loader antigo; o encodingInfo decide sozinho).
 */
export function setAv1HwFeature(on: boolean | null) {
    av1HwFeature = on;
    if (localCaps.av1HwFeature !== on) localCaps = { ...localCaps, av1HwFeature: on };
}

/** h264HwEncode de novo a partir do que a sonda mediu, das travas (placa travada, sonda WebCodecs rodando) e das quedas. */
function recomputeHwEncode() {
    const hw = !h264HwStuck && !h264HwProbing && !!measured?.h264HwEncode && h264Fallbacks < H264_FALLBACKS_TO_DISABLE;
    if (localCaps.h264HwEncode !== hw) localCaps = { ...localCaps, h264HwEncode: hw };
}

/**
 * A placa de video travou com H.264 (core/stuckEncoder.ts): `stuck` true = o automatico trata o H.264 da placa como
 * indisponivel (h264HwEncode false: chooseCodec escolhe VP9 e nenhum encoder H.264 da placa e criado; fixado em H.264
 * continua). Vale antes da sonda terminar tambem. false = volta ao que a sonda mediu, sem desfazer as quedas para
 * software desta sessao (noteH264Fallback).
 */
export function setH264HwStuck(stuck: boolean) {
    h264HwStuck = stuck;
    recomputeHwEncode();
}

/** A sonda WebCodecs do H.264 da placa esta rodando (true): enquanto isso, o automatico vai de VP9. */
export function setH264HwProbing(running: boolean) {
    h264HwProbing = running;
    recomputeHwEncode();
}

export function isH264HwStuck() {
    return h264HwStuck;
}

/** Na N-esima queda do H.264 para software numa sessao do Discord, o H.264 automatico desliga (noteH264Fallback). */
export const H264_FALLBACKS_TO_DISABLE = 2;

let h264Fallbacks = 0;

export interface H264FallbackTally {
    /** quedas nesta sessao do Discord, contando esta */
    count: number;
    /** esta queda desligou o H.264 automatico (os proximos espectadores recebem VP9) */
    disabledNow: boolean;
}

/**
 * Registra uma queda de verdade do encoder H.264 para software no ar (streaming.ts → checkEncoder). Uma queda so tira
 * do H.264 o espectador que caiu: os proximos ainda tentam a placa de video (pode ter sido algo daquele envio). Na
 * H264_FALLBACKS_TO_DISABLE-esima queda da sessao, desliga o H.264 automatico (h264HwEncode; chooseCodec passa a
 * escolher VP9) no resto da sessao do Discord.
 */
export function noteH264Fallback(): H264FallbackTally {
    h264Fallbacks++;
    let disabledNow = false;
    if (h264Fallbacks >= H264_FALLBACKS_TO_DISABLE && localCaps.h264HwEncode) {
        localCaps = { ...localCaps, h264HwEncode: false };
        disabledNow = true;
    }
    return { count: h264Fallbacks, disabledNow };
}

/**
 * Codec de video para enviar a UM espectador. Unico ponto de decisao (ajustar aqui com dados de teste): o envio
 * (streaming.ts → sendTo) e a troca no ar quando o H.264 cai para software (softwareFallback) passam por aqui.
 *
 * Medido no Discord com aceleracao de GPU desligada (1080p60, receptor novo por codec):
 * VP9 264 ms ate o 1o quadro / 58 fps / CPU 182% (melhor); VP8 327 ms / 56 fps / 249%; AV1 280 ms /
 * 52 fps / 283%; H.264 por software (OpenH264 → FFmpeg) 17,6 s e 106 PLIs (trava). Com GPU ligada,
 * H.264 NVIDIA → D3D11 nao trava e custa bem menos (3 espectadores 1080p60: 91% de um nucleo contra 420% do VP9).
 * Por isso "auto" = H.264 SO quando o espectador decodifica e este PC codifica H.264 por hardware; senao VP9.
 * "Codifica por hardware" = a sonda achou um perfil por hardware e o encoder real nao caiu para software no ar
 * H264_FALLBACKS_TO_DISABLE vezes nesta sessao (h264HwEncode, noteH264Fallback). Com H.264, a decisao leva esse perfil (h264Profile), que vai na frente na negociacao: so o
 * packetization-mode=1 nao basta, porque 42e01f tambem e packetization-mode=1 e cai no OpenH264.
 * High (whyNoHigh): no automatico, com H.264 por hardware nos dois lados, vai High (6400xx, com o Baseline da placa como
 * reserva) so se este PC codifica High por hardware com a sonda do High ok E o espectador anuncia High por hardware.
 * Fixado em H.264 nas configuracoes continua o Baseline de antes.
 * H.265 (whyNoH265): so MANUAL (decisao do dono, 02/11: com internet fraca o H.265 da placa perde fps; o automatico nunca o
 * escolhe). Fixado em H.265: vai so com as redes de seguranca (a placa dos dois lados, a sonda do H.265 ok, o H.264 da placa
 * ligado), com o H.264 que o automatico escolheria como reserva na negociacao; sem elas, o que o automatico escolheria, e o
 * motivo diz isso. AV1 (whyNoHwOnly): o mesmo do H.265, so com o AV1 fixado; sem as redes de seguranca, o que o
 * automatico escolheria (nunca o AV1 por software). AUTO_HW_ONLY (vazio) e a lista dos que o automatico tentaria antes.
 */
export function chooseCodec(viewerCaps: ViewerCodecCaps | undefined, setting: CodecSetting, local: LocalCodecCaps = localCaps): CodecDecision {
    const canSend = (c: VideoCodecName) => local.sendable.size === 0 || local.sendable.has(c);
    const fallback = (why: string): CodecDecision => canSend("vp9")
        ? { codec: "vp9", reason: `${why} → VP9` }
        : { codec: "vp8", reason: `${why}; VP9 indisponível → VP8` };
    const h264 = (reason: string): CodecDecision => ({ codec: "h264", h264Profile: local.h264HwProfile, reason });

    if (isHwOnlyCodec(setting)) {
        // o que o automatico escolheria: a reserva H.264 (so a da placa) ou, sem as redes de seguranca, o codec que vai
        const auto = chooseBaseAuto(viewerCaps, local);
        const no = whyNoHwOnly(setting, viewerCaps, local);
        if (no) return { ...auto, reason: `${HW_ONLY_LABEL[setting]} fixado nas configurações, mas ${no} → ${auto.reason}` };
        return hwOnlyDecision(setting, auto, "fixado nas configurações");
    }

    if (setting && setting !== "auto") {
        if (canSend(setting)) return setting === "h264" ? h264("fixado nas configurações") : { codec: setting, reason: "fixado nas configurações" };
        return fallback(`${setting.toUpperCase()} (configurações) indisponível neste cliente`);
    }

    const auto = chooseBaseAuto(viewerCaps, local);
    // o automatico nunca escolhe H.265 nem AV1 (so fixados) enquanto AUTO_HW_ONLY estiver vazio
    for (const codec of AUTO_HW_ONLY) if (!whyNoHwOnly(codec, viewerCaps, local)) return hwOnlyDecision(codec, auto, "automático");
    return auto;
}

/** O automatico sem os codecs so da placa: H.264 High → Baseline → VP9, como na v0.3.3. */
function chooseBaseAuto(viewerCaps: ViewerCodecCaps | undefined, local: LocalCodecCaps): CodecDecision {
    const canSend = (c: VideoCodecName) => local.sendable.size === 0 || local.sendable.has(c);
    const viewerHw = viewerCaps?.h264HwDecode === true;
    if (viewerHw && local.h264HwEncode && canSend("h264")) return chooseH264Hw(viewerCaps, local);
    const why = `automático: ${!viewerHw ? "o espectador não decodifica H.264 por hardware" : "este PC não codifica H.264 por hardware"}`;
    return canSend("vp9") ? { codec: "vp9", reason: `${why} → VP9` } : { codec: "vp8", reason: `${why}; VP9 indisponível → VP8` };
}

/** "H.265" / "AV1", para os textos. */
export const HW_ONLY_LABEL: Record<HwOnlyCodec, string> = { h265: "H.265", av1: "AV1" };

/**
 * A decisao H.265/AV1 com as redes de seguranca ja conferidas: `auto` (o que o automatico escolheria) vira a reserva H.264
 * na negociacao quando e o H.264 da placa; senao, sem reserva H.264 (o espectador sem H.264 na placa ainda decodifica o
 * codec na placa). `how`: "fixado nas configurações" ou "automático".
 */
function hwOnlyDecision(codec: HwOnlyCodec, auto: CodecDecision, how: string): CodecDecision {
    const label = HW_ONLY_LABEL[codec];
    if (auto.codec !== "h264") {
        return { codec, reason: `${how} (${label} por hardware nos dois lados, com a sonda do ${label} ok; sem reserva H.264 na placa para este espectador)` };
    }
    return {
        codec, h264Profile: auto.h264Profile, ...(auto.h264Backup ? { h264Backup: auto.h264Backup } : {}),
        reason: `${how} (${label} por hardware nos dois lados: este PC codifica ${label} na placa, com a sonda do ${label} ok, e o espectador `
            + `decodifica ${label} na placa; reserva H.264 perfil ${auto.h264Profile ?? "?"}${auto.h264Backup ? `/${auto.h264Backup}` : ""})`
    };
}

/**
 * O que o H.265/AV1 precisa deste PC (whyNoHwOnly sem o espectador; null = este PC pode mandar). Nesta ordem: este
 * cliente, (AV1) o recurso do Chromium nesta partida, este PC, a placa (o H.264 dela desligado leva junto: travou, sonda
 * rodando, quedas), a sonda deste PC. AV1: sem a medicao pronta (sendable vazio) ou com o recurso desconhecido (null: build
 * do fork ou loader antigo), o motivo diz que nao deu para confirmar, nunca "este PC nao codifica" nem "este cliente nao envia".
 */
export function whyNoHwOnlyHere(codec: HwOnlyCodec, local: LocalCodecCaps): string | null {
    const label = HW_ONLY_LABEL[codec];
    if (codec === "av1" && local.sendable.size === 0) return "não deu para confirmar o AV1 da placa nesta partida (a medição da placa ainda não terminou)";
    if (!local.sendable.has(codec)) return `este cliente não envia ${label} (o Chromium dele não oferece)`;
    // AV1: sem o WebRtcAV1HWEncode o WebRTC so tem o AV1 por software, e o recurso so liga na abertura do Discord
    if (codec === "av1" && local.av1HwFeature === false) return "o AV1 da placa de vídeo ainda não está ligado nesta partida do Discord (reinicie o Discord)";
    if (!(codec === "av1" ? local.av1HwFmtp : local.h265HwFmtp)) {
        if (codec !== "av1") return "este PC não codifica H.265 por hardware";
        // so com o recurso ligado a medicao da placa responde de verdade; desconhecido (null) nao diz nada da placa
        return local.av1HwFeature === true ? "este PC não codifica AV1 por hardware (só placas RTX 40/50, Radeon RX 7000, Intel Arc ou mais novas)"
            : "não deu para confirmar o AV1 da placa nesta partida (este Discord não tem a opção do AV1 pela placa)";
    }
    if (!local.h264HwEncode) return `o H.264 da placa está desligado neste PC (travou, sonda rodando ou quedas para software), e o ${label} vai junto`;
    if (!(codec === "av1" ? local.av1ProbeOk : local.h265ProbeOk)) return `a sonda WebCodecs do ${label} não passou neste PC`;
    return null;
}

/** Por que o H.265/AV1 nao vai para este espectador (null = vai): whyNoHwOnlyHere, depois o espectador. */
export function whyNoHwOnly(codec: HwOnlyCodec, viewerCaps: ViewerCodecCaps | undefined, local: LocalCodecCaps): string | null {
    const here = whyNoHwOnlyHere(codec, local);
    if (here) return here;
    // a versao do campo tambem aqui (o sanitizePresence ja descarta outra `v`): sem o decodificador da placa, tela preta
    // (H.265) ou o decodificador por software de quem assiste (AV1)
    if (viewerCaps?.hwDecode?.v !== HW_DECODE_CAPS_VERSION || viewerCaps.hwDecode[codec] !== true) {
        return `o espectador não anuncia ${HW_ONLY_LABEL[codec]} por hardware (não tem, ou é uma versão antiga do Telinha)`;
    }
    return null;
}

/** Por que o H.265 nao vai para este espectador (null = vai): whyNoHwOnly do H.265. */
export function whyNoH265(viewerCaps: ViewerCodecCaps | undefined, local: LocalCodecCaps): string | null {
    return whyNoHwOnly("h265", viewerCaps, local);
}

/** O H.264 da placa no automatico, com os dois lados em H.264 por hardware: High (whyNoHigh) ou o Baseline de antes. */
function chooseH264Hw(viewerCaps: ViewerCodecCaps | undefined, local: LocalCodecCaps): CodecDecision {
    const h264 = (reason: string): CodecDecision => ({ codec: "h264", h264Profile: local.h264HwProfile, reason });
    const noHigh = whyNoHigh(viewerCaps, local);
    if (!noHigh && local.h264HighHwProfile) {
        const backup = local.h264HwProfile && !sameH264Profile(local.h264HwProfile, local.h264HighHwProfile) ? local.h264HwProfile : null;
        return {
            codec: "h264", h264Profile: local.h264HighHwProfile, ...(backup ? { h264Backup: backup } : {}),
            reason: `automático: H.264 High por hardware nos dois lados (perfil ${local.h264HighHwProfile}: este PC codifica High na placa, `
                + `com a sonda do High ok, e o espectador decodifica High na placa${backup ? `; reserva ${backup}` : ""})`
        };
    }
    // placa que so codifica High por hardware: o perfil dela e o High (como antes desta versao); o log diz a verdade
    if (isH264High(local.h264HwProfile)) {
        return h264(`automático: H.264 por hardware nos dois lados (perfil ${local.h264HwProfile}: o único que a placa codifica por hardware, `
            + `então vai High mesmo assim, como antes; ${noHigh})`);
    }
    return h264(`automático: H.264 por hardware nos dois lados (${local.h264HwProfile ? `perfil ${local.h264HwProfile}; ` : ""}High não: ${noHigh})`);
}

/** A decisao H.264 que um envio em H.265/AV1 usa no lugar dele (a reserva da negociacao: h264Profile/h264Backup). */
export function h264ReserveOf(decision: CodecDecision, reason: string): CodecDecision | null {
    if (!isHwOnlyCodec(decision.codec) || !decision.h264Profile) return null;
    return { codec: "h264", h264Profile: decision.h264Profile, ...(decision.h264Backup ? { h264Backup: decision.h264Backup } : {}), reason };
}

/** Por que o High nao vai para este espectador (null = vai). Nesta ordem: este PC, a sonda deste PC, o espectador. */
export function whyNoHigh(viewerCaps: ViewerCodecCaps | undefined, local: LocalCodecCaps): string | null {
    if (!local.h264HighHwProfile) return "este PC não codifica High por hardware";
    if (!local.h264HighProbeOk) return "a sonda WebCodecs do High não passou neste PC";
    if (viewerCaps?.hwDecode?.h264High !== true) return "o espectador não anuncia High por hardware (não tem, ou é uma versão antiga do Telinha)";
    return null;
}

/**
 * Variantes do codec escolhido primeiro; o resto fica como alternativa (ordem original nos empates). H.264: o perfil por
 * hardware (h264Profile), depois o reserva (h264Backup, o Baseline da placa quando vai High), depois os outros
 * packetization-mode=1, depois o resto (sdp.ts → h264Rank). VP9: perfil 0 na frente. H.265 e AV1: Main na frente e, com
 * `h264Profile` (o H.264 reserva), as variantes H.264 nessa ordem logo depois; `matched` conta so as H.265/AV1.
 */
export function sortCodecs<C extends Codec>(codecs: readonly C[], codec: VideoCodecName, h264Profile?: string | null, h264Backup?: string | null): { sorted: C[]; matched: number; } {
    if (isHwOnlyCodec(codec)) {
        const mime = `video/${CODEC_RTP_NAME[codec]}`.toLowerCase();
        const hw = codecs.filter(c => c.mimeType.toLowerCase() === mime).sort((a, b) => hwOnlyRank(codec, a.sdpFmtpLine ?? "") - hwOnlyRank(codec, b.sdpFmtpLine ?? ""));
        const reserve = h264Profile ? sortCodecs(codecs, "h264", h264Profile, h264Backup) : null;
        const front = [...hw, ...(reserve ? reserve.sorted.slice(0, reserve.matched) : [])];
        return { sorted: [...front, ...codecs.filter(c => !front.includes(c))], matched: hw.length };
    }
    const wanted = `video/${CODEC_RTP_NAME[codec]}`.toLowerCase();
    const isWanted = (c: C) => c.mimeType.toLowerCase() === wanted;
    const backup = h264Profile && !sameH264Profile(h264Profile, h264Backup) ? h264Backup : null;
    const rank = (c: C) => {
        const fmtp = c.sdpFmtpLine ?? "";
        if (codec === "h264") return h264Rank(fmtp, h264Profile, backup);
        if (codec === "vp9") return /profile-id=[1-3]/.test(fmtp) ? 1 : 0;
        return 0;
    };
    const preferred = codecs.filter(isWanted).sort((a, b) => rank(a) - rank(b));
    return { sorted: [...preferred, ...codecs.filter(c => !isWanted(c))], matched: preferred.length };
}

const describeError = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * setCodecPreferences no transceiver de envio (antes da oferta/resposta). Tenta as capacidades do
 * sender e depois as do receiver (o Chromium ja aceitou so as do receiver). Devolve uma descricao.
 */
export function applyCodecPreferences(transceiver: RTCRtpTransceiver, codec: VideoCodecName, h264Profile?: string | null, h264Backup?: string | null): string {
    const sources = [
        ["sender", () => RTCRtpSender.getCapabilities("video")?.codecs],
        ["receiver", () => RTCRtpReceiver.getCapabilities("video")?.codecs]
    ] as const;

    let lastError = "";
    for (const [name, get] of sources) {
        const caps = get();
        if (!caps?.length) continue;
        const { sorted, matched } = sortCodecs(caps, codec, h264Profile, h264Backup);
        if (!matched) {
            lastError = `${CODEC_RTP_NAME[codec]} ausente em ${name}.getCapabilities`;
            continue;
        }
        try {
            transceiver.setCodecPreferences(sorted);
            const first = h264ProfileLevelId(sorted[0].sdpFmtpLine ?? "");
            const firstOk = codec === "h264" && isPacketizationMode1(sorted[0].sdpFmtpLine ?? "");
            if (isHwOnlyCodec(codec)) {
                const reserve = h264Profile ? `reserva H.264 perfil ${h264Profile}${h264Backup ? `/${h264Backup}` : ""} logo depois` : "sem reserva H.264";
                return `${CODEC_RTP_NAME[codec]} primeiro (${matched} variante(s), capacidades do ${name}; ${reserve})`;
            }
            const profile = firstOk && sameH264Profile(first, h264Profile) ? ` (perfil ${h264Profile})`
                : firstOk && h264Profile && sameH264Profile(first, h264Backup) ? ` (perfil ${h264Backup}, sem o ${h264Profile})` : "";
            return `${CODEC_RTP_NAME[codec]}${profile} primeiro (${matched} variante(s), capacidades do ${name})`;
        } catch (e) {
            lastError = describeError(e);
        }
    }
    return `setCodecPreferences não aplicado (${lastError || "sem capacidades"})`;
}

/**
 * Codec para RTCRtpEncodingParameters.codec (troca no ar, sem renegociar): a melhor variante do codec da decisao entre
 * os ja negociados com o espectador (sender.getParameters().codecs), so com os campos de RTCRtpCodec. null se nao foi
 * negociado.
 */
export function pickNegotiatedCodec(negotiated: readonly Codec[], decision: CodecDecision): RTCRtpCodec | null {
    const { sorted, matched } = sortCodecs(negotiated, decision.codec, decision.h264Profile, decision.h264Backup);
    if (!matched) return null;
    const { mimeType, clockRate, channels, sdpFmtpLine } = sorted[0];
    return { mimeType, clockRate, ...(channels !== undefined ? { channels } : {}), ...(sdpFmtpLine !== undefined ? { sdpFmtpLine } : {}) };
}

/** O que o getStats diz do encoder de UM envio de video (outbound-rtp e o codec dele). */
export interface EncoderReport {
    /** mimeType do codec em uso, ex.: "video/H264" */
    mimeType: string;
    /** encoderImplementation, ex.: "OpenH264" ou "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)" */
    implementation?: string;
    /** powerEfficientEncoder */
    powerEfficient?: boolean;
    framesEncoded?: number;
    /** frameWidth/frameHeight do ultimo quadro codificado */
    width?: number;
    height?: number;
    /** qualityLimitationReason ("none", "bandwidth", "cpu", "other"): o WebRTC esta reduzindo a resolucao por conta propria? */
    limitation?: string;
}

/**
 * Menor altura que o Chromium codifica H.264 na placa de video (RTCVideoEncoder::UseSoftwareForLowResolution, feature
 * kForceSoftwareForRtcLowResolutions; 270 para AV1). Abaixo disso, ou com largura/altura impar ("hardware H.264 encoder
 * only supports even sized frames"), o InitEncode pede WEBRTC_VIDEO_CODEC_FALLBACK_SOFTWARE e o WebRTC usa o OpenH264.
 */
export const H264_HW_MIN_HEIGHT = 360;

/** O RTCVideoEncoder do Chromium aceita codificar H.264 na placa de video um quadro deste tamanho? */
export function h264HwAcceptsSize(width: number, height: number): boolean {
    return width % 2 === 0 && height % 2 === 0 && height >= H264_HW_MIN_HEIGHT;
}

/** Famílias de codec de um mimeType ou de um nome de encoder (encoderFamilyOf, mimeFamilyOf). */
export type CodecFamily = "h264" | "h265" | "av1" | "vpx";

/**
 * A familia de codec que um encoderImplementation do Chromium codifica, pelo nome: "OpenH264" e "... H.264 Encoder MFT"
 * (h264), "... HEVC/H.265 ..." (h265), "libaom", "SVT-AV1", "rav1e" e "... AV1 Encoder ..." (av1), "libvpx" e "... VP9 ..."
 * (vpx). undefined = o nome nao diz (ex.: "ExternalEncoder", "MediaFoundationVideoEncodeAccelerator" sem o fabricante).
 */
export function encoderFamilyOf(implementation: string | undefined): CodecFamily | undefined {
    const name = implementation ?? "";
    // "av1" solto no meio: nomes colados como "AMDav1Encoder" (sem \b dos dois lados)
    if (/libaom|svt-?av1|rav1e|dav1d|av1/i.test(name)) return "av1";
    if (/libvpx|\bvp[89]\b/i.test(name)) return "vpx";
    if (/hevc|h\.?265/i.test(name)) return "h265";
    if (/openh264|h\.?264|\bavc\b/i.test(name)) return "h264";
    return undefined;
}

/** A familia de codec de um mimeType ("video/H264" → h264). undefined = outro (ex.: rtx, red). */
export function mimeFamilyOf(mimeType: string): CodecFamily | undefined {
    const m = /^video\/(h264|h265|hevc|av1|vp8|vp9)$/i.exec(mimeType)?.[1]?.toLowerCase();
    if (!m) return undefined;
    return m === "hevc" ? "h265" : m === "vp8" || m === "vp9" ? "vpx" : (m as CodecFamily);
}

/**
 * O encoder do relatorio e de OUTRO codec que o mimeType dele? O getStats le o codec (codecId) e o encoder
 * (encoderImplementation) em momentos diferentes: logo depois de a preferencia de codec valer, o outbound-rtp ja aponta
 * para o H.264 negociado mas o encoder ainda e o do codec anterior (log de 02/11: libaom, o AV1 por software, sem tamanho
 * e sem powerEfficientEncoder de H.264, 0,4 s depois da resposta). Esse relatorio nao diz nada do codec julgado: quem
 * confere o encoder espera as proximas estatisticas (streaming.ts → tick, isSoftwareH264, isOffHardwareAv1). Sem nome
 * conclusivo, ou com o mesmo codec, false.
 */
export function isForeignEncoder(r: EncoderReport): boolean {
    const encoder = encoderFamilyOf(r.implementation);
    const wanted = mimeFamilyOf(r.mimeType);
    return !!encoder && !!wanted && encoder !== wanted;
}

/**
 * O envio esta em H.264 codificado por software? So com evidencia: o encoder ja produziu quadros e diz
 * powerEfficientEncoder false, ou (sem esse campo) se chama OpenH264. O Chromium so expoe os dois campos com uma
 * captura no ar; sem eles nao da para saber (false). O encoder de outro codec (libaom do AV1 de antes da troca,
 * isForeignEncoder) nunca e o H.264 caindo para software.
 */
export function isSoftwareH264(r: EncoderReport): boolean {
    if (!/^video\/h264$/i.test(r.mimeType) || (r.framesEncoded ?? 0) <= 0 || isForeignEncoder(r)) return false;
    if (typeof r.powerEfficient === "boolean") return !r.powerEfficient;
    return /openh264/i.test(r.implementation ?? "");
}

/**
 * H.264 em software DE PROPOSITO, nao por falha da placa: o quadro esta num tamanho que a placa de video nao aceita
 * (h264HwAcceptsSize: impar ou abaixo de 360p), seja qual for o qualityLimitationReason. Medido no Chromium 152 (RTX
 * 3070): com a banda baixa o proprio WebRTC reduz a resolucao (degradationPreference "maintain-framerate"), chega num
 * tamanho desses, o OpenH264 assume nesse quadro e a placa volta sozinha na proxima reconfiguracao com um tamanho valido,
 * sem o espectador travar. O qualityLimitationReason nao serve para separar: o WebRTC so sobe a resolucao de novo depois
 * de varios segundos sem limitacao, entao o motivo volta para "none" com o tamanho reduzido (853x480) ainda no ar. Foi o
 * que aconteceu no log de 31/10: 20-30 s depois de cada reducao o mesmo 853x480 com "none" contou como queda, a 2a
 * desligou o H.264 da sessao e o PC passou a codificar VP9 por software. Uma reducao nossa com tamanho impar (1798x1080
 * ÷1,5 = 1199x720, que quality/levels.ts → evenScale evita) tambem nao e a placa falhando. Sem tamanho: nao da para
 * saber (false, como antes). Nunca conta como queda (softwareFallback).
 */
export function isTransientSoftwareH264(r: EncoderReport): boolean {
    if (!isSoftwareH264(r) || !r.width || !r.height) return false;
    return !h264HwAcceptsSize(r.width, r.height);
}

/**
 * O H.265 deste envio saiu da placa: o encoder em uso ja produziu quadros e diz powerEfficientEncoder false. O Chromium
 * nao tem H.265 por software, entao isso quase nunca aparece: quando o encoder da placa falha, o WebRTC troca sozinho
 * para o proximo codec negociado (o H.264 reserva), e quem chama ve o mimeType mudar (streaming.ts → checkH265).
 */
export function isOffHardwareH265(r: EncoderReport): boolean {
    return /^video\/h265$/i.test(r.mimeType) && (r.framesEncoded ?? 0) > 0 && r.powerEfficient === false && !isForeignEncoder(r);
}

/**
 * Menor altura que o Chromium codifica AV1 na placa de video (RTCVideoEncoder::UseSoftwareForLowResolution: 270 no AV1,
 * 360 nos outros). Abaixo disso o WebRTC usa o libaom DE PROPOSITO, num quadro pequeno e barato: nao e a placa falhando.
 */
export const AV1_HW_MIN_HEIGHT = 270;

/**
 * O AV1 deste envio saiu da placa: o encoder em uso ja produziu quadros e diz powerEfficientEncoder false, ou (sem esse
 * campo) se chama libaom/SVT/rav1e. Diferente do H.265, o Chromium TEM AV1 por software: quando o encoder da placa falha
 * (ao subir ou no meio), o VideoEncoderSoftwareFallbackWrapper do WebRTC passa para o libaom SEM trocar de codec, pesado
 * demais para 1080p60 com um jogo. Quem chama sai do AV1 (streaming.ts → checkHwOnly → leaveHwOnly). Um quadro abaixo de
 * 270p (AV1_HW_MIN_HEIGHT) e o software de proposito e nao conta. Sem evidencia: false.
 */
export function isOffHardwareAv1(r: EncoderReport): boolean {
    if (!/^video\/av1$/i.test(r.mimeType) || (r.framesEncoded ?? 0) <= 0 || isForeignEncoder(r)) return false;
    if (r.height && r.height < AV1_HW_MIN_HEIGHT) return false;
    if (typeof r.powerEfficient === "boolean") return !r.powerEfficient;
    return /libaom|svt|rav1e/i.test(r.implementation ?? "");
}

/** O H.265 ou o AV1 deste envio saiu da placa (isOffHardwareH265 / isOffHardwareAv1). */
export function isOffHardwareHwOnly(codec: HwOnlyCodec, r: EncoderReport): boolean {
    return codec === "av1" ? isOffHardwareAv1(r) : isOffHardwareH265(r);
}

/**
 * Checagem no ar de UM envio (streaming.ts → tick), no maximo uma vez por espectador (`alreadyChecked`): se o H.264
 * caiu para software de verdade (num tamanho que a placa aceita, ver isTransientSoftwareH264), o codec para ESTE espectador, o que
 * chooseCodec escolhe com este PC sem H.264 por hardware (VP9; continua H.264 so se estiver fixado nas configuracoes).
 * Nao mexe na sessao: quem chama registra a queda (noteH264Fallback). null = nada a fazer (sem evidencia, de passagem,
 * outro codec ou ja tratado).
 */
export function softwareFallback(
    report: EncoderReport, alreadyChecked: boolean, viewerCaps: ViewerCodecCaps | undefined, setting: CodecSetting,
    local: LocalCodecCaps = localCaps
): CodecDecision | null {
    if (alreadyChecked || !isSoftwareH264(report) || isTransientSoftwareH264(report)) return null;
    return chooseCodec(viewerCaps, setting, { ...local, h264HwEncode: false });
}
