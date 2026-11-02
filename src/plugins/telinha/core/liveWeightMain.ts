/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts.
//
// "Peso da live": enquanto transmite, quanto da placa de video e do processador a live custa e quanto o jogo usa, para
// toda otimizacao poder ser provada com numeros. So mede: nada aqui muda a captura, o envio ou a qualidade automatica.
//
// A fonte sao os contadores de desempenho da placa de video do Windows (os numeros do Gerenciador de Tarefas), lidos pelo
// typeperf.exe do proprio Windows (assinado, sem administrador, sem janela: windowsHide). Uma execucao por vez, com
// `-si 5`: o contador e de taxa (cada valor e a media do intervalo desde a amostra anterior), entao 5 s da a mesma media
// de 10 s das linhas do envio que 2 s, pela metade do custo. Medido em 02/11/2026 (Windows 11, 16 threads): o typeperf
// gasta ~1,4% de UM nucleo com -si 5 (3,8% com -si 2), ~0,1% do processador todo, e ~0,9 s de processador para
// comecar (expandir os curingas). Abaixo do 0,5% do processador todo: sempre ligado, sem opcao.
//
// O typeperf expande os curingas (*) so ao comecar: um processo que nasce depois (o jogo aberto com a live no ar, o
// processo da GPU do Discord que reiniciou) nao aparece ate a proxima execucao. Cada execucao vai ate SAMPLES_PER_RUN
// amostras (`-sc`) e outra comeca na hora; antes disso, recomeca quando falta o processo da GPU do Discord nas colunas ou
// quando nenhum jogo aparece (no maximo uma vez a cada EARLY_REFRESH_MS: cada comeco custa ~0,9 s de processador).
//
// Sem processos orfaos: (1) o libuv do Node poe todo filho nao "detached" num job object do Windows com
// KILL_ON_JOB_CLOSE: quando o processo main do Discord termina, ate num travamento, o Windows encerra o typeperf
// (conferido em 02/11/2026: o filho morre junto com o pai morto a forca); (2) o "exit" do processo mata tambem; (3) o
// renderer que para de ler (recarregou ou travou) encerra a medicao em IDLE_STOP_MS; (4) cada execucao tem fim (-sc).
//
// Falha mansa: sem typeperf, ou com os contadores recusados (Windows sem eles, em outra lingua sem o nome em ingles...),
// a medicao fica "indisponível" com o motivo, sem tentar de novo nesta transmissao; o renderer escreve uma linha so.
//
// Nada roda no carregamento do modulo.

import { type ChildProcessByStdio, spawn } from "child_process";
import { app } from "electron";
import { availableParallelism, cpus } from "os";
import { join } from "path";
import type { Readable } from "stream";

import { aggregate, consoleText, type CounterColumn, type CounterSample, type EngineLoad, enginePids, isHeaderLine, parseDataLine, parseHeader } from "./liveWeightCounters";

/** Os contadores, pelo nome em ingles (o PDH aceita o nome em ingles em qualquer lingua do Windows; conferido no pt-BR). */
export const LIVE_WEIGHT_COUNTERS = ["\\GPU Engine(*)\\Utilization Percentage", "\\GPU Process Memory(*)\\Dedicated Usage"] as const;
/** segundos entre amostras */
export const SAMPLE_INTERVAL_S = 5;
/** amostras por execucao do typeperf (5 min): depois, outra execucao ve os processos novos */
export const SAMPLES_PER_RUN = 60;
/** recomeco antecipado (processo novo que o typeperf nao ve): no maximo um a cada isto */
export const EARLY_REFRESH_MS = 60_000;
/** o renderer le a cada ~10 s; sem leitura por isto, a medicao para (renderer recarregou ou travou) */
export const IDLE_STOP_MS = 35_000;
/** amostras guardadas entre duas leituras (o resto, mais antigo, sai) */
const MAX_SAMPLES = 24;
/** o cabecalho tem ~700 colunas (~100 KB); acima disto a linha e descartada */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** abaixo disto de 3D, nenhum processo de fora do Discord conta como jogo */
export const GAME_MIN_3D = 1;
const NAME_TIMEOUT_MS = 4000;
const KILL_GRACE_MS = 1000;

export type LiveWeightState = "measuring" | "off" | "unavailable";

