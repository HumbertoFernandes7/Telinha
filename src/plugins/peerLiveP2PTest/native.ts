/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ConnectSrc, CspPolicies } from "@main/csp";
import { app, IpcMainInvokeEvent, shell } from "electron";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

import { RELAY_URLS } from "./protocol";

// O CSP do Discord bloqueia wss:// arbitrario no renderer. Este modulo e carregado no
// processo main na inicializacao (habilitado ou nao o plugin), entao basta adicionar os
// relays aqui. So passa a valer depois de FECHAR e abrir o Discord de novo (CSP e
// aplicado no carregamento da pagina principal).
for (const url of RELAY_URLS) {
    CspPolicies[url] = ConnectSrc;
}

const LOG_DIR_NAME = "PeerLive-test";
const LOG_FILE_RE = /^p2p-[A-Za-z0-9_-]+\.json$/;

function logDir() {
    return join(app.getPath("appData"), LOG_DIR_NAME);
}

/** Hosts que este modulo adicionou ao connect-src (para o renderer mostrar no diagnostico). */
export function getCspRelays(_: IpcMainInvokeEvent) {
    return RELAY_URLS.filter(url => CspPolicies[url] === ConnectSrc);
}

export function getLogDir(_: IpcMainInvokeEvent) {
    return logDir();
}

/** Grava (sobrescreve) o log JSON da sessao em %APPDATA%\PeerLive-test\<fileName>. Retorna o caminho. */
export async function writeLog(_: IpcMainInvokeEvent, fileName: string, contents: string) {
    if (typeof fileName !== "string" || !LOG_FILE_RE.test(fileName))
        throw new Error("Nome de arquivo de log inválido: " + fileName);
    if (typeof contents !== "string")
        throw new Error("Conteúdo do log inválido");

    const dir = logDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, fileName);
    await writeFile(path, contents, "utf-8");
    return path;
}

export async function openLogDir(_: IpcMainInvokeEvent) {
    const dir = logDir();
    await mkdir(dir, { recursive: true });
    return shell.openPath(dir);
}
