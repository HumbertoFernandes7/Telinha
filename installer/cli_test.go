// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

// None of these tests touches the real machine: the trees are fake, the process table is fake, nothing
// can reach the network (see TestMain).

func (f *fakeTrees) stubKind(t *testing.T) discord.Kind {
	t.Helper()
	return discord.Inspect(filepath.Join(f.discordRoot, "app-1.0.9266", "resources")).Kind
}

func TestCLIVersion(t *testing.T) {
	out, errOut := capture(t, func() {
		if code := runCLI(&options{showVersion: true}); code != exitOK {
			t.Errorf("exit code %d", code)
		}
	})
	if strings.TrimSpace(out) != "TelinhaInstaller "+version || errOut != "" {
		t.Fatalf("stdout %q stderr %q", out, errOut)
	}
}

func TestCLINoAppDataFolder(t *testing.T) {
	swap(t, &knownFolderPath, func(*windows.KNOWNFOLDERID, uint32) (string, error) { return "", errors.New("no shell") })
	t.Setenv("APPDATA", "")
	var code int
	_, errOut := capture(t, func() { code = runCLI(&options{status: true}) })
	if code != exitFailed || !strings.Contains(errOut, "erro: não foi possível achar a pasta %APPDATA%") {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
}

func TestCLIOldWindows(t *testing.T) {
	f := newFakeTrees(t)
	swap(t, &checkWindows, func() error { return errors.New("Windows 6.3 build 9600") })

	// every action that changes something refuses...
	for _, args := range [][]string{{"--install", "--payload", f.zip}, {"--repair"}, {"--uninstall"}, {"--rollback"}} {
		code, _, errOut := f.cli(t, args...)
		if code != exitFailed || !strings.Contains(errOut, "Windows 10 versão 2004") || !strings.Contains(errOut, "Windows 6.3 build 9600") {
			t.Errorf("%v: code %d stderr %q", args, code, errOut)
		}
	}
	if f.stubKind(t) != discord.KindVencordStub {
		t.Fatal("the stub was touched on an unsupported Windows")
	}
	mustContain(t, f.log(t), "unsupported windows: Windows 6.3 build 9600")

	// ...but --status still tells what it can, and adds the warning
	code, out, errOut := f.cli(t, "--status")
	if code != exitOK || errOut != "" {
		t.Fatalf("status: %d %q", code, errOut)
	}
	contains(t, "status", out, "Windows sem suporte: Windows 6.3 build 9600", "Discord [")
	// the JSON form has no such line: it is data
	_, out, _ = f.cli(t, "--status", "--json")
	if strings.Contains(out, "Windows sem suporte") {
		t.Fatalf("json: %s", out)
	}
}

// -------------------------------------------------------------------------------------------------- status

func TestCLIStatusText(t *testing.T) {
	f := newFakeTrees(t)

	code, out, _ := f.cli(t, "--status")
	if code != exitOK {
		t.Fatalf("code %d", code)
	}
	contains(t, "fresh status", out,
		"TelinhaInstaller "+version,
		"Pasta do Telinha: "+filepath.Join(f.appdata, "Telinha"),
		"Add-on: não instalado",
		"Discord ["+f.discordRoot+"] app-1.0.9266: vencord-stub, ready, Vencord: "+filepath.Join(f.appdata, "Vencord", "dist", "patcher.js"))
	if strings.Contains(out, "Versão anterior") || strings.Contains(out, "Abertos agora") {
		t.Fatalf("fresh status shows too much:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "install.json")); err == nil {
		t.Fatal("--status wrote something")
	}

	// installed, twice (so there is a previous version), with a Discord running
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.payloadZip(t, "0.2.0")); code != exitOK {
		t.Fatal(e)
	}
	withProcs(t, f.discordProc(4242))
	_, out, _ = f.cli(t, "--status")
	contains(t, "installed status", out,
		"Add-on: 0.2.0 (abcdef12) (Vencord base 443688b5)",
		"Versão anterior guardada: sim (--rollback)",
		"app-1.0.9266: telinha-stub, ready, Vencord:",
		"Abertos agora: Discord.exe(4242)")
}

func TestCLIStatusExplainsProblems(t *testing.T) {
	f := newFakeTrees(t)
	f.addFlavor(t, "DiscordPTB", false) // a plain Discord: Vencord is not there
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	_, out, _ := f.cli(t, "--status")
	contains(t, "status", out, "no-vencord (app.asar é o original do Discord)")

	// installed files that no longer match version.json
	testutil.Write(t, filepath.Join(f.appdata, "Telinha", "addon", "main.js"), []byte("tampered"))
	_, out, _ = f.cli(t, "--status")
	contains(t, "damaged add-on", out, "Add-on: com problema:", "main.js")
}

func TestCLIStatusWithoutDiscord(t *testing.T) {
	roaming, _ := sandboxFolders(t) // no Discord anywhere
	var code int
	out, _ := capture(t, func() { code = runCLI(&options{status: true, appdata: roaming}) })
	if code != exitOK {
		t.Fatalf("code %d", code)
	}
	contains(t, "status", out, "Discord: não encontrado", "Add-on: não instalado")
}

func TestCLIStatusJSON(t *testing.T) {
	f := newFakeTrees(t)
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	withProcs(t, f.discordProc(7))
	code, out, errOut := f.cli(t, "--status", "--json")
	if code != exitOK || errOut != "" {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	var s struct {
		Discord []struct {
			Flavor, Name, Root, App, Resources, Kind, State string
			VencordPatcher                                  string `json:"vencordPatcher"`
		} `json:"discord"`
		Payload struct {
			Version, Commit string
			Files           map[string]any
		} `json:"payload"`
		RollbackAvailable bool `json:"rollbackAvailable"`
		Install           struct {
			Version string
			Targets []struct{ Flavor, App string }
			Source  struct{ Kind, Path string }
		} `json:"install"`
		Running []struct {
			PID  uint32
			Name string
		} `json:"running"`
	}
	if err := json.Unmarshal([]byte(out), &s); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, out)
	}
	if len(s.Discord) != 1 || s.Discord[0].State != "ready" || s.Discord[0].Kind != "telinha-stub" || s.Discord[0].App != "app-1.0.9266" || s.Discord[0].Root != f.discordRoot {
		t.Fatalf("discord: %+v", s.Discord)
	}
	if s.Payload.Version != "0.1.0" || s.Payload.Commit != "abcdef12" || len(s.Payload.Files) == 0 || s.RollbackAvailable {
		t.Fatalf("payload: %+v", s)
	}
	if s.Install.Version != "0.1.0" || len(s.Install.Targets) != 1 || s.Install.Source.Kind != "local" || s.Install.Source.Path != f.zip {
		t.Fatalf("install: %+v", s.Install)
	}
	if len(s.Running) != 1 || s.Running[0].PID != 7 || s.Running[0].Name != "Discord.exe" {
		t.Fatalf("running: %+v", s.Running)
	}
	// paths keep their backslashes and no HTML escaping (someone parses this with jq)
	if strings.Contains(out, `\u003c`) || strings.Contains(out, `\u0026`) || !strings.HasPrefix(out, "{\n  ") {
		t.Fatalf("formatting:\n%s", out)
	}
}

