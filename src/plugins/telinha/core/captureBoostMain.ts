/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts.
//
// A live com um jogo que usa a placa de video toda (experimental; o lado do renderer e o core/captureBoost.ts):
//
// "Captura pela placa de vídeo": o recurso WebRtcAllowWgcUsingTexture do Chromium, que deixa cada quadro da captura na
// placa de video em vez de copia-lo para o processador com um Map que espera atras do jogo. So vale a partir da partida do
// Discord: quem liga e o loader do add-on (addon/loader/main.js → applyCaptureFlags), que le o
// %APPDATA%\Telinha\capture-flags.json antes do app ficar pronto e publica o que fez em globalThis.__TelinhaAddon.capture.
// Aqui so se grava o arquivo (para a proxima partida) e se le o que o loader fez nesta.
//
// "Prioridade da captura na placa de vídeo": enquanto transmite, o processo principal do Discord (onde o Chromium copia
// cada quadro da captura) e o da GPU (onde converte e codifica) passam para a classe HIGH do agendador da placa de video,
// pelo telinha-audio.exe --gpu-priority (D3DKMTSetProcessSchedulingPriorityClass). Funciona sem administrador (medido em
// 01/11/2026 no Windows 11, nivel de integridade medio: HIGH num outro processo do mesmo usuario e aceito). Nunca
// REALTIME: com o HAGS ligado pode travar o encoder NVENC (o helper recusa). Quando o Windows recusa, so fica no log e na
// pagina do plugin ("não foi possível (precisa de administrador)"); nunca pede elevacao.
// Ao parar a transmissao cada processo volta para a classe que tinha (normalmente NORMAL): o ganho so importa durante a
// captura, e o Discord em HIGH depois disso so disputaria a placa com o jogo (a interface, e o video de quem voce assiste)
// sem ganho nenhum. A classe tambem some quando o Discord fecha.
//
// Nada roda no carregamento do modulo.

import { type ChildProcessByStdio, spawn } from "child_process";
import { app } from "electron";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { release } from "os";
import { isAbsolute } from "path";
import type { Readable } from "stream";

import { helperPath, SCREEN_AUDIO_HELPER, spawnErrorReason } from "./audio/screenAudioMain";

/** Windows 11 24H2: o Chromium so captura a tela pelo WGC (e so ha esse caminho) a partir deste build. */
export const GPU_CAPTURE_MIN_BUILD = 26100;

/** O que a opcao "Captura pela placa de vídeo" faz neste PC e nesta partida do Discord. */
export interface GpuCaptureStatus {
    /** o loader do add-on desta partida sabe ligar a opcao (false: build do fork, loader antigo ou --vanilla) */
    loader: boolean;
    /** build do Windows (0 = nao e Windows) */
    build: number;
    /** Windows 11 24H2 ou mais novo: a opcao pode fazer efeito aqui */
    supported: boolean;
    /** o capture-flags.json pede a captura pela placa de video agora (vale na proxima partida) */
    saved: boolean;
    /** o arquivo pedia a captura quando o Discord abriu */
    requested: boolean;
    /** o recurso estava no enable-features quando o app ficou pronto; null = nao foi pedido */
    applied: boolean | null;
    /** o que o loader anotou (arquivo ignorado, Windows antigo, enable-features trocado...), para o diagnostico */
    loaderNote: string | null;
    /** o enable-features final (diagnostico) */
    enableFeatures: string | null;
    /** a ultima gravacao da opcao falhou (em pt-BR) */
    saveError: string | null;
}

interface LoaderCapture {
    file: string;
    wgcTexture?: unknown;
    applied?: unknown;
    reason?: unknown;
    enableFeatures?: unknown;
}

/** O que o loader desta partida publicou (null: sem loader do add-on, ou um loader antigo). */
function loaderCapture(): LoaderCapture | null {
    const capture = (globalThis as { __TelinhaAddon?: { capture?: unknown; }; }).__TelinhaAddon?.capture as LoaderCapture | null | undefined;
    return capture && typeof capture.file === "string" && isAbsolute(capture.file) ? capture : null;
}

function windowsBuild(): number {
    if (process.platform !== "win32") return 0;
    return Number(release().split(".")[2]) || 0;
}

const text = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);

function savedIn(file: string): boolean {
    try {
        return JSON.parse(readFileSync(file, "utf8"))?.wgcTexture === true;
    } catch {
        return false;
    }
}

export function gpuCaptureStatusMain(saveError: string | null = null): GpuCaptureStatus {
    const capture = loaderCapture();
    const build = windowsBuild();
    return {
        loader: !!capture,
        build,
        supported: build >= GPU_CAPTURE_MIN_BUILD,
        saved: capture ? savedIn(capture.file) : false,
        requested: capture?.wgcTexture === true,
        applied: typeof capture?.applied === "boolean" ? capture.applied : null,
        loaderNote: text(capture?.reason, 300),
        enableFeatures: text(capture?.enableFeatures, 500),
        saveError
    };
}

/**
 * Grava a opcao para a proxima partida do Discord (arquivo temporario + rename: o loader nunca le um arquivo pela
 * metade). Sem o loader do add-on nao grava nada. Nunca lanca: o erro volta em saveError.
 */
