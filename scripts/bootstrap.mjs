/*
 * Telinha - one-time (and idempotent) developer setup:
 *
 *   pnpm bootstrap [--force]
 *
 *   1. installs this repo's own dependencies (pnpm install --frozen-lockfile)
 *   2. fetches the official Vencord commit pinned in vencord.json into .vencord/ (shallow, depth 1; gitignored)
 *   3. installs Vencord's dependencies from Vencord's own lockfile (frozen), inside .vencord/
 *   4. builds the official Vencord into .vencord/dist (pnpm build --standalone --disable-updater): the Vencord the
 *      add-on's smoke, ABI check and offline tests run against
 *
 * Steps 2-4 are skipped when already done for the pinned commit (stamps in .vencord/node_modules and .vencord/dist).
 * --force redoes them and discards local edits inside .vencord/. Changing vencord.json and re-running moves .vencord.
 * Nothing here touches Discord, %APPDATA%\Vencord or %APPDATA%\Telinha.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { checkoutCommit, readPin, REPO, VENCORD_DIR, VENCORD_DIST } from "./vencord.mjs";

const force = process.argv.includes("--force");
const pin = readPin();
const short = pin.commit.slice(0, 8);

function die(msg) {
    console.error(`\n[bootstrap] FAILED - ${msg}`);
    process.exit(1);
}

const log = msg => console.log(`[bootstrap] ${msg}`);

const git = (args, opts = {}) => execFileSync("git", args, { cwd: VENCORD_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();

// Child pnpm runs get a clean environment: no npm_* variables or node_modules/.bin PATH entries from the outer
// `pnpm bootstrap`, so .vencord/ installs and builds exactly as a fresh Vencord checkout would.
function childEnv(extra = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(npm_|pnpm_script_src_dir$|init_cwd$)/i.test(k)) continue;
        env[k] = v;
    }
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === "PATH");
    if (pathKey) env[pathKey] = env[pathKey].split(process.platform === "win32" ? ";" : ":").filter(p => !/[\\/]node_modules[\\/]\.bin$/i.test(p)).join(process.platform === "win32" ? ";" : ":");
    return { ...env, ...extra };
}

function pnpm(args, cwd, extraEnv) {
    // When started by pnpm, reuse the very same pnpm (npm_execpath); otherwise the one on PATH (pnpm.cmd needs a shell).
    const execPath = process.env.npm_execpath;
    const viaNode = execPath && /\.(c|m)?js$/.test(execPath);
    const r = viaNode
        ? spawnSync(process.execPath, [execPath, ...args], { cwd, stdio: "inherit", env: childEnv(extraEnv) })
        : spawnSync("pnpm", args, { cwd, stdio: "inherit", env: childEnv(extraEnv), shell: process.platform === "win32" });
    if (r.status !== 0) die(`pnpm ${args.join(" ")} (in ${cwd}) exited with ${r.status ?? r.error}`);
}

const readJson = file => {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return null;
    }
};

// ------------------------------------------------------------------------------------------- 1. our dependencies
log("installing Telinha's dependencies (frozen lockfile)");
pnpm(["install", "--frozen-lockfile"], REPO);

// ------------------------------------------------------------------------------------------- 2. Vencord checkout
mkdirSync(VENCORD_DIR, { recursive: true });
if (!existsSync(join(VENCORD_DIR, ".git"))) {
    log(`creating ${VENCORD_DIR}`);
    git(["init", "--quiet"]);
}
const before = checkoutCommit();
const localEdits = before ? git(["status", "--porcelain", "--untracked-files=no"]) : "";
if (localEdits && !force) die(`.vencord has local edits to Vencord's files (git -C .vencord status). Re-run with --force to discard them.\n${localEdits}`);

if (before !== pin.commit || force) {
    log(`fetching Vencord ${pin.version} @ ${short} from ${pin.repository} (depth 1)`);
    git(["fetch", "--quiet", "--depth", "1", "--no-tags", pin.repository, pin.commit], { stdio: ["ignore", "pipe", "inherit"] });
    git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", pin.commit]);
} else {
    log(`.vencord already at ${short}`);
}
const head = checkoutCommit();
if (head !== pin.commit) die(`.vencord is at ${head} after checkout, expected ${pin.commit}`);
const vencordPkg = readJson(join(VENCORD_DIR, "package.json"));
if (vencordPkg?.version !== pin.version) die(`.vencord/package.json says version ${vencordPkg?.version}, vencord.json says ${pin.version}`);

// ------------------------------------------------------------------------------------------- 3. Vencord dependencies
const lockHash = createHash("sha256").update(readFileSync(join(VENCORD_DIR, "pnpm-lock.yaml"))).digest("hex");
const installStamp = join(VENCORD_DIR, "node_modules", ".telinha-bootstrap.json");
const installed = readJson(installStamp);
if (force || installed?.commit !== pin.commit || installed?.lockHash !== lockHash) {
    log("installing Vencord's dependencies from its own lockfile (frozen)");
    pnpm(["install", "--frozen-lockfile"], VENCORD_DIR);
    writeFileSync(installStamp, JSON.stringify({ commit: pin.commit, lockHash, at: new Date().toISOString() }, null, 4) + "\n");
} else {
    log("Vencord's dependencies already installed");
}

// ------------------------------------------------------------------------------------------- 4. official Vencord build
const buildStamp = join(VENCORD_DIST, ".telinha-bootstrap.json");
const DIST_FILES = ["patcher.js", "preload.js", "renderer.js"];
if (force || readJson(buildStamp)?.commit !== pin.commit || !DIST_FILES.every(f => existsSync(join(VENCORD_DIST, f)))) {
    log("building the official Vencord: pnpm build --standalone --disable-updater");
    // VENCORD_REMOTE: what an official build embeds as its repo (it would otherwise read `git remote get-url origin`)
    pnpm(["build", "--standalone", "--disable-updater"], VENCORD_DIR, { VENCORD_REMOTE: "Vendicated/Vencord" });
    for (const f of DIST_FILES) if (!existsSync(join(VENCORD_DIST, f))) die(`the Vencord build did not produce dist/${f}`);
    const header = readFileSync(join(VENCORD_DIST, "renderer.js"), "utf8").split("\n", 1)[0];
    const builtFrom = /^\/\/ Vencord ([0-9a-f]{7,})/.exec(header)?.[1];
    if (!builtFrom || !pin.commit.startsWith(builtFrom)) die(`.vencord/dist/renderer.js header is "${header}", expected Vencord ${short}`);
    writeFileSync(buildStamp, JSON.stringify({ commit: pin.commit, header, at: new Date().toISOString() }, null, 4) + "\n");
} else {
    log("official Vencord build already in .vencord/dist");
}

log(`ready: Vencord ${pin.version} @ ${short} in .vencord/ (sources, dependencies, dist)`);
