/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// EXPERIMENTO (modo "Tempo real (teste)" da prioridade da captura na placa de video): pede ao proprio Discord que ponha os
// processos dele em REALTIME na placa de video, pelo mesmo caminho do "GPU boost" do Discord. O modulo nativo do Discord
// (discord_utils.node) exporta setGPUBoostEnabledByPid, que manda um pedido ao servico DiscordSystemHelper (SYSTEM, so aceita
// quem foi assinado pela Discord Inc.; o codigo roda dentro do Discord.exe). A assinatura exata da funcao nao e conhecida
// (provavel: (pid, enabled), devolvendo valor, Promise ou usando callback), entao tudo aqui e tolerante e NUNCA lanca: o que
// acontece vai para o log e a transmissao segue como se nada tivesse sido pedido.
//
//   - probeDiscordGpuBoost(): acha o modulo, diz se a funcao existe e quais funcoes parecidas ele tem (para o log).
//   - setDiscordGpuBoost(pid, enabled): chama a funcao (retorno direto, Promise, callback ou excecao) com prazo de 5 s.
//   - startRealtimeTest / stopRealtimeTest: a orquestracao da transmissao (core/captureBoost.ts): no inicio, sonda, pede
//     REALTIME para cada processo e ~2 s depois le de novo as classes (pelo mesmo caminho do "high", que nunca abaixa e so
//     mexe em quem esta abaixo de HIGH, entao e uma leitura na pratica); no fim, pede o NORMAL de volta.
// Nada aqui mexe em codec, copia ou controlador, nem roda em "Desligada" ou "Alta".

import type { GpuPriorityReport, GpuPriorityTarget } from "./captureBoostMain";
import { errorText, log } from "./log";

const MODULE_NAME = "discord_utils";
const FUNCTION_NAME = "setGPUBoostEnabledByPid";
const PREFIX = "Teste do tempo real pelo Discord";
/** prazo para o requireModule responder (pode devolver uma Promise) */
export const PROBE_TIMEOUT_MS = 3000;
/** prazo para o pedido ao servico do Discord responder */
export const BOOST_TIMEOUT_MS = 5000;
/** depois do pedido, quanto esperar antes de ler de novo as classes */
export const REREAD_DELAY_MS = 2000;
/** funcoes do modulo que parecem ser da placa de video / desempenho, para o log */
const INTERESTING_KEY_RE = /gpu|boost|service|tool|perf/i;
const RESULT_MAX_CHARS = 120;

export interface DiscordGpuBoostProbe {
    available: boolean;
    /** por que nao esta disponivel (pt-BR) */
    why?: string;
    /** nomes das funcoes proprias do modulo que combinam com gpu|boost|service|tool|perf */
    keys: string[];
}

export interface DiscordGpuBoostResult {
    ok: boolean;
    /** o que a funcao devolveu (retorno, Promise resolvida ou argumentos do callback) */
    result?: unknown;
    error?: string;
    /** quanto durou o pedido */
    ms: number;
}

/** So para testes: troca o ponto de entrada do Discord e os prazos. */
export interface DiscordGpuBoostOptions {
    /** o objeto DiscordNative (padrao: globalThis.DiscordNative) */
    discordNative?: unknown;
    probeTimeoutMs?: number;
    boostTimeoutMs?: number;
}

type AnyFn = (...args: unknown[]) => unknown;

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && (typeof v === "object" || typeof v === "function") && typeof (v as { then?: unknown; }).then === "function";

