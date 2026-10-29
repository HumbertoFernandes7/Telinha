/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Big test-only packages loaded as ONE pre-bundled CommonJS file. Under tsx every file a package loads goes through
// its hooks: happy-dom (600+ ESM files) took ~2 s per test process that way (and ~30 s through import()), the bundle
// ~0.1 s. The bundle is built once with esbuild into node_modules/.cache/telinha-tests/ and rebuilt when
// pnpm-lock.yaml changes. React stays external (the tests and the plugin must share one React).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const CACHE = join(ROOT, "node_modules", ".cache", "telinha-tests");
const requireHere = createRequire(__filename);

let lockHash: string | null = null;

function lockfileHash() {
    lockHash ??= createHash("sha256").update(readFileSync(join(ROOT, "pnpm-lock.yaml"))).digest("hex").slice(0, 12);
    return lockHash;
}

/**
 * require() of `entry` (a package name) bundled into a single file. `external`: packages left as require() calls
 * (resolved from node_modules as usual).
 */
export function requireBundled<T>(name: string, entry: string, external: string[] = []): T {
    const key = createHash("sha256").update(JSON.stringify([lockfileHash(), entry, external])).digest("hex").slice(0, 12);
    const file = join(CACHE, `${name}-${key}.cjs`);
    if (!existsSync(file)) {
        mkdirSync(CACHE, { recursive: true });
        const esbuild = requireHere("esbuild") as typeof import("esbuild");
        const out = esbuild.buildSync({
            stdin: { contents: `export * from ${JSON.stringify(entry)};`, resolveDir: ROOT, loader: "js" },
            bundle: true, platform: "node", format: "cjs", target: "node22", write: false, logLevel: "error", external
        });
        // several test processes may build at once: write aside, then rename (the first one wins)
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, out.outputFiles[0].contents);
        try {
            renameSync(tmp, file);
        } catch {
            rmSync(tmp, { force: true });
            if (!existsSync(file)) throw new Error(`could not write the test bundle ${file}`);
        }
    }
    return requireHere(file) as T;
}
