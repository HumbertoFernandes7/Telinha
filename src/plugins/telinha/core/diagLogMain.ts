/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts (nunca pelo renderer; o build recusa fs la).
//
// Registro do Telinha em arquivo (o renderer manda as linhas em lotes: core/diagLog.ts): %APPDATA%\Telinha\logs\
// renderer.log, ao lado do main.log do loader. Pequeno e com rotacao: um lote que passaria de DIAG_LOG_MAX_BYTES faz o
// arquivo virar renderer.log.1 (o .1 anterior some), entao o disco nunca guarda mais que ~2x isso. Serve para o
// diagnostico compartilhado levar o fim da sessao ANTERIOR (o Discord travou e foi reaberto: o buffer da memoria se
// perdeu). Tudo assincrono e em fila (uma operacao por vez, na ordem em que chegaram); erro vira false / [] (nunca lanca
// para o renderer). Nada roda no carregamento do modulo.

import { app } from "electron";
import { promises as fs } from "fs";
import { dirname, join } from "path";

export const DIAG_LOG_FILE = "renderer.log";
/** tamanho em que o arquivo roda para .1 */
export const DIAG_LOG_MAX_BYTES = 100 * 1024;
/** linhas que readDiagLogMain devolve (as ultimas) */
export const DIAG_LOG_TAIL_LINES = 500;
/** maior lote aceito do renderer (ele manda no maximo 100 linhas de ~1 KB) */
export const DIAG_LOG_MAX_APPEND_CHARS = 128 * 1024;

let dirForTests: string | null = null;

/** Testes: a pasta do registro (nunca a %APPDATA% de verdade). null = a de verdade. */
export function setDiagLogDirForTests(dir: string | null) {
    dirForTests = dir;
}

function logFile(): string {
    return join(dirForTests ?? join(app.getPath("appData"), "Telinha", "logs"), DIAG_LOG_FILE);
}

let queue: Promise<unknown> = Promise.resolve();

/** Uma operacao por vez, na ordem: a leitura nunca pega uma rotacao pela metade. `fn` nunca rejeita (trata os proprios erros). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run;
    return run;
}

/** Acrescenta um lote (linhas terminadas em "\n") ao registro, rodando para .1 antes de passar do limite. false = nao gravou. */
export function appendDiagLogMain(text: unknown): Promise<boolean> {
    if (typeof text !== "string" || !text || text.length > DIAG_LOG_MAX_APPEND_CHARS) return Promise.resolve(false);
    const chunk = text.endsWith("\n") ? text : text + "\n";
    return serial(async () => {
        try {
            const file = logFile();
            await fs.mkdir(dirname(file), { recursive: true });
            const size = await fs.stat(file).then(s => s.size, () => 0);
            if (size > 0 && size + Buffer.byteLength(chunk) > DIAG_LOG_MAX_BYTES) await fs.rename(file, file + ".1");
            await fs.appendFile(file, chunk, "utf8");
            return true;
        } catch {
            return false;
        }
    });
}

/** As ultimas DIAG_LOG_TAIL_LINES linhas do registro (renderer.log.1 + renderer.log), mais antiga primeiro. [] = nada. */
export function readDiagLogMain(): Promise<string[]> {
    return serial(async () => {
        try {
            const file = logFile();
            const read = (path: string) => fs.readFile(path, "utf8").catch(() => "");
            const text = await read(file + ".1") + await read(file);
            return text.split(/\r?\n/).filter(Boolean).slice(-DIAG_LOG_TAIL_LINES);
        } catch {
            return [];
        }
    });
}
