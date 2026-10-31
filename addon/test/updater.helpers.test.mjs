/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of the pure half of addon/loader/updater.js: versions, payload / manifest checks, the read-only zip reader
 * and the published-SHA-256 parsers (the same rules as installer/internal/payload).
 *
 *   node --test addon/test/updater.helpers.test.mjs        (also run by `pnpm test:addon`)
 *
 * The zip reader is the security boundary of automatic updates (a zip comes from the network): every malformation it must
 * refuse is built here byte by byte with the raw zip writer of fake/update-kit.mjs. Nothing touches the network or the real
 * %APPDATA%: trees live under the OS temp dir.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { makeHome, makePayload, payloadZip, rawZip, scratch, upd, writePayload } from "./fake/update-kit.mjs";

const require = createRequire(import.meta.url);
const zlib = require("node:zlib");
const root = scratch("tlu-help-");
after(() => rmSync(root, { recursive: true, force: true }));

const H = "ab".repeat(32);
const H2 = "cd".repeat(32);

describe("compareSemver / plainVersion", () => {
    const c = upd.compareSemver;

    test("major / minor / patch order, with or without a leading v, whitespace trimmed, build metadata ignored", () => {
        assert.equal(c("0.1.1", "0.1.0"), 1);
        assert.equal(c("0.1.0", "0.1.1"), -1);
        assert.equal(c("1.0.0", "0.99.99"), 1);
        assert.equal(c("0.2.0", "0.10.0"), -1);
        assert.equal(c("v1.2.3", "1.2.3"), 0);
        assert.equal(c(" 1.2.3 ", "1.2.3"), 0);
        assert.equal(c("1.2.3+a", "1.2.3+b"), 0);
    });

    test("a pre-release is older than its release; pre-release identifiers follow semver precedence", () => {
        assert.equal(c("1.0.0-rc.1", "1.0.0"), -1);
        assert.equal(c("1.0.0", "1.0.0-rc.1"), 1);
        assert.equal(c("1.0.0-beta.10", "1.0.0-beta.2"), 1);
        assert.equal(c("1.0.0-2", "1.0.0-10"), -1);
        assert.equal(c("1.0.0-1", "1.0.0-alpha"), -1, "numeric identifiers rank below alphanumeric ones");
        assert.equal(c("1.0.0-alpha", "1.0.0-1"), 1);
        assert.equal(c("1.0.0-alpha", "1.0.0-beta"), -1);
        assert.equal(c("1.0.0-beta", "1.0.0-alpha"), 1);
        assert.equal(c("1.0.0-alpha", "1.0.0-alpha.1"), -1, "a shorter set of identifiers ranks lower");
        assert.equal(c("1.0.0-alpha.1", "1.0.0-alpha"), 1);
        assert.equal(c("1.0.0-alpha.1", "1.0.0-alpha.1"), 0);
    });

    test("anything that is not a version compares as null (never trusted, never newer)", () => {
        for (const bad of ["x", "", "1.0", "01.0.0", "1.0.0-", "1.0.0.0", undefined, null, 1, {}]) {
            assert.equal(c(bad, "1.0.0"), null, String(bad));
            assert.equal(c("1.0.0", bad), null, String(bad));
        }
    });

    test("plainVersion: v dropped, build metadata dropped, pre-release kept; null when not a version", () => {
        assert.equal(upd.plainVersion("v0.1.1"), "0.1.1");
        assert.equal(upd.plainVersion("1.2.3-beta.1+build.5"), "1.2.3-beta.1");
        assert.equal(upd.plainVersion("2.0.0+meta"), "2.0.0");
        assert.equal(upd.plainVersion("latest"), null);
        assert.equal(upd.plainVersion(undefined), null);
    });
});

