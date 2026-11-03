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
// Aqui so se grava o arquivo (para a proxima partida) e se le o que o loader fez nesta. O mesmo arquivo leva o AV1 da placa
// (core/av1FlagMain.ts): cada opcao grava so a sua chave e mantem a da outra (writeCaptureFlags).
//
// "Prioridade da captura na placa de vídeo": enquanto transmite, o processo principal do Discord (onde o Chromium captura
// a tela e copia cada quadro) e o da GPU (onde converte e codifica) sobem para a classe HIGH do agendador da placa de
// video, pelo telinha-audio.exe --gpu-priority --raise (D3DKMTSetProcessSchedulingPriorityClass). Funciona sem
// administrador (medido em 01/11/2026 no Windows 11, nivel de integridade medio: HIGH num outro processo do mesmo usuario
// e aceito). O modo "high" nunca pede REALTIME e nunca abaixa: o processo da GPU do Discord pode ja estar em REALTIME,
// posto pelo proprio Discord, e fica assim (02/11/2026, RTX 3070: baixado para HIGH, o NVENC foi de ~7 ms para ~400 ms por
// quadro com um jogo pesado). Quando o Windows recusa, so fica no log e na pagina do plugin ("não foi possível (precisa de
// administrador)"); nunca pede elevacao.
//
// O modo "realtime" ("Tempo real (teste)") tem duas fases: 1) tudo o que o "high" faz; 2) so nos processos que ficaram em
// HIGH, outra chamada com --class realtime --raise --allow-realtime (o helper so aceita REALTIME com essa chave). Como vem
// por cima do HIGH, uma recusa do Windows (sem administrador) ou um Windows que mantem HIGH deixa o processo em HIGH, nunca
// em NORMAL; fica no relatorio (realtimeRefused). O processo que ja estava em REALTIME (o do Discord) nao e tocado. Cada
// processo guarda a classe em que o Telinha o deixou (Raised.current): o "high" depois de um "realtime" desce so esses, de
// REALTIME para HIGH (--if-class realtime: se outro mudou a classe, fica), e a volta (restore) parte da classe atual.
// O REALTIME tem uma rede de seguranca que sobrevive a queda do Discord: o main grava, na mesma pasta do capture-flags.json, o
// gpu-priority.json (arquivo temporario + rename) com "armed" (o pid que ligou o REALTIME, gravado ANTES da 2a fase e apagado
// quando nada mais esta em REALTIME ou o processo sai normalmente) e "blocked" (por que o REALTIME esta desligado neste PC).
// Na 1a leitura de cada partida, um "armed" com outro pid quer dizer que o Discord morreu com o REALTIME ligado: vira
// "blocked", e o "realtime" fica em HIGH ate alguem desbloquear (setGpuRealtimeBlocked(null)). A queda do processo da GPU com
// o REALTIME ligado tambem bloqueia. Risco conhecido: o pid de outro Discord vivo (Canary, PTB) que divida a pasta conta como queda.
//
// Ao parar a transmissao volta so o que o Telinha subiu, para a classe que tinha (normalmente NORMAL), e so se ainda
// estiver na classe em que o Telinha o deixou (--if-class: se outro mudou a classe depois, fica): o ganho so importa durante
// a captura, e o Discord em HIGH depois disso so disputaria a placa com o jogo (a interface, e o video de quem voce assiste)
// sem ganho nenhum. A classe tambem some quando o Discord fecha.
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
import { dirname, isAbsolute, join } from "path";
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

export interface LoaderCapture {
    file: string;
    wgcTexture?: unknown;
    applied?: unknown;
    reason?: unknown;
    enableFeatures?: unknown;
    /** o arquivo pedia o WebRtcAV1HWEncode nesta partida (loader desta versao em diante) */
    av1HwEncode?: unknown;
    /** o WebRtcAV1HWEncode estava no enable-features quando o app ficou pronto; null = nao foi pedido */
    av1Applied?: unknown;
}

