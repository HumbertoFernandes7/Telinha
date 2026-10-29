// SPDX-License-Identifier: GPL-3.0-or-later
//
// TelinhaInstaller: installs the Telinha add-on into Discord for people who already have the official
// Vencord, keeping Vencord untouched (contract: addon/PAYLOAD.md).
//
// Copyright (c) 2026 Telinha contributors. This program is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later version. Parts are adapted
// from the official Vencord installer (https://github.com/Vencord/Installer, GPL-3.0,
// Copyright (c) 2023 Vendicated and Vencord contributors); see the notes in those files.
//
// Double-click: small native dialog (Instalar / Desinstalar / Cancelar). Command line:
//
//	TelinhaInstaller.exe --status [--json]
//	TelinhaInstaller.exe --install | --repair | --uninstall [--purge] | --rollback  [--yes]
//	    [--payload <zip|folder>] [--sha256 <hex>] [--discord-dir <dir>]... [--appdata <dir>]
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/logx"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/payload"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winproc"
)

// version is set by build.cmd (-ldflags "-X main.version=...").
var version = "0.1.0-dev"

const (
	vencordDownloadURL = "https://vencord.dev/download/"
	discordDownloadURL = "https://discord.com/download"
	projectURL         = "https://github.com/HumbertoFernandes7/Telinha"
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ";") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

type options struct {
	install, uninstall, repair, status, rollback bool
	yes, purge, json, showVersion, allowCustom   bool
	payload, sha256, appdata                     string
	discordDirs                                  multiFlag
}

func parseFlags(args []string, out io.Writer) (*options, error) {
	o := &options{}
	fs := flag.NewFlagSet("TelinhaInstaller", flag.ContinueOnError)
	fs.SetOutput(out)
	fs.BoolVar(&o.install, "install", false, "instala ou atualiza o Telinha (baixa a versão mais recente)")
	fs.BoolVar(&o.uninstall, "uninstall", false, "remove o Telinha e devolve o stub do Vencord")
	fs.BoolVar(&o.repair, "repair", false, "reativa o Telinha com os arquivos já instalados (baixa se faltarem)")
	fs.BoolVar(&o.status, "status", false, "mostra o que está instalado (não altera nada)")
	fs.BoolVar(&o.rollback, "rollback", false, "volta para a versão anterior do Telinha")
	fs.BoolVar(&o.yes, "yes", false, "não perguntar: fecha o Discord se estiver aberto")
	fs.BoolVar(&o.yes, "y", false, "o mesmo que --yes")
	fs.BoolVar(&o.purge, "purge", false, "com --uninstall: apaga também os logs (%APPDATA%\\Telinha inteiro)")
	fs.BoolVar(&o.json, "json", false, "com --status: saída em JSON")
	fs.BoolVar(&o.showVersion, "version", false, "mostra a versão do instalador")
	fs.BoolVar(&o.allowCustom, "allow-custom-vencord", false, "aceita um Vencord fora de %APPDATA%\\Vencord\\dist (desenvolvimento)")
	fs.StringVar(&o.payload, "payload", "", "usa este zip ou pasta do add-on em vez de baixar do GitHub")
	fs.StringVar(&o.sha256, "sha256", "", "SHA-256 esperado do zip passado em --payload")
	fs.StringVar(&o.appdata, "appdata", "", "pasta Roaming a usar no lugar de %APPDATA% (testes)")
	fs.Var(&o.discordDirs, "discord-dir", "pasta de instalação do Discord (com app-*); pode repetir (testes)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("argumento inesperado: %s", fs.Arg(0))
	}
	n := 0
	for _, b := range []bool{o.install, o.uninstall, o.repair, o.status, o.rollback} {
		if b {
			n++
		}
	}
	if n > 1 {
		return nil, fmt.Errorf("use só uma ação: --install, --uninstall, --repair, --status ou --rollback")
	}
	return o, nil
}

func (o *options) cli() bool {
	return o.install || o.uninstall || o.repair || o.status || o.rollback || o.showVersion
}

// app is everything a run needs.
type app struct {
	opt *options
	cfg *core.Config
	log *logx.File
	gh  *payload.Client
}

func knownFolder(id *windows.KNOWNFOLDERID, env string) string {
	if p, err := windows.KnownFolderPath(id, 0); err == nil && p != "" {
		return p
	}
	return os.Getenv(env)
}

func newApp(o *options, extraLog io.Writer) (*app, error) {
	appData := o.appdata
	if appData == "" {
		appData = knownFolder(windows.FOLDERID_RoamingAppData, "APPDATA")
	}
	if appData == "" {
		return nil, fmt.Errorf("não foi possível achar a pasta %%APPDATA%%")
	}
	cfg := &core.Config{
		AppData:            appData,
		VencordDataDir:     os.Getenv("VENCORD_USER_DATA_DIR"),
		AllowCustomVencord: o.allowCustom,
		Procs:              procAdapter{},
		InstallerVersion:   version,
	}
	if len(o.discordDirs) > 0 {
		cfg.Overridden = true
		for _, d := range o.discordDirs {
			cfg.Installs = append(cfg.Installs, discord.FromDir(d))
		}
	} else {
		cfg.Installs = discord.Find(knownFolder(windows.FOLDERID_LocalAppData, "LOCALAPPDATA"))
	}
	lf := logx.Open(cfg.Home()+`\logs`, extraLog)
	cfg.Log = lf.Logger
	mode := "gui"
	if o.cli() {
		mode = "cli"
	}
	lf.Printf("TelinhaInstaller %s start (%s), pid=%d args=%q appdata=%s installs=%d overridden=%v log=%s", version, mode, os.Getpid(), os.Args[1:], appData, len(cfg.Installs), cfg.Overridden, lf.Where())
	for _, in := range cfg.Installs {
		lf.Printf("discord: %s at %s", in.Name, in.Root)
	}
	gh := payload.NewClient("TelinhaInstaller/" + version + " (+" + projectURL + ")")
	return &app{opt: o, cfg: cfg, log: lf, gh: gh}, nil
}

type procAdapter struct{ winproc.System }

func main() {
	opt, err := parseFlags(os.Args[1:], io.Discard)
	if err != nil || (opt != nil && opt.cli()) {
		attachParentConsole()
		if err != nil {
			// re-parse to print usage where the user can see it
			_, err2 := parseFlags(os.Args[1:], os.Stderr)
			if err2 != nil && err2 != flag.ErrHelp {
				fmt.Fprintln(os.Stderr, err2)
			}
			if err == flag.ErrHelp {
				os.Exit(0)
			}
			os.Exit(exitUsage)
		}
		os.Exit(runCLI(opt))
	}
	hideOwnConsole()
	os.Exit(runGUI(opt))
}
