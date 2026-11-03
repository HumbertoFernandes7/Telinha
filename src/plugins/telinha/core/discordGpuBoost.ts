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
//     REALTIME so para os processos que o Telinha acabou de subir para HIGH (quem ja estava em REALTIME ou HIGH por conta do
//     Discord nunca e tocado) e ~2 s depois le de novo as classes (pelo mesmo caminho do "high", que nunca abaixa e so mexe
//     em quem esta abaixo de HIGH, entao e uma leitura na pratica); no fim, desfaz.
//   - ATENCAO: setGPUBoostEnabledByPid(pid, false) NAO e um "desfazer": o Discord poe NORMAL, nao a classe de antes. Por isso
//     o desfazer confere que o pid ainda e o mesmo processo do Discord, manda false (vai a NORMAL) e pede o "high" do Telinha
//     de novo (volta a HIGH; o "restore" do fim da transmissao leva para a classe que o Telinha encontrou).
//   - recoverDiscordGpuBoost: o que foi pedido fica em sessionStorage; se o renderer recarregar no meio, o inicio do plugin desfaz.
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

/** onde ficam os processos pedidos (sobrevive a um reload do renderer, some ao fechar o Discord) */
const STORAGE_KEY = "telinha.discordGpuBoost";
/** as classes abaixo de HIGH (as unicas de onde o Telinha sobe) */
const BELOW_HIGH = new Set(["IDLE", "BELOW_NORMAL", "NORMAL", "ABOVE_NORMAL"]);

type Role = GpuPriorityTarget["role"];
interface ProcessRef {
    pid: number;
    role: Role;
}

/** Um processo do Discord que o "high" respondeu. */
interface BoostTarget extends ProcessRef {
    /** a classe em que o "high" o deixou (para dizer "continua HIGH" ou "agora REALTIME") */
    was: string;
    /** a classe que o processo tinha antes de o Telinha mexer (o "restore" do fim leva para ela) */
    classBefore: string;
    /** o "high" o deixou como estava (ja era HIGH ou REALTIME por conta do Discord): nunca e tocado */
    kept: boolean;
}

interface SavedBoost extends ProcessRef {
    classBefore: string;
    at: number;
}

interface TestRun {
    /** os processos com classe conhecida */
    targets: BoostTarget[];
    /** os que o Telinha pediu ao Discord (e que o fim precisa desfazer) */
    boosted: BoostTarget[];
    /** o fim da transmissao chegou antes de o inicio terminar: nao ler as classes */
    aborted: boolean;
    started: Promise<void>;
    /** o "high" do main: le as classes de novo, confere os pids e volta a HIGH depois do false */
    ask: () => Promise<GpuPriorityReport | null>;
}

/** O teste desta transmissao (null: nenhum em andamento). Guarda contra inicio e fim em dobro. */
let run: TestRun | null = null;
/** O desfazer da transmissao anterior: o teste da proxima so comeca depois dele (o false nunca cai por cima do true novo). */
let pendingStop: Promise<void> = Promise.resolve();

const roleText = (t: { role: Role; }) => (t.role === "GPU" ? "GPU do Discord" : "Discord");
const who = (t: ProcessRef) => `${roleText(t)} ${t.pid}`;

/** O teste esta valendo nesta transmissao (o fim precisa desfazer). */
export function realtimeTestActive(): boolean {
    return run !== null;
}

/** So o que o Telinha subiu (a classe de antes era abaixo de HIGH, e agora e HIGH) entra no teste. */
const isOurs = (t: BoostTarget) => !t.kept && t.was === "HIGH" && BELOW_HIGH.has(t.classBefore);

// #region o que foi pedido, em sessionStorage

interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const sessionStore = () => (globalThis as { sessionStorage?: StorageLike; }).sessionStorage;

function readSaved(): SavedBoost[] {
    try {
        const raw = sessionStore()?.getItem(STORAGE_KEY);
        if (!raw) return [];
        const list: unknown = JSON.parse(raw);
        if (!Array.isArray(list)) return [];
        return list.filter((e): e is SavedBoost => !!e && typeof e === "object" && Number.isInteger(e.pid) && e.pid > 0
            && (e.role === "Discord" || e.role === "GPU") && typeof e.classBefore === "string" && typeof e.at === "number");
    } catch {
        return [];
    }
}

function writeSaved(list: SavedBoost[]) {
    try {
        const store = sessionStore();
        if (!store) return;
        if (list.length) store.setItem(STORAGE_KEY, JSON.stringify(list));
        else store.removeItem(STORAGE_KEY);
    } catch { /* sem sessionStorage: so nao ha como desfazer depois de um reload */ }
}