/** O que o loader desta partida publicou (null: sem loader do add-on, ou um loader antigo). */
export function loaderCapture(): LoaderCapture | null {
    const capture = (globalThis as { __TelinhaAddon?: { capture?: unknown; }; }).__TelinhaAddon?.capture as LoaderCapture | null | undefined;
    return capture && typeof capture.file === "string" && isAbsolute(capture.file) ? capture : null;
}

function windowsBuild(): number {
    if (process.platform !== "win32") return 0;
    return Number(release().split(".")[2]) || 0;
}

const text = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);

/** As chaves do capture-flags.json que o Telinha conhece (o resto do arquivo e ignorado e some na proxima gravacao). */
export interface CaptureFlags {
    wgcTexture: boolean;
    av1HwEncode: boolean;
}

/** O capture-flags.json agora (ausente, ilegivel ou sem `true` = desligado). */
export function readCaptureFlags(file: string): CaptureFlags {
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        return { wgcTexture: raw?.wgcTexture === true, av1HwEncode: raw?.av1HwEncode === true };
    } catch {
        return { wgcTexture: false, av1HwEncode: false };
    }
}

/**
 * Grava `patch` por cima do que o arquivo ja pede (a outra opcao fica como esta), com arquivo temporario + rename: o
 * loader nunca le um arquivo pela metade. Lanca se nao conseguir (quem chama devolve o erro em pt-BR).
 */
export function writeCaptureFlags(file: string, patch: Partial<CaptureFlags>) {
    const next = { format: 1, ...readCaptureFlags(file), ...patch };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify({ format: 1, wgcTexture: next.wgcTexture === true, av1HwEncode: next.av1HwEncode === true }) + "\n");
        renameSync(tmp, file);
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch { }
        throw e;
    }
}

