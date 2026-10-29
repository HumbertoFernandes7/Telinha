// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

// app.install is the sequence every front end goes through: these tests hook it the way the CLI, the GUI
// and the tests of others do, and check what is left behind on each way out.

func (f *fakeTrees) app(t *testing.T, mutate func(o *options)) *app {
	t.Helper()
	o := f.options()
	if mutate != nil {
		mutate(o)
	}
	a, err := newApp(o, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.finish(0) })
	return a
}

func (f *fakeTrees) staged() bool {
	_, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon.new"))
	return err == nil
}

func TestInstallWithoutHooks(t *testing.T) {
	f := newFakeTrees(t)
	a := f.app(t, func(o *options) { o.payload = f.zip })
	// every hook is optional: the work runs inline, status lines are dropped, nothing asks anything
	res, chosen, err := a.install(context.Background(), false, installUI{})
	if err != nil || res == nil || len(chosen) != 1 || len(res.Targets) != 1 {
		t.Fatalf("%+v %v %v", res, chosen, err)
	}
	if f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatal("not installed")
	}
}

func TestInstallStatusLines(t *testing.T) {
	f := newFakeTrees(t)
	a := f.app(t, func(o *options) { o.payload = f.zip })
	var said []string
	if _, _, err := a.install(context.Background(), false, installUI{say: func(s string) { said = append(said, s) }}); err != nil {
		t.Fatal(err)
	}
	if len(said) != 2 || !strings.Contains(said[0], "Verificando") || !strings.Contains(said[1], "Ativando o Telinha no Discord") {
		t.Fatalf("status lines: %q", said)
	}
}

func TestInstallBusyReceivesCancellableOnlyForTheDownload(t *testing.T) {
	f := newFakeTrees(t)
	a := f.app(t, func(o *options) { o.payload = f.zip })
	var flags []bool
	_, _, err := a.install(context.Background(), false, installUI{busy: func(cancellable bool, work func(set func(string)) error) error {
		flags = append(flags, cancellable)
		return work(func(string) {})
	}})
	if err != nil || len(flags) != 2 || !flags[0] || flags[1] {
		t.Fatalf("%v %v", flags, err)
	}
}

func TestInstallPickCancelled(t *testing.T) {
	f := newFakeTrees(t)
	a := f.app(t, func(o *options) { o.payload = f.zip })
	busy := 0
	_, _, err := a.install(context.Background(), false, installUI{
		pick: func(ready []core.Target) ([]core.Target, bool) { return nil, false },
		busy: func(bool, func(func(string)) error) error { busy++; return nil },
	})
	if err != errCancelled || busy != 0 || f.staged() {
		t.Fatalf("err %v, %d downloads, staged=%v: backing out of the choice must stop everything", err, busy, f.staged())
	}
	mustContain(t, f.log(t), "install: cancelled at the target choice")
}

func TestInstallPickNarrowsTheTargets(t *testing.T) {
	f := newFakeTrees(t)
	ptb := f.addFlavor(t, "DiscordPTB", true)
	a := f.app(t, func(o *options) { o.payload = f.zip })
	res, chosen, err := a.install(context.Background(), false, installUI{pick: func(ready []core.Target) ([]core.Target, bool) {
		if len(ready) != 2 {
			t.Errorf("ready %v", ready)
		}
		return ready[1:], true
	}})
	if err != nil || len(chosen) != 1 || chosen[0].Name != "Discord PTB" || len(res.Targets) != 1 {
		t.Fatalf("%+v %v %v", res, chosen, err)
	}
	if discord.Inspect(filepath.Join(ptb, "app-1.0.9266", "resources")).Kind != discord.KindTelinhaStub || f.stubKind(t) != discord.KindVencordStub {
		t.Fatal("only the chosen Discord may change")
	}
}

func TestInstallCancelledDuringTheDownload(t *testing.T) {
	f := newFakeTrees(t)
	a := f.app(t, func(o *options) { o.payload = f.zip })
	for name, workErr := range map[string]error{"the work finished anyway": nil, "the work failed because of the cancel": context.Canceled} {
		ctx, cancel := context.WithCancel(context.Background())
		_, _, err := a.install(ctx, false, installUI{
			busy: func(_ bool, work func(set func(string)) error) error {
				cancel()
				_ = work(func(string) {})
				return workErr
			},
			closeDiscord: func() (bool, error) { t.Error("asked about Discord after the user cancelled"); return true, nil },
		})
		if err != errCancelled {
			t.Errorf("%s: %v", name, err)
		}
		if f.staged() {
			t.Errorf("%s: the staged payload was kept", name)
		}
		if f.stubKind(t) != discord.KindVencordStub {
			t.Errorf("%s: stub written", name)
		}
	}
	mustContain(t, f.log(t), "install: cancelled during the download")
}

func TestInstallStageErrorIsReturnedAsIs(t *testing.T) {
	f := newFakeTrees(t)
	a := f.app(t, func(o *options) { o.payload = filepath.Join(f.dir, "missing.zip") })
	_, _, err := a.install(context.Background(), false, installUI{})
	if p := core.AsProblem(err); p.Code != core.CodePayload || err == errCancelled {
		t.Fatalf("%v", err)
	}
	// a work error reported by the busy hook itself (the progress dialog failing) is an error too
	boom := errors.New("dialog failed")
	a2 := f.app(t, func(o *options) { o.payload = f.zip })
	if _, _, err := a2.install(context.Background(), false, installUI{busy: func(bool, func(func(string)) error) error { return boom }}); err != boom {
		t.Fatalf("%v", err)
	}
}