const saveAdd = (entry: SavedBoost) => writeSaved([...readSaved().filter(e => e.pid !== entry.pid), entry]);
const saveRemove = (pids: number[]) => writeSaved(readSaved().filter(e => !pids.includes(e.pid)));

// #endregion

function boostLine(t: ProcessRef, enabled: boolean, r: DiscordGpuBoostResult) {
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

/** o helper diz "gone ..." (o processo terminou) ou "tree ..." (o pid ja e de outro processo, fora da arvore do Discord) */
const GONE_ERROR_RE = /^(?:gone|tree) /;

/** O pid ainda e o mesmo processo do Discord, segundo o relatorio de agora (mesmo papel, e nao "gone"/"tree")? */
const sameProcess = (current: GpuPriorityReport, t: ProcessRef) =>
    current.targets.some(x => x.pid === t.pid && x.role === t.role && !(x.error && GONE_ERROR_RE.test(x.error)));

interface UndoOutcome {
    undone: ProcessRef[];
    failed: ProcessRef[];
    /** o pid ja nao e o mesmo processo do Discord (reiniciou, ou o Windows deu o numero a outro): nada foi pedido nele */
    stale: ProcessRef[];
    /** nao deu para conferir os processos: nada foi pedido */
    unchecked: boolean;
}

/**
 * O desfazer: confere os pids (pedido "high" do main), manda false so para quem ainda e o mesmo processo do Discord (o Discord
 * poe NORMAL, nao a classe de antes) e pede o "high" de novo: volta a HIGH, com o main ainda lembrando a classe de antes (o
 * "restore" do fim da transmissao leva para ela). Nunca lanca.
 */
async function undoBoost(items: ProcessRef[], ask: () => Promise<GpuPriorityReport | null>, opts: DiscordGpuBoostOptions, each: boolean): Promise<UndoOutcome> {
    const out: UndoOutcome = { undone: [], failed: [], stale: [], unchecked: false };
    if (!items.length) return out;
    let current: GpuPriorityReport | null = null;
    try {
        current = await ask();
    } catch (e) {
        log.warn(`${PREFIX}: a conferência dos processos falhou (${errorText(e)})`);
    }
    if (!current) {
        out.unchecked = true;
        return out;
    }
    for (const t of items) {
        if (!sameProcess(current, t)) {
            out.stale.push(t);
            continue;
        }
        const r = await setDiscordGpuBoost(t.pid, false, opts);
        if (each) boostLine(t, false, r);
        (r.ok ? out.undone : out.failed).push(t);
    }
    // o false deixou NORMAL: volta a HIGH
    if (out.undone.length || out.failed.length) {
        try {
            await ask();
        } catch (e) {
            log.warn(`${PREFIX}: a volta para HIGH falhou (${errorText(e)})`);
        }
    }
    return out;
}

async function runStart(r: TestRun, opts: DiscordGpuBoostOptions) {
    if (r.aborted) return;
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
        // so quem o Telinha acabou de subir (ex.: NORMAL→HIGH). Quem ja estava em REALTIME ou HIGH por conta do Discord nao e
        // tocado: o false do Discord poe NORMAL, e nao ha como voltar ao que era
        if (!isOurs(t)) {
            log.info(`${PREFIX}: ${who(t)} → ${t.kept ? `já estava ${t.was}` : `ficou em ${t.was}`}; não pedi nada`);
            continue;
        }
        r.boosted.push(t);
        const result = await setDiscordGpuBoost(t.pid, true, opts);
        boostLine(t, true, result);
        if (result.ok) saveAdd({ pid: t.pid, role: t.role, classBefore: t.classBefore, at: Date.now() });
    }
    if (!r.boosted.length) {
        log.warn(`${PREFIX}: nenhum processo estava em HIGH por conta do Telinha; nada foi pedido`);
        if (run === r) run = null;
        return;
    }
    if (r.aborted) return;
    await sleep(REREAD_DELAY_MS);
    if (r.aborted) return;
    let report: GpuPriorityReport | null = null;
    try {
        report = await r.ask();
    } catch (e) {
        log.warn(`${PREFIX}: a releitura das classes falhou (${errorText(e)})`);
    }
    for (const t of r.boosted) classLine(t, report);
}