const savedIn = (file: string) => readCaptureFlags(file).wgcTexture;

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
    try {
        writeCaptureFlags(capture.file, { wgcTexture: on === true });
        return gpuCaptureStatusMain();
    } catch (e) {
        return gpuCaptureStatusMain(`não consegui salvar a opção (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
    }
}

// #region prioridade na placa de video

/**
 * "high": inicio da transmissao (e desce do REALTIME que o Telinha pos); "realtime": HIGH e, nos que ficaram em HIGH, REALTIME
 * (so com --allow-realtime); "restore": o que o Telinha subiu volta para a classe que tinha.
 */
export type GpuPriorityMode = "high" | "realtime" | "restore";

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
    /**
     * a classe em que terminaram os processos que o Telinha controla (os que nao ficaram "como estavam", e os que ele mesmo
     * pos em REALTIME antes): REALTIME so se todos chegaram la; null = misturado, com erro, ou nada (na volta, sempre null)
     */
    level: "HIGH" | "REALTIME" | null;
    /** no "realtime": o Windows recusou o REALTIME (acesso/privilegio) ou aceitou a chamada e manteve outra classe */
    realtimeRefused: boolean;
    /** o que o main fez sozinho desde o ultimo relatorio (o processo da GPU reiniciou...), para o log */
    notes: string[];
    /** por que o REALTIME esta desligado neste PC (gpu-priority.json: o encoder parou, a GPU caiu, o Discord morreu em REALTIME); null = liberado */
    realtimeBlocked: string | null;
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
    /** a classe em que o Telinha o deixou (so HIGH ou REALTIME): a volta so muda quem ainda esta nela */
    current: "HIGH" | "REALTIME";
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
const REALTIME = "REALTIME";
/** as classes abaixo de HIGH: so estas sao lembradas para voltar (um processo ja em HIGH ou acima fica como estava) */
const BELOW_HIGH = new Set(["IDLE", "BELOW_NORMAL", "NORMAL", "ABOVE_NORMAL"]);
/** a subida nunca abaixa: o helper so muda quem esta abaixo de HIGH (REALTIME e HIGH ficam, com uma linha "keep") */
const RAISE_ONLY = ["--raise"];
/** a 2a fase do "realtime": so sobe quem esta abaixo de REALTIME, e o helper so o aceita com --allow-realtime */
const RAISE_REALTIME = ["--raise", "--allow-realtime"];
/** a volta (e a descida do REALTIME) so muda quem ainda esta na classe que o Telinha pos (se o Discord mudou depois, fica) */
const ifStill = (cls: string) => ["--if-class", cls.toLowerCase()];
/** o Windows aceitou a chamada do REALTIME e manteve outra classe (a classe vem depois do texto) */
const CLAMPED_ERROR = "o Windows manteve";
const OLD_HELPER = "o ajudante do Telinha é de uma versão antiga";
const OLD_HELPER_REALTIME = "o ajudante do Telinha é de uma versão antiga (sem o tempo real)";
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

// #region tempo real: bloqueio e marcador (gpu-priority.json, na pasta do capture-flags.json)

/** O que o native gpuRealtimeStatus devolve: `available` = da para tentar o REALTIME agora; `blocked` = o motivo do bloqueio; `reason` = o resto (sem loader, nao gravou). */
export interface GpuRealtimeStatus {
    available: boolean;
    blocked: string | null;
    reason: string | null;
}

interface RealtimeFile {
    blocked: { at: number; why: string; } | null;
    armed: { pid: number; at: number; } | null;
}

const NO_LOADER_REALTIME = "só com o Telinha instalado pelo TelinhaInstaller";
const REALTIME_TEXT_MAX = 300;

/** o gpu-priority.json lido (ou vazio) uma vez por partida do Discord; `file` = de onde (null = sem loader, so na memoria) */
let realtimeMemo: { file: string | null; state: RealtimeFile; } | null = null;
/** a ultima gravacao do gpu-priority.json falhou (em pt-BR) */
let realtimeSaveError: string | null = null;
let realtimeExitHookInstalled = false;

function realtimeFile(): string | null {
    const capture = loaderCapture();
    return capture ? join(dirname(capture.file), "gpu-priority.json") : null;
}

/** Ausente, quebrado ou com campos estranhos = vazio. */
function readRealtimeFile(file: string): RealtimeFile {
    try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        const { blocked, armed } = raw ?? {};
        return {
            blocked: blocked && typeof blocked.why === "string" && blocked.why && Number.isFinite(blocked.at) ? { at: blocked.at, why: blocked.why.slice(0, REALTIME_TEXT_MAX) } : null,
            armed: armed && Number.isInteger(armed.pid) && Number.isFinite(armed.at) ? { pid: armed.pid, at: armed.at } : null
        };
    } catch {
        return { blocked: null, armed: null };
    }
}

const two = (n: number) => String(n).padStart(2, "0");
const whenText = (ms: number) => {
    const d = new Date(ms);
    return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** Grava o estado da memoria (sincrono, tmp + rename, como o writeCaptureFlags). Nunca lanca: devolve o erro em pt-BR. Sem loader nao grava nada. */
function saveRealtime(): string | null {
    const memo = realtimeMemo;
    if (!memo?.file) return null;
    const tmp = `${memo.file}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify({ format: 1, blocked: memo.state.blocked, armed: memo.state.armed }) + "\n");
        renameSync(tmp, memo.file);
        realtimeSaveError = null;
        return null;
    } catch (e) {
        try {
            rmSync(tmp, { force: true });
        } catch { }
        realtimeSaveError = `não consegui salvar o estado do tempo real (${e instanceof Error ? e.message : String(e)})`.slice(0, REALTIME_TEXT_MAX);
        return realtimeSaveError;
    }
}

/**
 * O estado do tempo real, lido uma vez por partida. Um "armed" de outro pid: o Discord anterior morreu com o REALTIME ligado
 * (travou ou foi fechado a forca): vira bloqueio, e o marcador e limpo.
 */
function realtimeState(): RealtimeFile {
    const file = realtimeFile();
    if (realtimeMemo && realtimeMemo.file === file) return realtimeMemo.state;
    const state: RealtimeFile = file ? readRealtimeFile(file) : { blocked: null, armed: null };
    realtimeMemo = { file, state };
    if (state.armed && state.armed.pid !== process.pid) {
        // a hora e a de quando o REALTIME foi ligado: a queda em si ninguem viu
        state.blocked = { at: Date.now(), why: `o Discord fechou sem sair do tempo real (travou ou foi fechado à força) em ${whenText(state.armed.at)}` };
        state.armed = null;
        saveRealtime();
    }
    return state;
}

