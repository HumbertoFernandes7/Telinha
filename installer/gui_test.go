// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/ui"
)

// The GUI is driven through its three seams (showDialog, showProgress, openURL): a script answers each
// dialog by its main instruction, exactly what a user would have clicked. The native windows themselves are
// out of reach without a desktop.

const (
	dlgMain       = "Telinha para Discord"
	dlgNoDiscord  = "Não encontramos o Discord"
	dlgNoVencord  = "Primeiro instale o Vencord"
	dlgPick       = "Em qual Discord instalar?"
	dlgCloseInst  = "O Discord precisa ser fechado para instalar. Fechar agora?"
	dlgCloseUnin  = "O Discord precisa ser fechado para desinstalar. Fechar agora?"
	dlgDone       = "Pronto!"
	dlgRemoved    = "O Telinha foi removido"
	dlgErrInstall = "Não foi possível instalar o Telinha"
	dlgErrUninst  = "Não foi possível desinstalar o Telinha"
	dlgOldWindows = "Este Windows é antigo demais para o Telinha"
	dlgCannotInit = "Não foi possível iniciar o instalador"

	progInstall = "Instalando o Telinha"
	progClose   = "Fechando o Discord…"
	progRemove  = "Removendo o Telinha"
)

func (f *fakeTrees) gui(t *testing.T, mutate func(o *options)) int {
	t.Helper()
	o := f.options()
	o.payload = f.zip
	if mutate != nil {
		mutate(o)
	}
	return runGUI(o)
}

func TestGUIFreshInstall(t *testing.T) {
	f := newFakeTrees(t)
	u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgDone, ui.IDCLOSE)
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatal("not installed")
	}
	if got := u.instructions(); strings.Join(got, "|") != dlgMain+"|"+dlgDone {
		t.Fatalf("dialogs: %v (no question about closing Discord when it is not running)", got)
	}
	main := u.shown(dlgMain)[0]
	if len(main.Buttons) != 1 || main.Buttons[0].ID != idInstall || !strings.HasPrefix(main.Buttons[0].Text, "Instalar\n") ||
		!main.CommandLinks || !main.Links || main.Default != idInstall || main.Common != ui.BtnCancel || main.Icon != ui.IconApp {
		t.Fatalf("main dialog: %+v", main)
	}
	contains(t, "content", main.Content, "transmitir a tela para os amigos")
	contains(t, "footer", main.Footer, "Instalador "+version, projectURL, "GPL-3.0")
	done := u.shown(dlgDone)[0]
	contains(t, "done content", done.Content, "Feche o Discord completamente e abra de novo", "Configurações → Vencord → Plugins")
	contains(t, "done details", done.Expanded, "Telinha 0.1.0 (abcdef12) instalado em: Discord.", "Registro: "+filepath.Join(f.appdata, "Telinha", "logs"))
	if strings.Contains(done.Content, "Não instalado em") {
		t.Fatal("nothing was skipped")
	}
	// two progress dialogs: the download (the user may cancel it) and writing the stub (it may not be interrupted)
	if len(u.progresses) != 2 || !u.progresses[0].cancellable || u.progresses[1].cancellable || u.progresses[0].title != title || u.progresses[1].instruction != progInstall {
		t.Fatalf("progress: %+v", u.progresses)
	}
	mustContain(t, f.log(t), "start (gui)", "gui: user chose install/update (already installed: false)", "install: finished", "finished: exit code 0")
}

func TestGUIAlreadyInstalledOffersUpdateAndUninstall(t *testing.T) {
	f := newFakeTrees(t)
	newFakeUI(t).answer(dlgMain, idInstall).answer(dlgDone, ui.IDCLOSE)
	f.gui(t, nil)

	u := newFakeUI(t).answer(dlgMain, ui.IDCANCEL)
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	main := u.shown(dlgMain)[0]
	contains(t, "content", main.Content, "O Telinha já está instalado (versão 0.1.0 (abcdef12))")
	if len(main.Buttons) != 2 || !strings.HasPrefix(main.Buttons[0].Text, "Atualizar ou reparar\n") || main.Buttons[1].ID != idUninstall || !strings.HasPrefix(main.Buttons[1].Text, "Desinstalar\n") {
		t.Fatalf("buttons: %+v", main.Buttons)
	}
	mustContain(t, f.log(t), "cancelled at the main dialog")
	if f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatal("cancelling changed something")
	}
}

