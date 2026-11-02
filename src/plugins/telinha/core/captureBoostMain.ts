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
// "Prioridade da captura na placa de vídeo": enquanto transmite, o processo principal do Discord (onde o Chromium captura
// a tela e copia cada quadro) e o da GPU (onde converte e codifica) sobem para a classe HIGH do agendador da placa de
// video, pelo telinha-audio.exe --gpu-priority --raise (D3DKMTSetProcessSchedulingPriorityClass). Funciona sem
// administrador (medido em 01/11/2026 no Windows 11, nivel de integridade medio: HIGH num outro processo do mesmo usuario
// e aceito). O Telinha nunca pede REALTIME (com o HAGS ligado pode travar o encoder NVENC; o helper recusa) e nunca
// abaixa: o processo da GPU do Discord pode ja estar em REALTIME, posto pelo proprio Discord, e fica assim (02/11/2026,
// RTX 3070: baixado para HIGH, o NVENC foi de ~7 ms para ~400 ms por quadro com um jogo pesado). Quando o Windows recusa,
// so fica no log e na pagina do plugin ("não foi possível (precisa de administrador)"); nunca pede elevacao.
// Ao parar a transmissao volta so o que o Telinha subiu, para a classe que tinha (normalmente NORMAL), e so se ainda
// estiver em HIGH (--if-class high: se outro mudou a classe depois, fica): o ganho so importa durante a captura, e o
// Discord em HIGH depois disso so disputaria a placa com o jogo (a interface, e o video de quem voce assiste) sem ganho
// nenhum. A classe tambem some quando o Discord fecha.
//
// Por que estes dois processos (conferido no codigo do Chromium 152, branch 7977): o getDisplayMedia nao passa pelo
// processo utilitario "Video Capture", que so atende cameras (VideoCaptureProviderSwitcher manda para ele so o
// DEVICE_VIDEO_CAPTURE). A captura da tela e da janela roda no processo principal (InProcessVideoCaptureProvider →
// DesktopCaptureDevice numa thread "desktopCaptureThread"), e e la que o WGC cria o seu D3D11 device e faz a copia e o
// Map de cada quadro; com o WebRtcAllowWgcUsingTexture o quadro vai como textura compartilhada para o processo da GPU.
//
// Nada roda no carregamento do modulo.

import { type ChildProcessByStdio, spawn } from "child_process";
import { app } from "electron";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { release } from "os";
import { isAbsolute } from "path";
import type { Readable } from "stream";

import { helperPath, SCREEN_AUDIO_HELPER, spawnErrorReason } from "./audio/screenAudioMain";

/** como as mensagens chamam o telinha-audio.exe neste modo (o de audio o chama de "o ajudante de áudio") */
const HELPER_NAME = "o ajudante do Telinha";

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

/** "high": inicio da transmissao; "restore": o que o "high" subiu volta para a classe que tinha. */
export type GpuPriorityMode = "high" | "restore";

/** Um processo do Discord e o que o helper fez nele. */
export interface GpuPriorityTarget {
    pid: number;
    /** "Discord" = o processo principal (a captura e a copia de cada quadro); "GPU" = o processo da GPU (conversao e codificacao) */
    role: "Discord" | "GPU";
    /** classe antes e depois (IDLE, BELOW_NORMAL, NORMAL, ABOVE_NORMAL, HIGH, REALTIME); null = sem resposta */
    before: string | null;
    after: string | null;
    /**
     * deixado como estava (before = after = a classe que tinha): no "high", ja estava em HIGH ou acima (o REALTIME que o
     * Discord da ao processo da GPU); na volta, ja nao estava na classe que o Telinha pos, ou a subida nem mexeu nele
     */
    kept: boolean;
    /** a linha de erro do helper ("open 0x80070005 Acesso negado.", "gone ..." = o processo terminou), ou o que faltou */
    error: string | null;
}