describe("validName (flat, ordinary file names only)", () => {
    test("accepts plain file names", () => {
        for (const ok of ["main.js", "telinha-audio.exe", "a", "UPPER.JS", "name.with.dots.js", "x".repeat(200)]) assert.equal(upd.validName(ok), true, ok);
    });

    test("refuses paths, drives, traversal, devices, trailing dot/space, control characters, too long, non strings", () => {
        const bad = ["../a.js", "..\\a.js", "a/b.js", "a\\b.js", "C:x.js", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "con", "CON.txt", "prn.x", "aux", "NUL.log",
            "com1", "COM9.js", "lpt3.txt", "x.js.", "x.js ", "", ".", "..", "a\u0000b", "a\u001fb", "x".repeat(201), 5, null, undefined, {}];
        for (const n of bad) assert.equal(upd.validName(n), false, JSON.stringify(n));
    });

    test("names that only start like a device name are fine", () => {
        for (const ok of ["console.js", "com10.js", "lpt.js", "auxiliary.js", "nullable.js", "com.js"]) assert.equal(upd.validName(ok), true, ok);
    });
});

describe("validateManifest (version.json)", () => {
    const base = () => makePayload().manifest;
    const bad = (mutate, re) => {
        const m = base();
        mutate(m);
        assert.throws(() => upd.validateManifest(m), err => err instanceof upd.PayloadError && re.test(err.message), re.source);
    };

    test("a good manifest is returned as it is", () => {
        const m = base();
        assert.equal(upd.validateManifest(m), m);
    });

    test("not an object", () => {
        for (const v of [null, undefined, [], "x", 3]) assert.throws(() => upd.validateManifest(v), /version\.json is not an object/);
    });

    test("unsupported payload / stub format", () => {
        bad(m => { m.payloadFormat = 2; }, /unsupported payload \(payloadFormat 2, stubFormat 1\)/);
        bad(m => { m.stubFormat = 0; }, /unsupported payload \(payloadFormat 1, stubFormat 0\)/);
        bad(m => { delete m.payloadFormat; }, /unsupported payload/);
    });

    test("invalid version", () => {
        bad(m => { m.version = "latest"; }, /invalid version "latest"/);
        bad(m => { delete m.version; }, /invalid version undefined/);
    });

    test("files: missing, not an object, empty, over 500", () => {
        bad(m => { delete m.files; }, /no files/);
        bad(m => { m.files = []; }, /no files/);
        bad(m => { m.files = null; }, /no files/);
        bad(m => { m.files = {}; }, /0 files listed/);
        bad(m => {
            m.files = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.js`, { size: 1, sha256: H }]));
        }, /501 files listed/);
    });

    test("duplicate names (case-insensitive) and invalid names, including the manifest itself", () => {
        bad(m => { m.files["MAIN.JS"] = { size: 1, sha256: H }; }, /duplicate file names/);
        bad(m => { m.files["../evil.js"] = { size: 1, sha256: H }; }, /invalid file name "\.\.\/evil\.js"/);
        bad(m => { m.files["version.json"] = { size: 1, sha256: H }; }, /invalid file name "version\.json"/);
        bad(m => { m.files["Version.JSON"] = { size: 1, sha256: H }; }, /invalid file name "Version\.JSON"/);
    });

    test("bad entries: not an object, negative / fractional / unsafe size, bad or short hash", () => {
        bad(m => { m.files["main.js"] = null; }, /bad entry for main\.js/);
        bad(m => { m.files["main.js"] = { size: -1, sha256: H }; }, /bad entry for main\.js/);
        bad(m => { m.files["main.js"] = { size: 1.5, sha256: H }; }, /bad entry for main\.js/);
        bad(m => { m.files["main.js"] = { size: 2 ** 60, sha256: H }; }, /bad entry for main\.js/);
        bad(m => { m.files["main.js"] = { size: "5", sha256: H }; }, /bad entry for main\.js/);
        bad(m => { m.files["main.js"] = { size: 5, sha256: "abc" }; }, /bad entry for main\.js/);
        bad(m => { m.files["main.js"] = { size: 5, sha256: "g".repeat(64) }; }, /bad entry for main\.js/);
        bad(m => { m.files["main.js"] = { size: 5, sha256: 7 }; }, /bad entry for main\.js/);
    });

    test("upper-case hashes are accepted (compared lower-cased later)", () => {
        const m = base();
        m.files["main.js"].sha256 = m.files["main.js"].sha256.toUpperCase();
        assert.doesNotThrow(() => upd.validateManifest(m));
    });

    test("payload larger than 256 MB in total", () => {
        bad(m => {
            m.files["big1.bin"] = { size: 200 << 20, sha256: H };
            m.files["big2.bin"] = { size: 100 << 20, sha256: H };
        }, /payload too large/);
    });

    test("loaderEntry / stubTemplate: missing, or not among the files", () => {
        bad(m => { delete m.loaderEntry; }, /loaderEntry missing/);
        bad(m => { m.loaderEntry = ""; }, /loaderEntry missing/);
        bad(m => { delete m.stubTemplate; }, /stubTemplate missing/);
        bad(m => { m.loaderEntry = "nope.js"; }, /loaderEntry nope\.js is not in files/);
        bad(m => { m.stubTemplate = "nope.js"; }, /stubTemplate nope\.js is not in files/);
    });

    test("the stub requires addon\\main.js and main.js reads addon.json: both must be listed", () => {
        bad(m => {
            m.files["entry.js"] = m.files["main.js"];
            delete m.files["main.js"];
            m.loaderEntry = "entry.js";
        }, /main\.js is missing/);
        bad(m => { delete m.files["addon.json"]; }, /addon\.json is missing/);
    });
});

describe("verifyDir (a payload folder on disk)", () => {
    const fresh = (name, payload = makePayload()) => writePayload(join(root, name), payload);

    test("returns version.json when every file matches size and SHA-256", () => {
        const dir = fresh("ok");
        assert.equal(upd.verifyDir(dir).version, "0.1.0");
    });

    test("version.json missing, too large, not JSON or invalid", () => {
        const none = join(root, "nothing");
        mkdirSync(none, { recursive: true });
        assert.throws(() => upd.verifyDir(none), err => err instanceof upd.PayloadError && /^version\.json: /.test(err.message));
        const big = fresh("big");
        writeFileSync(join(big, "version.json"), Buffer.alloc(5 * 1024 * 1024, 0x20));
        assert.throws(() => upd.verifyDir(big), /version\.json is too large/);
        const junk = fresh("junk");
        writeFileSync(join(junk, "version.json"), "{ not json");
        assert.throws(() => upd.verifyDir(junk), err => err instanceof upd.PayloadError && /^version\.json: /.test(err.message));
        const invalid = fresh("invalid", makePayload({ manifest: { payloadFormat: 9 } }));
        assert.throws(() => upd.verifyDir(invalid), /unsupported payload/);
    });

    test("a listed file missing, with another size, or with other content", () => {
        const missing = fresh("m1");
        rmSync(join(missing, "addon.json"));
        assert.throws(() => upd.verifyDir(missing), /addon\.json is missing/);
        const resized = fresh("m2");
        appendFileSync(join(resized, "main.js"), "more");
        assert.throws(() => upd.verifyDir(resized), /main\.js does not match version\.json/);
        const swapped = fresh("m3");
        writeFileSync(join(swapped, "main.js"), "// loader 9.9.9\n"); // same length as "// loader 0.1.0\n", other bytes
        assert.throws(() => upd.verifyDir(swapped), /main\.js does not match version\.json/);
    });

    test("upper-case hashes in version.json still verify", () => {
        const p = makePayload();
        for (const f of Object.values(p.manifest.files)) f.sha256 = f.sha256.toUpperCase();
        const dir = writePayload(join(root, "upper"), { ...p, manifestBytes: Buffer.from(JSON.stringify(p.manifest)) });
        assert.equal(upd.verifyDir(dir).version, "0.1.0");
    });
});

describe("crc32", () => {
    test("the standard check value, empty input, and a longer buffer", () => {
        assert.equal(upd.crc32(Buffer.from("123456789")), 0xcbf43926);
        assert.equal(upd.crc32(Buffer.alloc(0)), 0);
        const big = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) & 0xff));
        if (typeof zlib.crc32 === "function") assert.equal(upd.crc32(big), zlib.crc32(big) >>> 0, "agrees with Node's own");
    });

    test("without zlib.crc32 (older Node): the table-driven fallback gives the same answers", () => {
        const saved = zlib.crc32;
        const samples = [Buffer.from("123456789"), Buffer.alloc(0), Buffer.from("Telinha"), Buffer.from(Array.from({ length: 777 }, (_, i) => (i * 7) & 0xff))];
        const expected = samples.map(s => upd.crc32(s));
        zlib.crc32 = undefined;
        try {
            assert.deepEqual(samples.map(s => upd.crc32(s)), expected);
            assert.equal(upd.crc32(Buffer.from("123456789")), 0xcbf43926);
        } finally {
            zlib.crc32 = saved;
        }
        assert.equal(zlib.crc32, saved, "zlib is put back as it was");
    });
});

describe("zipEntries (the central directory)", () => {
    const one = () => rawZip([{ name: "a.js", data: "hello" }]);

    test("reads names, flags, method, CRC, sizes and local offsets", () => {
        const [e] = upd.zipEntries(rawZip([{ name: "a.js", data: "hello" }, { name: "b.js", data: "world!", method: 0 }]));
        assert.deepEqual({ name: e.name, flags: e.flags, method: e.method, size: e.size, crc: e.crc, localOffset: e.localOffset }, { name: "a.js", flags: 0, method: 8, size: 5, crc: upd.crc32(Buffer.from("hello")), localOffset: 0 });
        const all = upd.zipEntries(rawZip([{ name: "a.js", data: "hello" }, { name: "b.js", data: "world!", method: 0 }]));
        assert.deepEqual(all.map(x => [x.name, x.method, x.size]), [["a.js", 8, 5], ["b.js", 0, 6]]);
    });

    test("finds the end record behind a zip comment", () => {
        const zip = rawZip([{ name: "a.js", data: "hello" }], { comment: Buffer.from("made by tests ".repeat(100)) });
        assert.equal(upd.zipEntries(zip)[0].name, "a.js");
    });

    test("an empty archive has no entries", () => {
        assert.deepEqual(upd.zipEntries(rawZip([])), []);
    });

    test("not a zip: not a buffer, too short, no end record", () => {
        assert.throws(() => upd.zipEntries("text"), /not a zip file$/);
        assert.throws(() => upd.zipEntries(Buffer.alloc(10)), /not a zip file$/);
        assert.throws(() => upd.zipEntries(Buffer.alloc(100, 0x41)), /no end of central directory/);
    });

    test("multi-disk archives, and zip64 markers, are refused", () => {
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { disk: 1 } })), /multi-disk zip/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { cdDisk: 2 } })), /multi-disk zip/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { onDisk: 2 } })), /multi-disk zip/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { count: 0xffff, onDisk: 0xffff } })), /zip64 is not supported/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { cdOffset: 0xffffffff } })), /zip64 is not supported/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { cdSize: 0xffffffff } })), /zip64 is not supported/);
    });

    test("an absurd entry count, and a central directory that runs past the end record", () => {
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { count: 551, onDisk: 551 } })), /zip has 551 entries/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { cdSize: 100000 } })), /malformed zip \(central directory\)$/);
    });

    test("a damaged central directory entry: bad signature, count larger than what is there, name running past the directory", () => {
        const zip = one();
        const cdAt = zip.length - 22 - (46 + 4);
        const badSig = Buffer.from(zip);
        badSig.writeUInt32LE(0xdeadbeef, cdAt);
        assert.throws(() => upd.zipEntries(badSig), /malformed zip \(central directory entry\)/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { eocd: { count: 2, onDisk: 2 } })), /malformed zip \(central directory entry\)/);
        const longName = Buffer.from(zip);
        longName.writeUInt16LE(500, cdAt + 28);
        assert.throws(() => upd.zipEntries(longName), /malformed zip \(entry name\)/);
        assert.throws(() => upd.zipEntries(rawZip([{ name: "a.js", data: "x" }], { cdTruncate: 3, eocd: { cdSize: 46 + 4 - 3 } })), /malformed zip \(entry name\)/);
    });
});

describe("readPayloadZip (validated entirely in memory)", () => {
    const payload = makePayload({ version: "0.3.0", extra: { "telinha.renderer.js": "// renderer\n".repeat(50) } });

    test("a good zip: manifest, manifest bytes, every listed file; unlisted safe entries reported as ignored", () => {
        const r = upd.readPayloadZip(payloadZip(payload, { extra: [{ name: "README.txt", data: "hi" }] }));
        assert.equal(r.manifest.version, "0.3.0");
        assert.deepEqual(r.manifestBytes, payload.manifestBytes);
        assert.deepEqual([...r.files.keys()].sort(), [...payload.files.keys()].sort());
        assert.deepEqual(r.files.get("main.js"), payload.files.get("main.js"));
        assert.deepEqual(r.ignored, ["README.txt"]);
    });

    test("stored (method 0) entries work too", () => {
        const stored = rawZip([...payload.files].map(([name, data]) => ({ name, data, method: 0 })).concat({ name: "version.json", data: payload.manifestBytes, method: 0 }));
        assert.equal(upd.readPayloadZip(stored).manifest.version, "0.3.0");
    });

    test("Zip Slip and other unsafe names refuse the whole zip", () => {
        for (const name of ["../evil.js", "..\\evil.js", "sub/evil.js", "C:evil.js", "con.txt", "a:b"])
            assert.throws(() => upd.readPayloadZip(payloadZip(payload, { extra: [{ name, data: "pwned" }] })), /unsafe or nested entry in the zip/, name);
    });

    test("the same name twice, differing only in case", () => {
        assert.throws(() => upd.readPayloadZip(payloadZip(payload, { extra: [{ name: "MAIN.JS", data: "x" }] })), /duplicate entry in the zip: MAIN\.JS/);
    });

    test("no version.json; one that is too large, not JSON or invalid", () => {
        assert.throws(() => upd.readPayloadZip(payloadZip(payload, { without: ["version.json"] })), /no version\.json at the zip root/);
        assert.throws(() => upd.readPayloadZip(payloadZip(payload, { without: ["version.json"], extra: [{ name: "version.json", data: "{}", size: 5 * 1024 * 1024 }] })), /version\.json is too large/);
        assert.throws(() => upd.readPayloadZip(payloadZip(payload, { without: ["version.json"], extra: [{ name: "version.json", data: "not json" }] })), /version\.json is not JSON/);
        assert.throws(() => upd.readPayloadZip(payloadZip(payload, { without: ["version.json"], extra: [{ name: "version.json", data: "{}" }] })), /unsupported payload/);
    });

    test("a file listed in version.json but missing from the zip", () => {
        assert.throws(() => upd.readPayloadZip(payloadZip(payload, { without: ["telinha.renderer.js"] })), /telinha\.renderer\.js \(listed in version\.json\) is missing from the zip/);
    });

    test("an entry with another size than version.json says, or other bytes (SHA-256)", () => {
        const swapped = (name, data) => payloadZip(payload, { without: [name], extra: [{ name, data }] });
        assert.throws(() => upd.readPayloadZip(swapped("main.js", "shorter")), /main\.js has 7 bytes, version\.json says 16/);
        assert.throws(() => upd.readPayloadZip(swapped("main.js", "// loader 9.9.9\n")), /main\.js: SHA-256 does not match version\.json/);
    });

    test("entry data checks: local header, encryption, truncation, compression method, bad deflate, size and CRC", () => {
        const withMain = extra => payloadZip(payload, { without: ["main.js"], extra: [{ name: "main.js", data: payload.files.get("main.js"), ...extra }] });
        assert.throws(() => upd.readPayloadZip(withMain({ skipLocal: true })), /malformed zip \(local header of main\.js\)/);
        assert.throws(() => upd.readPayloadZip(withMain({ localOffset: 1 << 20 })), /malformed zip \(local header of main\.js\)/);
        assert.throws(() => upd.readPayloadZip(withMain({ flags: 1 })), /main\.js is encrypted/);
        const stored = withMain({ method: 0 });
        assert.equal(upd.readPayloadZip(stored).files.get("main.js").toString(), "// loader 0.3.0\n");
        assert.throws(() => upd.readPayloadZip(withMain({ method: 12 })), /main\.js: unsupported compression method 12/);
        assert.throws(() => upd.readPayloadZip(withMain({ method: 8, compressed: Buffer.from("this is not deflate data at all!!!!") })), /main\.js: bad compressed data \(Z_DATA_ERROR\)/);
        assert.throws(() => upd.readPayloadZip(withMain({ crc: 123 })), /main\.js: size\/CRC mismatch/);
    });

    test("an entry whose data runs past the end of the file is truncated (a download cut short that kept its directory)", () => {
        const zip = payloadZip(payload, { without: ["version.json"], extra: [{ name: "version.json", data: payload.manifestBytes, cdCompressedSize: 1 << 24 }] });
        assert.throws(() => upd.readPayloadZip(zip), /version\.json is truncated/);
        const cut = payloadZip(payload).subarray(0, 60);
        assert.throws(() => upd.zipEntries(cut), /not a zip file/);
    });

    test("a deflate failure that carries no error code is reported by its message", () => {
        const real = zlib.inflateRawSync;
        zlib.inflateRawSync = () => { throw new Error("odd failure"); };
        try {
            assert.throws(() => upd.readPayloadZip(payloadZip(payload)), /bad compressed data \(odd failure\)/);
        } finally {
            zlib.inflateRawSync = real;
        }
    });

    test("a zip bomb: data inflating beyond the size the directory declares is cut off", () => {
        const bomb = deflateRawSync(Buffer.alloc(100_000, 0x41));
        const zip = payloadZip(payload, { without: ["main.js"], extra: [{ name: "main.js", compressed: bomb, data: "A", size: 16, crc: 0 }] });
        assert.throws(() => upd.readPayloadZip(zip), /main\.js: bad compressed data \(ERR_BUFFER_TOO_LARGE\)/);
    });

    test("an empty listed file (size 0) is fine", () => {
        const p = makePayload({ extra: { "empty.txt": "" } });
        const r = upd.readPayloadZip(payloadZip(p));
        assert.equal(r.files.get("empty.txt").length, 0);
    });
});

describe("hashFromSumFile (sha256sum output)", () => {
    const name = "Telinha-addon-v1.zip";

    test("the line for the asset, in text and binary (*) mode, any case of the file name", () => {
        assert.equal(upd.hashFromSumFile(`${H}  ${name}\n`, name), H);
        assert.equal(upd.hashFromSumFile(`${H} *${name}\n`, name), H);
        assert.equal(upd.hashFromSumFile(`${H.toUpperCase()}  ${name.toUpperCase()}\r\n`, name), H);
    });

    test("picks the right line among several", () => {
        assert.equal(upd.hashFromSumFile(`${H}  other.zip\n${H2}  ${name}\n`, name), H2);
    });

    test("a single hash for another name is accepted (a bare checksum file); several unnamed ones are not", () => {
        assert.equal(upd.hashFromSumFile(`${H}\n`, name), H);
        assert.equal(upd.hashFromSumFile(`${H}  other.zip\n`, name), H);
        assert.equal(upd.hashFromSumFile(`${H}  a.zip\n${H2}  b.zip\n`, name), "");
    });

    test("noise lines are skipped; an sha256: prefix is understood; nothing usable gives ''", () => {
        assert.equal(upd.hashFromSumFile(`# comment\n\nnot a hash  x\nsha256:${H}  ${name}\n`, name), H);
        assert.equal(upd.hashFromSumFile("", name), "");
        assert.equal(upd.hashFromSumFile("not a checksum file", name), "");
        assert.equal(upd.hashFromSumFile(undefined, name), "");
    });
});

describe("hashFromReleaseBody (release notes)", () => {
    const name = "Telinha-addon-v1.zip";

    test("a line naming the asset with a 64-hex string (any shape), CRLF included", () => {
        assert.equal(upd.hashFromReleaseBody(`Notes\r\nSHA-256 (${name}) = ${H}\r\n`, name), H);
        assert.equal(upd.hashFromReleaseBody(`${H.toUpperCase()}  ${name.toUpperCase()}`, name), H);
    });

    test("a line naming the asset without a hash is not enough", () => {
        assert.equal(upd.hashFromReleaseBody(`Download ${name} below`, name), "");
    });

    test("a single line labelled SHA-256 / sha256 (not mentioning a .zip) counts; two do not", () => {
        assert.equal(upd.hashFromReleaseBody(`SHA-256: ${H}`, name), H);
        assert.equal(upd.hashFromReleaseBody(`sha256 ${H}`, name), H);
        assert.equal(upd.hashFromReleaseBody(`SHA-256: ${H}\nSHA256: ${H2}`, name), "");
        assert.equal(upd.hashFromReleaseBody(`SHA-256 of other.zip: ${H}`, name), "");
    });

    test("empty / missing body, labelled line without a hash", () => {
        assert.equal(upd.hashFromReleaseBody("", name), "");
        assert.equal(upd.hashFromReleaseBody(null, name), "");
        assert.equal(upd.hashFromReleaseBody("SHA-256: pending", name), "");
    });
});

describe("hashFromVersionJson (a small JSON naming the zip's SHA-256)", () => {
    const name = "Telinha-addon-v1.zip";
    const f = (obj, asset = name) => upd.hashFromVersionJson(JSON.stringify(obj), asset);

    test("top-level hash keys in every accepted spelling", () => {
        for (const k of ["sha256", "sha-256", "SHA256", "SHA-256", "zipSha256", "digest"]) assert.equal(f({ [k]: H }), H, k);
        assert.equal(f({ sha256: `sha256:${H.toUpperCase()}` }), H);
    });

    test("a hash next to a file name: used when it is this asset, refused when it names another zip", () => {
        for (const k of ["file", "asset", "name", "zip", "filename", "fileName"]) {
            assert.equal(f({ [k]: name, sha256: H }), H, k);
            assert.equal(f({ [k]: `dist\\${name}`, sha256: H }), H, `${k} with a path`);
            assert.equal(f({ [k]: "other.zip", sha256: H }), "", `${k} other zip`);
        }
        assert.equal(f({ name: "notes.txt", sha256: H }), H, "a name that is not a zip is not a conflict");
    });

    test("keyed by the asset name: a hash string, or a nested object", () => {
        assert.equal(f({ [name]: H }), H);
        assert.equal(f({ [name.toUpperCase()]: { sha256: H2 } }), H2);
        assert.equal(f({ [name]: 42 }), "");
        assert.equal(f({ [name]: "not a hash" }), "");
    });

    test("nested under assets / zip / checksums / release, and inside arrays", () => {
        assert.equal(f({ assets: [{ name: "other.zip", sha256: H2 }, { name, sha256: H }] }), H);
        assert.equal(f({ release: { checksums: { [name]: H } } }), H);
        assert.equal(f([{ zip: { digest: H } }]), H);
        assert.equal(f({ checksums: [] }), "");
    });

    test("not JSON, not an object, or nothing usable", () => {
        assert.equal(upd.hashFromVersionJson("{ nope", name), "");
        assert.equal(upd.hashFromVersionJson("null", name), "");
        assert.equal(upd.hashFromVersionJson("42", name), "");
        assert.equal(f({ sha256: "short" }), "");
        assert.equal(f({}), "");
    });
});

describe("pickAsset / error classes", () => {
    test("the add-on zip by the installer's pattern; the greatest name wins", () => {
        const names = ["TelinhaInstaller.exe", "Telinha-addon-abc.zip.sha256", "Telinha-addon-abc.zip", "Telinha-addon-abd.zip", "telinha-addon-zzz.zip", "Telinha-addon-.zip"];
        assert.equal(upd.pickAsset({ assets: names.map(name => ({ name })) }).name, "Telinha-addon-abd.zip");
    });

    test("no assets, a release without a list, null, entries without a string name", () => {
        assert.equal(upd.pickAsset({ assets: [] }), null);
        assert.equal(upd.pickAsset({}), null);
        assert.equal(upd.pickAsset(null), null);
        assert.equal(upd.pickAsset({ assets: [null, {}, { name: 5 }] }), null);
    });

    test("UpdateError carries kind, quiet, detail, until; PayloadError is a plain Error subclass", () => {
        const e = new upd.UpdateError("http", "message");
        assert.deepEqual([e.kind, e.message, e.quiet, e.detail, e.until, e instanceof Error], ["http", "message", false, null, 0, true]);
        const q = new upd.UpdateError("rate-limit", "wait", { quiet: true, detail: "d", until: 5 });
        assert.deepEqual([q.quiet, q.detail, q.until], [true, "d", 5]);
        assert.ok(new upd.PayloadError("x") instanceof Error);
    });
});

describe("a payload is accepted by createUpdater only when it verifies (home sanity)", () => {
    test("installed version read from addon\\version.json even when it does not verify (peek is cheap, verify is strict)", () => {
        const home = makeHome({ installed: makePayload({ version: "0.4.2", commit: "deadbeef" }), root });
        const u = upd.createUpdater({ addonDir: home.addonDir, log() { } });
        assert.deepEqual([u.installed.version, u.installed.commit], ["0.4.2", "deadbeef"]);
    });
});

describe("which programs are running (run markers of other Discords)", () => {
    test("isDiscordExe: the main executable of every Discord flavor, any letter case; nothing else", () => {
        for (const n of ["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe", "DiscordDevelopment.exe", "DISCORD.EXE", "discordptb.exe"])
            assert.equal(upd.isDiscordExe(n), true, n);
        for (const n of ["Update.exe", "svchost.exe", "node.exe", "DiscordSystemHelper.exe", "telinha-audio.exe", "Discord", "", null, undefined, 5])
            assert.equal(upd.isDiscordExe(n), false, String(n));
    });

    test("parseTasklist: tasklist /FO CSV /NH rows -> pid -> image name (CRLF, the localised memory column, odd lines skipped)", () => {
        const text = '\r\n"System Idle Process","0","Services","0","8 K"\r\n"Discord.exe","4242","Console","1","123.456 K"\r\n' +
            '"svchost.exe","1000","Services","0","1.234 K"\r\nnot a row\r\n"Nome da imagem","PID","Nome da sessão"\r\n';
        assert.deepEqual([...upd.parseTasklist(text)], [[0, "System Idle Process"], [4242, "Discord.exe"], [1000, "svchost.exe"]]);
    });

    test("parseTasklist: no process row at all (an INFO line in any language, nothing, not text) throws: the list is unreadable", () => {
        for (const text of ["INFO: No tasks are running which match the specified criteria.\r\n", "INFORMAÇÕES: Não há tarefas em execução.", "", null, undefined])
            assert.throws(() => upd.parseTasklist(text), /tasklist listed no process/, String(text));
    });

    test("listProcessNames: Windows' own tasklist.exe (System32), CSV without header, hidden window, 3 s at most", () => {
        const calls = [];
        const spawnSync = (file, args, opts) => {
            calls.push({ file, args, opts });
            return { status: 0, stdout: '"DiscordPTB.exe","77","Console","1","1 K"\r\n' };
        };
        const names = upd.listProcessNames({ platform: "win32", spawnSync, env: { SystemRoot: "D:\\Win" } });
        assert.deepEqual([...names], [[77, "DiscordPTB.exe"]]);
        assert.equal(calls[0].file, "D:\\Win\\System32\\tasklist.exe");
        assert.deepEqual(calls[0].args, ["/FO", "CSV", "/NH"]);
        assert.equal(calls[0].opts.windowsHide, true);
        assert.equal(calls[0].opts.timeout, 3000);
        assert.equal(calls[0].opts.encoding, "utf8");
        upd.listProcessNames({ platform: "win32", spawnSync, env: { windir: "E:\\W" } });
        upd.listProcessNames({ platform: "win32", spawnSync, env: {} });
        assert.deepEqual(calls.slice(1).map(c => c.file), ["E:\\W\\System32\\tasklist.exe", "C:\\Windows\\System32\\tasklist.exe"]);
    });

    test("listProcessNames throws when the list cannot be read: not Windows, tasklist missing or too slow, a failed exit", () => {
        assert.throws(() => upd.listProcessNames({ platform: "linux", spawnSync: () => assert.fail("not spawned") }), /no process list on linux/);
        const timedOut = Object.assign(new Error("spawnSync tasklist.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
        assert.throws(() => upd.listProcessNames({ platform: "win32", spawnSync: () => ({ error: timedOut, status: null }), env: {} }), /ETIMEDOUT/);
        assert.throws(() => upd.listProcessNames({ platform: "win32", spawnSync: () => ({ status: 1, stdout: "" }), env: {} }), /tasklist exited with 1/);
        assert.throws(() => upd.listProcessNames({ platform: "win32", spawnSync: () => ({ status: null, signal: "SIGTERM", stdout: "" }), env: {} }), /tasklist exited with SIGTERM/);
        assert.throws(() => upd.listProcessNames({ platform: "win32", spawnSync: () => ({ status: 0, stdout: "INFO: nothing" }), env: {} }), /listed no process/);
    });

    test("listProcessNames for real (Windows only): this very test process is in the list, as node.exe", t => {
        if (process.platform !== "win32") return t.skip("tasklist is Windows only");
        const names = upd.listProcessNames();
        assert.match(names.get(process.pid) ?? "", /^node(?:\.exe)?$/i);
        assert.equal(upd.isDiscordExe(names.get(process.pid)), false);
    });
});
