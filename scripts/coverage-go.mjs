/*
 * Telinha - statement coverage of the Go installer (installer/):
 *
 *   pnpm test:coverage:go [--retries <n>]
 *
 *   1. `go test -coverprofile -coverpkg=<all but internal/testutil>` once per package (`go list ./...`): code counts as
 *      covered when ANY package's tests run it (e.g. internal/winver from main_test.go), and a package can be retried
 *      alone: Windows Smart App
 *      Control / WDAC on some PCs blocks freshly built test binaries at random ("An Application Control policy has
 *      blocked this file", "Access is denied" on fork/exec). A blocked package is retried up to --retries times
 *      (default 4), each retry linked with a random -buildid so the new test binary has another hash than the one
 *      Windows just refused; a real test failure is not retried.
 *   2. merges the profiles into coverage/go/coverage.out (go tool cover -html=coverage/go/coverage.out to browse)
 *   3. prints coverage per package and per file plus the total; coverage/go/summary.json has the same numbers
 *
 * Go has statement coverage only (no branches). The tests build fake Discord/Vencord trees in temp folders
 * (internal/testutil): nothing here runs the installer for real or touches %APPDATA% / %LOCALAPPDATA%.
 * Exit code 1 when a package failed (or stayed blocked).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = join(REPO, "installer");
const OUT = join(REPO, "coverage", "go");
const argv = process.argv.slice(2);
const retries = argv.includes("--retries") ? Number(argv[argv.indexOf("--retries") + 1]) : 4;
const BLOCKED_RE = /Application Control policy|pol[ií]tica de Controle de Aplicativo|blocked by group policy|blocked by your administrator|Access is denied|Acesso negado|The system cannot execute the specified program|Operation did not complete successfully because the file contains a virus/i;

const log = msg => console.log(`[coverage:go] ${msg}`);

function goBinary() {
    const probe = spawnSync("go", ["version"], { encoding: "utf8" });
    if (probe.status === 0) return "go";
    const fallback = join(process.env.ProgramFiles ?? "C:\\Program Files", "Go", "bin", "go.exe");
    if (existsSync(fallback)) return fallback;
    console.error("[coverage:go] FAILED - go not found (install Go 1.26+)");
    process.exit(1);
}

const GO = goBinary();
const go = (args, opts = {}) => spawnSync(GO, args, { cwd: INSTALLER, encoding: "utf8", env: { ...process.env, CGO_ENABLED: "0" }, ...opts });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const list = go(["list", "./..."]);
if (list.status !== 0) {
    console.error(list.stderr);
    process.exit(1);
}
const packages = list.stdout.split(/\r?\n/).filter(Boolean);
const module = packages[0];
const shortName = pkg => (pkg === module ? "installer" : pkg.slice(module.length + 1));

// internal/testutil only builds fake trees for the tests: not product code
const coverpkg = packages.filter(p => !p.endsWith("/internal/testutil")).join(",");

const results = [];
for (const pkg of packages) {
    const profile = join(OUT, `${shortName(pkg).replace(/[\\/]/g, "_")}.out`);
    let r;
    let attempt = 0;
    for (;;) {
        attempt++;
        // a retry relinks with a random build ID: the same binary again would be blocked again (Windows judges its hash)
        const relink = attempt > 1 ? [`-ldflags=-buildid=${randomBytes(8).toString("hex")}`] : [];
        r = go(["test", "-covermode=set", `-coverpkg=${coverpkg}`, `-coverprofile=${profile}`, ...relink, pkg]);
        const output = `${r.stdout}\n${r.stderr}`;
        if (r.status === 0 || !BLOCKED_RE.test(output) || attempt > retries) break;
        log(`${shortName(pkg)}: test binary blocked by Windows (attempt ${attempt}), retrying`);
    }
    const output = `${r.stdout}\n${r.stderr}`.trim();
    const blocked = r.status !== 0 && BLOCKED_RE.test(output);
    const status = r.status === 0 ? "ok" : blocked ? "blocked" : "FAIL";
    // with -coverpkg this is the share of ALL packages that this package's tests run
    const reported = /coverage: ([\d.]+)% of statements/.exec(output)?.[1];
    results.push({ pkg, name: shortName(pkg), status, attempts: attempt, profile: existsSync(profile) ? profile : null, reported: reported ? Number(reported) : null });
    if (status !== "ok") console.error(output);
    log(`${shortName(pkg).padEnd(18)} ${status}${reported ? `  (its tests run ${reported}% of all statements)` : ""}${attempt > 1 ? `  (${attempt} attempts)` : ""}`);
}

// ------------------------------------------------------------------------------------------- merge + per file
// profile line: <import path>/<file>.go:<startLine>.<startCol>,<endLine>.<endCol> <statements> <count>
const blocks = new Map();
for (const { profile } of results) {
    if (!profile) continue;
    for (const line of readFileSync(profile, "utf8").split(/\r?\n/).slice(1)) {
        const m = /^(.+):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        const prev = blocks.get(key);
        blocks.set(key, { file: m[1], statements: Number(m[3]), count: Math.max(Number(m[4]), prev?.count ?? 0) });
    }
}
writeFileSync(join(OUT, "coverage.out"), "mode: set\n" + [...blocks].map(([key, b]) => `${key} ${b.statements} ${b.count ? 1 : 0}`).join("\n") + "\n");

const pct = (covered, total) => (total ? Math.round(covered / total * 1000) / 10 : 100);
const files = {};
const pkgs = {};
for (const b of blocks.values()) {
    const rel = b.file.startsWith(module + "/") ? b.file.slice(module.length + 1) : b.file;
    const pkgName = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "installer";
    for (const [map, key] of [[files, rel], [pkgs, pkgName]]) {
        const e = map[key] ??= { statements: 0, covered: 0 };
        e.statements += b.statements;
        if (b.count) e.covered += b.statements;
    }
}
for (const map of [files, pkgs]) for (const e of Object.values(map)) e.pct = pct(e.covered, e.statements);
const total = Object.values(files).reduce((acc, e) => ({ statements: acc.statements + e.statements, covered: acc.covered + e.covered }), { statements: 0, covered: 0 });
total.pct = pct(total.covered, total.statements);

console.log("\nGo statement coverage (installer/)");
console.log(`${"File".padEnd(44)} ${"Stmts".padStart(6)} ${"Covered".padStart(8)} ${"%".padStart(6)}`);
for (const [name, e] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
    console.log(`${name.padEnd(44)} ${String(e.statements).padStart(6)} ${String(e.covered).padStart(8)} ${e.pct.toFixed(1).padStart(6)}`);
console.log("\nPer package:");
for (const [name, e] of Object.entries(pkgs).sort(([a], [b]) => a.localeCompare(b)))
    console.log(`  ${name.padEnd(20)} ${e.pct.toFixed(1).padStart(5)}%  (${e.covered}/${e.statements})`);
console.log(`\nTotal: ${total.pct.toFixed(1)}% of statements (${total.covered}/${total.statements})`);
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ total, packages: pkgs, files, runs: results.map(({ profile, ...r }) => r) }, null, 4) + "\n");
log(`profile: ${join(OUT, "coverage.out")}, summary: ${join(OUT, "summary.json")}`);

const bad = results.filter(r => r.status !== "ok");
if (bad.length) console.error(`[coverage:go] ${bad.map(r => `${r.name} ${r.status}`).join(", ")}`);
process.exit(bad.length ? 1 : 0);
