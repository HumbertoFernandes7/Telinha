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
	"github.com/HumbertoFernandes7/Telinha/installer/internal/payload"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winproc"
)

// fakeProcs is a process table; Close "kills" what it is asked to.
type fakeProcs struct {
	list   []winproc.Process
	closed []uint32
	stuck  bool // processes survive Close
}

func (f *fakeProcs) List() ([]winproc.Process, error) { return f.list, nil }
func (f *fakeProcs) Close(ps []winproc.Process, _ time.Duration) error {
	if f.stuck {
		return errors.New("access denied")
	}
	kill := map[uint32]bool{}
	for _, p := range ps {
		kill[p.PID] = true
		f.closed = append(f.closed, p.PID)
	}
	var left []winproc.Process
	for _, p := range f.list {
		if !kill[p.PID] {
			left = append(left, p)
		}
	}
	f.list = left
	return nil
}

type env struct {
	t        *testing.T
	dir      string
	appdata  string
	local    string
	patcher  string
	cfg      *Config
	procs    *fakeProcs
	payloadV map[string]string // version -> payload folder
	logBuf   *bytes.Buffer
}

// newEnv: fake %APPDATA% with official Vencord, fake %LOCALAPPDATA%\Discord with Vencord's stub.
func newEnv(t *testing.T) *env {
	dir := testutil.TempDir(t)
	e := &env{t: t, dir: dir, appdata: filepath.Join(dir, "Roaming"), local: filepath.Join(dir, "Local"), procs: &fakeProcs{}, payloadV: map[string]string{}, logBuf: &bytes.Buffer{}}
	e.patcher = testutil.Vencord(t, e.appdata)
	testutil.DiscordWithVencord(t, filepath.Join(e.local, "Discord"), "app-1.0.9266", e.patcher)
	e.cfg = &Config{AppData: e.appdata, Procs: e.procs, Log: log.New(io.MultiWriter(e.logBuf), "", 0), InstallerVersion: "test"}
	e.rescan()
	return e
}

func (e *env) rescan() { e.cfg.Installs = discord.Find(e.local) }

func (e *env) payload(version string) string {
	if p, ok := e.payloadV[version]; ok {
		return p
	}
	p := filepath.Join(e.dir, "payload-"+version)
	testutil.Payload(e.t, p, version, map[string]string{"telinha.renderer.js": "// renderer " + version})
	e.payloadV[version] = p
	return p
}

func (e *env) res(flavor, app string) string { return filepath.Join(e.local, flavor, app, "resources") }

