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
// nao ha imagem. Por isso o automatico (chooseCodec) so manda H.265 quando, alem de tudo que o H.264 da placa precisa
// (h264HwEncode: nada travado, nenhuma sonda rodando, sem as quedas), este PC envia H.265 (sender.getCapabilities) e o
// codifica na placa (encodingInfo do fmtp Main do sender, h265HwFmtp), a sonda WebCodecs do H.265 deu "ok" neste ambiente
// (core/stuckEncoder.ts → setH265ProbeOk) E o espectador anuncia que decodifica na placa (caps.hwDecode.h265, protocol.ts
// passo 11). A ordem no automatico: H.265 → H.264 High → H.264 Baseline → VP9. Com H.265, o H.264 que iria sem ele vai
// logo depois na negociacao (h264Profile/h264Backup da decisao): se o outro lado nao negociar H.265, fica a placa em H.264.

import { H264_PROBE, HW_DECODE_CAPS_VERSION, type HwDecodeCaps } from "@plugins/telinha/protocol";
import type { CodecSetting } from "@plugins/telinha/settings";

import { CODEC_RTP_NAME, h264ProfileLevelId, h264Rank, h265Rank, isH264High, isH265Main, isPacketizationMode1, sameH264Profile, type VideoCodecName } from "./sdp";

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

export const PROBE_TIMING: ProbeTiming = { callMs: 3000, totalMs: 6000 };