/** Espera `work` por no maximo `ms`; o relogio e desarmado quando ela termina. */
function withTimeout<T>(work: PromiseLike<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what}: sem resposta em ${ms} ms`)), ms);
        work.then(
            v => {
                clearTimeout(timer);
                resolve(v);
            },
            e => {
                clearTimeout(timer);
                reject(e);
            }
        );
    });
}

/** O modulo discord_utils do Discord (o requireModule devolve direto ou uma Promise). Nunca lanca. */
async function loadModule(opts: DiscordGpuBoostOptions): Promise<{ mod: Record<string, unknown> | null; why?: string; }> {
    try {
        const dn = (opts.discordNative ?? (globalThis as { DiscordNative?: unknown; }).DiscordNative) as
            { nativeModules?: { requireModule?: unknown; }; } | undefined;
        const nm = dn?.nativeModules;
        if (!dn) return { mod: null, why: "o Discord não expõe o DiscordNative" };
        if (typeof nm?.requireModule !== "function") return { mod: null, why: "o Discord não expõe nativeModules.requireModule" };
        const got = (nm.requireModule as AnyFn).call(nm, MODULE_NAME);
        const mod = await withTimeout(Promise.resolve(got), opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS, `requireModule("${MODULE_NAME}")`);
        if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return { mod: null, why: `o módulo ${MODULE_NAME} não veio (${mod === null ? "null" : typeof mod})` };
        return { mod: mod as Record<string, unknown> };
    } catch (e) {
        return { mod: null, why: `não consegui carregar o módulo ${MODULE_NAME} (${errorText(e)})` };
    }
}

/** Nomes das funcoes do modulo que combinam com o filtro (so as proprias e enumeraveis). Nunca lanca. */
function interestingKeys(mod: Record<string, unknown>): string[] {
    try {
        return Object.keys(mod).filter(k => INTERESTING_KEY_RE.test(k) && typeof mod[k] === "function").sort();
    } catch {
        return [];
    }
}

/** O modulo do Discord esta la, e tem a funcao do GPU boost? Nunca lanca. */
export async function probeDiscordGpuBoost(opts: DiscordGpuBoostOptions = {}): Promise<DiscordGpuBoostProbe> {
    const { mod, why } = await loadModule(opts);
    if (!mod) return { available: false, why, keys: [] };
    const keys = interestingKeys(mod);
    let hasFn = false;
    try {
        hasFn = typeof mod[FUNCTION_NAME] === "function";
    } catch { /* modulo estranho: conta como sem a funcao */ }
    return hasFn ? { available: true, keys } : { available: false, why: `o módulo ${MODULE_NAME} não tem a função ${FUNCTION_NAME}`, keys };
}

/** Chama a funcao do jeito que ela responder: retorno, Promise, excecao ou callback (3o argumento). */
function invoke(fn: AnyFn, mod: unknown, pid: number, enabled: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
        try {
            if (fn.length >= 3) {
                const callback = (...args: unknown[]) => {
                    const err = args.find(a => a instanceof Error);
                    if (err) reject(err);
                    else resolve(args.length <= 1 ? args[0] : args[0] == null ? args[1] : args);
                };
                const ret = fn.call(mod, pid, enabled, callback);
                if (isThenable(ret)) ret.then(resolve, reject);
            } else {
                // resolve(Promise) adota a Promise; um valor direto resolve na hora
                resolve(fn.call(mod, pid, enabled));
            }
        } catch (e) {
            reject(e);
        }
    });
}

/** Liga (enabled) ou desliga o REALTIME do Discord para este PID, pelo servico do proprio Discord. Nunca lanca. */
export async function setDiscordGpuBoost(pid: number, enabled: boolean, opts: DiscordGpuBoostOptions = {}): Promise<DiscordGpuBoostResult> {
    const started = Date.now();
    const done = (r: Omit<DiscordGpuBoostResult, "ms">): DiscordGpuBoostResult => ({ ...r, ms: Math.max(0, Date.now() - started) });
    try {
        const { mod, why } = await loadModule(opts);
        if (!mod) return done({ ok: false, error: why });
        const fn = mod[FUNCTION_NAME];
        if (typeof fn !== "function") return done({ ok: false, error: `o módulo ${MODULE_NAME} não tem a função ${FUNCTION_NAME}` });
        const result = await withTimeout(invoke(fn as AnyFn, mod, pid, enabled), opts.boostTimeoutMs ?? BOOST_TIMEOUT_MS, FUNCTION_NAME);
        // um "false" explicito e a resposta do Discord dizendo que nao fez
        if (result === false) return done({ ok: false, result, error: "o Discord respondeu false" });
        return done({ ok: true, result });
    } catch (e) {
        return done({ ok: false, error: errorText(e) });
    }
}

/** A resposta da funcao, curta, para o log. */
export function resultText(result: unknown): string {
    if (result === undefined) return "sem valor";
    let text: string;
    try {
        text = typeof result === "string" ? JSON.stringify(result) : (JSON.stringify(result) ?? String(result));
    } catch {
        text = String(result);
    }
    return text.length > RESULT_MAX_CHARS ? `${text.slice(0, RESULT_MAX_CHARS)}…` : text;
}

// #region orquestracao da transmissao

interface BoostTarget {
    pid: number;
    role: GpuPriorityTarget["role"];
    /** a classe em que o "high" o deixou (para dizer "continua HIGH" ou "agora REALTIME") */
    was: string | null;
}

interface TestRun {
    targets: BoostTarget[];
    /** o fim da transmissao chegou antes de o inicio terminar: nao ler as classes */
    aborted: boolean;
    started: Promise<void>;
}

/** O teste desta transmissao (null: nenhum em andamento). Guarda contra inicio e fim em dobro. */
let run: TestRun | null = null;

const roleText = (t: { role: GpuPriorityTarget["role"]; }) => (t.role === "GPU" ? "GPU do Discord" : "Discord");
const who = (t: BoostTarget) => `${roleText(t)} ${t.pid}`;

/** O teste esta valendo nesta transmissao (o fim precisa desfazer). */
export function realtimeTestActive(): boolean {
    return run !== null;
}

function boostLine(t: BoostTarget, enabled: boolean, r: DiscordGpuBoostResult) {
    if (r.ok) {
        log.info(`${PREFIX}: ${who(t)} → ${enabled ? "pedido aceito" : "volta ao normal aceita"} (${r.ms} ms; resposta: ${resultText(r.result)})`);
    } else {
        log.warn(`${PREFIX}: ${who(t)} → ${enabled ? "falhou" : "a volta ao normal falhou"}: ${r.error ?? "motivo desconhecido"} (${r.ms} ms)`);
    }
}

/** "agora REALTIME", "continua HIGH"... a classe de cada processo na releitura. */
function classLine(t: BoostTarget, reread: GpuPriorityReport | null) {
    const now = reread?.targets.find(x => x.pid === t.pid);
    if (!now) {
        log.warn(`${PREFIX}: ${who(t)} → não deu para ler a classe agora${reread ? " (o processo não veio na resposta)" : " (sem resposta da parte nativa)"}`);
    } else if (now.error || !now.after) {
        log.warn(`${PREFIX}: ${who(t)} → não deu para ler a classe agora (${now.error ?? "sem resposta do ajudante"})`);
    } else {
        log.info(`${PREFIX}: ${who(t)} → ${t.was === now.after ? "continua" : "agora"} ${now.after}`);
    }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function runStart(r: TestRun, reread: () => Promise<GpuPriorityReport | null>, opts: DiscordGpuBoostOptions) {
    const probe = await probeDiscordGpuBoost(opts);
    const keys = probe.keys.length ? probe.keys.join(", ") : "nenhuma";
    if (!probe.available) {
        log.warn(`${PREFIX}: ${MODULE_NAME} indisponível (${probe.why ?? "motivo desconhecido"}); funções parecidas: ${keys}. Nada foi pedido.`);
        // sem o que desfazer: o fim da transmissao nao precisa pedir nada
        if (run === r) run = null;
        return;
    }
    log.info(`${PREFIX}: ${MODULE_NAME} disponível (${FUNCTION_NAME} existe); funções parecidas: ${keys}`);
    for (const t of r.targets) {
        if (r.aborted) return;
        boostLine(t, true, await setDiscordGpuBoost(t.pid, true, opts));
    }
    if (r.aborted) return;
    await sleep(REREAD_DELAY_MS);
    if (r.aborted) return;
    let report: GpuPriorityReport | null = null;
    try {
        report = await reread();
    } catch (e) {
        log.warn(`${PREFIX}: a releitura das classes falhou (${errorText(e)})`);
    }
    for (const t of r.targets) classLine(t, report);
}

/**
 * A transmissao comecou em "Tempo real (teste)" e o "high" ja respondeu com os processos (core/captureBoost.ts): sonda o
 * modulo do Discord e pede o REALTIME de cada um. `reread` le as classes de novo (o "high" do main). Em dobro (ja ha um
 * teste na transmissao): nao faz nada. Nunca lanca.
 */
export function startRealtimeTest(report: GpuPriorityReport, reread: () => Promise<GpuPriorityReport | null>, opts: DiscordGpuBoostOptions = {}): void {
    if (run) return;
    const targets = report.targets
        .filter(t => Number.isInteger(t.pid) && t.pid > 0 && !t.error && !!t.after)
        .map((t): BoostTarget => ({ pid: t.pid, role: t.role, was: t.after }));
    if (!targets.length) {
        log.warn(`${PREFIX}: nenhum processo do Discord com classe conhecida; nada foi pedido`);
        return;
    }
    const r: TestRun = { targets, aborted: false, started: Promise.resolve() };
    run = r;
    r.started = runStart(r, reread, opts).catch(e => log.warn(`${PREFIX}: erro inesperado (${errorText(e)})`));
}

/**
 * A transmissao acabou (ou o modo deixou de ser "Tempo real"): espera o inicio terminar e pede o NORMAL de volta para os
 * mesmos processos. Sem teste em andamento: nao faz nada. Nunca lanca.
 */
export async function stopRealtimeTest(opts: DiscordGpuBoostOptions = {}): Promise<void> {
    const r = run;
    if (!r) return;
    run = null;
    r.aborted = true;
    try {
        await r.started;
        for (const t of r.targets) boostLine(t, false, await setDiscordGpuBoost(t.pid, false, opts));
    } catch (e) {
        log.warn(`${PREFIX}: erro inesperado ao desfazer (${errorText(e)})`);
    }
}

/** So para testes: esquece o teste em andamento. */
export function resetDiscordGpuBoostForTests() {
    run = null;
}

// #endregion