func (e *env) install(version string) *Result {
	e.t.Helper()
	ready, err := e.cfg.Preflight()
	if err != nil {
		e.t.Fatal(err)
	}
	st, err := e.cfg.Stage(context.Background(), PayloadSource{Local: e.payload(version)}, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	res, err := e.cfg.Apply(st, ready)
	if err != nil {
		e.t.Fatal(err)
	}
	return res
}

func TestInstallUninstallRoundTrip(t *testing.T) {
	e := newEnv(t)
	res := e.res("Discord", "app-1.0.9266")
	original := testutil.Read(t, filepath.Join(res, "app.asar"))
	vencordBefore := testutil.TreeHash(t, filepath.Join(e.appdata, "Vencord"))
	underscoreBefore := testutil.Read(t, filepath.Join(res, "_app.asar"))

	r := e.install("0.1.0")
	if len(r.Targets) != 1 || r.Targets[0].Previous != "vencord-stub" || r.Targets[0].Backup == nil {
		t.Fatalf("result %+v", r)
	}

	// stub in place, pointing at our loader and the same patcher
	in := discord.Inspect(res)
	wantLoader := filepath.Join(e.appdata, "Telinha", "addon", "main.js")
	if in.Kind != discord.KindTelinhaStub || in.Patcher != e.patcher || in.Loader != wantLoader {
		t.Fatalf("after install: %+v", in)
	}
	// backup = exact original bytes, at the PAYLOAD.md path
	backup := filepath.Join(e.appdata, "Telinha", "backup", "Discord", "app-1.0.9266.app.asar")
	if !bytes.Equal(testutil.Read(t, backup), original) {
		t.Fatal("backup differs from Vencord's stub")
	}
	// payload + install.json
	if _, err := payload.ReadInstalled(e.cfg.AddonDir()); err != nil {
		t.Fatal(err)
	}
	rec, err := e.cfg.ReadRecord()
	if err != nil || rec == nil || rec.Version != "0.1.0" || len(rec.Targets) != 1 || rec.Targets[0].Flavor != "Discord" || rec.Source.Kind != "local" {
		t.Fatalf("install.json: %+v %v", rec, err)
	}
	if !e.cfg.Status().Installed() {
		t.Fatal("status: not installed")
	}

	// a log file in logs\ must survive uninstall
	testutil.Write(t, filepath.Join(e.cfg.Home(), "logs", "installer.log"), []byte("log"))

	u, err := e.cfg.Uninstall()
	if err != nil {
		t.Fatal(err)
	}
	if len(u.Restored) != 1 {
		t.Fatalf("restored %v", u.Restored)
	}
	if !bytes.Equal(testutil.Read(t, filepath.Join(res, "app.asar")), original) {
		t.Fatal("uninstall is not byte-identical")
	}
	for _, gone := range []string{"addon", "backup", "install.json", "addon.prev"} {
		if _, err := os.Stat(filepath.Join(e.cfg.Home(), gone)); err == nil {
			t.Fatalf("%s left behind", gone)
		}
	}
	if _, err := os.Stat(filepath.Join(e.cfg.Home(), "logs", "installer.log")); err != nil {
		t.Fatal("logs removed without --purge")
	}
	if testutil.TreeHash(t, filepath.Join(e.appdata, "Vencord")) != vencordBefore {
		t.Fatal("Vencord folder was modified")
	}
	if !bytes.Equal(testutil.Read(t, filepath.Join(res, "_app.asar")), underscoreBefore) {
		t.Fatal("_app.asar was modified")
	}
	if err := e.cfg.Purge(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.cfg.Home()); err == nil {
		t.Fatal("purge left Telinha folder")
	}
}

func TestIdempotentAndRepair(t *testing.T) {
	e := newEnv(t)
	res := e.res("Discord", "app-1.0.9266")
	original := testutil.Read(t, filepath.Join(res, "app.asar"))
	e.install("0.1.0")
	stub1 := testutil.Read(t, filepath.Join(res, "app.asar"))

	// same payload again: nothing staged, stub unchanged, backup still Vencord's (never our stub)
	ready, _ := e.cfg.Preflight()
	st, err := e.cfg.Stage(context.Background(), PayloadSource{Local: e.payload("0.1.0")}, nil)
	if err != nil || !st.UpToDate {
		t.Fatalf("restage: %+v %v", st, err)
	}
	r, err := e.cfg.Apply(st, ready)
	if err != nil || len(r.Targets) != 0 || len(r.Unchanged) != 1 {
		t.Fatalf("second apply: %+v %v", r, err)
	}
	if !bytes.Equal(testutil.Read(t, filepath.Join(res, "app.asar")), stub1) {
		t.Fatal("stub changed on idempotent run")
	}
	backup := e.cfg.BackupPath(e.cfg.Installs[0], "app-1.0.9266")
	if !bytes.Equal(testutil.Read(t, backup), original) {
		t.Fatal("backup overwritten with our stub")
	}
	if _, err := os.Stat(filepath.Join(e.cfg.Home(), payload.PrevDir)); err == nil {
		t.Fatal("identical payload created a rollback copy")
	}

	// repair without payload (nil staged) also a no-op
	if r, err := e.cfg.Apply(nil, ready); err != nil || len(r.Unchanged) != 1 {
		t.Fatalf("repair: %+v %v", r, err)
	}

	// Vencord installer "Repair" puts its stub back (new patcher-equal stub): our install re-backs it up and re-stubs
	testutil.Write(t, filepath.Join(res, "app.asar"), asar.VencordStub(e.patcher))
	os.Remove(backup)
	if r, err := e.cfg.Apply(nil, ready); err != nil || len(r.Targets) != 1 || r.Targets[0].Previous != "vencord-stub" {
		t.Fatalf("repair after Vencord installer: %+v %v", r, err)
	}
	if !bytes.Equal(testutil.Read(t, backup), original) || !bytes.Equal(testutil.Read(t, filepath.Join(res, "app.asar")), stub1) {
		t.Fatal("repair did not restore the same state")
	}
}

func TestDiscordUpdateThenUninstall(t *testing.T) {
	e := newEnv(t)
	e.install("0.1.0")
	ours := testutil.Read(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"))
	// Vencord's persistAfterDiscordUpdates copies our stub into the new app folder
	newRes := e.res("Discord", "app-1.0.9300")
	testutil.Write(t, filepath.Join(newRes, "_app.asar"), []byte("new discord"))
	testutil.Write(t, filepath.Join(newRes, "app.asar"), ours)

	st := e.cfg.Status()
	if st.Targets[0].App != "app-1.0.9300" || !st.Targets[0].Telinha() {
		t.Fatalf("status after update: %+v", st.Targets[0])
	}
	u, err := e.cfg.Uninstall()
	if err != nil || len(u.Restored) != 2 {
		t.Fatalf("uninstall: %+v %v", u, err)
	}
	want := asar.VencordStub(e.patcher)
	for _, app := range []string{"app-1.0.9266", "app-1.0.9300"} {
		if !bytes.Equal(testutil.Read(t, filepath.Join(e.res("Discord", app), "app.asar")), want) {
			t.Fatalf("%s not restored to Vencord's exact stub", app)
		}
	}
}

func TestOnlyNewestAppFolderIsPatched(t *testing.T) {
	e := newEnv(t)
	testutil.DiscordWithVencord(t, filepath.Join(e.local, "Discord"), "app-1.0.10000", e.patcher)
	e.rescan()
	e.install("0.1.0")
	if k := discord.Inspect(e.res("Discord", "app-1.0.10000")).Kind; k != discord.KindTelinhaStub {
		t.Fatalf("newest: %s", k)
	}
	if k := discord.Inspect(e.res("Discord", "app-1.0.9266")).Kind; k != discord.KindVencordStub {
		t.Fatalf("older folder touched: %s", k)
	}
}

func TestMultipleFlavors(t *testing.T) {
	e := newEnv(t)
	testutil.DiscordWithVencord(t, filepath.Join(e.local, "DiscordPTB"), "app-1.0.1100", e.patcher)
	testutil.DiscordVanilla(t, filepath.Join(e.local, "DiscordCanary"), "app-1.0.500")
	e.rescan()
	ready, err := e.cfg.Preflight()
	if err != nil || len(ready) != 2 {
		t.Fatalf("preflight: %v %v", ready, err)
	}
	r := e.install("0.1.0")
	if len(r.Targets) != 2 {
		t.Fatalf("%+v", r)
	}
	for _, f := range []string{"Discord", "DiscordPTB"} {
		if _, err := os.Stat(filepath.Join(e.cfg.Home(), "backup", f)); err != nil {
			t.Fatalf("no backup for %s", f)
		}
	}
	rec, _ := e.cfg.ReadRecord()
	if len(rec.Targets) != 2 {
		t.Fatalf("install.json targets: %+v", rec.Targets)
	}
	if k := discord.Inspect(e.res("DiscordCanary", "app-1.0.500")).Kind; k != discord.KindDiscordOriginal {
		t.Fatalf("canary touched: %s", k)
	}
}

func TestDiscordMissing(t *testing.T) {
	e := newEnv(t)
	e.cfg.Installs = discord.Find(filepath.Join(e.dir, "nowhere"))
	_, err := e.cfg.Preflight()
	if p := AsProblem(err); p.Code != CodeNoDiscord {
		t.Fatalf("got %v", err)
	}
}

func TestVencordMissing(t *testing.T) {
	cases := map[string]func(e *env){
		"vanilla discord": func(e *env) {
			os.RemoveAll(filepath.Join(e.local, "Discord"))
			testutil.DiscordVanilla(t, filepath.Join(e.local, "Discord"), "app-1.0.9266")
		},
		"no _app.asar": func(e *env) { os.Remove(filepath.Join(e.res("Discord", "app-1.0.9266"), "_app.asar")) },
		"patcher.js deleted": func(e *env) {
			os.RemoveAll(filepath.Join(e.appdata, "Vencord"))
		},
		"custom vencord": func(e *env) {
			other := testutil.Vencord(t, filepath.Join(e.dir, "dev"))
			testutil.Write(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"), asar.VencordStub(other))
		},
		"other mod": func(e *env) {
			testutil.Write(t, filepath.Join(e.res("Discord", "app-1.0.9266"), "app.asar"), asar.BuildStub(`require("C:\\bd\\injector.js");`))
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			mutate(e)
			before := testutil.TreeHash(t, filepath.Join(e.local, "Discord"))
			_, err := e.cfg.Preflight()
			p := AsProblem(err)
			if p.Code != CodeNoVencord || !strings.Contains(p.Msg, "Vencord") {
				t.Fatalf("got %v", err)
			}
			// Apply must refuse too (re-checks each target) and touch nothing
			e.cfg.Stage(context.Background(), PayloadSource{Local: e.payload("0.1.0")}, nil)
			if _, err := e.cfg.Apply(nil, e.cfg.Scan()); err == nil {
				t.Fatal("apply succeeded")
			}
			if testutil.TreeHash(t, filepath.Join(e.local, "Discord")) != before {
				t.Fatal("Discord folder modified")
			}
		})
	}
	// custom Vencord is accepted when explicitly allowed
	e := newEnv(t)
	cases["custom vencord"](e)
	e.cfg.AllowCustomVencord = true
	if _, err := e.cfg.Preflight(); err != nil {
		t.Fatalf("allow custom: %v", err)
	}
}

func TestDiscordRunning(t *testing.T) {
	e := newEnv(t)
	discordExe := filepath.Join(e.local, "Discord", "app-1.0.9266", "Discord.exe")
	e.procs.list = []winproc.Process{
		{PID: 10, Name: "Discord.exe", Path: discordExe},
		{PID: 11, Name: "Discord.exe", Path: discordExe},
		{PID: 12, Name: "telinha-audio.exe", Path: filepath.Join(e.cfg.Home(), "addon", "telinha-audio.exe")},
		{PID: 13, Name: "telinha-audio.exe", Path: `C:\elsewhere\telinha-audio.exe`},
		{PID: 14, Name: "notepad.exe", Path: `C:\Windows\notepad.exe`},
	}
	ready, _ := e.cfg.Preflight()
	st, err := e.cfg.Stage(context.Background(), PayloadSource{Local: e.payload("0.1.0")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.cfg.Apply(st, ready); AsProblem(err).Code != CodeDiscordRunning {
		t.Fatalf("apply while running: %v", err)
	}
	if k := discord.Inspect(e.res("Discord", "app-1.0.9266")).Kind; k != discord.KindVencordStub {
		t.Fatal("stub written while Discord runs")
	}
	ps, _ := e.cfg.RunningProcesses()
	if len(ps) != 3 {
		t.Fatalf("running: %+v", ps)
	}

	e.procs.stuck = true
	if err := e.cfg.CloseDiscord(ps); AsProblem(err).Code != CodeDiscordRunning {
		t.Fatalf("stuck close: %v", err)
	}
	e.procs.stuck = false
	if err := e.cfg.CloseDiscord(ps); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(e.procs.closed) != "[10 11 12]" {
		t.Fatalf("closed %v", e.procs.closed)
	}
	if _, err := e.cfg.Apply(st, ready); err != nil {
		t.Fatal(err)
	}
}

// With --discord-dir overrides only processes started from those folders count, so a real Discord
// running elsewhere is never closed by a test run.
func TestOverriddenOnlyMatchesOwnProcesses(t *testing.T) {
	e := newEnv(t)
	e.cfg.Installs = []discord.Install{discord.FromDir(filepath.Join(e.local, "Discord"))}
	e.cfg.Overridden = true
	e.procs.list = []winproc.Process{
		{PID: 20, Name: "Discord.exe", Path: `C:\Users\real\AppData\Local\Discord\app-1.0.9266\Discord.exe`},
		{PID: 21, Name: "DiscordPTB.exe", Path: ""},
	}
	if ps, _ := e.cfg.RunningProcesses(); len(ps) != 0 {
		t.Fatalf("matched foreign processes: %+v", ps)
	}
	e.install("0.1.0") // succeeds although "Discord.exe" is in the process table
	e.cfg.Overridden = false
	if ps, _ := e.cfg.RunningProcesses(); len(ps) != 2 {
		t.Fatalf("without override every Discord process counts: %+v", ps)
	}
}

func TestUpdateAndRollback(t *testing.T) {
	e := newEnv(t)
	e.install("0.1.0")
	e.install("0.2.0")
	if m, _ := payload.ReadInstalled(e.cfg.AddonDir()); m.Version != "0.2.0" {
		t.Fatalf("installed %s", m.Version)
	}
	if !e.cfg.Status().PreviousReady {
		t.Fatal("no rollback copy")
	}
	m, err := e.cfg.Rollback()
	if err != nil || m.Version != "0.1.0" {
		t.Fatalf("rollback: %v %v", m, err)
	}
	rec, _ := e.cfg.ReadRecord()
	if rec.Version != "0.2.0" {
		t.Fatalf("record %s", rec.Version) // Apply after rollback rewrites it (done by the CLI)
	}
}

func TestCorruptPayloadKeepsInstalledVersion(t *testing.T) {
	e := newEnv(t)
	e.install("0.1.0")
	bad := e.payload("0.3.0")
	testutil.Write(t, filepath.Join(bad, "main.js"), []byte("evil"))
	_, err := e.cfg.Stage(context.Background(), PayloadSource{Local: bad}, nil)
	if AsProblem(err).Code != CodePayload {
		t.Fatalf("got %v", err)
	}
	if m, err := payload.ReadInstalled(e.cfg.AddonDir()); err != nil || m.Version != "0.1.0" {
		t.Fatalf("installed payload damaged: %v %v", m, err)
	}
	// local zip with a wrong --sha256
	z := filepath.Join(e.dir, "p.zip")
	testutil.Zip(t, e.payload("0.1.0"), z, nil)
	_, err = e.cfg.Stage(context.Background(), PayloadSource{Local: z, SHA256: strings.Repeat("0", 64)}, nil)
	if !errors.Is(err, payload.ErrChecksum) {
		t.Fatalf("wrong sha accepted: %v", err)
	}
	if _, err := e.cfg.Stage(context.Background(), PayloadSource{Local: z, SHA256: testutil.SHA256(t, z)}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestRepairWithoutPayload(t *testing.T) {
	e := newEnv(t)
	ready, _ := e.cfg.Preflight()
	if _, err := e.cfg.Apply(nil, ready); AsProblem(err).Code != CodeNotInstalled {
		t.Fatalf("got %v", err)
	}
}

func TestStageFromGitHub(t *testing.T) {
	e := newEnv(t)
	z := filepath.Join(e.dir, "Telinha-addon-abcdef12.zip")
	testutil.Zip(t, e.payload("0.1.0"), z, nil)
	data := testutil.Read(t, z)
	sum := testutil.SHA256(t, z)
	digest := "sha256:" + sum
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/HumbertoFernandes7/Telinha/releases":
			json.NewEncoder(w).Encode([]map[string]any{{"tag_name": "v0.1.0", "prerelease": true, "published_at": "2026-10-29T00:00:00Z",
				"body":   "SHA-256 (Telinha-addon-abcdef12.zip) = " + sum,
				"assets": []map[string]any{{"name": "Telinha-addon-abcdef12.zip", "size": len(data), "digest": digest, "browser_download_url": srv.URL + "/z"}}}})
		case "/z":
			w.Write(data)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := payload.NewClient("test")
	c.APIBase = srv.URL
	var msgs []string
	st, err := e.cfg.Stage(context.Background(), PayloadSource{Client: c}, func(s string) { msgs = append(msgs, s) })
	if err != nil {
		t.Fatal(err)
	}
	if st.Source.Kind != "github" || st.Source.Release != "v0.1.0" || st.Source.SHA256 != sum || len(msgs) < 2 {
		t.Fatalf("%+v %v", st.Source, msgs)
	}
	ready, _ := e.cfg.Preflight()
	if _, err := e.cfg.Apply(st, ready); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.Home(), "download.zip.tmp")); err == nil {
		t.Fatal("download left behind")
	}

	// tampered digest -> CodePayload, nothing changed
	digest = "sha256:" + strings.Repeat("1", 64)
	e2 := newEnv(t)
	_, err = e2.cfg.Stage(context.Background(), PayloadSource{Client: c}, nil)
	if p := AsProblem(err); p.Code != CodePayload || !errors.Is(err, payload.ErrChecksum) {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(e2.cfg.AddonDir()); err == nil {
		t.Fatal("addon created from a bad download")
	}
}