func TestGUIDamagedInstallStillShowsTheRecord(t *testing.T) {
	// the Telinha stub is not in Discord any more (Discord updated and dropped it) but install.json says it was
	// there: Desinstalar is still offered, to clean up what is left
	f := newFakeTrees(t)
	newFakeUI(t).answer(dlgMain, idInstall).answer(dlgDone, ui.IDCLOSE)
	f.gui(t, nil)
	os.RemoveAll(filepath.Join(f.appdata, "Telinha", "addon")) // no payload either
	res := filepath.Join(f.discordRoot, "app-1.0.9266", "resources")
	testutil.Write(t, filepath.Join(res, "app.asar"), testutil.Read(t, filepath.Join(f.appdata, "Telinha", "backup", "Discord", "app-1.0.9266.app.asar")))

	u := newFakeUI(t).answer(dlgMain, ui.IDCANCEL)
	f.gui(t, nil)
	main := u.shown(dlgMain)[0]
	if len(main.Buttons) != 2 || main.Buttons[1].ID != idUninstall {
		t.Fatalf("buttons: %+v", main.Buttons)
	}
	if strings.Contains(main.Content, "já está instalado") || !strings.HasPrefix(main.Buttons[0].Text, "Instalar\n") {
		t.Fatalf("not installed any more, only the record remains: %+v", main)
	}
}

func TestGUIInstalledWithoutDiscordStillOffersUninstall(t *testing.T) {
	roaming, _ := sandboxFolders(t) // no Discord found anywhere
	// an install left by an earlier run
	home := filepath.Join(roaming, "Telinha")
	testutil.Payload(t, filepath.Join(home, "addon"), "0.1.0", nil)
	u := newFakeUI(t).answer(dlgMain, ui.IDCANCEL)
	if code := runGUI(&options{appdata: roaming}); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if len(u.shown(dlgNoDiscord)) != 0 || len(u.shown(dlgMain)) != 1 {
		t.Fatalf("an installed add-on without Discord is still managed: %v", u.instructions())
	}
}

func TestGUINoDiscord(t *testing.T) {
	roaming, _ := sandboxFolders(t)
	for name, tc := range map[string]struct {
		button int
		opened []string
	}{
		"opens the download page": {idOpenSite, []string{discordDownloadURL}},
		"closes":                  {ui.IDCLOSE, nil},
		"cancels":                 {ui.IDCANCEL, nil},
	} {
		u := newFakeUI(t).answer(dlgNoDiscord, tc.button)
		if code := runGUI(&options{appdata: roaming}); code != exitNoDiscord {
			t.Errorf("%s: exit code %d", name, code)
		}
		if strings.Join(u.opened, ",") != strings.Join(tc.opened, ",") {
			t.Errorf("%s: opened %v", name, u.opened)
		}
		d := u.shown(dlgNoDiscord)[0]
		if d.Icon != ui.IconWarning || len(d.Buttons) != 1 || d.Buttons[0].ID != idOpenSite || d.Common != ui.BtnClose {
			t.Errorf("%s: %+v", name, d)
		}
	}
	mustContainFile(t, filepath.Join(roaming, "Telinha", "logs", "installer.log"), "no Discord found", "finished: exit code 5")
}

func mustContainFile(t *testing.T, path string, want ...string) {
	t.Helper()
	mustContain(t, string(testutil.Read(t, path)), want...)
}

func TestGUIOldWindows(t *testing.T) {
	f := newFakeTrees(t)
	swap(t, &checkWindows, func() error { return errors.New("Windows 6.1 build 7601") })
	u := newFakeUI(t).answer(dlgOldWindows, ui.IDCLOSE)
	if code := f.gui(t, nil); code != exitFailed {
		t.Fatalf("exit code %d", code)
	}
	d := u.shown(dlgOldWindows)[0]
	if d.Icon != ui.IconError || d.Expanded != "Windows 6.1 build 7601" || !strings.Contains(d.Content, "Windows 10 versão 2004") {
		t.Fatalf("%+v", d)
	}
	if len(u.shown(dlgMain)) != 0 {
		t.Fatal("the main dialog was shown on an unsupported Windows")
	}
	mustContain(t, f.log(t), "unsupported windows: Windows 6.1 build 7601")
}

