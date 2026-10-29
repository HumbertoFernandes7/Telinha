/*
 * Telinha - the pinned official Vencord (vencord.json) that the plugin compiles against and the add-on is tested with.
 * Vencord is a build-time dependency only: `pnpm bootstrap` fetches it into .vencord/ (gitignored, never committed).
 * Shared by scripts/bootstrap.mjs, addon/build/build-addon.mjs and addon/test/common.mjs.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VENCORD_DIR = join(REPO, ".vencord");
/** Official Vencord build made by `pnpm bootstrap` (pnpm build --standalone --disable-updater at the pinned commit). */
export const VENCORD_DIST = join(VENCORD_DIR, "dist");

/** vencord.json: { repository, commit (full SHA), version }. */
export function readPin() {
    const pin = JSON.parse(readFileSync(join(REPO, "vencord.json"), "utf8"));
    if (!/^[0-9a-f]{40}$/.test(pin.commit ?? "")) throw new Error(`vencord.json: "commit" must be a full 40-character SHA (got ${pin.commit})`);
    if (!pin.repository) throw new Error('vencord.json: "repository" is missing');
    return pin;
}

/** HEAD of the .vencord checkout, or null. Never asks git outside .vencord (git would find this repo instead). */
export function checkoutCommit() {
    if (!existsSync(join(VENCORD_DIR, ".git"))) return null;
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: VENCORD_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

/** The pin, after checking that .vencord is checked out at it (sources the build and the type check read). */
export function requirePinnedCheckout() {
    const pin = readPin();
    const head = checkoutCommit();
    if (head !== pin.commit)
        throw new Error(`.vencord is ${head ? `at ${head.slice(0, 8)}` : "missing"} but vencord.json pins ${pin.commit.slice(0, 8)}: run \`pnpm bootstrap\``);
    return pin;
}