func TestInstallRepairKeepsTheInstalledFiles(t *testing.T) {
	f := installedTrees(t)
	// Vencord's own Repair put its stub back
	res := filepath.Join(f.discordRoot, "app-1.0.9266", "resources")
	testutil.Write(t, filepath.Join(res, "app.asar"), testutil.Read(t, filepath.Join(f.appdata, "Telinha", "backup", "Discord", "app-1.0.9266.app.asar")))

	a := f.app(t, nil) // no --payload
	downloads := 0
	r, _, err := a.install(context.Background(), true, installUI{busy: func(c bool, work func(func(string)) error) error {
		if c {
			downloads++
		}
		return work(func(string) {})
	}})
	if err != nil || len(r.Targets) != 1 || downloads != 0 {
		t.Fatalf("%+v %v (%d downloads)", r, err, downloads)
	}
	mustContain(t, f.log(t), "install: repair with the files already installed (nothing to download)")
	if f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatal("not repaired")
	}
}

func TestInstallRepairWithAPayloadOrWithoutFilesStillStages(t *testing.T) {
	// --payload given: it is used even for a repair
	f := installedTrees(t)
	a := f.app(t, func(o *options) { o.payload = f.zip })
	downloads := 0
	if _, _, err := a.install(context.Background(), true, installUI{busy: func(c bool, work func(func(string)) error) error {
		if c {
			downloads++
		}
		return work(func(string) {})
	}}); err != nil || downloads != 1 {
		t.Fatalf("%v (%d downloads)", err, downloads)
	}
	// nothing installed yet: a repair has to bring the files in first
	g := newFakeTrees(t)
	b := g.app(t, func(o *options) { o.payload = g.zip })
	if r, _, err := b.install(context.Background(), true, installUI{}); err != nil || len(r.Targets) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestInstallCloseDiscordHook(t *testing.T) {
	t.Run("the user says no", func(t *testing.T) {
		f := newFakeTrees(t)
		a := f.app(t, func(o *options) { o.payload = f.zip })
		_, _, err := a.install(context.Background(), false, installUI{closeDiscord: func() (bool, error) { return false, nil }})
		if err != errCancelled || f.staged() || f.stubKind(t) != discord.KindVencordStub {
			t.Fatalf("%v staged=%v", err, f.staged())
		}
	})
	t.Run("closing fails", func(t *testing.T) {
		f := newFakeTrees(t)
		a := f.app(t, func(o *options) { o.payload = f.zip })
		boom := errors.New("cannot close")
		_, _, err := a.install(context.Background(), false, installUI{closeDiscord: func() (bool, error) { return true, boom }})
		if err != boom || f.staged() || f.stubKind(t) != discord.KindVencordStub {
			t.Fatalf("%v staged=%v", err, f.staged())
		}
	})
	t.Run("it is asked after the download and before the stub", func(t *testing.T) {
		f := newFakeTrees(t)
		a := f.app(t, func(o *options) { o.payload = f.zip })
		_, _, err := a.install(context.Background(), false, installUI{closeDiscord: func() (bool, error) {
			if !f.staged() || f.stubKind(t) != discord.KindVencordStub {
				t.Errorf("staged=%v stub=%s", f.staged(), f.stubKind(t))
			}
			return true, nil
		}})
		if err != nil {
			t.Fatal(err)
		}
	})
}

func TestInstallApplyFailure(t *testing.T) {
	f := newFakeTrees(t)
	procs := withProcs(t, f.discordProc(1)) // Discord is running and nobody closed it
	a := f.app(t, func(o *options) { o.payload = f.zip })
	res, chosen, err := a.install(context.Background(), false, installUI{closeDiscord: func() (bool, error) { return true, nil }})
	if core.AsProblem(err).Code != core.CodeDiscordRunning || res != nil || chosen != nil {
		t.Fatalf("%+v %v %v", res, chosen, err)
	}
	_ = procs
	if f.stubKind(t) != discord.KindVencordStub {
		t.Fatal("stub written while Discord ran")
	}
}

func TestInstallPreflightErrors(t *testing.T) {
	f := newFakeTrees(t)
	os.RemoveAll(f.discordRoot)
	testutil.DiscordVanilla(t, f.discordRoot, "app-1.0.9266")
	a := f.app(t, func(o *options) { o.payload = f.zip })
	_, _, err := a.install(context.Background(), false, installUI{
		pick: func([]core.Target) ([]core.Target, bool) { t.Error("asked to pick"); return nil, true },
		busy: func(bool, func(func(string)) error) error { t.Error("downloaded"); return nil },
	})
	if core.AsProblem(err).Code != core.CodeNoVencord || f.staged() {
		t.Fatalf("%v", err)
	}
}

func TestFinishLogsTheExitCodeAndStops(t *testing.T) {
	f := newFakeTrees(t)
	a, err := newApp(f.options(), nil)
	if err != nil {
		t.Fatal(err)
	}
	a.finish(7)
	mustContain(t, f.log(t), "finished: exit code 7")
	a.log.Printf("after the end") // the log is closed: nothing is written, nothing breaks
	if strings.Contains(f.log(t), "after the end") {
		t.Fatal("a finished run kept logging")
	}
}
