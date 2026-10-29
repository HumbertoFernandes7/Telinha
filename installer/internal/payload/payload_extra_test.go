// SPDX-License-Identifier: GPL-3.0-or-later

package payload

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/fsutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

// Held and read-only files stand in for "Discord still has it open": fsutil's retries must not slow the tests.
func init() { fsutil.RetryDelay = time.Millisecond }

// -------------------------------------------------------------------------------------------- helpers

type zentry struct {
	name   string
	data   []byte
	method uint16      // 0 = Deflate (the default), zip.Store for stored entries
	mode   os.FileMode // 0 = a regular file
	raw99  bool        // an entry compressed with a method nobody implements
}

func writeZip(t *testing.T, path string, entries []zentry) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.method == zip.Store {
			h.Method = zip.Store
		}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		var w io.Writer
		if e.raw99 {
			h.Method = 99
			h.CRC32 = crc32.ChecksumIEEE(e.data)
			h.CompressedSize64, h.UncompressedSize64 = uint64(len(e.data)), uint64(len(e.data))
			w, err = zw.CreateRaw(h)
		} else {
			w, err = zw.CreateHeader(h)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

// entriesOf lists the files of a payload folder as zip entries.
func entriesOf(t *testing.T, dir string) []zentry {
	t.Helper()
	list, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []zentry
	for _, e := range list {
		out = append(out, zentry{name: e.Name(), data: testutil.Read(t, filepath.Join(dir, e.Name()))})
	}
	return out
}

func replaceEntry(es []zentry, name string, f func(*zentry)) []zentry {
	out := append([]zentry(nil), es...)
	for i := range out {
		if out[i].name == name {
			f(&out[i])
		}
	}
	return out
}

func manifestBytes(t *testing.T, m map[string]any, edit func(m map[string]any)) []byte {
	t.Helper()
	b, _ := json.Marshal(m)
	var c map[string]any
	_ = json.Unmarshal(b, &c)
	if edit != nil {
		edit(c)
	}
	b, _ = json.Marshal(c)
	return b
}

// jsonServer serves fixed handlers by path.
func server(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c := NewClient("test")
	c.APIBase = srv.URL
	return c
}

func shortHome(t *testing.T) string { return filepath.Join(testutil.TempDir(t), "home") }

// -------------------------------------------------------------------------------------------- github.go

func TestClientRequestErrors(t *testing.T) {
	ctx := context.Background()
	c := NewClient("agent/1")
	c.APIBase = "http://bad host" // a URL that cannot even be built
	if _, _, err := c.Latest(ctx); err == nil {
		t.Fatal("a malformed API base was accepted")
	}
	c.Prerelease = true
	if _, _, err := c.Latest(ctx); err == nil {
		t.Fatal("a malformed API base was accepted (pre-release list)")
	}

	// nothing listens there
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	c = NewClient("agent/1")
	c.APIBase = url
	if _, _, err := c.Latest(ctx); err == nil || errors.Is(err, ErrNoRelease) {
		t.Fatalf("connection refused: %v", err)
	}
	c.Prerelease = true
	if _, _, err := c.Latest(ctx); err == nil || errors.Is(err, ErrNoRelease) {
		t.Fatalf("connection refused (pre-release list): %v", err)
	}
	if _, err := c.ReleaseChecks(ctx, &Release{Assets: []Asset{{Name: "version.json", URL: url + "/x"}}}, &Asset{Name: "Telinha-addon-a.zip"}); err == nil {
		t.Fatal("ReleaseChecks ignored a failing download")
	}
	// a cancelled context stops the request
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	live := server(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("{}")) })
	if _, _, err := live.Latest(cctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestRequestHeaders(t *testing.T) {
	var ua, accept []string
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		ua = append(ua, r.Header.Get("User-Agent"))
		accept = append(accept, r.Header.Get("Accept"))
		w.Write([]byte(`{"tag_name":"v1","assets":[{"name":"Telinha-addon-a.zip","browser_download_url":"x"}]}`))
	})
	c.UserAgent = "TelinhaInstaller/9 (+https://example.test)"
	if _, _, err := c.Latest(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ua[0] != c.UserAgent || accept[0] != "application/vnd.github+json" {
		t.Fatalf("headers: %q %q", ua, accept)
	}
}

func TestStatusErrorMessage(t *testing.T) {
	err := &StatusError{URL: "https://x/y", Code: 503}
	if err.Error() != "GET https://x/y: HTTP 503" {
		t.Fatalf("%q", err.Error())
	}
	c := server(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "down", 503) })
	_, _, e := c.Latest(context.Background())
	var se *StatusError
	if !errors.As(e, &se) || se.Code != 503 {
		t.Fatalf("a failing GitHub must surface its status: %v", e)
	}
}

func TestLatestRejectsBadAnswers(t *testing.T) {
	ctx := context.Background()
	answer := ""
	status := 200
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		io.WriteString(w, answer)
	})
	asset := `"assets":[{"name":"Telinha-addon-a.zip"}]`
	for name, tc := range map[string]struct {
		pre    bool
		status int
		body   string
		noRel  bool // ErrNoRelease
	}{
		"stable: garbage":         {false, 200, "not json", false},
		"stable: draft":           {false, 200, `{"tag_name":"v1","draft":true,` + asset + `}`, true},
		"stable: pre-release":     {false, 200, `{"tag_name":"v1","prerelease":true,` + asset + `}`, true},
		"stable: no payload":      {false, 200, `{"tag_name":"v1","assets":[{"name":"TelinhaInstaller.exe"}]}`, true},
		"stable: server error":    {false, 500, "x", false},
		"stable: rate limited":    {false, 403, "x", false},
		"list: garbage":           {true, 200, "not json", false},
		"list: object, not array": {true, 200, `{"tag_name":"v1"}`, false},
		"list: empty":             {true, 200, "[]", true},
		"list: server error":      {true, 500, "x", false},
	} {
		c.Prerelease, status, answer = tc.pre, tc.status, tc.body
		_, _, err := c.Latest(ctx)
		if err == nil || errors.Is(err, ErrNoRelease) != tc.noRel {
			t.Errorf("%s: %v (want ErrNoRelease=%v)", name, err, tc.noRel)
		}
	}
}

