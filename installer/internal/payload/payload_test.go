// SPDX-License-Identifier: GPL-3.0-or-later

package payload

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

func TestStageZipAndDir(t *testing.T) {
	dir := testutil.TempDir(t)
	src := filepath.Join(dir, "src")
	testutil.Payload(t, src, "0.1.0", map[string]string{"telinha.renderer.js": "renderer"})
	zipPath := filepath.Join(dir, "Telinha-addon-abcdef12.zip")
	testutil.Zip(t, src, zipPath, map[string]string{"../evil.js": "x", "sub/extra.txt": "y"})

	for _, in := range []string{zipPath, src} {
		home := filepath.Join(dir, "home-"+filepath.Base(in))
		m, ignored, err := Stage(in, home)
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if m.Version != "0.1.0" || m.LoaderEntry != "main.js" || len(m.Files) != 4 {
			t.Fatalf("manifest %+v", m)
		}
		if in == zipPath && (len(ignored) != 2 || !strings.Contains(strings.Join(ignored, ","), "evil")) {
			t.Fatalf("ignored: %v", ignored)
		}
		staged := filepath.Join(home, NewDir)
		entries, _ := os.ReadDir(staged)
		if len(entries) != 5 { // 4 listed + version.json, nothing else
			t.Fatalf("staged %d files", len(entries))
		}
		if _, err := os.Stat(filepath.Join(home, "evil.js")); err == nil {
			t.Fatal("zip slip")
		}
		if _, err := ReadInstalled(staged); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStageRejectsTampering(t *testing.T) {
	dir := testutil.TempDir(t)
	src := filepath.Join(dir, "src")
	testutil.Payload(t, src, "0.1.0", nil)
	home := filepath.Join(dir, "home")

	// tampered content (same size)
	testutil.Write(t, filepath.Join(src, "main.js"), []byte(strings.Repeat("X", len(testutil.Read(t, filepath.Join(src, "main.js"))))))
	if _, _, err := Stage(src, home); !errors.Is(err, ErrFileMismatch) {
		t.Fatalf("tampered: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, NewDir)); err == nil {
		t.Fatal("staging left behind")
	}

	// zip with a size mismatch
	testutil.Payload(t, src, "0.1.0", nil)
	testutil.Write(t, filepath.Join(src, "addon.json"), []byte("{}"))
	z := filepath.Join(dir, "bad.zip")
	testutil.Zip(t, src, z, nil)
	if _, _, err := Stage(z, home); err == nil {
		t.Fatal("size mismatch accepted")
	}

	// missing listed file
	testutil.Payload(t, src, "0.1.0", nil)
	os.Remove(filepath.Join(src, "addon.json"))
	if _, _, err := Stage(src, home); err == nil {
		t.Fatal("missing file accepted")
	}

	// no version.json
	empty := filepath.Join(dir, "empty")
	os.MkdirAll(empty, 0o755)
	if _, _, err := Stage(empty, home); err == nil {
		t.Fatal("no manifest accepted")
	}
}

func TestManifestValidation(t *testing.T) {
	dir := testutil.TempDir(t)
	m := testutil.Payload(t, dir, "0.1.0", nil)
	edit := func(f func(m map[string]any)) []byte {
		var c map[string]any
		b, _ := json.Marshal(m)
		json.Unmarshal(b, &c)
		f(c)
		b, _ = json.Marshal(c)
		return b
	}
	if _, err := ParseManifest(edit(func(map[string]any) {})); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseManifest(edit(func(c map[string]any) { c["payloadFormat"] = 2 })); !errors.Is(err, ErrTooNew) {
		t.Fatalf("format 2: %v", err)
	}
	if _, err := ParseManifest(edit(func(c map[string]any) { c["stubFormat"] = 2 })); !errors.Is(err, ErrTooNew) {
		t.Fatalf("stub format 2: %v", err)
	}
	bad := []func(c map[string]any){
		func(c map[string]any) { c["loaderEntry"] = "nope.js" },
		func(c map[string]any) { delete(c, "stubTemplate") },
		func(c map[string]any) {
			c["files"].(map[string]any)["../x.js"] = map[string]any{"size": 1, "sha256": strings.Repeat("a", 64)}
		},
		func(c map[string]any) {
			c["files"].(map[string]any)["sub/x.js"] = map[string]any{"size": 1, "sha256": strings.Repeat("a", 64)}
		},
		func(c map[string]any) {
			c["files"].(map[string]any)["x.js"] = map[string]any{"size": 1, "sha256": "zz"}
		},
		func(c map[string]any) { c["files"] = map[string]any{} },
	}
	for i, f := range bad {
		if _, err := ParseManifest(edit(f)); err == nil {
			t.Errorf("bad manifest %d accepted", i)
		}
	}
}

func TestValidName(t *testing.T) {
	for _, n := range []string{"main.js", "telinha-audio.exe", "a.b.c"} {
		if !ValidName(n) {
			t.Errorf("%q rejected", n)
		}
	}
	for _, n := range []string{"", ".", "..", "a/b", `a\b`, "c:x", "con", "NUL.txt", "com1.js", "x.", "x ", "a\x01"} {
		if ValidName(n) {
			t.Errorf("%q accepted", n)
		}
	}
}

func TestSwapAndRollback(t *testing.T) {
	dir := testutil.TempDir(t)
	home := filepath.Join(dir, "home")
	v1, v2 := filepath.Join(dir, "v1"), filepath.Join(dir, "v2")
	testutil.Payload(t, v1, "1.0.0", nil)
	testutil.Payload(t, v2, "2.0.0", nil)

	if _, _, err := Stage(v1, home); err != nil {
		t.Fatal(err)
	}
	if err := Swap(home); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Stage(v2, home); err != nil {
		t.Fatal(err)
	}
	if err := Swap(home); err != nil {
		t.Fatal(err)
	}
	cur, _ := ReadInstalled(filepath.Join(home, AddonDir))
	prev, _ := ReadInstalled(filepath.Join(home, PrevDir))
	if cur == nil || prev == nil || cur.Version != "2.0.0" || prev.Version != "1.0.0" {
		t.Fatalf("after swap: %v %v", cur, prev)
	}
	for _, d := range []string{NewDir, OldDir} {
		if _, err := os.Stat(filepath.Join(home, d)); err == nil {
			t.Fatalf("%s left behind", d)
		}
	}
	if err := Rollback(home); err != nil {
		t.Fatal(err)
	}
	cur, _ = ReadInstalled(filepath.Join(home, AddonDir))
	prev, _ = ReadInstalled(filepath.Join(home, PrevDir))
	if cur.Version != "1.0.0" || prev.Version != "2.0.0" {
		t.Fatalf("after rollback: %s %s", cur.Version, prev.Version)
	}
	if err := Swap(home); err == nil {
		t.Fatal("swap without staging succeeded")
	}
}

func TestSameFiles(t *testing.T) {
	dir := testutil.TempDir(t)
	a, _ := ParseManifest(mustJSON(testutil.Payload(t, filepath.Join(dir, "a"), "1", nil)))
	b, _ := ParseManifest(mustJSON(testutil.Payload(t, filepath.Join(dir, "b"), "1", nil)))
	c, _ := ParseManifest(mustJSON(testutil.Payload(t, filepath.Join(dir, "c"), "2", nil)))
	if !SameFiles(a, b) || SameFiles(a, c) {
		t.Fatal("SameFiles")
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestPickRelease(t *testing.T) {
	ts := func(s string) time.Time { v, _ := time.Parse(time.RFC3339, s); return v }
	rels := []Release{
		{TagName: "old", PublishedAt: ts("2026-01-01T00:00:00Z"), Assets: []Asset{{Name: "Telinha-addon-1.zip"}}},
		{TagName: "draft", Draft: true, PublishedAt: ts("2026-12-01T00:00:00Z"), Assets: []Asset{{Name: "Telinha-addon-d.zip"}}},
		{TagName: "pre", Prerelease: true, PublishedAt: ts("2026-10-01T00:00:00Z"), Assets: []Asset{{Name: "Telinha-addon-p.zip"}, {Name: "Telinha-addon-p.zip.sha256"}}},
		{TagName: "noasset", PublishedAt: ts("2026-11-01T00:00:00Z"), Assets: []Asset{{Name: "Telinha-teste-x.zip"}}},
	}
	if r, a := PickRelease(rels, true); r == nil || r.TagName != "pre" || a.Name != "Telinha-addon-p.zip" {
		t.Fatalf("with prereleases: %v %v", r, a)
	}
	if r, _ := PickRelease(rels, false); r == nil || r.TagName != "old" {
		t.Fatalf("without prereleases: %v", r)
	}
	if r, _ := PickRelease(rels[3:], true); r != nil {
		t.Fatal("picked a release without payload")
	}
}

func TestHashSources(t *testing.T) {
	h := strings.Repeat("ab", 32)
	o := strings.Repeat("cd", 32)
	name := "Telinha-addon-abc.zip"
	if got := HashFromSumFile(h+"  "+name+"\n", name); got != h {
		t.Fatalf("sum file: %q", got)
	}
	if got := HashFromSumFile(o+"  other.zip\n"+h+" *"+name+"\n", name); got != h {
		t.Fatalf("sum file 2: %q", got)
	}
	if got := HashFromSumFile(h+"\n", name); got != h {
		t.Fatalf("bare: %q", got)
	}
	for body, want := range map[string]string{
		"Notas\n\nSHA-256 (" + name + ") = " + h + "\n":                       h,
		"| arquivo | sha256 |\n|---|---|\n| `" + name + "` | `" + h + "` |\n": h,
		"**SHA-256:** `" + h + "`\n":                                          h,
		"sha256: " + h + "\nsha256: " + o + "\n":                              "",
		"`" + o + "  Telinha-teste.zip`\n":                                    "",
		"nothing here":                                                        "",
	} {
		if got := HashFromReleaseBody(body, name); got != want {
			t.Errorf("body %q: got %q want %q", body, got, want)
		}
	}
	for js, want := range map[string]string{
		`{"sha256":"` + h + `"}`:                              h,
		`{"file":"` + name + `","sha256":"sha256:` + h + `"}`: h,
		`{"file":"other.zip","sha256":"` + h + `"}`:           "",
		`{"assets":[{"name":"x.zip","sha256":"` + o + `"},{"name":"` + name + `","sha256":"` + h + `"}]}`: h,
		`{"` + name + `":"` + h + `"}`:                 h,
		`{"files":{"main.js":{"sha256":"` + o + `"}}}`: "",
	} {
		if got := HashFromVersionJSON([]byte(js), name); got != want {
			t.Errorf("json %s: got %q want %q", js, got, want)
		}
	}
	if err := Verify(h, []Expected{{h, "a"}, {strings.ToUpper(h), "b"}}); err != nil {
		t.Fatal(err)
	}
	if err := Verify(h, []Expected{{h, "a"}, {o, "b"}}); !errors.Is(err, ErrChecksum) {
		t.Fatalf("mismatch: %v", err)
	}
}

// fakeGitHub serves a release list and its assets.
func fakeGitHub(t *testing.T, zipPath string, digest, sumFile string) *httptest.Server {
	zipData := testutil.Read(t, zipPath)
	name := filepath.Base(zipPath)
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/"+RepoOwner+"/"+RepoName+"/releases", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			http.Error(w, "no UA", 403)
			return
		}
		assets := []map[string]any{{"name": name, "size": len(zipData), "digest": digest, "browser_download_url": srv.URL + "/dl/" + name}}
		if sumFile != "" {
			assets = append(assets, map[string]any{"name": name + ".sha256", "size": len(sumFile), "browser_download_url": srv.URL + "/dl/" + name + ".sha256"})
		}
		json.NewEncoder(w).Encode([]map[string]any{
			{"tag_name": "teste-3", "prerelease": true, "published_at": "2026-10-29T00:00:00Z", "body": "notes", "assets": assets},
			{"tag_name": "teste-2", "prerelease": true, "published_at": "2026-10-20T00:00:00Z", "assets": []map[string]any{{"name": "Telinha-teste-a.zip"}}},
		})
	})
	mux.HandleFunc("/dl/"+name, func(w http.ResponseWriter, r *http.Request) { w.Write(zipData) })
	mux.HandleFunc("/dl/"+name+".sha256", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, sumFile) })
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestGitHubDownload(t *testing.T) {
	dir := testutil.TempDir(t)
	src := filepath.Join(dir, "src")
	testutil.Payload(t, src, "0.1.0", nil)
	zipPath := filepath.Join(dir, "Telinha-addon-abcdef12.zip")
	testutil.Zip(t, src, zipPath, nil)
	sum := testutil.SHA256(t, zipPath)

	srv := fakeGitHub(t, zipPath, "sha256:"+sum, sum+"  Telinha-addon-abcdef12.zip\n")
	c := NewClient("test")
	c.APIBase = srv.URL
	ctx := context.Background()
	rel, asset, err := c.Latest(ctx)
	if err != nil || rel.TagName != "teste-3" || asset.Name != "Telinha-addon-abcdef12.zip" {
		t.Fatalf("Latest: %v %v %v", rel, asset, err)
	}
	checks, err := c.ReleaseChecks(ctx, rel, asset)
	if err != nil || len(checks.Hashes) != 2 {
		t.Fatalf("checks: %+v %v", checks, err)
	}
	out := filepath.Join(dir, "dl.zip")
	got, err := c.Download(ctx, asset, out, checks.Hashes)
	if err != nil || got != sum {
		t.Fatalf("download: %s %v", got, err)
	}

	// published hash disagrees with the file -> refused
	bad := fakeGitHub(t, zipPath, "sha256:"+sum, strings.Repeat("0", 64)+"  Telinha-addon-abcdef12.zip\n")
	c.APIBase = bad.URL
	rel, asset, _ = c.Latest(ctx)
	checks, _ = c.ReleaseChecks(ctx, rel, asset)
	if _, err := c.Download(ctx, asset, out, checks.Hashes); !errors.Is(err, ErrChecksum) {
		t.Fatalf("bad hash: %v", err)
	}
}

func TestLatestNoRelease(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("[]")) }))
	defer srv.Close()
	c := NewClient("test")
	c.APIBase = srv.URL
	if _, _, err := c.Latest(context.Background()); !errors.Is(err, ErrNoRelease) {
		t.Fatalf("%v", err)
	}
}
