/*
 * All offline add-on tests (`pnpm test:addon`), in order:
 *   1. the scenario scripts addon/test/run-*-test.mjs: main, renderer and update first (as before), then any other
 *      one alphabetically. Each runs in its own process and gets the same arguments (--vencord-dist, --payload...).
 *   2. node:test unit tests of the loader, if any: addon/test/*.test.mjs and *.test.cjs (node --test).
 * A new test file is picked up by name: package.json never needs to change. Exit code 1 if anything failed.
 * Like the scripts it runs, it never touches the real Discord or %APPDATA% (fake trees under %TEMP%\tl-addon).
 */
import { spawnSync } from "child_process";
import { readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRST = ["run-main-test.mjs", "run-renderer-test.mjs", "run-update-test.mjs"];
const files = readdirSync(HERE);
const scenarios = [...FIRST.filter(f => files.includes(f)), ...files.filter(f => /^run-.+-test\.mjs$/.test(f) && !FIRST.includes(f)).sort()];
const units = files.filter(f => /\.test\.(mjs|cjs)$/.test(f)).sort();

const failed = [];
for (const f of scenarios) {
    console.log(`\n=== ${f}`);
    const r = spawnSync(process.execPath, [join(HERE, f), ...process.argv.slice(2)], { stdio: "inherit" });
    if (r.status !== 0) failed.push(f);
}
if (units.length) {
    console.log(`\n=== node --test (${units.join(", ")})`);
    const r = spawnSync(process.execPath, ["--test", ...units.map(f => join(HERE, f))], { stdio: "inherit" });
    if (r.status !== 0) failed.push("node --test");
}
console.log(failed.length ? `\nADD-ON TESTS FAILED: ${failed.join(", ")}` : `\nALL ADD-ON TESTS PASSED (${scenarios.length} scenario scripts${units.length ? `, ${units.length} unit test files` : ""})`);
process.exit(failed.length ? 1 : 0);