// ------------------------------------------------------------------------------------------------- install

func TestCLIInstallOutput(t *testing.T) {
	f := newFakeTrees(t)
	f.addFlavor(t, "DiscordPTB", true)
	code, out, errOut := f.cli(t, "--install", "--payload", f.zip) // no --yes needed: nothing is running
	if code != exitOK || errOut != "" {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "install output", out,
		"Telinha 0.1.0 (abcdef12) ativo em: Discord, Discord PTB",
		`  stub escrito: Discord\app-1.0.9266 (antes: vencord-stub)`,
		`  stub escrito: DiscordPTB\app-1.0.9266 (antes: vencord-stub)`,
		"Pronto! Feche o Discord completamente")
	if strings.Contains(out, "já estava em dia") {
		t.Fatalf("first run:\n%s", out)
	}

	// the same again: nothing to write
	code, out, _ = f.cli(t, "--install", "--payload", f.zip)
	if code != exitOK {
		t.Fatalf("second run: %d", code)
	}
	contains(t, "second run", out, `  já estava em dia: Discord\app-1.0.9266`, `  já estava em dia: DiscordPTB\app-1.0.9266`)
	if strings.Contains(out, "stub escrito") {
		t.Fatalf("second run wrote again:\n%s", out)
	}
}

func TestCLIRepairUsesTheInstalledFiles(t *testing.T) {
	f := newFakeTrees(t)
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	// the Vencord installer's "Repair" put its stub back
	res := filepath.Join(f.discordRoot, "app-1.0.9266", "resources")
	testutil.Write(t, filepath.Join(res, "app.asar"), asar.VencordStub(filepath.Join(f.appdata, "Vencord", "dist", "patcher.js")))

	code, out, errOut := f.cli(t, "--repair") // no --payload: no download, nothing to reach (the network is blocked)
	if code != exitOK || errOut != "" {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "repair", out, "stub escrito: Discord", "Pronto!")
	if f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatal("repair did not put the Telinha stub back")
	}
	mustContain(t, f.log(t), "install: repair with the files already installed (nothing to download)")
}

