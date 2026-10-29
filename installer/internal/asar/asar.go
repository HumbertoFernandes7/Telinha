// SPDX-License-Identifier: GPL-3.0-or-later
//
// Telinha installer: minimal asar writer/reader for the resources\app.asar stub.
//
// BuildStub is a port of WriteAppAsar() from the official Vencord installer
// (https://github.com/Vencord/Installer, app_asar.go, GPL-3.0,
// Copyright (c) 2023 Vendicated and Vencord contributors), which in turn was ported from
// https://github.com/GeopJr/asar-cr (pack.cr). It produces the same bytes: two files (index.js +
// package.json), a JSON header padded with '0' characters to a 4-byte boundary and four
// little-endian int32 size fields. Because it is the same code path (Go's encoding/json included),
// a Vencord stub we regenerate on uninstall is byte-identical to what Vencord's installer writes.

package asar

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// PackageJSON is the package.json Vencord's installer puts in its stub (tabs and all).
const PackageJSON = "{\n\t\"name\": \"discord\",\n\t\"main\": \"index.js\"\n}"

type entry struct {
	Size   int32  `json:"size"`
	Offset string `json:"offset"`
}

// BuildStub returns the bytes of a two-file asar {index.js, package.json}.
func BuildStub(indexJS string) []byte {
	files := map[string]entry{
		"index.js":     {Size: int32(len(indexJS)), Offset: "0"},
		"package.json": {Size: int32(len(PackageJSON)), Offset: strconv.Itoa(len(indexJS))},
	}
	headerBytes, _ := json.Marshal(map[string]map[string]entry{"files": files})
	header := string(headerBytes)

	headerStringSize := uint32(len(header))
	const dataSize = uint32(4)
	alignedSize := (headerStringSize + dataSize - 1) &^ (dataSize - 1)
	headerSize := alignedSize + 8
	headerObjectSize := alignedSize + dataSize
	header += strings.Repeat("0", int(alignedSize-headerStringSize))

	out := make([]byte, 0, 16+len(header)+len(indexJS)+len(PackageJSON))
	for _, n := range []uint32{dataSize, headerSize, headerObjectSize, headerStringSize} {
		out = binary.LittleEndian.AppendUint32(out, n)
	}
	out = append(out, header...)
	out = append(out, indexJS...)
	out = append(out, PackageJSON...)
	return out
}

// VencordStub returns exactly what Vencord's installer writes for the given patcher.js path:
// index.js = `require(<json.Marshal(path)>)`.
func VencordStub(patcherPath string) []byte {
	return BuildStub(VencordIndexJS(patcherPath))
}

// VencordIndexJS is the index.js of Vencord's stub.
func VencordIndexJS(patcherPath string) string {
	b, _ := json.Marshal(patcherPath)
	return "require(" + string(b) + ")"
}

var vencordStubRe = regexp.MustCompile(`^require\(("(?:[^"\\]|\\.)*")\)$`)

// ParseVencordIndexJS returns the patcher path of a Vencord-style stub index.js, or "" if it is not one.
func ParseVencordIndexJS(indexJS string) string {
	m := vencordStubRe.FindStringSubmatch(strings.TrimSpace(indexJS))
	if m == nil {
		return ""
	}
	var p string
	if err := json.Unmarshal([]byte(m[1]), &p); err != nil {
		return ""
	}
	return p
}

// ErrNotFound is returned by ReadFile when the archive has no such top-level file.
var ErrNotFound = errors.New("asar: file not found")

// ReadFile returns one top-level, packed file of an asar archive. It is only meant for small stubs.
func ReadFile(archive []byte, name string) ([]byte, error) {
	if len(archive) < 16 {
		return nil, errors.New("asar: too short")
	}
	headerSize := binary.LittleEndian.Uint32(archive[4:8])
	headerStringSize := binary.LittleEndian.Uint32(archive[12:16])
	if uint64(16)+uint64(headerStringSize) > uint64(len(archive)) || uint64(8)+uint64(headerSize) > uint64(len(archive)) {
		return nil, errors.New("asar: header out of range")
	}
	var header struct {
		Files map[string]struct {
			Size     *int64          `json:"size"`
			Offset   string          `json:"offset"`
			Unpacked bool            `json:"unpacked"`
			Files    json.RawMessage `json:"files"`
		} `json:"files"`
	}
	if err := json.Unmarshal(archive[16:16+headerStringSize], &header); err != nil {
		return nil, errors.New("asar: bad header: " + err.Error())
	}
	e, ok := header.Files[name]
	if !ok || e.Files != nil || e.Unpacked || e.Size == nil {
		return nil, ErrNotFound
	}
	off, err := strconv.ParseInt(e.Offset, 10, 64)
	if err != nil || off < 0 || *e.Size < 0 {
		return nil, errors.New("asar: bad entry")
	}
	start := int64(8) + int64(headerSize) + off
	end := start + *e.Size
	if end > int64(len(archive)) {
		return nil, errors.New("asar: entry out of range")
	}
	return archive[start:end], nil
}