func TestGUICannotStart(t *testing.T) {
	swap(t, &knownFolderPath, func(*windows.KNOWNFOLDERID, uint32) (string, error) { return "", errors.New("no shell") })
	t.Setenv("APPDATA", "")
	u := newFakeUI(t).answer(dlgCannotInit, ui.IDCLOSE)
	if code := runGUI(&options{}); code != exitFailed {
		t.Fatalf("exit code %d", code)
	}
	d := u.shown(dlgCannotInit)[0]
	if d.Icon != ui.IconError || !strings.Contains(d.Content, "%APPDATA%") {
		t.Fatalf("%+v", d)
	}
}

func TestGUIAutoClickIsOnlyForFakeTrees(t *testing.T) {
	// with --appdata (a fake tree) the self-driving smoke test is honoured
	f := newFakeTrees(t)
	t.Setenv("TELINHA_TEST_AUTOCLICK_MS", "250")
	u := newFakeUI(t).answer(dlgMain, ui.IDCANCEL)
	f.gui(t, nil)
	if ui.AutoClick != 250*time.Millisecond {
		t.Fatalf("AutoClick %v", ui.AutoClick)
	}
	if ui.Logf == nil {
		t.Fatal("the dialogs are not logged")
	}
	mustContain(t, f.log(t), "test: auto-click after 250ms")
	_ = u

	// without it (the real %APPDATA%) it is ignored, so a stray variable can never click through a real install
	roaming, _ := sandboxFolders(t)
	ui.AutoClick = 0
	newFakeUI(t).answer(dlgNoDiscord, ui.IDCLOSE)
	runGUI(&options{})
	if ui.AutoClick != 0 {
		t.Fatalf("AutoClick %v without --appdata", ui.AutoClick)
	}
	if got := string(testutil.Read(t, filepath.Join(roaming, "Telinha", "logs", "installer.log"))); strings.Contains(got, "auto-click") {
		t.Fatalf("log: %s", got)
	}

	// values that are not a positive number of milliseconds are ignored too
	for _, v := range []string{"", "abc", "0", "-5", "1.5"} {
		t.Setenv("TELINHA_TEST_AUTOCLICK_MS", v)
		ui.AutoClick = 0
		g := newFakeTrees(t)
		newFakeUI(t).answer(dlgMain, ui.IDCANCEL)
		g.gui(t, nil)
		if ui.AutoClick != 0 {
			t.Errorf("%q enabled auto-click: %v", v, ui.AutoClick)
		}
	}
}

// ------------------------------------------------------------------------------------------------ install

func TestGUIInstallSkippedDiscords(t *testing.T) {
	f := newFakeTrees(t)
	f.addFlavor(t, "DiscordPTB", false) // a Discord without Vencord: cannot be installed into
	f.addFlavor(t, "DiscordCanary", false)
	u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgDone, ui.IDCLOSE)
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	done := u.shown(dlgDone)[0]
	contains(t, "done", done.Content, "Não instalado em: Discord PTB (app.asar é o original do Discord); Discord Canary (app.asar é o original do Discord).")
	if len(u.shown(dlgPick)) != 0 {
		t.Fatal("one ready Discord needs no question")
	}
}