func TestCLIRepairWithoutInstalledFilesNeedsTheNetwork(t *testing.T) {
	f := newFakeTrees(t)
	code, _, errOut := f.cli(t, "--repair") // nothing installed: it has to download, and the test network is closed
	if code != exitFailed {
		t.Fatalf("code %d", code)
	}
	contains(t, "stderr", errOut, "erro: Não foi possível falar com o GitHub", "detalhes:", "registro: "+filepath.Join(f.appdata, "Telinha", "logs"))
	if f.stubKind(t) != discord.KindVencordStub {
		t.Fatal("a failed download changed the stub")
	}
}

func TestCLIInstallFailures(t *testing.T) {
	t.Run("Vencord is not installed", func(t *testing.T) {
		f := newFakeTrees(t)
		os.RemoveAll(filepath.Join(f.discordRoot))
		testutil.DiscordVanilla(t, f.discordRoot, "app-1.0.9266")
		code, _, errOut := f.cli(t, "--install", "--yes", "--payload", f.zip)
		if code != exitNoVencord {
			t.Fatalf("code %d", code)
		}
		contains(t, "stderr", errOut, "erro: O Telinha funciona junto com o Vencord oficial", "Vencord: "+vencordDownloadURL, "registro:")
	})
	t.Run("Discord is not installed", func(t *testing.T) {
		roaming, _ := sandboxFolders(t)
		var code int
		_, errOut := capture(t, func() { code = runCLI(&options{install: true, yes: true, appdata: roaming}) })
		if code != exitNoDiscord || !strings.Contains(errOut, "Não encontramos o Discord") {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
	})
	t.Run("the payload cannot be used", func(t *testing.T) {
		f := newFakeTrees(t)
		code, _, errOut := f.cli(t, "--install", "--yes", "--payload", filepath.Join(f.dir, "missing.zip"))
		if code != exitFailed {
			t.Fatalf("code %d", code)
		}
		contains(t, "stderr", errOut, "erro: O pacote do Telinha está incompleto ou corrompido", "detalhes: payload zip:", "registro:")
		mustContain(t, f.log(t), "error [payload]", "finished: exit code 1")
	})
	t.Run("the SHA-256 does not match", func(t *testing.T) {
		f := newFakeTrees(t)
		code, _, errOut := f.cli(t, "--install", "--yes", "--payload", f.zip, "--sha256", strings.Repeat("0", 64))
		if code != exitFailed || !strings.Contains(errOut, "não confere com o SHA-256 informado") {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
		if f.stubKind(t) != discord.KindVencordStub {
			t.Fatal("stub changed")
		}
	})
	t.Run("the SHA-256 matches", func(t *testing.T) {
		f := newFakeTrees(t)
		code, _, errOut := f.cli(t, "--install", "--yes", "--payload", f.zip, "--sha256", testutil.SHA256(t, f.zip))
		if code != exitOK {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
	})
}

func TestCLIFailMapsEveryProblem(t *testing.T) {
	f := newFakeTrees(t)
	a, err := newApp(f.options(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.finish(exitFailed)
	inner := errors.New("disk on fire\n")
	for _, c := range []struct {
		err      error
		code     int
		stderr   []string
		notInErr []string
	}{
		{&core.Problem{Code: core.CodeDiscordRunning, Msg: "Feche o Discord."}, exitDiscordRunning, []string{"erro: Feche o Discord.", "registro: " + a.log.Where()}, []string{"detalhes", "Vencord:"}},
		{&core.Problem{Code: core.CodeNoVencord, Msg: "Instale o Vencord.", Err: inner}, exitNoVencord, []string{"erro: Instale o Vencord.", "detalhes: disk on fire\n", "Vencord: " + vencordDownloadURL}, nil},
		{&core.Problem{Code: core.CodeNoDiscord, Msg: "Instale o Discord."}, exitNoDiscord, []string{"erro: Instale o Discord."}, []string{"Vencord:"}},
		{&core.Problem{Code: core.CodePayload, Msg: "Pacote ruim.", Err: inner}, exitFailed, []string{"erro: Pacote ruim.", "detalhes: disk on fire"}, nil},
		{&core.Problem{Code: core.CodeNotInstalled, Msg: "Use Instalar."}, exitFailed, []string{"erro: Use Instalar."}, nil},
		{fmt.Errorf("wrapped: %w", &core.Problem{Code: core.CodeDiscordRunning, Msg: "dentro"}), exitDiscordRunning, []string{"erro: dentro"}, nil},
		{errors.New("plain failure"), exitFailed, []string{"erro: Algo deu errado.", "detalhes: plain failure"}, nil},
	} {
		var code int
		_, errOut := capture(t, func() { code = a.fail(c.err) })
		if code != c.code {
			t.Errorf("%v: exit code %d, want %d", c.err, code, c.code)
		}
		contains(t, fmt.Sprint(c.err), errOut, c.stderr...)
		for _, n := range c.notInErr {
			if strings.Contains(errOut, n) {
				t.Errorf("%v: stderr has %q:\n%s", c.err, n, errOut)
			}
		}
	}
	mustContain(t, f.log(t), "error [discord-running]", "error [no-vencord]", "error [no-discord]", "error [payload]", "error [failed]")
}

func TestExitCodesAreStable(t *testing.T) {
	// scripts depend on these numbers (documented in the README)
	if exitOK != 0 || exitFailed != 1 || exitUsage != 2 || exitDiscordRunning != 3 || exitNoVencord != 4 || exitNoDiscord != 5 {
		t.Fatal("exit codes changed")
	}
}

// ------------------------------------------------------------------------------------ closing Discord (CLI)

func TestCLICloseDiscordWithYes(t *testing.T) {
	f := newFakeTrees(t)
	procs := withProcs(t, f.discordProc(10), f.discordProc(11))
	setStdin(t, nil) // nobody to ask
	code, out, errOut := f.cli(t, "--install", "--yes", "--payload", f.zip)
	if code != exitOK {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "stdout", out, "Fechando o Discord…")
	if strings.Contains(out, "[s/N]") {
		t.Fatal("--yes must not ask")
	}
	if len(procs.Closed) != 2 {
		t.Fatalf("closed %v", procs.Closed)
	}
	mustContain(t, f.log(t), "closing 2 process(es): Discord.exe(10), Discord.exe(11)")
	// -y is the same
	f2 := newFakeTrees(t)
	withProcs(t, f2.discordProc(12))
	if code, _, e := f2.cli(t, "-y", "--install", "--payload", f2.zip); code != exitOK {
		t.Fatalf("-y: %d %s", code, e)
	}
}

func TestCLICloseDiscordAsksOnAConsole(t *testing.T) {
	for _, answer := range []string{"s", "S", "sim", "Sim", " SIM ", "y", "yes", "YES"} {
		f := newFakeTrees(t)
		procs := withProcs(t, f.discordProc(20))
		setStdin(t, typed(answer+"\r\n"))
		code, out, errOut := f.cli(t, "--install", "--payload", f.zip)
		if code != exitOK {
			t.Errorf("%q: code %d stderr %q", answer, code, errOut)
			continue
		}
		contains(t, "prompt", out, "O Discord precisa ser fechado para instalar. Fechar agora? [s/N] ", "Fechando o Discord…")
		if len(procs.Closed) != 1 {
			t.Errorf("%q: closed %v", answer, procs.Closed)
		}
	}
	for _, answer := range []string{"n", "N", "não", "nao", "", "\n", "talvez", "ss", "yep"} {
		f := newFakeTrees(t)
		procs := withProcs(t, f.discordProc(21))
		setStdin(t, typed(answer))
		code, out, errOut := f.cli(t, "--install", "--payload", f.zip)
		if code != exitDiscordRunning {
			t.Errorf("%q: code %d", answer, code)
			continue
		}
		contains(t, "prompt", out, "[s/N]")
		contains(t, "stderr", errOut, "erro: Cancelado: o Discord continua aberto.")
		if len(procs.Closed) != 0 || f.stubKind(t) != discord.KindVencordStub {
			t.Errorf("%q: Discord was closed or the stub written", answer)
		}
	}
}

func TestCLICloseDiscordWithoutAConsole(t *testing.T) {
	f := newFakeTrees(t)
	procs := withProcs(t, f.discordProc(30))
	setStdin(t, nil)
	code, out, errOut := f.cli(t, "--install", "--payload", f.zip)
	if code != exitDiscordRunning {
		t.Fatalf("code %d", code)
	}
	if strings.Contains(out, "[s/N]") || !strings.Contains(errOut, "rode de novo com --yes") {
		t.Fatalf("stdout %q stderr %q", out, errOut)
	}
	if len(procs.Closed) != 0 {
		t.Fatal("closed Discord without being allowed to")
	}
}

func TestCLICloseDiscordFailures(t *testing.T) {
	t.Run("Discord will not close", func(t *testing.T) {
		f := newFakeTrees(t)
		procs := withProcs(t, f.discordProc(40))
		procs.Stuck = true
		code, _, errOut := f.cli(t, "--install", "--yes", "--payload", f.zip)
		if code != exitDiscordRunning || !strings.Contains(errOut, "Não foi possível fechar o Discord") {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
		if f.stubKind(t) != discord.KindVencordStub {
			t.Fatal("stub written while Discord ran")
		}
		if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon.new")); err == nil {
			t.Fatal("the staged payload was left behind")
		}
	})
	t.Run("the process table cannot be read", func(t *testing.T) {
		f := newFakeTrees(t)
		withProcs(t).ListErr = errors.New("snapshot failed")
		code, _, errOut := f.cli(t, "--install", "--yes", "--payload", f.zip)
		if code != exitFailed || !strings.Contains(errOut, "snapshot failed") {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
	})
}

// ------------------------------------------------------------------------------------------------ uninstall

func TestCLIUninstall(t *testing.T) {
	f := newFakeTrees(t)
	f.addFlavor(t, "DiscordPTB", true)
	original := testutil.Read(t, filepath.Join(f.discordRoot, "app-1.0.9266", "resources", "app.asar"))
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	testutil.Write(t, filepath.Join(f.appdata, "Telinha", "logs", "keep.txt"), []byte("kept"))

	code, out, errOut := f.cli(t, "--uninstall")
	if code != exitOK || errOut != "" {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "uninstall", out,
		`  stub do Vencord devolvido: Discord\app-1.0.9266`, `  stub do Vencord devolvido: DiscordPTB\app-1.0.9266`,
		"O Telinha foi removido. O Vencord continua instalado normalmente.")
	if got := testutil.Read(t, filepath.Join(f.discordRoot, "app-1.0.9266", "resources", "app.asar")); string(got) != string(original) {
		t.Fatal("uninstall is not byte-identical")
	}
	for _, gone := range []string{"addon", "backup", "install.json"} {
		if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", gone)); err == nil {
			t.Errorf("%s left behind", gone)
		}
	}
	if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "logs", "keep.txt")); err != nil {
		t.Fatal("logs must survive a plain uninstall")
	}
	mustContain(t, f.log(t), "uninstall: begin (purge=false)", "uninstall: done")
}

func TestCLIUninstallPurge(t *testing.T) {
	f := newFakeTrees(t)
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	code, out, errOut := f.cli(t, "--uninstall", "--purge")
	if code != exitOK || errOut != "" {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "uninstall", out, "O Telinha foi removido.")
	if _, err := os.Stat(filepath.Join(f.appdata, "Telinha")); err == nil {
		t.Fatal("--purge left %APPDATA%\\Telinha behind (the log must not recreate it)")
	}
	if _, err := os.Stat(filepath.Join(f.appdata, "Vencord")); err != nil {
		t.Fatal("Vencord was touched")
	}
}

func TestCLIUninstallPurgeCannotDeleteEverything(t *testing.T) {
	f := newFakeTrees(t)
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	held := filepath.Join(f.appdata, "Telinha", "logs", "other.log")
	testutil.Write(t, held, []byte("another program writes here"))
	testutil.HoldFile(t, held)
	code, out, errOut := f.cli(t, "--uninstall", "--purge")
	if code != exitOK {
		t.Fatalf("a purge that fails is a warning, not an error: %d", code)
	}
	contains(t, "stderr", errOut, "aviso: não foi possível apagar "+filepath.Join(f.appdata, "Telinha"))
	contains(t, "stdout", out, "O Telinha foi removido.")
	if f.stubKind(t) != discord.KindVencordStub {
		t.Fatal("the stub was not restored")
	}
}

func TestCLIUninstallFailures(t *testing.T) {
	t.Run("Discord is running and nobody can be asked", func(t *testing.T) {
		f := newFakeTrees(t)
		if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
			t.Fatal(e)
		}
		withProcs(t, f.discordProc(50))
		setStdin(t, nil)
		code, _, errOut := f.cli(t, "--uninstall")
		if code != exitDiscordRunning || !strings.Contains(errOut, "--yes") {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
		if f.stubKind(t) != discord.KindTelinhaStub {
			t.Fatal("uninstalled while Discord ran")
		}
	})
	t.Run("the stub cannot be written back", func(t *testing.T) {
		f := newFakeTrees(t)
		if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
			t.Fatal(e)
		}
		appAsar := filepath.Join(f.discordRoot, "app-1.0.9266", "resources", "app.asar")
		if err := os.Chmod(appAsar, 0o444); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(appAsar, 0o666) })
		code, _, errOut := f.cli(t, "--uninstall", "--yes")
		if code != exitFailed || !strings.Contains(errOut, "Não foi possível devolver o Discord ao Vencord original") {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
		if _, err := os.Stat(filepath.Join(f.appdata, "Telinha", "addon")); err != nil {
			t.Fatal("the add-on must stay while the stub still points at it")
		}
	})
}

// -------------------------------------------------------------------------------------------------- rollback

func TestCLIRollback(t *testing.T) {
	f := newFakeTrees(t)
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.payloadZip(t, "0.2.0")); code != exitOK {
		t.Fatal(e)
	}
	code, out, errOut := f.cli(t, "--rollback")
	if code != exitOK || errOut != "" {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "rollback", out, "Telinha voltou para a versão 0.1.0 (abcdef12).")
	rec, _ := (&core.Config{AppData: f.appdata}).ReadRecord()
	if rec == nil || rec.Version != "0.1.0" {
		t.Fatalf("install.json must follow the rollback: %+v", rec)
	}
	if f.stubKind(t) != discord.KindTelinhaStub {
		t.Fatal("the stub is gone")
	}
	mustContain(t, f.log(t), "rollback: begin", "rollback: now 0.1.0")
}