func TestPickReleaseFallsBackToCreatedAt(t *testing.T) {
	ts := func(s string) time.Time { v, _ := time.Parse(time.RFC3339, s); return v }
	a := Asset{Name: "Telinha-addon-a.zip"}
	rels := []Release{
		{TagName: "unpublished-old", CreatedAt: ts("2026-03-01T00:00:00Z"), Assets: []Asset{a}},
		{TagName: "unpublished-new", CreatedAt: ts("2026-05-01T00:00:00Z"), Assets: []Asset{a}},
		{TagName: "published", PublishedAt: ts("2026-04-01T00:00:00Z"), CreatedAt: ts("2026-01-01T00:00:00Z"), Assets: []Asset{a}},
	}
	if r, _ := PickRelease(rels, false); r == nil || r.TagName != "unpublished-new" {
		t.Fatalf("picked %v", r)
	}
	// several payload assets: the greatest name wins
	r := Release{Assets: []Asset{{Name: "Telinha-addon-a.zip"}, {Name: "Telinha-addon-c.zip"}, {Name: "Telinha-addon-b.zip"}, {Name: "other.zip"}}}
	if _, best := PickRelease([]Release{r}, false); best == nil || best.Name != "Telinha-addon-c.zip" {
		t.Fatalf("best %v", best)
	}
	if rel, best := PickRelease(nil, true); rel != nil || best != nil {
		t.Fatal("empty list")
	}
}

func TestReleaseChecksSources(t *testing.T) {
	ctx := context.Background()
	h := strings.Repeat("ab", 32)
	o := strings.Repeat("cd", 32)
	zipName := "Telinha-addon-abc.zip"
	files := map[string]string{}
	status := map[string]int{}
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if s := status[name]; s != 0 {
			http.Error(w, "x", s)
			return
		}
		io.WriteString(w, files[name])
	})
	url := func(n string) string { return c.APIBase + "/" + n }
	asset := &Asset{Name: zipName, URL: url(zipName), Digest: "SHA256:" + strings.ToUpper(h)}

	// the digest is read case-insensitively; an unknown digest scheme is ignored
	rel := &Release{TagName: "v1"}
	ch, err := c.ReleaseChecks(ctx, rel, asset)
	if err != nil || len(ch.Hashes) != 1 || ch.Hashes[0].SHA256 != h || ch.Manifest != nil {
		t.Fatalf("digest: %+v %v", ch, err)
	}
	for _, d := range []string{"", "md5:" + h, "sha256:short", "sha256:" + strings.Repeat("g", 64)} {
		ch, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName, Digest: d})
		if err != nil || len(ch.Hashes) != 0 {
			t.Fatalf("digest %q: %+v %v", d, ch, err)
		}
	}

	// <zip>.sha256: found, no hash inside, fetch fails
	files[zipName+".sha256"] = o + "  " + zipName + "\n"
	rel = &Release{Assets: []Asset{{Name: zipName + ".SHA256", URL: url(zipName + ".sha256")}}}
	ch, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName})
	if err != nil || len(ch.Hashes) != 1 || ch.Hashes[0].SHA256 != o || !strings.EqualFold(ch.Hashes[0].Source, zipName+".sha256") {
		t.Fatalf("sum asset: %+v %v", ch, err)
	}
	files[zipName+".sha256"] = "nothing useful\n"
	if _, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err == nil || !strings.Contains(err.Error(), "no SHA-256") {
		t.Fatalf("sum asset without a hash: %v", err)
	}
	status[zipName+".sha256"] = 404
	if _, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err == nil || !strings.Contains(err.Error(), "downloading") {
		t.Fatalf("sum asset that fails: %v", err)
	}

	// version.json: a payload manifest, a small JSON with the hash, or something else entirely
	m := testutil.Payload(t, filepath.Join(testutil.TempDir(t), "p"), "0.1.0", nil)
	mb, _ := json.Marshal(m)
	rel = &Release{Assets: []Asset{{Name: "version.json", URL: url("version.json")}}}
	files["version.json"] = string(mb)
	if ch, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err != nil || ch.Manifest == nil || ch.Manifest.Version != "0.1.0" || len(ch.Hashes) != 0 {
		t.Fatalf("version.json manifest: %+v %v", ch, err)
	}
	files["version.json"] = `{"file":"` + zipName + `","sha256":"` + h + `"}`
	if ch, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err != nil || ch.Manifest != nil || len(ch.Hashes) != 1 || ch.Hashes[0].SHA256 != h || ch.Hashes[0].Source != ChecksumAsset {
		t.Fatalf("version.json hash: %+v %v", ch, err)
	}
	for _, junk := range []string{"not json at all", `{"sha256":"zz"}`, `{"file":"other.zip","sha256":"` + h + `"}`} {
		files["version.json"] = junk
		if ch, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err != nil || ch.Manifest != nil || len(ch.Hashes) != 0 {
			t.Fatalf("version.json %q: %+v %v", junk, ch, err)
		}
	}
	status["version.json"] = 500
	if _, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err == nil {
		t.Fatal("version.json fetch error swallowed")
	}

	// the release notes count too
	rel = &Release{Body: "SHA-256 (" + zipName + ") = " + o}
	if ch, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err != nil || len(ch.Hashes) != 1 || ch.Hashes[0].SHA256 != o || ch.Hashes[0].Source != "notas da release" {
		t.Fatalf("notes: %+v %v", ch, err)
	}
	// unrelated assets are never downloaded
	rel = &Release{Assets: []Asset{{Name: "README.md", URL: url("boom")}}}
	status["boom"] = 500
	if _, err = c.ReleaseChecks(ctx, rel, &Asset{Name: zipName}); err != nil {
		t.Fatalf("an unrelated asset was fetched: %v", err)
	}
}

