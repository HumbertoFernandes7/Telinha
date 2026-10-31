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

import { H264_PROBE } from "@plugins/telinha/protocol";
import type { CodecSetting } from "@plugins/telinha/settings";

import { CODEC_RTP_NAME, h264ProfileLevelId, h264Rank, isPacketizationMode1, type VideoCodecName } from "./sdp";

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
    /** codecs de video que este cliente sabe enviar (vazio = desconhecido) */
    sendable: Set<VideoCodecName>;
}

export interface CodecDecision {
    codec: VideoCodecName;
    /** H.264: perfil que vai na frente na negociacao (o por hardware); null/ausente = so packetization-mode=1 na frente */
    h264Profile?: string | null;
    reason: string;
}

/** Limites da sonda: cada consulta ao mediaCapabilities e a sonda inteira (os perfis vao um de cada vez). */
export interface ProbeTiming {
    callMs: number;
    totalMs: number;
}

export const PROBE_TIMING: ProbeTiming = { callMs: 3000, totalMs: 6000 };

let localCaps: LocalCodecCaps = { h264HwDecode: false, h264HwEncode: false, h264HwProfile: null, sendable: new Set() };
let probing: Promise<LocalCodecCaps> | null = null;
/** o que a sonda mediu (null = ainda nao mediu): o H.264 automatico volta para isto quando deixa de estar travado */
let measured: LocalCodecCaps | null = null;
/** a placa de video travou com H.264 nesta sessao, ou neste PC com o mesmo ambiente (core/stuckEncoder.ts) */
let h264HwStuck = false;
/** a sonda WebCodecs do H.264 da placa esta rodando (core/encoderProbe.ts): ate ela acabar, o automatico vai de VP9 */
let h264HwProbing = false;

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

/**
 * Primeiro fmtp de `fmtps` (na ordem) que o mediaCapabilities diz ser eficiente (hardware), ou null. Uma consulta por
 * vez ("video/H264;<fmtp>", 1080p60, 8 Mbps), cada uma com ate timing.callMs, e todas juntas com ate timing.totalMs.
 * Erro ou estouro = nao.
 */