/** Saida normal do Discord: o marcador sai (so uma queda o deixa para a proxima partida). */
function onProcessExit() {
    const memo = realtimeMemo;
    if (!memo || memo.state.armed?.pid !== process.pid) return;
    memo.state.armed = null;
    saveRealtime();
}

/**
 * Liga o marcador (ANTES de pedir o REALTIME) ou o apaga. Devolve o erro de gravacao: sem o marcador gravado nao ha rede de
 * seguranca, entao quem liga nao pede o REALTIME.
 */
function armRealtime(on: boolean): string | null {
    const state = realtimeState();
    if (on) {
        if (state.armed?.pid === process.pid) return null;
        state.armed = { pid: process.pid, at: Date.now() };
        const error = saveRealtime();
        if (error) {
            state.armed = null;
            return error;
        }
        if (!realtimeExitHookInstalled) {
            realtimeExitHookInstalled = true;
            process.once("exit", onProcessExit);
        }
        return null;
    }
    if (!state.armed) return null;
    state.armed = null;
    return saveRealtime();
}

/** Nada mais em REALTIME por causa do Telinha: o marcador sai. */
function syncArmed() {
    if (![...raised.values()].some(entry => entry.current === REALTIME)) armRealtime(false);
}

/** Desliga o REALTIME neste PC (grava; o "realtime" fica em HIGH). Devolve o erro de gravacao, se houve. */
export function blockRealtime(why: string): string | null {
    realtimeState().blocked = { at: Date.now(), why: why.trim().slice(0, REALTIME_TEXT_MAX) || "motivo não informado" };
    return saveRealtime();
}

export function unblockRealtime(): string | null {
    realtimeState().blocked = null;
    return saveRealtime();
}

const blockedWhy = () => realtimeState().blocked?.why ?? null;

/** Por que o "realtime" nao pode pedir REALTIME agora (sem o loader da pasta, ou bloqueado); null = pode. */
function realtimeGate(): string | null {
    if (!realtimeFile()) return NO_LOADER_REALTIME;
    const why = blockedWhy();
    return why ? `tempo real desligado neste PC: ${why}` : null;
}

export function gpuRealtimeStatusMain(): GpuRealtimeStatus {
    const blocked = blockedWhy();
    const hasFile = !!realtimeFile();
    return { available: hasFile && !blocked && !realtimeSaveError, blocked, reason: hasFile ? realtimeSaveError : NO_LOADER_REALTIME };
}

/** Um texto bloqueia, null libera (a nova escolha de "Tempo real (teste)" na pagina); qualquer outro valor do IPC e ignorado. */
export function setGpuRealtimeBlockedMain(why: unknown): GpuRealtimeStatus {
    if (why === null) unblockRealtime();
    else if (typeof why === "string") blockRealtime(why);
    return gpuRealtimeStatusMain();
}

// #endregion

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
 * Roda `telinha-audio.exe --gpu-priority <pids> --class <cls> <condicao>` (RAISE_ONLY, RAISE_REALTIME ou ifStill(...)) e junta as linhas
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
    // no "realtime", so conta quem esta em REALTIME (o que o Telinha pos, ou o que o Discord ja tinha posto)
    const reached = (t: GpuPriorityTarget) => (mode === "high" ? t.after === HIGH || t.kept : mode === "realtime" ? t.after === REALTIME : true);
    const done = targets.filter(t => (!t.error && t.after && reached(t)) || (mode === "restore" && isGone(t))).length;
    return {
        mode, ok: !reason && done === targets.length, done, targets, hags, reason, quiet,
        refused: targets.some(t => !!t.error && REFUSED_ERROR_RE.test(t.error)),
        raised: raised.size,
        notes: [],
        level: levelOf(mode, targets),
        realtimeRefused: false,
        realtimeBlocked: blockedWhy()
    };
}

