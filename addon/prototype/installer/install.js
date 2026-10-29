#!/usr/bin/env node
/*
 * PeerLive addon prototype - installer CLI.
 *
 *   node install.js <status|install|uninstall> --discord <Discord root> --appdata <Roaming dir> [--real]
 *
 * install   : requires official Vencord already installed (resources/_app.asar present, app.asar = Vencord's
 *             stub). Copies the addon to <appdata>/PeerLive/addon, backs up Vencord's stub and writes ours into
 *             the newest app-* folder (the one Vencord's installer patches, find_discord_windows.go).
 *             Running it again repairs/updates (also after Vencord's installer replaced our stub).
 * uninstall : puts back a Vencord stub (byte-identical to Vencord installer output) wherever ours is, and
 *             removes <appdata>/PeerLive/addon. Vencord itself and its settings are left alone.
 *
 * Safety: refuses to touch the real %LOCALAPPDATA%\Discord / %APPDATA% unless --real is passed, and with
 * --real refuses while Discord is running.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { buildStubAsar, readAsarFile, parseVencordStub } = require("./asar");

const PROTO = path.join(__dirname, "..");
const ADDON_SOURCES = [path.join(PROTO, "loader"), path.join(PROTO, "payload")];
const STUB_MARKER = "// PeerLive stub";

function parseArgs(argv) {
    const args = { cmd: argv[0], real: false };
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === "--real") args.real = true;
        else if (argv[i] === "--discord") args.discord = path.resolve(argv[++i]);
        else if (argv[i] === "--appdata") args.appdata = path.resolve(argv[++i]);
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    return args;
}

const versionOf = dir => dir.slice(4).split(".").map(Number);
function newer(a, b) {
    const [x, y] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
}

function appFolders(discordRoot) {
    return fs.readdirSync(discordRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith("app-") && fs.existsSync(path.join(discordRoot, d.name, "resources")))
        .map(d => d.name)
        .sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
}

/** What is in resources/app.asar: vencord-stub | peerlive-stub | discord-original | missing | unknown */
function inspect(resources) {
    const appAsar = path.join(resources, "app.asar");
    const result = { resources, hasBackupOriginal: fs.existsSync(path.join(resources, "_app.asar")), kind: "missing", vencordPatcher: null };
    if (!fs.existsSync(appAsar)) return result;
    if (fs.statSync(appAsar).size > 64 * 1024) return { ...result, kind: "discord-original" };

    const index = readAsarFile(appAsar, "index.js");
    const vencord = parseVencordStub(index);
    if (vencord) return { ...result, kind: "vencord-stub", vencordPatcher: vencord };
    if (index?.startsWith(STUB_MARKER)) {
        const m = /const VENCORD_PATCHER = ("(?:[^"\\]|\\.)*");/.exec(index);
        return { ...result, kind: "peerlive-stub", vencordPatcher: m ? JSON.parse(m[1]) : null };
    }
    return { ...result, kind: "unknown" };
}

function renderStub(loaderPath, vencordPatcher) {
    const template = fs.readFileSync(path.join(PROTO, "loader", "stub-template.js"), "utf8");
    return template
        .replace("__PEERLIVE_LOADER__", JSON.stringify(loaderPath))
        .replace("__VENCORD_PATCHER__", JSON.stringify(vencordPatcher));
}

const vencordStub = patcherPath => buildStubAsar("require(" + JSON.stringify(patcherPath) + ")");

function atomicWrite(file, bytes) {
    const tmp = file + ".peerlive-tmp";
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
}

function copyAddon(target) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const dir of ADDON_SOURCES)
        for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(target, f));
}

function guard(args) {
    if (!args.discord || !args.appdata) throw new Error("--discord and --appdata are required");
    const realDiscord = process.env.LOCALAPPDATA && path.resolve(process.env.LOCALAPPDATA, "Discord");
    const realAppData = process.env.APPDATA && path.resolve(process.env.APPDATA);
    const touchesReal = [realDiscord, realAppData].some(r => r && [args.discord, args.appdata].some(p => p.toLowerCase() === r.toLowerCase()));
    if (touchesReal && !args.real) throw new Error("refusing to modify the real Discord/AppData without --real");
    if (args.real && process.platform === "win32") {
        const list = execFileSync("tasklist", ["/FI", "IMAGENAME eq Discord.exe", "/NH"], { encoding: "utf8" });
        if (/Discord\.exe/i.test(list)) throw new Error("Discord is running: close it completely (tray too) first");
    }
}

function status(args) {
    return appFolders(args.discord).map(name => ({ app: name, ...inspect(path.join(args.discord, name, "resources")) }));
}

function install(args) {
    const folders = appFolders(args.discord);
    if (!folders.length) throw new Error(`no app-* folder in ${args.discord}`);
    const latest = folders[folders.length - 1];
    const resources = path.join(args.discord, latest, "resources");
    const info = inspect(resources);

    if (!info.hasBackupOriginal || !["vencord-stub", "peerlive-stub"].includes(info.kind))
        throw new Error(`${latest}: official Vencord is not installed here (app.asar is ${info.kind}, _app.asar ${info.hasBackupOriginal ? "present" : "missing"}). Install Vencord first.`);
    if (!info.vencordPatcher || !fs.existsSync(info.vencordPatcher))
        throw new Error(`${latest}: Vencord's patcher.js not found at ${info.vencordPatcher}`);

    const home = path.join(args.appdata, "PeerLive");
    const addonDir = path.join(home, "addon");
    copyAddon(addonDir);

    if (info.kind === "vencord-stub") {
        fs.mkdirSync(path.join(home, "backup"), { recursive: true });
        fs.copyFileSync(path.join(resources, "app.asar"), path.join(home, "backup", `${latest}.vencord-app.asar`));
    }

    const stub = renderStub(path.join(addonDir, "main.js"), info.vencordPatcher);
    atomicWrite(path.join(resources, "app.asar"), buildStubAsar(stub));
    return { app: latest, previous: info.kind, vencordPatcher: info.vencordPatcher, addonDir };
}

function uninstall(args) {
    const restored = [];
    for (const name of appFolders(args.discord)) {
        const resources = path.join(args.discord, name, "resources");
        const info = inspect(resources);
        if (info.kind !== "peerlive-stub") continue;
        atomicWrite(path.join(resources, "app.asar"), vencordStub(info.vencordPatcher));
        restored.push(name);
    }
    fs.rmSync(path.join(args.appdata, "PeerLive", "addon"), { recursive: true, force: true });
    return { restored };
}

module.exports = { inspect, renderStub, vencordStub, status, install, uninstall, appFolders, STUB_MARKER };

if (require.main === module) {
    try {
        const args = parseArgs(process.argv.slice(2));
        guard(args);
        const run = { status, install, uninstall }[args.cmd];
        if (!run) throw new Error("usage: install.js <status|install|uninstall> --discord <dir> --appdata <dir> [--real]");
        console.log(JSON.stringify(run(args), null, 2));
    } catch (err) {
        console.error("[PeerLive installer]", err.message);
        process.exit(1);
    }
}
