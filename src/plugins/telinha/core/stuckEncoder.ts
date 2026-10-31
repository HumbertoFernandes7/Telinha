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
// - o H.264 da placa volta a ser tentado sozinho quando o ambiente muda (driver, Discord/Chromium, outra placa), com uma
//   linha no log, ou pelo botao "Tentar a placa de vídeo de novo" (ui/StuckEncoderSection.tsx);
// - antes da 1a transmissao, uma vez por ambiente: a sonda WebCodecs (core/encoderProbe.ts) codifica uns quadros com o
//   H.264 da placa num Worker. Travou = o mesmo registro de "travou", entao a 1a transmissao ja vai em VP9 e nenhum
//   encoder H.264 do WebRTC e criado. O resultado fica salvo (chave privada hwH264Probe) e ela so roda de novo quando o
//   ambiente muda. O checkStall + containStuck do streaming.ts continuam como rede de seguranca.
// Parte do ambiente desconhecida (o native.ts antigo, getGPUInfo falhou) vale como curinga: o PC continua lembrando, e so
// uma parte conhecida dos dois lados e diferente conta como mudanca (um retry por engano custaria outro travamento).

import { settings } from "@plugins/telinha/settings";

import { describeLocalCaps, isH264HwStuck, probeLocalCaps, setH264HwProbing, setH264HwStuck } from "./codec";
import { rt } from "./context";
import { type ProbeResult, type ProbeVerdict, runEncoderProbe } from "./encoderProbe";
import { errorText, log } from "./log";
import { getNativeOrNull } from "./nativeApi";
import { containedCount } from "./peerConnection";

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

/** Resultado da sonda WebCodecs salvo neste PC (chave privada hwH264Probe): ela roda uma vez por ambiente. */
export interface ProbeRecord {
    at: number;
    env: EncoderEnv;
    verdict: ProbeVerdict;
    detail: string;
}

/** Espera antes da sonda WebCodecs, depois da sonda de codecs: fora da partida do Discord. Mutavel pelos testes. */
export const PROBE_START = { delayMs: 3000 };

/** Aviso para quem transmite (barra do Telinha), com o codec no automatico. */
export const STUCK_NOTICE = "A placa de vídeo travou com H.264. Para não travar o Discord, o Telinha não mexe mais nesta transmissão. "
    + "Reinicie o Discord (feche por completo e abra de novo) para transmitir de novo: da próxima vez vai em VP9 sozinho.";
/** O mesmo aviso com o codec fixado em H.264 nas configuracoes (ai o automatico nao vale). */
export const STUCK_NOTICE_PINNED = "A placa de vídeo travou com H.264. Para não travar o Discord, o Telinha não mexe mais nesta transmissão. "
    + "Reinicie o Discord (feche por completo e abra de novo) para transmitir de novo. O formato de vídeo está fixado em H.264 nas configurações: escolha Automático para ir em VP9.";

/** Espera pela placa de video no main (o native.ts tambem limita em 3 s) e pelo WebGPU. */
const ENV_TIMEOUT_MS = 4000;

/** Fabricantes que o WebGPU (GPUAdapterInfo.vendor) da pelo nome. */
const VENDOR_IDS: Record<string, string> = { amd: "1002", nvidia: "10de", intel: "8086", qualcomm: "5143", apple: "106b", microsoft: "1414" };

type PrivateStore = { stuckHwH264?: unknown; hwH264Probe?: unknown; };

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

/** O que mudou entre o ambiente salvo e o atual: so partes conhecidas dos dois lados e diferentes. Vazio = o mesmo. */
export function envChanges(saved: EncoderEnv, now: EncoderEnv): string[] {
    return ENV_PARTS
        .filter(([key]) => saved[key] != null && now[key] != null && saved[key] !== now[key])
        .map(([key, name]) => `${name} ${saved[key]} → ${now[key]}`);
}

/** "1002:73df, driver 31.0.24033.1003; Chromium 152...; Discord 1.0.9266" (partes desconhecidas com "?"). */
export function describeEnv(env: EncoderEnv): string {
    return `placa de vídeo ${env.vendorId ?? "?"}:${env.deviceId ?? "?"}, driver ${env.driver ?? "?"}; Chromium ${env.chrome ?? "?"}; Discord ${env.discord ?? "?"}`;
}