export interface GpuPriorityReport {
    mode: GpuPriorityMode;
    /** todos os processos ficaram como pedido (sem nada a voltar, ou o processo que ja terminou, tambem contam) */
    ok: boolean;
    /** quantos ficaram como pedido */
    done: number;
    /** na volta, tambem os que a subida deixou como estavam (kept), para o log citar todos */
    targets: GpuPriorityTarget[];
    /** agendamento da placa por hardware (HAGS), segundo o helper; null = desconhecido */
    hags: "on" | "off" | null;
    /** o Windows recusou por acesso/privilegio (talvez precise de administrador; o Telinha nunca pede) */
    refused: boolean;
    /** por que nada foi feito, em pt-BR (Windows, ajudante ausente/bloqueado/antigo, nao respondeu a tempo...) */
    reason: string | null;
    /** processos que seguem em HIGH por causa do Telinha (o proximo "restore" ou "high" tenta voltar estes) */
    raised: number;
    /** uma volta que falhou de novo do mesmo jeito: ja foi dita uma vez, nao precisa de outra linha no log */
    quiet: boolean;
    /** o que o main fez sozinho desde o ultimo relatorio (o processo da GPU reiniciou...), para o log */
    notes: string[];
}

type Role = GpuPriorityTarget["role"];

interface HelperAnswer {
    lines: string[];
    code: number | null;
    /** o helper nem rodou ou nao respondeu a tempo */
    reason: string | null;
}

/** Um processo que o Telinha subiu para HIGH e ainda nao voltou. */
interface Raised {
    /** a classe de antes, para onde ele volta */
    before: string;
    role: Role;
    /** a ultima volta falhou (e ja foi dita no log) */
    failed: boolean;
}

/** so ajusta e sai; fora do caminho da captura, entao pode esperar bem (antivirus examinando o exe na 1a vez) */
const PRIORITY_TIMEOUT_MS = 12_000;
const OUTPUT_MAX_CHARS = 8 * 1024;
/** o processo da GPU que caiu: o Chromium abre outro; espera ele aparecer no app.getAppMetrics() */
const GPU_RESTART_DELAY_MS = 2000;
const GPU_RESTART_TRIES = 3;
/** o processo novo pode nascer um pouco antes de o evento chegar ao JS */
const GPU_RESTART_SLACK_MS = 5000;
const HIGH = "HIGH";
/** as classes abaixo de HIGH: so estas sao lembradas para voltar (um processo ja em HIGH ou acima fica como estava) */
const BELOW_HIGH = new Set(["IDLE", "BELOW_NORMAL", "NORMAL", "ABOVE_NORMAL"]);
/** a subida nunca abaixa: o helper so muda quem esta abaixo de HIGH (REALTIME e HIGH ficam, com uma linha "keep") */
const RAISE_ONLY = ["--raise"];
/** a volta so muda quem ainda esta na classe que o Telinha pos (se o Discord mudou depois, fica) */
const IF_STILL_HIGH = ["--if-class", "high"];
const HAGS_RE = /^hags (on|off|unknown)$/;
const OK_RE = /^ok pid=(\d+) before=(\S+) after=(\S+)$/;
const KEEP_RE = /^keep pid=(\d+) class=(\S+)$/;
const TARGET_ERROR_RE = /^error (\w+) (0x[0-9A-Fa-f]{8}) pid=(\d+)\s*(.*)$/;
const GENERAL_ERROR_RE = /^error (\S+) (0x[0-9A-Fa-f]{8})/;
/** OpenProcess negado, STATUS_ACCESS_DENIED, STATUS_PRIVILEGE_NOT_HELD: o Windows recusou (talvez precise de administrador) */
const REFUSED_ERROR_RE = /^(?:open|get|set) 0x(?:80070005|C0000022|C0000061)\b/i;
/** o processo terminou ("gone"), ou o pid ja e de outro processo, fora da arvore do Discord ("tree"): nada a voltar */
const GONE_ERROR_RE = /^(?:gone|tree) /;

