/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Fixtures shared by the updater / loader unit tests (addon/test/updater.*.test.mjs, main.*.test.mjs). Not a test file
 * itself (run-all.mjs only picks `run-*-test.mjs` and `*.test.mjs`).
 *
 *   - small payloads (the files version.json lists, correctly hashed) written to disk or zipped
 *   - a raw zip writer that can produce every malformation the updater's reader must refuse
 *   - a fake `fetch` (offline: nothing here opens a socket) and a fake GitHub release API on top of it
 *   - fake %APPDATA%\Telinha trees under the OS temp dir (never the real one)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";

const require = createRequire(import.meta.url);
export const upd = require("../../loader/updater.js");

export const REPO = "HumbertoFernandes7/Telinha";
export const API = "https://api.github.com";
export const DOWNLOAD = `https://github.com/${REPO}/releases/download`;

export const sha256 = buf => createHash("sha256").update(buf).digest("hex");

/** Short on purpose (Windows MAX_PATH): <tmp>/tlu-XXXXXX. Removed by the caller (or the OS). */
export function scratch(prefix = "tlu-") {
    return mkdtempSync(join(tmpdir(), prefix));
}

// ------------------------------------------------------------------------------------------- payloads

/**
 * A payload as build-addon.mjs produces it, reduced to what the loader checks: main.js + addon.json (required),
 * stub-template.js, version.json listing every file with size and SHA-256.
 *   extra:   more files (name -> text/Buffer)       replace: change a default file's content
 *   manifest: fields merged into version.json AFTER it is computed (to make it lie)
 */
export function makePayload({ version = "0.1.0", commit = "c0ffee01", extra = {}, replace = {}, manifest: patch = {}, drop = [] } = {}) {
    const defaults = {
        "main.js": `// loader ${version}\n`,
        "addon.json": JSON.stringify({ pluginName: "Telinha", renderer: "telinha.renderer.js", main: "telinha.main.js" }),
        "stub-template.js": "// Telinha stub v1\nconst TELINHA_LOADER = __TELINHA_LOADER__;\nconst VENCORD_PATCHER = __VENCORD_PATCHER__;\n"
    };
    const files = new Map(Object.entries({ ...defaults, ...replace, ...extra }).map(([n, c]) => [n, Buffer.from(c)]));
    for (const n of drop) files.delete(n);
    const manifest = {
        payloadFormat: 1, stubFormat: 1, version, commit, loaderEntry: "main.js", stubTemplate: "stub-template.js",
        files: Object.fromEntries([...files].map(([n, b]) => [n, { size: b.length, sha256: sha256(b) }])),
        ...patch
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 4) + "\n");
    return { version, commit, files, manifest, manifestBytes };
}

/** Writes a payload folder (the files + version.json). Returns `dir`. */
export function writePayload(dir, payload) {
    mkdirSync(dir, { recursive: true });
    for (const [n, b] of payload.files) writeFileSync(join(dir, n), b);
    writeFileSync(join(dir, "version.json"), payload.manifestBytes);
    return dir;
}

/** The zip of a payload (version.json included), as a release asset. `entries` adds/overrides raw entries. */
export function payloadZip(payload, { extra = [], without = [], ...opts } = {}) {
    const entries = [...payload.files].filter(([n]) => !without.includes(n)).map(([name, data]) => ({ name, data }));
    if (!without.includes("version.json")) entries.push({ name: "version.json", data: payload.manifestBytes });
    return rawZip([...entries, ...extra], opts);
}

// ------------------------------------------------------------------------------------------- raw zip writer

/**
 * A zip writer with knobs for every field the reader (updater.js zipEntries/zipEntryData) checks.
 * entry: { name, data, method = 8, flags = 0, crc, size, compressed, localOffset, skipLocal, cdCompressedSize }
 * opts:  { eocd: { disk, cdDisk, onDisk, count, cdSize, cdOffset, sig }, cdTruncate, comment }
 */
export function rawZip(entries, { eocd = {}, cdTruncate = 0, comment = Buffer.alloc(0) } = {}) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name);
        const data = Buffer.from(e.data ?? "");
        const method = e.method ?? 8;
        const compressed = e.compressed ?? (method === 8 ? deflateRawSync(data) : data);
        const crc = e.crc ?? upd.crc32(data);
        const size = e.size ?? data.length;
        const flags = e.flags ?? 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc >>> 0, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        const at = offset;
        if (!e.skipLocal) {
            parts.push(local, name, compressed);
            offset += 30 + name.length + compressed.length;
        }
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(flags, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(crc >>> 0, 16);
        cd.writeUInt32LE(e.cdCompressedSize ?? compressed.length, 20);
        cd.writeUInt32LE(size, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(e.localOffset ?? at, 42);
        central.push(cd, name);
    }
    const cdBytes = Buffer.concat(central);
    const cdOffset = offset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(eocd.sig ?? 0x06054b50, 0);
    end.writeUInt16LE(eocd.disk ?? 0, 4);
    end.writeUInt16LE(eocd.cdDisk ?? 0, 6);
    end.writeUInt16LE(eocd.onDisk ?? entries.length, 8);
    end.writeUInt16LE(eocd.count ?? entries.length, 10);
    end.writeUInt32LE(eocd.cdSize ?? cdBytes.length, 12);
    end.writeUInt32LE(eocd.cdOffset ?? cdOffset, 16);
    end.writeUInt16LE(comment.length, 20);
    return Buffer.concat([...parts, cdBytes.subarray(0, cdBytes.length - cdTruncate), end, comment]);
}