async function firstPowerEfficient(kind: "decodingInfo" | "encodingInfo", fmtps: readonly string[], timing: ProbeTiming): Promise<string | null> {
    const mc = (globalThis.navigator as any)?.mediaCapabilities;
    if (typeof mc?.[kind] !== "function") return null;
    const deadline = Date.now() + timing.totalMs;
    for (const fmtp of fmtps) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        try {
            const config = { ...H264_PROBE, video: { ...H264_PROBE.video, contentType: `video/H264;${fmtp}` } };
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

/**
 * Mede as capacidades (sem memorizar). Codifica: o primeiro perfil H.264 packetization-mode=1 do sender que o
 * encodingInfo diz ser por hardware. Decodifica: o primeiro perfil packetization-mode=1 do receiver (o que o Chromium
 * lista primeiro, em geral 42001f, o mesmo que uma placa NVIDIA codifica).
 */
export async function measureLocalCaps(timing: ProbeTiming = PROBE_TIMING): Promise<LocalCodecCaps> {
    const senderCodecs = videoCodecs("sender");
    const [decodeFmtp, encodeFmtp] = await Promise.all([
        firstPowerEfficient("decodingInfo", h264Candidates(videoCodecs("receiver")).slice(0, 1), timing),
        firstPowerEfficient("encodingInfo", h264Candidates(senderCodecs), timing)
    ]);
    const h264HwProfile = encodeFmtp ? h264ProfileLevelId(encodeFmtp) : null;
    return { h264HwDecode: decodeFmtp !== null, h264HwEncode: h264HwProfile !== null, h264HwProfile, sendable: sendableCodecs(senderCodecs) };
}

/** Linha do log de inicio (ex.: "... codifica: sim (perfil 42001f); envia: h264, vp8, vp9, av1"). */
export function describeLocalCaps(caps: LocalCodecCaps): string {
    const encode = caps.h264HwEncode ? `sim${caps.h264HwProfile ? ` (perfil ${caps.h264HwProfile})` : ""}` : "não";
    return `Capacidades locais: H.264 por hardware — decodifica: ${caps.h264HwDecode ? "sim" : "não"}, codifica: ${encode}; envia: ${[...caps.sendable].join(", ") || "?"}`;
}

/** Mede uma vez por sessao do Discord. `report` recebe a linha de log da medicao (so na primeira chamada). */
export function probeLocalCaps(report?: (line: string) => void): Promise<LocalCodecCaps> {
    return probing ??= measureLocalCaps().then(caps => {
        measured = caps;
        localCaps = h264HwStuck || h264HwProbing ? { ...caps, h264HwEncode: false } : caps;
        report?.(describeLocalCaps(caps));
        return caps;
    });
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
 */
export function chooseCodec(viewerCaps: { h264HwDecode: boolean; } | undefined, setting: CodecSetting, local: LocalCodecCaps = localCaps): CodecDecision {
    const canSend = (c: VideoCodecName) => local.sendable.size === 0 || local.sendable.has(c);
    const fallback = (why: string): CodecDecision => canSend("vp9")
        ? { codec: "vp9", reason: `${why} → VP9` }
        : { codec: "vp8", reason: `${why}; VP9 indisponível → VP8` };
    const h264 = (reason: string): CodecDecision => ({ codec: "h264", h264Profile: local.h264HwProfile, reason });

    if (setting && setting !== "auto") {
        if (canSend(setting)) return setting === "h264" ? h264("fixado nas configurações") : { codec: setting, reason: "fixado nas configurações" };
        return fallback(`${setting.toUpperCase()} (configurações) indisponível neste cliente`);
    }

    const viewerHw = viewerCaps?.h264HwDecode === true;
    if (viewerHw && local.h264HwEncode && canSend("h264"))
        return h264(`automático: H.264 por hardware nos dois lados${local.h264HwProfile ? ` (perfil ${local.h264HwProfile})` : ""}`);

    return fallback(`automático: ${!viewerHw ? "o espectador não decodifica H.264 por hardware" : "este PC não codifica H.264 por hardware"}`);
}

/**
 * Variantes do codec escolhido primeiro; o resto fica como alternativa (ordem original nos empates). H.264: o perfil por
 * hardware (h264Profile), depois os outros packetization-mode=1, depois o resto (sdp.ts → h264Rank). VP9: perfil 0 na frente.
 */
export function sortCodecs<C extends Codec>(codecs: readonly C[], codec: VideoCodecName, h264Profile?: string | null) {
    const wanted = `video/${CODEC_RTP_NAME[codec]}`.toLowerCase();
    const isWanted = (c: C) => c.mimeType.toLowerCase() === wanted;
    const rank = (c: C) => {
        const fmtp = c.sdpFmtpLine ?? "";
        if (codec === "h264") return h264Rank(fmtp, h264Profile);
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
export function applyCodecPreferences(transceiver: RTCRtpTransceiver, codec: VideoCodecName, h264Profile?: string | null): string {
    const sources = [
        ["sender", () => RTCRtpSender.getCapabilities("video")?.codecs],
        ["receiver", () => RTCRtpReceiver.getCapabilities("video")?.codecs]
    ] as const;

    let lastError = "";
    for (const [name, get] of sources) {
        const caps = get();
        if (!caps?.length) continue;
        const { sorted, matched } = sortCodecs(caps, codec, h264Profile);
        if (!matched) {
            lastError = `${CODEC_RTP_NAME[codec]} ausente em ${name}.getCapabilities`;
            continue;
        }
        try {
            transceiver.setCodecPreferences(sorted);
            const profile = codec === "h264" && h264Profile && h264Rank(sorted[0].sdpFmtpLine ?? "", h264Profile) === 0 ? ` (perfil ${h264Profile})` : "";
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
    const { sorted, matched } = sortCodecs(negotiated, decision.codec, decision.h264Profile);
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

/**
 * O envio esta em H.264 codificado por software? So com evidencia: o encoder ja produziu quadros e diz
 * powerEfficientEncoder false, ou (sem esse campo) se chama OpenH264. O Chromium so expoe os dois campos com uma
 * captura no ar; sem eles nao da para saber (false).
 */
export function isSoftwareH264(r: EncoderReport): boolean {
    if (!/^video\/h264$/i.test(r.mimeType) || (r.framesEncoded ?? 0) <= 0) return false;
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
 * Checagem no ar de UM envio (streaming.ts → tick), no maximo uma vez por espectador (`alreadyChecked`): se o H.264
 * caiu para software de verdade (num tamanho que a placa aceita, ver isTransientSoftwareH264), o codec para ESTE espectador, o que
 * chooseCodec escolhe com este PC sem H.264 por hardware (VP9; continua H.264 so se estiver fixado nas configuracoes).
 * Nao mexe na sessao: quem chama registra a queda (noteH264Fallback). null = nada a fazer (sem evidencia, de passagem,
 * outro codec ou ja tratado).
 */
export function softwareFallback(
    report: EncoderReport, alreadyChecked: boolean, viewerCaps: { h264HwDecode: boolean; } | undefined, setting: CodecSetting,
    local: LocalCodecCaps = localCaps
): CodecDecision | null {
    if (alreadyChecked || !isSoftwareH264(report) || isTransientSoftwareH264(report)) return null;
    return chooseCodec(viewerCaps, setting, { ...local, h264HwEncode: false });
}
