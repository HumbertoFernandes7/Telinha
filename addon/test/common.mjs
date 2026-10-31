/*
 * Shared bits of the offline add-on tests: which Vencord build and which payload are under test, scratch dir, checks.
 *
 *   --vencord-dist <dir>   Vencord build with patcher.js, preload.js, renderer.js
 *                          (default: .vencord/dist = the pinned official Vencord built by `pnpm bootstrap`, read-only)
 *   --payload <dir>        built payload (default: dist/addon/payload, from `pnpm build:addon`)
 */
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { VENCORD_DIST } from "../../scripts/vencord.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ADDON = resolve(HERE, "..");
export const REPO = resolve(ADDON, "..");
// Short on purpose: Windows MAX_PATH and the fake trees nest a few levels deep. Never the real %APPDATA%.
// One folder per checkout (a short hash of the repo path): two worktrees running the tests at once would otherwise share,
// and wipe, each other's fake trees.
export const SCRATCH = join(tmpdir(), `tl-addon-${createHash("sha1").update(REPO).digest("hex").slice(0, 6)}`);

export const argValue = name => (process.argv.includes(name) ? resolve(process.argv[process.argv.indexOf(name) + 1]) : null);

/** The natives the plugin's native.ts exports (sorted): what the loader registers and VencordNative.pluginHelpers.Telinha shows. */
export const PLUGIN_NATIVES = [
    "appendDiagLog", "finishDisplayMedia", "listSources", "prepareDisplayMedia", "readDiagLog", "readScreenAudio", "resetDisplayMedia", "screenAudioStatus",
    "startScreenAudio", "stopScreenAudio"
];

export function pickVencordDist() {
    const dir = argValue("--vencord-dist") ?? VENCORD_DIST;
    if (!["patcher.js", "preload.js", "renderer.js"].every(f => existsSync(join(dir, f)))) {
        console.error(`No Vencord build in ${dir}: run \`pnpm bootstrap\` (or pass --vencord-dist <dir with patcher.js, preload.js, renderer.js>)`);
        process.exit(2);
    }
    return dir;
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
