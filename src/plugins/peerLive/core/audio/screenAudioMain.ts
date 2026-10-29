/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts (nunca pelo renderer; o build recusa child_process la).
//
// Audio da tela inteira sem o Discord: roda o peerlive-audio.exe (native-audio/), que captura tudo o que o
// Windows toca EXCETO a arvore de processos do Discord (este processo main + renderer, onde o
// discord_voice.node toca as vozes da call, + o servico de audio do Chromium), e entrega o PCM ao renderer.
//
// Transporte: long poll por IPC (readScreenAudio). O renderer nao tem Node e os natives do Vencord sao
// ipcMain.handle; um WebSocket local exigiria liberar ws://127.0.0.1 no CSP (so vale apos reiniciar), abrir
// uma porta que qualquer processo local alcanca e escrever framing a mao. A leitura responde assim que chega
// PCM (o helper escreve a cada ~10 ms) ou apos SCREEN_AUDIO_MAX_WAIT_MS, entao nao depende de timers no
// renderer (que o Chromium estrangula com o Discord minimizado). ~3,8 KB por resposta: custo desprezivel.
//
// Nada roda no carregamento do modulo.

import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { existsSync } from "fs";
import { release } from "os";
import { join } from "path";

import {
    SCREEN_AUDIO_BYTES_PER_FRAME,
    SCREEN_AUDIO_CHANNELS,
    SCREEN_AUDIO_MAX_WAIT_MS,
    SCREEN_AUDIO_RATE,
    type ScreenAudioRead,
    type ScreenAudioStart,
    type ScreenAudioStatus
} from "./types";

export const SCREEN_AUDIO_HELPER = "peerlive-audio.exe";

const MIN_WINDOWS_BUILD = 19041; // Windows 10 2004: process loopback
const READY_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 6000;
const MAX_QUEUE_BYTES = SCREEN_AUDIO_RATE * SCREEN_AUDIO_BYTES_PER_FRAME / 2; // 500 ms; o excesso mais antigo e descartado
const IDLE_STOP_MS = 5000; // renderer parou de ler (recarregou/travou): encerra o helper
const KILL_GRACE_MS = 800;
const STDERR_MAX_CHARS = 16 * 1024;

interface Capture {
    id: number;
    child: ChildProcessWithoutNullStreams;
    queue: Buffer[];
    queuedBytes: number;
    remainder: Buffer | null;
    droppedBytes: number;
    ended: boolean;
    reason: string | null;
    lastError: string | null;
    waiter: (() => void) | null;
    lastReadAt: number;
    idleTimer: ReturnType<typeof setInterval> | null;
}

let current: Capture | null = null;
let nextId = 1;
let exitHookInstalled = false;
let probeOk: Promise<ScreenAudioStatus> | null = null;
let helperPathOverride: string | null = null;

function helperPath() {
    // patcher.js (onde este codigo e empacotado) fica em .../Vencord/dist: o exe vai ao lado dele
    return helperPathOverride ?? join(__dirname, SCREEN_AUDIO_HELPER);
}

/** So para testes fora do Electron (o exe nao fica ao lado do .ts). */
export function setScreenAudioHelperPathForTests(path: string | null) {
    helperPathOverride = path;
    probeOk = null;
}

function windowsBuild(): number {
    const parts = release().split(".");
    return Number(parts[2]) || 0;
}

function basicCheck(): string | null {
    if (process.platform !== "win32") return "o áudio da tela inteira só funciona no Windows";
    const build = windowsBuild();
    if (build < MIN_WINDOWS_BUILD) return `o áudio da tela inteira exige Windows 10 versão 2004 ou mais novo (este é o build ${build || "?"})`;
    if (!existsSync(helperPath())) return `o ajudante de áudio (${SCREEN_AUDIO_HELPER}) não foi instalado junto com o PeerLive`;
    return null;
}

function spawnErrorReason(e: NodeJS.ErrnoException) {
    if (e?.code === "ENOENT") return `o ajudante de áudio (${SCREEN_AUDIO_HELPER}) não foi encontrado (o antivírus pode tê-lo removido)`;
    if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "UNKNOWN")
        return `o Windows ou o antivírus bloqueou o ajudante de áudio (${SCREEN_AUDIO_HELPER})`;
    return `não foi possível abrir o ajudante de áudio: ${e?.code ?? ""} ${e?.message ?? String(e)}`.trim();
}

/** Linha "error <etapa> 0x<hr> <texto>" do helper + codigo de saida -> motivo em pt-BR. */
function exitReason(code: number | null, signal: NodeJS.Signals | null, lastError: string | null): string {
    const m = lastError ? /^error (\S+) (0x[0-9A-Fa-f]{8})\s*(.*)$/.exec(lastError) : null;
    const hr = m ? `${m[2]}${m[3] ? ` — ${m[3]}` : ""}` : "";
    if (code === 3 || m?.[1] === "os") return "o áudio da tela inteira exige Windows 10 versão 2004 ou mais novo";
    if (code === 4) return `o Windows recusou a captura de áudio do sistema${hr ? ` (${hr})` : ""}`;
    if (code === 5) return `não foi possível iniciar a captura de áudio do Windows${hr ? ` (${hr})` : ""}`;
    if (code === 1 && m) return `a captura de áudio parou (${hr})`;
    if (code === 1) return "o ajudante de áudio foi encerrado por outro programa (antivírus?)";
    if (code === 0) return "o ajudante de áudio encerrou";
    if (signal) return "o ajudante de áudio foi encerrado";
    return `o ajudante de áudio fechou inesperadamente (código ${code ?? "?"})`;
}

