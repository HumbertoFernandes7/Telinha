#!/usr/bin/env node
/*
 * Telinha add-on - DEV installer (Node). Reference implementation of addon/PAYLOAD.md sections 3-5, used by the
 * offline tests and the real-Discord test (addon/REAL-TEST.md). The product installer is the Go one in installer/.
 *
 *   node addon/installer/install.js <status|install|uninstall> --discord <Discord root> --appdata <Roaming dir>
 *        [--payload <dir>] [--real] [--purge]
 *
 *   --discord  a flavor root, e.g. %LOCALAPPDATA%\Discord (or DiscordPTB / DiscordCanary)
 *   --appdata  the Roaming folder (%APPDATA%); Telinha goes to <appdata>\Telinha
 *   --payload  the built payload (default: dist/addon/payload from `pnpm build:addon`)
 *   --real     required to touch the real %LOCALAPPDATA%\Discord* or %APPDATA%; then also refuses while Discord runs
 *   --purge    uninstall: also delete <appdata>\Telinha\logs
 *
 * install   : newest app-* must hold Vencord's stub (or ours) with _app.asar present. Copies + verifies the payload
 *             into <appdata>\Telinha\addon (staged swap), backs up Vencord's stub, writes our stub (atomic rename).
 *             Running it again repairs/updates, also after Vencord's installer replaced our stub.
 * uninstall : every app-* holding our stub gets Vencord's stub back (backup bytes, or regenerated = identical), then
 *             <appdata>\Telinha\{addon,backup,install.json} are removed. Vencord and its settings are left alone.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { buildStubAsar, readAsarFile, parseVencordStub } = require("./asar");

const REPO = path.join(__dirname, "..", "..");
const DEFAULT_PAYLOAD = path.join(REPO, "dist", "addon", "payload");
const STUB_MARKER = "// Telinha stub";
const MAX_STUB_BYTES = 64 * 1024;
const DISCORD_PROCESSES = ["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe", "DiscordDevelopment.exe"];

function parseArgs(argv) {
    const args = { cmd: argv[0], real: false, purge: false, payload: DEFAULT_PAYLOAD };
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === "--real") args.real = true;
        else if (argv[i] === "--purge") args.purge = true;
        else if (argv[i] === "--discord") args.discord = path.resolve(argv[++i]);
        else if (argv[i] === "--appdata") args.appdata = path.resolve(argv[++i]);
        else if (argv[i] === "--payload") args.payload = path.resolve(argv[++i]);
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    return args;
}

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

const versionOf = dir => dir.slice(4).split(".").map(Number);
function newer(a, b) {
    const [x, y] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
}

/** app-* folders with a resources folder, oldest first. */
function appFolders(discordRoot) {
    return fs.readdirSync(discordRoot, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^app-\d+(\.\d+)*$/.test(d.name) && fs.existsSync(path.join(discordRoot, d.name, "resources")))
        .map(d => d.name)
        .sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
}

const jsonStringAt = (text, re) => {
    const m = re.exec(text);
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
};

/** PAYLOAD.md 3.3: what is in resources/app.asar. kind: vencord-stub | telinha-stub | discord-original | missing | unknown */
function inspect(resources) {
    const appAsar = path.join(resources, "app.asar");
    const result = { resources, hasOriginal: fs.existsSync(path.join(resources, "_app.asar")), kind: "missing", vencordPatcher: null, telinhaLoader: null };
    if (!fs.existsSync(appAsar)) return result;
    const st = fs.statSync(appAsar);
    if (st.isDirectory()) return { ...result, kind: "unknown" };
    if (st.size > MAX_STUB_BYTES) return { ...result, kind: "discord-original" };

    let index = null;
    try {
        index = readAsarFile(appAsar, "index.js");
    } catch { }
    if (index == null) return { ...result, kind: "discord-original" };

    const vencord = parseVencordStub(index);
    if (vencord) {
        // Would regenerating Vencord's stub from this path give exactly these bytes? (what makes uninstall exact)
        const canonical = Buffer.compare(fs.readFileSync(appAsar), vencordStub(vencord)) === 0;
        return { ...result, kind: "vencord-stub", vencordPatcher: vencord, vencordStubCanonical: canonical };
    }
    if (index.startsWith(STUB_MARKER)) {
        return {
            ...result,
            kind: "telinha-stub",
            vencordPatcher: jsonStringAt(index, /^const VENCORD_PATCHER = ("(?:[^"\\]|\\.)*");$/m),
            telinhaLoader: jsonStringAt(index, /^const TELINHA_LOADER = ("(?:[^"\\]|\\.)*");$/m)
        };
    }
    return { ...result, kind: "unknown" };
}