// ------------------------------------------------------------------------------------------- fake fetch

/**
 * A fetch Response look-alike (status, ok, headers.get, body.getReader, arrayBuffer).
 * opts: { headers, chunk (bytes per read), noStream (no body.getReader: arrayBuffer only), failRead (throw on the Nth read),
 *         cancelFails, lengthHeader }
 */
export function reply(status, body = "", { headers = {}, chunk = 0, noStream = false, failRead = 0, cancelFails = false } = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const res = {
        status, ok: status >= 200 && status < 300, headers: { get: k => h[k.toLowerCase()] ?? null },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
    };
    if (!noStream) {
        res.body = {
            getReader() {
                let pos = 0;
                let reads = 0;
                return {
                    read: async () => {
                        reads++;
                        if (failRead && reads >= failRead) throw new Error("connection reset");
                        if (pos >= buf.length) return { done: true, value: undefined };
                        const end = chunk ? Math.min(buf.length, pos + chunk) : buf.length;
                        const value = new Uint8Array(buf.subarray(pos, end));
                        pos = end;
                        return { done: false, value };
                    },
                    cancel: async () => {
                        if (cancelFails) throw new Error("cancel failed");
                    }
                };
            }
        };
    }
    return res;
}

/** fetch(url, init) -> whatever `handler(url, init, n)` returns (a reply(), or an Error to throw). Records every call. */
export function fakeFetch(handler) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        const out = await handler(String(url), init, calls.length);
        if (out instanceof Error) throw out;
        return out;
    };
    fetch.calls = calls;
    fetch.count = re => calls.filter(c => re.test(c.url)).length;
    return fetch;
}

/**
 * A fake GitHub: releases/latest (with ETag / If-None-Match) and the asset downloads, all in memory.
 *   gh.publish(tag, zip, { name, digest, sumFile, body, prerelease, versionJson, assets })
 *   gh.mode = "ok" | "rate-limit" | "500" | "offline" | "no-release"
 */
export function fakeGitHub(base = API) {
    const gh = { release: null, files: new Map(), mode: "ok", etagOf: body => `"${sha256(body).slice(0, 12)}"`, hooks: {} };
    gh.fetch = fakeFetch(async (url, init) => {
        const inm = init?.headers?.["If-None-Match"] ?? null;
        if (gh.hooks.before) {
            const r = await gh.hooks.before(url, init);
            if (r !== undefined) return r;
        }
        if (gh.mode === "offline") return new TypeError("fetch failed");
        if (gh.mode === "rate-limit") return reply(403, "{}", { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } });
        if (gh.mode === "500") return reply(500, "boom");
        if (url === `${base}/repos/${REPO}/releases/latest`) {
            if (gh.mode === "no-release" || !gh.release) return reply(404, "{}");
            const body = JSON.stringify(gh.release);
            const etag = gh.etagOf(body);
            if (inm === etag) return reply(304, "", { headers: { etag } });
            return reply(200, body, { headers: { etag } });
        }
        const m = /\/releases\/download\/[^/]+\/(.+)$/.exec(url);
        if (m && gh.files.has(decodeURIComponent(m[1]))) {
            const b = gh.files.get(decodeURIComponent(m[1]));
            return reply(200, b, { headers: { "content-length": b.length } });
        }
        return reply(404, "");
    });
    /** Publishes a release like the real ones: the zip, <zip>.sha256, GitHub's asset digest. */
    gh.publish = (tag, zip, { name = `Telinha-addon-${tag.replace(/\W/g, "")}.zip`, digest = sha256(zip), sumFile = `${sha256(zip)}  ${name}\n`, body = "", prerelease = false, draft = false, versionJson = null, assets = null, size = zip.length } = {}) => {
        gh.files.clear();
        gh.files.set(name, zip);
        const url = n => `${DOWNLOAD}/${tag}/${n}`;
        const list = [
            { name: "TelinhaInstaller.exe", size: 3, digest: "sha256:" + sha256("exe"), browser_download_url: url("TelinhaInstaller.exe") },
            { name, size, digest: digest ? "sha256:" + digest : null, browser_download_url: url(name) }
        ];
        if (sumFile !== null) {
            gh.files.set(name + ".sha256", Buffer.from(sumFile));
            list.push({ name: name + ".sha256", size: sumFile.length, digest: null, browser_download_url: url(name + ".sha256") });
        }
        if (versionJson !== null) {
            gh.files.set("version.json", Buffer.from(versionJson));
            list.push({ name: "version.json", size: versionJson.length, digest: null, browser_download_url: url("version.json") });
        }
        gh.release = { tag_name: tag, name: tag, draft, prerelease, body, assets: assets ?? list };
        gh.fetch.calls.length = 0;
    };
    return gh;
}