function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    // O helper tambem sai sozinho quando o Discord morre (stdin fecha / --parent), isto so adianta.
    process.once("exit", () => {
        const cap = current;
        current = null;
        try {
            cap?.child.kill();
        } catch { }
    });
}

function wake(cap: Capture) {
    const w = cap.waiter;
    cap.waiter = null;
    w?.();
}

function finish(cap: Capture, reason: string) {
    if (cap.ended) return;
    cap.ended = true;
    cap.reason = reason;
    if (cap.idleTimer) clearInterval(cap.idleTimer);
    cap.idleTimer = null;
    wake(cap);
}

function ingest(cap: Capture, chunk: Buffer) {
    const data = cap.remainder ? Buffer.concat([cap.remainder, chunk]) : chunk;
    const whole = data.length - (data.length % SCREEN_AUDIO_BYTES_PER_FRAME);
    cap.remainder = whole < data.length ? Buffer.from(data.subarray(whole)) : null;
    if (!whole) return;

    cap.queue.push(whole === data.length ? data : data.subarray(0, whole));
    cap.queuedBytes += whole;
    while (cap.queuedBytes > MAX_QUEUE_BYTES && cap.queue.length > 1) {
        const old = cap.queue.shift()!;
        cap.queuedBytes -= old.length;
        cap.droppedBytes += old.length;
    }
    wake(cap);
}

function take(cap: Capture): Uint8Array {
    // Copia exata num ArrayBuffer proprio: o IPC (structured clone) serializa o ArrayBuffer INTEIRO de uma
    // view, e os Buffers do Node podem ser fatias de um slab maior/compartilhado.
    const out = new Uint8Array(cap.queuedBytes);
    let offset = 0;
    for (const b of cap.queue) {
        out.set(b, offset);
        offset += b.length;
    }
    cap.queue = [];
    cap.queuedBytes = 0;
    return out;
}

function stopChild(child: ChildProcessWithoutNullStreams) {
    // fechar o stdin e o pedido educado de parada; se nao sair, mata
    try {
        child.stdin.end();
    } catch { }
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => {
        try {
            child.kill();
        } catch { }
    }, KILL_GRACE_MS);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
}

/** Roda `--probe` uma vez (cacheado quando funciona). */
function probe(): Promise<ScreenAudioStatus> {
    return new Promise(resolve => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(helperPath(), ["--probe"], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
            resolve({ available: false, reason: spawnErrorReason(e as NodeJS.ErrnoException) });
            return;
        }
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch { }
            done({ available: false, reason: "o ajudante de áudio não respondeu" });
        }, PROBE_TIMEOUT_MS);
        const done = (status: ScreenAudioStatus) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(status);
        };
        child.on("error", e => done({ available: false, reason: spawnErrorReason(e) }));
        child.stdin.on("error", () => { });
        child.stdout.on("error", () => { });
        child.stdout.resume();
        child.stderr.on("error", () => { });
        child.stderr.on("data", (b: Buffer) => {
            if (stderr.length < STDERR_MAX_CHARS) stderr += b.toString("utf8");
        });
        child.on("exit", (code, signal) => {
            const lastError = stderr.split(/\r?\n/).find(l => l.startsWith("error ")) ?? null;
            if (code === 0) done({ available: true, reason: "áudio do PC sem o Discord (process loopback do Windows)" });
            else done({ available: false, reason: exitReason(code, signal, lastError) });
        });
        child.stdin.end();
    });
}

export function screenAudioStatusMain(): Promise<ScreenAudioStatus> {
    const problem = basicCheck();
    if (problem) return Promise.resolve({ available: false, reason: problem });
    if (current && !current.ended) return Promise.resolve({ available: true, reason: "capturando" });
    if (probeOk) return probeOk;
    const p = probe();
    probeOk = p;
    p.then(s => {
        if (!s.available && probeOk === p) probeOk = null; // so o sucesso fica em cache
    });
    return p;
}

/**
 * Inicia a captura de todo o audio do PC menos a arvore de `excludePid` (o native.ts passa process.pid,
 * o processo main do Discord). Para uma captura anterior. Nunca rejeita: devolve { ok: false, reason }.
 */
