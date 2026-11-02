/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A placa de video que trava com H.264 (Telinha 0.2.9). Visto em 31/10/2026 numa placa AMD (MediaFoundation
// AMDh264Encoder): o encoder H.264 da placa sobe e nunca solta um quadro. Parado, ele nao atrapalha (o audio continua e a
// conexao fica no ar), mas desmontar esse envio (trocar o codec com setParameters, removeTrack, fechar a conexao) faz o
// Chromium esperar o encoder para sempre na thread WebRTC_W_and_N, que TODAS as conexoes do Discord usam: as conexoes
// caem e a proxima chamada sincrona congela o Discord. O streaming.ts contem esse envio (containStuck) e aqui fica o
// resto, "cada PC aprende sozinho":
// - travou: o H.264 automatico desliga na hora para o resto da sessao (codec.ts → setH264HwStuck) e o PC lembra, nas
//   configuracoes do plugin (chave privada stuckHwH264), quando foi e em que ambiente (placa de video ativa, driver,
//   Chromium, Discord);
// - nas proximas sessoes com o mesmo ambiente, o automatico comeca em VP9 e nenhum encoder H.264 da placa e criado
//   (codec fixado em H.264 continua H.264);
// - o H.264 da placa volta a ser tentado quando o ambiente muda (driver, versao principal do Chromium, outra placa; a
//   versao do Discord nao conta) E a sonda deste ambiente diz "ok", ou pelo botao "Tentar a placa de vídeo de novo"
//   (ui/StuckEncoderSection.tsx), que tambem roda a sonda de novo;
// - antes da 1a transmissao, uma vez por ambiente: a sonda WebCodecs (core/encoderProbe.ts) codifica uns quadros com o
//   H.264 da placa num Worker. Travou duas vezes (a 2a rodada confirma) = o mesmo registro de "travou", entao a 1a
//   transmissao ja vai em VP9 e nenhum encoder H.264 do WebRTC e criado. O resultado fica salvo (chave privada
//   hwH264Probe) e ela so roda de novo quando o ambiente muda. O checkStall + containStuck do streaming.ts continuam como
//   rede de seguranca.
// Parte do ambiente desconhecida (o native.ts antigo, getGPUInfo falhou) vale como curinga: o PC continua lembrando, e so
// uma parte conhecida dos dois lados e diferente conta como mudanca (um retry por engano custaria outro travamento).
//
// H.264 High (depois da v0.3.2; core/codec.ts): a sonda acima testa o perfil Baseline (42001f). O High (6400xx) passa
// pelo mesmo encoder da placa com outro perfil, entao tem a SUA sonda (runHighProbe) e o seu resultado salvo (chave
// privada hwH264HighProbe, com o perfil testado), tambem uma vez por ambiente. Ela so roda depois de a do Baseline dizer
// "ok" neste ambiente, nunca com o H.264 da placa travado ou desligado, e segura o H.264 da placa enquanto roda (como a do
// Baseline: nenhum encoder H.264 do WebRTC ao lado do dela). Travou (ou ficou presa) duas vezes = "travou". Sem o "ok"
// dela neste ambiente (nao rodou, inconclusiva, travou), nunca High. Travou: o High fica desligado neste ambiente e, com
// um encoder H.264 preso na placa, o automatico vai de VP9 so nesta sessao. Um envio em High que trava ou cai para
// software no ar marca o High (nunca o Baseline) como travado. O "travou" do High so some quando o ambiente muda (o botao
// "Tentar a placa de vídeo de novo" nao o esquece: High → trava → botao → High de novo seria um laco). Tudo que desliga o
// H.264 da placa (o travamento lembrado, a sonda do Baseline, as quedas no ar) desliga o High junto.
//
// H.265 (depois da v0.3.3; core/codec.ts): o mesmo desenho do High, com a SUA sonda (runH265Probe: um VideoEncoder
// WebCodecs "hvc1.1.6.L<nivel>.B0" Main, h265ProbeCodec) e o seu resultado salvo (chave privada hwH265Probe, com o codec
// testado), uma vez por ambiente, e SO com o H.265 fixado no formato de video (o automatico nunca usa H.265; fixado depois
// do inicio, ela roda na hora: onCodecSettingChanged). Ela so roda depois de a do Baseline dizer "ok" neste ambiente (e depois da do High),
// nunca com o H.264 da placa travado ou desligado (a placa AMD que trava com H.264 nunca cria um encoder H.265), nunca com
// uma transmissao comecando ou no ar, e segura o H.264 da placa enquanto roda (hold "h265": o automatico vai em VP9 nesse
// meio tempo, e nenhum encoder H.264/H.265 do WebRTC sobe ao lado do dela). Travou (ou ficou presa) duas vezes = "travou":
// o H.265 fica desligado neste ambiente e, com um encoder preso na placa, VP9 nesta sessao. Um envio em H.265 que trava ou
// sai da placa no ar marca o H.265 (nunca o H.264) como travado neste ambiente, sem o registro permanente "H.264 da placa
// travado"; o botao "Tentar a placa de vídeo de novo" nao esquece esse "travou" (o mesmo laco do High).
//
// AV1 (depois da v0.3.3): o mesmo desenho do H.265, com a SUA sonda (um VideoEncoder WebCodecs "av01.0.<nivel>M.08" Main
// 8 bits em "prefer-hardware", av1ProbeCodec; o libaom por software nao passa nela) e o seu resultado salvo (chave privada
// hwAv1Probe), SO com o AV1 fixado, depois da do H.265 (settleUpgrades), e so com o WebRtcAV1HWEncode ligado nesta partida
// do Discord (sem ele o encodingInfo ja diz que nao ha AV1 na placa). As mesmas travas: nunca com o H.264 da placa
// travado ou desligado (a placa que trava nunca cria um encoder AV1), nunca com uma transmissao comecando ou no ar, e
// segura o H.264 da placa enquanto roda (hold "av1"). Um envio em AV1 que trava, ou que sai da placa (o libaom assumiu),
// marca so o AV1 como travado neste ambiente.
//
// O H.265 e o AV1 compartilham o codigo (HW_ONLY, settleHwOnly, runHwOnlyProbe, noteHwOnlyFailed); as funcoes com o nome
// de cada um (settleH265, runAv1Probe...) sao so atalhos.

import { type CodecSetting, settings } from "@plugins/telinha/settings";

import {
    describeLocalCaps, getLocalCaps, hwOnlyWanted, isH264HwStuck, type LocalCodecCaps, probeLocalCaps, setAv1ProbeOk, setH264HighProbeOk, setH264HwProbing, setH264HwStuck,
    setH265ProbeOk
} from "./codec";
import { rt } from "./context";
import { type ProbeResult, type ProbeVerdict, runEncoderProbe } from "./encoderProbe";
import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";
import { containedCount } from "./peerConnection";
import type { HwOnlyCodec } from "./sdp";

/** O ambiente do encoder. Cada parte null = desconhecida (curinga na comparacao). */
export interface EncoderEnv {
    /** PCI vendor id da placa de video ativa, 4 digitos hex minusculos (ex.: "1002" AMD, "10de" NVIDIA) */
    vendorId: string | null;
    /** PCI device id, 4 digitos hex minusculos */
    deviceId: string | null;
    /** versao do driver da placa de video */
    driver: string | null;
    /** versao do Chromium (ex.: "152.0.7444.59") */
    chrome: string | null;
    /** versao do Discord (ex.: "1.0.9266") */
    discord: string | null;
}

/** O que fica salvo neste PC quando a placa trava (configuracoes do plugin, chave privada stuckHwH264). */
export interface StuckRecord {
    /** Date.now() do travamento */
    at: number;
    env: EncoderEnv;
    /** quem viu: uma transmissao (checkStall) ou a sonda WebCodecs; ausente = transmissao */
    source?: "stream" | "probe";
}

/**
 * Resultado da sonda WebCodecs salvo neste PC (chave privada hwH264Probe): com "ok" ou "travou" ela nao roda de novo
 * neste ambiente. "Inconclusiva" nunca e salva (roda de novo a cada abertura).
 */
export interface ProbeRecord {
    at: number;
    env: EncoderEnv;
    verdict: ProbeVerdict;
    detail: string;
}

/** O resultado da sonda WebCodecs do High (chave privada hwH264HighProbe): o mesmo, com o perfil testado. */
export interface HighProbeRecord extends ProbeRecord {
    /** profile-level-id testado (ex.: "640032"); null = desconhecido */
    profile: string | null;
    /** quem viu: a sonda, ou um envio em High no ar ("stream": travou ou caiu para software); ausente = a sonda */
    source?: "probe" | "stream";
}

/** O resultado da sonda WebCodecs do H.265 ou do AV1 (chaves privadas hwH265Probe, hwAv1Probe): o mesmo, com o codec WebCodecs testado. */
export interface HwOnlyProbeRecord extends ProbeRecord {
    /** codec testado (ex.: "hvc1.1.6.L123.B0", "av01.0.05M.08"); null = desconhecido */
    codec: string | null;
    /** quem viu: a sonda, ou um envio no ar ("stream": travou ou saiu da placa); ausente = a sonda */
    source?: "probe" | "stream";
}

export type H265ProbeRecord = HwOnlyProbeRecord;

/**
 * Quando a sonda WebCodecs roda: `delayMs` depois da sonda de codecs (fora da partida do Discord) e, se travar, a 2a
 * rodada de confirmacao `confirmMs` depois. Mutavel pelos testes.
 */
export const PROBE_START = { delayMs: 3000, confirmMs: 30_000 };

/** Aviso para quem transmite (barra do Telinha), com o codec no automatico. */
export const STUCK_NOTICE = "A placa de vídeo travou com H.264. Para não travar o Discord, o Telinha não mexe mais nesta transmissão. "
    + "Reinicie o Discord (feche por completo e abra de novo) para transmitir de novo: da próxima vez vai em VP9 sozinho.";
/** O aviso quando o envio que travou era em High: na proxima vez vai o H.264 de sempre, sem o High. */
export const STUCK_NOTICE_HIGH = "A placa de vídeo travou com H.264 High. Para não travar o Discord, o Telinha não mexe mais nesta transmissão. "
    + "Reinicie o Discord (feche por completo e abra de novo) para transmitir de novo: da próxima vez vai sem o High.";
/** O aviso quando o envio que travou era em H.265: na proxima vez vai o H.264 de sempre, sem o H.265. */
export const STUCK_NOTICE_H265 = "A placa de vídeo travou com H.265. Para não travar o Discord, o Telinha não mexe mais nesta transmissão. "
    + "Reinicie o Discord (feche por completo e abra de novo) para transmitir de novo: da próxima vez vai sem o H.265.";
/** O aviso quando o envio que travou era em AV1: na proxima vez vai o H.264 de sempre, sem o AV1. */
export const STUCK_NOTICE_AV1 = "A placa de vídeo travou com AV1. Para não travar o Discord, o Telinha não mexe mais nesta transmissão. "
    + "Reinicie o Discord (feche por completo e abra de novo) para transmitir de novo: da próxima vez vai sem o AV1.";
/** O mesmo aviso com o codec fixado em H.264 nas configuracoes (ai o automatico nao vale). */
export const STUCK_NOTICE_PINNED = "A placa de vídeo travou com H.264. Para não travar o Discord, o Telinha não mexe mais nesta transmissão. "
    + "Reinicie o Discord (feche por completo e abra de novo) para transmitir de novo. O formato de vídeo está fixado em H.264 nas configurações: escolha Automático para ir em VP9.";

/** Espera pela placa de video no main (o native.ts tambem limita em 3 s) e pelo WebGPU. */
const ENV_TIMEOUT_MS = 4000;

/** Fabricantes que o WebGPU (GPUAdapterInfo.vendor) da pelo nome. */
const VENDOR_IDS: Record<string, string> = { amd: "1002", nvidia: "10de", intel: "8086", qualcomm: "5143", apple: "106b", microsoft: "1414" };

type PrivateStore = { stuckHwH264?: unknown; hwH264Probe?: unknown; hwH264HighProbe?: unknown; hwH265Probe?: unknown; hwAv1Probe?: unknown; };

/** As configuracoes do plugin com a chave privada (lido so na hora: settings.ts importa o nucleo). */
function privateSettings() {
    return settings.withPrivateSettings<PrivateStore>();
}

let envPromise: Promise<EncoderEnv> | null = null;
/** o ambiente lido nesta sessao (null = ainda lendo); para o diagnostico */
let envNow: EncoderEnv | null = null;
/** de onde veio a placa de video: "main" (app.getGPUInfo), "webgpu", ou o motivo de ter ficado desconhecida */
let envSource = "";
/** a placa travou NESTA sessao do Discord (ha conexao contida: o botao so vale depois de reiniciar) */
let stuckThisSession = false;
let started: Promise<void> | null = null;
/** uma transmissao esta comecando (streaming.ts → noteStreamStarting): a sonda WebCodecs nao comeca no meio */
let streamStarting = false;
/** a sonda WebCodecs nesta sessao: o que ela disse, ou por que nao rodou (log e diagnostico) */
let probeNote = "ainda não";
/** a sonda WebCodecs do High nesta sessao: o que ela disse, ou por que nao rodou (log e diagnostico) */
let highNote = "ainda não";
/** as sondas WebCodecs do H.265 e do AV1 nesta sessao: o que disseram, ou por que nao rodaram (log e diagnostico) */
const hwOnlyNotes: Record<HwOnlyCodec, string> = { h265: "ainda não", av1: "ainda não" };
/** quem segura o H.264 da placa agora (setH264HwProbing): a sonda do Baseline (e o inicio), a do High, a do H.265 e a do AV1 */
const holds = { baseline: false, high: false, h265: false, av1: false };

/** Segura (ou solta) o H.264 da placa para `who`; ele so volta quando ninguem mais segura. */
function hold(who: keyof typeof holds, on: boolean) {
    holds[who] = on;
    setH264HwProbing(holds.baseline || holds.high || holds.h265 || holds.av1);
}

/** O que muda entre o H.265 e o AV1 nas sondas deles (o resto e o mesmo codigo). */
interface HwOnlySpec {
    label: string;
    key: "hwH265Probe" | "hwAv1Probe";
    /** um codec WebCodecs valido deste (o salvo pode ter sido editado a mao) */
    codecRe: RegExp;
    /** o fmtp do sender que este PC codifica na placa (encodingInfo); null = nenhum */
    fmtp(caps: LocalCodecCaps): string | null | undefined;
    probeCodec(fmtp: string | null | undefined): string;
    setOk(ok: boolean): void;
}

/** A ordem das sondas depois da do High: o H.265 e depois o AV1, uma de cada vez. */
const HW_ONLY_CODECS: readonly HwOnlyCodec[] = ["h265", "av1"];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const hex4 = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 0xFFFF ? n.toString(16).padStart(4, "0") : null);
const text = (s: unknown, max = 64) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null);

