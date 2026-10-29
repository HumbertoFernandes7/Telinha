// SPDX-License-Identifier: GPL-3.0-or-later

package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/fsutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/payload"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winproc"
)

// Files that are locked or read-only stand in for "Discord is still holding it" / "antivirus is scanning
// it": the retries of fsutil would make every such test wait seconds.
func init() { fsutil.RetryDelay = time.Millisecond }

func (e *env) logged(t *testing.T, sub string) {
	t.Helper()
	if !strings.Contains(e.logBuf.String(), sub) {
		t.Errorf("log lacks %q:\n%s", sub, e.logBuf.String())
	}
}

func (e *env) code(t *testing.T, err error, want string) *Problem {
	t.Helper()
	if err == nil {
		t.Fatalf("no error, want a %s problem", want)
	}
	p := AsProblem(err)
	if p.Code != want {
		t.Fatalf("problem %s (%v), want %s", p.Code, err, want)
	}
	return p
}

// readOnly makes path read-only (a rename over it fails with access denied) until the end of the test.
func readOnly(t *testing.T, path string) {
	t.Helper()
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(path, 0o666) })
}

// ------------------------------------------------------------------------------------------------ core.go

func TestConfigLoggingWithoutALogger(t *testing.T) {
	c := &Config{AppData: `C:\x`}
	c.logf("nobody listens %d", 1) // must not panic
	l := c.logger()
	if l == nil || c.Log != l || c.logger() != l {
		t.Fatal("logger() must create one discarding logger and keep it")
	}
	l.Printf("still fine")
	mine := log.New(io.Discard, "", 0)
	c = &Config{Log: mine}
	if c.logger() != mine {
		t.Fatal("logger() replaced the configured one")
	}
}

func TestConfigPaths(t *testing.T) {
	c := &Config{AppData: `C:\Users\a\AppData\Roaming`}
	if got := c.OfficialPatchers(); len(got) != 1 || got[0] != `C:\Users\a\AppData\Roaming\Vencord\dist\patcher.js` {
		t.Fatalf("patchers %v", got)
	}
	c.VencordDataDir = `D:\data`
	if got := c.OfficialPatchers(); len(got) != 2 || got[1] != `D:\data\dist\patcher.js` {
		t.Fatalf("with VENCORD_USER_DATA_DIR: %v", got)
	}
	if c.Home() != `C:\Users\a\AppData\Roaming\Telinha` || c.AddonDir() != c.Home()+`\addon` || c.RecordPath() != c.Home()+`\install.json` {
		t.Fatalf("home %s addon %s record %s", c.Home(), c.AddonDir(), c.RecordPath())
	}
	if got := c.BackupPath(discord.FromDir(`C:\L\DiscordPTB`), "app-1.0.1"); got != c.Home()+`\backup\DiscordPTB\app-1.0.1.app.asar` {
		t.Fatalf("backup %s", got)
	}
}