func TestGUIPickTargets(t *testing.T) {
	cases := map[string]struct {
		button, radio int
		wantStub      map[string]bool // flavor -> has the Telinha stub afterwards
		wantExit      int
		wantLog       string
	}{
		"all":          {ui.IDOK, idAll, map[string]bool{"Discord": true, "DiscordPTB": true}, exitOK, "targets chosen: Discord, Discord PTB"},
		"only the 1st": {ui.IDOK, idOne, map[string]bool{"Discord": true, "DiscordPTB": false}, exitOK, "targets chosen: Discord\n"},
		"only the 2nd": {ui.IDOK, idOne + 1, map[string]bool{"Discord": false, "DiscordPTB": true}, exitOK, "targets chosen: Discord PTB"},
		"no radio":     {ui.IDOK, 0, map[string]bool{"Discord": true, "DiscordPTB": true}, exitOK, "targets chosen: Discord, Discord PTB"},
		"out of range": {ui.IDOK, idOne + 7, map[string]bool{"Discord": true, "DiscordPTB": true}, exitOK, "targets chosen: Discord, Discord PTB"},
		"cancel":       {ui.IDCANCEL, idAll, map[string]bool{"Discord": false, "DiscordPTB": false}, exitOK, "install: cancelled at the target choice"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFakeTrees(t)
			ptb := f.addFlavor(t, "DiscordPTB", true)
			u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgPick, c.button, c.radio).answer(dlgDone, ui.IDCLOSE)
			if code := f.gui(t, nil); code != c.wantExit {
				t.Fatalf("exit code %d", code)
			}
			for flavor, root := range map[string]string{"Discord": f.discordRoot, "DiscordPTB": ptb} {
				got := discord.Inspect(filepath.Join(root, "app-1.0.9266", "resources")).Kind == discord.KindTelinhaStub
				if got != c.wantStub[flavor] {
					t.Errorf("%s: telinha stub = %v", flavor, got)
				}
			}
			mustContain(t, f.log(t), c.wantLog)
			d := u.shown(dlgPick)[0]
			if len(d.Radios) != 3 || d.Radios[0].ID != idAll || d.Radios[0].Text != "Todos (Discord, Discord PTB)" ||
				d.Radios[1].ID != idOne || d.Radios[1].Text != "Só no Discord" || d.Radios[2].ID != idOne+1 || d.Radios[2].Text != "Só no Discord PTB" ||
				d.DefaultRadio != idAll || d.Common != ui.BtnOK|ui.BtnCancel || d.Default != ui.IDOK {
				t.Errorf("picker: %+v", d)
			}
			if c.button == ui.IDCANCEL && (len(u.shown(dlgDone)) != 0 || u.progressed(progInstall) != 0) {
				t.Error("cancelling the choice must stop before anything is downloaded or written")
			}
		})
	}
}

func TestGUIPickTargetsDirectly(t *testing.T) {
	a := &app{}
	one := []core.Target{{Name: "Discord"}}
	if got, ok := a.pickTargets(nil); !ok || len(got) != 0 {
		t.Fatalf("none: %v %v", got, ok)
	}
	if got, ok := a.pickTargets(one); !ok || len(got) != 1 {
		t.Fatalf("one: %v %v", got, ok)
	}
}

func TestGUIInstallCancelledByTheUser(t *testing.T) {
	f := newFakeTrees(t)
	u := newFakeUI(t).answer(dlgMain, idInstall)
	u.onProgress = func(instruction string, cancel func()) {
		if instruction == progInstall && cancel != nil {
			cancel() // the user clicks Cancelar in the progress dialog
		}
	}
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if len(u.shown(dlgDone)) != 0 || len(u.shown(dlgErrInstall)) != 0 {
		t.Fatalf("a cancelled install shows nothing more: %v", u.instructions())
	}
	if f.stubKind(t) != discord.KindVencordStub {
		t.Fatal("stub written after cancelling")
	}
	if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon.new")); err == nil {
		t.Fatal("the staged payload was left behind")
	}
	mustContain(t, f.log(t), "install: cancelled during the download")
}

