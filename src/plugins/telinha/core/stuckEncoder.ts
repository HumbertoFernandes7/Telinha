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

import { settings } from "@plugins/telinha/settings";

import { describeLocalCaps, getLocalCaps, isH264HwStuck, probeLocalCaps, setH264HwProbing, setH264HwStuck } from "./codec";
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

/**
 * Quando a sonda WebCodecs roda: `delayMs` depois da sonda de codecs (fora da partida do Discord) e, se travar, a 2a
 * rodada de confirmacao `confirmMs` depois. Mutavel pelos testes.
 */
export const PROBE_START = { delayMs: 3000, confirmMs: 30_000 };

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

const canProbe = () => typeof (globalThis as { Worker?: unknown; }).Worker === "function";
const streamBusy = () => streamStarting || !!rt.local;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Inicio da sessao (session.ts). A sonda de codecs (codec.ts → probeLocalCaps) e a leitura do ambiente correm juntas;
 * so o H.264 automatico espera (setH264HwProbing) ate o travamento lembrado ser aplicado, para nenhum envio H.264 da placa
 * comecar antes. Travamento lembrado no mesmo ambiente: H.264 automatico desligado. Ambiente mudou: continua desligado ate
 * a sonda deste ambiente dizer "ok" (settleChangedEnv). Resolve depois das duas (a presenca sai). Se a sonda WebCodecs
 * ainda nao rodou neste ambiente (e a placa codifica H.264), ela roda em segundo plano depois de PROBE_START.delayMs
 * (runStartupProbe). `report` recebe UMA linha das capacidades, com a placa de video, o travamento e a sonda (quando a
 * sonda roda, so no fim dela). Uma vez por sessao do Discord. Nunca rejeita.
 */
export function startLocalCaps(report: (line: string) => void): Promise<void> {
    return started ??= (async () => {
        setH264HwProbing(true);
        const measuring = probeLocalCaps();
        const env = await environment();
        const record = stuckRecord();
        const sameEnv = !!record && !envChanges(record.env, env).length;
        if (record) setH264HwStuck(true);
        const saved = probeRecord();
        const done = saved && !envChanges(saved.env, env).length ? saved : null;
        const caps = await measuring;
        const line = () => {
            const rec = stuckRecord();
            report(`${describeLocalCaps(caps)}; ${describeEnv(env)}; sonda WebCodecs H.264 placa: ${probeNote}`
                + (rec && isH264HwStuck() ? `; H.264 automático desligado: a placa de vídeo travou com H.264 neste PC em ${shortDate(rec.at)} (usando VP9)` : ""));
        };
        if (!sameEnv && !done && canProbe() && caps.h264HwEncode && caps.h264HwProfile) {
            void runStartupProbe(env, caps.h264HwProfile).then(line);
            return;
        }
        if (record && !sameEnv) settleChangedEnv(record, env, done?.verdict ?? "unknown");
        setH264HwProbing(false);
        probeNote = sameEnv ? "não feita (a placa já travou neste PC)"
            : done ? `${PROBE_LABEL[done.verdict]} (feita em ${shortDate(done.at)} neste ambiente: ${done.detail})`
                : !caps.h264HwEncode ? "não feita (este PC não codifica H.264 na placa)"
                    : "não feita (sem Worker)";
        line();
    })();
}

/** Uma rodada da sonda, com a linha do log quando o Worker fica preso. */
async function probeOnce(profile: string): Promise<ProbeResult> {
    const result = await runEncoderProbe(profile);
    if (result.hung) log.warn(`Sonda WebCodecs do H.264 da placa de vídeo: o encoder ficou preso (${result.detail}); o Worker dela fica como está até o Discord fechar`);
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
    setH264HwProbing(true);
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
                probeNote = `travou uma vez (${first.detail}), sem confirmar (uma transmissão começou): VP9 nesta sessão`;
                setH264HwStuck(true);
                log.warn("A sonda WebCodecs travou com o H.264 da placa de vídeo, mas uma transmissão começou antes da confirmação: o automático vai em VP9 "
                    + "nesta sessão, e a sonda roda de novo na próxima vez que o Discord abrir");
                return;
            }
            const second = await probeOnce(profile);
            result = second.verdict === "broken"
                ? { verdict: "broken", detail: `${second.detail}; confirmado na 2ª rodada` }
                : { verdict: second.verdict, detail: `${second.detail} (a 1ª rodada tinha travado: ${first.detail})` };
        }
        probeNote = `${PROBE_LABEL[result.verdict]} (${result.detail})`;
        save("hwH264Probe", { at: Date.now(), env: { ...env }, verdict: result.verdict, detail: result.detail }, "o resultado da sonda do H.264");
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
 * O que o botao fez: "testing" = a sonda roda agora e o H.264 so volta se ela disser ok/inconclusiva; "restart" = um
 * envio travou nesta sessao, ou ha uma transmissao no ar: a sonda roda na proxima abertura do Discord; "now" = nao ha
 * sonda possivel (sem Worker, ou a placa nem codifica H.264): o H.264 automatico volta ja, como antes.
 */
export type RetryOutcome = "testing" | "restart" | "now";

/**
 * Botao "Tentar a placa de vídeo de novo": esquece o travamento E o resultado da sonda, para o H.264 da placa so voltar
 * depois de a sonda deste ambiente dizer ok/inconclusiva (nunca as cegas).
 */
export function forgetStuckEncoder(): RetryOutcome {
    writeRecord(null);
    save("hwH264Probe", null, "o resultado da sonda do H.264");
    const profile = getLocalCaps().h264HwProfile;
    const probeable = canProbe() && !!profile;
    let outcome: RetryOutcome;
    if (stuckThisSession || (probeable && streamBusy())) {
        outcome = "restart";
    } else if (probeable) {
        outcome = "testing";
        // a trava da sonda antes de soltar a do travamento: nenhum envio H.264 da placa comeca no meio
        setH264HwProbing(true);
        setH264HwStuck(false);
        if (!probeRunning) void environment().then(env => runStartupProbe(env, profile, 0));
    } else {
        outcome = "now";
        setH264HwStuck(false);
    }
    log.info("Você pediu para tentar o H.264 da placa de vídeo de novo: " + {
        testing: "testando a placa agora (sonda WebCodecs); o H.264 só volta se ela responder",
        restart: "a placa é testada de novo quando o Discord reiniciar",
        now: "vale a partir da próxima pessoa que assistir"
    }[outcome]);
    return outcome;
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
