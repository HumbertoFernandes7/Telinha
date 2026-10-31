/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Telinha add-on - automatic updates, main process (%APPDATA%\Telinha\addon\updater.js). Contract: PAYLOAD.md section 8.
 *
 * Two halves, both owned by the loader (main.js):
 *
 *   startup()  synchronous, called by main.js boot() BEFORE any hook or plugin code of the add-on runs. It is the only
 *              code that changes %APPDATA%\Telinha\addon: it activates a staged update (addon.new -> addon, the version
 *              left behind -> addon.prev, same moves as the installer) or rolls back a version that never confirmed a
 *              good start (addon.prev -> addon). main.js then hands the boot to the loader now in addon\. The stub in
 *              resources\app.asar never changes: it always requires addon\main.js.
 *   check() /  asynchronous, asked for by the plugin (renderer) through the loader's own IPC channels: GitHub
 *   download() releases/latest -> Telinha-addon-*.zip -> SHA-256 published by GitHub (same rules as the installer)
 *              -> version.json of every file -> staged in addon.new. Never touches addon\ (telinha-audio.exe may be
 *              running from there) and never downgrades.
 *
 * Nothing here imports electron (the offline tests require this file directly); the caller passes fetch.
 */
"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const REPO = "HumbertoFernandes7/Telinha";
const API_BASE = "https://api.github.com";
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const ASSET_RE = /^Telinha-addon-[0-9A-Za-z._-]+\.zip$/;
const MANIFEST = "version.json";
const PAYLOAD_FORMAT = 1;
const STUB_FORMAT = 1;
// Every payload must have these: the stub requires addon\main.js by that exact name, main.js reads addon.json.
const REQUIRED_FILES = ["main.js", "addon.json"];

const MAX_ZIP = 64 << 20; // same limits as the installer (installer/internal/payload)
const MAX_SMALL = 4 << 20;
const MAX_FILES = 500;
const MAX_EXTRACTED = 256 << 20;

const HTTP_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const HEARTBEAT_MS = 5 * 60_000; // run markers: a live Discord touches its marker this often
const RUN_STALE_MS = 12 * 60 * 60_000; // ...so a marker this old belongs to a dead process whose pid was reused
const LOCK_STALE_MS = 2 * 60_000;
const UNARMED_LIMIT = 5; // a trial whose renderer never loaded in this many starts is dropped (kept, not rolled back)
// The main executable of every Discord flavor (installer/internal/core discordExeNames, PAYLOAD.md 4.1): only these boot
// our stub, so only these can own a run marker.
const DISCORD_EXES = new Set(["discord.exe", "discordptb.exe", "discordcanary.exe", "discorddevelopment.exe"]);
const TASKLIST_TIMEOUT_MS = 3000;
const RECENT_LOG_LINES = 10; // "update" lines of main.log in "Copiar diagnóstico"
const RECENT_LOG_LINE_MAX = 400;

// ------------------------------------------------------------------------------------------- small helpers

const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const iso = ms => new Date(ms).toISOString();

class PayloadError extends Error { }

/** An update failure with a short pt-BR message for the settings page. quiet = network/rate limit/offline. */
class UpdateError extends Error {
    constructor(kind, message, { quiet = false, detail = null, until = 0 } = {}) {
        super(message);
        this.kind = kind;
        this.quiet = quiet;
        this.detail = detail;
        this.until = until;
    }
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch { }
}

// Windows keeps files briefly locked (antivirus scan, a process that just exited): retry a few times, quickly,
// because startup() runs while Discord is starting.
const BUSY = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
function retry(fn, attempts = 5, delayMs = 200) {
    for (let i = 1; ; i++) {
        try {
            return fn();
        } catch (err) {
            if (i >= attempts || !BUSY.has(err?.code)) throw err;
            sleepSync(delayMs);
        }
    }
}

const rename = (from, to) => retry(() => fs.renameSync(from, to));
const remove = p => retry(() => fs.rmSync(p, { recursive: true, force: true }));
function tryRemove(p) {
    try {
        remove(p);
        return true;
    } catch {
        return false;
    }
}
function exists(p) {
    try {
        fs.statSync(p);
        return true;
    } catch {
        return false;
    }
}

// ------------------------------------------------------------------------------------------- running programs (Windows)

const isDiscordExe = name => typeof name === "string" && DISCORD_EXES.has(name.toLowerCase());

/** `tasklist /FO CSV /NH` output -> Map pid -> image name ("Discord.exe"). Throws when no line reads as a process. */
function parseTasklist(text) {
    const names = new Map();
    for (const line of String(text ?? "").split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m) names.set(Number(m[2]), m[1]);
    }
    if (!names.size) throw new Error("tasklist listed no process");
    return names;
}

/**
 * The image name of every running process, from Windows' own tasklist (about 0.1-0.3 s). Only called when a run
 * marker's pid answers, i.e. with an update waiting and maybe another Discord open. Throws when the list cannot be read
 * (not Windows, tasklist missing or slower than 3 s): the caller then counts the marker as before.
 */
function listProcessNames({ platform = process.platform, spawnSync = childProcess.spawnSync, env = process.env } = {}) {
    if (platform !== "win32") throw new Error(`no process list on ${platform}`);
    const exe = path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tasklist.exe");
    const r = spawnSync(exe, ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: TASKLIST_TIMEOUT_MS, maxBuffer: 8 << 20 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`tasklist exited with ${r.status ?? r.signal}`);
    return parseTasklist(r.stdout);
}

function readLimited(file, limit) {
    const st = fs.statSync(file);
    if (st.size > limit) throw new PayloadError(`${path.basename(file)} is too large`);
    return fs.readFileSync(file);
}

function writeAtomic(file, data) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    try {
        rename(tmp, file);
    } catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch { }
        throw err;
    }
}

// ------------------------------------------------------------------------------------------- versions

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(v) {
    const m = typeof v === "string" ? SEMVER_RE.exec(v.trim()) : null;
    return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] } : null;
}

/** "v0.1.1" -> "0.1.1" (build metadata dropped); null when not a version. */
function plainVersion(v) {
    const s = parseSemver(v);
    return s ? `${s.major}.${s.minor}.${s.patch}${s.pre.length ? "-" + s.pre.join(".") : ""}` : null;
}

/** Semantic-version order: -1, 0, 1, or null when either side is not a version. */
function compareSemver(a, b) {
    const x = parseSemver(a);
    const y = parseSemver(b);
    if (!x || !y) return null;
    for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i];
        const q = y.pre[i];
        if (p === undefined) return -1;
        if (q === undefined) return 1;
        const pn = /^\d+$/.test(p);
        const qn = /^\d+$/.test(q);
        if (pn && qn) {
            if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1;
        } else if (pn !== qn) return pn ? -1 : 1;
        else if (p !== q) return p > q ? 1 : -1;
    }
    return 0;
}