/** PAYLOAD.md 3.1: template from the payload, two tokens replaced by JSON string literals. */
function renderStub(template, loaderPath, vencordPatcher) {
    for (const token of ["__TELINHA_LOADER__", "__VENCORD_PATCHER__"])
        if (template.split(token).length !== 2) throw new Error(`stub template must contain ${token} exactly once`);
    return template
        .replace("__TELINHA_LOADER__", () => JSON.stringify(loaderPath))
        .replace("__VENCORD_PATCHER__", () => JSON.stringify(vencordPatcher));
}

const vencordStub = patcherPath => buildStubAsar("require(" + JSON.stringify(patcherPath) + ")");

function atomicWrite(file, bytes) {
    const tmp = file + ".telinha-tmp";
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
}

const homeOf = args => path.join(args.appdata, "Telinha");
const backupFile = (args, appName) => path.join(homeOf(args), "backup", path.basename(args.discord), `${appName}.app.asar`);

/** Reads version.json and checks every listed file (size + SHA-256). Returns the parsed version.json. */
function verifyPayload(dir) {
    const versionFile = path.join(dir, "version.json");
    if (!fs.existsSync(versionFile)) throw new Error(`no version.json in ${dir} (run pnpm build:addon)`);
    const version = JSON.parse(fs.readFileSync(versionFile, "utf8"));
    if (version.payloadFormat !== 1) throw new Error(`unsupported payloadFormat ${version.payloadFormat}`);
    for (const [name, { size, sha256: hash }] of Object.entries(version.files ?? {})) {
        if (name !== path.basename(name)) throw new Error(`bad file name in version.json: ${name}`);
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) throw new Error(`payload file missing: ${name}`);
        const buf = fs.readFileSync(file);
        if (buf.length !== size || sha256(buf) !== hash) throw new Error(`payload file corrupted: ${name}`);
    }
    for (const required of [version.loaderEntry, version.stubTemplate])
        if (!version.files?.[required]) throw new Error(`payload lacks ${required}`);
    return version;
}

/** PAYLOAD.md 4.4: copy into addon.new, verify, swap. The previous addon stays if anything fails. */
function installPayload(payloadDir, home) {
    const version = verifyPayload(payloadDir);
    const target = path.join(home, "addon");
    const staged = path.join(home, "addon.new");
    const old = path.join(home, "addon.old");
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });
    try {
        for (const name of [...Object.keys(version.files), "version.json"]) fs.copyFileSync(path.join(payloadDir, name), path.join(staged, name));
        verifyPayload(staged);
    } catch (err) {
        fs.rmSync(staged, { recursive: true, force: true });
        throw err;
    }
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(staged, target);
    fs.rmSync(old, { recursive: true, force: true });
    return { version, addonDir: target };
}

function guard(args) {
    if (!args.discord || !args.appdata) throw new Error("--discord and --appdata are required");
    const local = process.env.LOCALAPPDATA && path.resolve(process.env.LOCALAPPDATA).toLowerCase();
    const roaming = process.env.APPDATA && path.resolve(process.env.APPDATA).toLowerCase();
    const d = args.discord.toLowerCase();
    const touchesReal = (local && path.dirname(d) === local && path.basename(d).startsWith("discord")) || (roaming && args.appdata.toLowerCase() === roaming);
    if (touchesReal && !args.real && args.cmd !== "status") throw new Error("refusing to modify the real Discord/AppData without --real");
    if (args.real && args.cmd !== "status" && process.platform === "win32") {
        const list = execFileSync("tasklist", ["/NH", "/FO", "CSV"], { encoding: "utf8" });
        const running = DISCORD_PROCESSES.filter(p => list.toLowerCase().includes(`"${p.toLowerCase()}"`));
        if (running.length) throw new Error(`${running.join(", ")} is running: quit Discord completely (tray icon -> Quit) first`);
    }
}

function status(args) {
    const home = homeOf(args);
    const versionFile = path.join(home, "addon", "version.json");
    return {
        discord: args.discord,
        apps: appFolders(args.discord).map(name => ({ app: name, ...inspect(path.join(args.discord, name, "resources")), backup: fs.existsSync(backupFile(args, name)) ? backupFile(args, name) : null })),
        installedAddon: fs.existsSync(versionFile) ? (({ version, commit, builtAt }) => ({ version, commit, builtAt }))(JSON.parse(fs.readFileSync(versionFile, "utf8"))) : null
    };
}