/** pid → o que o Telinha subiu para HIGH e ainda nao voltou */
const raised = new Map<number, Raised>();
/** pid → o que a ultima subida deixou como estava (ja em HIGH ou acima): nada a voltar, so entra no relatorio da volta */
const untouched = new Map<number, GpuPriorityTarget>();
/** a transmissao pediu HIGH e ainda nao pediu a volta (o processo da GPU que reinicia sobe de novo) */
let active = false;
/** o que o main fez sozinho, entregue no proximo relatorio (GpuPriorityReport.notes) */
const notes: string[] = [];
/** um pedido por vez ao helper: "high", "restore" e a GPU que reiniciou nunca se cruzam */
let queue: Promise<unknown> = Promise.resolve();
let watchingGpu = false;

/** Na fila, depois do que ja estava nela. `job` nunca rejeita (o helper que falha vira um relatorio), entao a fila nunca trava. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job);
    queue = next;
    return next;
}

/** O processo principal do Discord (este) e o da GPU (app.getAppMetrics). `created`: ProcessMetric.creationTime (NaN = sem). */
function discordTargets(): { pid: number; role: Role; created: number; }[] {
    const targets: { pid: number; role: Role; created: number; }[] = [{ pid: process.pid, role: "Discord", created: NaN }];
    try {
        for (const m of app.getAppMetrics())
            if (m?.type === "GPU" && Number.isInteger(m.pid) && m.pid > 0 && m.pid !== process.pid) targets.push({ pid: m.pid, role: "GPU", created: Number(m.creationTime) });
    } catch { }
    return targets;
}

function helperProblem(): string | null {
    if (process.platform !== "win32") return "só funciona no Windows";
    if (!existsSync(helperPath())) return `o ajudante do Telinha (${SCREEN_AUDIO_HELPER}) não foi instalado`;
    return null;
}

const toLines = (output: string) => output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

/**
 * Roda `telinha-audio.exe --gpu-priority <pids> --class <cls> <condicao>` (RAISE_ONLY ou IF_STILL_HIGH) e junta as linhas
 * (stdout e stderr). Sem resposta a tempo, mata o helper e fica com o que ele ja tinha dito (um "ok pid=" ja escrito
 * valeu). Nunca rejeita.
 */
function runHelper(pids: number[], cls: string, condition: string[]): Promise<HelperAnswer> {
    return new Promise(resolve => {
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
            child = spawn(helperPath(), ["--gpu-priority", pids.join(","), "--class", cls, ...condition], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            resolve({ lines: [], code: null, reason: spawnErrorReason(e as NodeJS.ErrnoException, HELPER_NAME) });
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
            done({ lines: toLines(output), code: null, reason: "o ajudante do Telinha não respondeu a tempo" });
        }, PRIORITY_TIMEOUT_MS);
        const collect = (b: Buffer) => {
            if (output.length < OUTPUT_MAX_CHARS) output += b.toString("utf8");
        };
        // sem estes handlers um erro num pipe viraria excecao nao tratada no processo main do Discord
        const ignore = () => { };
        child.on("error", e => done({ lines: [], code: null, reason: spawnErrorReason(e, HELPER_NAME) }));
        child.stdout.on("error", ignore);
        child.stderr.on("error", ignore);
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.on("close", code => done({ lines: toLines(output), code, reason: null }));
    });
}

const isGone = (t: GpuPriorityTarget) => !!t.error && GONE_ERROR_RE.test(t.error);

function summarize(mode: GpuPriorityMode, targets: GpuPriorityTarget[], hags: GpuPriorityReport["hags"], reason: string | null, quiet = false): GpuPriorityReport {
    // na subida, quem ja estava em HIGH ou acima (kept) ficou como pedido; na volta, o processo que ja terminou nao tem o
    // que voltar: conta como feito
    const done = targets.filter(t => (!t.error && t.after && (mode !== "high" || t.after === HIGH || t.kept)) || (mode === "restore" && isGone(t))).length;
    return {
        mode, ok: !reason && done === targets.length, done, targets, hags, reason, quiet,
        refused: targets.some(t => !!t.error && REFUSED_ERROR_RE.test(t.error)),
        raised: raised.size,
        notes: []
    };
}