func TestHashHelpersMore(t *testing.T) {
	h := strings.Repeat("ab", 32)
	o := strings.Repeat("cd", 32)
	name := "Telinha-addon-abc.zip"
	if got := HashFromSumFile("", name); got != "" {
		t.Fatalf("empty: %q", got)
	}
	if got := HashFromSumFile(h+"  a.zip\n"+o+"  b.zip\n", name); got != "" {
		t.Fatalf("two hashes, none for this file: %q", got)
	}
	if got := HashFromSumFile("\n  \n"+h+"  "+strings.ToUpper(name)+"\n", name); got != h {
		t.Fatalf("case-insensitive name: %q", got)
	}
	if got := HashFromSumFile("not-a-hash  "+name+"\n", name); got != "" {
		t.Fatalf("garbage hash: %q", got)
	}
	for js, want := range map[string]string{
		`{"` + name + `":{"sha256":"` + h + `"}}`:                          h, // object under the asset's name
		`{"` + name + `":{"other":1}}`:                                     "",
		`{"` + name + `":"` + h[:10] + `"}`:                                "", // a string that is not a hash
		`{"release":{"assets":{"` + name + `":"` + o + `"}}}`:              o,
		`{"checksums":[{"zip":"` + name + `","SHA-256":"` + h + `"}]}`:     h,
		`{"assets":[{"name":"` + name + `","digest":"sha256:` + o + `"}]}`: o,
		`[]`:    "",
		`7`:     "",
		`null`:  "",
		`"str"`: "",
		`{"name":"x\\` + name + `","sha256":"` + h + `"}`: h, // a Windows path to the same file
	} {
		if got := HashFromVersionJSON([]byte(js), name); got != want {
			t.Errorf("json %s: got %q want %q", js, got, want)
		}
	}
	if got := HashFromVersionJSON([]byte("{"), name); got != "" {
		t.Fatalf("broken json: %q", got)
	}
	for in, want := range map[string]string{h: h, "  " + strings.ToUpper(h) + " ": h, "sha256:" + h: h, "SHA256:" + h: h, h[:63]: "", h + "0": "", "": "", strings.Repeat("g", 64): ""} {
		if got := normHash(in); got != want {
			t.Errorf("normHash(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDownloadFailures(t *testing.T) {
	ctx := context.Background()
	dir := testutil.TempDir(t)
	dest := filepath.Join(dir, "dl.zip")
	body := []byte(strings.Repeat("telinha", 100))
	handler := func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			w.Write(body)
		case "/404":
			http.NotFound(w, r)
		case "/cut": // promises 1000 bytes, delivers 10, drops the connection
			w.Header().Set("Content-Length", "1000")
			w.Write(body[:10])
			w.(http.Flusher).Flush()
			panic(http.ErrAbortHandler)
		case "/endless": // more than MaxZipSize, with no Content-Length to give it away
			w.Header().Set("Transfer-Encoding", "chunked")
			chunk := make([]byte, 1<<20)
			for i := 0; i <= MaxZipSize>>20; i++ {
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
			w.Write([]byte{0})
		}
	}
	c := server(t, handler)
	url := func(p string) string { return c.APIBase + p }
	sum := sha256Hex(body)

	if _, err := c.Download(ctx, &Asset{Name: "z", URL: url("/ok"), Size: MaxZipSize + 1}, dest, nil); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("declared size over the limit: %v", err)
	}
	if _, err := c.Download(ctx, &Asset{Name: "z", URL: url("/404")}, dest, nil); err == nil {
		t.Fatal("404 accepted")
	} else if se := (*StatusError)(nil); !errors.As(err, &se) || se.Code != 404 {
		t.Fatalf("404: %v", err)
	}
	if _, err := c.Download(ctx, &Asset{Name: "z", URL: url("/ok")}, filepath.Join(dir, "no", "such", "dl.zip"), nil); err == nil {
		t.Fatal("destination in a missing folder accepted")
	}
	if _, err := c.Download(ctx, &Asset{Name: "z", URL: url("/cut"), Size: 1000}, dest, nil); err == nil || !strings.Contains(err.Error(), "downloading z") {
		t.Fatalf("a connection that drops half way: %v", err)
	}
	if _, err := c.Download(ctx, &Asset{Name: "z", URL: url("/ok"), Size: int64(len(body)) + 5}, dest, nil); err == nil || !strings.Contains(err.Error(), "expected") {
		t.Fatalf("size different from what GitHub declared: %v", err)
	}
	// no declared size: the size check is skipped, the hash still counts
	got, err := c.Download(ctx, &Asset{Name: "z", URL: url("/ok")}, dest, []Expected{{sum, "test"}})
	if err != nil || got != sum {
		t.Fatalf("download without a declared size: %q %v", got, err)
	}
	got, err = c.Download(ctx, &Asset{Name: "z", URL: url("/ok"), Size: int64(len(body))}, dest, []Expected{{strings.Repeat("0", 64), "test"}})
	if !errors.Is(err, ErrChecksum) || got != sum {
		t.Fatalf("the computed hash comes back with the mismatch error: %q %v", got, err)
	}
	if testing.Short() {
		t.Skip("the 64 MiB download is skipped in -short")
	}
	if _, err := c.Download(ctx, &Asset{Name: "z", URL: url("/endless")}, dest, nil); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("an endless body must be cut at MaxZipSize: %v", err)
	}
}

