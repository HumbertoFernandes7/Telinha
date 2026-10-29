// SPDX-License-Identifier: GPL-3.0-or-later

// Package testutil builds fake Discord / Vencord / payload trees for the tests. Only tests import it.
package testutil

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
)

// TestdataDir is installer/internal/testdata.
func TestdataDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "testdata")
}

// StubTemplate is the stub-template.js fixture (a copy of addon/loader/stub-template.js).
func StubTemplate(t testing.TB) string {
	b, err := os.ReadFile(filepath.Join(TestdataDir(), "stub-template.js"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Write creates a file (and its folders).
func Write(t testing.TB, p string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// Read reads a file or fails.
func Read(t testing.TB, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Vencord creates <appdata>\Vencord\dist\patcher.js (+ a settings file) and returns the patcher path.
func Vencord(t testing.TB, appdata string) string {
	p := filepath.Join(appdata, "Vencord", "dist", "patcher.js")
	Write(t, p, []byte("// Vencord 443688b\n"))
	Write(t, filepath.Join(appdata, "Vencord", "dist", "renderer.js"), []byte("var Vencord={}"))
	Write(t, filepath.Join(appdata, "Vencord", "settings", "settings.json"), []byte(`{"plugins":{}}`))
	return p
}

// DiscordWithVencord creates <root>\<app>\resources with Vencord's stub (pointing at patcher) and _app.asar.
func DiscordWithVencord(t testing.TB, root, app, patcher string) string {
	res := filepath.Join(root, app, "resources")
	Write(t, filepath.Join(res, "_app.asar"), []byte("discord original"))
	Write(t, filepath.Join(res, "app.asar"), asar.VencordStub(patcher))
	Write(t, filepath.Join(root, app, filepath.Base(root)+".exe"), []byte("MZ"))
	return res
}

// DiscordVanilla creates <root>\<app>\resources with a big original app.asar and no _app.asar.
func DiscordVanilla(t testing.TB, root, app string) string {
	res := filepath.Join(root, app, "resources")
	Write(t, filepath.Join(res, "app.asar"), make([]byte, 70<<10))
	return res
}

// Payload builds a payload folder: the given files plus stub-template.js and a computed version.json.
func Payload(t testing.TB, dir, version string, files map[string]string) map[string]any {
	t.Helper()
	all := map[string]string{
		"main.js":          "module.exports = { boot() {} }; // " + version,
		"addon.json":       `{"format":1,"pluginName":"Telinha"}`,
		"stub-template.js": StubTemplate(t),
	}
	for k, v := range files {
		all[k] = v
	}
	entries := map[string]any{}
	for name, content := range all {
		Write(t, filepath.Join(dir, name), []byte(content))
		sum := sha256.Sum256([]byte(content))
		entries[name] = map[string]any{"size": len(content), "sha256": hex.EncodeToString(sum[:])}
	}
	manifest := map[string]any{
		"name": "Telinha", "payloadFormat": 1, "version": version, "commit": "abcdef12",
		"vencordBaseCommit": "443688b5", "vencordVersion": "1.15.13", "builtAt": "2026-10-29T12:00:00.000Z",
		"pluginName": "Telinha", "loaderEntry": "main.js", "stubTemplate": "stub-template.js", "stubFormat": 1,
		"files": entries,
	}
	b, _ := json.MarshalIndent(manifest, "", "    ")
	Write(t, filepath.Join(dir, "version.json"), b)
	return manifest
}

// Zip zips the regular files of dir, flat, into zipPath (plus extra raw entries name->content).
func Zip(t testing.TB, dir, zipPath string, extra map[string]string) {
	t.Helper()
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		if e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		w.Write(Read(t, filepath.Join(dir, n)))
	}
	for n, c := range extra {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(c))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

// SHA256 of a file.
func SHA256(t testing.TB, p string) string {
	sum := sha256.Sum256(Read(t, p))
	return hex.EncodeToString(sum[:])
}

// TreeHash hashes every file under dir (path + content), to prove a folder was not touched.
func TreeHash(t testing.TB, dir string) string {
	h := sha256.New()
	_ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		h.Write([]byte(rel + "\x00"))
		if fi.Mode().IsRegular() {
			h.Write(Read(t, p))
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))
}

// TempDir returns a short folder under %TEMP%\tli-test (short paths keep Windows happy), removed at the end.
func TempDir(t testing.TB) string {
	t.Helper()
	base := filepath.Join(os.TempDir(), "tli-test")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	d, err := os.MkdirTemp(base, "t")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}
