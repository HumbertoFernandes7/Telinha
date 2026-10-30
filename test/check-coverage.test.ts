/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// scripts/check-coverage.mjs, the coverage floor CI enforces: the script itself, run as a child process on the
// fixtures in test/fixtures/ (a c8 summary and the `go test -cover` output of a green CI run) and on doctored copies of
// them, always against a floor file of its own, never the committed coverage-floor.json (which moves with every ratchet).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const SCRIPT = join(__dirname, "..", "scripts", "check-coverage.mjs");
const GO_OUTPUT = readFileSync(join(__dirname, "fixtures", "go-test-cover.txt"), "utf8");
const JS_SUMMARY = JSON.parse(readFileSync(join(__dirname, "fixtures", "coverage-summary.json"), "utf8"));

// what the fixtures' numbers become: rounded down to 0.1, minus 0.1; internal/testutil (no tests) has none
const FLOOR = {
    js: { lines: 99.7, statements: 99.7, functions: 99.1, branches: 96.5 },
    go: {
        "installer": 98.4,
        "internal/asar": 99.9,
        "internal/core": 98.8,
        "internal/discord": 99.9,
        "internal/fsutil": 98,
        "internal/logx": 99.9,
        "internal/payload": 99.2,
        "internal/stub": 99.9,
        "internal/ui": 95.5,
        "internal/winproc": 93.1,
        "internal/winver": 99.9
    }
};

const jsWith = (metric: string, pct: number) => ({ total: { ...JS_SUMMARY.total, [metric]: { ...JS_SUMMARY.total[metric], pct } } });
const goWith = (pkg: string, pct: string) => GO_OUTPUT.replace(new RegExp(`(${pkg}\\t[\\d.]+s\\tcoverage: )[\\d.]+`), `$1${pct}`);

