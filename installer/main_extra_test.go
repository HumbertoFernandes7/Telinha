// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/ui"
)

func TestMultiFlag(t *testing.T) {
	var m multiFlag
	if m.String() != "" {
		t.Fatalf("%q", m.String())
	}
	for _, v := range []string{`C:\a`, `C:\b`, `C:\c`} {
		if err := m.Set(v); err != nil {
			t.Fatal(err)
		}
	}
	if m.String() != `C:\a;C:\b;C:\c` || len(m) != 3 {
		t.Fatalf("%q", m.String())
	}
}

func TestParseFlagsAllOptions(t *testing.T) {
	o, err := parseFlags([]string{"--repair", "-y", "--purge", "--json", "--allow-custom-vencord", "--prerelease", "--sha256", "abc", "--payload", `C:\p`}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !o.repair || !o.yes || !o.purge || !o.json || !o.allowCustom || !o.prerelease || o.sha256 != "abc" || o.payload != `C:\p` || !o.cli() {
		t.Fatalf("%+v", o)
	}
	for flagName, set := range map[string]func(o *options) bool{
		"--install":   func(o *options) bool { return o.install },
		"--uninstall": func(o *options) bool { return o.uninstall },
		"--repair":    func(o *options) bool { return o.repair },
		"--status":    func(o *options) bool { return o.status },
		"--rollback":  func(o *options) bool { return o.rollback },
		"--version":   func(o *options) bool { return o.showVersion },
		"--yes":       func(o *options) bool { return o.yes },
	} {
		o, err := parseFlags([]string{flagName}, io.Discard)
		if err != nil || !set(o) {
			t.Errorf("%s: %+v %v", flagName, o, err)
		}
	}
	// single dash and "=" forms are the standard flag package's
	if o, err := parseFlags([]string{"-install", "-payload=x.zip"}, io.Discard); err != nil || !o.install || o.payload != "x.zip" {
		t.Fatalf("%+v %v", o, err)
	}
	// --yes alone is not a CLI action: double-clicking with --yes stays a GUI
	if o, _ := parseFlags([]string{"--yes", "--purge", "--json"}, io.Discard); o.cli() {
		t.Fatal("modifiers alone must not switch to the command line")
	}
}

func TestParseFlagsErrors(t *testing.T) {
	var out strings.Builder
	if _, err := parseFlags([]string{"-h"}, &out); !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("-h: %v", err)
	}
	contains(t, "usage", out.String(), "-install", "-uninstall", "-rollback", "-payload", "-discord-dir", "-appdata", "instala ou atualiza o Telinha")
	for args, want := range map[string]string{
		"--install --uninstall": "use só uma ação",
		"--status --rollback":   "use só uma ação",
		"--repair --install":    "use só uma ação",
		"extra":                 "argumento inesperado: extra",
		"--install extra more":  "argumento inesperado: extra",
		"--payload":             "needs an argument",
		"--nope":                "not defined",
	} {
		_, err := parseFlags(strings.Fields(args), io.Discard)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v (want %q)", args, err, want)
		}
	}
}

// ---------------------------------------------------------------------------------------------------- run

func TestRunUsageErrors(t *testing.T) {
	attached := 0
	swap(t, &attachConsole, func() { attached++ })
	hidden := 0
	swap(t, &hideConsole, func() { hidden++ })

	var code int
	_, errOut := capture(t, func() { code = run([]string{"--nope"}) })
	if code != exitUsage {
		t.Fatalf("exit code %d", code)
	}
	contains(t, "stderr", errOut, "flag provided but not defined: -nope", "-install")

	_, errOut = capture(t, func() { code = run([]string{"--install", "--uninstall"}) })
	if code != exitUsage || !strings.Contains(errOut, "use só uma ação") {
		t.Fatalf("code %d stderr %q", code, errOut)
	}

	_, errOut = capture(t, func() { code = run([]string{"extra"}) })
	if code != exitUsage || !strings.Contains(errOut, "argumento inesperado: extra") {
		t.Fatalf("code %d stderr %q", code, errOut)
	}

	_, errOut = capture(t, func() { code = run([]string{"-h"}) })
	if code != exitOK || !strings.Contains(errOut, "-status") {
		t.Fatalf("-h: code %d stderr %q", code, errOut)
	}
	if strings.Contains(errOut, "flag: help requested") {
		t.Fatalf("-h is not an error:\n%s", errOut)
	}
	if attached != 4 || hidden != 0 {
		t.Fatalf("a usage error needs the console to be seen: attached %d hidden %d", attached, hidden)
	}
}

func TestRunCLIAttachesTheConsole(t *testing.T) {
	attached, hidden := 0, 0
	swap(t, &attachConsole, func() { attached++ })
	swap(t, &hideConsole, func() { hidden++ })
	var code int
	out, _ := capture(t, func() { code = run([]string{"--version"}) })
	if code != exitOK || strings.TrimSpace(out) != "TelinhaInstaller "+version || attached != 1 || hidden != 0 {
		t.Fatalf("code %d out %q attached %d hidden %d", code, out, attached, hidden)
	}
	f := newFakeTrees(t)
	out, _ = capture(t, func() { code = run([]string{"--status", "--appdata", f.appdata, "--discord-dir", f.discordRoot}) })
	if code != exitOK || !strings.Contains(out, "Add-on: não instalado") || attached != 2 {
		t.Fatalf("code %d out %q", code, out)
	}
}

