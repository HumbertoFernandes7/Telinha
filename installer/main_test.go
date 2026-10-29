// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winver"
)

func TestParseFlags(t *testing.T) {
	o, err := parseFlags([]string{"--install", "--yes", "--payload", `C:\p.zip`, "--discord-dir", `C:\a\Discord`, "--discord-dir", `C:\a\DiscordPTB`, "--appdata", `C:\r`}, io.Discard)
	if err != nil || !o.install || !o.yes || o.payload != `C:\p.zip` || len(o.discordDirs) != 2 || o.appdata != `C:\r` || !o.cli() {
		t.Fatalf("%+v %v", o, err)
	}
	if o, _ := parseFlags(nil, io.Discard); o.cli() {
		t.Fatal("no flags must mean GUI")
	}
	if o, _ := parseFlags([]string{"--payload", "x"}, io.Discard); o.cli() {
		t.Fatal("overrides alone keep the GUI (for testing it on fake trees)")
	}
	for _, bad := range [][]string{{"--install", "--uninstall"}, {"--nope"}, {"extra"}} {
		if _, err := parseFlags(bad, io.Discard); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestWindowsVersionGate(t *testing.T) {
	for _, c := range []struct {
		major, build uint32
		ok           bool
	}{{10, 19041, true}, {10, 19045, true}, {10, 22631, true}, {10, 18363, false}, {6, 9600, false}, {11, 1, true}} {
		if winver.Supported(c.major, c.build) != c.ok {
			t.Errorf("%d.%d: want %v", c.major, c.build, c.ok)
		}
	}
	if err := winver.Check(); err != nil {
		t.Logf("this machine is below the minimum: %v", err)
	}
}

// fakeTrees builds a fake %APPDATA% (official Vencord) and a fake Discord with Vencord's stub, plus a payload
// zip, all under one temp folder. Nothing here touches the real Discord or the real %APPDATA%.
type fakeTrees struct {
	dir, appdata, discordRoot, zip, installerLog string
}

func newFakeTrees(t *testing.T) *fakeTrees {
	t.Helper()
	dir := testutil.TempDir(t)
	f := &fakeTrees{dir: dir, appdata: filepath.Join(dir, "Roaming"), discordRoot: filepath.Join(dir, "Local", "Discord")}
	patcher := testutil.Vencord(t, f.appdata)
	testutil.DiscordWithVencord(t, f.discordRoot, "app-1.0.9266", patcher)
	pl := filepath.Join(dir, "payload")
	testutil.Payload(t, pl, "0.1.0", map[string]string{"telinha.renderer.js": "// renderer"})
	f.zip = filepath.Join(dir, "Telinha-addon-abcdef12.zip")
	testutil.Zip(t, pl, f.zip, nil)
	f.installerLog = filepath.Join(f.appdata, "Telinha", "logs", "installer.log")
	return f
}

func (f *fakeTrees) options() *options {
	return &options{appdata: f.appdata, discordDirs: multiFlag{f.discordRoot}}
}

func (f *fakeTrees) log(t *testing.T) string {
	t.Helper()
	return string(testutil.Read(t, f.installerLog))
}

func mustContain(t *testing.T, log string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(log, w) {
			t.Errorf("installer.log lacks %q", w)
		}
	}
	if t.Failed() {
		t.Logf("installer.log:\n%s", log)
	}
}

// TestGUIInstallPathWritesInstallerLog drives an install the way the GUI does: newApp (what runGUI starts
// with), then app.install with hooks like the GUI's (the work runs in a goroutine, as ui.Progress does it,
// and the answer to "close Discord?" comes from a stand-in dialog), the payload coming from a fake GitHub
// release. The regression it guards: a GUI run that installed fine but left nothing in installer.log.
func TestGUIInstallPathWritesInstallerLog(t *testing.T) {
	f := newFakeTrees(t)
	data := testutil.Read(t, f.zip)
	sum := testutil.SHA256(t, f.zip)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/HumbertoFernandes7/Telinha/releases":
			json.NewEncoder(w).Encode([]map[string]any{{"tag_name": "teste-3", "prerelease": true, "published_at": "2026-10-29T00:00:00Z",
				"body":   "SHA-256 (Telinha-addon-abcdef12.zip) = " + sum,
				"assets": []map[string]any{{"name": "Telinha-addon-abcdef12.zip", "size": len(data), "digest": "sha256:" + sum, "browser_download_url": srv.URL + "/z"}}}})
		case "/z":
			w.Write(data)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	a, err := newApp(f.options(), nil)
	if err != nil {
		t.Fatal(err)
	}
	a.gh.APIBase = srv.URL
	asked := false
	res, chosen, err := a.install(context.Background(), false, installUI{
		pick: func(ready []core.Target) ([]core.Target, bool) { return ready, true },
		busy: func(_ bool, work func(set func(string)) error) error {
			done := make(chan error, 1)
			go func() { done <- work(func(string) {}) }()
			return <-done
		},
		closeDiscord: func() (bool, error) { asked = true; return true, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	a.finish(exitOK) // what runGUI defers
	if !asked || res == nil || len(chosen) != 1 || len(res.Targets) != 1 {
		t.Fatalf("asked=%v res=%+v chosen=%v", asked, res, chosen)
	}
	if k := discord.Inspect(filepath.Join(f.discordRoot, "app-1.0.9266", "resources")).Kind; k != discord.KindTelinhaStub {
		t.Fatalf("stub not written: %s", k)
	}

	mustContain(t, f.log(t),
		"TelinhaInstaller", "start (gui)", "discord: Discord at "+f.discordRoot,
		"install: begin", "preflight: ready to install into Discord app-1.0.9266", "install: targets chosen: Discord",
		"payload: release teste-3", "payload: expected sha256 "+sum, "payload: downloaded sha256="+sum, "payload: staged 0.1.0",
		"apply: begin", "payload: activated 0.1.0", "backup: ", "stub: wrote ", "install.json: written",
		"apply: done, Telinha 0.1.0 (abcdef12), 1 stub(s) written", "install: finished, Telinha 0.1.0",
		"finished: exit code 0")
}

// TestGUIInstallCancelledIsLogged: backing out (keeping Discord open) is a decision too.
func TestGUIInstallCancelledIsLogged(t *testing.T) {
	f := newFakeTrees(t)
	o := f.options()
	o.payload = f.zip
	a, err := newApp(o, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = a.install(context.Background(), false, installUI{closeDiscord: func() (bool, error) { return false, nil }})
	a.finish(exitOK)
	if err != errCancelled {
		t.Fatalf("got %v", err)
	}
	mustContain(t, f.log(t), "install: cancelled: the user kept Discord open", "finished: exit code 0")
	if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon.new")); err == nil {
		t.Fatal("staged payload left behind")
	}
}

// TestCLIInstallWritesInstallerLog: the same for the CLI entry (runCLI), end to end with a local payload.
func TestCLIInstallWritesInstallerLog(t *testing.T) {
	f := newFakeTrees(t)
	o := f.options()
	o.install, o.yes, o.payload = true, true, f.zip
	if code := runCLI(o); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	mustContain(t, f.log(t),
		"start (cli)", "install: begin", "payload: local "+f.zip, "payload: staged 0.1.0", "payload: activated 0.1.0",
		"backup: ", "stub: wrote ", "install.json: written", "install: finished", "finished: exit code 0")
}