func TestGUIInstallErrors(t *testing.T) {
	t.Run("Vencord is missing", func(t *testing.T) {
		f := newFakeTrees(t)
		os.RemoveAll(f.discordRoot)
		testutil.DiscordVanilla(t, f.discordRoot, "app-1.0.9266")
		for name, tc := range map[string]struct {
			button int
			opened []string
		}{"opens the Vencord site": {idOpenSite, []string{vencordDownloadURL}}, "closes": {ui.IDCLOSE, nil}} {
			u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgNoVencord, tc.button)
			if code := f.gui(t, nil); code != exitNoVencord {
				t.Fatalf("%s: exit code %d", name, code)
			}
			if strings.Join(u.opened, ",") != strings.Join(tc.opened, ",") {
				t.Errorf("%s: opened %v", name, u.opened)
			}
			d := u.shown(dlgNoVencord)[0]
			if d.Icon != ui.IconWarning || !strings.Contains(d.Content, "Vencord") || !strings.Contains(d.Expanded, "Registro: ") || d.Buttons[0].ID != idOpenSite {
				t.Errorf("%s: %+v", name, d)
			}
		}
	})
	t.Run("the payload is broken", func(t *testing.T) {
		f := newFakeTrees(t)
		u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgErrInstall, ui.IDCLOSE)
		if code := f.gui(t, func(o *options) { o.payload = filepath.Join(f.dir, "missing.zip") }); code != exitFailed {
			t.Fatalf("exit code %d", code)
		}
		d := u.shown(dlgErrInstall)[0]
		if d.Icon != ui.IconError || !strings.Contains(d.Content, "incompleto ou corrompido") || !strings.Contains(d.Expanded, "payload zip:") || !strings.Contains(d.Expanded, "Registro: ") {
			t.Fatalf("%+v", d)
		}
		mustContain(t, f.log(t), "error [payload]")
	})
	t.Run("the download dialog itself fails", func(t *testing.T) {
		f := newFakeTrees(t)
		u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgErrInstall, ui.IDCLOSE)
		u.workErrs[progInstall] = errors.New("the dialog could not open")
		if code := f.gui(t, nil); code != exitFailed {
			t.Fatalf("exit code %d", code)
		}
		d := u.shown(dlgErrInstall)[0]
		if d.Content != "Algo deu errado." || !strings.HasPrefix(d.Expanded, "the dialog could not open\n\nRegistro: ") {
			t.Fatalf("%+v", d)
		}
	})
	t.Run("Discord was uninstalled meanwhile", func(t *testing.T) {
		// guiError routes "no Discord" to the dedicated dialog
		f := newFakeTrees(t)
		a, err := newApp(f.options(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		u := newFakeUI(t).answer(dlgNoDiscord, idOpenSite)
		if code := a.guiError("x", &core.Problem{Code: core.CodeNoDiscord, Msg: "m"}); code != exitNoDiscord {
			t.Fatalf("exit code %d", code)
		}
		if len(u.opened) != 1 || u.opened[0] != discordDownloadURL {
			t.Fatalf("opened %v", u.opened)
		}
	})
	t.Run("Discord is running", func(t *testing.T) {
		f := newFakeTrees(t)
		a, err := newApp(f.options(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer a.finish(0)
		u := newFakeUI(t).answer("Fechar", ui.IDCLOSE)
		if code := a.guiError("Fechar", &core.Problem{Code: core.CodeDiscordRunning, Msg: "O Discord está aberto."}); code != exitDiscordRunning {
			t.Fatalf("exit code %d", code)
		}
		if d := u.shown("Fechar")[0]; d.Content != "O Discord está aberto." || d.Expanded != "Registro: "+a.log.Where() {
			t.Fatalf("%+v", d)
		}
	})
}

func TestGUIDetail(t *testing.T) {
	if got := detail(&core.Problem{Msg: "m"}, `C:\l.log`); got != "Registro: C:\\l.log" {
		t.Fatalf("%q", got)
	}
	if got := detail(&core.Problem{Msg: "m", Err: errors.New("  the cause \n")}, `C:\l.log`); got != "the cause\n\nRegistro: C:\\l.log" {
		t.Fatalf("%q", got)
	}
}

// ----------------------------------------------------------------------------- closing Discord (GUI)

func TestGUIAskCloseDiscord(t *testing.T) {
	t.Run("nothing is running", func(t *testing.T) {
		f := newFakeTrees(t)
		a, _ := newApp(f.options(), nil)
		defer a.finish(0)
		u := newFakeUI(t)
		if ok, err := a.askCloseDiscord("instalar"); !ok || err != nil || len(u.dialogs) != 0 {
			t.Fatalf("%v %v %v", ok, err, u.dialogs)
		}
	})
	t.Run("the process table cannot be read", func(t *testing.T) {
		f := newFakeTrees(t)
		withProcs(t).ListErr = errors.New("snapshot failed")
		a, _ := newApp(f.options(), nil)
		defer a.finish(0)
		newFakeUI(t)
		if ok, err := a.askCloseDiscord("instalar"); !ok || err == nil {
			t.Fatalf("%v %v", ok, err)
		}
	})
	t.Run("the user agrees", func(t *testing.T) {
		f := newFakeTrees(t)
		procs := withProcs(t, f.discordProc(1), f.discordProc(2))
		a, _ := newApp(f.options(), nil)
		defer a.finish(0)
		u := newFakeUI(t).answer(dlgCloseInst, idProceed)
		ok, err := a.askCloseDiscord("instalar")
		if !ok || err != nil || len(procs.Closed) != 2 || u.progressed(progClose) != 1 {
			t.Fatalf("%v %v closed=%v", ok, err, procs.Closed)
		}
		d := u.shown(dlgCloseInst)[0]
		if d.Icon != ui.IconWarning || d.Default != idProceed || len(d.Buttons) != 1 || d.Common != ui.BtnCancel || !strings.Contains(d.Content, "termine antes") {
			t.Fatalf("%+v", d)
		}
		if u.progresses[0].cancellable {
			t.Fatal("closing Discord is not cancellable")
		}
		mustContain(t, f.log(t), "discord running: 2 process(es), asking to close it to instalar", "user agreed to close Discord")
	})
	t.Run("the user says no", func(t *testing.T) {
		f := newFakeTrees(t)
		procs := withProcs(t, f.discordProc(1))
		a, _ := newApp(f.options(), nil)
		defer a.finish(0)
		u := newFakeUI(t).answer(dlgCloseInst, ui.IDCANCEL)
		if ok, err := a.askCloseDiscord("instalar"); ok || err != nil || len(procs.Closed) != 0 || u.progressed(progClose) != 0 {
			t.Fatalf("%v %v", ok, err)
		}
		mustContain(t, f.log(t), "user chose not to close Discord")
	})
	t.Run("Discord does not close", func(t *testing.T) {
		f := newFakeTrees(t)
		procs := withProcs(t, f.discordProc(1))
		procs.Stuck = true
		a, _ := newApp(f.options(), nil)
		defer a.finish(0)
		newFakeUI(t).answer(dlgCloseInst, idProceed)
		ok, err := a.askCloseDiscord("instalar")
		if !ok || core.AsProblem(err).Code != core.CodeDiscordRunning {
			t.Fatalf("%v %v", ok, err)
		}
	})
}

func TestGUIInstallWhileDiscordRuns(t *testing.T) {
	f := newFakeTrees(t)
	procs := withProcs(t, f.discordProc(1))
	u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgCloseInst, idProceed).answer(dlgDone, ui.IDCLOSE)
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if len(procs.Closed) != 1 || f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatalf("closed %v", procs.Closed)
	}
	want := []string{dlgMain, dlgCloseInst, dlgDone}
	if strings.Join(u.instructions(), "|") != strings.Join(want, "|") {
		t.Fatalf("dialogs %v", u.instructions())
	}
}

func TestGUIInstallDiscordRunsAndTheUserKeepsItOpen(t *testing.T) {
	f := newFakeTrees(t)
	withProcs(t, f.discordProc(1))
	u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgCloseInst, ui.IDCANCEL)
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if f.stubKind(t) != discord.KindVencordStub || len(u.shown(dlgDone)) != 0 {
		t.Fatal("nothing may change when the user keeps Discord open")
	}
	mustContain(t, f.log(t), "install: cancelled: the user kept Discord open")
	if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon.new")); err == nil {
		t.Fatal("staged payload left behind")
	}
}