/** GpuPriorityReport.level: `kept` com REALTIME que e do proprio Telinha (ele o pos antes) conta como dele */
function levelOf(mode: GpuPriorityMode, targets: GpuPriorityTarget[]): GpuPriorityReport["level"] {
    if (mode === "restore") return null;
    const own = targets.filter(t => !t.kept || (t.after === REALTIME && raised.get(t.pid)?.current === REALTIME));
    if (!own.length || own.some(t => !!t.error || !t.after)) return null;
    if (own.every(t => t.after === REALTIME)) return REALTIME;
    if (own.every(t => t.after === HIGH)) return HIGH;
    return null;
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
            reason ??= general[1] === "usage" ? OLD_HELPER : `o Windows não tem a função (${general[2]})`;
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
    // um helper por par (classe de antes, classe atual): a volta so muda quem ainda esta na classe em que o Telinha o deixou
    const groups = new Map<string, { before: string; current: Raised["current"]; wanted: { pid: number; role: Role; }[]; }>();
    for (const [pid, { before, current, role }] of entries) {
        const key = `${before}|${current}`;
        const group = groups.get(key) ?? { before, current, wanted: [] };
        group.wanted.push({ pid, role });
        groups.set(key, group);
    }
    const problem = groups.size ? helperProblem() : null;
    const targets: GpuPriorityTarget[] = [];
    let hags: GpuPriorityReport["hags"] = null;
    let reason: string | null = null;
    let news = false;
    for (const { before, current, wanted } of groups.values()) {
        const answer = problem ? { lines: [], code: null, reason: problem } : await runHelper(wanted.map(t => t.pid), before.toLowerCase(), ifStill(current));
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

/**
 * Desce de REALTIME para HIGH o que o Telinha pos em REALTIME (so se ainda estiver la: --if-class realtime). Quem mudou a
 * classe por fora ("keep") ou ja terminou sai da lista; o que falhou fica (a proxima descida ou a volta tenta de novo).
 * null = nada em REALTIME.
 */
async function stepDown() {
    const wanted = [...raised].filter(([, entry]) => entry.current === REALTIME).map(([pid, { role }]) => ({ pid, role }));
    if (!wanted.length) {
        syncArmed();
        return null;
    }
    const problem = helperProblem();
    const answer = problem ? { lines: [], code: null, reason: problem } : await runHelper(wanted.map(t => t.pid), "high", ifStill(REALTIME));
    const read = readAnswer(wanted, answer);
    for (const t of read.targets) {
        const entry = raised.get(t.pid);
        // sem entrada: o processo da GPU caiu enquanto o helper rodava (onChildProcessGone ja o tirou)
        if (!entry) continue;
        if (!t.error && t.after === HIGH && !t.kept) {
            entry.current = HIGH;
            entry.failed = false;
        } else if (t.kept || isGone(t)) {
            raised.delete(t.pid);
        } else {
            entry.failed = true;
        }
    }
    syncArmed();
    return read;
}

/** `keepRealtime`: a 1a fase do "realtime" nao desce o que o Telinha ja pos em REALTIME. */
async function raise(keepRealtime = false): Promise<GpuPriorityReport> {
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
        // ja lembrado (a volta falhou antes, ou o processo da GPU reiniciou): continua voltando para a classe de antes de tudo;
        // se estava em REALTIME e o helper o achou em HIGH (outro o baixou), a classe atual e HIGH
        if (entry) {
            entry.failed = false;
            entry.current = HIGH;
        }
        else if (t.before && BELOW_HIGH.has(t.before)) raised.set(t.pid, { before: t.before, current: HIGH, role: t.role, failed: false });
    }
    let { hags, reason } = read;
    // o "high" tambem significa "volta do REALTIME": desce o que o Telinha pos la, e o relatorio mostra REALTIME→HIGH
    const down = keepRealtime ? null : await stepDown();
    if (down) {
        for (const d of down.targets) {
            const i = read.targets.findIndex(t => t.pid === d.pid);
            if (i < 0) continue;
            if (!d.error && d.after === HIGH && !d.kept) read.targets[i] = d;
            else if (raised.has(d.pid)) read.targets[i] = { ...read.targets[i], error: d.error ?? down.reason ?? "não desceu do tempo real" };
        }
        hags ??= down.hags;
        reason ??= down.reason;
    }
    return summarize("high", read.targets, hags, reason);
}

/**
 * "realtime", em duas fases: 1) o "high" (sem descer o REALTIME que o Telinha ja pos); 2) REALTIME so nos que ficaram em HIGH
 * (por nos ou por outro), com --raise --allow-realtime: por cima do HIGH, entao uma recusa deixa HIGH. Nunca num pid fora de
 * discordTargets(), e nunca sem --raise.
 */
async function raiseRealtime(): Promise<GpuPriorityReport> {
    const first = await raise(true);
    const eligible = first.targets.filter(t => !t.error && t.after === HIGH);
    if (first.reason || !eligible.length) return summarize("realtime", first.targets, first.hags, first.reason);

    // sem o loader (sem pasta para o marcador) ou bloqueado: fica em HIGH
    const gate = realtimeGate();
    if (gate) return summarize("realtime", first.targets, first.hags, gate);
    // o marcador vai para o disco ANTES do REALTIME: se o Discord travar com ele ligado, a proxima partida sabe
    const armError = armRealtime(true);
    if (armError) return summarize("realtime", first.targets, first.hags, `tempo real não ligado: ${armError}`);

    const answer = await runHelper(eligible.map(t => t.pid), "realtime", RAISE_REALTIME);
    const read = readAnswer(eligible, answer);
    const reason = read.reason === OLD_HELPER ? OLD_HELPER_REALTIME : read.reason;
    let refusedOrClamped = false;
    for (const t of read.targets) {
        if (t.error) {
            refusedOrClamped ||= REFUSED_ERROR_RE.test(t.error);
        } else if (t.after === REALTIME) {
            const entry = raised.get(t.pid);
            if (t.kept) continue; // outro o pos em REALTIME entre as duas fases: nao e do Telinha
            if (entry) {
                entry.current = REALTIME;
            } else if (t.before) {
                // ja estava em HIGH por outro: o restore o devolve a HIGH, a classe que tinha
                raised.set(t.pid, { before: t.before, current: REALTIME, role: t.role, failed: false });
                untouched.delete(t.pid);
            }
        } else if (t.after) {
            // o Windows aceitou a chamada e manteve HIGH (ou outra classe)
            t.error = `${CLAMPED_ERROR} ${t.after}`;
            refusedOrClamped = true;
        }
    }
    syncArmed(); // recusado ou mantido em HIGH: nada em REALTIME, o marcador sai
    const merged = first.targets.map(t => read.targets.find(r => r.pid === t.pid) ?? t);
    const report = summarize("realtime", merged, read.hags ?? first.hags, reason);
    report.realtimeRefused = refusedOrClamped;
    return report;
}

async function restore(): Promise<GpuPriorityReport> {
    active = false;
    const read = await restoreEntries([...raised]);
    syncArmed();
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
    const hadRealtime = [...raised.values()].some(entry => entry.role === "GPU" && entry.current === REALTIME);
    for (const pid of old) {
        raised.delete(pid);
        untouched.delete(pid);
    }
    // a GPU caiu com o REALTIME do Telinha ligado: nao se repete neste PC (o novo processo so sobe para HIGH)
    if (hadRealtime) blockRealtime("o processo da GPU do Discord caiu com o tempo real ligado");
    syncArmed();
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
 * "high": o Discord (principal + GPU) em HIGH na placa de video, so quem esta abaixo (nunca abaixa um REALTIME que nao e do
 * Telinha; o que ele pos em REALTIME desce para HIGH); "realtime": HIGH e, por cima, REALTIME; "restore": volta o que o Telinha
 * mudou (sem nada a voltar, nao roda o helper; o que falhou antes e tentado de novo). Um pedido por vez. Nunca rejeita.
 */
export function setGpuPriorityMain(mode: GpuPriorityMode): Promise<GpuPriorityReport> {
    return enqueue(async () => {
        const report = await (mode === "high" ? raise() : mode === "realtime" ? raiseRealtime() : restore());
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
    realtimeMemo = null;
    realtimeSaveError = null;
    process.off("exit", onProcessExit);
    realtimeExitHookInstalled = false;
}

// #endregion
