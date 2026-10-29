/*
 * PeerLive addon prototype - minimal asar writer/reader for the resources/app.asar stub.
 *
 * The writer is a byte-for-byte port of WriteAppAsar() from the official Vencord installer
 * (github.com/Vencord/Installer, app_asar.go): two files, index.js + package.json, header JSON padded
 * with "0" characters to a 4-byte boundary, four little-endian int32 size fields. Keeping the exact same
 * layout means a stub we regenerate for Vencord (on PeerLive uninstall) is identical to the one the
 * Vencord installer would have written.
 */
"use strict";

const fs = require("fs");

const PACKAGE_JSON = '{\n\t"name": "discord",\n\t"main": "index.js"\n}';

/** Builds the bytes of a two-file asar ({index.js, package.json}) exactly like Vencord's installer. */
function buildStubAsar(indexJs) {
    const indexBytes = Buffer.byteLength(indexJs, "utf8");
    const pkgBytes = Buffer.byteLength(PACKAGE_JSON, "utf8");

    // Go's json.Marshal on map[string]... sorts keys; struct fields keep declaration order (size, offset)
    let header = JSON.stringify({
        files: {
            "index.js": { size: indexBytes, offset: "0" },
            "package.json": { size: pkgBytes, offset: String(indexBytes) }
        }
    });

    const headerStringSize = Buffer.byteLength(header, "utf8");
    const dataSize = 4;
    const alignedSize = (headerStringSize + dataSize - 1) & ~(dataSize - 1);
    const headerSize = alignedSize + 8;
    const headerObjectSize = alignedSize + dataSize;
    header += "0".repeat(alignedSize - headerStringSize);

    const sizes = Buffer.alloc(16);
    [dataSize, headerSize, headerObjectSize, headerStringSize].forEach((n, i) => sizes.writeInt32LE(n, i * 4));

    return Buffer.concat([sizes, Buffer.from(header, "utf8"), Buffer.from(indexJs, "utf8"), Buffer.from(PACKAGE_JSON, "utf8")]);
}

function writeStubAsar(outFile, indexJs) {
    fs.writeFileSync(outFile, buildStubAsar(indexJs));
}

/** Returns the contents of one top-level file of an asar archive, or null. Only what we need for stubs. */
function readAsarFile(asarPath, fileName) {
    // original-fs inside Electron would be needed to read an .asar as a plain file; this runs in the installer (Node)
    const buf = fs.readFileSync(asarPath);
    if (buf.length < 16) return null;
    const headerSize = buf.readUInt32LE(4);
    const headerStringSize = buf.readUInt32LE(12);
    let header;
    try {
        header = JSON.parse(buf.subarray(16, 16 + headerStringSize).toString("utf8"));
    } catch {
        return null;
    }
    const entry = header?.files?.[fileName];
    if (!entry || entry.files || entry.unpacked) return null;
    const base = 8 + headerSize;
    const start = base + Number(entry.offset);
    return buf.subarray(start, start + entry.size).toString("utf8");
}

/** Vencord's stub index.js is exactly `require("<json-escaped patcher path>")`. Returns that path or null. */
function parseVencordStub(indexJs) {
    const m = /^require\(("(?:[^"\\]|\\.)*")\)$/.exec(indexJs?.trim() ?? "");
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

module.exports = { PACKAGE_JSON, buildStubAsar, writeStubAsar, readAsarFile, parseVencordStub };