/** O que o renderer recebe a cada leitura (a media desde a leitura anterior). */
export interface LiveWeightReport {
    state: LiveWeightState;
    /** "unavailable": por que nao ha numeros (pt-BR) */
    reason: string | null;
    /** amostras do typeperf nesta janela (0 = ainda comecando, ou recomecando) */
    samples: number;
    /** a janela, em ms (desde a leitura anterior ou o comeco) */
    windowMs: number;
    /** a placa de video usada pelo Discord (todos os processos dele), por tipo de motor; null sem amostras */
    discord: EngineLoad | null;
    /** o processador usado pelo Discord, em % do processador todo (como o Gerenciador de Tarefas); null = sem leitura */
    discordCpu: number | null;
    /** memoria dedicada da placa usada pelo Discord, em MB; null = sem o contador */
    discordGpuMemoryMb: number | null;
    /** o processo de fora do Discord que mais usou o 3D da placa (o jogo); null = nenhum acima de GAME_MIN_3D */
    game: { pid: number; name: string | null; load3D: number; } | null;
    /** a placa toda, por tipo de motor; null sem amostras */
    total: EngineLoad | null;
    /** execucoes do typeperf desde o comeco desta medicao (diagnostico) */
    runs: number;
}

export interface LiveWeightStart {
    ok: boolean;
    reason: string | null;
}

interface Run {
    child: ChildProcessByStdio<null, Readable, Readable>;
    startedAt: number;
    columns: (CounterColumn | null)[] | null;
    pending: string;
    gotData: boolean;
    /** as primeiras linhas de texto fora do CSV ("Saindo, aguarde...", o erro do typeperf quando ele nao mede) */
    notes: string[];
    /** encerrado por nos para recomecar */
    refreshing: boolean;
}

let wanted = false;
let run: Run | null = null;
let runs = 0;
let samples: CounterSample[] = [];
let failure: string | null = null;
let lastReadAt = 0;
let windowStart = 0;
let lastEarlyRefresh = -Infinity;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let exitHookInstalled = false;
/** pid → segundos de processador acumulados na leitura anterior (cumulativeCPUUsage) */
let cpuBase = new Map<number, number>();
/** pid → nome do executavel (null = nao achou); esquecido a cada medicao nova (os pids voltam a ser usados) */
const names = new Map<number, string | null>();
let typeperfOverride: string | null = null;

/** So para testes: outro executavel no lugar do typeperf.exe do Windows. */
export function setTypeperfPathForTests(path: string | null) {
    typeperfOverride = path;
}

/** Um executavel do proprio Windows (System32), pelo SystemRoot (sem ele, C:\Windows). */
function system32(exe: string) {
    return join(process.env.SystemRoot || "C:\\Windows", "System32", exe);
}

function typeperfPath() {
    return typeperfOverride ?? system32("typeperf.exe");
}

/** kill() sem deixar escapar nada (o processo pode ja ter terminado). */
function killQuietly(child: { kill(): boolean; }) {
    try {
        child.kill();
    } catch { }
}

function spawnReason(e: NodeJS.ErrnoException) {
    if (e?.code === "ENOENT") return "o typeperf.exe do Windows não foi encontrado";
    if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "UNKNOWN") return "o Windows ou o antivírus bloqueou o typeperf.exe";
    return `não foi possível abrir o typeperf.exe: ${[e?.code, e?.message].filter(Boolean).join(" ")}`;
}

function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once("exit", () => {
        const r = run;
        run = null;
        wanted = false;
        if (r) killQuietly(r.child);
    });
}

function cores() {
    try {
        return Math.max(1, availableParallelism());
    } catch {
        return Math.max(1, cpus().length || 1);
    }
}

/** Os processos do Discord (app.getAppMetrics: principal, GPU, renderers, utilitarios) e o processador de cada um. */
function discordMetrics(): { pids: Set<number>; cpu: Map<number, number>; percent: number; gpuPid: number | null; } {
    const pids = new Set<number>([process.pid]);
    const cpu = new Map<number, number>();
    let percent = 0;
    let gpuPid: number | null = null;
    try {
        for (const m of app.getAppMetrics()) {
            if (!Number.isInteger(m?.pid) || m.pid <= 0) continue;
            pids.add(m.pid);
            if (m.type === "GPU") gpuPid = m.pid;
            const cumulative = Number(m.cpu?.cumulativeCPUUsage);
            if (Number.isFinite(cumulative)) cpu.set(m.pid, cumulative);
            const p = Number(m.cpu?.percentCPUUsage);
            if (Number.isFinite(p)) percent += p;
        }
    } catch { }
    return { pids, cpu, percent, gpuPid };
}