export function startScreenAudioMain(excludePid: number): Promise<ScreenAudioStart> {
    stopScreenAudioMain();

    const problem = basicCheck();
    if (problem) return Promise.resolve({ ok: false, reason: problem });
    if (!Number.isInteger(excludePid) || excludePid <= 0 || excludePid > 0xFFFFFFFF)
        return Promise.resolve({ ok: false, reason: `PID inválido (${excludePid})` });

    installExitHook();

    let child: ChildProcessWithoutNullStreams;
    try {
        child = spawn(helperPath(), ["--exclude", String(excludePid), "--parent", String(process.pid)], {
            windowsHide: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"]
        });
    } catch (e) {
        return Promise.resolve({ ok: false, reason: spawnErrorReason(e as NodeJS.ErrnoException) });
    }

    const cap: Capture = {
        id: nextId++,
        child,
        queue: [],
        queuedBytes: 0,
        remainder: null,
        droppedBytes: 0,
        ended: false,
        reason: null,
        lastError: null,
        waiter: null,
        lastReadAt: Date.now(),
        idleTimer: null
    };
    current = cap;

    return new Promise<ScreenAudioStart>(resolve => {
        let stderr = "";
        let ready = false;
        let settled = false;
        const settle = (result: ScreenAudioStart) => {
            if (settled) return;
            settled = true;
            clearTimeout(readyTimer);
            if (!result.ok) {
                finish(cap, result.reason);
                if (current === cap) current = null;
                stopChild(child);
            }
            resolve(result);
        };
        const readyTimer = setTimeout(() => settle({ ok: false, reason: "o ajudante de áudio não ficou pronto a tempo" }), READY_TIMEOUT_MS);

        // Sem estes handlers um EPIPE viraria excecao nao tratada no processo main do Discord.
        child.on("error", e => {
            const reason = spawnErrorReason(e);
            settle({ ok: false, reason });
            finish(cap, reason);
        });
        child.stdin.on("error", () => { });
        child.stdout.on("error", () => { });
        child.stderr.on("error", () => { });

        child.stdout.on("data", (chunk: Buffer) => {
            if (!cap.ended) ingest(cap, chunk);
        });

        child.stderr.on("data", (b: Buffer) => {
            if (stderr.length > STDERR_MAX_CHARS) return;
            stderr += b.toString("utf8");
            let nl: number;
            while ((nl = stderr.indexOf("\n")) >= 0) {
                const line = stderr.slice(0, nl).trim();
                stderr = stderr.slice(nl + 1);
                if (line.startsWith("error ")) cap.lastError = line.slice(0, 300);
                if (!ready && line.startsWith("ready ")) {
                    ready = true;
                    cap.lastReadAt = Date.now();
                    cap.idleTimer = setInterval(() => {
                        if (Date.now() - cap.lastReadAt > IDLE_STOP_MS) stopScreenAudioMain(cap.id, "o PeerLive parou de ler o áudio");
                    }, 1000);
                    cap.idleTimer.unref?.();
                    settle({ ok: true, id: cap.id, sampleRate: SCREEN_AUDIO_RATE, channels: SCREEN_AUDIO_CHANNELS });
                }
            }
        });

        child.on("exit", (code, signal) => {
            const reason = exitReason(code, signal, cap.lastError);
            settle({ ok: false, reason });
            finish(cap, reason);
        });
    });
}

/**
 * Long poll: devolve o PCM acumulado assim que houver (ou apos `maxWaitMs`, no maximo
 * SCREEN_AUDIO_MAX_WAIT_MS). So uma leitura pendente por vez: uma nova encerra a anterior vazia.
 */
export function readScreenAudioMain(id: number, maxWaitMs: number): Promise<ScreenAudioRead> {
    const cap = current;
    if (!cap || cap.id !== id) return Promise.resolve({ pcm: null, ended: true, reason: "a captura de áudio já foi encerrada" });
    cap.lastReadAt = Date.now();
    if (cap.queuedBytes > 0) return Promise.resolve({ pcm: take(cap), ended: false });
    if (cap.ended) return Promise.resolve({ pcm: null, ended: true, reason: cap.reason ?? "a captura de áudio terminou" });

    const wait = Math.max(0, Math.min(SCREEN_AUDIO_MAX_WAIT_MS, Math.round(Number(maxWaitMs) || 0)));
    return new Promise(resolve => {
        wake(cap);
        const done = () => {
            clearTimeout(timer);
            if (cap.waiter === done) cap.waiter = null;
            if (cap.queuedBytes > 0) resolve({ pcm: take(cap), ended: false });
            else if (cap.ended) resolve({ pcm: null, ended: true, reason: cap.reason ?? "a captura de áudio terminou" });
            else resolve({ pcm: null, ended: false });
        };
        const timer = setTimeout(done, wait);
        cap.waiter = done;
    });
}

/** Para a captura (`id` omitido = qualquer uma). Seguro de chamar a qualquer momento. */
export function stopScreenAudioMain(id?: number, reason = "captura de áudio parada") {
    const cap = current;
    if (!cap || (id !== undefined && cap.id !== id)) return;
    current = null;
    finish(cap, reason);
    stopChild(cap.child);
}

/** Bytes descartados por o renderer nao ter lido a tempo (diagnostico). */
export function screenAudioDroppedBytes(): number {
    return current?.droppedBytes ?? 0;
}