describe("coverage floor (scripts/check-coverage.mjs)", () => {
    let root: string;

    before(() => {
        root = mkdtempSync(join(tmpdir(), "tl-covfloor-"));
    });

    after(() => {
        rmSync(root, { recursive: true, force: true });
    });

    // a folder of its own per test, with the inputs that were given
    function setup(inputs: { js?: unknown; go?: string; floor?: unknown } = {}) {
        const dir = mkdtempSync(join(root, "t-"));
        const files = { js: join(dir, "coverage-summary.json"), go: join(dir, "go-test.txt"), floor: join(dir, "coverage-floor.json"), summary: join(dir, "summary.md") };
        if (inputs.js !== undefined) writeFileSync(files.js, JSON.stringify(inputs.js));
        if (inputs.go !== undefined) writeFileSync(files.go, inputs.go);
        if (inputs.floor !== undefined) writeFileSync(files.floor, JSON.stringify(inputs.floor));
        return files;
    }

    function run(mode: "check" | "ratchet", files: ReturnType<typeof setup>, ...extra: string[]) {
        const r = spawnSync(process.execPath, [SCRIPT, mode, "--js", files.js, "--go", files.go, "--floor", files.floor, ...extra], { encoding: "utf8" });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
    }

    const floorOf = (files: ReturnType<typeof setup>) => JSON.parse(readFileSync(files.floor, "utf8"));

    describe("check", () => {
        test("passes on the numbers the floor came from, with a table of current against floor", () => {
            const { status, out } = run("check", setup({ js: JS_SUMMARY, go: GO_OUTPUT, floor: FLOOR }));
            assert.equal(status, 0, out);
            assert.match(out, /lines\s+99\.84\s+99\.70\s+\+0\.14\s+ok/);
            assert.match(out, /internal\/ui\s+95\.60\s+95\.50\s+\+0\.10\s+ok/);
            assert.match(out, /at or above the floor/);
            assert.doesNotMatch(out, /raise the floor/);
            assert.doesNotMatch(out, /testutil/);
        });

        test("fails when a TypeScript metric drops below its floor", () => {
            const { status, out } = run("check", setup({ js: jsWith("branches", 96.4), go: GO_OUTPUT, floor: FLOOR }));
            assert.equal(status, 1);
            assert.match(out, /branches\s+96\.40\s+96\.50\s+-0\.10\s+BELOW THE FLOOR/);
            assert.match(out, /js branches: 96\.40% is below its floor of 96\.50%/);
        });

        test("fails when a Go package drops below its floor", () => {
            const { status, out } = run("check", setup({ js: JS_SUMMARY, go: goWith("internal/ui", "95.4"), floor: FLOOR }));
            assert.equal(status, 1);
            assert.match(out, /internal\/ui\s+95\.40\s+95\.50\s+-0\.10\s+BELOW THE FLOOR/);
            assert.match(out, /go internal\/ui: 95\.40% is below its floor of 95\.50%/);
        });

        test("passes exactly at the floor", () => {
            const { status, out } = run("check", setup({ js: jsWith("branches", 96.5), go: goWith("internal/ui", "95.5"), floor: FLOOR }));
            assert.equal(status, 0, out);
        });

        test("fails when a package that has a floor has no coverage line any more", () => {
            const { status, out } = run("check", setup({ js: JS_SUMMARY, go: GO_OUTPUT.replace(/^ok.*internal\/winver.*\n/m, ""), floor: FLOOR }));
            assert.equal(status, 1);
            assert.match(out, /internal\/winver\s+-\s+99\.90\s+MISSING/);
        });

        test("only notes a new package that has no floor yet", () => {
            const go = `${GO_OUTPUT}ok  \tgithub.com/HumbertoFernandes7/Telinha/installer/internal/newpkg\t0.100s\tcoverage: 80.0% of statements\n`;
            const { status, out } = run("check", setup({ js: JS_SUMMARY, go, floor: FLOOR }));
            assert.equal(status, 0, out);
            assert.match(out, /internal\/newpkg\s+80\.00\s+-\s+new, no floor yet/);
            assert.match(out, /raise the floor: pnpm coverage:ratchet/);
        });

        test("hints to raise the floor for what is more than 0.5 above it, and only that", () => {
            const { status, out } = run("check", setup({ js: JS_SUMMARY, go: goWith("internal/ui", "99.0"), floor: FLOOR }));
            assert.equal(status, 0, out);
            assert.match(out, /internal\/ui\s+99\.00\s+95\.50\s+\+3\.50\s+ok\n\s+raise the floor: pnpm coverage:ratchet/);
            assert.equal(out.match(/raise the floor/g)?.length, 1);
        });

        test("reads the go test output as it is in a CI log: line prefixes, (cached), CRLF", () => {
            const log = GO_OUTPUT.replace(/^ok {2}\t(\S+)\t[\d.]+s/gm, "pnpm check\tgo test -cover\t2026-10-30T00:31:21.8683236Z ok  \t$1\t(cached)").replace(/\n/g, "\r\n");
            const { status, out } = run("check", setup({ js: JS_SUMMARY, go: log, floor: FLOOR }));
            assert.equal(status, 0, out);
            assert.match(out, /internal\/core\s+98\.90/);
        });

        test("a metric the summary lacks fails like a missing package", () => {
            const { status, out } = run("check", setup({ js: { total: { lines: JS_SUMMARY.total.lines } }, go: GO_OUTPUT, floor: FLOOR }));
            assert.equal(status, 1);
            assert.match(out, /functions\s+-\s+99\.10\s+MISSING/);
        });

        test("fails when a source file is absent, and --only leaves the other side out", () => {
            const noGo = setup({ js: JS_SUMMARY, floor: FLOOR });
            const missing = run("check", noGo);
            assert.equal(missing.status, 1);
            assert.match(missing.out, /no go test output/);
            assert.equal(run("check", noGo, "--only", "js").status, 0);

            const noJs = setup({ go: GO_OUTPUT, floor: FLOOR });
            assert.equal(run("check", noJs).status, 1);
            assert.equal(run("check", noJs, "--only", "go").status, 0);
        });

        test("fails without a floor file", () => {
            const { status, out } = run("check", setup({ js: JS_SUMMARY, go: GO_OUTPUT }));
            assert.equal(status, 1);
            assert.match(out, /no floor file/);
        });

        test("--summary appends the markdown table, failures included", () => {
            const files = setup({ js: jsWith("lines", 90), go: GO_OUTPUT, floor: FLOOR });
            writeFileSync(files.summary, "earlier\n");
            const { status } = run("check", files, "--summary", files.summary);
            assert.equal(status, 1);
            const md = readFileSync(files.summary, "utf8");
            assert.ok(md.startsWith("earlier\n### Coverage floor"));
            assert.match(md, /\| lines \| 90\.00% \| 99\.70% \| -9\.70 \| \*\*BELOW THE FLOOR\*\* \|/);
            assert.match(md, /\| internal\/ui \| 95\.60% \| 95\.50% \| \+0\.10 \| ok \|/);
            assert.match(md, /\*\*Below the floor:\*\*/);
        });
    });

    describe("ratchet", () => {
        test("writes the floor from nothing: current rounded down to 0.1, minus 0.1, no floor for a package without tests", () => {
            const files = setup({ js: JS_SUMMARY, go: GO_OUTPUT });
            const { status, out } = run("ratchet", files);
            assert.equal(status, 0, out);
            assert.deepEqual(floorOf(files), FLOOR);
            assert.match(readFileSync(files.floor, "utf8"), /^\{\n {4}"js": \{\n {8}"lines": 99\.7,/);
            assert.equal(run("check", files).status, 0);
        });

        test("raises what went up and never lowers what is above the measurement", () => {
            const files = setup({
                js: JS_SUMMARY,
                go: GO_OUTPUT,
                floor: { js: { ...FLOOR.js, lines: 99.0, branches: 99.9 }, go: { ...FLOOR.go, "internal/ui": 90, "internal/core": 99.9 } }
            });
            const { status, out } = run("ratchet", files);
            assert.equal(status, 0, out);
            assert.match(out, /js lines: 99\.00 -> 99\.70/);
            assert.match(out, /js branches: 96\.63 is below its floor 99\.90, not lowered/);
            assert.deepEqual(floorOf(files), { js: { ...FLOOR.js, branches: 99.9 }, go: { ...FLOOR.go, "internal/core": 99.9 } });
        });

        test("adds a package that has no floor yet and keeps one whose line is gone", () => {
            const go = `${GO_OUTPUT.replace(/^ok.*internal\/winver.*\n/m, "")}ok  \tgithub.com/HumbertoFernandes7/Telinha/installer/internal/newpkg\t0.100s\tcoverage: 80.0% of statements\n`;
            const files = setup({ js: JS_SUMMARY, go, floor: FLOOR });
            const { status } = run("ratchet", files);
            assert.equal(status, 0);
            assert.deepEqual(floorOf(files), { js: FLOOR.js, go: { ...FLOOR.go, "internal/newpkg": 79.9 } });
        });

        test("leaves the file alone when there is nothing to raise", () => {
            const files = setup({ js: JS_SUMMARY, go: GO_OUTPUT, floor: FLOOR });
            const before = readFileSync(files.floor, "utf8");
            const { status, out } = run("ratchet", files);
            assert.equal(status, 0);
            assert.match(out, /nothing to raise/);
            assert.equal(readFileSync(files.floor, "utf8"), before);
        });

        test("skips a side whose file is absent and fails only when it can read nothing", () => {
            const files = setup({ js: JS_SUMMARY, floor: { js: { ...FLOOR.js, lines: 90 }, go: FLOOR.go } });
            const { status, out } = run("ratchet", files);
            assert.equal(status, 0, out);
            assert.match(out, /go: skipped/);
            assert.deepEqual(floorOf(files), FLOOR);

            const none = setup({ floor: FLOOR });
            assert.equal(run("ratchet", none).status, 1);
        });

        test("--only leaves the other side's floors as they are", () => {
            const files = setup({ js: JS_SUMMARY, go: GO_OUTPUT, floor: { js: { ...FLOOR.js, lines: 90 }, go: { ...FLOOR.go, "internal/ui": 90 } } });
            const { status, out } = run("ratchet", files, "--only", "js");
            assert.equal(status, 0, out);
            assert.deepEqual(floorOf(files), { js: FLOOR.js, go: { ...FLOOR.go, "internal/ui": 90 } });
        });
    });
});