/**
 * % do processador todo usado pelo Discord desde a leitura anterior (cumulativeCPUUsage: segundos desde que cada processo
 * nasceu; o que nasceu na janela conta inteiro). Sem cumulativeCPUUsage (Electron antigo): o percentCPUUsage, que e de
 * UM nucleo, dividido pelos nucleos. null = nada lido.
 */
function cpuPercent(m: ReturnType<typeof discordMetrics>, elapsedMs: number): number | null {
    const n = cores();
    let value: number | null = null;
    if (m.cpu.size && cpuBase.size && elapsedMs > 0) {
        let seconds = 0;
        for (const [pid, now] of m.cpu) seconds += Math.max(0, now - (cpuBase.get(pid) ?? 0));
        value = Math.min(100, seconds / (elapsedMs / 1000) / n * 100);
    } else if (!m.cpu.size && m.percent > 0) {
        value = Math.min(100, m.percent / n);
    }
    cpuBase = m.cpu;
    return value;
}

/** O nome do executavel de um pid (tasklist do Windows; cacheado). Sem o titulo da janela. null = nao achou. */
function processName(pid: number): Promise<string | null> {
    if (names.has(pid)) return Promise.resolve(names.get(pid) as string | null);
    return new Promise(resolve => {
        const done = (name: string | null) => {
            names.set(pid, name);
            resolve(name);
        };
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
            child = spawn(system32("tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
                windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"]
            });
        } catch {
            done(null);
            return;
        }
        let out = "";
        let settled = false;
        const finish = (name: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            done(name);
        };
        const timer = setTimeout(() => {
            killQuietly(child);
            finish(null);
        }, NAME_TIMEOUT_MS);
        timer.unref?.();
        child.on("error", () => finish(null));
        child.stdout.on("error", () => { });
        child.stderr.on("error", () => { });
        child.stderr.resume();
        child.stdout.on("data", (b: Buffer) => {
            if (out.length < 4096) out += b.toString("latin1");
        });
        child.on("close", () => {
            // "jogo.exe","1234","Console","1","123.456 K"; sem o processo, uma mensagem sem aspas
            const m = /^"([^"]{1,128})","(\d+)"/m.exec(out);
            finish(m && Number(m[2]) === pid ? consoleText(m[1]) : null);
        });
    });
}

function onLine(r: Run, raw: string) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;
    if (isHeaderLine(line)) {
        r.columns = parseHeader(line);
        return;
    }
    const sample = r.columns ? parseDataLine(line, r.columns) : null;
    if (sample) {
        r.gotData = true;
        samples.push(sample);
        if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
        return;
    }
    if (!line.startsWith("\"") && r.notes.length < 5) r.notes.push(consoleText(line).slice(0, 200));
}

/** O que o typeperf disse ao falhar: a linha de erro ("Erro: nenhum contador válido."), nao o "Saindo, aguarde...". */
function note(r: Run): string | null {
    return r.notes.find(l => l.includes(":")) ?? r.notes[0] ?? null;
}

function stopRun(r: Run) {
    killQuietly(r.child);
}

function spawnRun() {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
        child = spawn(typeperfPath(), [...LIVE_WEIGHT_COUNTERS, "-si", String(SAMPLE_INTERVAL_S), "-sc", String(SAMPLES_PER_RUN)], {
            windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"]
        });
    } catch (e) {
        failure = spawnReason(e as NodeJS.ErrnoException);
        wanted = false;
        return;
    }
    runs++;
    const r: Run = { child, startedAt: Date.now(), columns: null, pending: "", gotData: false, notes: [], refreshing: false };
    run = r;
    // sem estes handlers um erro num pipe viraria excecao nao tratada no processo main do Discord
    child.stdout.on("error", () => { });
    child.stderr.on("error", () => { });
    child.stderr.resume();
    child.stdout.on("data", (b: Buffer) => {
        r.pending += b.toString("latin1");
        let nl: number;
        while ((nl = r.pending.indexOf("\n")) >= 0) {
            const line = r.pending.slice(0, nl);
            r.pending = r.pending.slice(nl + 1);
            onLine(r, line);
        }
        if (r.pending.length > MAX_LINE_CHARS) r.pending = "";
    });
    let ended = false;
    const end = (why: string | null) => {
        if (ended) return;
        ended = true;
        // parado (stopLiveWeightMain, o "exit") ja tirou a execucao: nada a fazer
        if (run !== r) return;
        run = null;
        // a execucao terminou depois de medir (fim do -sc, ou recomeco): a proxima comeca ja
        if (r.gotData || r.refreshing) {
            spawnRun();
            return;
        }
        failure = why ?? note(r) ?? "o typeperf.exe não mediu nada";
        wanted = false;
    };
    child.on("error", e => {
        end(spawnReason(e));
        stopRun(r);
    });
    child.on("close", code => {
        const text = note(r);
        end(code === 0 || code === null ? null : text ? `${text} (código ${code})` : `o typeperf.exe saiu com o código ${code}`);
    });
}

