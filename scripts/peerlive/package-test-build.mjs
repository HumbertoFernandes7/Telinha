/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Empacota o build de TESTE do PeerLive (fase de viabilidade) para os amigos instalarem no Windows.
//
// 1. Roda o gate `smokeRenderer.mjs` em dist/renderer.js (aborta se falhar).
// 2. Gera dist/test-package/PeerLive-teste-<hash>.zip com os arquivos de dist (patcher/preload/renderer + .map/.LEGAL),
//    instalar.cmd, restaurar.cmd, peerlive-test.ps1 e LEIA-ME.txt.
// 3. Imprime o caminho e o SHA-256 do zip.
//
// Não roda `pnpm build`: faça o build antes (pnpm build / pnpm buildStandalone).
//
// Uso: node scripts/peerlive/package-test-build.mjs [--dist <pasta>] [--out <pasta>]
//      (ou: pnpm package:test)   --dist e --out existem para testar o empacotador com uma dist falsa.

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { zipSync } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

// Arquivos de dist que o build de teste substitui no Vencord instalado (manter em sincronia com $ManagedFiles do peerlive-test.ps1).
const REQUIRED_DIST_FILES = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
const OPTIONAL_DIST_FILES = [
    "patcher.js.map", "patcher.js.LEGAL.txt",
    "preload.js.map",
    "renderer.js.map", "renderer.js.LEGAL.txt",
    "renderer.css.map"
];
// Plugins que o teste precisa; se o renderer.js não os contém, o build está velho.
const REQUIRED_PLUGINS = ["PeerLiveTest", "PeerLiveP2PTest"];

// [arquivo em disco, caminho dentro do zip, tipo]. "ascii" = .cmd (só ASCII, CRLF); "utf8bom" = UTF-8 com BOM + CRLF.
const SCRIPT_FILES = [
    [join(here, "test-package", "instalar.cmd"), "instalar.cmd", "ascii"],
    [join(here, "test-package", "restaurar.cmd"), "restaurar.cmd", "ascii"],
    [join(here, "peerlive-test.ps1"), "peerlive-test.ps1", "utf8bom"],
    [join(here, "test-package", "LEIA-ME.txt"), "LEIA-ME.txt", "utf8bom"]
];

function fail(message) {
    console.error(`[package:test] FALHOU - ${message}`);
    process.exit(1);
}

function parseArgs(argv) {
    const opts = { dist: join(repoRoot, "dist"), out: join(repoRoot, "dist", "test-package") };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--dist" || arg === "--out") {
            const value = argv[++i];
            if (!value) fail(`${arg} precisa de um valor`);
            opts[arg.slice(2)] = resolve(value);
        } else {
            fail(`argumento desconhecido: ${arg}\nUso: node scripts/peerlive/package-test-build.mjs [--dist <pasta>] [--out <pasta>]`);
        }
    }
    return opts;
}

function readScript(path, kind) {
    if (!existsSync(path)) fail(`arquivo do pacote não encontrado: ${path}`);
    const text = readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r?\n/g, "\r\n");
    if (kind === "ascii") {
        const bad = text.match(/[^\x00-\x7f]/);
        if (bad) fail(`${basename(path)} só pode ter caracteres ASCII (o cmd.exe estraga acentos); achei "${bad[0]}"`);
        return Buffer.from(text, "utf8");
    }
    return Buffer.from("﻿" + text, "utf8");
}

const { dist, out } = parseArgs(process.argv.slice(2));

// ---- 1. gate: smoke test do renderer
const rendererPath = join(dist, "renderer.js");
if (!existsSync(rendererPath)) fail(`${rendererPath} não existe (rode o build antes)`);
console.log(`[package:test] Gate: smokeRenderer em ${rendererPath}`);
const smoke = spawnSync(process.execPath, [join(here, "smokeRenderer.mjs"), rendererPath], { stdio: "inherit" });
if (smoke.status !== 0) fail("o smoke test do renderer falhou; nada foi empacotado");

// ---- 2. arquivos de dist
const missing = REQUIRED_DIST_FILES.filter(f => !existsSync(join(dist, f)));
if (missing.length) fail(`faltam arquivos em ${dist}: ${missing.join(", ")} (rode o build antes)`);

const renderer = readFileSync(rendererPath, "utf8");
const lostPlugins = REQUIRED_PLUGINS.filter(p => !new RegExp(`name:\\s*["']${p}["']`).test(renderer));
if (lostPlugins.length) fail(`o renderer.js não contém o(s) plugin(s) ${lostPlugins.join(", ")} (build desatualizado? rode o build)`);

const patcherFirstLine = readFileSync(join(dist, "patcher.js"), "utf8").split(/\r?\n/, 1)[0];
const shortHash = patcherFirstLine.match(/^\/\/\s*Vencord\s+([A-Za-z0-9._-]+)/)?.[1];
if (!shortHash) fail(`a primeira linha de dist/patcher.js não é "// Vencord <hash>": "${patcherFirstLine.slice(0, 80)}"`);

const buildTime = statSync(join(dist, "patcher.js")).mtime;   // mtime fixo => zip reproduzível para a mesma dist
const entries = {};
for (const file of [...REQUIRED_DIST_FILES, ...OPTIONAL_DIST_FILES]) {
    const path = join(dist, file);
    if (existsSync(path)) entries[`dist/${file}`] = [new Uint8Array(readFileSync(path)), { mtime: buildTime }];
}
for (const [path, zipName, kind] of SCRIPT_FILES) {
    entries[zipName] = [new Uint8Array(readScript(path, kind)), { mtime: buildTime }];
}

// ---- 3. zip
const zip = zipSync(entries, { level: 9 });
mkdirSync(out, { recursive: true });
const zipPath = join(out, `PeerLive-teste-${shortHash}.zip`);
writeFileSync(zipPath, zip);
const sha256 = createHash("sha256").update(zip).digest("hex");

console.log(`\n[package:test] OK - build ${shortHash}, ${Object.keys(entries).length} arquivos no zip:`);
for (const name of Object.keys(entries)) console.log(`    ${name}`);
console.log(`\nZIP:     ${zipPath}`);
console.log(`Tamanho: ${(zip.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`SHA-256: ${sha256}`);