func TestGUIInstallDiscordWillNotClose(t *testing.T) {
	f := newFakeTrees(t)
	withProcs(t, f.discordProc(1)).Stuck = true
	u := newFakeUI(t).answer(dlgMain, idInstall).answer(dlgCloseInst, idProceed).answer(dlgErrInstall, ui.IDCLOSE)
	if code := f.gui(t, nil); code != exitDiscordRunning {
		t.Fatalf("exit code %d", code)
	}
	if d := u.shown(dlgErrInstall)[0]; !strings.Contains(d.Content, "Não foi possível fechar o Discord") {
		t.Fatalf("%+v", d)
	}
}

// ---------------------------------------------------------------------------------------------- uninstall

func installedTrees(t *testing.T) *fakeTrees {
	t.Helper()
	f := newFakeTrees(t)
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatalf("setup: %d %s", code, e)
	}
	return f
}

func TestGUIUninstall(t *testing.T) {
	f := installedTrees(t)
	u := newFakeUI(t).answer(dlgMain, idUninstall).answer(dlgRemoved, ui.IDCLOSE)
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if f.stubKind(t) != discord.KindVencordStub {
		t.Fatal("Vencord's stub was not restored")
	}
	if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon")); err == nil {
		t.Fatal("add-on left behind")
	}
	d := u.shown(dlgRemoved)[0]
	contains(t, "done", d.Content, "O Vencord continua instalado normalmente")
	contains(t, "details", d.Expanded, `Stub do Vencord devolvido em: Discord\app-1.0.9266`, "Registro: ")
	if u.progressed(progRemove) != 1 || u.progresses[0].cancellable {
		t.Fatalf("progress %+v", u.progresses)
	}
	mustContain(t, f.log(t), "gui: user chose uninstall", "uninstall: done")
}