/**
 * A transmissao comecou em "Tempo real (teste)" e o "high" ja respondeu com os processos (core/captureBoost.ts): sonda o
 * modulo do Discord e pede o REALTIME dos que o Telinha subiu. `reread` e o "high" do main (le as classes de novo, confere
 * os pids no fim e volta a HIGH depois do false). Em dobro (ja ha um teste na transmissao): nao faz nada. Se o fim da
 * transmissao anterior ainda esta desfazendo, espera ele. Nunca lanca.
 */
export function startRealtimeTest(report: GpuPriorityReport, reread: () => Promise<GpuPriorityReport | null>, opts: DiscordGpuBoostOptions = {}): void {
    if (run) return;
    const targets = report.targets
        .filter(t => Number.isInteger(t.pid) && t.pid > 0 && !t.error && !!t.after && !!t.before)
        .map((t): BoostTarget => ({ pid: t.pid, role: t.role, was: t.after as string, classBefore: t.before as string, kept: t.kept }));
    if (!targets.length) {
        log.warn(`${PREFIX}: nenhum processo do Discord com classe conhecida; nada foi pedido`);
        return;
    }
    const r: TestRun = { targets, boosted: [], aborted: false, started: Promise.resolve(), ask: reread };
    run = r;
    r.started = pendingStop.then(() => runStart(r, opts)).catch(e => log.warn(`${PREFIX}: erro inesperado (${errorText(e)})`));
}

/**
 * A transmissao acabou (ou o modo deixou de ser "Tempo real"): espera o inicio terminar e desfaz o pedido nos processos
 * que ainda sao os mesmos do Discord (ver undoBoost). Sem teste em andamento: nao faz nada. Nunca lanca.
 */
export function stopRealtimeTest(opts: DiscordGpuBoostOptions = {}): Promise<void> {
    const r = run;
    if (!r) return Promise.resolve();
    // marca o fim na hora: um inicio novo durante o desfazer espera (pendingStop) e nao ve este teste como em andamento
    run = null;
    r.aborted = true;
    const work = (async () => {
        try {
            await r.started;
            const out = await undoBoost(r.boosted, r.ask, opts, true);
            for (const t of out.stale) log.warn(`${PREFIX}: ${who(t)} → o processo mudou (reiniciou?); não desfiz nada nesse pid`);
            if (out.unchecked) log.warn(`${PREFIX}: não deu para conferir os processos do Discord; o tempo real fica até o Telinha abrir de novo`);
            // o que falhou ou nao deu para conferir continua salvo: o inicio do plugin tenta de novo
            saveRemove([...out.undone, ...out.stale].map(t => t.pid));
        } catch (e) {
            log.warn(`${PREFIX}: erro inesperado ao desfazer (${errorText(e)})`);
        }
    })();
    pendingStop = work;
    return work;
}

/**
 * Inicio do plugin: o renderer recarregou no meio de um teste (o REALTIME do Discord continua ligado e o Telinha perdeu a
 * conta). Desfaz o que ficou em sessionStorage nos pids que ainda sao do Discord e limpa a lista. `ask` e o "high" do main;
 * o "restore" logo depois (core/captureBoost.ts) leva para a classe de antes. Uma linha no log. Nunca lanca.
 */
export async function recoverDiscordGpuBoost(ask: () => Promise<GpuPriorityReport | null>, opts: DiscordGpuBoostOptions = {}): Promise<void> {
    try {
        if (run) return;
        const saved = readSaved();
        if (!saved.length) return;
        const out = await undoBoost(saved, ask, opts, false);
        if (out.unchecked) {
            log.warn(`${PREFIX}: o Telinha recarregou com o tempo real pedido em ${saved.length} processo(s), mas não deu para conferir os processos do Discord; tento de novo no próximo início`);
            return;
        }
        saveRemove([...out.undone, ...out.stale].map(t => t.pid));
        const list = (l: ProcessRef[]) => l.map(who).join(", ");
        log.info(`${PREFIX}: o Telinha recarregou com o tempo real pedido: desfeito em ${out.undone.length ? list(out.undone) : "nenhum"}`
            + `${out.stale.length ? `; pulei ${list(out.stale)} (já não é o mesmo processo do Discord)` : ""}`
            + `${out.failed.length ? `; falhou em ${list(out.failed)} (tento de novo no próximo início)` : ""}`);
    } catch (e) {
        log.warn(`${PREFIX}: erro inesperado ao recuperar depois do reload (${errorText(e)})`);
    }
}

/** So para testes: esquece o teste em andamento. */
export function resetDiscordGpuBoostForTests() {
    run = null;
    pendingStop = Promise.resolve();
}

// #endregion