function stopIdleTimer() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
}

/**
 * Comeca a medir (a transmissao comecou). Ja medindo: continua (trocar de fonte nao recomeca). Nunca lanca. ok false =
 * sem numeros nesta transmissao, com o motivo.
 */
export function startLiveWeightMain(): LiveWeightStart {
    if (process.platform !== "win32") return { ok: false, reason: "só funciona no Windows" };
    lastReadAt = Date.now();
    if (wanted && run) return { ok: true, reason: null };
    stopLiveWeightMain();
    installExitHook();
    wanted = true;
    failure = null;
    runs = 0;
    samples = [];
    names.clear();
    windowStart = Date.now();
    lastEarlyRefresh = Date.now();
    cpuPercent(discordMetrics(), 0);
    spawnRun();
    if (!wanted) return { ok: false, reason: failure };
    idleTimer = setInterval(() => {
        if (Date.now() - lastReadAt > IDLE_STOP_MS) stopLiveWeightMain();
    }, 5000);
    idleTimer.unref?.();
    return { ok: true, reason: null };
}

/** Recomeca a execucao do typeperf agora (processo novo que ele nao ve). */
function refreshRun(r: Run) {
    r.refreshing = true;
    lastEarlyRefresh = Date.now();
    stopRun(r);
}

/** A media desde a leitura anterior (as amostras saem). Nunca rejeita. */
export async function readLiveWeightMain(): Promise<LiveWeightReport> {
    const now = Date.now();
    const windowMs = Math.max(0, now - windowStart);
    lastReadAt = now;
    windowStart = now;
    const base: LiveWeightReport = {
        state: wanted ? "measuring" : failure ? "unavailable" : "off",
        reason: wanted ? null : failure, samples: 0, windowMs, discord: null, discordCpu: null, discordGpuMemoryMb: null, game: null, total: null, runs
    };
    if (!wanted) return base;
    const metrics = discordMetrics();
    const discordCpu = cpuPercent(metrics, windowMs);
    const taken = samples;
    samples = [];
    const w = aggregate(taken, metrics.pids);
    const r = run;
    // o processo da GPU do Discord (ou o jogo) nasceu depois desta execucao do typeperf: recomeca para ele entrar
    if (r?.columns && r.gotData && now - lastEarlyRefresh >= EARLY_REFRESH_MS) {
        const missingGpu = metrics.gpuPid != null && !enginePids(r.columns).has(metrics.gpuPid);
        if (missingGpu || (w.samples && w.top3D < GAME_MIN_3D)) refreshRun(r);
    }
    if (!w.samples) return { ...base, discordCpu };
    const game = w.topPid != null && w.top3D >= GAME_MIN_3D ? { pid: w.topPid, name: await processName(w.topPid), load3D: w.top3D } : null;
    return {
        ...base,
        samples: w.samples,
        discord: w.discord,
        discordCpu,
        discordGpuMemoryMb: w.discordMemory == null ? null : w.discordMemory / (1024 * 1024),
        game,
        total: w.total,
        runs
    };
}

/** Para de medir (a transmissao acabou, ou o plugin parou). Seguro de chamar a qualquer momento. */
export function stopLiveWeightMain() {
    wanted = false;
    stopIdleTimer();
    samples = [];
    const r = run;
    run = null;
    if (!r) return;
    stopRun(r);
    // kill() e TerminateProcess no Windows; a segunda tentativa so cobre um kill que falhou de passagem
    const timer = setTimeout(() => {
        if (r.child.exitCode === null && r.child.signalCode === null) stopRun(r);
    }, KILL_GRACE_MS);
    timer.unref?.();
}

/** So para testes: o pid do typeperf em execucao (null = nenhum) e o estado esquecido. */
export function liveWeightRunPidForTests(): number | null {
    return run?.child.pid ?? null;
}

export function resetLiveWeightForTests() {
    stopLiveWeightMain();
    failure = null;
    runs = 0;
    cpuBase = new Map();
    names.clear();
    lastEarlyRefresh = -Infinity;
}