func TestCLIRollbackFailures(t *testing.T) {
	t.Run("there is no previous version", func(t *testing.T) {
		f := newFakeTrees(t)
		if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
			t.Fatal(e)
		}
		code, _, errOut := f.cli(t, "--rollback")
		if code != exitFailed || !strings.Contains(errOut, "Não há uma versão anterior do Telinha para voltar.") {
			t.Fatalf("code %d stderr %q", code, errOut)
		}
	})
	t.Run("Discord is running and nobody can be asked", func(t *testing.T) {
		f := newFakeTrees(t)
		withProcs(t, f.discordProc(60))
		setStdin(t, nil)
		code, _, _ := f.cli(t, "--rollback")
		if code != exitDiscordRunning {
			t.Fatalf("code %d", code)
		}
	})
}

// The payload that rollback brings back has a stub template that cannot be rendered, so the step that writes
// the stub again fails: reported as an error, not swallowed.
func TestCLIRollbackApplyFails(t *testing.T) {
	f := newFakeTrees(t)
	home := filepath.Join(f.appdata, "Telinha")
	good := filepath.Join(f.dir, "payload-good")
	testutil.Payload(t, good, "0.1.0", nil)
	bad := filepath.Join(f.dir, "payload-bad")
	testutil.Payload(t, bad, "0.0.9", map[string]string{"stub-template.js": "// Telinha stub v1\nno placeholders\n"})
	// addon = good, addon.prev = bad: built by hand, as if the bad one had been installed first
	for dir, name := range map[string]string{bad: "addon.prev", good: "addon"} {
		if err := copyDir(dir, filepath.Join(home, name)); err != nil {
			t.Fatal(err)
		}
	}
	code, _, errOut := f.cli(t, "--rollback")
	if code != exitFailed || !strings.Contains(errOut, "Não foi possível ativar o Telinha em todos os Discords") {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "stderr", errOut, "placeholder")
}

func copyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// Rolling back without a working Vencord still restores the files (the stub is left alone: Preflight fails).
func TestCLIRollbackWithoutVencordStillSwapsFiles(t *testing.T) {
	f := newFakeTrees(t)
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.zip); code != exitOK {
		t.Fatal(e)
	}
	if code, _, e := f.cli(t, "--install", "--yes", "--payload", f.payloadZip(t, "0.2.0")); code != exitOK {
		t.Fatal(e)
	}
	os.RemoveAll(filepath.Join(f.appdata, "Vencord")) // Vencord's files vanished
	code, out, errOut := f.cli(t, "--rollback")
	if code != exitOK || errOut != "" {
		t.Fatalf("code %d stderr %q", code, errOut)
	}
	contains(t, "rollback", out, "Telinha voltou para a versão 0.1.0")
	if m, err := (&core.Config{AppData: f.appdata}).ReadRecord(); err != nil || m == nil || m.Version != "0.2.0" {
		t.Fatalf("install.json is only rewritten when the stub could be written again: %+v %v", m, err)
	}
}

// ----------------------------------------------------------------------------------------- small pure pieces

func TestTargetNamesAndSource(t *testing.T) {
	if got := targetNames(nil); got != "" {
		t.Fatalf("%q", got)
	}
	ts := []core.Target{{Name: "Discord"}, {Name: "Discord PTB"}, {Name: "Discord Canary"}}
	if got := targetNames(ts); got != "Discord, Discord PTB, Discord Canary" {
		t.Fatalf("%q", got)
	}
	f := newFakeTrees(t)
	o := f.options()
	o.payload, o.sha256 = f.zip, strings.Repeat("a", 64)
	a, err := newApp(o, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.finish(0)
	if src := a.source(); src.Local != f.zip || src.SHA256 != o.sha256 || src.Client != a.gh {
		t.Fatalf("%+v", src)
	}
}
