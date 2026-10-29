/*
 * Telinha - test coverage of the plugin (src/plugins/telinha) and the add-on loader (addon/loader):
 *
 *   pnpm test:coverage [--no-addon] [--report-only]
 *
 *   1. runs `pnpm test:unit` and `pnpm test:addon` with NODE_V8_COVERAGE (every child process included); the add-on
 *      tests need dist/addon/payload, built first with `pnpm build:addon` when missing (--no-addon skips them)
 *   2. the add-on tests run COPIES of the loader (fake Discord trees under %TEMP%\tl-addon): coverage of a copy whose
 *      content still starts with the loader file it came from is moved to that file in addon/loader/ (code that
 *      only ran inside node:vm, e.g. register.js glued to the renderer bundle, cannot be mapped and stays out)
 *   3. `c8 report --all` over src/plugins/telinha/** and addon/loader/** (tests excluded): text table + summary on
 *      the console, coverage/lcov.info and coverage/coverage-summary.json
 *
 * --report-only skips step 1 and reports the raw coverage already in coverage/tmp.
 * Exit code: the tests' (a failing test still writes the report). Nothing here touches Discord or %APPDATA%.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, "coverage");
const RAW = join(OUT, "tmp");
const LOADER = join(REPO, "addon", "loader");
const withAddon = !process.argv.includes("--no-addon");
const reportOnly = process.argv.includes("--report-only");

const log = msg => console.log(`[coverage] ${msg}`);
const isWin = process.platform === "win32";

// pnpm's own JS entry when we run under `pnpm test:coverage` (no shell); else pnpm from PATH (pnpm.cmd needs a shell
// on Windows, so arguments with spaces are quoted)
const PNPM_JS = /\.c?js$/.test(process.env.npm_execpath ?? "") ? process.env.npm_execpath : null;
const quote = a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function run(args, env = process.env) {
    log(`pnpm ${args.join(" ")}`);
    const r = PNPM_JS
        ? spawnSync(process.execPath, [PNPM_JS, ...args], { cwd: REPO, env, stdio: "inherit" })
        : spawnSync(isWin ? "pnpm.cmd" : "pnpm", isWin ? args.map(quote) : args, { cwd: REPO, env, stdio: "inherit", shell: isWin });
    return r.status ?? 1;
}

let failed = false;
if (!reportOnly) {
    // only our own outputs: coverage/go/ belongs to test:coverage:go
    for (const f of ["tmp", "lcov.info", "coverage-summary.json", "coverage-final.json"]) rmSync(join(OUT, f), { recursive: true, force: true });
    mkdirSync(RAW, { recursive: true });
    const covEnv = { ...process.env, NODE_V8_COVERAGE: RAW };
    failed = run(["test:unit"], covEnv) !== 0;
    if (withAddon) failed = runAddonTests(covEnv) || failed;
}

function runAddonTests(covEnv) {
    if (!existsSync(join(REPO, "dist", "addon", "payload", "version.json")) && run(["build:addon"]) !== 0) {
        console.error("[coverage] build:addon failed: add-on tests skipped (their coverage is missing from the report)");
        return true;
    }
    return run(["test:addon"], covEnv) !== 0;
}

// ------------------------------------------------------------------------------------------- copies -> addon/loader
const loaderSources = Object.fromEntries(readdirSync(LOADER).filter(f => f.endsWith(".js")).map(f => [f, readFileSync(join(LOADER, f), "utf8")]));
const repoPrefix = pathToFileURL(REPO).href.toLowerCase();
let moved = 0;
for (const name of readdirSync(RAW).filter(f => f.endsWith(".json"))) {
    const file = join(RAW, name);
    const data = JSON.parse(readFileSync(file, "utf8"));
    const kept = [];
    for (const script of data.result ?? []) {
        const { url } = script;
        if (!url?.startsWith("file:")) continue;
        if (url.toLowerCase().startsWith(repoPrefix)) {
            kept.push(script);
            continue;
        }
        // outside the repo: only a loader copy is kept (moved onto its source); vm scripts with made-up names
        // (file:///VencordRenderer) are dropped, c8 cannot even read them
        let path;
        try {
            path = fileURLToPath(url);
        } catch {
            continue;
        }
        const source = loaderSources[basename(path)];
        if (source == null) continue;
        let copy;
        try {
            copy = readFileSync(path, "utf8");
        } catch {
            continue;
        }
        // identical, or a test variant with code appended (the loader's own offsets are unchanged)
        if (!copy.startsWith(source)) continue;
        script.url = pathToFileURL(join(LOADER, basename(path))).href;
        kept.push(script);
        moved++;
    }
    data.result = kept;
    // source maps (tsx's inline ones) only matter for the repo's own files
    const maps = data["source-map-cache"];
    if (maps) for (const key of Object.keys(maps)) if (!key.toLowerCase().startsWith(repoPrefix)) delete maps[key];
    writeFileSync(file, JSON.stringify(data));
}
if (withAddon) log(`${moved} coverage record(s) of loader copies moved to addon/loader/`);

// ------------------------------------------------------------------------------------------- report
const c8 = [
    "exec", "c8", "report", "--all", "--temp-directory", RAW, "--report-dir", OUT, "--src", REPO,
    "--include", "src/plugins/telinha/**", "--include", "addon/loader/**",
    "--exclude", "**/*.test.ts", "--exclude", "**/*.test.tsx",
    // type-only module: nothing to run
    "--exclude", "src/plugins/telinha/types.ts",
    "--extension", ".ts", "--extension", ".tsx", "--extension", ".js",
    "--reporter", "text", "--reporter", "text-summary", "--reporter", "lcovonly", "--reporter", "json-summary", "--reporter", "json"
];
if (run(c8) !== 0) failed = true;
log(`reports: ${join(OUT, "lcov.info")}, ${join(OUT, "coverage-summary.json")}`);
process.exit(failed ? 1 : 0);
