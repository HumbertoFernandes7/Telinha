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
// Nada roda no carregamento do modulo.

import { readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { release } from "os";
import { isAbsolute } from "path";

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