func sha256Hex(b []byte) string {
	dir, _ := os.MkdirTemp("", "tlh")
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "f")
	os.WriteFile(p, b, 0o644)
	s, _ := FileSHA256(p)
	return s
}

func TestFileSHA256Errors(t *testing.T) {
	dir := testutil.TempDir(t)
	if _, err := FileSHA256(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("missing file hashed")
	}
	// a folder opens on Windows but cannot be read
	if _, err := FileSHA256(dir); err == nil {
		t.Fatal("folder hashed")
	}
	p := filepath.Join(dir, "a.txt")
	testutil.Write(t, p, []byte("abc"))
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got, err := FileSHA256(p); err != nil || got != want {
		t.Fatalf("%q %v", got, err)
	}
}

// -------------------------------------------------------------------------------------------- manifest

func TestManifestLabelAndParseErrors(t *testing.T) {
	for _, c := range []struct {
		m    Manifest
		want string
	}{
		{Manifest{}, "?"},
		{Manifest{Version: "0.1.0"}, "0.1.0"},
		{Manifest{Version: "0.1.0", Commit: "a"}, "0.1.0 (a)"},
		{Manifest{Commit: "abc"}, "? (abc)"},
	} {
		if got := c.m.Label(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.m, got, c.want)
		}
	}
	if _, err := ParseManifest([]byte("{not json")); err == nil || !strings.Contains(err.Error(), "version.json") {
		t.Fatalf("%v", err)
	}
	if _, err := ParseManifest(nil); err == nil {
		t.Fatal("empty manifest accepted")
	}
}