func TestVencordInTheCustomDataDirIsOfficial(t *testing.T) {
	e := newEnv(t)
	dataDir := filepath.Join(e.dir, "vdata")
	other := testutil.Vencord(t, dataDir)
	testutil.Write(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"), asar.VencordStub(other))
	if _, err := e.cfg.Preflight(); err == nil {
		t.Fatal("a Vencord outside %APPDATA% was accepted without VENCORD_USER_DATA_DIR")
	}
	e.cfg.VencordDataDir = filepath.Join(dataDir, "Vencord") // the folder that holds dist
	if _, err := e.cfg.Preflight(); err != nil {
		t.Fatalf("VENCORD_USER_DATA_DIR: %v", err)
	}
}

func TestProblemAndAsProblem(t *testing.T) {
	inner := errors.New("disk on fire")
	p := &Problem{Code: CodeFailed, Msg: "Não deu"}
	if p.Error() != "Não deu" || p.Unwrap() != nil {
		t.Fatalf("%q %v", p.Error(), p.Unwrap())
	}
	p = &Problem{Code: CodePayload, Msg: "Não deu", Err: inner}
	if p.Error() != "Não deu (disk on fire)" || !errors.Is(p, inner) {
		t.Fatalf("%q", p.Error())
	}
	if got := AsProblem(fmt.Errorf("wrapped: %w", p)); got != p {
		t.Fatalf("a wrapped problem must come back as itself: %+v", got)
	}
	got := AsProblem(inner)
	if got.Code != CodeFailed || got.Msg == "" || got.Err != inner {
		t.Fatalf("a plain error becomes a generic failure: %+v", got)
	}
}

func TestRunningProcessesEdgeCases(t *testing.T) {
	e := newEnv(t)
	root := filepath.Join(e.local, "Discord")
	// no process table at all
	e.cfg.Procs = nil
	if ps, err := e.cfg.RunningProcesses(); ps != nil || err != nil {
		t.Fatalf("nil table: %v %v", ps, err)
	}
	e.cfg.Procs = e.procs

	// the process table fails
	failing := &testutil.FakeProcs{ListErr: errors.New("snapshot failed")}
	e.cfg.Procs = failing
	if _, err := e.cfg.RunningProcesses(); err == nil {
		t.Fatal("List error swallowed")
	}
	// Apply carries on when it cannot tell (the stub write will fail by itself if Discord really holds the file)
	e.install("0.1.0")
	e.logged(t, "listing processes failed: snapshot failed")

	// overridden: only the processes that run from the fake folders count, case-insensitively
	e.cfg.Procs = &testutil.FakeProcs{Procs: []winproc.Process{
		{PID: 1, Name: "DISCORD.EXE", Path: strings.ToUpper(filepath.Join(root, "app-1.0.9266", "Discord.exe"))},
		{PID: 2, Name: "Discord.exe", Path: filepath.Join(e.dir, "Elsewhere", "Discord.exe")},
		{PID: 3, Name: "Discord.exe", Path: root + "-other\\app-1\\Discord.exe"}, // sibling folder with the same prefix
		{PID: 4, Name: "Discord.exe", Path: root},                                // the folder itself is not "under" it
	}}
	e.cfg.Overridden = true
	ps, err := e.cfg.RunningProcesses()
	if err != nil || len(ps) != 1 || ps[0].PID != 1 {
		t.Fatalf("overridden: %+v %v", ps, err)
	}
}

func TestCloseDiscordEdgeCases(t *testing.T) {
	e := newEnv(t)
	if err := e.cfg.CloseDiscord(nil); err != nil || e.procs.closed != nil {
		t.Fatalf("nothing to close: %v %v", err, e.procs.closed)
	}
	discordExe := filepath.Join(e.local, "Discord", "app-1.0.9266", "Discord.exe")

	// Close reports an error but the process is gone anyway: that is a success
	fake := &testutil.FakeProcs{CloseErr: errors.New("one handle was busy"), Procs: []winproc.Process{{PID: 5, Name: "Discord.exe", Path: discordExe}}}
	e.cfg.Procs = fake
	ps, _ := e.cfg.RunningProcesses()
	if err := e.cfg.CloseDiscord(ps); err != nil {
		t.Fatalf("%v", err)
	}
	e.logged(t, "close: one handle was busy")
	e.logged(t, "closing 1 process(es): Discord.exe(5)")

	// the table cannot be read after the close
	fake = &testutil.FakeProcs{Procs: []winproc.Process{{PID: 6, Name: "Discord.exe", Path: discordExe}}}
	e.cfg.Procs = &failAfterClose{FakeProcs: fake}
	ps = []winproc.Process{{PID: 6, Name: "Discord.exe", Path: discordExe}}
	if err := e.cfg.CloseDiscord(ps); err == nil || !strings.Contains(err.Error(), "table gone") {
		t.Fatalf("got %v", err)
	}
}

// failAfterClose: the table is readable until Close ran, then listing fails.
type failAfterClose struct {
	*testutil.FakeProcs
}

func (f *failAfterClose) List() ([]winproc.Process, error) {
	if f.CloseCalls > 0 {
		return nil, errors.New("table gone")
	}
	return f.FakeProcs.List()
}

// ----------------------------------------------------------------------------------------------- scan.go

func TestScanStatesAndPreflightMessages(t *testing.T) {
	cases := map[string]struct {
		mutate func(e *env)
		state  State
		msg    string
	}{
		"no app folder":   {func(e *env) { os.RemoveAll(filepath.Join(e.local, "Discord", "app-1.0.9266")) }, StateNoApp, "não está instalado"},
		"patcher missing": {func(e *env) { os.RemoveAll(filepath.Join(e.appdata, "Vencord")) }, StatePatcherMissing, "arquivos dele sumiram"},
		"custom vencord": {func(e *env) {
			other := testutil.Vencord(t, filepath.Join(e.dir, "dev"))
			testutil.Write(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"), asar.VencordStub(other))
		}, StateCustomVencord, "fora da pasta padrão"},
		"other mod": {func(e *env) {
			testutil.Write(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"), asar.BuildStub(`require("C:\\bd\\injector.js");`))
		}, StateUnknown, "modificado por outro programa"},
		"vanilla": {func(e *env) {
			os.RemoveAll(filepath.Join(e.local, "Discord"))
			testutil.DiscordVanilla(t, filepath.Join(e.local, "Discord"), "app-1.0.9266")
		}, StateNoVencord, "não está instalado no seu Discord"},
		"no _app.asar": {func(e *env) { os.Remove(filepath.Join(e.res("Discord", "app-1.0.9266"), "_app.asar")) }, StateNoVencord, "não está instalado no seu Discord"},
		"our stub without a patcher line": {func(e *env) {
			testutil.Write(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"), asar.BuildStub("// Telinha stub v1\n// no paths\n"))
		}, StateUnknown, "modificado por outro programa"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			c.mutate(e)
			targets := e.cfg.Scan()
			if len(targets) != 1 || targets[0].State != c.state || targets[0].Detail == "" || targets[0].Ready() {
				t.Fatalf("scan: %+v", targets)
			}
			_, err := e.cfg.Preflight()
			p := e.code(t, err, CodeNoVencord)
			if !strings.Contains(p.Msg, c.msg) {
				t.Fatalf("message %q lacks %q", p.Msg, c.msg)
			}
			if p.Err == nil || !strings.Contains(p.Err.Error(), "Discord") {
				t.Fatalf("the details must name the Discord that failed: %v", p.Err)
			}
			if _, err := e.cfg.Apply(nil, targets); err == nil {
				t.Fatal("Apply accepted a target that is not ready")
			}
		})
	}
}

// Target.Ready does not exist on Target; the helper keeps the table above readable.
func (t Target) Ready() bool { return t.State == StateReady }

func TestStatusViews(t *testing.T) {
	e := newEnv(t)
	s := e.cfg.Status()
	if s.Installed() || len(s.Ready()) != 1 || s.Payload != nil || s.PayloadError != "" || s.PreviousReady || s.Record != nil || len(s.Running) != 0 {
		t.Fatalf("fresh status: %+v", s)
	}
	e.install("0.1.0")
	s = e.cfg.Status()
	if !s.Installed() || len(s.Ready()) != 1 || s.Payload == nil || s.Record == nil {
		t.Fatalf("installed status: %+v", s)
	}
	// a Discord that is not ready is listed but not offered
	testutil.DiscordVanilla(t, filepath.Join(e.local, "DiscordPTB"), "app-1.0.1")
	e.rescan()
	s = e.cfg.Status()
	if len(s.Targets) != 2 || len(s.Ready()) != 1 || s.Ready()[0].Name != "Discord" {
		t.Fatalf("targets %+v", s.Targets)
	}
	// processes are reported
	e.procs.list = []winproc.Process{{PID: 9, Name: "Discord.exe"}}
	if s = e.cfg.Status(); len(s.Running) != 1 || s.Running[0].PID != 9 {
		t.Fatalf("running %+v", s.Running)
	}
}

func TestStatusReportsDamage(t *testing.T) {
	e := newEnv(t)
	e.install("0.1.0")
	e.install("0.2.0")
	// the installed files no longer match version.json
	testutil.Write(t, filepath.Join(e.cfg.AddonDir(), "main.js"), []byte("tampered"))
	// the previous version is damaged too
	testutil.Write(t, filepath.Join(e.cfg.Home(), payload.PrevDir, "main.js"), []byte("tampered"))
	// install.json is garbage
	testutil.Write(t, e.cfg.RecordPath(), []byte("{not json"))
	s := e.cfg.Status()
	if s.Payload == nil || s.PayloadError == "" || !strings.Contains(s.PayloadError, "main.js") {
		t.Fatalf("payload damage: %+v", s)
	}
	if s.PreviousReady {
		t.Fatal("a damaged previous version is not a rollback target")
	}
	if s.Record != nil {
		t.Fatalf("garbage install.json: %+v", s.Record)
	}
	if e.cfg.PayloadOK() {
		t.Fatal("PayloadOK on a tampered payload")
	}
	if _, err := e.cfg.Rollback(); AsProblem(err).Code != CodeFailed {
		t.Fatalf("rollback to a damaged copy: %v", err)
	}
}

func TestReadRecordErrors(t *testing.T) {
	e := newEnv(t)
	if r, err := e.cfg.ReadRecord(); r != nil || err != nil {
		t.Fatalf("no install.json: %v %v", r, err)
	}
	testutil.Write(t, e.cfg.RecordPath(), []byte("{broken"))
	if r, err := e.cfg.ReadRecord(); r != nil || err == nil || !strings.Contains(err.Error(), "install.json") {
		t.Fatalf("garbage: %v %v", r, err)
	}
	os.Remove(e.cfg.RecordPath())
	if err := os.MkdirAll(e.cfg.RecordPath(), 0o755); err != nil { // a folder where the file should be: unreadable
		t.Fatal(err)
	}
	if r, err := e.cfg.ReadRecord(); r != nil || err == nil {
		t.Fatalf("folder as install.json: %v %v", r, err)
	}
	if err := e.cfg.writeRecord(&Record{Version: "1"}); err == nil {
		t.Fatal("wrote install.json over a folder")
	}
}

func TestInstallJSONFailureDoesNotStopTheInstall(t *testing.T) {
	e := newEnv(t)
	if err := os.MkdirAll(e.cfg.RecordPath(), 0o755); err != nil { // install.json cannot be written
		t.Fatal(err)
	}
	r := e.install("0.1.0")
	if len(r.Targets) != 1 {
		t.Fatalf("%+v", r)
	}
	e.logged(t, "install.json: ")
	if k := discord.Inspect(e.res("Discord", "app-1.0.9266")).Kind; k != discord.KindTelinhaStub {
		t.Fatalf("stub %s", k)
	}
}

// -------------------------------------------------------------------------------------------- Stage (local)

func TestStageLocalFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("the Telinha folder cannot be created", func(t *testing.T) {
		e := newEnv(t)
		testutil.Write(t, e.cfg.Home(), []byte("a file where the folder should go"))
		_, err := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0")}, nil)
		e.code(t, err, CodeFailed)
	})
	t.Run("the zip is held by another program", func(t *testing.T) {
		e := newEnv(t)
		z := filepath.Join(e.dir, "p.zip")
		testutil.Zip(t, e.payload("0.1.0"), z, nil)
		testutil.LockFile(t, z)
		_, err := e.cfg.Stage(ctx, PayloadSource{Local: z}, nil)
		p := e.code(t, err, CodePayload)
		if !strings.Contains(p.Msg, "ler o pacote") {
			t.Fatalf("message %q", p.Msg)
		}
	})
	t.Run("there is no such file", func(t *testing.T) {
		e := newEnv(t)
		_, err := e.cfg.Stage(ctx, PayloadSource{Local: filepath.Join(e.dir, "missing.zip")}, nil)
		p := e.code(t, err, CodePayload)
		if !strings.Contains(p.Msg, "incompleto ou corrompido") {
			t.Fatalf("message %q", p.Msg)
		}
	})
	t.Run("the payload needs a newer installer", func(t *testing.T) {
		e := newEnv(t)
		dir := filepath.Join(e.dir, "future")
		testutil.Write(t, filepath.Join(dir, "version.json"), []byte(`{"payloadFormat":2,"stubFormat":1}`))
		_, err := e.cfg.Stage(ctx, PayloadSource{Local: dir}, nil)
		p := e.code(t, err, CodePayload)
		if !errors.Is(err, payload.ErrTooNew) || !strings.Contains(p.Msg, "instalador mais novo") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("a payload folder is staged without a hash check", func(t *testing.T) {
		e := newEnv(t)
		st, err := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0"), SHA256: strings.Repeat("0", 64)}, nil)
		if err != nil || st.Source.Kind != "local" || st.Source.SHA256 != "" {
			t.Fatalf("a folder has no zip hash to compare: %+v %v", st, err)
		}
	})
	t.Run("files outside version.json are ignored and logged", func(t *testing.T) {
		e := newEnv(t)
		z := filepath.Join(e.dir, "p.zip")
		testutil.Zip(t, e.payload("0.1.0"), z, map[string]string{"extra.txt": "not listed"})
		if _, err := e.cfg.Stage(ctx, PayloadSource{Local: z}, nil); err != nil {
			t.Fatal(err)
		}
		e.logged(t, "ignored files not listed in version.json: [extra.txt]")
		if _, err := os.Stat(filepath.Join(e.cfg.Home(), payload.NewDir, "extra.txt")); err == nil {
			t.Fatal("an unlisted file was extracted")
		}
	})
	t.Run("discard", func(t *testing.T) {
		e := newEnv(t)
		if _, err := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0")}, nil); err != nil {
			t.Fatal(err)
		}
		if !fsutil.IsDir(filepath.Join(e.cfg.Home(), payload.NewDir)) {
			t.Fatal("nothing staged")
		}
		e.cfg.DiscardStaged()
		if fsutil.Exists(filepath.Join(e.cfg.Home(), payload.NewDir)) {
			t.Fatal("staged payload survived DiscardStaged")
		}
		e.cfg.DiscardStaged() // nothing there: fine
	})
}

// ------------------------------------------------------------------------------------------ Stage (GitHub)

// fakeGitHub serves releases/latest and what hangs off it. Zero values are the healthy release.
type fakeGitHub struct {
	srv *httptest.Server

	zipName, zipData string
	digest           string            // asset digest ("" = none published)
	notes            string            // release body
	latestStatus     int               // releases/latest answers this instead of 200
	zipStatus        int               // the zip download answers this instead of 200
	zipTruncate      bool              // the zip download ends early
	extra            map[string]string // extra assets: name -> content
	extraStatus      int               // status of the extra assets' downloads
	prerelease       bool
}

func newFakeGitHub(t *testing.T, e *env, version string) *fakeGitHub {
	t.Helper()
	z := filepath.Join(e.dir, "Telinha-addon-abcdef12.zip")
	testutil.Zip(t, e.payload(version), z, nil)
	g := &fakeGitHub{zipName: filepath.Base(z), zipData: string(testutil.Read(t, z)), extra: map[string]string{}}
	g.srv = httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGitHub) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/repos/"+payload.RepoOwner+"/"+payload.RepoName+"/releases/latest":
		if g.latestStatus != 0 {
			http.Error(w, "nope", g.latestStatus)
			return
		}
		assets := []map[string]any{{"name": g.zipName, "size": len(g.zipData), "digest": g.digest, "browser_download_url": g.srv.URL + "/dl/" + g.zipName}}
		for name, content := range g.extra {
			assets = append(assets, map[string]any{"name": name, "size": len(content), "browser_download_url": g.srv.URL + "/dl/" + name})
		}
		json.NewEncoder(w).Encode(map[string]any{"tag_name": "v0.1.0", "prerelease": g.prerelease, "published_at": "2026-10-29T00:00:00Z", "body": g.notes, "assets": assets})
	case r.URL.Path == "/dl/"+g.zipName:
		if g.zipStatus != 0 {
			http.Error(w, "nope", g.zipStatus)
			return
		}
		if g.zipTruncate {
			w.Write([]byte(g.zipData[:len(g.zipData)/2]))
			return
		}
		w.Write([]byte(g.zipData))
	case strings.HasPrefix(r.URL.Path, "/dl/"):
		if g.extraStatus != 0 {
			http.Error(w, "nope", g.extraStatus)
			return
		}
		io.WriteString(w, g.extra[strings.TrimPrefix(r.URL.Path, "/dl/")])
	default:
		http.NotFound(w, r)
	}
}

func (g *fakeGitHub) source() PayloadSource {
	c := payload.NewClient("test")
	c.APIBase = g.srv.URL
	return PayloadSource{Client: c}
}

func TestStageFromGitHubFailures(t *testing.T) {
	ctx := context.Background()
	zipSum := func(g *fakeGitHub) string {
		h := sha256sum(g.zipData)
		return h
	}
	cases := []struct {
		name    string
		prepare func(g *fakeGitHub, e *env)
		code    string
		msg     string // part of the user message
		is      error
	}{
		{"nothing published yet", func(g *fakeGitHub, e *env) { g.latestStatus = 404 }, CodePayload, "Ainda não há uma versão", payload.ErrNoRelease},
		{"only a pre-release", func(g *fakeGitHub, e *env) { g.prerelease = true }, CodePayload, "Ainda não há uma versão", payload.ErrNoRelease},
		{"GitHub is down", func(g *fakeGitHub, e *env) { g.latestStatus = 500 }, CodePayload, "falar com o GitHub", nil},
		{"the sha256 asset cannot be fetched", func(g *fakeGitHub, e *env) {
			g.extra["Telinha-addon-abcdef12.zip.sha256"] = "x"
			g.extraStatus = 500
		}, CodePayload, "Não foi possível baixar o Telinha", nil},
		{"the sha256 asset has no hash for the zip", func(g *fakeGitHub, e *env) {
			g.extra["Telinha-addon-abcdef12.zip.sha256"] = "no hash in here\n"
		}, CodePayload, "Não foi possível baixar o Telinha", nil},
		{"the download fails", func(g *fakeGitHub, e *env) { g.zipStatus = 502 }, CodePayload, "download do Telinha falhou", nil},
		{"the download is cut short", func(g *fakeGitHub, e *env) { g.zipTruncate = true }, CodePayload, "download do Telinha falhou", nil},
		{"the download is not a payload", func(g *fakeGitHub, e *env) { g.zipData = "this is not a zip" }, CodePayload, "incompleto ou corrompido", nil},
		{"the published version.json describes other files", func(g *fakeGitHub, e *env) {
			other := testutil.Payload(t, filepath.Join(e.dir, "other"), "9.9.9", map[string]string{"extra.js": "x"})
			b, _ := json.Marshal(other)
			g.extra["version.json"] = string(b)
		}, CodePayload, "não confere com o version.json publicado", nil},
		{"a hash in the release notes disagrees", func(g *fakeGitHub, e *env) {
			g.notes = "SHA-256 (Telinha-addon-abcdef12.zip) = " + strings.Repeat("1", 64)
		}, CodePayload, "não confere com o publicado", payload.ErrChecksum},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			g := newFakeGitHub(t, e, "0.1.0")
			c.prepare(g, e)
			_, err := e.cfg.Stage(ctx, g.source(), nil)
			p := e.code(t, err, c.code)
			if !strings.Contains(p.Msg, c.msg) {
				t.Fatalf("message %q lacks %q", p.Msg, c.msg)
			}
			if c.is != nil && !errors.Is(err, c.is) {
				t.Fatalf("%v is not %v", err, c.is)
			}
			if fsutil.Exists(filepath.Join(e.cfg.Home(), "download.zip.tmp")) {
				t.Fatal("the downloaded file was left behind")
			}
			if fsutil.Exists(e.cfg.AddonDir()) {
				t.Fatal("a failed download installed something")
			}
		})
	}

	t.Run("a published version.json that matches is accepted", func(t *testing.T) {
		e := newEnv(t)
		g := newFakeGitHub(t, e, "0.1.0")
		b, _ := os.ReadFile(filepath.Join(e.payload("0.1.0"), "version.json"))
		g.extra["version.json"] = string(b)
		g.digest = "sha256:" + zipSum(g)
		g.extra["Telinha-addon-abcdef12.zip.sha256"] = zipSum(g) + "  Telinha-addon-abcdef12.zip\n"
		var steps []string
		st, err := e.cfg.Stage(ctx, g.source(), func(s string) { steps = append(steps, s) })
		if err != nil || st.Manifest.Version != "0.1.0" || st.Source.Release != "v0.1.0" {
			t.Fatalf("%+v %v", st, err)
		}
		if len(steps) != 3 || !strings.Contains(steps[0], "Procurando") || !strings.Contains(steps[1], "Baixando o Telinha v0.1.0") || !strings.Contains(steps[2], "Verificando") {
			t.Fatalf("progress lines: %q", steps)
		}
		e.logged(t, "payload: expected sha256 "+zipSum(g)+" (GitHub (digest do asset))")
		e.logged(t, "(Telinha-addon-abcdef12.zip.sha256)")
	})

	t.Run("no published checksum at all is a warning, not a failure", func(t *testing.T) {
		e := newEnv(t)
		g := newFakeGitHub(t, e, "0.1.0")
		if _, err := e.cfg.Stage(ctx, g.source(), nil); err != nil {
			t.Fatal(err)
		}
		e.logged(t, "WARNING no published checksum for Telinha-addon-abcdef12.zip")
	})

	t.Run("an identical payload is not swapped again", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		g := newFakeGitHub(t, e, "0.1.0")
		st, err := e.cfg.Stage(ctx, g.source(), nil)
		if err != nil || !st.UpToDate {
			t.Fatalf("%+v %v", st, err)
		}
	})
}