let localCaps: LocalCodecCaps = {
    h264HwDecode: false, h264HwEncode: false, h264HwProfile: null, h264HighHwDecode: false, h264HighHwProfile: null, h264HighProbeOk: false,
    h265HwDecode: false, h265HwFmtp: null, h265ProbeOk: false, sendable: new Set()
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

/**
 * Primeiro fmtp de `fmtps` (na ordem) que o mediaCapabilities diz ser eficiente (hardware), ou null. Uma consulta por
 * vez ("video/H264;<fmtp>" ou "video/H265;<fmtp>", 1080p60, 8 Mbps), cada uma com ate timing.callMs, e todas juntas com
 * ate timing.totalMs. Erro ou estouro = nao.
 */
async function firstPowerEfficient(kind: "decodingInfo" | "encodingInfo", fmtps: readonly string[], timing: ProbeTiming, mime = "H264"): Promise<string | null> {
    const mc = (globalThis.navigator as any)?.mediaCapabilities;
    if (typeof mc?.[kind] !== "function") return null;
    const deadline = Date.now() + timing.totalMs;
    for (const fmtp of fmtps) {
        const left = deadline - Date.now();
        if (left <= 0) break;
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
 * nenhuma consulta e H.265 nao.
 */
export async function measureLocalCaps(timing: ProbeTiming = PROBE_TIMING): Promise<LocalCodecCaps> {
    const senderCodecs = videoCodecs("sender");
    const receiverCodecs = videoCodecs("receiver");
    const senderH264 = h264Candidates(senderCodecs);
    const receiverH264 = h264Candidates(receiverCodecs);
    const [decodeFmtp, encodeFmtp, highDecodeFmtp, highEncodeFmtp, h265DecodeFmtp, h265EncodeFmtp] = await Promise.all([
        firstPowerEfficient("decodingInfo", receiverH264.slice(0, 1), timing),
        firstPowerEfficient("encodingInfo", senderH264, timing),
        firstPowerEfficient("decodingInfo", highOnly(receiverH264).slice(0, 1), timing),
        firstPowerEfficient("encodingInfo", highOnly(senderH264), timing),
        firstPowerEfficient("decodingInfo", h265Candidates(receiverCodecs).slice(0, 1), timing, "H265"),
        firstPowerEfficient("encodingInfo", h265Candidates(senderCodecs), timing, "H265")
    ]);
    const h264HwProfile = encodeFmtp ? h264ProfileLevelId(encodeFmtp) : null;
    return {
        h264HwDecode: decodeFmtp !== null, h264HwEncode: h264HwProfile !== null, h264HwProfile,
        h264HighHwDecode: highDecodeFmtp !== null, h264HighHwProfile: highEncodeFmtp ? h264ProfileLevelId(highEncodeFmtp) : null, h264HighProbeOk: false,
        h265HwDecode: h265DecodeFmtp !== null, h265HwFmtp: h265EncodeFmtp, h265ProbeOk: false,
        sendable: sendableCodecs(senderCodecs)
    };
}

/**
 * Linha do log de inicio (ex.: "... codifica: sim (perfil 42001f); envia: h264, vp8, vp9, av1; H.264 High por hardware —
 * decodifica: sim, codifica: sim (perfil 640032); H.265 por hardware — decodifica: sim, codifica: sim (level-id=123;...)").
 * O "codifica" do High e do H.265 e o do encodingInfo; as sondas deles vem depois.
 */
export function describeLocalCaps(caps: LocalCodecCaps): string {
    const encode = caps.h264HwEncode ? `sim${caps.h264HwProfile ? ` (perfil ${caps.h264HwProfile})` : ""}` : "não";
    const high = `H.264 High por hardware — decodifica: ${caps.h264HighHwDecode ? "sim" : "não"}, codifica: ${caps.h264HighHwProfile ? `sim (perfil ${caps.h264HighHwProfile})` : "não"}`;
    // H.265 so quando este Chromium o oferece ou mede (sem ele, a linha de antes)
    const h265 = caps.h265HwDecode || caps.h265HwFmtp || caps.sendable.has("h265")
        ? `; H.265 por hardware — decodifica: ${caps.h265HwDecode ? "sim" : "não"}, codifica: ${caps.h265HwFmtp ? `sim (${caps.h265HwFmtp})` : "não"}` : "";
    return `Capacidades locais: H.264 por hardware — decodifica: ${caps.h264HwDecode ? "sim" : "não"}, codifica: ${encode}; envia: ${[...caps.sendable].join(", ") || "?"}; ${high}${h265}`;
}

/** Mede uma vez por sessao do Discord. `report` recebe a linha de log da medicao (so na primeira chamada). */
export function probeLocalCaps(report?: (line: string) => void): Promise<LocalCodecCaps> {
    return probing ??= measureLocalCaps().then(caps => {
        measured = caps;
        localCaps = { ...caps, h264HwEncode: caps.h264HwEncode && !h264HwStuck && !h264HwProbing, h264HighProbeOk, h265ProbeOk };
        report?.(describeLocalCaps(caps));
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
 * travou, ou um envio em H.265 falhou no ar nesta sessao. Sem ela o automatico nunca escolhe H.265.
 */
export function setH265ProbeOk(ok: boolean) {
    h265ProbeOk = ok;
    if (localCaps.h265ProbeOk !== ok) localCaps = { ...localCaps, h265ProbeOk: ok };
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
 * H.265 (whyNoH265): no automatico, na frente de tudo isso, so com a placa dos dois lados e a sonda do H.265 ok; o H.264
 * que iria sem ele vira a reserva na negociacao. Fixado em H.265: as mesmas redes de seguranca (nunca sem a placa dos dois
 * lados, sem a sonda ou com o H.264 da placa desligado); sem elas, o que o automatico escolheria, e o motivo diz isso.
 */
export function chooseCodec(viewerCaps: ViewerCodecCaps | undefined, setting: CodecSetting, local: LocalCodecCaps = localCaps): CodecDecision {
    const canSend = (c: VideoCodecName) => local.sendable.size === 0 || local.sendable.has(c);
    const fallback = (why: string): CodecDecision => canSend("vp9")
        ? { codec: "vp9", reason: `${why} → VP9` }
        : { codec: "vp8", reason: `${why}; VP9 indisponível → VP8` };
    const h264 = (reason: string): CodecDecision => ({ codec: "h264", h264Profile: local.h264HwProfile, reason });

    if (setting === "h265") {
        // as redes de seguranca do automatico valem; o espectador sem H.264 na placa ainda recebe H.265 (sem reserva H.264)
        const auto = chooseCodec(viewerCaps, "auto", local);
        if (auto.codec === "h265") return { ...auto, reason: `fixado nas configurações (${auto.reason.replace(/^automático: /, "")})` };
        const noH265 = whyNoH265(viewerCaps, local);
        if (!noH265) return { codec: "h265", reason: "fixado nas configurações (H.265 por hardware nos dois lados, com a sonda do H.265 ok; sem reserva H.264 na placa para este espectador)" };
        return { ...auto, reason: `H.265 fixado nas configurações, mas ${noH265} → ${auto.reason}` };
    }

    if (setting && setting !== "auto") {
        if (canSend(setting)) return setting === "h264" ? h264("fixado nas configurações") : { codec: setting, reason: "fixado nas configurações" };
        return fallback(`${setting.toUpperCase()} (configurações) indisponível neste cliente`);
    }

    const viewerHw = viewerCaps?.h264HwDecode === true;
    if (viewerHw && local.h264HwEncode && canSend("h264")) {
        const reserve = chooseH264Hw(viewerCaps, local);
        const noH265 = whyNoH265(viewerCaps, local);
        if (!noH265) {
            return {
                codec: "h265", h264Profile: reserve.h264Profile, ...(reserve.h264Backup ? { h264Backup: reserve.h264Backup } : {}),
                reason: "automático: H.265 por hardware nos dois lados (este PC codifica H.265 na placa, com a sonda do H.265 ok, e o espectador "
                    + `decodifica H.265 na placa; reserva H.264 perfil ${reserve.h264Profile ?? "?"}${reserve.h264Backup ? `/${reserve.h264Backup}` : ""})`
            };
        }
        // so num PC que codifica H.265 na placa o motivo do "sem H.265" interessa (os outros: a linha de antes)
        return local.h265HwFmtp ? { ...reserve, reason: `${reserve.reason}; H.265 não: ${noH265}` } : reserve;
    }

    return fallback(`automático: ${!viewerHw ? "o espectador não decodifica H.264 por hardware" : "este PC não codifica H.264 por hardware"}`);
}

/**
 * Por que o H.265 nao vai para este espectador (null = vai). Nesta ordem: este cliente, este PC, a placa (o H.264 dela
 * desligado leva o H.265 junto: travou, sonda rodando, quedas), a sonda deste PC, o espectador.
 */
export function whyNoH265(viewerCaps: ViewerCodecCaps | undefined, local: LocalCodecCaps): string | null {
    if (!local.sendable.has("h265")) return "este cliente não envia H.265 (o Chromium dele não oferece)";
    if (!local.h265HwFmtp) return "este PC não codifica H.265 por hardware";
    if (!local.h264HwEncode) return "o H.264 da placa está desligado neste PC (travou, sonda rodando ou quedas para software), e o H.265 vai junto";
    if (!local.h265ProbeOk) return "a sonda WebCodecs do H.265 não passou neste PC";
    // a versao do campo tambem aqui (o sanitizePresence ja descarta outra `v`): um H.265 sem decodificador e tela preta
    if (viewerCaps?.hwDecode?.v !== HW_DECODE_CAPS_VERSION || viewerCaps.hwDecode.h265 !== true) return "o espectador não anuncia H.265 por hardware (não tem, ou é uma versão antiga do Telinha)";
    return null;
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

/** A decisao H.264 que um envio em H.265 usa no lugar dele (a reserva da negociacao: h264Profile/h264Backup). */
export function h264ReserveOf(decision: CodecDecision, reason: string): CodecDecision | null {
    if (decision.codec !== "h265" || !decision.h264Profile) return null;
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
 * packetization-mode=1, depois o resto (sdp.ts → h264Rank). VP9: perfil 0 na frente. H.265: Main na frente e, com
 * `h264Profile` (o H.264 reserva), as variantes H.264 nessa ordem logo depois; `matched` conta so as H.265.
 */
export function sortCodecs<C extends Codec>(codecs: readonly C[], codec: VideoCodecName, h264Profile?: string | null, h264Backup?: string | null): { sorted: C[]; matched: number; } {
    if (codec === "h265") {
        const h265 = codecs.filter(c => /^video\/h265$/i.test(c.mimeType)).sort((a, b) => h265Rank(a.sdpFmtpLine ?? "") - h265Rank(b.sdpFmtpLine ?? ""));
        const reserve = h264Profile ? sortCodecs(codecs, "h264", h264Profile, h264Backup) : null;
        const front = [...h265, ...(reserve ? reserve.sorted.slice(0, reserve.matched) : [])];
        return { sorted: [...front, ...codecs.filter(c => !front.includes(c))], matched: h265.length };
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
            if (codec === "h265") {
                const reserve = h264Profile ? `reserva H.264 perfil ${h264Profile}${h264Backup ? `/${h264Backup}` : ""} logo depois` : "sem reserva H.264";
                return `H265 primeiro (${matched} variante(s), capacidades do ${name}; ${reserve})`;
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
 * O H.265 deste envio saiu da placa: o encoder em uso ja produziu quadros e diz powerEfficientEncoder false. O Chromium
 * nao tem H.265 por software, entao isso quase nunca aparece: quando o encoder da placa falha, o WebRTC troca sozinho
 * para o proximo codec negociado (o H.264 reserva), e quem chama ve o mimeType mudar (streaming.ts → checkH265).
 */
export function isOffHardwareH265(r: EncoderReport): boolean {
    return /^video\/h265$/i.test(r.mimeType) && (r.framesEncoded ?? 0) > 0 && r.powerEfficient === false;
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