export function setGpuCaptureMain(on: boolean): GpuCaptureStatus {
    const capture = loaderCapture();
    if (!capture) return gpuCaptureStatusMain();
    const tmp = `${capture.file}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify({ format: 1, wgcTexture: on === true }) + "\n");
        renameSync(tmp, capture.file);
        return gpuCaptureStatusMain();
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch { }
        return gpuCaptureStatusMain(`não consegui salvar a opção (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
    }
}

// #region prioridade na placa de video

/** "high": inicio da transmissao; "restore": cada processo volta para a classe que tinha antes do "high". */
export type GpuPriorityMode = "high" | "restore";

/** Um processo do Discord e o que o helper fez nele. */
export interface GpuPriorityTarget {
    pid: number;
    /** "Discord" = o processo principal (a copia da captura); "GPU" = o processo da GPU (conversao e codificacao) */
    role: "Discord" | "GPU";
    /** classe antes e depois (IDLE, BELOW_NORMAL, NORMAL, ABOVE_NORMAL, HIGH); null = nao mexeu */
    before: string | null;
    after: string | null;
    /** a linha de erro do helper ("open 0x80070005 Acesso negado."), ou o que faltou */
    error: string | null;
}

export interface GpuPriorityReport {
    mode: GpuPriorityMode;
    /** todos os processos ficaram como pedido (sem nada a voltar tambem conta) */
    ok: boolean;
    /** quantos ficaram como pedido */
    done: number;
    targets: GpuPriorityTarget[];
    /** agendamento da placa por hardware (HAGS), segundo o helper; null = desconhecido */
    hags: "on" | "off" | null;
    /** o Windows recusou por acesso/privilegio: so com administrador (o Telinha nunca pede) */
    adminNeeded: boolean;
    /** por que nada foi feito, em pt-BR (Windows, ajudante ausente/bloqueado/antigo...) */
    reason: string | null;
    /** processos que seguem em HIGH por causa do Telinha (o "restore" volta estes) */
    raised: number;
}

type Role = GpuPriorityTarget["role"];

interface HelperAnswer {
    lines: string[];
    code: number | null;
    /** o helper nem rodou ou nao respondeu */
    reason: string | null;
}

const PRIORITY_TIMEOUT_MS = 5000;
const OUTPUT_MAX_CHARS = 8 * 1024;
const HIGH = "HIGH";
/** as classes abaixo de HIGH: so estas sao lembradas para voltar (um processo ja em HIGH fica como estava) */
const BELOW_HIGH = new Set(["IDLE", "BELOW_NORMAL", "NORMAL", "ABOVE_NORMAL"]);
const HAGS_RE = /^hags (on|off|unknown)$/;
const OK_RE = /^ok pid=(\d+) before=(\S+) after=(\S+)$/;
const TARGET_ERROR_RE = /^error (\w+) (0x[0-9A-Fa-f]{8}) pid=(\d+)\s*(.*)$/;
const GENERAL_ERROR_RE = /^error (\S+) (0x[0-9A-Fa-f]{8})/;
/** OpenProcess negado, STATUS_ACCESS_DENIED, STATUS_PRIVILEGE_NOT_HELD: o Windows quer administrador */
const ADMIN_ERROR_RE = /^(?:open|get|set) 0x(?:80070005|C0000022|C0000061)\b/i;

/** pid → a classe que o processo tinha antes do HIGH, e qual processo e */
const raised = new Map<number, { before: string; role: Role; }>();
/** um pedido por vez ao helper: "high" e "restore" nunca se cruzam */
let queue: Promise<unknown> = Promise.resolve();

/** O processo principal do Discord (este) e o da GPU (app.getAppMetrics). */
function discordTargets(): { pid: number; role: Role; }[] {
    const targets: { pid: number; role: Role; }[] = [{ pid: process.pid, role: "Discord" }];
    try {
        for (const m of app.getAppMetrics())
            if (m?.type === "GPU" && Number.isInteger(m.pid) && m.pid > 0 && m.pid !== process.pid) targets.push({ pid: m.pid, role: "GPU" });
    } catch { }
    return targets;
}

function helperProblem(): string | null {
    if (process.platform !== "win32") return "só funciona no Windows";
    if (!existsSync(helperPath())) return `o ajudante do Telinha (${SCREEN_AUDIO_HELPER}) não foi instalado`;
    return null;
}

