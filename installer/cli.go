// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winver"
)

const (
	exitOK             = 0
	exitFailed         = 1
	exitUsage          = 2
	exitDiscordRunning = 3
	exitNoVencord      = 4
	exitNoDiscord      = 5
)

func runCLI(o *options) (code int) {
	if o.showVersion {
		fmt.Println("TelinhaInstaller", version)
		return exitOK
	}
	a, err := newApp(o, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		return exitFailed
	}
	defer func() { a.finish(code) }()
	if err := winver.Check(); err != nil && !o.status {
		a.log.Printf("unsupported windows: %v", err)
		fmt.Fprintln(os.Stderr, "erro: o Telinha precisa do Windows 10 versão 2004 ou mais recente ("+err.Error()+")")
		return exitFailed
	}
	switch {
	case o.status:
		return a.cliStatus()
	case o.uninstall:
		return a.cliUninstall()
	case o.rollback:
		return a.cliRollback()
	default:
		return a.cliInstall(o.repair)
	}
}

func (a *app) fail(err error) int {
	p := core.AsProblem(err)
	a.log.Printf("error [%s]: %v", p.Code, err)
	fmt.Fprintln(os.Stderr, "erro:", p.Msg)
	if p.Err != nil {
		fmt.Fprintln(os.Stderr, "detalhes:", strings.TrimSpace(p.Err.Error()))
	}
	fmt.Fprintln(os.Stderr, "registro:", a.log.Where())
	switch p.Code {
	case core.CodeDiscordRunning:
		return exitDiscordRunning
	case core.CodeNoVencord:
		fmt.Fprintln(os.Stderr, "Vencord:", vencordDownloadURL)
		return exitNoVencord
	case core.CodeNoDiscord:
		return exitNoDiscord
	}
	return exitFailed
}

// closeDiscordCLI handles a running Discord: --yes closes it, a console asks, otherwise it refuses.
func (a *app) closeDiscordCLI(verb string) error {
	ps, err := a.cfg.RunningProcesses()
	if err != nil || len(ps) == 0 {
		return err
	}
	if !a.opt.yes {
		if !canPrompt() {
			return &core.Problem{Code: core.CodeDiscordRunning, Msg: "O Discord está aberto. Feche-o ou rode de novo com --yes para fechá-lo automaticamente."}
		}
		fmt.Printf("O Discord precisa ser fechado para %s. Fechar agora? [s/N] ", verb)
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if ans := strings.ToLower(strings.TrimSpace(line)); ans != "s" && ans != "sim" && ans != "y" && ans != "yes" {
			return &core.Problem{Code: core.CodeDiscordRunning, Msg: "Cancelado: o Discord continua aberto."}
		}
	}
	fmt.Println("Fechando o Discord…")
	return a.cfg.CloseDiscord(ps)
}

func (a *app) source() core.PayloadSource {
	return core.PayloadSource{Local: a.opt.payload, SHA256: a.opt.sha256, Client: a.gh}
}

func (a *app) cliInstall(repair bool) int {
	res, chosen, err := a.install(context.Background(), repair, installUI{
		say:          func(s string) { fmt.Println(s) },
		closeDiscord: func() (bool, error) { return true, a.closeDiscordCLI("instalar") },
	})
	if err != nil {
		return a.fail(err)
	}
	fmt.Printf("Telinha %s ativo em: %s\n", res.Version, targetNames(chosen))
	for _, t := range res.Targets {
		fmt.Printf("  stub escrito: %s\\%s (antes: %s)\n", t.Flavor, t.App, t.Previous)
	}
	for _, u := range res.Unchanged {
		fmt.Printf("  já estava em dia: %s\n", u)
	}
	fmt.Println("Pronto! Feche o Discord completamente e abra de novo. Depois ative o Telinha em Configurações → Vencord → Plugins.")
	return exitOK
}

func targetNames(ts []core.Target) string {
	var n []string
	for _, t := range ts {
		n = append(n, t.Name)
	}
	return strings.Join(n, ", ")
}

func (a *app) cliUninstall() int {
	a.log.Printf("uninstall: begin (purge=%v)", a.opt.purge)
	if err := a.closeDiscordCLI("desinstalar"); err != nil {
		return a.fail(err)
	}
	res, err := a.cfg.Uninstall()
	if err != nil {
		return a.fail(err)
	}
	for _, r := range res.Restored {
		fmt.Printf("  stub do Vencord devolvido: %s\n", r)
	}
	if a.opt.purge {
		a.log.Printf("purge: removing %s", a.cfg.Home())
		a.log.Close()
		if err := a.cfg.Purge(); err != nil {
			fmt.Fprintln(os.Stderr, "aviso: não foi possível apagar", a.cfg.Home()+":", err)
		}
	}
	fmt.Println("O Telinha foi removido. O Vencord continua instalado normalmente.")
	return exitOK
}

func (a *app) cliRollback() int {
	a.log.Printf("rollback: begin")
	if err := a.closeDiscordCLI("voltar a versão"); err != nil {
		return a.fail(err)
	}
	m, err := a.cfg.Rollback()
	if err != nil {
		return a.fail(err)
	}
	if ready, err := a.cfg.Preflight(); err == nil {
		if _, err := a.cfg.Apply(nil, ready); err != nil {
			return a.fail(err)
		}
	}
	fmt.Printf("Telinha voltou para a versão %s.\n", m.Label())
	return exitOK
}

func (a *app) cliStatus() int {
	s := a.cfg.Status()
	if a.opt.json {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.SetEscapeHTML(false)
		_ = enc.Encode(s)
		return exitOK
	}
	fmt.Println("TelinhaInstaller", version)
	fmt.Println("Pasta do Telinha:", a.cfg.Home())
	switch {
	case s.Payload != nil && s.PayloadError == "":
		fmt.Printf("Add-on: %s (Vencord base %s)\n", s.Payload.Label(), s.Payload.VencordBaseCommit)
	case s.PayloadError != "":
		fmt.Println("Add-on: com problema:", s.PayloadError)
	default:
		fmt.Println("Add-on: não instalado")
	}
	if s.PreviousReady {
		fmt.Println("Versão anterior guardada: sim (--rollback)")
	}
	if len(s.Targets) == 0 {
		fmt.Println("Discord: não encontrado")
	}
	for _, t := range s.Targets {
		line := fmt.Sprintf("%s [%s] %s: %s, %s", t.Name, t.Root, t.App, t.Kind, t.State)
		if t.Patcher != "" {
			line += ", Vencord: " + t.Patcher
		}
		if t.Detail != "" && t.State != core.StateReady {
			line += " (" + t.Detail + ")"
		}
		fmt.Println(line)
	}
	if len(s.Running) > 0 {
		var n []string
		for _, p := range s.Running {
			n = append(n, fmt.Sprintf("%s(%d)", p.Name, p.PID))
		}
		fmt.Println("Abertos agora:", strings.Join(n, ", "))
	}
	if err := winver.Check(); err != nil {
		fmt.Println("Windows sem suporte:", err)
	}
	return exitOK
}