func TestManifestSizeAndCountLimits(t *testing.T) {
	m := testutil.Payload(t, filepath.Join(testutil.TempDir(t), "p"), "0.1.0", nil)
	ok := strings.Repeat("a", 64)
	// the sum of the sizes is bounded (nothing here is ever allocated: the numbers are only declared)
	b := manifestBytes(t, m, func(c map[string]any) {
		files := c["files"].(map[string]any)
		files["big1.bin"] = map[string]any{"size": maxExtractedSize, "sha256": ok}
		files["big2.bin"] = map[string]any{"size": 1, "sha256": ok}
	})
	if _, err := ParseManifest(b); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized payload: %v", err)
	}
	// exactly at the limit is fine
	b = manifestBytes(t, m, func(c map[string]any) {
		c["files"].(map[string]any)["big1.bin"] = map[string]any{"size": maxExtractedSize - 100000, "sha256": ok}
	})
	if _, err := ParseManifest(b); err != nil {
		t.Fatalf("a big but allowed payload: %v", err)
	}
	// too many files
	b = manifestBytes(t, m, func(c map[string]any) {
		files := c["files"].(map[string]any)
		for i := 0; i < maxFiles; i++ {
			files[fmt.Sprintf("f%03d.js", i)] = map[string]any{"size": 1, "sha256": ok}
		}
	})
	if _, err := ParseManifest(b); err == nil || !strings.Contains(err.Error(), "files listed") {
		t.Fatalf("too many files: %v", err)
	}
	// names and entries
	for name, f := range map[string]func(c map[string]any){
		"negative size": func(c map[string]any) { c["files"].(map[string]any)["x.js"] = map[string]any{"size": -1, "sha256": ok} },
		"upper-case hash": func(c map[string]any) {
			c["files"].(map[string]any)["x.js"] = map[string]any{"size": 1, "sha256": strings.ToUpper(ok)}
		},
		"manifest as file": func(c map[string]any) {
			c["files"].(map[string]any)["VERSION.json"] = map[string]any{"size": 1, "sha256": ok}
		},
		"reserved name": func(c map[string]any) {
			c["files"].(map[string]any)["nul.txt"] = map[string]any{"size": 1, "sha256": ok}
		},
		"no loaderEntry":   func(c map[string]any) { c["loaderEntry"] = "" },
		"template missing": func(c map[string]any) { c["stubTemplate"] = "gone.js" },
	} {
		_, err := ParseManifest(manifestBytes(t, m, f))
		if name == "upper-case hash" {
			if err != nil {
				t.Errorf("%s: hex is case-insensitive: %v", name, err)
			}
			continue
		}
		if err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestValidNameMore(t *testing.T) {
	for _, n := range []string{"lpt1", "COM9.txt", "Aux", "prn.js", strings.Repeat("a", 201), "a|b", "a?b", "a*b", "a<b", `a"b`, "tab\tname"} {
		if ValidName(n) {
			t.Errorf("%q accepted", n)
		}
	}
	for _, n := range []string{"com", "com10", "lpt", "comma.js", "console.js", "x-y_z.min.js", strings.Repeat("a", 200)} {
		if !ValidName(n) {
			t.Errorf("%q rejected", n)
		}
	}
}

// -------------------------------------------------------------------------------------------- Stage

func TestStageFolderIgnoresUnlistedFiles(t *testing.T) {
	dir := testutil.TempDir(t)
	src := filepath.Join(dir, "src")
	testutil.Payload(t, src, "0.1.0", nil)
	testutil.Write(t, filepath.Join(src, "README.txt"), []byte("not part of the payload"))
	os.MkdirAll(filepath.Join(src, "sub"), 0o755)
	m, ignored, err := Stage(src, filepath.Join(dir, "home"))
	if err != nil || m.Version != "0.1.0" || len(ignored) != 2 {
		t.Fatalf("%+v %v %v", m, ignored, err)
	}
	if fsutil.Exists(filepath.Join(dir, "home", NewDir, "README.txt")) {
		t.Fatal("an unlisted file was staged")
	}
}

func TestStageFolderFailures(t *testing.T) {
	dir := testutil.TempDir(t)
	src := filepath.Join(dir, "src")
	m := testutil.Payload(t, src, "0.1.0", nil)

	t.Run("version.json is not valid", func(t *testing.T) {
		bad := filepath.Join(dir, "bad")
		testutil.Write(t, filepath.Join(bad, "version.json"), []byte("{oops"))
		if _, _, err := Stage(bad, filepath.Join(dir, "h1")); err == nil || !strings.Contains(err.Error(), "version.json") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("version.json is too big", func(t *testing.T) {
		big := filepath.Join(dir, "big")
		testutil.Write(t, filepath.Join(big, "version.json"), bytes.Repeat([]byte(" "), maxManifest+1))
		if _, _, err := Stage(big, filepath.Join(dir, "h2")); err == nil || !strings.Contains(err.Error(), "too large") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("a payload for a newer installer", func(t *testing.T) {
		newer := filepath.Join(dir, "newer")
		testutil.Write(t, filepath.Join(newer, "version.json"), manifestBytes(t, m, func(c map[string]any) { c["payloadFormat"] = 2 }))
		if _, _, err := Stage(newer, filepath.Join(dir, "h3")); !errors.Is(err, ErrTooNew) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("two names that differ only in case", func(t *testing.T) {
		// Windows would extract both onto the same file: refused instead of silently overwriting
		twin := filepath.Join(dir, "twin")
		testutil.Payload(t, twin, "0.1.0", nil)
		var mm map[string]any
		_ = json.Unmarshal(testutil.Read(t, filepath.Join(twin, "version.json")), &mm)
		files := mm["files"].(map[string]any)
		files["MAIN.JS"] = files["main.js"]
		testutil.Write(t, filepath.Join(twin, "version.json"), manifestBytes(t, mm, nil))
		if _, _, err := Stage(twin, filepath.Join(dir, "h4")); err == nil {
			t.Fatal("main.js and MAIN.JS were both staged")
		}
		if fsutil.Exists(filepath.Join(dir, "h4", NewDir)) {
			t.Fatal("a failed stage left addon.new behind")
		}
	})
	t.Run("a file with another size than version.json says", func(t *testing.T) {
		for name, content := range map[string]string{"shorter": "{}", "longer": `{"format":1,"pluginName":"Telinha"}` + strings.Repeat(" ", 50)} {
			d := filepath.Join(dir, "size-"+name)
			testutil.Payload(t, d, "0.1.0", nil)
			testutil.Write(t, filepath.Join(d, "addon.json"), []byte(content))
			_, _, err := Stage(d, filepath.Join(dir, "hs-"+name))
			if !errors.Is(err, ErrFileMismatch) || !strings.Contains(err.Error(), "bytes, expected") {
				t.Errorf("%s: %v", name, err)
			}
		}
	})
	t.Run("version.json is a folder", func(t *testing.T) {
		d := filepath.Join(dir, "folder-manifest")
		os.MkdirAll(filepath.Join(d, "version.json"), 0o755)
		if _, _, err := Stage(d, filepath.Join(dir, "h7")); err == nil || !strings.Contains(err.Error(), "payload folder") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("the staging folder is held open", func(t *testing.T) {
		home := filepath.Join(dir, "h5")
		testutil.Write(t, filepath.Join(home, NewDir, "old.txt"), []byte("x"))
		testutil.HoldFile(t, filepath.Join(home, NewDir, "old.txt"))
		if _, _, err := Stage(src, home); err == nil {
			t.Fatal("staged over a folder that cannot be cleared")
		}
	})
	t.Run("the staging folder cannot be created", func(t *testing.T) {
		home := filepath.Join(dir, "h6")
		testutil.Write(t, home, []byte("a file where the Telinha folder should be"))
		if _, _, err := Stage(src, home); err == nil {
			t.Fatal("staged into a file")
		}
	})
}

func TestStageZipFailures(t *testing.T) {
	dir := testutil.TempDir(t)
	src := filepath.Join(dir, "src")
	m := testutil.Payload(t, src, "0.1.0", nil)
	base := entriesOf(t, src)
	n := 0
	stage := func(t *testing.T, entries []zentry) error {
		t.Helper()
		n++
		z := filepath.Join(dir, fmt.Sprintf("z%d.zip", n))
		writeZip(t, z, entries)
		_, _, err := Stage(z, filepath.Join(dir, fmt.Sprintf("home%d", n)))
		if err == nil {
			return nil
		}
		if fsutil.Exists(filepath.Join(dir, fmt.Sprintf("home%d", n), NewDir)) {
			t.Errorf("a failed stage left addon.new behind (%v)", err)
		}
		return err
	}
	cases := map[string]struct {
		entries []zentry
		want    string
	}{
		"duplicate entry":               {append(append([]zentry(nil), base...), zentry{name: "main.js", data: []byte("evil")}), "duplicate entry"},
		"duplicate after the slash fix": {append(append([]zentry(nil), base...), zentry{name: "sub/x.js", data: []byte("a")}, zentry{name: `sub\x.js`, data: []byte("b")}), "duplicate entry"},
		"no version.json": {func() []zentry {
			var out []zentry
			for _, e := range base {
				if e.name != "version.json" {
					out = append(out, e)
				}
			}
			return out
		}(), "no version.json at the zip root"},
		"version.json in a subfolder": {func() []zentry {
			out := replaceEntry(base, "version.json", func(e *zentry) { e.name = "payload/version.json" })
			return out
		}(), "no version.json at the zip root"},
		"version.json too large":                   {replaceEntry(base, "version.json", func(e *zentry) { e.data = bytes.Repeat([]byte(" "), maxManifest+1) }), "too large"},
		"version.json broken":                      {replaceEntry(base, "version.json", func(e *zentry) { e.data = []byte("{oops") }), "version.json"},
		"version.json uses an unknown compression": {replaceEntry(base, "version.json", func(e *zentry) { e.raw99 = true }), "unsupported compression"},
		"a listed file is missing": {func() []zentry {
			var out []zentry
			for _, e := range base {
				if e.name != "addon.json" {
					out = append(out, e)
				}
			}
			return out
		}(), "addon.json listed in version.json is missing"},
		"a listed file is a symlink":           {replaceEntry(base, "addon.json", func(e *zentry) { e.mode = os.ModeSymlink | 0o777 }), "not a regular file"},
		"a file uses an unknown compression":   {replaceEntry(base, "addon.json", func(e *zentry) { e.raw99 = true }), "unsupported compression"},
		"a file has the wrong size":            {replaceEntry(base, "addon.json", func(e *zentry) { e.data = append(e.data, ' ') }), "version.json says"},
		"a file has other content":             {replaceEntry(base, "addon.json", func(e *zentry) { e.data = bytes.ToUpper(e.data) }), "SHA-256"},
		"a stored file with a bad CRC":         {replaceEntry(base, "main.js", func(e *zentry) { e.method = zip.Store }), "checksum"},
		"a stored version.json with a bad CRC": {replaceEntry(base, "version.json", func(e *zentry) { e.method = zip.Store }), "checksum"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			entries := c.entries
			if strings.HasPrefix(name, "a stored") {
				// build the zip, then change a stored byte behind the writer's back (same length, CRC no longer fits)
				n++
				z := filepath.Join(dir, fmt.Sprintf("crc%d.zip", n))
				writeZip(t, z, entries)
				raw := testutil.Read(t, z)
				marker := "module.exports"
				if strings.Contains(name, "version.json") {
					marker = "payloadFormat"
				}
				i := bytes.Index(raw, []byte(marker))
				if i < 0 {
					t.Fatal("stored content not found in the zip")
				}
				raw[i] ^= 0x20 // flips the case of a letter: same length, the CRC no longer fits
				testutil.Write(t, z, raw)
				_, _, err := Stage(z, filepath.Join(dir, fmt.Sprintf("home%d", n)))
				if err == nil || !strings.Contains(err.Error(), c.want) {
					t.Fatalf("got %v, want %q", err, c.want)
				}
				return
			}
			err := stage(t, entries)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("got %v, want %q", err, c.want)
			}
		})
	}
	t.Run("a zip that is not a zip", func(t *testing.T) {
		junk := filepath.Join(dir, "junk.zip")
		testutil.Write(t, junk, []byte("PK nope"))
		if _, _, err := Stage(junk, filepath.Join(dir, "hj")); err == nil || !strings.Contains(err.Error(), "payload zip") {
			t.Fatalf("%v", err)
		}
		if _, _, err := Stage(filepath.Join(dir, "missing.zip"), filepath.Join(dir, "hj2")); err == nil {
			t.Fatal("missing zip accepted")
		}
	})
	t.Run("a healthy payload with directory entries and extras", func(t *testing.T) {
		entries := append(append([]zentry(nil), base...), zentry{name: "docs/", data: nil}, zentry{name: "docs/readme.txt", data: []byte("x")})
		n++
		z := filepath.Join(dir, fmt.Sprintf("ok%d.zip", n))
		writeZip(t, z, entries)
		got, ignored, err := Stage(z, filepath.Join(dir, fmt.Sprintf("homeok%d", n)))
		if err != nil || got.Version != m["version"] || len(ignored) != 1 || ignored[0] != "docs/readme.txt" {
			t.Fatalf("%v %v %v", got, ignored, err)
		}
	})
}

// -------------------------------------------------------------------------------------------- Swap / Rollback

func stageVersion(t *testing.T, home, dir, version string) {
	t.Helper()
	src := filepath.Join(dir, "v"+version)
	testutil.Payload(t, src, version, nil)
	if _, _, err := Stage(src, home); err != nil {
		t.Fatal(err)
	}
}

func versionOf(t *testing.T, dir string) string {
	t.Helper()
	m, err := ReadInstalled(dir)
	if err != nil {
		return "(" + err.Error() + ")"
	}
	return m.Version
}

func TestSwapFailures(t *testing.T) {
	dir := testutil.TempDir(t)

	t.Run("the first install", func(t *testing.T) {
		home := filepath.Join(dir, "first")
		stageVersion(t, home, dir, "1.0.0")
		if err := Swap(home); err != nil {
			t.Fatal(err)
		}
		if versionOf(t, filepath.Join(home, AddonDir)) != "1.0.0" || fsutil.Exists(filepath.Join(home, PrevDir)) {
			t.Fatal("first install")
		}
	})
	t.Run("addon.old from an earlier crash cannot be cleared", func(t *testing.T) {
		home := filepath.Join(dir, "oldheld")
		stageVersion(t, home, dir, "1.0.0")
		testutil.Write(t, filepath.Join(home, OldDir, "x.txt"), []byte("x"))
		testutil.HoldFile(t, filepath.Join(home, OldDir, "x.txt"))
		if err := Swap(home); err == nil {
			t.Fatal("swapped with a stale addon.old that could not be removed")
		}
	})
	t.Run("the running add-on cannot be moved aside", func(t *testing.T) {
		home := filepath.Join(dir, "inuse")
		stageVersion(t, home, dir, "1.0.0")
		if err := Swap(home); err != nil {
			t.Fatal(err)
		}
		stageVersion(t, home, dir, "2.0.0")
		testutil.HoldFile(t, filepath.Join(home, AddonDir, "main.js")) // Discord has it open
		err := Swap(home)
		if err == nil || !strings.Contains(err.Error(), "moving the current add-on aside") {
			t.Fatalf("%v", err)
		}
		if versionOf(t, filepath.Join(home, AddonDir)) != "1.0.0" {
			t.Fatal("the installed add-on must stay as it was")
		}
		if fsutil.Exists(filepath.Join(home, NewDir)) {
			t.Fatal("the staged copy must be dropped after a failed swap")
		}
	})
	t.Run("the new add-on cannot be activated", func(t *testing.T) {
		home := filepath.Join(dir, "noactivate")
		stageVersion(t, home, dir, "1.0.0")
		if err := Swap(home); err != nil {
			t.Fatal(err)
		}
		stageVersion(t, home, dir, "2.0.0")
		testutil.HoldFile(t, filepath.Join(home, NewDir, "main.js")) // an antivirus is scanning the staged copy
		err := Swap(home)
		if err == nil || !strings.Contains(err.Error(), "activating the new add-on") {
			t.Fatalf("%v", err)
		}
		if got := versionOf(t, filepath.Join(home, AddonDir)); got != "1.0.0" {
			t.Fatalf("the old add-on must be put back: %s", got)
		}
		if fsutil.Exists(filepath.Join(home, OldDir)) {
			t.Fatal("addon.old left behind")
		}
	})
	t.Run("the new add-on cannot be activated and there was none before", func(t *testing.T) {
		home := filepath.Join(dir, "noactivate-first")
		stageVersion(t, home, dir, "1.0.0")
		testutil.HoldFile(t, filepath.Join(home, NewDir, "main.js"))
		if err := Swap(home); err == nil {
			t.Fatal("swap succeeded")
		}
		if fsutil.Exists(filepath.Join(home, AddonDir)) {
			t.Fatal("an add-on appeared from a failed swap")
		}
	})
	t.Run("the previous copy cannot be replaced", func(t *testing.T) {
		home := filepath.Join(dir, "prevheld")
		stageVersion(t, home, dir, "1.0.0")
		_ = Swap(home)
		stageVersion(t, home, dir, "2.0.0")
		_ = Swap(home) // addon 2.0.0, prev 1.0.0
		stageVersion(t, home, dir, "3.0.0")
		testutil.HoldFile(t, filepath.Join(home, PrevDir, "main.js"))
		if err := Swap(home); err != nil {
			t.Fatalf("the new version is active even if the old backup could not be refreshed: %v", err)
		}
		if got := versionOf(t, filepath.Join(home, AddonDir)); got != "3.0.0" {
			t.Fatalf("active %s", got)
		}
		if fsutil.Exists(filepath.Join(home, OldDir)) {
			t.Fatal("addon.old left behind")
		}
	})
}

func TestRollbackFailures(t *testing.T) {
	dir := testutil.TempDir(t)
	twoVersions := func(t *testing.T, name string) string {
		t.Helper()
		home := filepath.Join(dir, name)
		stageVersion(t, home, dir, "1.0.0")
		if err := Swap(home); err != nil {
			t.Fatal(err)
		}
		stageVersion(t, home, dir, "2.0.0")
		if err := Swap(home); err != nil {
			t.Fatal(err)
		}
		return home
	}

	t.Run("no previous version", func(t *testing.T) {
		home := filepath.Join(dir, "none")
		stageVersion(t, home, dir, "1.0.0")
		_ = Swap(home)
		if err := Rollback(home); err == nil || !strings.Contains(err.Error(), "no previous version") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("the previous version is damaged", func(t *testing.T) {
		home := twoVersions(t, "damaged")
		testutil.Write(t, filepath.Join(home, PrevDir, "main.js"), []byte("tampered"))
		if err := Rollback(home); err == nil || !strings.Contains(err.Error(), "not usable") {
			t.Fatalf("%v", err)
		}
		if versionOf(t, filepath.Join(home, AddonDir)) != "2.0.0" {
			t.Fatal("the current add-on must not change")
		}
	})
	t.Run("addon.old from an earlier crash cannot be cleared", func(t *testing.T) {
		home := twoVersions(t, "oldheld")
		testutil.Write(t, filepath.Join(home, OldDir, "x.txt"), []byte("x"))
		testutil.HoldFile(t, filepath.Join(home, OldDir, "x.txt"))
		if err := Rollback(home); err == nil {
			t.Fatal("rolled back over a stale addon.old")
		}
	})
	t.Run("the current add-on cannot be moved aside", func(t *testing.T) {
		home := twoVersions(t, "inuse")
		testutil.HoldFile(t, filepath.Join(home, AddonDir, "main.js"))
		if err := Rollback(home); err == nil {
			t.Fatal("rolled back while the add-on is in use")
		}
		if versionOf(t, filepath.Join(home, AddonDir)) != "2.0.0" || versionOf(t, filepath.Join(home, PrevDir)) != "1.0.0" {
			t.Fatal("nothing may change on a failed rollback")
		}
	})
	t.Run("the previous version cannot be activated", func(t *testing.T) {
		home := twoVersions(t, "prevheld")
		testutil.HoldFile(t, filepath.Join(home, PrevDir, "main.js"))
		if err := Rollback(home); err == nil {
			t.Fatal("rolled back while the previous copy is in use")
		}
		if got := versionOf(t, filepath.Join(home, AddonDir)); got != "2.0.0" {
			t.Fatalf("the current add-on must be put back: %s", got)
		}
		if fsutil.Exists(filepath.Join(home, OldDir)) {
			t.Fatal("addon.old left behind")
		}
	})
	t.Run("there is no current add-on", func(t *testing.T) {
		home := twoVersions(t, "noaddon")
		if err := os.RemoveAll(filepath.Join(home, AddonDir)); err != nil {
			t.Fatal(err)
		}
		if err := Rollback(home); err != nil {
			t.Fatal(err)
		}
		if versionOf(t, filepath.Join(home, AddonDir)) != "1.0.0" || fsutil.Exists(filepath.Join(home, PrevDir)) {
			t.Fatal("rollback without a current add-on")
		}
	})
}

// -------------------------------------------------------------------------------------------- ReadInstalled

func TestReadInstalledDamage(t *testing.T) {
	dir := testutil.TempDir(t)
	fresh := func(name string) string {
		d := filepath.Join(dir, name)
		testutil.Payload(t, d, "0.1.0", nil)
		return d
	}
	if _, err := ReadInstalled(filepath.Join(dir, "nothing")); err == nil {
		t.Fatal("missing folder")
	}
	d := fresh("missing")
	os.Remove(filepath.Join(d, "addon.json"))
	if m, err := ReadInstalled(d); !errors.Is(err, ErrFileMismatch) || m == nil || !strings.Contains(err.Error(), "addon.json missing") {
		t.Fatalf("a missing file: %v %v (the manifest is still returned)", m, err)
	}
	d = fresh("size")
	testutil.Write(t, filepath.Join(d, "addon.json"), []byte("{}"))
	if _, err := ReadInstalled(d); !errors.Is(err, ErrFileMismatch) {
		t.Fatalf("a file with another size: %v", err)
	}
	d = fresh("content")
	b := testutil.Read(t, filepath.Join(d, "main.js"))
	testutil.Write(t, filepath.Join(d, "main.js"), bytes.ToUpper(b))
	if _, err := ReadInstalled(d); !errors.Is(err, ErrFileMismatch) || !strings.Contains(err.Error(), "main.js") {
		t.Fatalf("a file with other content: %v", err)
	}
	d = fresh("folder-manifest")
	os.Remove(filepath.Join(d, "version.json"))
	os.MkdirAll(filepath.Join(d, "version.json"), 0o755)
	if _, err := ReadInstalled(d); err == nil {
		t.Fatal("a folder as version.json")
	}
	d = fresh("badjson")
	testutil.Write(t, filepath.Join(d, "version.json"), []byte("{"))
	if _, err := ReadInstalled(d); err == nil {
		t.Fatal("broken version.json")
	}
	d = fresh("unreadable")
	testutil.LockFile(t, filepath.Join(d, "main.js"))
	if _, err := ReadInstalled(d); !errors.Is(err, ErrFileMismatch) {
		t.Fatalf("a locked file: %v", err)
	}
	d = fresh("folder-as-file")
	os.Remove(filepath.Join(d, "main.js"))
	os.MkdirAll(filepath.Join(d, "main.js"), 0o755)
	if _, err := ReadInstalled(d); !errors.Is(err, ErrFileMismatch) {
		t.Fatalf("a folder where a file should be: %v", err)
	}
	if m, err := ReadInstalled(fresh("good")); err != nil || m.Version != "0.1.0" {
		t.Fatalf("%v %v", m, err)
	}
}

func TestSameFilesIgnoresHashCase(t *testing.T) {
	a := &Manifest{Files: map[string]FileEntry{"a": {Size: 1, SHA256: strings.Repeat("ab", 32)}}}
	b := &Manifest{Files: map[string]FileEntry{"a": {Size: 1, SHA256: strings.Repeat("AB", 32)}}}
	if !SameFiles(a, b) || !SameFiles(a, a) {
		t.Fatal("hash case")
	}
	for name, other := range map[string]*Manifest{
		"other size": {Files: map[string]FileEntry{"a": {Size: 2, SHA256: strings.Repeat("ab", 32)}}},
		"other name": {Files: map[string]FileEntry{"b": {Size: 1, SHA256: strings.Repeat("ab", 32)}}},
		"more files": {Files: map[string]FileEntry{"a": {Size: 1, SHA256: strings.Repeat("ab", 32)}, "c": {}}},
		"other hash": {Files: map[string]FileEntry{"a": {Size: 1, SHA256: strings.Repeat("cd", 32)}}},
		"none":       {},
	} {
		if SameFiles(a, other) {
			t.Errorf("%s: reported equal", name)
		}
	}
}
