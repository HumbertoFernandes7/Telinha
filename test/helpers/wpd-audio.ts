/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Auxiliares do WP-D (audio da tela e natives do main): construtor de PCM, um "Windows 10 com o telinha-audio.exe"
// de mentira (exe vazio numa pasta temporaria + os.release/process.platform trocados) e atalhos para dirigir um
// FakeChildProcess como o helper (ou o PowerShell) faria. Nada aqui executa processo de verdade.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { setScreenAudioHelperPathForTests } from "@plugins/telinha/core/audio/screenAudioMain";
import { type FakeChildProcess, mockSpawn, type SpawnEnv } from "@test/fakes/childProcess";
import { flushPromises } from "@test/fakes/clock";

/** `frames` frames de PCM float32 estereo intercalado: o frame k vale L = first + k, R = -(first + k). */
export function pcm(frames: number, first = 1): Buffer {
    const out = Buffer.alloc(frames * 8);
    for (let k = 0; k < frames; k++) {
        out.writeFloatLE(first + k, k * 8);
        out.writeFloatLE(-(first + k), k * 8 + 4);
    }
    return out;
}

/** Os floats de um PCM devolvido pelo main (copia: a view pode nao estar alinhada). */
export function floatsOf(bytes: Uint8Array): number[] {
    const copy = bytes.slice();
    return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength / 4));
}

/** Troca process.platform ate o fim do teste. */
export function setPlatform(t: TestContext, platform: NodeJS.Platform) {
    const before = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...before, value: platform });
    t.after(() => Object.defineProperty(process, "platform", before));
}

export interface HelperHost {
    /** caminho do "telinha-audio.exe" (arquivo vazio) usado pelo screenAudioMain */
    exe: string;
    /** troca o build do Windows que os.release() informa */
    setBuild(build: number | string): void;
    /** troca o process.platform */
    setPlatform(platform: NodeJS.Platform): void;
    /** cria ou apaga o exe */
    setExe(present: boolean): void;
}

/**
 * Faz o screenAudioMain achar um Windows 10 21H2 com o ajudante instalado. `exe: false` = o arquivo nao existe;
 * `build` troca o os.release(); `platform` o process.platform. Tudo desfeito no fim do teste.
 */
export function helperHost(t: TestContext, opts: { build?: number | string; exe?: boolean; platform?: NodeJS.Platform; } = {}): HelperHost {
    const dir = mkdtempSync(join(tmpdir(), "tl-wpd-"));
    const exe = join(dir, "telinha-audio.exe");
    const releaseOf = (build: number | string) => (typeof build === "string" ? build : `10.0.${build}`);
    let release = releaseOf(opts.build ?? 22631);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const setHostPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    const setExe = (present: boolean) => {
        if (present) writeFileSync(exe, "not a real exe");
        else rmSync(exe, { force: true });
    };

    setExe(opts.exe !== false);
    setScreenAudioHelperPathForTests(exe);
    t.mock.method(os, "release", () => release);
    setHostPlatform(opts.platform ?? "win32");
    t.after(() => {
        Object.defineProperty(process, "platform", originalPlatform);
        setScreenAudioHelperPathForTests(null);
        rmSync(dir, { recursive: true, force: true });
    });
    return {
        exe,
        setBuild(build) {
            release = releaseOf(build);
        },
        setPlatform: setHostPlatform,
        setExe
    };
}

/** Escreve no stdout do helper e deixa o evento "data" chegar. */
export async function feed(proc: FakeChildProcess, data: string | Buffer) {
    proc.writeStdout(data);
    await flushPromises();
}

/** Escreve no stderr do helper e deixa o evento "data" chegar. */
export async function feedErr(proc: FakeChildProcess, data: string | Buffer) {
    proc.writeStderr(data);
    await flushPromises();
}

/** O helper (ou o PowerShell) responde: stderr/stdout opcionais e a saida, tudo em um turno do event loop. */
export function answer(proc: FakeChildProcess, opts: { stdout?: string; stderr?: string; code?: number | null; signal?: NodeJS.Signals | null; } = {}) {
    setImmediate(async () => {
        if (opts.stderr) await feedErr(proc, opts.stderr);
        if (opts.stdout) await feed(proc, opts.stdout);
        proc.exit(opts.code === undefined ? 0 : opts.code, opts.signal ?? null);
    });
}

/** Windows com o PowerShell de mentira: cada busca de PID recebe a proxima resposta da lista (a ultima se repete). */
export function powershellHost(t: TestContext, ...answers: { stdout?: string; code?: number | null; }[]): SpawnEnv {
    setPlatform(t, "win32");
    let n = 0;
    return mockSpawn(t, p => answer(p, answers[Math.min(n++, answers.length - 1)]));
}