/** Chromium e Discord pelo userAgent do renderer (o main nao respondeu). */
function fromUserAgent(): Pick<EncoderEnv, "chrome" | "discord"> {
    const ua = String(navigator.userAgent);
    return { chrome: /\bChrome\/([\d.]+)/.exec(ua)?.[1] ?? null, discord: /\bdiscord\/([\d.]+)/i.exec(ua)?.[1] ?? null };
}

/** Plano B para a placa de video: o adaptador do WebGPU (so fabricante e, as vezes, o device id; nunca o driver). */
async function fromWebGpu(): Promise<Pick<EncoderEnv, "vendorId" | "deviceId"> | null> {
    const gpu = (globalThis.navigator as any)?.gpu;
    if (typeof gpu?.requestAdapter !== "function") return null;
    const adapter: any = await withTimeout(Promise.resolve(gpu.requestAdapter()), ENV_TIMEOUT_MS);
    const info = adapter?.info;
    const vendor = text(info?.vendor, 32)?.toLowerCase() ?? null;
    if (!vendor) return null;
    const device = /^(?:0x)?([0-9a-f]{1,4})$/i.exec(text(info?.device, 16) ?? "")?.[1];
    return { vendorId: VENDOR_IDS[vendor] ?? vendor, deviceId: device ? device.toLowerCase().padStart(4, "0") : null };
}