/** As linhas do helper → o que aconteceu com cada processo. */
function readAnswer(wanted: { pid: number; role: Role; }[], answer: HelperAnswer) {
    const targets = wanted.map(({ pid, role }): GpuPriorityTarget => ({ pid, role, before: null, after: null, kept: false, error: null }));
    const byPid = new Map(targets.map(t => [t.pid, t]));
    let hags: GpuPriorityReport["hags"] = null;
    let { reason } = answer;
    for (const line of answer.lines) {
        const hagsLine = HAGS_RE.exec(line);
        const ok = OK_RE.exec(line);
        const kept = KEEP_RE.exec(line);
        const failed = TARGET_ERROR_RE.exec(line);
        const general = GENERAL_ERROR_RE.exec(line);
        if (hagsLine) {
            hags = hagsLine[1] === "unknown" ? null : hagsLine[1] as "on" | "off";
        } else if (ok) {
            const t = byPid.get(Number(ok[1]));
            if (t) [t.before, t.after] = [ok[2], ok[3]];
        } else if (kept) {
            const t = byPid.get(Number(kept[1]));
            if (t) [t.before, t.after, t.kept] = [kept[2], kept[2], true];
        } else if (failed) {
            const t = byPid.get(Number(failed[3]));
            if (t) t.error = `${failed[1]} ${failed[2]}${failed[4] ? ` ${failed[4]}` : ""}`.slice(0, 200);
        } else if (general) {
            reason ??= general[1] === "usage" ? "o ajudante do Telinha é de uma versão antiga" : `o Windows não tem a função (${general[2]})`;
        }
    }
    if (!reason && answer.code !== 0 && answer.code !== 6) reason = `o ajudante do Telinha fechou com o código ${answer.code}`;
    if (!reason) for (const t of targets) if (!t.after && !t.error) t.error = "sem resposta do ajudante";
    return { targets, hags, reason };
}

/**
 * Volta estes processos para a classe de antes (um helper por classe), so se ainda estiverem em HIGH. Sai de `raised` o
 * que voltou, o que ja nao estava em HIGH (outro mudou a classe: fica como esta) e o que ja terminou; o resto (antivirus
 * atrasando, sem resposta a tempo, acesso negado de passagem) fica para a proxima tentativa: o proximo "restore", o
 * proximo "high" ou o inicio do plugin. quiet = nada mudou e as falhas ja tinham sido ditas.
 */
async function restoreEntries(entries: [number, Raised][]) {
    const groups = new Map<string, { pid: number; role: Role; }[]>();
    for (const [pid, { before, role }] of entries) groups.set(before, [...(groups.get(before) ?? []), { pid, role }]);
    const problem = groups.size ? helperProblem() : null;
    const targets: GpuPriorityTarget[] = [];
    let hags: GpuPriorityReport["hags"] = null;
    let reason: string | null = null;
    let news = false;
    for (const [before, wanted] of groups) {
        const answer = problem ? { lines: [], code: null, reason: problem } : await runHelper(wanted.map(t => t.pid), before.toLowerCase(), IF_STILL_HIGH);
        const read = readAnswer(wanted, answer);
        for (const t of read.targets) {
            // sem entrada: o processo da GPU caiu enquanto o helper rodava (onChildProcessGone ja o tirou)
            const entry = raised.get(t.pid);
            if (!entry || (t.after && !t.error) || isGone(t)) {
                raised.delete(t.pid);
                news = true;
            } else {
                news ||= !entry.failed;
                entry.failed = true;
            }
        }
        targets.push(...read.targets);
        hags ??= read.hags;
        reason ??= read.reason;
    }
    return { targets, hags, reason, quiet: !news };
}