func TestGUIUninstallWhileDiscordRuns(t *testing.T) {
	f := installedTrees(t)
	procs := withProcs(t, f.discordProc(1))
	u := newFakeUI(t).answer(dlgMain, idUninstall).answer(dlgCloseUnin, idProceed).answer(dlgRemoved, ui.IDCLOSE)
	if code := f.gui(t, nil); code != exitOK || len(procs.Closed) != 1 {
		t.Fatalf("exit code %d closed %v", code, procs.Closed)
	}
	_ = u
}

func TestGUIUninstallKeepsDiscordOpen(t *testing.T) {
	f := installedTrees(t)
	withProcs(t, f.discordProc(1))
	newFakeUI(t).answer(dlgMain, idUninstall).answer(dlgCloseUnin, ui.IDCANCEL)
	if code := f.gui(t, nil); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	if f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatal("uninstalled although the user kept Discord open")
	}
	mustContain(t, f.log(t), "cancelled: user kept Discord open")
}

func TestGUIUninstallErrors(t *testing.T) {
	t.Run("the process table cannot be read", func(t *testing.T) {
		f := installedTrees(t)
		withProcs(t).ListErr = errors.New("snapshot failed")
		u := newFakeUI(t).answer(dlgMain, idUninstall).answer(dlgErrUninst, ui.IDCLOSE)
		if code := f.gui(t, nil); code != exitFailed {
			t.Fatalf("exit code %d", code)
		}
		if d := u.shown(dlgErrUninst)[0]; !strings.Contains(d.Expanded, "snapshot failed") {
			t.Fatalf("%+v", d)
		}
	})
	t.Run("the stub cannot be written back", func(t *testing.T) {
		f := installedTrees(t)
		appAsar := filepath.Join(f.discordRoot, "app-1.0.9266", "resources", "app.asar")
		if err := os.Chmod(appAsar, 0o444); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(appAsar, 0o666) })
		u := newFakeUI(t).answer(dlgMain, idUninstall).answer(dlgErrUninst, ui.IDCLOSE)
		if code := f.gui(t, nil); code != exitFailed {
			t.Fatalf("exit code %d", code)
		}
		if d := u.shown(dlgErrUninst)[0]; !strings.Contains(d.Content, "Não foi possível devolver o Discord ao Vencord original") || d.Icon != ui.IconError {
			t.Fatalf("%+v", d)
		}
		if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon")); err != nil {
			t.Fatal("the add-on must stay while the stub points at it")
		}
	})
	t.Run("Discord will not close", func(t *testing.T) {
		f := installedTrees(t)
		withProcs(t, f.discordProc(1)).Stuck = true
		newFakeUI(t).answer(dlgMain, idUninstall).answer(dlgCloseUnin, idProceed).answer(dlgErrUninst, ui.IDCLOSE)
		if code := f.gui(t, nil); code != exitDiscordRunning {
			t.Fatalf("exit code %d", code)
		}
		if f.stubKind(t) != discord.KindTelinhaStub {
			t.Fatal("uninstalled while Discord ran")
		}
	})
	t.Run("the removal dialog itself fails", func(t *testing.T) {
		f := installedTrees(t)
		u := newFakeUI(t).answer(dlgMain, idUninstall).answer(dlgErrUninst, ui.IDCLOSE)
		u.workErrs[progRemove] = errors.New("no window")
		if code := f.gui(t, nil); code != exitFailed {
			t.Fatalf("exit code %d", code)
		}
	})
}
