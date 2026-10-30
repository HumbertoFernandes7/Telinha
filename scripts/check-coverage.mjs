/*
 * Telinha - coverage floor: CI fails when coverage drops below the numbers committed in coverage-floor.json, and the
 * floor only ever goes up (a ratchet):
 *
 *   node scripts/check-coverage.mjs [check|ratchet] [--only js|go] [--js <file>] [--go <file>] [--floor <file>] [--summary <file>]
 *   pnpm coverage:check      compares the current coverage with the floor (exit 1 when anything is below it)
 *   pnpm coverage:ratchet    raises every floor to the current coverage, never lowers one, rewrites coverage-floor.json
 *
 *   - TypeScript: lines, statements, functions and branches of the whole run (total of coverage/coverage-summary.json,
 *     written by `pnpm test:coverage`; --js changes the file)
 *   - Go: statement coverage per package, read from the text of `go test -count=1 -cover ./...` run in installer/ (one
 *     "ok <package> <time> coverage: X% of statements" line each; CI keeps it in $RUNNER_TEMP/go-test.txt and passes it
 *     with --go, locally the default is coverage/go-test.txt). Packages without tests (internal/testutil) have no "ok"
 *     line and no floor. It is NOT coverage/go/summary.json of `pnpm test:coverage:go`: that one counts code run by any
 *     package's tests, so it is higher than what CI measures and would raise the floor out of CI's reach. Anything
 *     before "ok" on a line is ignored, so a green CI run's log (gh run view <id> --log) can be fed as it is.
 *
 * A floor is the current coverage rounded down to 0.1 minus 0.1 (noise margin), so check and ratchet agree and a run that
 * measures a hair less than the last one does not fail the build. check also hints "raise the floor" for what is more
 * than 0.5 points above its floor. A package that shows up without a floor is only noted (ratchet adds it); a floor
 * whose package has no coverage line any more fails (removed it? delete its line from coverage-floor.json by hand). A
 * deliberate drop is the same: lower the number by hand in the PR that causes it, where a reviewer sees it.
 * --only limits both modes to one side. --summary appends a markdown table (CI puts it in the job summary).
 * Exit code: check 1 when anything is below its floor, missing or a source file is absent; ratchet 1 only when it could
 * read nothing. Nothing here runs a test or touches Discord or %APPDATA%.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JS_METRICS = ["lines", "statements", "functions", "branches"];
const MARGIN = 0.1;
const HINT_GAP = 0.5;
const EPS = 1e-9;

const argv = process.argv.slice(2);
const opt = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const mode = argv[0] && !argv[0].startsWith("--") ? argv[0] : "check";
const only = opt("--only");
const jsFile = resolve(opt("--js") ?? join(REPO, "coverage", "coverage-summary.json"));
const goFile = resolve(opt("--go") ?? join(REPO, "coverage", "go-test.txt"));
const floorFile = resolve(opt("--floor") ?? join(REPO, "coverage-floor.json"));
const summaryFile = opt("--summary");

const die = msg => {
    console.error(`[coverage-floor] FAILED - ${msg}`);
    process.exit(1);
};
if (!["check", "ratchet"].includes(mode)) die(`unknown mode "${mode}" (check or ratchet)`);
if (only && !["js", "go"].includes(only)) die(`--only takes js or go, not "${only}"`);

const shown = file => relative(REPO, file).replace(/\\/g, "/") || file;
const fmt = n => n.toFixed(2);
// the floor for a measured percentage: rounded down to 0.1, minus the margin (the +1e-6 keeps 99.3 * 10 = 992.99.. from
// losing a tenth)
const floorOf = pct => Math.max(0, Math.floor(pct * 10 + 1e-6) - Math.round(MARGIN * 10)) / 10;

// ------------------------------------------------------------------------------------------- what was measured
function readJs() {
    if (!existsSync(jsFile)) return { error: `no TypeScript summary at ${shown(jsFile)} (run pnpm test:coverage first)` };
    const total = JSON.parse(readFileSync(jsFile, "utf8")).total ?? {};
    const values = {};
    for (const metric of JS_METRICS) if (typeof total[metric]?.pct === "number") values[metric] = total[metric].pct;
    return { values };
}

function readGo() {
    if (!existsSync(goFile)) return { error: `no go test output at ${shown(goFile)} (cd installer && go test -count=1 -cover ./... > ../coverage/go-test.txt)` };
    const module = /^module\s+(\S+)/m.exec(readFileSync(join(REPO, "installer", "go.mod"), "utf8"))?.[1];
    const values = {};
    for (const line of readFileSync(goFile, "utf8").split(/\r?\n/)) {
        const m = /\bok\s+(\S+)\s+(?:\(cached\)|[\d.]+s)\s+coverage: ([\d.]+)% of statements/.exec(line);
        if (!m) continue;
        // same names as pnpm test:coverage:go: the module root is "installer", the rest relative to it
        values[m[1] === module ? "installer" : module && m[1].startsWith(`${module}/`) ? m[1].slice(module.length + 1) : m[1]] = Number(m[2]);
    }
    return Object.keys(values).length ? { values } : { error: `no "ok <package> ... coverage: X% of statements" line in ${shown(goFile)}` };
}

let floors;
if (existsSync(floorFile)) floors = JSON.parse(readFileSync(floorFile, "utf8"));
else if (mode === "check") die(`no floor file at ${shown(floorFile)} (pnpm coverage:ratchet creates it)`);
else floors = {};

const sections = [];
if (only !== "go") sections.push({ id: "js", title: "TypeScript (pnpm test:coverage)", ...readJs(), names: [...new Set([...JS_METRICS, ...Object.keys(floors.js ?? {})])] });
if (only !== "js") sections.push({ id: "go", title: "Go installer (go test -cover)", ...readGo(), names: null });

for (const section of sections) {
    section.rows = [];
    if (!section.values) continue;
    const names = section.names ?? [...new Set([...Object.keys(section.values), ...Object.keys(floors.go ?? {})])].sort((a, b) => a.localeCompare(b));
    for (const name of names) section.rows.push({ name, current: section.values[name] ?? null, floor: floors[section.id]?.[name] ?? null });
}

const statusOf = r =>
    r.current == null ? "missing"
        : r.floor == null ? "new"
            : r.current + EPS < r.floor ? "below"
                : r.current - r.floor > HINT_GAP ? "raise"
                    : "ok";
const LABEL = {
    ok: "ok",
    raise: "ok",
    below: "BELOW THE FLOOR",
    missing: "MISSING (no coverage line any more)",
    new: "new, no floor yet"
};
const HINT = "raise the floor: pnpm coverage:ratchet";

// ------------------------------------------------------------------------------------------- check
function check() {
    const problems = [];
    const markdown = ["### Coverage floor", "", `Floor: \`${shown(floorFile)}\`. It only goes up: \`pnpm coverage:ratchet\` raises it to what a run measures.`, ""];
    console.log(`Coverage vs floor (${shown(floorFile)})`);
    for (const section of sections) {
        console.log(`\n${section.title}`);
        markdown.push(`**${section.title}**`, "");
        if (section.error) {
            console.log(`  ${section.error}`);
            markdown.push(`_${section.error}_`, "");
            problems.push(section.error);
            continue;
        }
        console.log(`  ${"".padEnd(34)} ${"current".padStart(8)} ${"floor".padStart(8)} ${"margin".padStart(8)}`);
        markdown.push("| | current | floor | margin | |", "|---|---:|---:|---:|---|");
        for (const row of section.rows) {
            const status = statusOf(row);
            const cur = row.current == null ? "-" : fmt(row.current);
            const flo = row.floor == null ? "-" : fmt(row.floor);
            const gap = row.current == null || row.floor == null ? "" : `${row.current >= row.floor ? "+" : ""}${fmt(row.current - row.floor)}`;
            console.log(`  ${row.name.padEnd(34)} ${cur.padStart(8)} ${flo.padStart(8)} ${gap.padStart(8)}  ${LABEL[status]}`);
            if (status === "raise" || status === "new") console.log(`    ${HINT}`);
            const note = status === "below" || status === "missing" ? `**${LABEL[status]}**` : status === "raise" || status === "new" ? `${LABEL[status]}, ${HINT.replace("pnpm coverage:ratchet", "`pnpm coverage:ratchet`")}` : LABEL[status];
            markdown.push(`| ${row.name} | ${row.current == null ? "-" : `${cur}%`} | ${row.floor == null ? "-" : `${flo}%`} | ${gap} | ${note} |`);
            if (status === "below") problems.push(`${section.id} ${row.name}: ${fmt(row.current)}% is below its floor of ${fmt(row.floor)}%`);
            if (status === "missing") problems.push(`${section.id} ${row.name}: no coverage line in ${shown(section.id === "js" ? jsFile : goFile)}, floor is ${fmt(row.floor)}%`);
        }
        markdown.push("");
    }
    console.log(problems.length ? `\nCoverage is below the committed floor (${problems.length}):` : "\nCoverage is at or above the floor.");
    for (const p of problems) {
        console.log(`  - ${p}`);
        if (process.env.GITHUB_ACTIONS) console.log(`::error title=Coverage floor::${p}. Add tests, or lower coverage-floor.json by hand if the drop is deliberate.`);
    }
    markdown.push(problems.length ? `**Below the floor:** ${problems.map(p => `\`${p}\``).join(", ")}` : "At or above the floor.", "");
    if (summaryFile) appendFileSync(summaryFile, markdown.join("\n") + "\n");
    process.exit(problems.length ? 1 : 0);
}

// ------------------------------------------------------------------------------------------- ratchet
function ratchet() {
    const next = { js: { ...floors.js }, go: { ...floors.go } };
    let read = 0;
    let raised = 0;
    for (const section of sections) {
        if (section.error) {
            console.log(`[coverage-floor] ${section.id}: skipped, ${section.error}`);
            continue;
        }
        read++;
        for (const row of section.rows) {
            if (row.current == null) {
                if (row.floor != null) console.log(`[coverage-floor] ${section.id} ${row.name}: not measured, floor stays ${fmt(row.floor)}`);
                continue;
            }
            const target = floorOf(row.current);
            if (row.floor == null || target > row.floor + EPS) {
                next[section.id][row.name] = target;
                raised++;
                console.log(`[coverage-floor] ${section.id} ${row.name}: ${row.floor == null ? "new floor" : `${fmt(row.floor)} ->`} ${fmt(target)} (measured ${fmt(row.current)})`);
            } else if (row.current + EPS < row.floor) {
                console.log(`[coverage-floor] ${section.id} ${row.name}: ${fmt(row.current)} is below its floor ${fmt(row.floor)}, not lowered (fix the coverage, or lower the floor by hand)`);
            }
        }
    }
    if (!read) die("nothing to ratchet: no coverage source could be read");
    if (!raised) {
        console.log("[coverage-floor] nothing to raise");
        return;
    }
    const ordered = Object.fromEntries(Object.entries(next.go).sort(([a], [b]) => a.localeCompare(b)));
    const js = Object.fromEntries([...JS_METRICS, ...Object.keys(next.js).filter(k => !JS_METRICS.includes(k))].filter(k => k in next.js).map(k => [k, next.js[k]]));
    writeFileSync(floorFile, JSON.stringify({ js, go: ordered }, null, 4) + "\n");
    console.log(`[coverage-floor] ${raised} floor(s) raised in ${shown(floorFile)}: commit it`);
}

if (mode === "check") check();
else ratchet();