// ------------------------------------------------------------------------------------------- fake %APPDATA%\Telinha

/**
 * <root>/Telinha with addon/ (installed), optionally addon.new/ (staged), addon.prev/, install.json and update/state.json.
 * Returns the paths plus readers. `root` is a fresh temp dir unless given.
 */
export function makeHome({ installed = makePayload(), staged = null, prev = null, record = true, state = null, root = scratch() } = {}) {
    const home = join(root, "Telinha");
    const t = {
        root, home, addonDir: join(home, "addon"), staged: join(home, "addon.new"), prev: join(home, "addon.prev"), old: join(home, "addon.old"),
        updateDir: join(home, "update"), stateFile: join(home, "update", "state.json"), runDir: join(home, "update", "run"), lock: join(home, "update", "swap.lock"),
        recordFile: join(home, "install.json")
    };
    mkdirSync(home, { recursive: true });
    if (installed) writePayload(t.addonDir, installed);
    if (staged) writePayload(t.staged, staged);
    if (prev) writePayload(t.prev, prev);
    if (record && installed) {
        writeFileSync(t.recordFile, JSON.stringify({
            installedAt: "2026-10-29T12:00:00Z", version: installed.version, commit: installed.commit,
            targets: [{ flavor: "Discord", app: "app-1.0.9002", resources: "R", vencordPatcher: "P", previous: "vencord-stub", backup: null }],
            installerVersion: "0.1.0", source: { kind: "github", release: `v${installed.version}`, asset: "a.zip", sha256: "a".repeat(64) }
        }, null, 2) + "\n");
    }
    if (state) {
        mkdirSync(t.updateDir, { recursive: true });
        writeFileSync(t.stateFile, typeof state === "string" ? state : JSON.stringify(state));
    }
    t.state = () => (existsSync(t.stateFile) ? JSON.parse(readFileSync(t.stateFile, "utf8")) : null);
    t.record = () => (existsSync(t.recordFile) ? JSON.parse(readFileSync(t.recordFile, "utf8")) : null);
    t.versionOf = dir => (existsSync(join(dir, "version.json")) ? JSON.parse(readFileSync(join(dir, "version.json"), "utf8")).version : null);
    t.names = dir => (existsSync(dir) ? readdirSync(dir).sort() : []);
    t.cleanup = () => rmSync(root, { recursive: true, force: true });
    return t;
}

/** No list of running programs (the updater then counts a live run marker as another Discord, as it always did). */
export const noProcessList = () => {
    throw new Error("no process list in the unit tests");
};

/** A list of running programs: { pid: "Discord.exe", ... } -> the Map the updater gets from tasklist. */
export const processList = names => () => new Map(Object.entries(names).map(([pid, exe]) => [Number(pid), exe]));

/**
 * An updater over a home, with its log lines collected (`u.lines`), no network and no list of running programs unless
 * given (processNames: processList({...}), or upd.listProcessNames for the real tasklist).
 */
export function updaterFor(home, { fetch = fakeFetch(() => new TypeError("offline")), log, processNames = noProcessList, ...rest } = {}) {
    const lines = [];
    const u = upd.createUpdater({
        addonDir: home.addonDir, fetch, log: log ?? ((m, d) => lines.push(d === undefined ? String(m) : `${m} ${JSON.stringify(d)}`)), processNames, ...rest
    });
    u.lines = lines;
    u.fetch = fetch;
    return u;
}

/** Error with a Node-style `code`. */
export const fsError = (code, message = code) => Object.assign(new Error(message), { code });

/** process.kill(pid, 0) as the updater probes other Discords: `alive` pids answer, `eperm` pids are not ours to signal, the rest do not exist. */
export function fakeKill(t, { alive = [], eperm = [] } = {}) {
    const real = process.kill;
    return t.mock.method(process, "kill", (pid, sig) => {
        if (alive.includes(pid)) return true;
        if (eperm.includes(pid)) throw fsError("EPERM");
        if (pid === process.pid) return real.call(process, pid, sig);
        throw fsError("ESRCH");
    });
}

/**
 * Wraps one `fs` method with a hook (restored when the test ends). `hook(original, ...args)` decides: return a value to
 * replace the call, throw to fail it, or call `original(...args)` to let it through.
 */
export function wrapFs(t, fs, name, hook) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => hook((...a) => original.apply(fs, a), ...args));
}