function install(args) {
    const folders = appFolders(args.discord);
    if (!folders.length) throw new Error(`no app-* folder in ${args.discord}`);
    const latest = folders[folders.length - 1];
    const resources = path.join(args.discord, latest, "resources");
    const info = inspect(resources);

    if (!info.hasOriginal || !["vencord-stub", "telinha-stub"].includes(info.kind))
        throw new Error(`${latest}: official Vencord is not installed here (app.asar is ${info.kind}, _app.asar ${info.hasOriginal ? "present" : "missing"}). Install Vencord first.`);
    if (!info.vencordPatcher || !fs.existsSync(info.vencordPatcher))
        throw new Error(`${latest}: Vencord's patcher.js not found at ${info.vencordPatcher}`);

    const home = homeOf(args);
    const { version, addonDir } = installPayload(args.payload, home);

    let backup = null;
    if (info.kind === "vencord-stub") {
        backup = backupFile(args, latest);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(path.join(resources, "app.asar"), backup);
    } else if (fs.existsSync(backupFile(args, latest))) backup = backupFile(args, latest);

    const template = fs.readFileSync(path.join(addonDir, version.stubTemplate), "utf8");
    const stub = renderStub(template, path.join(addonDir, version.loaderEntry), info.vencordPatcher);
    atomicWrite(path.join(resources, "app.asar"), buildStubAsar(stub));

    const after = inspect(resources);
    if (after.kind !== "telinha-stub" || after.vencordPatcher !== info.vencordPatcher)
        throw new Error(`${latest}: stub verification failed (${after.kind})`);

    const target = { flavor: path.basename(args.discord), app: latest, resources, vencordPatcher: info.vencordPatcher, previous: info.kind, backup };
    const installFile = path.join(home, "install.json");
    let record = { targets: [] };
    try {
        record = JSON.parse(fs.readFileSync(installFile, "utf8"));
    } catch { }
    record = {
        installedAt: new Date().toISOString(),
        version: version.version,
        commit: version.commit,
        targets: [...(record.targets ?? []).filter(t => t.resources !== resources), target]
    };
    fs.writeFileSync(installFile, JSON.stringify(record, null, 2));
    return { ...target, addonDir, version: version.version, commit: version.commit };
}

function uninstall(args) {
    const restored = [];
    for (const name of appFolders(args.discord)) {
        const resources = path.join(args.discord, name, "resources");
        const info = inspect(resources);
        if (info.kind !== "telinha-stub") continue;
        if (!info.vencordPatcher) throw new Error(`${name}: our stub has no readable VENCORD_PATCHER; restore ${resources}\\app.asar by hand`);

        const regenerated = vencordStub(info.vencordPatcher);
        let bytes = regenerated;
        let from = "regenerated";
        const backup = backupFile(args, name);
        if (fs.existsSync(backup)) {
            const saved = fs.readFileSync(backup);
            let savedPatcher = null;
            try {
                savedPatcher = parseVencordStub(readAsarFile(backup, "index.js"));
            } catch { }
            if (savedPatcher === info.vencordPatcher) {
                bytes = saved;
                from = "backup";
            }
        }
        atomicWrite(path.join(resources, "app.asar"), bytes);
        const after = inspect(resources);
        if (after.kind !== "vencord-stub" || after.vencordPatcher !== info.vencordPatcher)
            throw new Error(`${name}: restore verification failed (${after.kind})`);
        restored.push({ app: name, from, sha256: sha256(bytes), sameAsVencordInstallerOutput: Buffer.compare(bytes, regenerated) === 0 });
    }
    const home = homeOf(args);
    for (const p of ["addon", "addon.new", "addon.old", "backup", "install.json", ...(args.purge ? ["logs"] : [])])
        fs.rmSync(path.join(home, p), { recursive: true, force: true });
    if (args.purge && fs.existsSync(home) && !fs.readdirSync(home).length) fs.rmdirSync(home);
    return { restored };
}

module.exports = { inspect, renderStub, vencordStub, verifyPayload, status, install, uninstall, appFolders, STUB_MARKER, DEFAULT_PAYLOAD };

if (require.main === module) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const run = { status, install, uninstall }[args.cmd];
        if (!run) throw new Error("usage: install.js <status|install|uninstall> --discord <dir> --appdata <dir> [--payload <dir>] [--real] [--purge]");
        guard(args);
        console.log(JSON.stringify(run(args), null, 2));
    } catch (err) {
        console.error("[Telinha installer]", err.message);
        process.exit(1);
    }
}