/** Le o ambiente agora (sem memorizar; environment() le uma vez por sessao). Nunca rejeita. */
export async function measureEnvironment(): Promise<EncoderEnv> {
    const env: EncoderEnv = { vendorId: null, deviceId: null, driver: null, chrome: null, discord: null };
    const why: string[] = [];
    try {
        const native = getNativeOrNull();
        if (typeof native?.gpuEnvironment === "function") {
            const res: any = await withTimeout(native.gpuEnvironment(), ENV_TIMEOUT_MS);
            if (!res) why.push("o processo main não respondeu");
            env.vendorId = hex4(res?.vendorId);
            env.deviceId = hex4(res?.deviceId);
            env.driver = text(res?.driverVersion);
            env.chrome = text(res?.chrome);
            env.discord = text(res?.discord);
            if (typeof res?.error === "string") why.push(res.error.slice(0, 200));
        } else {
            why.push("parte nativa sem gpuEnvironment (Discord ainda não reiniciado depois da atualização)");
        }
    } catch (e) {
        why.push(errorText(e));
    }
    if (env.vendorId) envSource = "main";
    else {
        try {
            const web = await fromWebGpu();
            if (web) {
                env.vendorId = web.vendorId;
                env.deviceId = web.deviceId;
                envSource = "webgpu";
            } else why.push("sem WebGPU");
        } catch (e) {
            why.push("WebGPU: " + errorText(e));
        }
    }
    if (!env.vendorId) envSource = why.join("; ");
    const ua = fromUserAgent();
    env.chrome ??= ua.chrome;
    env.discord ??= ua.discord;
    envNow = env;
    return env;
}

/** O ambiente desta sessao do Discord (lido uma vez). Nunca rejeita. */
export function environment(): Promise<EncoderEnv> {
    return envPromise ??= measureEnvironment();
}

const ENV_PARTS: readonly [keyof EncoderEnv, string][] = [
    ["vendorId", "fabricante da placa de vídeo"],
    ["deviceId", "placa de vídeo"],
    ["driver", "driver da placa de vídeo"],
    ["chrome", "Chromium"],
    ["discord", "Discord"]
];

/**
 * As partes que, mudando, fazem a placa ser testada de novo. A versao do Discord fica de fora (muda toda semana sem mexer
 * no encoder; so aparece na descricao), e o Chromium conta so pela versao principal (152.0.x → 152.0.y nao muda nada).
 */
const CHANGE_PARTS = ENV_PARTS.filter(([key]) => key !== "discord");

const major = (version: string) => version.split(".")[0];

/** O que mudou entre o ambiente salvo e o atual: so partes conhecidas dos dois lados e diferentes. Vazio = o mesmo. */
export function envChanges(saved: EncoderEnv, now: EncoderEnv): string[] {
    return CHANGE_PARTS
        .filter(([key]) => {
            const a = saved[key];
            const b = now[key];
            if (a == null || b == null) return false;
            return key === "chrome" ? major(a) !== major(b) : a !== b;
        })
        .map(([key, name]) => `${name} ${saved[key]} → ${now[key]}`);
}

/** "1002:73df, driver 31.0.24033.1003; Chromium 152...; Discord 1.0.9266" (partes desconhecidas com "?"). */
export function describeEnv(env: EncoderEnv): string {
    return `placa de vídeo ${env.vendorId ?? "?"}:${env.deviceId ?? "?"}, driver ${env.driver ?? "?"}; Chromium ${env.chrome ?? "?"}; Discord ${env.discord ?? "?"}`;
}

