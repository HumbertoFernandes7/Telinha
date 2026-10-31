/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Offline test of automatic updates (addon/loader/updater.js + the loader's swap/rollback, PAYLOAD.md section 8), with a
 * fake GitHub release server on 127.0.0.1 and fake %APPDATA% trees under %TEMP%\tl-addon-<hash of the repo path>. Never touches the real
 * Discord, %APPDATA% or GitHub.
 *
 *   node addon/test/run-update-test.mjs [--vencord-dist <dir>] [--payload <dir>] [--installer <TelinhaInstaller-cli.exe>]
 *
 * U*: the updater on its own (check, download, verify, stage, startup swap/rollback).
 * I*: the real loader through our stub, with the real Vencord build and the fake electron (like run-main-test.mjs).
 * The last block reads the result with the Go installer (--status --json) when dist\installer\TelinhaInstaller-cli.exe
 * exists (`pnpm build:installer`), so the install.json/addon layout the installer sees stays valid.
 */
import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import http from "http";
import { createRequire } from "module";
import { join } from "path";

import { zipSync } from "fflate";

import { argValue, HERE, makeChecker, pickPayload, pickVencordDist, REPO, SCRATCH } from "./common.mjs";

const require = createRequire(import.meta.url);
const upd = require("../loader/updater.js");
const installer = require("../installer/install.js");
const { check, finish } = makeChecker();

const vencordDist = pickVencordDist();
const payload = pickPayload();
const ROOT = join(SCRATCH, "upd");
const RELEASE_REPO = "HumbertoFernandes7/Telinha";
const sha256 = buf => createHash("sha256").update(buf).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
console.log(`Payload: ${payload.dir} (${payload.version.version}, ${payload.version.commit})\nVencord: ${vencordDist}\nScratch: ${ROOT}\n`);

// ------------------------------------------------------------------------------------------- payload variants

/** A copy of the built payload as another version: files changed as asked, version.json rehashed. */
function variant(name, { version, commit, append = {}, replace = {} }) {
    const dir = join(ROOT, "payloads", name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const v = structuredClone(payload.version);
    for (const f of Object.keys(v.files)) {
        let buf = readFileSync(join(payload.dir, f));
        if (replace[f] !== undefined) buf = Buffer.from(replace[f]);
        if (append[f]) buf = Buffer.concat([buf, Buffer.from(append[f])]);
        writeFileSync(join(dir, f), buf);
        v.files[f] = { size: buf.length, sha256: sha256(buf) };
    }
    Object.assign(v, { version, commit });
    writeFileSync(join(dir, "version.json"), JSON.stringify(v, null, 4) + "\n");
    return dir;
}

// main.js marks which loader ran last (the driver reports globalThis.__TelinhaTestLoader)
const marker = tag => `\n;globalThis.__TelinhaTestLoader = ${JSON.stringify(tag)};\n`;
const BASE = variant("base-0.1.0", { version: "0.1.0", commit: "base0100", append: { "main.js": marker("0.1.0") } });
const NEW = variant("new-0.1.1", { version: "0.1.1", commit: "new00101", append: { "main.js": marker("0.1.1") } });
const OLDER = variant("older-0.0.9", { version: "0.0.9", commit: "old00009" });
const NEW_BROKEN_LOADER = variant("new-broken-loader", { version: "0.1.1", commit: "brk00101", replace: { "main.js": "throw new Error('simulated broken 0.1.1 loader');\n" } });
const NEW_BROKEN_NATIVES = variant("new-broken-natives", { version: "0.1.1", commit: "nat00101", append: { "main.js": marker("0.1.1") }, replace: { "telinha.main.js": "throw new Error('simulated broken 0.1.1 natives');\n" } });
const MISMATCH = variant("mismatch-0.1.2", { version: "0.1.2", commit: "mis00102" });

const filesOf = dir => Object.fromEntries([...Object.keys(JSON.parse(readFileSync(join(dir, "version.json"), "utf8")).files), "version.json"].map(f => [f, readFileSync(join(dir, f))]));
const zipOf = (dir, extra = {}) => Buffer.from(zipSync({ ...Object.fromEntries(Object.entries(filesOf(dir)).map(([n, b]) => [n, new Uint8Array(b)])), ...extra }));
const dirHash = dir => sha256(Buffer.from(JSON.stringify(readdirSync(dir).sort().map(f => [f, sha256(readFileSync(join(dir, f)))]))));
const versionOf = dir => (existsSync(join(dir, "version.json")) ? JSON.parse(readFileSync(join(dir, "version.json"), "utf8")).version : null);
const verifies = dir => {
    try {
        return upd.verifyDir(dir).version;
    } catch {
        return null;
    }
};

/**
 * A live process named like a Discord flavor (a copy of node.exe that only waits), for the run-marker checks: the updater
 * asks Windows' tasklist which program owns a marker's pid. kill() ends it.
 */
function discordLookalike(exeName) {
    const dir = join(ROOT, "procs");
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, exeName);
    if (!existsSync(exe)) copyFileSync(process.execPath, exe);
    const child = spawn(exe, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    return { pid: child.pid, kill: () => child.kill() };
}

// ------------------------------------------------------------------------------------------- fake GitHub

async function fakeGitHub() {
    const gh = { requests: [], release: null, files: new Map(), mode: "ok" };
    const server = http.createServer((req, res) => {
        gh.requests.push({ url: req.url, ua: req.headers["user-agent"] ?? "", inm: req.headers["if-none-match"] ?? null });
        if (gh.mode === "rate-limit") {
            res.writeHead(403, { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) });
            return res.end('{"message":"API rate limit exceeded"}');
        }
        if (req.url === `/repos/${RELEASE_REPO}/releases/latest`) {
            if (!gh.release) {
                res.writeHead(404, { "content-type": "application/json" });
                return res.end('{"message":"Not Found"}');
            }
            const body = JSON.stringify(gh.release);
            const etag = `"${sha256(body).slice(0, 16)}"`;
            if (req.headers["if-none-match"] === etag) {
                res.writeHead(304, { etag });
                return res.end();
            }
            res.writeHead(200, { "content-type": "application/json", etag });
            return res.end(body);
        }
        let m;
        // github.com/.../releases/download/... answers with a redirect to the asset CDN
        if ((m = /^\/download\/(.+)$/.exec(req.url))) {
            res.writeHead(302, { location: `/cdn/${m[1]}` });
            return res.end();
        }
        if ((m = /^\/cdn\/(.+)$/.exec(req.url)) && gh.files.has(decodeURIComponent(m[1]))) {
            const b = gh.files.get(decodeURIComponent(m[1]));
            res.writeHead(200, { "content-type": "application/octet-stream", "content-length": b.length });
            return res.end(b);
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    gh.base = `http://127.0.0.1:${server.address().port}`;
    gh.close = () => new Promise(r => server.close(r));
    gh.count = re => gh.requests.filter(q => re.test(q.url)).length;
    /** Publishes a release like the real ones: zip + <zip>.sha256 assets, GitHub's asset digest. */
    gh.publish = (tag, zip, { name = `Telinha-addon-${tag.replace(/\W/g, "")}.zip`, digest = sha256(zip), sumFile = `${sha256(zip)}  ${name}\n`, prerelease = false, body = "" } = {}) => {
        gh.files.clear();
        gh.files.set(name, zip);
        const assets = [
            { name: "TelinhaInstaller.exe", size: 3, digest: "sha256:" + sha256("exe"), browser_download_url: `${gh.base}/download/TelinhaInstaller.exe` },
            { name, size: zip.length, digest: digest ? "sha256:" + digest : null, browser_download_url: `${gh.base}/download/${name}` }
        ];
        if (sumFile !== null) {
            gh.files.set(name + ".sha256", Buffer.from(sumFile));
            assets.push({ name: name + ".sha256", size: sumFile.length, digest: null, browser_download_url: `${gh.base}/download/${name}.sha256` });
        }
        gh.release = { tag_name: tag, name: tag, draft: false, prerelease, body, assets };
        gh.requests.length = 0;
    };
    return gh;
}

// ------------------------------------------------------------------------------------------- fake trees

const FAKE_DISCORD_BOOTSTRAP = `"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("path");
globalThis.__fakeDiscord = { loaded: true, bwName: BrowserWindow.name };
app.on("ready", () => {
    globalThis.__fakeDiscord.win = new BrowserWindow({ title: "Discord", width: 1280, height: 720,
        webPreferences: { preload: path.join(__dirname, "..", "mainScreenPreload.js"), contextIsolation: true } });
});
`;

/** Local/Discord/app-1.0.9002 (exploded stub) + Roaming/Vencord/dist + Roaming/Telinha/{addon, install.json}. */
function makeTree(name, { installed = BASE, staged = null } = {}) {
    const root = join(ROOT, name);
    rmSync(root, { recursive: true, force: true });
    const appDir = join(root, "Local", "Discord", "app-1.0.9002");
    const res = join(appDir, "resources");
    const dist = join(root, "Roaming", "Vencord", "dist");
    const home = join(root, "Roaming", "Telinha");
    const addonDir = join(home, "addon");

    mkdirSync(join(res, "_app.asar", "app_bootstrap"), { recursive: true });
    writeFileSync(join(appDir, "Discord.exe"), "");
    writeFileSync(join(res, "_app.asar", "package.json"), JSON.stringify({ name: "discord", main: "app_bootstrap/index.js" }));
    writeFileSync(join(res, "_app.asar", "app_bootstrap", "index.js"), FAKE_DISCORD_BOOTSTRAP);
    writeFileSync(join(res, "_app.asar", "mainScreenPreload.js"), "globalThis.__fakeDiscordPreloadRan = true;\n");
    mkdirSync(dist, { recursive: true });
    for (const f of ["patcher.js", "preload.js", "renderer.js"]) cpSync(join(vencordDist, f), join(dist, f));

    cpSync(installed, addonDir, { recursive: true });
    if (staged) cpSync(staged, join(home, "addon.new"), { recursive: true });
    const record = {
        installedAt: "2026-10-29T12:00:00Z", version: versionOf(installed), commit: JSON.parse(readFileSync(join(installed, "version.json"), "utf8")).commit,
        targets: [{ flavor: "Discord", app: "app-1.0.9002", resources: res, vencordPatcher: join(dist, "patcher.js"), previous: "vencord-stub", backup: null }],
        installerVersion: "0.1.0",
        source: { kind: "github", release: "v0.1.0", asset: "Telinha-addon-base0100.zip", sha256: "a".repeat(64) }
    };
    writeFileSync(join(home, "install.json"), JSON.stringify(record, null, 2) + "\n");

    mkdirSync(join(res, "app.asar"), { recursive: true });
    const template = readFileSync(join(installed, "stub-template.js"), "utf8");
    writeFileSync(join(res, "app.asar", "index.js"), installer.renderStub(template, join(addonDir, "main.js"), join(dist, "patcher.js")));
    writeFileSync(join(res, "app.asar", "package.json"), JSON.stringify({ name: "discord", main: "index.js" }));
    return {
        root, appDir, res, dist, home, addonDir,
        staged: join(home, "addon.new"), prev: join(home, "addon.prev"),
        state: () => (existsSync(join(home, "update", "state.json")) ? JSON.parse(readFileSync(join(home, "update", "state.json"), "utf8")) : {}),
        record: () => JSON.parse(readFileSync(join(home, "install.json"), "utf8")),
        mainLog: () => (existsSync(join(home, "logs", "main.log")) ? readFileSync(join(home, "logs", "main.log"), "utf8") : "")
    };
}

/** One Discord start through the stub (async: the fake GitHub in this process must keep answering). */
async function boot(name, tree, extraEnv = {}) {
    const reportPath = join(tree.root, `report-${name}.json`);
    rmSync(reportPath, { force: true });
    const env = { ...process.env, FAKE_ROOT: tree.root, FAKE_REPORT: reportPath, FAKE_DISCORD_EXE: join(tree.appDir, "Discord.exe"), ...extraEnv };
    for (const k of ["VENCORD_USER_DATA_DIR", "DISCORD_USER_DATA_DIR", "DISABLE_UPDATER_AUTO_PATCHING", "TELINHA_HELPER_DIR", "TELINHA_VENCORD_PRELOAD"]) delete env[k];
    if (!extraEnv.TELINHA_UPDATE_API) delete env.TELINHA_UPDATE_API;
    const out = await new Promise(done => {
        const child = spawn(process.execPath, ["--require", join(HERE, "fake", "register.js"), join(tree.res, "app.asar", "index.js")], { env });
        let text = "";
        child.stdout.on("data", d => (text += d));
        child.stderr.on("data", d => (text += d));
        const timer = setTimeout(() => child.kill(), 60_000);
        child.on("close", code => {
            clearTimeout(timer);
            done({ code, text });
        });
    });
    writeFileSync(join(tree.root, `boot-${name}.log`), out.text);
    if (!existsSync(reportPath)) {
        console.log(out.text);
        throw new Error(`${name}: no report (exit ${out.code})`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (report.error) console.log(`  [${name}] driver error:\n${report.error}`);
    report.log = out.text;
    return report;
}

/** A home with only %APPDATA%\Telinha (for the updater on its own). */
function makeHome(name, { installed = BASE, staged = null } = {}) {
    return makeTree(name, { installed, staged });
}

function updaterFor(tree, gh, extra = {}) {
    const lines = [];
    const u = upd.createUpdater({ addonDir: tree.addonDir, apiBase: gh?.base ?? "http://127.0.0.1:9", log: (m, d) => lines.push(d === undefined ? m : `${m} ${JSON.stringify(d)}`), ...extra });
    u.lines = lines;
    return u;
}

const leftovers = tree => (existsSync(join(tree.home, "update")) ? readdirSync(join(tree.home, "update")).filter(n => n.startsWith("staging-")) : []);
const goodRecord = (r, version, commit) => r && r.version === version && r.commit === commit && Array.isArray(r.targets) && r.targets.length === 1 && typeof r.targets[0].resources === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.installedAt);

const gh = await fakeGitHub();
const zipNew = zipOf(NEW);
/** zip downloads that reached the "CDN" (each one is a /download -> /cdn redirect) */
const zipDownloads = () => gh.count(/^\/cdn\/.*\.zip$/);

// ------------------------------------------------------------------------------------------- U: the updater on its own
console.log("U1 newer release: downloaded (through the CDN redirect), verified, staged in addon.new; live addon untouched");
{
    const t = makeHome("u1");
    const before = dirHash(t.addonDir);
    gh.publish("v0.1.1", zipNew);
    const u = updaterFor(t, gh);
    const s = await u.check({ autoDownload: true });
    check("status: ready 0.1.1", s.phase === "ready" && s.ready === "0.1.1" && s.latest?.version === "0.1.1" && s.installed?.version === "0.1.0", s);
    check("addon.new holds 0.1.1 and verifies (every file: size + SHA-256)", verifies(t.staged) === "0.1.1");
    check("live addon\\ untouched (byte for byte)", dirHash(t.addonDir) === before);
    check("asked GitHub releases/latest with a User-Agent", gh.requests.some(q => q.url === `/repos/${RELEASE_REPO}/releases/latest` && /^Telinha-addon\/0\.1\.0/.test(q.ua)), gh.requests);
    check("zip and .sha256 downloaded through the redirect to the CDN", gh.count(/^\/cdn\/.*\.zip$/) === 1 && gh.count(/^\/cdn\/.*\.sha256$/) === 1, gh.requests.map(q => q.url));
    check("state.json records the staged release (tag, asset, SHA-256)", u.readState().staged?.sha256 === sha256(zipNew) && u.readState().staged?.tag === "v0.1.1");
    check("no staging leftovers", !leftovers(t).length, leftovers(t));

    const again = await u.check({ autoDownload: true });
    check("next check: conditional request (If-None-Match -> 304), nothing downloaded again", again.phase === "ready" && gh.requests.at(-1).inm && zipDownloads() === 1, gh.requests.slice(-2));
}

console.log("\nU2 same or older version: nothing");
for (const [tag, dir] of [["v0.1.0", BASE], ["v0.0.9", OLDER]]) {
    const t = makeHome(`u2-${tag}`);
    gh.publish(tag, zipOf(dir));
    const s = await updaterFor(t, gh).check({ autoDownload: true });
    check(`${tag}: up to date, nothing downloaded or staged`, s.phase === "up-to-date" && !existsSync(t.staged) && gh.count(/\.zip/) === 0, s);
}

console.log("\nU3 bad SHA-256: rejected, nothing staged");
for (const [label, opts] of [
    ["GitHub asset digest disagrees", { digest: "0".repeat(64) }],
    [".sha256 asset disagrees", { sumFile: `${"1".repeat(64)}  Telinha-addon-v011.zip\n` }],
    ["release notes disagree", { body: `SHA-256 (Telinha-addon-v011.zip) = ${"2".repeat(64)}` }],
    ["no SHA-256 published at all", { digest: null, sumFile: null }]
]) {
    const t = makeHome(`u3-${label.split(" ")[0]}`);
    gh.publish("v0.1.1", zipNew, opts);
    const s = await updaterFor(t, gh).check({ autoDownload: true });
    check(`${label}: refused (checksum), not quiet, nothing staged`, s.phase === "error" && s.error?.kind === "checksum" && !s.error.quiet && !existsSync(t.staged) && !leftovers(t).length, s);
}

console.log("\nU4 malformed zip / Zip Slip / wrong contents: rejected before anything is written");
{
    const cases = [
        ["not a zip", Buffer.from("this is not a zip file at all".repeat(10))],
        ["truncated zip", zipNew.subarray(0, zipNew.length - 200)],
        ["Zip Slip entry ../evil.js", zipOf(NEW, { "../evil.js": new Uint8Array(Buffer.from("pwned")) })],
        ["Zip Slip entry ..\\\\evil.js", zipOf(NEW, { "..\\evil.js": new Uint8Array(Buffer.from("pwned")) })],
        ["nested entry sub/evil.js", zipOf(NEW, { "sub/evil.js": new Uint8Array(Buffer.from("pwned")) })],
        ["file tampered (version.json not updated)", (() => {
            const files = Object.fromEntries(Object.entries(filesOf(NEW)).map(([n, b]) => [n, new Uint8Array(b)]));
            files["telinha.renderer.js"] = new Uint8Array(Buffer.from("tampered"));
            return Buffer.from(zipSync(files));
        })()],
        ["version.json says 0.1.2, release is v0.1.1", zipOf(MISMATCH)]
    ];
    for (const [label, zip] of cases) {
        const t = makeHome(`u4-${label.replace(/\W+/g, "-").slice(0, 24)}`);
        gh.publish("v0.1.1", zip);
        const s = await updaterFor(t, gh).check({ autoDownload: true });
        const evil = [join(t.root, "Roaming", "evil.js"), join(t.home, "evil.js"), join(t.home, "update", "evil.js")].some(existsSync);
        check(`${label}: refused (invalid), nothing staged or extracted`, s.phase === "error" && s.error?.kind === "invalid" && !existsSync(t.staged) && !leftovers(t).length && !evil, s.error);
    }
}

console.log("\nU5 rate limit, offline, no release yet: silent (quiet error, no throw), retried at the next check");
{
    const t = makeHome("u5");
    gh.publish("v0.1.1", zipNew);
    gh.mode = "rate-limit";
    const u = updaterFor(t, gh);
    const s = await u.check({ autoDownload: true });
    check("rate limit: quiet error, nothing staged", s.phase === "error" && s.error?.kind === "rate-limit" && s.error.quiet && !existsSync(t.staged), s);
    const n = gh.requests.length;
    await u.check({ autoDownload: true });
    check("automatic check during the rate limit: no request (waits for GitHub's reset)", gh.requests.length === n);
    gh.mode = "ok";
    const manual = await u.check({ autoDownload: true, manual: true });
    check("manual check goes out and works once GitHub answers again", manual.phase === "ready" && verifies(t.staged) === "0.1.1", manual);
    check("logged, not shown: main log has the rate limit", u.lines.some(l => /check failed \(rate-limit, will retry/.test(l)));

    const closed = http.createServer();
    await new Promise(r => closed.listen(0, "127.0.0.1", r));
    const deadBase = `http://127.0.0.1:${closed.address().port}`;
    await new Promise(r => closed.close(r));
    const t2 = makeHome("u5-offline");
    const off = await updaterFor(t2, { base: deadBase }).check({ autoDownload: true });
    check("offline: quiet error, nothing staged", off.phase === "error" && off.error?.kind === "offline" && off.error.quiet && !existsSync(t2.staged), off);

    const t3 = makeHome("u5-none");
    gh.release = null;
    const none = await updaterFor(t3, gh).check({ autoDownload: true });
    check("no release published yet (404): quiet", none.phase === "error" && none.error?.kind === "no-release" && none.error.quiet, none);
}

console.log("\nU6 'Atualizar automaticamente' off: only reports 'available'; Atualizar downloads and stages");
{
    const t = makeHome("u6");
    gh.publish("v0.1.1", zipNew);
    const u = updaterFor(t, gh);
    const s = await u.check({ autoDownload: false });
    check("available 0.1.1, nothing downloaded", s.phase === "available" && s.latest?.version === "0.1.1" && gh.count(/\.zip/) === 0 && !existsSync(t.staged), s);
    const d = await u.download();
    check("Atualizar: downloaded, verified, staged -> ready", d.phase === "ready" && d.ready === "0.1.1" && verifies(t.staged) === "0.1.1", d);
}

console.log("\nU7 next start: swap addon.new -> addon, previous kept as addon.prev, install.json updated");
let swappedTree;
{
    const t = makeHome("u7");
    gh.publish("v0.1.1", zipNew);
    await updaterFor(t, gh).check({ autoDownload: true });
    const u = updaterFor(t, null); // a new Discord start: a new loader, a new updater
    const r = u.startup();
    check("startup swapped 0.1.0 -> 0.1.1", r?.kind === "swapped" && r.from === "0.1.0" && r.to === "0.1.1", r);
    check("addon\\ = 0.1.1 (verified), addon.prev = 0.1.0 (verified), no addon.new / addon.old", verifies(t.addonDir) === "0.1.1" && verifies(t.prev) === "0.1.0" && !existsSync(t.staged) && !existsSync(join(t.home, "addon.old")));
    const st = u.readState();
    check("trial recorded (boot marker not set yet)", st.trial?.version === "0.1.1" && st.trial.previous === "0.1.0" && st.trial.armed === false && !st.staged, st.trial);
    const rec = t.record();
    check("install.json: version/commit/source of 0.1.1, targets kept, installer fields intact", goodRecord(rec, "0.1.1", "new00101") && rec.source?.kind === "github" && rec.source.release === "v0.1.1" &&
        rec.source.sha256 === sha256(zipNew) && rec.installerVersion === "0.1.0" && rec.targets[0].previous === "vencord-stub", rec);
    swappedTree = t;
}

console.log("\nU8 good start confirmed: boot marker set when the renderer is served, cleared when the plugin reports in");
{
    const u = updaterFor(swappedTree, null);
    check("startup of the trial version changes nothing", u.startup() === null && verifies(swappedTree.addonDir) === "0.1.1");
    u.markServed();
    check("renderer served -> boot marker set", u.readState().trial?.armed === true);
    check("main-process problems -> not confirmed", u.confirmBoot({ healthy: false, problems: ["plugin natives not loaded"] }).confirmed === false && u.readState().trial?.armed === true);
    check("plugin reported a good start -> trial over", u.confirmBoot({ healthy: true }).confirmed === true && !u.readState().trial);
    check("next start: nothing to do", updaterFor(swappedTree, null).startup() === null && verifies(swappedTree.addonDir) === "0.1.1");
}

console.log("\nU9 boot marker left set at the next start: automatic rollback, version marked bad, not downloaded again");
{
    const t = makeHome("u9");
    gh.publish("v0.1.1", zipNew);
    await updaterFor(t, gh).check({ autoDownload: true });
    updaterFor(t, null).startup();
    updaterFor(t, null).markServed(); // the swapped-in version got its renderer served... and never confirmed
    const u = updaterFor(t, null);
    const r = u.startup();
    check("rolled back 0.1.1 -> 0.1.0", r?.kind === "rolledBack" && r.from === "0.1.1" && r.to === "0.1.0", r);
    check("addon\\ = 0.1.0 again (verified); the failed version is not kept", verifies(t.addonDir) === "0.1.0" && !existsSync(t.prev) && !existsSync(join(t.home, "addon.old")));
    const st = u.readState();
    check("0.1.1 marked bad, rollback recorded, trial over", !!st.bad?.["0.1.1"] && st.lastRollback?.version === "0.1.1" && !st.trial, st);
    check("install.json back to 0.1.0 (version, commit, source)", goodRecord(t.record(), "0.1.0", "base0100") && t.record().source?.release === "v0.1.0", t.record());
    check("logged", u.lines.some(l => /ROLLED BACK/.test(l)));
    const again = await updaterFor(t, gh).check({ autoDownload: true });
    check("same release again: skipped (no download loop)", again.phase === "up-to-date" && again.skipped === "0.1.1" && zipDownloads() === 1 && !existsSync(t.staged), again);
}

console.log("\nU10 swap waits while another Discord runs from this add-on (second Discord.exe, other flavor); a stale marker does not block");
{
    const t = makeHome("u10", { staged: NEW });
    const run = join(t.home, "update", "run");
    mkdirSync(run, { recursive: true });
    // Windows: a real process named DiscordPTB.exe, named by the updater's own tasklist call; elsewhere a fake list
    const other = process.platform === "win32" ? discordLookalike("DiscordPTB.exe") : null;
    try {
        const pid = other?.pid ?? process.ppid;
        const u = updaterFor(t, null, other ? {} : { processNames: () => new Map([[pid, "DiscordPTB.exe"]]) });
        writeFileSync(join(run, String(pid)), "{}");
        check("no swap while a Discord PTB runs (tasklist names it)", u.startup() === null && verifies(t.addonDir) === "0.1.0" && verifies(t.staged) === "0.1.1" &&
            u.lines.some(l => /another Discord is running/.test(l) && /DiscordPTB\.exe/.test(l)), u.lines);
        const st = u.status();
        check("status(): ready, and why it waits (another Discord, with its pid and program)", st.phase === "ready" && st.waiting?.reason === "others" &&
            st.waiting.detail?.pids?.[0] === pid && st.waiting.detail?.exes?.[0] === "DiscordPTB.exe", st);
        rmSync(join(run, String(pid)));
    } finally {
        other?.kill();
    }
    // a marker left by a Discord that crashed, its pid now another live program's (this test's parent), and a dead one
    writeFileSync(join(run, String(process.ppid)), "{}");
    writeFileSync(join(run, "999999"), "{}");
    const u2 = updaterFor(t, null, process.platform === "win32" ? {} : { processNames: () => new Map([[process.ppid, "node"]]) });
    check("a stale marker (live pid, not a Discord) and a dead one: both dropped, the next start swaps, the reason is cleared",
        u2.startup()?.kind === "swapped" && verifies(t.addonDir) === "0.1.1" && !existsSync(join(run, "999999")) && !existsSync(join(run, String(process.ppid))) &&
        u2.readState().waiting === undefined, u2.lines);
}

console.log("\nU11 never downgrade, never a tampered stage");
{
    const t = makeHome("u11", { staged: OLDER });
    const u = updaterFor(t, null);
    check("staged 0.0.9 under 0.1.0: discarded at startup", u.startup() === null && verifies(t.addonDir) === "0.1.0" && !existsSync(t.staged));
    const t2 = makeHome("u11b", { staged: NEW });
    writeFileSync(join(t2.staged, "telinha.renderer.js"), "tampered after staging");
    check("staged files changed after verification: discarded at startup", updaterFor(t2, null).startup() === null && verifies(t2.addonDir) === "0.1.0" && !existsSync(t2.staged));
    const t3 = makeHome("u11c", { staged: NEW });
    const s = updaterFor(t3, null).readState();
    s.bad = { "0.1.1": { at: "x", reason: "test" } };
    mkdirSync(join(t3.home, "update"), { recursive: true });
    writeFileSync(join(t3.home, "update", "state.json"), JSON.stringify(s));
    check("staged version marked bad: discarded at startup", updaterFor(t3, null).startup() === null && verifies(t3.addonDir) === "0.1.0" && !existsSync(t3.staged));
}

console.log("\nU12 pure helpers");
{
    const c = upd.compareSemver;
    check("semver order", c("0.1.1", "0.1.0") === 1 && c("v0.1.0", "0.1.0") === 0 && c("0.1.0", "0.1.0-beta.2") === 1 && c("0.1.0-beta.10", "0.1.0-beta.2") === 1 && c("1.0.0", "0.99.99") === 1 && c("x", "0.1.0") === null);
    check("Zip Slip names refused", ["../a.js", "..\\a.js", "a/b.js", "C:x.js", "con.txt", "x.js.", "", "."].every(n => !upd.validName(n)) && upd.validName("telinha-audio.exe"));
    const h = "ab".repeat(32);
    check("published-hash parsers (same rules as the installer)", upd.hashFromSumFile(`${h}  Telinha-addon-x.zip\n`, "Telinha-addon-x.zip") === h &&
        upd.hashFromReleaseBody(`SHA-256 (Telinha-addon-x.zip) = ${h}`, "Telinha-addon-x.zip") === h && upd.hashFromVersionJson(`{"sha256":"${h}"}`, "Telinha-addon-x.zip") === h &&
        upd.hashFromVersionJson(`{"file":"other.zip","sha256":"${h}"}`, "Telinha-addon-x.zip") === "");
    check("asset picked by the installer's pattern", upd.pickAsset({ assets: [{ name: "TelinhaInstaller.exe" }, { name: "Telinha-addon-abc.zip.sha256" }, { name: "Telinha-addon-abc.zip" }] })?.name === "Telinha-addon-abc.zip");
}

// ------------------------------------------------------------------------------------------- I: the real loader at Discord start
console.log("\nI1 full cycle through the real loader: check (Electron net.fetch path) -> staged -> swapped at the next start -> good start confirmed");
let cycleTree;
{
    const t = makeTree("i1");
    gh.publish("v0.1.1", zipNew);
    const r1 = await boot("i1-a", t, { TELINHA_UPDATE_API: gh.base, FAKE_ADDON_CALLS: "bootOk,check" });
    const a1 = r1.addon ?? {};
    check("start 1: Discord + Vencord + Telinha 0.1.0 loaded", r1.afterLoad?.discordLoaded && a1.vencordLoaded && a1.rendererHooked && a1.version === "0.1.0" && r1.loaderMarker === "0.1.0", { a1, marker: r1.loaderMarker });
    check("pluginHelpers.TelinhaAddon = the loader's natives (next to the 8 plugin natives)", JSON.stringify([...(r1.preload?.addonHelpers ?? [])].sort()) === '["bootOk","updateCheck","updateDownload","updateLog","updateStatus"]' && r1.preload?.telinhaHelpers?.length === 8, r1.preload);
    check("update check over IPC: 0.1.1 downloaded, verified, staged", r1.addonCalls?.check?.phase === "ready" && verifies(t.staged) === "0.1.1" && verifies(t.addonDir) === "0.1.0", r1.addonCalls);
    const r2 = await boot("i1-b", t, { FAKE_ADDON_CALLS: "bootOk,status" });
    const a2 = r2.addon ?? {};
    check("start 2: the 0.1.0 loader swapped and handed the boot to the 0.1.1 loader", r2.loaderMarker === "0.1.1" && a2.version === "0.1.1" && a2.update?.kind === "swapped" && a2.update.from === "0.1.0", { marker: r2.loaderMarker, update: a2.update, version: a2.version });
    check("start 2: Discord + Vencord + Telinha 0.1.1 fully loaded (hooks, 8 natives, CSP, no errors)", r2.afterLoad?.discordLoaded && a2.vencordLoaded && a2.rendererHooked && a2.ipcMapHooked && a2.nativeChannels?.length === 8 && r2.csp?.mode === "chained" && !a2.errors?.length, a2.errors);
    check("addon\\ = 0.1.1, addon.prev = 0.1.0", verifies(t.addonDir) === "0.1.1" && verifies(t.prev) === "0.1.0" && !existsSync(t.staged));
    check("plugin's boot report confirmed the good start; trial over", r2.addonCalls?.bootOk?.confirmed === true && !t.state().trial && a2.bootConfirmed === true, { bootOk: r2.addonCalls?.bootOk, trial: t.state().trial });
    check("status after the swap: installed 0.1.1", r2.addonCalls?.status?.installed?.version === "0.1.1", r2.addonCalls?.status);
    check("install.json follows (0.1.1, source = the release)", goodRecord(t.record(), "0.1.1", "new00101") && t.record().source?.release === "v0.1.1");
    check("main.log tells the story", /update: staged, applied at the next Discord start/.test(t.mainLog()) && /update: activated/.test(t.mainLog()) && /handing the boot to Telinha 0\.1\.1/.test(t.mainLog()) && /good start confirmed/.test(t.mainLog()));
    const r3 = await boot("i1-c", t);
    check("start 3: plain start of 0.1.1, nothing moved", r3.loaderMarker === "0.1.1" && !r3.addon?.update && verifies(t.addonDir) === "0.1.1", r3.addon?.update);
    cycleTree = t;
}

console.log("\nI2 the new version never reports a good start: rolled back at the next start");
{
    const t = makeTree("i2", { staged: NEW });
    const r1 = await boot("i2-a", t); // renderer served, no boot report
    check("start 1: swapped to 0.1.1, boot marker set", r1.loaderMarker === "0.1.1" && t.state().trial?.armed === true, t.state().trial);
    const r2 = await boot("i2-b", t, { FAKE_ADDON_CALLS: "bootOk" });
    const a2 = r2.addon ?? {};
    check("start 2: the 0.1.1 loader rolled back and handed the boot to 0.1.0", r2.loaderMarker === "0.1.0" && a2.version === "0.1.0" && a2.update?.kind === "rolledBack" && a2.update.from === "0.1.1", { marker: r2.loaderMarker, update: a2.update });
    check("start 2: Discord + Vencord + Telinha 0.1.0 loaded", r2.afterLoad?.discordLoaded && a2.vencordLoaded && a2.rendererHooked && a2.nativeChannels?.length === 8 && !a2.errors?.length, a2.errors);
    check("0.1.1 marked bad, addon\\ = 0.1.0, install.json = 0.1.0", !!t.state().bad?.["0.1.1"] && verifies(t.addonDir) === "0.1.0" && goodRecord(t.record(), "0.1.0", "base0100"));
    check("main.log: ROLLED BACK", /update: ROLLED BACK/.test(t.mainLog()));
}

console.log("\nI3 the new loader throws while loading: rolled back in the same start, Telinha 0.1.0 still loads");
{
    const t = makeTree("i3", { staged: NEW_BROKEN_LOADER });
    const r = await boot("i3", t);
    const a = r.addon ?? {};
    check("Discord + Vencord + Telinha 0.1.0 loaded in that same start", r.afterLoad?.discordLoaded && a.vencordLoaded && a.rendererHooked && r.preload?.hasAddonRenderer && a.version === "0.1.0" && r.loaderMarker === "0.1.0", { marker: r.loaderMarker, version: a.version });
    check("immediate rollback recorded, 0.1.1 marked bad", a.update?.kind === "rolledBack" && a.update.immediate === true && !!t.state().bad?.["0.1.1"] && verifies(t.addonDir) === "0.1.0", a.update);
    check("the failure is logged", /ERROR swapped loader: .*simulated broken 0\.1\.1 loader/.test(t.mainLog()));
}

console.log("\nI4 the new version's natives throw: its start is not confirmed, rolled back at the next start");
{
    const t = makeTree("i4", { staged: NEW_BROKEN_NATIVES });
    const r1 = await boot("i4-a", t, { FAKE_ADDON_CALLS: "bootOk" });
    check("start 1: 0.1.1 runs, Discord fine, boot report refused (natives not loaded)", r1.loaderMarker === "0.1.1" && r1.afterLoad?.discordLoaded && r1.addonCalls?.bootOk?.confirmed === false && t.state().trial?.armed === true, r1.addonCalls);
    const r2 = await boot("i4-b", t, { FAKE_ADDON_CALLS: "bootOk" });
    check("start 2: back on 0.1.0 with working natives, 0.1.1 marked bad", r2.loaderMarker === "0.1.0" && r2.addon?.nativeChannels?.length === 8 && r2.addonCalls?.bootOk?.confirmed === true && !!t.state().bad?.["0.1.1"], r2.addon?.update);
}

console.log("\nI5 another Discord is running from the add-on: the swap waits and says why; a stale marker does not block");
{
    const t = makeTree("i5", { staged: NEW });
    const run = join(t.home, "update", "run");
    mkdirSync(run, { recursive: true });
    if (process.platform === "win32") {
        const other = discordLookalike("DiscordCanary.exe");
        try {
            writeFileSync(join(run, String(other.pid)), "{}");
            const r = await boot("i5", t);
            check("0.1.0 started normally, addon.new kept for later", r.loaderMarker === "0.1.0" && r.afterLoad?.discordLoaded && verifies(t.addonDir) === "0.1.0" && verifies(t.staged) === "0.1.1");
            check("main.log: another Discord (DiscordCanary.exe) is running", /another Discord is running from this add-on .*DiscordCanary\.exe/.test(t.mainLog()));
            check("state.json says why it waits (others, with the pid)", t.state().waiting?.reason === "others" && t.state().waiting.detail?.pids?.[0] === other.pid, t.state().waiting);
        } finally {
            other.kill();
        }
        rmSync(join(run, String(other.pid)), { force: true });
    }
    // this test process: alive, but node.exe, i.e. a crashed Discord's pid that Windows gave to another program
    writeFileSync(join(run, String(process.pid)), "{}");
    const r2 = await boot("i5-b", t);
    if (process.platform === "win32") {
        check("a marker whose pid is now another program: dropped, the swap goes ahead", r2.loaderMarker === "0.1.1" && verifies(t.addonDir) === "0.1.1" &&
            /run marker of a Discord that is gone, dropped/.test(t.mainLog()) && !existsSync(join(run, String(process.pid))), { marker: r2.loaderMarker });
    } else {
        check("no list of programs here (tasklist is Windows only): the live marker still counts", r2.loaderMarker === "0.1.0" && verifies(t.staged) === "0.1.1" &&
            /could not list the running programs/.test(t.mainLog()));
    }
}

console.log("\nI6 --vanilla: no swap, no hooks");
{
    const t = makeTree("i6", { staged: NEW });
    const r = await (async () => {
        const reportPath = join(t.root, "report-i6.json");
        const env = { ...process.env, FAKE_ROOT: t.root, FAKE_REPORT: reportPath, FAKE_DISCORD_EXE: join(t.appDir, "Discord.exe") };
        delete env.TELINHA_UPDATE_API;
        spawnSync(process.execPath, ["--require", join(HERE, "fake", "register.js"), join(t.res, "app.asar", "index.js"), "--vanilla"], { env, encoding: "utf8", timeout: 60_000 });
        return existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : {};
    })();
    check("addon\\ unchanged, addon.new kept", r.afterLoad?.discordLoaded && verifies(t.addonDir) === "0.1.0" && verifies(t.staged) === "0.1.1");
}

// ------------------------------------------------------------------------------------------- the Go installer reads the result
const cli = argValue("--installer") ?? join(REPO, "dist", "installer", "TelinhaInstaller-cli.exe");
if (process.platform === "win32" && existsSync(cli) && cycleTree) {
    console.log(`\nG the installer (${cli}) reads the add-on and install.json after an automatic update`);
    const r = spawnSync(cli, ["--status", "--json", "--appdata", join(cycleTree.root, "Roaming"), "--discord-dir", join(cycleTree.root, "Local", "Discord")], { encoding: "utf8", timeout: 60_000 });
    let s = null;
    try {
        s = JSON.parse(r.stdout);
    } catch { }
    check("--status --json: payload 0.1.1 verified, install.json 0.1.1 with its target, rollback to 0.1.0 available", s?.payload?.version === "0.1.1" && !s.payloadError && s.install?.version === "0.1.1" &&
        s.install.targets?.length === 1 && s.install.source?.release === "v0.1.1" && s.rollbackAvailable === true, s ?? r.stderr);
} else console.log("\nG skipped (no dist\\installer\\TelinhaInstaller-cli.exe: run `pnpm build:installer`, or pass --installer <exe>)");

await gh.close();
finish();
