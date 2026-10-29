/*
 * Shared bits of the offline add-on tests: which Vencord build and which payload are under test, scratch dir, checks.
 *
 *   --vencord-dist <dir>   Vencord build with patcher.js, preload.js, renderer.js
 *                          (default: %APPDATA%\Vencord\dist.backup-oficial-* = official release, read-only)
 *   --payload <dir>        built payload (default: dist/addon/payload, from `pnpm build:addon`)
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ADDON = resolve(HERE, "..");
export const REPO = resolve(ADDON, "..");
// Short on purpose: Windows MAX_PATH and the fake trees nest a few levels deep. Never the real %APPDATA%.
export const SCRATCH = join(tmpdir(), "tl-addon");

const argValue = name => (process.argv.includes(name) ? resolve(process.argv[process.argv.indexOf(name) + 1]) : null);

export function pickVencordDist() {
    const explicit = argValue("--vencord-dist");
    if (explicit) return explicit;
    const roaming = process.env.APPDATA && join(process.env.APPDATA, "Vencord");
    const official = roaming && existsSync(roaming) && readdirSync(roaming).find(d => d.startsWith("dist.backup-oficial"));
    if (!official) {
        console.error("No official Vencord build found: pass --vencord-dist <dir with patcher.js, preload.js, renderer.js>");
        process.exit(2);
    }
    return join(roaming, official);
}

export function pickPayload() {
    const dir = argValue("--payload") ?? join(REPO, "dist", "addon", "payload");
    if (!existsSync(join(dir, "version.json"))) {
        console.error(`No built payload at ${dir}: run \`pnpm build:addon\` first (or pass --payload <dir>)`);
        process.exit(2);
    }
    const version = JSON.parse(readFileSync(join(dir, "version.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(dir, "addon.json"), "utf8"));
    return { dir, version, manifest, files: [...Object.keys(version.files), "version.json"] };
}

export function makeChecker() {
    const state = { failures: 0, total: 0 };
    const check = (label, cond, extra) => {
        state.total++;
        console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${!cond && extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
        if (!cond) state.failures++;
    };
    const finish = () => {
        console.log(state.failures ? `\n${state.failures} of ${state.total} check(s) FAILED` : `\nALL ${state.total} CHECKS PASSED`);
        process.exit(state.failures ? 1 : 0);
    };
    return { check, finish };
}