/** Uma chave privada salva, com `at` valido e o ambiente so com os campos conhecidos. null = nada (ou estragado). */
function readSaved(key: keyof PrivateStore): { raw: Record<string, unknown>; at: number; env: EncoderEnv; } | null {
    let raw: unknown;
    try {
        raw = privateSettings().store[key];
    } catch {
        // configuracoes indisponiveis: a pagina do plugin e o diagnostico continuam (sem o registro)
        return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
    const e = r.env && typeof r.env === "object" ? r.env as Record<string, unknown> : {};
    return { raw: r, at: r.at, env: Object.fromEntries(ENV_PARTS.map(([part]) => [part, text(e[part])])) as unknown as EncoderEnv };
}

function save(key: keyof PrivateStore, value: unknown, what: string) {
    try {
        privateSettings().store[key] = value;
    } catch (e) {
        log.warn(`Não deu para salvar nas configurações ${what}: ${errorText(e)}`);
    }
}

/** O travamento salvo neste PC, validado (as configuracoes podem ter sido editadas a mao). null = nenhum. */
export function stuckRecord(): StuckRecord | null {
    const saved = readSaved("stuckHwH264");
    if (!saved) return null;
    return { at: saved.at, env: saved.env, ...(saved.raw.source === "probe" ? { source: "probe" as const } : {}) };
}

function writeRecord(record: StuckRecord | null) {
    save("stuckHwH264", record ? { at: record.at, env: { ...record.env }, source: record.source ?? "stream" } : null, "que a placa de vídeo travou");
}

const VERDICTS: readonly ProbeVerdict[] = ["ok", "broken", "unknown"];

function readProbe(key: "hwH264Probe" | "hwH264HighProbe" | "hwH265Probe" | "hwAv1Probe") {
    const saved = readSaved(key);
    const verdict = VERDICTS.find(v => v === saved?.raw.verdict);
    if (!saved || !verdict) return null;
    return { saved, record: { at: saved.at, env: saved.env, verdict, detail: text(saved.raw.detail, 200) ?? "" } };
}

/** O resultado da sonda WebCodecs salvo neste PC (de qualquer ambiente). null = nenhum. */
export function probeRecord(): ProbeRecord | null {
    return readProbe("hwH264Probe")?.record ?? null;
}

/** O resultado da sonda WebCodecs do High salvo neste PC (de qualquer ambiente). null = nenhum. */
export function highProbeRecord(): HighProbeRecord | null {
    const read = readProbe("hwH264HighProbe");
    if (!read) return null;
    const profile = text(read.saved.raw.profile, 6)?.toLowerCase() ?? null;
    return {
        ...read.record, profile: profile && /^[0-9a-f]{6}$/.test(profile) ? profile : null,
        ...(read.saved.raw.source === "stream" ? { source: "stream" as const } : {})
    };
}

function saveHigh(record: HighProbeRecord) {
    save("hwH264HighProbe", { at: record.at, env: { ...record.env }, verdict: record.verdict, detail: record.detail, profile: record.profile, source: record.source ?? "probe" },
        "o resultado da sonda do H.264 High");
}

/** O resultado da sonda WebCodecs do H.265 ou do AV1 salvo neste PC (de qualquer ambiente). null = nenhum. */
export function hwOnlyProbeRecord(codec: HwOnlyCodec): HwOnlyProbeRecord | null {
    const spec = HW_ONLY[codec];
    const read = readProbe(spec.key);
    if (!read) return null;
    const tested = text(read.saved.raw.codec, 32);
    return {
        ...read.record, codec: tested && spec.codecRe.test(tested) ? tested : null,
        ...(read.saved.raw.source === "stream" ? { source: "stream" as const } : {})
    };
}

/** O resultado da sonda WebCodecs do H.265 salvo neste PC (de qualquer ambiente). null = nenhum. */
export function h265ProbeRecord(): HwOnlyProbeRecord | null {
    return hwOnlyProbeRecord("h265");
}

/** O resultado da sonda WebCodecs do AV1 salvo neste PC (de qualquer ambiente). null = nenhum. */
export function av1ProbeRecord(): HwOnlyProbeRecord | null {
    return hwOnlyProbeRecord("av1");
}

function saveHwOnly(codec: HwOnlyCodec, record: HwOnlyProbeRecord) {
    const spec = HW_ONLY[codec];
    save(spec.key, { at: record.at, env: { ...record.env }, verdict: record.verdict, detail: record.detail, codec: record.codec, source: record.source ?? "probe" },
        `o resultado da sonda do ${spec.label}`);
}

/**
 * O codec WebCodecs da sonda do H.265 para o fmtp que o Chromium oferece (Main, nivel do level-id; ex.:
 * "level-id=123;profile-id=1;..." → "hvc1.1.6.L123.B0"). Sem level-id, o nivel 4.0 (L120). Medido no Chrome 156 (RTX
 * 3070): isConfigSupported aceita L93/L120/L123 em prefer-hardware, e 30 quadros 1280x720 saem em ~1 s (1o pacote em ~170 ms).
 */
export function h265ProbeCodec(fmtp: string | null | undefined): string {
    const level = /level-id=(\d{1,3})/.exec(fmtp ?? "")?.[1];
    return `hvc1.1.6.L${level ?? "120"}.B0`;
}

/**
 * O codec WebCodecs da sonda do AV1 para o fmtp que o Chromium oferece (Main 8 bits, tier Main, nivel do level-idx; ex.:
 * "level-idx=5;profile=0;tier=0" → "av01.0.05M.08", o nivel 3.1, que cobre os 1280x720@30 da sonda). Sem level-idx, o
 * nivel 4.0 (08). Medido no Edge 156 (RTX 3070, sem AV1 na placa): isConfigSupported diz false para av01.0.05M.08 e
 * av01.0.08M.08 em prefer-hardware (true em no-preference, o libaom), entao a sonda so passa com o encoder da placa.
 */
export function av1ProbeCodec(fmtp: string | null | undefined): string {
    const level = Number(/level-idx=(\d{1,2})/.exec(fmtp ?? "")?.[1] ?? 8);
    return `av01.0.${pad2(level)}M.08`;
}

const HW_ONLY: Record<HwOnlyCodec, HwOnlySpec> = {
    h265: { label: "H.265", key: "hwH265Probe", codecRe: /^(hvc1|hev1)\.[0-9a-z.]+$/i, fmtp: caps => caps.h265HwFmtp, probeCodec: h265ProbeCodec, setOk: setH265ProbeOk },
    av1: { label: "AV1", key: "hwAv1Probe", codecRe: /^av01\.[0-9a-z.]+$/i, fmtp: caps => caps.av1HwFmtp, probeCodec: av1ProbeCodec, setOk: setAv1ProbeOk }
};

/** Um resultado salvo que vale neste ambiente (ok ou travou; "inconclusiva" nunca e salva, mas pode ter sido editada a mao). */
function doneIn<R extends ProbeRecord>(saved: R | null, env: EncoderEnv): R | null {
    return saved && saved.verdict !== "unknown" && !envChanges(saved.env, env).length ? saved : null;
}

const PROBE_LABEL: Record<ProbeVerdict, string> = { ok: "ok", broken: "travou", unknown: "inconclusiva" };

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "31/10" (hora local). */
export function shortDate(at: number): string {
    const d = new Date(at);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
}

/** Linha da pagina do plugin para um travamento lembrado. */
export function stuckLine(record: StuckRecord): string {
    return `A placa de vídeo travou com H.264 neste PC em ${shortDate(record.at)}; usando VP9.`;
}

/**
 * O travamento salvo e de outro ambiente (driver, Chromium ou placa mudou): so a sonda DESTE ambiente dizendo "ok" o
 * esquece. Inconclusiva (ou sem sonda) mantem o VP9: um retry as cegas custaria outro travamento.
 */
function settleChangedEnv(record: StuckRecord, env: EncoderEnv, verdict: ProbeVerdict) {
    const changes = envChanges(record.env, env).join("; ");
    if (verdict === "ok") {
        writeRecord(null);
        setH264HwStuck(stuckThisSession);
        log.info(`A placa de vídeo tinha travado com H.264 neste PC em ${shortDate(record.at)}, mas o ambiente mudou (${changes}) e a sonda deste `
            + "ambiente passou: o automático volta a tentar o H.264 da placa de vídeo");
        return;
    }
    setH264HwStuck(true);
    log.info(`A placa de vídeo tinha travado com H.264 neste PC em ${shortDate(record.at)}; o ambiente mudou (${changes}), mas a sonda deste `
        + `ambiente não confirmou que ela funciona (${PROBE_LABEL[verdict]}): continua em VP9`);
}

/**
 * A sonda do H.265/AV1 vale agora: o formato de video fixado nele, ou ele no automatico (codec.ts → hwOnlyWanted; hoje
 * os dois sao so manuais). Configuracoes indisponiveis = nao (o diagnostico continua).
 */
function wanted(codec: HwOnlyCodec): boolean {
    try {
        return hwOnlyWanted(codec, settings.store.codec as CodecSetting);
    } catch {
        return false;
    }
}

const canProbe = () => typeof (globalThis as { Worker?: unknown; }).Worker === "function";
const streamBusy = () => streamStarting || !!rt.local;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Inicio da sessao (session.ts). A sonda de codecs (codec.ts → probeLocalCaps) e a leitura do ambiente correm juntas;
 * so o H.264 automatico espera (setH264HwProbing) ate o travamento lembrado ser aplicado, para nenhum envio H.264 da placa
 * comecar antes. Travamento lembrado no mesmo ambiente: H.264 automatico desligado. Ambiente mudou: continua desligado ate
 * a sonda deste ambiente dizer "ok" (settleChangedEnv). Resolve depois das duas (a presenca sai). Se a sonda WebCodecs
 * ainda nao rodou neste ambiente (e a placa codifica H.264), ela roda em segundo plano depois de PROBE_START.delayMs
 * (runStartupProbe). Depois do Baseline, o High (settleHigh: o resultado salvo deste ambiente, ou a sonda dele). `report`
 * recebe UMA linha das capacidades, com a placa de video, o travamento e as sondas (quando uma sonda roda, so no fim
 * dela). Uma vez por sessao do Discord. Nunca rejeita.
 */
export function startLocalCaps(report: (line: string) => void): Promise<void> {
    return started ??= (async () => {
        hold("baseline", true);
        const measuring = probeLocalCaps();
        const env = await environment();
        const record = stuckRecord();
        const sameEnv = !!record && !envChanges(record.env, env).length;
        // "inconclusiva" nunca e salva, entao `done` e ok ou travou
        const done = doneIn(probeRecord(), env);
        // a sonda deste ambiente travou mas o registro do travamento sumiu (a gravacao falhou): vale como o registro
        if (record || done?.verdict === "broken") setH264HwStuck(true);
        const caps = await measuring;
        const line = () => {
            const rec = stuckRecord();
            report(`${describeLocalCaps(caps)}; ${describeEnv(env)}; sonda WebCodecs H.264 placa: ${probeNote}`
                + (caps.h264HighHwProfile ? `; sonda WebCodecs H.264 High: ${highNote}` : "")
                + (caps.h265HwFmtp ? `; sonda WebCodecs H.265: ${hwOnlyNotes.h265}` : "")
                + (caps.av1HwFmtp || wanted("av1") ? `; sonda WebCodecs AV1: ${hwOnlyNotes.av1}` : "")
                + (rec && isH264HwStuck() ? `; H.264 automático desligado: a placa de vídeo travou com H.264 neste PC em ${shortDate(rec.at)} (usando VP9)` : ""));
        };
        if (!sameEnv && !done && canProbe() && caps.h264HwEncode && caps.h264HwProfile) {
            // o High e o H.265 logo depois do Baseline (sem esperar de novo), so se ele passar
            void runStartupProbe(env, caps.h264HwProfile).then(() => settleUpgrades(env, 0)).then(line);
            return;
        }
        if (record && !sameEnv) settleChangedEnv(record, env, done?.verdict ?? "unknown");
        hold("baseline", false);
        probeNote = sameEnv ? "não feita (a placa já travou neste PC)"
            : done ? `${PROBE_LABEL[done.verdict]} (feita em ${shortDate(done.at)} neste ambiente: ${done.detail})`
                : !caps.h264HwEncode ? "não feita (este PC não codifica H.264 na placa)"
                    : "não feita (sem Worker)";
        // o Baseline ja vale; o High e o H.265 so depois das sondas deles (fora da partida do Discord, como a do Baseline)
        const high = settleUpgrades(env, PROBE_START.delayMs);
        if (high) void high.then(line);
        else line();
    })();
}

/** A sonda do Baseline passou neste ambiente (salva). */
function baselineOkIn(env: EncoderEnv) {
    return doneIn(probeRecord(), env)?.verdict === "ok";
}

/**
 * O High depois que o Baseline se resolveu (inicio da sessao, ou o botao): o resultado salvo deste ambiente E deste perfil
 * (o profile-level-id que o Chromium oferece agora) vale; sem ele, a sonda do High roda (runHighProbe, depois de
 * `delayMs`) se este PC codifica High por hardware (encodingInfo), o H.264 da placa nao esta desligado e a sonda do
 * Baseline deu "ok" neste ambiente. Senao, sem High nesta sessao. Devolve a promessa da sonda quando ela roda (null = nao roda).
 */
export function settleHigh(env: EncoderEnv, delayMs: number): Promise<void> | null {
    const profile = getLocalCaps().h264HighHwProfile;
    const saved = doneIn(highProbeRecord(), env);
    const done = saved?.profile === profile ? saved : null;
    const skip = (why: string) => {
        setH264HighProbeOk(false);
        highNote = `não feita (${why})`;
        return null;
    };
    if (!profile) return skip("este PC não codifica High na placa");
    if (done) {
        setH264HighProbeOk(done.verdict === "ok");
        highNote = `${PROBE_LABEL[done.verdict]} (feita em ${shortDate(done.at)} neste ambiente: ${done.detail})`;
        return null;
    }
    if (isH264HwStuck()) return skip("o H.264 da placa está desligado neste PC");
    if (!baselineOkIn(env)) return skip("a sonda do H.264 Baseline não deu ok neste ambiente; sem High nesta sessão");
    if (!canProbe()) return skip("sem Worker");
    return runHighProbe(env, profile, delayMs);
}

/**
 * O High, depois o H.265 e depois o AV1 (settleHigh, settleHwOnly), um depois do outro: nenhuma sonda roda ao lado de
 * outra, e so a primeira que roda espera `delayMs`. Devolve a promessa quando alguma sonda roda (null = nenhuma).
 */
export function settleUpgrades(env: EncoderEnv, delayMs: number): Promise<void> | null {
    let chain = settleHigh(env, delayMs);
    for (const codec of HW_ONLY_CODECS) chain = chain ? chain.then(() => settleHwOnly(codec, env, 0) ?? undefined) : settleHwOnly(codec, env, delayMs);
    return chain;
}

/**
 * O H.265 (ou o AV1) depois que o Baseline e o High se resolveram: o resultado salvo deste ambiente E deste codec vale;
 * sem ele, a sonda roda (runHwOnlyProbe, depois de `delayMs`) se ele esta fixado, este PC o codifica por hardware
 * (encodingInfo), o H.264 da placa nao esta desligado e a sonda do Baseline deu "ok" neste ambiente. AV1: tambem so com
 * o WebRtcAV1HWEncode ligado nesta partida do Discord. Senao, sem ele nesta sessao.
 */
export function settleHwOnly(codec: HwOnlyCodec, env: EncoderEnv, delayMs: number): Promise<void> | null {
    const spec = HW_ONLY[codec];
    const caps = getLocalCaps();
    const fmtp = spec.fmtp(caps);
    const tested = fmtp ? spec.probeCodec(fmtp) : null;
    const saved = doneIn(hwOnlyProbeRecord(codec), env);
    const done = saved && saved.codec === tested ? saved : null;
    const skip = (why: string) => {
        spec.setOk(false);
        hwOnlyNotes[codec] = `não feita (${why})`;
        return null;
    };
    // sem o recurso, o WebRTC so teria o AV1 por software (e o encodingInfo ja diz que nao ha AV1 na placa)
    if (codec === "av1" && caps.av1HwFeature === false) return skip("o WebRtcAV1HWEncode não está ligado nesta partida do Discord; liga quando o Discord abrir com o AV1 fixado");
    if (!tested) return skip(`este PC não codifica ${spec.label} na placa`);
    if (done) {
        spec.setOk(done.verdict === "ok");
        hwOnlyNotes[codec] = `${PROBE_LABEL[done.verdict]} (feita em ${shortDate(done.at)} neste ambiente: ${done.detail})${done.source === "stream" ? " [visto numa transmissão]" : ""}`;
        return null;
    }
    // so manual: sem ele fixado, a sonda nunca roda (a abertura do Discord custa o mesmo de antes)
    if (!wanted(codec)) return skip(`só roda com o ${spec.label} fixado no formato de vídeo`);
    if (isH264HwStuck()) return skip(`o H.264 da placa está desligado neste PC, e o ${spec.label} vai junto`);
    if (!baselineOkIn(env)) return skip(`a sonda do H.264 Baseline não deu ok neste ambiente; sem ${spec.label} nesta sessão`);
    if (!canProbe()) return skip("sem Worker");
    return runHwOnlyProbe(codec, env, tested, delayMs);
}

/** settleHwOnly do H.265. */
export function settleH265(env: EncoderEnv, delayMs: number): Promise<void> | null {
    return settleHwOnly("h265", env, delayMs);
}

/** settleHwOnly do AV1. */
export function settleAv1(env: EncoderEnv, delayMs: number): Promise<void> | null {
    return settleHwOnly("av1", env, delayMs);
}

/**
 * O formato de video mudou nas configuracoes (settings.ts → codec.onChange): fixado em H.265 ou AV1 depois do inicio da
 * sessao, a sonda dele roda agora (settleHwOnly, as mesmas regras: nunca com uma transmissao comecando ou no ar, nem ao
 * lado de outra sonda; com uma transmissao no ar, ela roda quando a transmissao acabar: onStreamStopped). Antes do inicio,
 * ou com outra sonda rodando, quem vem depois (startLocalCaps, o botao) ja olha o formato. Devolve a promessa da sonda
 * quando ela roda (null = nao roda). O AV1 sem o WebRtcAV1HWEncode nesta partida nao roda (so depois de reiniciar).
 */
export function onCodecSettingChanged(): Promise<void> | null {
    return settleHwOnlyNow();
}

/**
 * A transmissao acabou (streaming.ts → stopStreaming): com o H.265 ou o AV1 fixado e a sonda dele ainda sem resultado
 * (ela nao roda com uma transmissao no ar), ela roda agora, PROBE_START.delayMs depois e com as mesmas regras (uma
 * transmissao que comeca nesse meio tempo a adia de novo). Com resultado salvo, ou sem nenhum dos dois fixado, nada.
 */
export function onStreamStopped(): Promise<void> | null {
    return settleHwOnlyNow();
}

function settleHwOnlyNow(): Promise<void> | null {
    const codecs = HW_ONLY_CODECS.filter(wanted);
    if (!codecs.length || !started || !envNow || probeRunning || highProbeRunning || HW_ONLY_CODECS.some(c => hwOnlyRunning[c])) return null;
    const env = envNow;
    let chain: Promise<void> | null = null;
    for (const codec of codecs) chain = chain ? chain.then(() => settleHwOnly(codec, env, 0) ?? undefined) : settleHwOnly(codec, env, PROBE_START.delayMs);
    return chain;
}

/**
 * A 1a rodada travou e nao deu para confirmar (`why`): VP9 so nesta sessao, nada salvo, e a sonda roda de novo na proxima
 * abertura do Discord.
 */
function sessionOnly(note: string, why: string) {
    probeNote = `${note}: VP9 nesta sessão`;
    setH264HwStuck(true);
    log.warn(`A sonda WebCodecs travou com o H.264 da placa de vídeo, mas ${why}: o automático vai em VP9 nesta sessão, `
        + "e a sonda roda de novo na próxima vez que o Discord abrir");
}

/** Uma rodada da sonda, com a linha do log quando o Worker fica preso. `what` = "H.264" (o Baseline), "H.264 High", "H.265" ou "AV1". */
async function probeOnce(profile: string, what = "H.264"): Promise<ProbeResult> {
    const result = await runEncoderProbe(profile, what === "H.265" ? "h265" : what === "AV1" ? "av1" : "h264");
    if (result.hung) log.warn(`Sonda WebCodecs do ${what} da placa de vídeo: o encoder ficou preso (${result.detail}); o Worker dela fica como está até o Discord fechar`);
    return result;
}

/** a sonda WebCodecs esta rodando (inicio da sessao ou o botao): nao comeca outra */
let probeRunning = false;

/**
 * A sonda WebCodecs (core/encoderProbe.ts), uma vez por ambiente, fora da partida do Discord (espera `delayMs`). Uma
 * transmissao comecando ou no ar nessa hora: nao roda (fica para a proxima vez que o Discord abrir). Enquanto roda, o
 * H.264 automatico fica desligado (setH264HwProbing): uma transmissao que comeca no meio manda VP9 para quem pedir.
 * - Travou: confirma com uma 2a rodada PROBE_START.confirmMs depois (um encoder preso continua preso; uma placa so
 *   ocupada naquela hora nao). Travou de novo = o mesmo registro de um travamento numa transmissao (source "probe"),
 *   antes de soltar a trava, entao nenhum encoder H.264 do WebRTC e criado. Uma transmissao comecou no meio: VP9 so nesta
 *   sessao, nada salvo (a sonda roda de novo na proxima abertura).
 * - Ok ou inconclusiva: como antes; um travamento salvo de outro ambiente so e esquecido com "ok" (settleChangedEnv).
 */
export async function runStartupProbe(env: EncoderEnv, profile: string, delayMs = PROBE_START.delayMs) {
    probeRunning = true;
    hold("baseline", true);
    try {
        await sleep(delayMs);
        if (streamBusy()) {
            probeNote = "não feita (uma transmissão estava começando ou no ar; tenta de novo na próxima vez que o Discord abrir)";
            return;
        }
        probeNote = "rodando";
        const first = await probeOnce(profile);
        let result = first;
        if (first.verdict === "broken") {
            log.info(`Sonda WebCodecs do H.264 da placa de vídeo: travou (${first.detail}); confirmando em ${PROBE_START.confirmMs / 1000} s`);
            probeNote = "travou uma vez; confirmando";
            await sleep(PROBE_START.confirmMs);
            if (streamBusy()) {
                sessionOnly(`travou uma vez (${first.detail}), sem confirmar (uma transmissão começou)`, "uma transmissão começou antes da confirmação");
                return;
            }
            // juncao conservadora: so "ok" na 2a desfaz a 1a. O encoder preso da 1a pode travar o caminho do driver, entao
            // uma 2a presa (inconclusiva e "hung", ex.: sem resposta no isConfigSupported) confirma; inconclusiva sem nada
            // preso nao confirma nem libera: VP9 nesta sessao, nada salvo
            const second = await probeOnce(profile);
            if (second.verdict === "ok") result = { verdict: "ok", detail: `${second.detail} (a 1ª rodada tinha travado: ${first.detail})` };
            else if (second.verdict === "broken" || second.hung) result = { verdict: "broken", detail: `${second.detail}; confirmado na 2ª rodada` };
            else {
                sessionOnly(`travou uma vez (${first.detail}); a 2ª rodada não conseguiu dizer (${second.detail})`, "a 2ª rodada não conseguiu confirmar");
                return;
            }
        }
        probeNote = `${PROBE_LABEL[result.verdict]} (${result.detail})`;
        // "inconclusiva" nunca fica salva: a sonda roda de novo na proxima abertura (um travamento de outro ambiente
        // continua valendo ate ela dizer "ok")
        if (result.verdict !== "unknown") save("hwH264Probe", { at: Date.now(), env: { ...env }, verdict: result.verdict, detail: result.detail }, "o resultado da sonda do H.264");
        if (result.verdict === "broken") {
            // antes de soltar a trava (finally): nenhum envio H.264 da placa comeca no meio
            setH264HwStuck(true);
            writeRecord({ at: Date.now(), env, source: "probe" });
            log.warn(`A sonda WebCodecs mostrou que o H.264 da placa de vídeo trava neste PC (${result.detail}): `
                + "o automático vai em VP9, sem criar o encoder H.264 da placa, até o driver, o Chromium ou a placa mudarem");
            return;
        }
        const record = stuckRecord();
        if (record && envChanges(record.env, env).length) settleChangedEnv(record, env, result.verdict);
    } finally {
        probeRunning = false;
        hold("baseline", false);
    }
}

/** a sonda WebCodecs do High esta rodando: nao comeca outra */
let highProbeRunning = false;

/** A rodada travou: nenhum pacote no prazo, ou o Worker ficou preso (um passo ou o flush sem resposta). */
const isBad = (r: ProbeResult) => r.verdict === "broken" || !!r.hung;

/**
 * A sonda WebCodecs do High (avc1.6400xx, core/encoderProbe.ts), uma vez por ambiente, depois de a do Baseline dizer
 * "ok" (settleHigh). Uma transmissao comecando ou no ar nessa hora: nao roda (fica para a proxima vez que o Discord
 * abrir). Enquanto roda (com a confirmacao), segura o H.264 da placa (hold): uma transmissao que comeca no meio manda VP9,
 * e nenhum encoder H.264 do WebRTC sobe ao lado do dela.
 * - Travou ou ficou presa: confirma com uma 2a rodada PROBE_START.confirmMs depois, como a do Baseline (uma placa so
 *   ocupada com um jogo nao fica presa). Ok na 2a = ok. Travou ou presa de novo = "travou", salvo: o High desligado neste
 *   ambiente (so o Baseline; o botao nao esquece) e, com um encoder H.264 preso na placa, VP9 no resto desta sessao.
 *   Inconclusiva sem nada preso na 2a, ou uma transmissao comecando antes dela: nada salvo, VP9 nesta sessao.
 * - Ok: fica salvo; o automatico usa High com quem tambem decodifica High por hardware.
 * - Inconclusiva sem nada preso: nada salvo; sem High nesta sessao (o Baseline continua) e ela roda de novo na proxima abertura.
 */
export async function runHighProbe(env: EncoderEnv, profile: string, delayMs = PROBE_START.delayMs) {
    if (highProbeRunning) return;
    highProbeRunning = true;
    setH264HighProbeOk(false);
    try {
        await sleep(delayMs);
        if (streamBusy()) {
            highNote = "não feita (uma transmissão estava começando ou no ar; tenta de novo na próxima vez que o Discord abrir)";
            return;
        }
        if (isH264HwStuck()) {
            highNote = "não feita (o H.264 da placa está desligado neste PC)";
            return;
        }
        hold("high", true);
        highNote = "rodando";
        const first = await probeOnce(profile, "H.264 High");
        let result = first;
        if (isBad(first)) {
            log.info(`Sonda WebCodecs do H.264 High (perfil ${profile}) da placa de vídeo: travou (${first.detail}); confirmando em ${PROBE_START.confirmMs / 1000} s`);
            highNote = "travou uma vez; confirmando";
            await sleep(PROBE_START.confirmMs);
            const unconfirmed = (note: string, why: string) => {
                highNote = `${note}: VP9 nesta sessão`;
                setH264HwStuck(true);
                log.warn(`A sonda WebCodecs travou com o H.264 High da placa de vídeo, mas ${why}: o automático vai em VP9 nesta sessão, `
                    + "e a sonda do High roda de novo na próxima vez que o Discord abrir");
            };
            if (streamBusy()) {
                unconfirmed(`travou uma vez (${first.detail}), sem confirmar (uma transmissão começou)`, "uma transmissão começou antes da confirmação");
                return;
            }
            const second = await probeOnce(profile, "H.264 High");
            if (second.verdict === "ok") result = { verdict: "ok", detail: `${second.detail} (a 1ª rodada tinha travado: ${first.detail})` };
            else if (isBad(second)) result = { verdict: "broken", detail: `${second.detail}; confirmado na 2ª rodada` };
            else {
                unconfirmed(`travou uma vez (${first.detail}); a 2ª rodada não conseguiu dizer (${second.detail})`, "a 2ª rodada não conseguiu confirmar");
                return;
            }
        }
        highNote = `${PROBE_LABEL[result.verdict]} (${result.detail})`;
        if (result.verdict !== "unknown") saveHigh({ at: Date.now(), env, verdict: result.verdict, detail: result.detail, profile });
        if (result.verdict === "ok") {
            setH264HighProbeOk(true);
            log.info(`Sonda WebCodecs do H.264 High (perfil ${profile}) da placa de vídeo: ok (${result.detail}); `
                + "o automático manda High para quem também decodifica High por hardware");
        } else if (result.verdict === "broken") {
            // antes de soltar a trava (finally): nenhum envio H.264 da placa comeca no meio
            setH264HwStuck(true);
            log.warn(`A sonda WebCodecs do H.264 High (perfil ${profile}) travou neste PC (${result.detail}): o High fica desligado neste ambiente `
                + "(só o Baseline) e, com um encoder H.264 preso na placa de vídeo, o automático vai em VP9 nesta sessão");
        } else {
            log.info(`Sonda WebCodecs do H.264 High (perfil ${profile}) da placa de vídeo: inconclusiva (${result.detail}); `
                + "sem High nesta sessão (o Baseline continua), e ela roda de novo na próxima vez que o Discord abrir");
        }
    } finally {
        highProbeRunning = false;
        hold("high", false);
    }
}

/** as sondas WebCodecs do H.265 e do AV1 rodando: nao comeca outra do mesmo */
const hwOnlyRunning: Record<HwOnlyCodec, boolean> = { h265: false, av1: false };

/**
 * A sonda WebCodecs do H.265 ou do AV1 (`tested`, ex.: hvc1.1.6.L123.B0, av01.0.05M.08; core/encoderProbe.ts), uma vez
 * por ambiente, depois das do Baseline e do High (settleUpgrades). As mesmas regras da do High: nao roda com uma
 * transmissao comecando ou no ar, nem com o H.264 da placa desligado; enquanto roda (com a confirmacao), segura o H.264
 * da placa (hold "h265"/"av1"), entao nenhum encoder do WebRTC na placa sobe ao lado do dela.
 * - Travou ou ficou presa: confirma com uma 2a rodada PROBE_START.confirmMs depois. Ok na 2a = ok. Travou ou presa de novo
 *   = "travou", salvo: ele desligado neste ambiente (o botao nao esquece) e, com um encoder preso na placa, VP9 no resto
 *   desta sessao. Inconclusiva sem nada preso na 2a, ou uma transmissao comecando antes dela: nada salvo, VP9 nesta sessao.
 * - Ok: fica salvo; com ele fixado, vai ele para quem tambem o decodifica por hardware.
 * - Inconclusiva sem nada preso: nada salvo; sem ele nesta sessao (o H.264 continua) e ela roda de novo na proxima abertura.
 */
export async function runHwOnlyProbe(codec: HwOnlyCodec, env: EncoderEnv, tested: string, delayMs = PROBE_START.delayMs) {
    if (hwOnlyRunning[codec]) return;
    const { label, setOk } = HW_ONLY[codec];
    const note = (text: string) => { hwOnlyNotes[codec] = text; };
    hwOnlyRunning[codec] = true;
    setOk(false);
    try {
        await sleep(delayMs);
        if (streamBusy()) {
            note("não feita (uma transmissão estava começando ou no ar; tenta de novo na próxima vez que o Discord abrir)");
            return;
        }
        if (isH264HwStuck()) {
            note(`não feita (o H.264 da placa está desligado neste PC, e o ${label} vai junto)`);
            return;
        }
        hold(codec, true);
        note("rodando");
        const first = await probeOnce(tested, label);
        let result = first;
        if (isBad(first)) {
            log.info(`Sonda WebCodecs do ${label} (${tested}) da placa de vídeo: travou (${first.detail}); confirmando em ${PROBE_START.confirmMs / 1000} s`);
            note("travou uma vez; confirmando");
            await sleep(PROBE_START.confirmMs);
            const unconfirmed = (text: string, why: string) => {
                note(`${text}: VP9 nesta sessão`);
                setH264HwStuck(true);
                log.warn(`A sonda WebCodecs travou com o ${label} da placa de vídeo, mas ${why}: o automático vai em VP9 nesta sessão, `
                    + `e a sonda do ${label} roda de novo na próxima vez que o Discord abrir`);
            };
            if (streamBusy()) {
                unconfirmed(`travou uma vez (${first.detail}), sem confirmar (uma transmissão começou)`, "uma transmissão começou antes da confirmação");
                return;
            }
            const second = await probeOnce(tested, label);
            if (second.verdict === "ok") result = { verdict: "ok", detail: `${second.detail} (a 1ª rodada tinha travado: ${first.detail})` };
            else if (isBad(second)) result = { verdict: "broken", detail: `${second.detail}; confirmado na 2ª rodada` };
            else {
                unconfirmed(`travou uma vez (${first.detail}); a 2ª rodada não conseguiu dizer (${second.detail})`, "a 2ª rodada não conseguiu confirmar");
                return;
            }
        }
        note(`${PROBE_LABEL[result.verdict]} (${result.detail})`);
        if (result.verdict !== "unknown") saveHwOnly(codec, { at: Date.now(), env, verdict: result.verdict, detail: result.detail, codec: tested });
        if (result.verdict === "ok") {
            setOk(true);
            log.info(`Sonda WebCodecs do ${label} (${tested}) da placa de vídeo: ok (${result.detail}); `
                + `com o ${label} fixado, vai ${label} para quem também decodifica ${label} por hardware`);
        } else if (result.verdict === "broken") {
            // antes de soltar a trava (finally): nenhum envio da placa comeca no meio
            setH264HwStuck(true);
            log.warn(`A sonda WebCodecs do ${label} (${tested}) travou neste PC (${result.detail}): o ${label} fica desligado neste ambiente `
                + "(só o H.264) e, com um encoder preso na placa de vídeo, o automático vai em VP9 nesta sessão");
        } else {
            log.info(`Sonda WebCodecs do ${label} (${tested}) da placa de vídeo: inconclusiva (${result.detail}); `
                + `sem ${label} nesta sessão (o H.264 continua), e ela roda de novo na próxima vez que o Discord abrir`);
        }
    } finally {
        hwOnlyRunning[codec] = false;
        hold(codec, false);
    }
}

/** runHwOnlyProbe do H.265 (`codec`, ex.: hvc1.1.6.L123.B0). */
export function runH265Probe(env: EncoderEnv, codec: string, delayMs = PROBE_START.delayMs) {
    return runHwOnlyProbe("h265", env, codec, delayMs);
}

/** runHwOnlyProbe do AV1 (`codec`, ex.: av01.0.05M.08). */
export function runAv1Probe(env: EncoderEnv, codec: string, delayMs = PROBE_START.delayMs) {
    return runHwOnlyProbe("av1", env, codec, delayMs);
}

/**
 * Um envio em H.265 ou AV1 falhou no ar (streaming.ts): travou (containStuck → noteStuckEncoder) ou saiu da placa (o
 * WebRTC trocou sozinho para o H.264 reserva, ou o encoder deixou de ser da placa: no AV1, o libaom por software). A culpa
 * e dele, nunca do H.264: fica salvo "travou" para ele neste ambiente (source "stream") e o automatico deixa de manda-lo
 * agora, sem o registro "H.264 da placa travado". O botao nao esquece; so um ambiente novo testa ele de novo.
 */
export function noteHwOnlyFailed(codec: HwOnlyCodec, detail: string) {
    const at = Date.now();
    const spec = HW_ONLY[codec];
    const tested = spec.probeCodec(spec.fmtp(getLocalCaps()));
    spec.setOk(false);
    hwOnlyNotes[codec] = `travou num envio (${detail.slice(0, 200)})`;
    void environment().then(env => saveHwOnly(codec, { at, env, verdict: "broken", detail: detail.slice(0, 200), codec: tested, source: "stream" }));
}

/** noteHwOnlyFailed do H.265. */
export function noteH265Failed(detail: string) {
    noteHwOnlyFailed("h265", detail);
}

/** noteHwOnlyFailed do AV1. */
export function noteAv1Failed(detail: string) {
    noteHwOnlyFailed("av1", detail);
}

/**
 * Um envio em High falhou no ar (streaming.ts): travou (containStuck → noteStuckEncoder) ou caiu para o OpenH264 de verdade
 * (fallBack). A culpa e do High, nunca do Baseline: fica salvo "travou" para o High neste ambiente (source "stream") e o
 * automatico deixa de mandar High agora. O botao nao esquece; so um ambiente novo testa o High de novo.
 */
export function noteHighFailed(profile: string, detail: string) {
    const at = Date.now();
    setH264HighProbeOk(false);
    highNote = `travou num envio (${detail.slice(0, 200)})`;
    void environment().then(env => saveHigh({ at, env, verdict: "broken", detail: detail.slice(0, 200), profile, source: "stream" }));
}

/** streaming.ts → startStreaming: uma transmissao esta comecando (true) ou acabou de comecar/falhar (false). */
export function noteStreamStarting(starting: boolean) {
    streamStarting = starting;
}

/**
 * A placa de video travou num envio H.264 (streaming.ts → containStuck): o H.264 automatico desliga agora para o resto
 * da sessao e o PC lembra (com o ambiente atual; desconhecido tambem vale). Envio em High (`highProfile`): lembra que o
 * HIGH trava (noteHighFailed), nao o Baseline, que passou na sonda dele; depois de reiniciar o Discord, vai o Baseline.
 * Envio em H.265 ou AV1 (`hwOnly`, pelo codec que estava de fato no ar): lembra que ELE trava (noteHwOnlyFailed), sem o
 * registro do H.264; depois de reiniciar o Discord, vai o H.264.
 */
export function noteStuckEncoder(highProfile?: string | null, hwOnly: HwOnlyCodec | null = null) {
    const at = Date.now();
    stuckThisSession = true;
    setH264HwStuck(true);
    if (hwOnly) {
        noteHwOnlyFailed(hwOnly, `o encoder da placa de vídeo travou numa transmissão em ${HW_ONLY[hwOnly].label}`);
        return;
    }
    if (highProfile) {
        noteHighFailed(highProfile, "o encoder da placa de vídeo travou numa transmissão em High");
        return;
    }
    void environment().then(env => writeRecord({ at, env }));
}

/** A placa travou nesta sessao do Discord. */
export function stuckInThisSession() {
    return stuckThisSession;
}

/**
 * O que o botao fez: "testing" = a sonda roda agora e o H.264 so volta se ela disser ok/inconclusiva; "restart" = um
 * envio travou nesta sessao, ou ha uma transmissao no ar: a sonda roda na proxima abertura do Discord; "now" = nao ha
 * sonda possivel (sem Worker, ou a placa nem codifica H.264): o H.264 automatico volta ja, como antes.
 */
export type RetryOutcome = "testing" | "restart" | "now";

/**
 * Botao "Tentar a placa de vídeo de novo": esquece o travamento E o resultado das sondas, para o H.264 da placa so voltar
 * depois de a sonda deste ambiente dizer ok/inconclusiva (nunca as cegas). Do High, esquece so um "ok" (a sonda dele roda
 * de novo, logo depois da do Baseline: settleHigh); um "travou" do High fica ate o ambiente mudar (High → trava → botao →
 * High de novo seria um laco que trava o Discord a cada volta).
 */
export function forgetStuckEncoder(): RetryOutcome {
    writeRecord(null);
    save("hwH264Probe", null, "o resultado da sonda do H.264");
    const high = highProbeRecord();
    if (high?.verdict !== "broken") {
        save("hwH264HighProbe", null, "o resultado da sonda do H.264 High");
        highNote = "não feita (esquecida pelo botão; roda depois da do Baseline)";
    }
    setH264HighProbeOk(false);
    for (const codec of HW_ONLY_CODECS) {
        const spec = HW_ONLY[codec];
        if (hwOnlyProbeRecord(codec)?.verdict !== "broken") {
            save(spec.key, null, `o resultado da sonda do ${spec.label}`);
            hwOnlyNotes[codec] = "não feita (esquecida pelo botão; roda depois da do Baseline)";
        }
        spec.setOk(false);
    }
    const profile = getLocalCaps().h264HwProfile;
    const probeable = canProbe() && !!profile;
    let outcome: RetryOutcome;
    if (stuckThisSession || (probeable && streamBusy())) {
        outcome = "restart";
    } else if (probeable) {
        outcome = "testing";
        // a trava da sonda antes de soltar a do travamento: nenhum envio H.264 da placa comeca no meio
        hold("baseline", true);
        setH264HwStuck(false);
        if (!probeRunning) {
            void environment().then(async env => {
                await runStartupProbe(env, profile, 0);
                await settleUpgrades(env, 0);
            });
        }
    } else {
        outcome = "now";
        setH264HwStuck(false);
    }
    log.info("Você pediu para tentar o H.264 da placa de vídeo de novo: " + {
        testing: "testando a placa agora (sonda WebCodecs); o H.264 só volta se ela não travar no teste",
        restart: "a placa é testada de novo quando o Discord reiniciar",
        now: "vale a partir da próxima pessoa que assistir"
    }[outcome]);
    return outcome;
}

/** Linhas do "Copiar diagnóstico": a placa de video, o travamento lembrado e o desta sessao, e o High. */
export function stuckEncoderDiagnostics(): string {
    const record = stuckRecord();
    const env = envNow;
    const remembered = record
        ? `em ${new Date(record.at).toISOString()} (${describeEnv(record.env)})${env && envChanges(record.env, env).length ? " — o ambiente mudou desde então" : ""}`
        : "não";
    const contained = containedCount();
    const saved = probeRecord();
    const savedHigh = highProbeRecord();
    const caps = getLocalCaps();
    const highOn = caps.h264HwEncode && !!caps.h264HighHwProfile && caps.h264HighProbeOk;
    const savedH265 = h265ProbeRecord();
    const h265On = caps.h264HwEncode && caps.sendable.has("h265") && !!caps.h265HwFmtp && caps.h265ProbeOk === true;
    const savedAv1 = av1ProbeRecord();
    const av1On = caps.h264HwEncode && caps.sendable.has("av1") && caps.av1HwFeature !== false && !!caps.av1HwFmtp && caps.av1ProbeOk === true;
    const feature = caps.av1HwFeature === true ? "ligado" : caps.av1HwFeature === false ? "desligado" : "desconhecido";
    return [
        `ambiente do encoder: ${env ? `${describeEnv(env)} (placa via ${envSource})` : "ainda lendo"}`,
        `H.264 da placa travado neste PC: ${remembered}${record?.source === "probe" ? " [visto pela sonda]" : ""}; H.264 automático ${isH264HwStuck() ? "desligado" : "ligado"}`,
        `travou nesta sessão: ${stuckThisSession ? `sim (${contained} ${contained === 1 ? "conexão contida" : "conexões contidas"})` : "não"}`,
        `sonda WebCodecs H.264 placa: ${probeNote}${saved ? `; salva: ${PROBE_LABEL[saved.verdict]} em ${new Date(saved.at).toISOString()} (${saved.detail})` : ""}`,
        `H.264 High: codifica na placa ${caps.h264HighHwProfile ? `sim (perfil ${caps.h264HighHwProfile})` : "não"}, decodifica na placa ${caps.h264HighHwDecode ? "sim" : "não"}; `
        + `sonda WebCodecs High: ${highNote}${savedHigh ? `; salva: ${PROBE_LABEL[savedHigh.verdict]} em ${new Date(savedHigh.at).toISOString()} (perfil ${savedHigh.profile ?? "?"}: ${savedHigh.detail})${savedHigh.source === "stream" ? " [visto numa transmissão]" : ""}` : ""}; `
        + `High automático ${highOn ? "ligado (só com quem anuncia High por hardware)" : "desligado"}`,
        `H.265: codifica na placa ${caps.h265HwFmtp ? `sim (${caps.h265HwFmtp})` : "não"}, decodifica na placa ${caps.h265HwDecode ? "sim" : "não"}, `
        + `envia ${caps.sendable.has("h265") ? "sim" : "não (o Chromium não oferece)"}; sonda WebCodecs H.265: ${hwOnlyNotes.h265}`
        + `${savedH265 ? `; salva: ${PROBE_LABEL[savedH265.verdict]} em ${new Date(savedH265.at).toISOString()} (${savedH265.codec ?? "?"}: ${savedH265.detail})${savedH265.source === "stream" ? " [visto numa transmissão]" : ""}` : ""}; `
        + (!wanted("h265") ? "H.265 fixado desligado (o formato de vídeo não está em H.265)"
            : `H.265 fixado ${h265On ? "ligado (só com quem anuncia H.265 por hardware)" : "desligado"}`),
        `AV1: codifica na placa ${caps.av1HwFmtp ? `sim (${caps.av1HwFmtp})` : "não"}, decodifica na placa ${caps.av1HwDecode ? "sim" : "não"}, `
        + `WebRtcAV1HWEncode nesta partida ${feature}; sonda WebCodecs AV1: ${hwOnlyNotes.av1}`
        + `${savedAv1 ? `; salva: ${PROBE_LABEL[savedAv1.verdict]} em ${new Date(savedAv1.at).toISOString()} (${savedAv1.codec ?? "?"}: ${savedAv1.detail})${savedAv1.source === "stream" ? " [visto numa transmissão]" : ""}` : ""}; `
        + (!wanted("av1") ? "AV1 fixado desligado (o formato de vídeo não está em AV1)"
            : `AV1 fixado ${av1On ? "ligado (só com quem anuncia AV1 por hardware)" : "desligado (vai o do automático)"}`)
    ].join("\n");
}