func sha256sum(s string) string {
	dir, _ := os.MkdirTemp("", "tls")
	defer os.RemoveAll(dir)
	p := filepath.Join(dir, "f")
	os.WriteFile(p, []byte(s), 0o644)
	sum, _ := payload.FileSHA256(p)
	return sum
}

// ----------------------------------------------------------------------------------------------- Apply

func TestApplyFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("the staged payload vanished before the swap", func(t *testing.T) {
		e := newEnv(t)
		ready, _ := e.cfg.Preflight()
		st, err := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0")}, nil)
		if err != nil {
			t.Fatal(err)
		}
		e.cfg.DiscardStaged()
		_, err = e.cfg.Apply(st, ready)
		p := e.code(t, err, CodeFailed)
		if !strings.Contains(p.Msg, "instalar os arquivos") {
			t.Fatalf("%q", p.Msg)
		}
	})
	t.Run("repair finds an incomplete install", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		os.Remove(filepath.Join(e.cfg.AddonDir(), "addon.json"))
		ready, _ := e.cfg.Preflight()
		_, err := e.cfg.Apply(nil, ready)
		p := e.code(t, err, CodePayload)
		if !strings.Contains(p.Msg, "incompletos") {
			t.Fatalf("%q", p.Msg)
		}
	})
	t.Run("nothing to apply to", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		r, err := e.cfg.Apply(nil, nil)
		if err != nil || len(r.Targets) != 0 || len(r.Unchanged) != 0 {
			t.Fatalf("%+v %v", r, err)
		}
		e.logged(t, "apply: begin, targets=none")
		e.logged(t, "payload=keep the installed one")
	})
	t.Run("one Discord fails, the others are still done", func(t *testing.T) {
		e := newEnv(t)
		testutil.DiscordVanilla(t, filepath.Join(e.local, "DiscordCanary"), "app-1.0.500")
		e.rescan()
		ready, _ := e.cfg.Preflight()
		st, _ := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0")}, nil)
		res, err := e.cfg.Apply(st, append(ready, e.cfg.Scan()[1])) // the Canary is not ready: asked anyway
		p := e.code(t, err, CodeFailed)
		if res == nil || len(res.Targets) != 1 || res.Targets[0].Flavor != "Discord" {
			t.Fatalf("the good target must be reported: %+v", res)
		}
		if !strings.Contains(p.Err.Error(), "Discord Canary: not ready (no-vencord)") {
			t.Fatalf("details: %v", p.Err)
		}
		rec, _ := e.cfg.ReadRecord()
		if rec == nil || len(rec.Targets) != 1 {
			t.Fatalf("only the target that worked is recorded: %+v", rec)
		}
		e.logged(t, "apply Discord Canary: not ready")
	})
	t.Run("Discord is running", func(t *testing.T) {
		e := newEnv(t)
		e.procs.list = []winproc.Process{{PID: 1, Name: "Discord.exe"}}
		ready, _ := e.cfg.Preflight()
		_, err := e.cfg.Apply(nil, ready)
		e.code(t, err, CodeDiscordRunning)
		e.logged(t, "apply: refused")
	})
}