/** Roda `telinha-audio.exe --gpu-priority <pids> --class <cls>` e junta as linhas (stdout e stderr). Nunca rejeita. */
function runHelper(pids: number[], cls: string): Promise<HelperAnswer> {
    return new Promise(resolve => {
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
            child = spawn(helperPath(), ["--gpu-priority", pids.join(","), "--class", cls], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            resolve({ lines: [], code: null, reason: spawnErrorReason(e as NodeJS.ErrnoException) });
            return;
        }
        let output = "";
        let settled = false;
        const done = (answer: HelperAnswer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(answer);
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch { }
            done({ lines: [], code: null, reason: "o ajudante do Telinha não respondeu" });
        }, PRIORITY_TIMEOUT_MS);
        const collect = (b: Buffer) => {
            if (output.length < OUTPUT_MAX_CHARS) output += b.toString("utf8");
        };
        // sem estes handlers um erro num pipe viraria excecao nao tratada no processo main do Discord
        const ignore = () => { };
        child.on("error", e => done({ lines: [], code: null, reason: spawnErrorReason(e) }));
        child.stdout.on("error", ignore);
        child.stderr.on("error", ignore);
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("close", code => done({ lines: output.split(/\r?\n/).map(l => l.trim()).filter(Boolean), code, reason: null }));
    });
}

function summarize(mode: GpuPriorityMode, targets: GpuPriorityTarget[], hags: GpuPriorityReport["hags"], reason: string | null): GpuPriorityReport {
    const done = targets.filter(t => !t.error && t.after && (mode !== "high" || t.after === HIGH)).length;
    return {
        mode, ok: !reason && done === targets.length, done, targets, hags, reason,
        adminNeeded: targets.some(t => !!t.error && ADMIN_ERROR_RE.test(t.error)),
        raised: raised.size
    };
}

/** As linhas do helper → o que aconteceu com cada processo. */
function readAnswer(mode: GpuPriorityMode, wanted: { pid: number; role: Role; }[], answer: HelperAnswer): GpuPriorityReport {
    const targets = wanted.map((t): GpuPriorityTarget => ({ ...t, before: null, after: null, error: null }));
    const byPid = new Map(targets.map(t => [t.pid, t]));
    let hags: GpuPriorityReport["hags"] = null;
    let { reason } = answer;
    for (const line of answer.lines) {
        const hagsLine = HAGS_RE.exec(line);
        const ok = OK_RE.exec(line);
        const failed = TARGET_ERROR_RE.exec(line);
        const general = GENERAL_ERROR_RE.exec(line);
        if (hagsLine) {
            hags = hagsLine[1] === "unknown" ? null : hagsLine[1] as "on" | "off";
        } else if (ok) {
            const t = byPid.get(Number(ok[1]));
            if (t) [t.before, t.after] = [ok[2], ok[3]];
        } else if (failed) {
            const t = byPid.get(Number(failed[3]));
            if (t) t.error = `${failed[1]} ${failed[2]}${failed[4] ? ` ${failed[4]}` : ""}`.slice(0, 200);
        } else if (general) {
            reason ??= general[1] === "usage" ? "o ajudante do Telinha é de uma versão antiga" : `o Windows não tem a função (${general[2]})`;
        }
    }
    if (!reason && answer.code !== 0 && answer.code !== 6) reason = `o ajudante do Telinha fechou com o código ${answer.code}`;
    if (!reason) for (const t of targets) if (!t.after && !t.error) t.error = "sem resposta do ajudante";
    return summarize(mode, targets, hags, reason);
}

async function raise(): Promise<GpuPriorityReport> {
    const wanted = discordTargets();
    const problem = helperProblem();
    const answer = problem ? { lines: [], code: null, reason: problem } : await runHelper(wanted.map(t => t.pid), "high");
    const report = readAnswer("high", wanted, answer);
    for (const t of report.targets)
        if (t.after === HIGH && t.before && BELOW_HIGH.has(t.before) && !raised.has(t.pid)) raised.set(t.pid, { before: t.before, role: t.role });
    report.raised = raised.size;
    return report;
}

async function restore(): Promise<GpuPriorityReport> {
    // esquecidos mesmo se a volta falhar: o processo pode ter fechado (a GPU reinicia sozinha), e nada mais ha a fazer
    const groups = new Map<string, { pid: number; role: Role; }[]>();
    for (const [pid, { before, role }] of raised) groups.set(before, [...(groups.get(before) ?? []), { pid, role }]);
    raised.clear();
    const problem = groups.size ? helperProblem() : null;
    const targets: GpuPriorityTarget[] = [];
    let hags: GpuPriorityReport["hags"] = null;
    let reason: string | null = null;
    for (const [before, wanted] of groups) {
        const answer = problem ? { lines: [], code: null, reason: problem } : await runHelper(wanted.map(t => t.pid), before.toLowerCase());
        const report = readAnswer("restore", wanted, answer);
        targets.push(...report.targets);
        hags ??= report.hags;
        reason ??= report.reason;
    }
    return summarize("restore", targets, hags, reason);
}

/**
 * "high": o Discord (principal + GPU) em HIGH na placa de video; "restore": volta o que o "high" mudou (sem nada a voltar,
 * nao roda o helper). Um pedido por vez. Nunca rejeita.
 */
export function setGpuPriorityMain(mode: GpuPriorityMode): Promise<GpuPriorityReport> {
    // raise/restore nunca rejeitam (o helper que falha vira um relatorio), entao a fila nunca trava
    const next = queue.then(() => (mode === "high" ? raise() : restore()));
    queue = next;
    return next;
}

/** So para testes: esquece o que foi subido. */
export function resetGpuPriorityForTests() {
    raised.clear();
    queue = Promise.resolve();
}

// #endregion