/** Uma chave privada salva, com `at` valido e o ambiente so com os campos conhecidos. null = nada (ou estragado). */
function readSaved(key: keyof PrivateStore): { raw: Record<string, unknown>; at: number; env: EncoderEnv; } | null {
    const raw: unknown = privateSettings().store[key];
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

/** O resultado da sonda WebCodecs salvo neste PC (de qualquer ambiente). null = nenhum. */
export function probeRecord(): ProbeRecord | null {
    const saved = readSaved("hwH264Probe");
    const verdict = VERDICTS.find(v => v === saved?.raw.verdict);
    if (!saved || !verdict) return null;
    return { at: saved.at, env: saved.env, verdict, detail: text(saved.raw.detail, 200) ?? "" };
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

/** O travamento lembrado vale neste ambiente? Mudou: esquece, com uma linha no log. */
function applyRemembered(env: EncoderEnv): StuckRecord | null {
    const record = stuckRecord();
    if (!record) return null;
    const changes = envChanges(record.env, env);
    if (!changes.length) {
        setH264HwStuck(true);
        return record;
    }
    writeRecord(null);
    log.info(`A placa de vídeo tinha travado com H.264 neste PC em ${shortDate(record.at)}, mas o ambiente mudou (${changes.join("; ")}): `
        + "o automático volta a tentar o H.264 da placa de vídeo");
    return null;
}

/**
 * Inicio da sessao (session.ts): le o ambiente, aplica o travamento lembrado (mesmo ambiente: H.264 automatico desligado;
 * ambiente mudou: esquece, com uma linha no log) e so entao mede as capacidades (codec.ts → probeLocalCaps), para nenhum
 * envio H.264 da placa comecar antes. Resolve ai (a presenca sai). Se a sonda WebCodecs ainda nao rodou neste ambiente
 * (e a placa codifica H.264, e o PC nao tem travamento lembrado), ela roda em segundo plano depois de PROBE_START.delayMs
 * (runStartupProbe). `report` recebe UMA linha das capacidades, com a placa de video, o travamento e a sonda (quando a
 * sonda roda, so no fim dela). Uma vez por sessao do Discord. Nunca rejeita.
 */
export function startLocalCaps(report: (line: string) => void): Promise<void> {
    return started ??= (async () => {
        const env = await environment();
        const remembered = applyRemembered(env);
        const saved = probeRecord();
        const done = saved && !envChanges(saved.env, env).length ? saved : null;
        const canProbe = typeof (globalThis as { Worker?: unknown; }).Worker === "function";
        const wantProbe = !remembered && !done && canProbe;
        // a sonda vai rodar: ate ela acabar, o automatico vai de VP9 (ligado antes da sonda de codecs, sem brecha)
        if (wantProbe) setH264HwProbing(true);
        const caps = await probeLocalCaps();
        const line = () => report(`${describeLocalCaps(caps)}; ${describeEnv(env)}; sonda WebCodecs H.264 placa: ${probeNote}`
            + (remembered ? `; H.264 automático desligado: a placa de vídeo travou com H.264 neste PC em ${shortDate(remembered.at)} (usando VP9)` : ""));
        if (wantProbe && caps.h264HwEncode && caps.h264HwProfile) {
            void runStartupProbe(env, caps.h264HwProfile).then(line);
            return;
        }
        setH264HwProbing(false);
        probeNote = remembered ? "não feita (a placa já travou neste PC)"
            : done ? `${PROBE_LABEL[done.verdict]} (feita em ${shortDate(done.at)} neste ambiente: ${done.detail})`
                : !caps.h264HwEncode ? "não feita (este PC não codifica H.264 na placa)"
                    : "não feita (sem Worker)";
        line();
    })();
}

/**
 * A sonda WebCodecs (core/encoderProbe.ts), uma vez por ambiente, fora da partida do Discord (espera PROBE_START.delayMs).
 * Uma transmissao comecando ou no ar nessa hora: nao roda (fica para a proxima vez que o Discord abrir). Enquanto roda,
 * o H.264 automatico fica desligado (setH264HwProbing): uma transmissao que comeca no meio manda VP9 para quem pedir
 * nesses segundos (no maximo ~7 s). Travou = o mesmo registro de um travamento numa transmissao (source "probe"), antes
 * de desligar a trava, entao nenhum encoder H.264 do WebRTC e criado. Ok ou inconclusiva: como antes.
 */
export async function runStartupProbe(env: EncoderEnv, profile: string) {
    setH264HwProbing(true);
    try {
        await new Promise(resolve => setTimeout(resolve, PROBE_START.delayMs));
        if (streamStarting || rt.local) {
            probeNote = "não feita (uma transmissão estava começando ou no ar; tenta de novo na próxima vez que o Discord abrir)";
            return;
        }
        probeNote = "rodando";
        // nunca rejeita: travou, inconclusiva ou ok
        const result: ProbeResult = await runEncoderProbe(profile);
        if (result.hung) log.warn(`Sonda WebCodecs do H.264 da placa de vídeo: o encoder ficou preso (${result.detail}); o Worker dela fica como está até o Discord fechar`);
        probeNote = `${PROBE_LABEL[result.verdict]} (${result.detail})`;
        save("hwH264Probe", { at: Date.now(), env: { ...env }, verdict: result.verdict, detail: result.detail }, "o resultado da sonda do H.264");
        if (result.verdict === "broken") {
            // antes de soltar a trava (finally): nenhum envio H.264 da placa comeca no meio
            setH264HwStuck(true);
            writeRecord({ at: Date.now(), env, source: "probe" });
            log.warn(`A sonda WebCodecs mostrou que o H.264 da placa de vídeo trava neste PC (${result.detail}): `
                + "o automático vai em VP9, sem criar o encoder H.264 da placa, até o driver, o Discord ou a placa mudarem");
        }
    } finally {
        setH264HwProbing(false);
    }
}

/** streaming.ts → startStreaming: uma transmissao esta comecando (true) ou acabou de comecar/falhar (false). */
export function noteStreamStarting(starting: boolean) {
    streamStarting = starting;
}

/**
 * A placa de video travou num envio H.264 (streaming.ts → containStuck): o H.264 automatico desliga agora para o resto
 * da sessao e o PC lembra (com o ambiente atual; desconhecido tambem vale).
 */
export function noteStuckEncoder() {
    const at = Date.now();
    stuckThisSession = true;
    setH264HwStuck(true);
    void environment().then(env => writeRecord({ at, env }));
}

/** A placa travou nesta sessao do Discord. */
export function stuckInThisSession() {
    return stuckThisSession;
}

/**
 * Botao "Tentar a placa de vídeo de novo": esquece o travamento lembrado. Sem nada travado nesta sessao, o H.264
 * automatico volta agora (devolve true); com um envio travado nesta sessao, so depois de reiniciar o Discord (false).
 */
export function forgetStuckEncoder(): boolean {
    writeRecord(null);
    const now = !stuckThisSession;
    if (now) setH264HwStuck(false);
    log.info(`Você pediu para tentar o H.264 da placa de vídeo de novo: ${now ? "vale a partir da próxima pessoa que assistir" : "vale depois que você reiniciar o Discord"}`);
    return now;
}

/** Linhas do "Copiar diagnóstico": a placa de video, o travamento lembrado e o desta sessao. */
export function stuckEncoderDiagnostics(): string {
    const record = stuckRecord();
    const env = envNow;
    const remembered = record
        ? `em ${new Date(record.at).toISOString()} (${describeEnv(record.env)})${env && envChanges(record.env, env).length ? " — o ambiente mudou desde então" : ""}`
        : "não";
    const contained = containedCount();
    const saved = probeRecord();
    return [
        `ambiente do encoder: ${env ? `${describeEnv(env)} (placa via ${envSource})` : "ainda lendo"}`,
        `H.264 da placa travado neste PC: ${remembered}${record?.source === "probe" ? " [visto pela sonda]" : ""}; H.264 automático ${isH264HwStuck() ? "desligado" : "ligado"}`,
        `travou nesta sessão: ${stuckThisSession ? `sim (${contained} ${contained === 1 ? "conexão contida" : "conexões contidas"})` : "não"}`,
        `sonda WebCodecs H.264 placa: ${probeNote}${saved ? `; salva: ${PROBE_LABEL[saved.verdict]} em ${new Date(saved.at).toISOString()} (${saved.detail})` : ""}`
    ].join("\n");
}