func TestApplyOneFailures(t *testing.T) {
	ctx := context.Background()
	// a payload whose stub template has the placeholders and is big: the stub it renders does not fit
	// Discord's "small stub" rule, so the check after writing refuses it
	hugeTemplate := testutil.StubTemplate(t) + "\n// " + strings.Repeat("x", discord.MaxStubSize+10)

	t.Run("the stub template is broken", func(t *testing.T) {
		e := newEnv(t)
		bad := filepath.Join(e.dir, "badtemplate")
		testutil.Payload(t, bad, "0.1.0", map[string]string{"stub-template.js": "// Telinha stub v1\nno placeholders\n"})
		ready, _ := e.cfg.Preflight()
		st, err := e.cfg.Stage(ctx, PayloadSource{Local: bad}, nil)
		if err != nil {
			t.Fatal(err)
		}
		before := testutil.Read(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"))
		_, err = e.cfg.Apply(st, ready)
		e.code(t, err, CodeFailed)
		if !strings.Contains(err.Error(), "placeholder") {
			t.Fatalf("%v", err)
		}
		if !bytes.Equal(before, testutil.Read(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"))) {
			t.Fatal("app.asar changed although the template was broken")
		}
	})
	t.Run("the check after writing fails", func(t *testing.T) {
		e := newEnv(t)
		big := filepath.Join(e.dir, "bigtemplate")
		testutil.Payload(t, big, "0.1.0", map[string]string{"stub-template.js": hugeTemplate})
		ready, _ := e.cfg.Preflight()
		st, err := e.cfg.Stage(ctx, PayloadSource{Local: big}, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, err = e.cfg.Apply(st, ready)
		e.code(t, err, CodeFailed)
		if !strings.Contains(err.Error(), "verification failed after writing") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("the backup folder cannot be created", func(t *testing.T) {
		e := newEnv(t)
		testutil.Write(t, filepath.Join(e.cfg.Home(), "backup"), []byte("a file where the folder should go"))
		ready, _ := e.cfg.Preflight()
		st, _ := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0")}, nil)
		_, err := e.cfg.Apply(st, ready)
		e.code(t, err, CodeFailed)
		if k := discord.Inspect(e.res("Discord", "app-1.0.9266")).Kind; k != discord.KindVencordStub {
			t.Fatalf("Vencord's stub must stay when its backup could not be made: %s", k)
		}
	})
	t.Run("the backup cannot be written", func(t *testing.T) {
		e := newEnv(t)
		bp := e.cfg.BackupPath(e.cfg.Installs[0], "app-1.0.9266")
		if err := os.MkdirAll(bp, 0o755); err != nil { // a folder where the backup file goes
			t.Fatal(err)
		}
		ready, _ := e.cfg.Preflight()
		st, _ := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0")}, nil)
		_, err := e.cfg.Apply(st, ready)
		e.code(t, err, CodeFailed)
		if !strings.Contains(err.Error(), "backup:") {
			t.Fatalf("%v", err)
		}
		if k := discord.Inspect(e.res("Discord", "app-1.0.9266")).Kind; k != discord.KindVencordStub {
			t.Fatalf("stub %s", k)
		}
	})
	t.Run("app.asar cannot be replaced", func(t *testing.T) {
		e := newEnv(t)
		appAsar := filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar")
		before := testutil.Read(t, appAsar)
		readOnly(t, appAsar)
		ready, _ := e.cfg.Preflight()
		st, _ := e.cfg.Stage(ctx, PayloadSource{Local: e.payload("0.1.0")}, nil)
		_, err := e.cfg.Apply(st, ready)
		e.code(t, err, CodeFailed)
		if !strings.Contains(err.Error(), "writing "+appAsar) {
			t.Fatalf("%v", err)
		}
		if !bytes.Equal(before, testutil.Read(t, appAsar)) || fsutil.Exists(appAsar+".telinha-tmp") {
			t.Fatal("app.asar changed or a temp file was left")
		}
	})
}

// ------------------------------------------------------------------------------------------ Uninstall

func TestUninstallFailures(t *testing.T) {
	t.Run("Discord is running", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		e.procs.list = []winproc.Process{{PID: 1, Name: "Discord.exe"}}
		res, err := e.cfg.Uninstall()
		e.code(t, err, CodeDiscordRunning)
		if res != nil || !e.cfg.PayloadOK() {
			t.Fatalf("uninstall touched things while Discord ran: %+v", res)
		}
		e.logged(t, "uninstall: refused")
	})
	t.Run("our stub has no Vencord path to go back to", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		appAsar := filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar")
		testutil.Write(t, appAsar, asar.BuildStub("// Telinha stub v1\nconst TELINHA_LOADER = \"x\";\n"))
		res, err := e.cfg.Uninstall()
		p := e.code(t, err, CodeFailed)
		if !strings.Contains(p.Err.Error(), "no readable VENCORD_PATCHER") || len(res.Restored) != 0 {
			t.Fatalf("%v %+v", p.Err, res)
		}
		if !e.cfg.PayloadOK() {
			t.Fatal("the add-on must be kept when a stub could not be restored (the stub still points at it)")
		}
		e.logged(t, "uninstall Discord app-1.0.9266")
	})
	t.Run("the stub cannot be written back", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		readOnly(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"))
		_, err := e.cfg.Uninstall()
		e.code(t, err, CodeFailed)
		if !e.cfg.PayloadOK() {
			t.Fatal("the add-on was removed although the stub still points at it")
		}
	})
	t.Run("a file of the add-on cannot be deleted", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		testutil.LockFile(t, filepath.Join(e.cfg.AddonDir(), "main.js"))
		res, err := e.cfg.Uninstall()
		p := e.code(t, err, CodeFailed)
		if !strings.Contains(p.Msg, "alguns arquivos do Telinha não puderam ser apagados") {
			t.Fatalf("%q", p.Msg)
		}
		if len(res.Restored) != 1 {
			t.Fatalf("the stub must be back even if the files could not be deleted: %+v", res)
		}
		if k := discord.Inspect(e.res("Discord", "app-1.0.9266")).Kind; k != discord.KindVencordStub {
			t.Fatalf("stub %s", k)
		}
		e.logged(t, "uninstall: removing")
		// the other folders were still cleaned up
		if fsutil.Exists(filepath.Join(e.cfg.Home(), "backup")) || fsutil.Exists(e.cfg.RecordPath()) {
			t.Fatal("backup / install.json should have been removed")
		}
	})
	t.Run("nothing installed", func(t *testing.T) {
		e := newEnv(t)
		res, err := e.cfg.Uninstall()
		if err != nil || len(res.Restored) != 0 {
			t.Fatalf("%+v %v", res, err)
		}
	})
}

// ------------------------------------------------------------------------------------------- Rollback

func TestRollbackFailures(t *testing.T) {
	t.Run("Discord is running", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		e.install("0.2.0")
		e.procs.list = []winproc.Process{{PID: 1, Name: "Discord.exe"}}
		_, err := e.cfg.Rollback()
		e.code(t, err, CodeDiscordRunning)
		if m, _ := payload.ReadInstalled(e.cfg.AddonDir()); m.Version != "0.2.0" {
			t.Fatalf("rolled back while Discord ran: %s", m.Version)
		}
	})
	t.Run("there is no previous version", func(t *testing.T) {
		e := newEnv(t)
		e.install("0.1.0")
		_, err := e.cfg.Rollback()
		p := e.code(t, err, CodeFailed)
		if !strings.Contains(p.Msg, "Não há uma versão anterior") {
			t.Fatalf("%q", p.Msg)
		}
	})
}