async function raise(): Promise<GpuPriorityReport> {
    active = true;
    watchGpuProcess();
    const wanted = discordTargets();
    // o que nao voltou de antes e nao e um destes (um processo da GPU antigo): tenta voltar, em silencio
    const stale = [...raised].filter(([pid]) => !wanted.some(t => t.pid === pid));
    if (stale.length) await restoreEntries(stale);
    const problem = helperProblem();
    const answer = problem ? { lines: [], code: null, reason: problem } : await runHelper(wanted.map(t => t.pid), "high", RAISE_ONLY);
    const read = readAnswer(wanted, answer);
    untouched.clear();
    for (const t of read.targets) {
        const entry = raised.get(t.pid);
        // ja estava em HIGH ou acima sem o Telinha (o REALTIME do Discord): fica como esta e nunca volta; a volta so o cita
        if (t.kept && !entry) untouched.set(t.pid, { ...t });
        if (t.after !== HIGH) continue;
        // ja lembrado (a volta falhou antes, ou o processo da GPU reiniciou): continua voltando para a classe de antes de tudo
        if (entry) entry.failed = false;
        else if (t.before && BELOW_HIGH.has(t.before)) raised.set(t.pid, { before: t.before, role: t.role, failed: false });
    }
    return summarize("high", read.targets, read.hags, read.reason);
}

async function restore(): Promise<GpuPriorityReport> {
    active = false;
    const read = await restoreEntries([...raised]);
    const left = [...untouched.values()];
    untouched.clear();
    return summarize("restore", [...read.targets, ...left], read.hags, read.reason, read.quiet);
}

/**
 * O processo da GPU do Discord caiu no meio de uma transmissao (driver reiniciou, TDR, troca de placa num notebook): o pid
 * antigo sai de `raised` e o novo processo da GPU sobe para HIGH assim que aparece. Fica numa nota do proximo relatorio.
 */
function onChildProcessGone(_event: unknown, details: { type?: string; } | undefined) {
    if (details?.type !== "GPU" || !active) return;
    const old = [...raised, ...untouched].filter(([, entry]) => entry.role === "GPU").map(([pid]) => pid);
    for (const pid of old) {
        raised.delete(pid);
        untouched.delete(pid);
    }
    const goneAt = Date.now();
    const at = new Date(goneAt).toISOString().slice(11, 19);
    let tries = 0;
    const attempt = () => {
        const timer = setTimeout(() => void enqueue(async () => {
            if (!active) return;
            // o Windows pode dar o pid antigo ao processo novo: entao vale o que nasceu depois da queda (creationTime)
            const gpu = discordTargets().find(t => t.role === "GPU" && (!old.includes(t.pid) || t.created >= goneAt - GPU_RESTART_SLACK_MS));
            if (!gpu) {
                if (++tries < GPU_RESTART_TRIES) attempt();
                else notes.push(`o processo da GPU do Discord reiniciou às ${at} UTC e o novo não apareceu: alta só no principal`);
                return;
            }
            const report = await raise();
            const now = report.targets.find(t => t.pid === gpu.pid);
            const outcome = now?.kept ? `já estava ${now.after}` : now?.after === HIGH ? "alta de novo" : `não subiu de novo (${now?.error ?? report.reason})`;
            notes.push(`o processo da GPU do Discord reiniciou às ${at} UTC (${old.join(", ") || "?"} → ${gpu.pid}): ${outcome}`);
        }), GPU_RESTART_DELAY_MS);
        timer.unref?.();
    };
    attempt();
}

function watchGpuProcess() {
    if (watchingGpu) return;
    watchingGpu = true;
    try {
        app.on("child-process-gone", onChildProcessGone);
    } catch { }
}

/**
 * "high": o Discord (principal + GPU) em HIGH na placa de video, so quem esta abaixo (nunca abaixa um REALTIME); "restore":
 * volta o que o "high" mudou (sem nada a voltar, nao roda o helper; o que falhou antes e tentado de novo). Um pedido por
 * vez. Nunca rejeita.
 */
export function setGpuPriorityMain(mode: GpuPriorityMode): Promise<GpuPriorityReport> {
    return enqueue(async () => {
        const report = await (mode === "high" ? raise() : restore());
        // so aqui: o "high" que o main faz sozinho (a GPU que reiniciou) nao consome as notas
        report.notes = notes.splice(0);
        return report;
    });
}

/** So para testes: esquece o que foi subido, e o ouvinte do processo da GPU e instalado de novo no proximo "high". */
export function resetGpuPriorityForTests() {
    raised.clear();
    untouched.clear();
    notes.length = 0;
    active = false;
    watchingGpu = false;
    queue = Promise.resolve();
}

// #endregion