// ------------------------------------------------------------------------------------------- payload checks

const RESERVED = new Set(["con", "prn", "aux", "nul"]);

/** Flat, ordinary file names only (the payload has no subfolders). Same rule as the installer's ValidName. */
function validName(name) {
    if (typeof name !== "string" || !name || name === "." || name === ".." || name.length > 200) return false;
    if (/[/\\:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) return false;
    const stem = name.split(".")[0].toLowerCase();
    return !RESERVED.has(stem) && !/^(com|lpt)[0-9]$/.test(stem);
}

/** version.json checks: the installer's Manifest.Validate plus the files every loader needs. */
function validateManifest(m) {
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new PayloadError("version.json is not an object");
    if (m.payloadFormat !== PAYLOAD_FORMAT || m.stubFormat !== STUB_FORMAT)
        throw new PayloadError(`unsupported payload (payloadFormat ${m.payloadFormat}, stubFormat ${m.stubFormat})`);
    if (!parseSemver(m.version)) throw new PayloadError(`version.json: invalid version ${JSON.stringify(m.version)}`);
    const { files } = m;
    if (!files || typeof files !== "object" || Array.isArray(files)) throw new PayloadError("version.json: no files");
    const names = Object.keys(files);
    if (!names.length || names.length > MAX_FILES) throw new PayloadError(`version.json: ${names.length} files listed`);
    if (new Set(names.map(n => n.toLowerCase())).size !== names.length) throw new PayloadError("version.json: duplicate file names");
    let total = 0;
    for (const name of names) {
        const f = files[name];
        if (!validName(name) || name.toLowerCase() === MANIFEST) throw new PayloadError(`version.json: invalid file name ${JSON.stringify(name)}`);
        if (!f || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(f.sha256))
            throw new PayloadError(`version.json: bad entry for ${name}`);
        total += f.size;
    }
    if (total > MAX_EXTRACTED) throw new PayloadError(`version.json: payload too large (${total} bytes)`);
    for (const [what, name] of [["loaderEntry", m.loaderEntry], ["stubTemplate", m.stubTemplate]]) {
        if (!name) throw new PayloadError(`version.json: ${what} missing`);
        if (!hasOwn(files, name)) throw new PayloadError(`version.json: ${what} ${name} is not in files`);
    }
    for (const name of REQUIRED_FILES) if (!hasOwn(files, name)) throw new PayloadError(`version.json: ${name} is missing`);
    return m;
}

/** Reads and fully verifies a payload folder (every listed file: size + SHA-256). Returns its version.json. */
function verifyDir(dir) {
    let m;
    try {
        m = JSON.parse(readLimited(path.join(dir, MANIFEST), MAX_SMALL).toString("utf8"));
    } catch (err) {
        throw new PayloadError(`${MANIFEST}: ${err.message}`);
    }
    validateManifest(m);
    for (const [name, f] of Object.entries(m.files)) {
        let buf;
        try {
            buf = fs.readFileSync(path.join(dir, name));
        } catch {
            throw new PayloadError(`${name} is missing`);
        }
        if (buf.length !== f.size || sha256(buf) !== f.sha256.toLowerCase()) throw new PayloadError(`${name} does not match version.json`);
    }
    return m;
}

/** version.json of a payload folder, parsed but not verified (cheap: for labels and comparisons). */
function peekManifest(dir) {
    try {
        const m = JSON.parse(readLimited(path.join(dir, MANIFEST), MAX_SMALL).toString("utf8"));
        return m && typeof m === "object" && parseSemver(m.version) ? m : null;
    } catch {
        return null;
    }
}

function sameFiles(a, b) {
    const ka = Object.keys(a?.files ?? {});
    if (ka.length !== Object.keys(b?.files ?? {}).length) return false;
    return ka.every(k => hasOwn(b.files, k) && b.files[k].size === a.files[k].size && String(b.files[k].sha256).toLowerCase() === String(a.files[k].sha256).toLowerCase());
}

// ------------------------------------------------------------------------------------------- zip (read only)

let crcTable = null;
function crc32(buf) {
    if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
    if (!crcTable) {
        crcTable = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/** Central directory of a single-disk, non-zip64 archive (what build-addon.mjs writes). */
function zipEntries(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new PayloadError("not a zip file");
    let eocd = -1;
    for (let i = buf.length - 22, min = Math.max(0, buf.length - 22 - 0xffff); i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw new PayloadError("not a zip file (no end of central directory)");
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || buf.readUInt16LE(eocd + 8) !== count)
        throw new PayloadError("multi-disk zip");
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new PayloadError("zip64 is not supported");
    if (count > MAX_FILES + 50) throw new PayloadError(`zip has ${count} entries`);
    const cdEnd = cdOffset + cdSize;
    if (cdEnd > eocd) throw new PayloadError("malformed zip (central directory)");
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > cdEnd || buf.readUInt32LE(p) !== 0x02014b50) throw new PayloadError("malformed zip (central directory entry)");
        const nameLen = buf.readUInt16LE(p + 28);
        if (p + 46 + nameLen > cdEnd) throw new PayloadError("malformed zip (entry name)");
        entries.push({
            name: buf.toString("utf8", p + 46, p + 46 + nameLen),
            flags: buf.readUInt16LE(p + 8),
            method: buf.readUInt16LE(p + 10),
            crc: buf.readUInt32LE(p + 16),
            compressedSize: buf.readUInt32LE(p + 20),
            size: buf.readUInt32LE(p + 24),
            localOffset: buf.readUInt32LE(p + 42)
        });
        p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return entries;
}

function zipEntryData(buf, e) {
    const at = e.localOffset;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw new PayloadError(`malformed zip (local header of ${e.name})`);
    if (e.flags & 0x1) throw new PayloadError(`${e.name} is encrypted`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const end = start + e.compressedSize;
    if (end > buf.length) throw new PayloadError(`${e.name} is truncated`);
    const raw = buf.subarray(start, end);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
        try {
            data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
        } catch (err) {
            throw new PayloadError(`${e.name}: bad compressed data (${err.code ?? err.message})`);
        }
    } else throw new PayloadError(`${e.name}: unsupported compression method ${e.method}`);
    if (data.length !== e.size || crc32(data) !== e.crc) throw new PayloadError(`${e.name}: size/CRC mismatch`);
    return data;
}

/**
 * Validates a payload zip entirely in memory, before anything is written: every entry must be a flat, safe file name
 * (anything with a path, "..", a drive or a device name is a Zip Slip attempt: the whole zip is refused), version.json
 * at the root and valid, every listed file present with the listed size and SHA-256. Unlisted safe entries are ignored
 * (not extracted), like the installer does.
 */
function readPayloadZip(buf) {
    const byName = new Map();
    const seen = new Set();
    for (const e of zipEntries(buf)) {
        if (!validName(e.name)) throw new PayloadError(`unsafe or nested entry in the zip: ${JSON.stringify(e.name)}`);
        if (seen.has(e.name.toLowerCase())) throw new PayloadError(`duplicate entry in the zip: ${e.name}`);
        seen.add(e.name.toLowerCase());
        byName.set(e.name, e);
    }
    const me = byName.get(MANIFEST);
    if (!me) throw new PayloadError(`no ${MANIFEST} at the zip root`);
    if (me.size > MAX_SMALL) throw new PayloadError(`${MANIFEST} is too large`);
    const manifestBytes = zipEntryData(buf, me);
    let manifest;
    try {
        manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
        throw new PayloadError(`${MANIFEST} is not JSON`);
    }
    validateManifest(manifest);
    const files = new Map();
    for (const [name, f] of Object.entries(manifest.files)) {
        const e = byName.get(name);
        if (!e) throw new PayloadError(`${name} (listed in version.json) is missing from the zip`);
        if (e.size !== f.size) throw new PayloadError(`${name} has ${e.size} bytes, version.json says ${f.size}`);
        const data = zipEntryData(buf, e);
        if (sha256(data) !== f.sha256.toLowerCase()) throw new PayloadError(`${name}: SHA-256 does not match version.json`);
        files.set(name, data);
    }
    const ignored = [...byName.keys()].filter(n => n !== MANIFEST && !hasOwn(manifest.files, n));
    return { manifest, manifestBytes, files, ignored };
}

// ------------------------------------------------------------------------------------------- published SHA-256 (same rules as installer/internal/payload/github.go)

const HEX64_RE = /\b[0-9a-f]{64}\b/i;

function normHash(s) {
    const h = String(s ?? "").trim().toLowerCase().replace(/^sha256:/, "");
    return /^[0-9a-f]{64}$/.test(h) ? h : "";
}

/** sha256sum output ("<hex>  <name>"): the line for assetName, or the only hash. */
function hashFromSumFile(text, assetName) {
    const all = [];
    for (const line of String(text).split("\n")) {
        const f = line.trim().split(/\s+/).filter(Boolean);
        if (!f.length || !normHash(f[0])) continue;
        if (f.length >= 2 && f[1].replace(/^\*/, "").toLowerCase() === assetName.toLowerCase()) return normHash(f[0]);
        all.push(normHash(f[0]));
    }
    return all.length === 1 ? all[0] : "";
}

/** Release notes: a line naming the asset with a 64-hex string, or a single line labelled SHA-256. */
function hashFromReleaseBody(body, assetName) {
    const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
    for (const l of lines) {
        if (l.toLowerCase().includes(assetName.toLowerCase())) {
            const m = HEX64_RE.exec(l);
            if (m) return m[0].toLowerCase();
        }
    }
    const found = [];
    for (const l of lines) {
        const ll = l.toLowerCase();
        if (ll.includes("sha-256") || ll.includes("sha256")) {
            const m = HEX64_RE.exec(l);
            if (m && !ll.includes(".zip")) found.push(m[0].toLowerCase());
        }
    }
    return found.length === 1 ? found[0] : "";
}

/** A small JSON naming the zip's SHA-256 (not a payload manifest). Accepted shapes as in the installer. */
function hashFromVersionJson(text, assetName) {
    let v;
    try {
        v = JSON.parse(text);
    } catch {
        return "";
    }
    const find = x => {
        if (Array.isArray(x)) {
            for (const e of x) {
                const h = find(e);
                if (h) return h;
            }
            return "";
        }
        if (!x || typeof x !== "object") return "";
        for (const k of ["file", "asset", "name", "zip", "filename", "fileName"]) {
            const s = x[k];
            if (typeof s === "string" && s.toLowerCase().endsWith(".zip") && path.posix.basename(s.replace(/\\/g, "/")).toLowerCase() !== assetName.toLowerCase()) return "";
        }
        for (const k of ["sha256", "sha-256", "SHA256", "SHA-256", "zipSha256", "digest"]) {
            if (typeof x[k] === "string" && normHash(x[k])) return normHash(x[k]);
        }
        for (const [k, sub] of Object.entries(x)) {
            if (k.toLowerCase() === assetName.toLowerCase()) return typeof sub === "string" ? normHash(sub) : find(sub);
        }
        for (const k of ["assets", "zip", "checksums", "release"]) {
            if (hasOwn(x, k)) {
                const h = find(x[k]);
                if (h) return h;
            }
        }
        return "";
    };
    return find(v);
}

function pickAsset(release) {
    let best = null;
    for (const a of Array.isArray(release?.assets) ? release.assets : [])
        if (typeof a?.name === "string" && ASSET_RE.test(a.name) && (!best || a.name > best.name)) best = a;
    return best;
}

/** Only the fields we use (and keep in state.json for conditional requests). */
function slimRelease(r) {
    return {
        tag_name: String(r?.tag_name ?? ""),
        draft: !!r?.draft,
        prerelease: !!r?.prerelease,
        body: typeof r?.body === "string" ? r.body.slice(0, 64 * 1024) : "",
        assets: (Array.isArray(r?.assets) ? r.assets : []).slice(0, 50).map(a => ({
            name: String(a?.name ?? ""),
            size: Number(a?.size) || 0,
            digest: typeof a?.digest === "string" ? a.digest : "",
            browser_download_url: String(a?.browser_download_url ?? "")
        }))
    };
}

// ------------------------------------------------------------------------------------------- the updater

/**
 * @param {object} o
 * @param {string} o.addonDir   %APPDATA%\Telinha\addon (main.js's own folder); its parent is the Telinha home
 * @param {(msg: string, data?: any) => void} [o.log]
 * @param {typeof fetch} [o.fetch]  Electron net.fetch in production (follows redirects to GitHub's asset CDN)
 * @param {string} [o.apiBase]      only a loopback http:// base is accepted besides api.github.com (offline tests)
 * @param {() => number} [o.now]
 * @param {string} [o.logFile]      main.log (main.js's own log): its last "update" lines go into "Copiar diagnóstico"
 * @param {() => Map<number, string>} [o.processNames]  pid -> image name of every running process (tests replace it)
 */
function createUpdater({ addonDir, log = () => { }, fetch: fetchImpl = globalThis.fetch, apiBase = API_BASE, now = Date.now, userAgent, logFile = null, processNames = () => listProcessNames() } = {}) {
    const home = path.dirname(addonDir);
    const P = {
        home,
        addon: addonDir,
        staged: path.join(home, "addon.new"),
        old: path.join(home, "addon.old"),
        prev: path.join(home, "addon.prev"),
        updateDir: path.join(home, "update"),
        state: path.join(home, "update", "state.json"),
        runDir: path.join(home, "update", "run"),
        lock: path.join(home, "update", "swap.lock"),
        record: path.join(home, "install.json")
    };
    const testBase = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(String(apiBase).replace(/\/+$/, ""));
    const base = testBase ? String(apiBase).replace(/\/+$/, "") : API_BASE;
    const installed = peekManifest(addonDir); // the version running now (its loader is the one that created us)
    const ua = userAgent ?? `Telinha-addon/${installed?.version ?? "?"} (+https://github.com/${REPO})`;

    // --------------------------------------------------------------------------------------- state.json

    function readState() {
        try {
            const s = JSON.parse(readLimited(P.state, MAX_SMALL).toString("utf8"));
            if (s && typeof s === "object" && !Array.isArray(s)) {
                if (!s.bad || typeof s.bad !== "object" || Array.isArray(s.bad)) s.bad = {};
                s.format = 1;
                return s;
            }
        } catch (err) {
            if (err?.code !== "ENOENT") log("update: state.json unreadable, starting over", String(err?.message ?? err));
        }
        return { format: 1, bad: {} };
    }

    function writeState(s) {
        fs.mkdirSync(P.updateDir, { recursive: true });
        writeAtomic(P.state, JSON.stringify(s, null, 2) + "\n");
    }

    function mutateState(fn) {
        const s = readState();
        fn(s);
        writeState(s);
        return s;
    }

    const isBad = (s, version) => !!version && hasOwn(s.bad, version);
    const sameBuild = (t, m) => !!t && !!m && t.version === m.version && (t.commit ?? null) === (m.commit ?? null);

    // --------------------------------------------------------------------------------------- install.json

    function readRecord() {
        try {
            const r = JSON.parse(readLimited(P.record, MAX_SMALL).toString("utf8"));
            return r && typeof r === "object" && !Array.isArray(r) ? r : null;
        } catch {
            return null;
        }
    }

    /** Keeps install.json (read by the installer's --status, Atualizar, Desinstalar) in step with addon\. Never creates it. */
    function updateRecord(fields) {
        const r = readRecord();
        if (!r) return false;
        try {
            Object.assign(r, fields, { installedAt: iso(now()).replace(/\.\d{3}Z$/, "Z") });
            for (const [k, v] of Object.entries(fields)) if (v === undefined) delete r[k];
            if (!Array.isArray(r.targets)) r.targets = [];
            writeAtomic(P.record, JSON.stringify(r, null, 2) + "\n");
            return true;
        } catch (err) {
            log("update: install.json not updated", String(err?.message ?? err));
            return false;
        }
    }

    // --------------------------------------------------------------------------------------- other Discords

    /** Marks this process as running the add-on (every Discord flavor shares %APPDATA%\Telinha\addon). */
    function registerRun() {
        try {
            fs.mkdirSync(P.runDir, { recursive: true });
            const file = path.join(P.runDir, String(process.pid));
            const touch = () => {
                try {
                    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: iso(now()), version: installed?.version ?? null }));
                } catch { }
            };
            touch();
            const prev = globalThis.__TelinhaRunMarker;
            if (prev?.file === file) clearInterval(prev.timer);
            const timer = setInterval(touch, HEARTBEAT_MS);
            timer.unref?.();
            if (!prev) {
                process.once("exit", () => {
                    try {
                        fs.rmSync(file, { force: true });
                    } catch { }
                });
            }
            globalThis.__TelinhaRunMarker = { file, timer };
        } catch (err) {
            log("update: run marker not written", String(err?.message ?? err));
        }
    }

    /**
     * Other live processes using the add-on: a second Discord.exe started while one is already open (it boots
     * through our stub before Discord's single-instance check makes it quit), or another flavor (PTB, Canary).
     * Swapping under them would mix versions, so startup() waits for the next start when it finds one.
     * Returns [{ pid, exe }] (exe: the program's name, null when the list of programs could not be read).
     */
    function othersRunning() {
        const alive = [];
        let names = [];
        try {
            names = fs.readdirSync(P.runDir);
        } catch {
            return alive;
        }
        for (const name of names) {
            const pid = Number(name);
            const file = path.join(P.runDir, name);
            if (pid === process.pid) continue;
            let fresh = false;
            try {
                fresh = now() - fs.statSync(file).mtimeMs < RUN_STALE_MS;
            } catch {
                continue;
            }
            let live = false;
            if (Number.isSafeInteger(pid) && pid > 0) {
                try {
                    process.kill(pid, 0);
                    live = true;
                } catch (err) {
                    live = err?.code === "EPERM";
                }
            }
            if (fresh && live) alive.push({ pid, file });
            else tryRemove(file);
        }
        if (!alive.length) return [];
        // A marker outlives a Discord that ended without 'exit' (a crash, End task, a power cut, Windows shutting down),
        // and Windows soon gives its pid to another process (a service answers EPERM): only a Discord program can own it.
        let running = null;
        try {
            running = processNames();
            if (!(running instanceof Map)) throw new Error("no list of programs");
        } catch (err) {
            running = null;
            log("update: could not list the running programs; the run markers count as other Discords", String(err?.message ?? err));
        }
        const others = [];
        for (const { pid, file } of alive) {
            const exe = running?.get(pid) ?? null;
            if (running && !isDiscordExe(exe)) {
                log("update: run marker of a Discord that is gone, dropped (its pid now belongs to another program)", { pid, exe });
                tryRemove(file);
            } else others.push({ pid, exe });
        }
        return others;
    }

    /** What a staged update / rollback waiting on other Discords logs and records: their pids, and names when known. */
    function othersDetail(others) {
        const detail = { pids: others.map(o => o.pid) };
        if (others.some(o => o.exe)) detail.exes = others.map(o => o.exe);
        return detail;
    }

    /**
     * Why the last swap / rollback attempt of this start did not happen ({ reason, detail }), set where it gave up:
     * "locked" (swap.lock), "in-use" (addon\ could not be moved aside), "activate-failed" (the new folder could not be
     * moved in). startup() records it in state.json for the plugin (status().waiting).
     */
    let blocked = null;
    const errCode = err => ({ code: typeof err?.code === "string" ? err.code : null });

    /** One process at a time moves the add-on folders (two flavors starting together). */
    function withLock(fn) {
        fs.mkdirSync(P.updateDir, { recursive: true });
        let fd;
        for (let i = 0; i < 2 && fd === undefined; i++) {
            try {
                fd = fs.openSync(P.lock, "wx");
            } catch (err) {
                if (err?.code !== "EEXIST") throw err;
                let stale = true;
                try {
                    stale = now() - fs.statSync(P.lock).mtimeMs > LOCK_STALE_MS;
                } catch { }
                if (!stale) {
                    log("update: swap.lock is held by another Discord start (under 2 minutes old); the add-on folders wait for the next start");
                    blocked = { reason: "locked", detail: null };
                    return null;
                }
                tryRemove(P.lock);
            }
        }
        if (fd === undefined) {
            log("update: an old swap.lock could not be removed; the add-on folders wait for the next start");
            blocked = { reason: "locked", detail: null };
            return null;
        }
        try {
            return fn();
        } finally {
            try {
                fs.closeSync(fd);
            } catch { }
            tryRemove(P.lock);
        }
    }

    // --------------------------------------------------------------------------------------- startup (sync)

    /** addon.new -> addon; the version left behind -> addon.prev. Caller holds the lock. */
    function swapLocked(s) {
        let m;
        try {
            m = verifyDir(P.staged);
        } catch (err) {
            log("update: staged add-on is invalid, discarding it", err.message);
            tryRemove(P.staged);
            delete s.staged;
            return null;
        }
        const cmp = compareSemver(m.version, installed.version);
        if (cmp === null || cmp <= 0 || isBad(s, m.version)) {
            log("update: staged add-on is not a newer, good version; discarding it", { staged: m.version, installed: installed.version, bad: isBad(s, m.version) });
            tryRemove(P.staged);
            delete s.staged;
            return null;
        }
        try {
            remove(P.old);
            rename(P.addon, P.old);
        } catch (err) {
            log("update: the add-on folder is in use; the update waits for the next start", String(err?.message ?? err));
            blocked = { reason: "in-use", detail: errCode(err) };
            return null;
        }
        try {
            rename(P.staged, P.addon);
        } catch (err) {
            try {
                rename(P.old, P.addon);
            } catch (err2) {
                log("update: ERROR could not put the add-on folder back", String(err2?.message ?? err2));
            }
            log("update: could not activate the staged add-on; it waits for the next start", String(err?.message ?? err));
            blocked = { reason: "activate-failed", detail: errCode(err) };
            return null;
        }
        try {
            remove(P.prev);
            rename(P.old, P.prev);
        } catch (err) {
            log("update: previous version not kept as addon.prev (no rollback possible)", String(err?.message ?? err));
            tryRemove(P.old);
        }
        const rec = readRecord();
        const staged = s.staged?.version === m.version && s.staged?.commit === m.commit ? s.staged : null;
        s.trial = {
            version: m.version, commit: m.commit ?? null, previous: installed.version, previousCommit: installed.commit ?? null,
            swappedAt: iso(now()), armed: false, unarmedStarts: 0,
            previousRecord: rec ? { version: rec.version ?? null, commit: rec.commit ?? null, source: rec.source ?? null } : null
        };
        delete s.staged;
        delete s.waiting;
        writeState(s);
        updateRecord({
            version: m.version, commit: m.commit ?? "",
            source: staged ? { kind: "github", release: staged.tag, asset: staged.asset, sha256: staged.sha256 } : undefined,
            updatedBy: "telinha-auto-update"
        });
        log("update: activated", { from: installed.version, to: m.version, commit: m.commit });
        return { kind: "swapped", from: installed.version, to: m.version };
    }

    /** addon -> (deleted), addon.prev -> addon; the failed version is marked bad. Caller holds the lock. */
    function rollbackLocked(s, reason) {
        const t = s.trial;
        if (!t) return null;
        let prev;
        try {
            prev = verifyDir(P.prev);
            if (prev.version === t.version && prev.commit === t.commit) throw new PayloadError("addon.prev is the failed version itself");
        } catch (err) {
            log("update: ERROR cannot roll back, no usable previous version; keeping", { version: t.version, why: err.message });
            delete s.trial;
            writeState(s);
            return null;
        }
        try {
            remove(P.old);
            rename(P.addon, P.old);
        } catch (err) {
            log("update: rollback postponed, the add-on folder is in use", String(err?.message ?? err));
            blocked = { reason: "in-use", detail: errCode(err) };
            return null;
        }
        try {
            rename(P.prev, P.addon);
        } catch (err) {
            try {
                rename(P.old, P.addon);
            } catch { }
            log("update: rollback postponed, could not restore addon.prev", String(err?.message ?? err));
            blocked = { reason: "activate-failed", detail: errCode(err) };
            return null;
        }
        tryRemove(P.old); // the failed version is not kept as addon.prev
        const at = iso(now());
        s.bad[t.version] = { commit: t.commit ?? null, at, reason };
        s.lastRollback = { version: t.version, to: prev.version, at, reason };
        delete s.trial;
        delete s.waiting;
        if (s.staged?.version === t.version) delete s.staged;
        writeState(s);
        const pr = t.previousRecord;
        updateRecord({
            version: pr?.version === prev.version ? pr.version : prev.version,
            commit: pr?.version === prev.version ? pr.commit ?? prev.commit ?? "" : prev.commit ?? "",
            source: pr?.version === prev.version && pr.source ? pr.source : undefined,
            updatedBy: "telinha-auto-rollback"
        });
        log("update: ROLLED BACK", { from: t.version, to: prev.version, reason, markedBad: t.version });
        return { kind: "rolledBack", from: t.version, to: prev.version };
    }

    function cleanLeftovers() {
        let names = [];
        try {
            names = fs.readdirSync(P.updateDir);
        } catch {
            return;
        }
        for (const n of names) {
            const m = /^staging-(\d+)-/.exec(n);
            if (m && Number(m[1]) !== process.pid) tryRemove(path.join(P.updateDir, n));
        }
    }

    /**
     * state.json `waiting`: why the staged update did not go in at this start, for the plugin (status().waiting: the
     * notice, the settings line, "Copiar diagnóstico"). `starts` counts the starts in a row it waited for this version.
     */
    function noteWait(s, reason, detail = null) {
        const version = peekManifest(P.staged)?.version ?? null;
        const prev = s.waiting && typeof s.waiting === "object" ? s.waiting : null;
        const starts = prev?.version === version && Number.isSafeInteger(prev.starts) && prev.starts > 0 ? prev.starts + 1 : 1;
        s.waiting = { version, reason, detail, at: iso(now()), starts };
    }

    /**
     * Runs at every Discord start, before the add-on's hooks: rolls back a version that never confirmed a good start,
     * or activates a staged update. Returns what changed in addon\ ({ kind: "swapped" | "rolledBack" }) or null.
     * Never throws for expected failures (locked files, another Discord running): those wait for the next start, and
     * the reason is kept in state.json (`waiting`) so the plugin can say why.
     */
    function startup({ actions = true } = {}) {
        registerRun();
        if (!installed) {
            log("update: the installed version.json is unreadable; updates are off this session");
            return null;
        }
        if (!actions) return null;
        cleanLeftovers();
        const s = readState();
        let dirty = false;
        if (s.trial && !sameBuild(s.trial, installed)) {
            // the add-on was replaced since (installer, manual copy): nothing to judge anymore
            log("update: dropping the trial of a version that is no longer installed", { trial: s.trial.version, installed: installed.version });
            delete s.trial;
            dirty = true;
        }
        const staged = exists(P.staged);
        if (!staged && s.waiting) {
            delete s.waiting;
            dirty = true;
        }
        const others = s.trial?.armed || staged ? othersRunning() : [];
        const wait = (reason, detail = null) => {
            if (!staged) return;
            noteWait(s, reason, detail);
            dirty = true;
        };

        if (s.trial?.armed) {
            // The renderer was served in an earlier start but never reported a good start: the boot marker was left set.
            if (others.length) {
                log("update: rollback waits, another Discord is running from this add-on", othersDetail(others));
                wait("others", othersDetail(others));
            } else {
                blocked = null;
                const done = withLock(() => rollbackLocked(s, `Telinha ${s.trial.version} did not confirm a good start (boot marker left set)`));
                if (done) return done;
                // no usable addon.prev: the trial was dropped, the staged update is tried at the next start
                wait(blocked?.reason ?? "trial", blocked?.detail ?? null);
            }
            if (dirty) writeState(s);
            return null;
        }
        if (s.trial) {
            s.trial.unarmedStarts = (s.trial.unarmedStarts ?? 0) + 1;
            if (s.trial.unarmedStarts > UNARMED_LIMIT) {
                log("update: the renderer never loaded during the trial; keeping the version", { version: s.trial.version });
                delete s.trial;
            }
            dirty = true;
        }

        if (staged) {
            if (s.trial) {
                log("update: staged update waits until the current version confirms a good start");
                wait("trial");
            } else if (others.length) {
                log("update: staged update waits, another Discord is running from this add-on", othersDetail(others));
                wait("others", othersDetail(others));
            } else {
                blocked = null;
                const done = withLock(() => swapLocked(s));
                if (done) return done;
                if (exists(P.staged)) wait(blocked?.reason ?? "unknown", blocked?.detail ?? null);
                else delete s.waiting; // discarded (invalid, not newer): nothing waits anymore
                dirty = true;
            }
        }
        if (dirty) writeState(s);
        return null;
    }

    /**
     * The new loader could not even start (require threw, no boot(), boot() threw before Vencord): put the previous
     * version back right away, in this same start, and mark the new one bad.
     */
    function rollbackNow(reason) {
        try {
            const s = readState();
            if (!s.trial) return null;
            return withLock(() => rollbackLocked(s, reason));
        } catch (err) {
            log("update: ERROR rollback failed", String(err?.message ?? err));
            return null;
        }
    }

    let served = false;
    /** The renderer got the add-on: from now on a start that never confirms counts as a failed start. */
    function markServed() {
        if (served || !installed) return;
        served = true;
        try {
            const s = readState();
            if (s.trial && sameBuild(s.trial, installed) && !s.trial.armed) {
                s.trial.armed = true;
                s.trial.armedAt = iso(now());
                writeState(s);
                log("update: boot marker set (renderer served); waiting for the plugin to confirm a good start", { version: installed.version });
            }
        } catch (err) {
            log("update: boot marker not written", String(err?.message ?? err));
        }
    }

    let confirmed = false;
    /** The renderer registered (and, when enabled, started) the plugin. healthy = no main-process failures either. */
    function confirmBoot({ healthy = true, problems = [], info = null } = {}) {
        if (!installed) return { confirmed: false };
        if (!healthy) {
            log("update: good start NOT confirmed (main-process problems)", { version: installed.version, problems, info });
            return { confirmed: false };
        }
        if (confirmed) return { confirmed: true };
        confirmed = true;
        try {
            const s = readState();
            let dirty = false;
            if (s.trial && sameBuild(s.trial, installed)) {
                log("update: good start confirmed", { version: installed.version, previous: s.trial.previous, info });
                delete s.trial;
                dirty = true;
            }
            if (isBad(s, installed.version)) {
                // installed again on purpose (installer) and working: no longer skip it
                delete s.bad[installed.version];
                dirty = true;
            }
            if (dirty) writeState(s);
        } catch (err) {
            log("update: could not record the good start", String(err?.message ?? err));
        }
        return { confirmed: true };
    }

    // --------------------------------------------------------------------------------------- network (async)

    const rt = { phase: "idle", latest: null, error: null, checkedAt: null, skipped: null, inflight: null, rateLimitedUntil: 0 };

    /**
     * One HTTP request; returns what `use(res)` returns. The time limit covers the whole exchange, body included: `use`
     * reads the response while the timer still runs, so a connection that goes quiet in the middle of the body is aborted
     * too (the timer used to be cleared as soon as the headers arrived, and a stalled download then hung the check forever).
     */
    async function request(url, { accept, etag, timeoutMs = HTTP_TIMEOUT_MS } = {}, use) {
        if (typeof fetchImpl !== "function") throw new UpdateError("offline", "sem acesso à rede neste Discord", { quiet: true });
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            let res;
            try {
                const headers = { "User-Agent": ua, Accept: accept ?? "application/octet-stream" };
                if (etag) headers["If-None-Match"] = etag;
                res = await fetchImpl(url, { headers, redirect: "follow", signal: ctrl.signal, cache: "no-store" });
            } catch (err) {
                throw new UpdateError("offline", "sem conexão com o GitHub; tento de novo mais tarde", { quiet: true, detail: `${url}: ${err?.message ?? err}` });
            }
            return await use(res);
        } finally {
            clearTimeout(timer);
        }
    }

    function httpError(res, url) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        if (res.status === 429 || (res.status === 403 && (remaining === "0" || res.headers.get("retry-after")))) {
            const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
            const after = Number(res.headers.get("retry-after")) * 1000;
            const until = reset > now() ? reset : now() + (after > 0 ? after : 60 * 60_000);
            return new UpdateError("rate-limit", "o GitHub pediu para esperar um pouco; tento de novo mais tarde", { quiet: true, until, detail: `${url}: HTTP ${res.status}` });
        }
        return new UpdateError("http", `o GitHub respondeu com erro (HTTP ${res.status}); tento de novo mais tarde`, { quiet: true, detail: `${url}: HTTP ${res.status}` });
    }

    async function readBody(res, limit, url) {
        const len = Number(res.headers.get("content-length"));
        if (Number.isFinite(len) && len > limit) throw new UpdateError("invalid", "o arquivo publicado é grande demais", { detail: `${url}: ${len} bytes` });
        try {
            if (!res.body?.getReader) {
                const b = Buffer.from(await res.arrayBuffer());
                if (b.length > limit) throw new UpdateError("invalid", "o arquivo publicado é grande demais");
                return b;
            }
            const reader = res.body.getReader();
            const chunks = [];
            let total = 0;
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > limit) {
                    try {
                        await reader.cancel();
                    } catch { }
                    throw new UpdateError("invalid", "o arquivo publicado é grande demais", { detail: `${url}: more than ${limit} bytes` });
                }
                chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
            }
            return Buffer.concat(chunks, total);
        } catch (err) {
            if (err instanceof UpdateError) throw err;
            throw new UpdateError("offline", "o download foi interrompido; tento de novo mais tarde", { quiet: true, detail: `${url}: ${err?.message ?? err}` });
        }
    }

    function allowedDownload(url) {
        const u = String(url);
        return testBase ? u.startsWith(base + "/") : u.toLowerCase().startsWith(DOWNLOAD_PREFIX.toLowerCase());
    }

    async function getAsset(url, limit, timeoutMs) {
        if (!allowedDownload(url)) throw new UpdateError("invalid", "a release aponta para um download fora do GitHub do Telinha", { detail: url });
        return request(url, { timeoutMs }, async res => {
            if (!res.ok) throw httpError(res, url);
            return readBody(res, limit, url);
        });
    }

    async function fetchLatest(s) {
        const url = `${base}/repos/${REPO}/releases/latest`;
        const cached = s.lastCheck?.etag && s.lastCheck?.release ? s.lastCheck : null;
        return request(url, { accept: "application/vnd.github+json", etag: cached?.etag }, async res => {
            if (res.status === 304 && cached) return { release: cached.release, etag: cached.etag, notModified: true };
            if (res.status === 404) throw new UpdateError("no-release", "nenhuma versão publicada ainda", { quiet: true, detail: `${url}: HTTP 404` });
            if (!res.ok) throw httpError(res, url);
            let json;
            try {
                json = JSON.parse((await readBody(res, MAX_SMALL, url)).toString("utf8"));
            } catch (err) {
                if (err instanceof UpdateError) throw err;
                throw new UpdateError("http", "resposta inválida do GitHub; tento de novo mais tarde", { quiet: true, detail: String(err?.message ?? err) });
            }
            return { release: slimRelease(json), etag: res.headers.get("etag") ?? null, notModified: false };
        });
    }

    function candidate(release) {
        if (release.draft || release.prerelease) return null; // releases/latest never returns these; be safe
        const version = plainVersion(release.tag_name);
        if (!version) throw new UpdateError("invalid", `a release ${release.tag_name || "?"} não tem um número de versão`, { quiet: true });
        const asset = pickAsset(release);
        if (!asset) throw new UpdateError("no-asset", `a versão ${version} ainda não tem o pacote do Telinha`, { quiet: true });
        return { version, tag: release.tag_name, asset, release };
    }

    /** Every SHA-256 GitHub publishes for the zip: asset digest, <zip>.sha256, a version.json asset, release notes. */
    async function expectedHashes(c) {
        const hashes = [];
        let manifest = null;
        const digest = String(c.asset.digest ?? "").toLowerCase();
        if (digest.startsWith("sha256:") && normHash(digest)) hashes.push({ sha256: normHash(digest), source: "GitHub (digest do asset)" });
        for (const a of c.release.assets) {
            const isSum = a.name.toLowerCase() === (c.asset.name + ".sha256").toLowerCase();
            const isVersion = a.name.toLowerCase() === MANIFEST;
            if (!isSum && !isVersion) continue;
            const text = (await getAsset(a.browser_download_url, MAX_SMALL, HTTP_TIMEOUT_MS)).toString("utf8");
            if (isSum) {
                const h = hashFromSumFile(text, c.asset.name);
                if (!h) throw new UpdateError("checksum", "o arquivo .sha256 publicado não tem o SHA-256 do pacote", { detail: a.name });
                hashes.push({ sha256: h, source: a.name });
            } else {
                let m = null;
                try {
                    m = validateManifest(JSON.parse(text));
                } catch { }
                if (m) manifest = m;
                else if (hashFromVersionJson(text, c.asset.name)) hashes.push({ sha256: hashFromVersionJson(text, c.asset.name), source: MANIFEST });
            }
        }
        const fromBody = hashFromReleaseBody(c.release.body, c.asset.name);
        if (fromBody) hashes.push({ sha256: fromBody, source: "notas da release" });
        return { hashes, manifest };
    }

    function stagedVersion(s) {
        const m = exists(P.staged) ? peekManifest(P.staged) : null;
        return m && installed && compareSemver(m.version, installed.version) === 1 && !isBad(s, m.version) ? m.version : null;
    }

    /** Download -> verify -> extract into update\staging-* -> verify on disk -> rename to addon.new. */
    async function downloadAndStage(c) {
        rt.phase = "downloading";
        log("update: downloading", { version: c.version, asset: c.asset.name, size: c.asset.size });
        const { hashes, manifest } = await expectedHashes(c);
        if (!hashes.length) throw new UpdateError("checksum", `a versão ${c.version} não publicou SHA-256; nada foi instalado`);
        const zip = await getAsset(c.asset.browser_download_url, MAX_ZIP, DOWNLOAD_TIMEOUT_MS);
        if (c.asset.size && zip.length !== c.asset.size)
            throw new UpdateError("offline", "o download veio incompleto; tento de novo mais tarde", { quiet: true, detail: `${zip.length} of ${c.asset.size} bytes` });
        const sum = sha256(zip);
        for (const h of hashes)
            if (h.sha256 !== sum) throw new UpdateError("checksum", "o download não confere com o SHA-256 publicado; nada foi instalado", { detail: `got ${sum}, ${h.source} says ${h.sha256}` });

        let payload;
        try {
            payload = readPayloadZip(zip);
        } catch (err) {
            throw new UpdateError("invalid", "o pacote baixado está incompleto ou inválido; nada foi instalado", { detail: err.message });
        }
        const m = payload.manifest;
        if (manifest && !sameFiles(manifest, m)) throw new UpdateError("invalid", "o pacote não confere com o version.json publicado; nada foi instalado");
        if (compareSemver(m.version, c.version) !== 0)
            throw new UpdateError("invalid", `o pacote diz versão ${m.version}, mas a release é ${c.version}; nada foi instalado`);
        if (compareSemver(m.version, installed.version) !== 1) throw new UpdateError("invalid", "o pacote não é mais novo que o instalado; nada foi instalado");
        if (isBad(readState(), m.version)) throw new UpdateError("invalid", `a versão ${m.version} já falhou ao iniciar; ignorada`);
        if (payload.ignored.length) log("update: zip entries not listed in version.json ignored", payload.ignored);

        const tmp = path.join(P.updateDir, `staging-${process.pid}-${now()}`);
        try {
            remove(tmp);
            fs.mkdirSync(tmp, { recursive: true });
            for (const [name, data] of [...payload.files, [MANIFEST, payload.manifestBytes]]) {
                const dest = path.join(tmp, name);
                if (path.dirname(dest) !== tmp) throw new PayloadError(`unsafe name ${name}`); // validName already refused it
                fs.writeFileSync(dest, data, { flag: "wx" });
            }
            const onDisk = verifyDir(tmp);
            if (onDisk.commit !== m.commit) throw new PayloadError("staged copy differs");
            remove(P.staged);
            rename(tmp, P.staged);
        } catch (err) {
            tryRemove(tmp);
            throw new UpdateError("disk", "não foi possível guardar a atualização no disco; tento de novo mais tarde", { detail: String(err?.message ?? err) });
        }
        mutateState(s => {
            s.staged = { version: m.version, commit: m.commit ?? null, tag: c.tag, asset: c.asset.name, sha256: sum, at: iso(now()) };
        });
        log("update: staged, applied at the next Discord start", { version: m.version, commit: m.commit, sha256: sum, checkedAgainst: hashes.map(h => h.source) });
    }

    async function runCheck({ autoDownload, manual }) {
        if (!installed) throw new UpdateError("installed", "versão instalada desconhecida");
        if (!manual && rt.rateLimitedUntil > now()) return; // silent: wait for GitHub's reset
        rt.phase = "checking";
        const s = readState();
        const r = await fetchLatest(s);
        mutateState(x => {
            x.lastCheck = r.notModified ? { ...x.lastCheck, at: iso(now()) } : { at: iso(now()), etag: r.etag, release: r.release };
        });
        const c = candidate(r.release);
        rt.checkedAt = now();
        rt.error = null;
        rt.skipped = null;
        if (!c) {
            rt.latest = null;
            rt.phase = "up-to-date";
            return;
        }
        rt.latest = { version: c.version, tag: c.tag };
        if (compareSemver(c.version, installed.version) !== 1) {
            rt.phase = "up-to-date";
            return;
        }
        if (isBad(s, c.version)) {
            rt.phase = "up-to-date";
            rt.skipped = c.version;
            log("update: latest version skipped, it failed to start before", { version: c.version });
            return;
        }
        if (stagedVersion(s) === c.version) {
            rt.phase = "ready";
            return;
        }
        if (!autoDownload) {
            rt.phase = "available";
            log("update: new version available (automatic updates are off)", { version: c.version });
            return;
        }
        await downloadAndStage(c);
        rt.phase = "ready";
    }

    function setError(err) {
        const e = err instanceof UpdateError ? err : new UpdateError("other", "a verificação falhou; tento de novo mais tarde", { detail: String(err?.stack ?? err) });
        rt.phase = "error";
        rt.error = { kind: e.kind, message: e.message, quiet: e.quiet };
        if (e.kind === "rate-limit") rt.rateLimitedUntil = e.until;
        log(`update: check failed (${e.kind}${e.quiet ? ", will retry at the next check" : ""})`, e.detail ?? e.message);
    }

    /** What the settings page and the notices show. */
    function status() {
        let s;
        try {
            s = readState();
        } catch {
            s = { bad: {} };
        }
        const ready = rt.phase === "checking" || rt.phase === "downloading" ? null : stagedVersion(s);
        const w = s.waiting;
        // why this very version did not go in at the last start (a version staged since has not tried yet)
        const waiting = ready && w && typeof w === "object" && w.version === ready && typeof w.reason === "string"
            ? { reason: w.reason, detail: w.detail ?? null, at: w.at ?? null, starts: Number.isSafeInteger(w.starts) && w.starts > 0 ? w.starts : 1 }
            : null;
        return {
            supported: true,
            installed: installed ? { version: installed.version, commit: installed.commit ?? null } : null,
            phase: ready ? "ready" : rt.phase,
            latest: rt.latest,
            ready,
            waiting,
            error: ready ? null : rt.error,
            checkedAt: rt.checkedAt,
            skipped: rt.skipped,
            lastRollback: s.lastRollback ?? null
        };
    }

    /**
     * The last "update" lines of main.log (main.log.1 when main.log has too few), oldest first, for "Copiar diagnóstico".
     * The user's own folder (C:\Users\<name>) shows as ~ and IPv4 addresses (a proxy in an error) as x.x.x.x, like the
     * rest of the diagnostic. [] without a log file.
     */
    function recentLog(max = RECENT_LOG_LINES) {
        const lines = [];
        if (!logFile) return lines;
        for (const file of [logFile, `${logFile}.1`]) {
            if (lines.length >= max) break;
            let text;
            try {
                text = readLimited(file, MAX_SMALL).toString("utf8");
            } catch {
                continue;
            }
            const found = text.split(/\r?\n/).filter(l => /^\S+ \[\d+\] (?:ERROR )?update/.test(l));
            lines.unshift(...found.slice(-(max - lines.length)));
        }
        let userHome = "";
        try {
            userHome = os.homedir();
        } catch { }
        const forms = userHome ? [JSON.stringify(userHome).slice(1, -1), userHome] : [];
        return lines.map(l => {
            let out = l;
            for (const f of forms) out = out.split(f).join("~");
            out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "x.x.x.x");
            return out.length > RECENT_LOG_LINE_MAX ? `${out.slice(0, RECENT_LOG_LINE_MAX)}…` : out;
        });
    }

    /** Looks for a newer release; with autoDownload, also downloads and stages it. Concurrent calls share one run. */
    function check({ autoDownload = false, manual = false } = {}) {
        if (rt.inflight) return rt.inflight;
        rt.inflight = (async () => {
            try {
                await runCheck({ autoDownload: !!autoDownload, manual: !!manual });
            } catch (err) {
                setError(err);
            } finally {
                rt.inflight = null;
            }
            return status();
        })();
        return rt.inflight;
    }

    /** "Atualizar" (automatic updates off): download and stage the newest release now. */
    async function download() {
        if (rt.inflight) await rt.inflight;
        return check({ autoDownload: true, manual: true });
    }

    return { paths: P, installed, startup, rollbackNow, markServed, confirmBoot, status, recentLog, check, download, readState };
}

module.exports = {
    createUpdater,
    // pure helpers, exported for the offline tests
    compareSemver, plainVersion, validName, validateManifest, verifyDir, readPayloadZip, zipEntries, crc32,
    hashFromSumFile, hashFromReleaseBody, hashFromVersionJson, pickAsset, parseTasklist, listProcessNames, isDiscordExe,
    PayloadError, UpdateError
};