func TestRunStartsTheGUIWithoutActions(t *testing.T) {
	attached, hidden := 0, 0
	swap(t, &attachConsole, func() { attached++ })
	swap(t, &hideConsole, func() { hidden++ })
	f := newFakeTrees(t)
	u := newFakeUI(t).answer(dlgMain, ui.IDCANCEL)
	// overrides alone keep the GUI (that is how the GUI is tried out on fake trees)
	if code := run([]string{"--appdata", f.appdata, "--discord-dir", f.discordRoot, "--payload", f.zip}); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if attached != 0 || hidden != 1 || len(u.shown(dlgMain)) != 1 {
		t.Fatalf("attached %d hidden %d dialogs %v", attached, hidden, u.instructions())
	}
}

// ---------------------------------------------------------------------------------------------- newApp

func TestNewAppFolders(t *testing.T) {
	t.Run("--appdata and --discord-dir are used as given", func(t *testing.T) {
		f := newFakeTrees(t)
		extra := f.addFlavor(t, "DiscordCanary", false)
		a, err := newApp(f.options(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		if a.cfg.AppData != f.appdata || !a.cfg.Overridden || len(a.cfg.Installs) != 2 || a.cfg.Installs[0].Root != f.discordRoot ||
			a.cfg.Installs[1] != discord.FromDir(extra) || a.cfg.InstallerVersion != version || a.cfg.Procs != systemProcesses {
			t.Fatalf("%+v", a.cfg)
		}
		if a.cfg.Log == nil || a.cfg.Home() != filepath.Join(f.appdata, "Telinha") {
			t.Fatal("log or home")
		}
	})
	t.Run("without them the Windows folders are used", func(t *testing.T) {
		roaming, local := sandboxFolders(t)
		testutil.DiscordWithVencord(t, filepath.Join(local, "Discord"), "app-1.0.1", filepath.Join(roaming, "Vencord", "dist", "patcher.js"))
		testutil.DiscordVanilla(t, filepath.Join(local, "DiscordPTB"), "app-1.0.2")
		os.MkdirAll(filepath.Join(local, "DiscordCanary"), 0o755) // no app-* inside: not an install
		a, err := newApp(&options{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		if a.cfg.AppData != roaming || a.cfg.Overridden || len(a.cfg.Installs) != 2 || !a.cfg.Installs[0].Detected || a.cfg.Installs[1].Branch != "ptb" {
			t.Fatalf("%+v %+v", a.cfg, a.cfg.Installs)
		}
	})
	t.Run("the shell cannot say, the environment can", func(t *testing.T) {
		dir := testutil.TempDir(t)
		t.Setenv("APPDATA", filepath.Join(dir, "FromEnv", "Roaming"))
		t.Setenv("LOCALAPPDATA", filepath.Join(dir, "FromEnv", "Local"))
		swap(t, &knownFolderPath, func(*windows.KNOWNFOLDERID, uint32) (string, error) { return "", errors.New("no shell") })
		a, err := newApp(&options{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		if a.cfg.AppData != filepath.Join(dir, "FromEnv", "Roaming") || len(a.cfg.Installs) != 0 {
			t.Fatalf("%+v", a.cfg)
		}
	})
	t.Run("an empty answer from the shell falls back too", func(t *testing.T) {
		dir := testutil.TempDir(t)
		t.Setenv("APPDATA", filepath.Join(dir, "R"))
		swap(t, &knownFolderPath, func(*windows.KNOWNFOLDERID, uint32) (string, error) { return "", nil })
		a, err := newApp(&options{}, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		if a.cfg.AppData != filepath.Join(dir, "R") {
			t.Fatalf("%s", a.cfg.AppData)
		}
	})
	t.Run("nowhere to put the files", func(t *testing.T) {
		t.Setenv("APPDATA", "")
		swap(t, &knownFolderPath, func(*windows.KNOWNFOLDERID, uint32) (string, error) { return "", errors.New("no shell") })
		if a, err := newApp(&options{}, nil); err == nil || a != nil || !strings.Contains(err.Error(), "%APPDATA%") {
			t.Fatalf("%v %v", a, err)
		}
	})
}

func TestNewAppSettings(t *testing.T) {
	f := newFakeTrees(t)
	t.Run("VENCORD_USER_DATA_DIR", func(t *testing.T) {
		t.Setenv("VENCORD_USER_DATA_DIR", `D:\vdata`)
		a, err := newApp(f.options(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		if a.cfg.VencordDataDir != `D:\vdata` || len(a.cfg.OfficialPatchers()) != 2 {
			t.Fatalf("%q", a.cfg.VencordDataDir)
		}
	})
	t.Run("--allow-custom-vencord and --prerelease", func(t *testing.T) {
		o := f.options()
		o.allowCustom, o.prerelease = true, true
		a, err := newApp(o, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		if !a.cfg.AllowCustomVencord || !a.gh.Prerelease {
			t.Fatalf("%+v %+v", a.cfg, a.gh)
		}
		mustContain(t, f.log(t), "releases: pre-releases accepted (--prerelease)")
	})
	t.Run("the GitHub client says who is asking", func(t *testing.T) {
		a, err := newApp(f.options(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		if a.gh.UserAgent != "TelinhaInstaller/"+version+" (+"+projectURL+")" || a.gh.Prerelease || a.gh.APIBase != "https://api.github.com" {
			t.Fatalf("%+v", a.gh)
		}
	})
	t.Run("the first log line says what this run is", func(t *testing.T) {
		g := newFakeTrees(t)
		var extra strings.Builder
		o := g.options()
		o.status = true
		a, err := newApp(o, &extra)
		if err != nil {
			t.Fatal(err)
		}
		a.finish(0)
		contains(t, "extra log", extra.String(), "TelinhaInstaller "+version+" start (cli)", "appdata="+g.appdata, "installs=1 overridden=true", "discord: Discord at "+g.discordRoot)
		o2 := g.options()
		a2, _ := newApp(o2, nil)
		a2.finish(0)
		mustContain(t, g.log(t), "start (gui)")
	})
}
