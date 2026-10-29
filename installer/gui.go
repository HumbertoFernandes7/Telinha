// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/ui"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winver"
)

const (
	title = "Instalador do Telinha"

	idInstall   = 101
	idUninstall = 102
	idProceed   = 103
	idOpenSite  = 104
	idAll       = 200
	idOne       = 201 // + index
)

func runGUI(o *options) int {
	a, err := newApp(o, nil)
	if err != nil {
		ui.Show(ui.Dialog{Title: title, Instruction: "Não foi possível iniciar o instalador", Content: err.Error(), Icon: ui.IconError, Common: ui.BtnClose})
		return exitFailed
	}
	defer func() { a.log.Close() }()
	ui.Logf = a.log.Printf
	// Self-driving smoke test (fake trees only: honoured only together with --appdata).
	if ms, err := strconv.Atoi(os.Getenv("TELINHA_TEST_AUTOCLICK_MS")); err == nil && ms > 0 && o.appdata != "" {
		ui.AutoClick = time.Duration(ms) * time.Millisecond
		a.log.Printf("test: auto-click after %v", ui.AutoClick)
	}

	if err := winver.Check(); err != nil {
		a.log.Printf("unsupported windows: %v", err)
		ui.Show(ui.Dialog{Title: title, Icon: ui.IconError, Common: ui.BtnClose,
			Instruction: "Este Windows é antigo demais para o Telinha",
			Content:     "O Telinha precisa do Windows 10 versão 2004 ou mais recente (ou do Windows 11). Atualize o Windows pelo Windows Update e tente de novo.",
			Expanded:    err.Error()})
		return exitFailed
	}

	s := a.cfg.Status()
	installed := s.Installed() || a.cfg.PayloadOK()
	if len(s.Targets) == 0 && !installed {
		return a.guiNoDiscord()
	}

	content := "O Telinha deixa você transmitir a tela para os amigos da call e assistir direto no Discord, de PC para PC.\n\n" +
		"Ele é um complemento do Vencord: o Vencord que você já tem continua do mesmo jeito, só ganha o Telinha."
	install := ui.Button{ID: idInstall, Text: "Instalar\nBaixa a versão mais recente do Telinha e ativa no Discord."}
	if installed {
		v := "?"
		if s.Payload != nil {
			v = s.Payload.Label()
		}
		content = "O Telinha já está instalado (versão " + v + ").\n\nVocê pode atualizar/reparar a instalação ou remover o Telinha."
		install.Text = "Atualizar ou reparar\nBaixa a versão mais recente e ativa o Telinha de novo no Discord."
	}
	buttons := []ui.Button{install}
	if installed || s.Record != nil {
		buttons = append(buttons, ui.Button{ID: idUninstall, Text: "Desinstalar\nRemove o Telinha. O Vencord continua instalado normalmente."})
	}
	choice, _ := ui.Show(ui.Dialog{
		Title: title, Instruction: "Telinha para Discord", Content: content, Icon: ui.IconApp,
		Buttons: buttons, CommandLinks: true, Common: ui.BtnCancel, Default: idInstall, Links: true,
		Footer: "Instalador " + version + " · software livre (GPL-3.0) · <a href=\"" + projectURL + "\">página do projeto</a>",
	})
	switch choice {
	case idInstall:
		return a.guiInstall()
	case idUninstall:
		return a.guiUninstall()
	}
	a.log.Printf("cancelled at the main dialog")
	return exitOK
}

func (a *app) guiNoDiscord() int {
	a.log.Printf("no Discord found")
	r, _ := ui.Show(ui.Dialog{Title: title, Icon: ui.IconWarning, Common: ui.BtnClose, CommandLinks: true,
		Instruction: "Não encontramos o Discord",
		Content:     "Instale o Discord, abra-o uma vez e rode este instalador de novo.\n\nDepois você também vai precisar do Vencord oficial (vencord.dev).",
		Buttons:     []ui.Button{{ID: idOpenSite, Text: "Abrir o site do Discord"}}})
	if r == idOpenSite {
		ui.OpenURL(discordDownloadURL)
	}
	return exitNoDiscord
}

func (a *app) guiError(what string, err error) int {
	p := core.AsProblem(err)
	a.log.Printf("error [%s]: %v", p.Code, err)
	if p.Code == core.CodeNoVencord {
		r, _ := ui.Show(ui.Dialog{Title: title, Icon: ui.IconWarning, Common: ui.BtnClose, CommandLinks: true,
			Instruction: "Primeiro instale o Vencord",
			Content:     p.Msg,
			Buttons:     []ui.Button{{ID: idOpenSite, Text: "Abrir o site do Vencord\nvencord.dev/download: baixe e rode o instalador do Vencord."}},
			Expanded:    detail(p, a.log.Path)})
		if r == idOpenSite {
			ui.OpenURL(vencordDownloadURL)
		}
		return exitNoVencord
	}
	if p.Code == core.CodeNoDiscord {
		return a.guiNoDiscord()
	}
	ui.Show(ui.Dialog{Title: title, Icon: ui.IconError, Common: ui.BtnClose,
		Instruction: what, Content: p.Msg, Expanded: detail(p, a.log.Path)})
	if p.Code == core.CodeDiscordRunning {
		return exitDiscordRunning
	}
	return exitFailed
}

func detail(p *core.Problem, logPath string) string {
	d := ""
	if p.Err != nil {
		d = strings.TrimSpace(p.Err.Error()) + "\n\n"
	}
	return d + "Registro: " + logPath
}

// pickTargets lets the user choose when Telinha can go into more than one Discord.
func (a *app) pickTargets(ready []core.Target) ([]core.Target, bool) {
	if len(ready) < 2 {
		return ready, true
	}
	radios := []ui.Button{{ID: idAll, Text: "Todos (" + targetNames(ready) + ")"}}
	for i, t := range ready {
		radios = append(radios, ui.Button{ID: idOne + i, Text: "Só no " + t.Name})
	}
	b, r := ui.Show(ui.Dialog{Title: title, Icon: ui.IconApp, Common: ui.BtnOK | ui.BtnCancel, Default: ui.IDOK,
		Instruction: "Em qual Discord instalar?",
		Content:     "Encontramos mais de um Discord com o Vencord instalado.",
		Radios:      radios, DefaultRadio: idAll})
	if b != ui.IDOK {
		return nil, false
	}
	if r >= idOne && r < idOne+len(ready) {
		return ready[r-idOne : r-idOne+1], true
	}
	return ready, true
}

// askCloseDiscord asks before closing a running Discord. Returns false if the user said no.
func (a *app) askCloseDiscord(verb string) (bool, error) {
	ps, err := a.cfg.RunningProcesses()
	if err != nil || len(ps) == 0 {
		return true, err
	}
	a.log.Printf("discord running: %d process(es)", len(ps))
	b, _ := ui.Show(ui.Dialog{Title: title, Icon: ui.IconWarning, Common: ui.BtnCancel, CommandLinks: true, Default: idProceed,
		Instruction: "O Discord precisa ser fechado para " + verb + ". Fechar agora?",
		Content:     "Se estiver no meio de uma conversa ou call, termine antes. Depois é só abrir o Discord de novo.",
		Buttons:     []ui.Button{{ID: idProceed, Text: "Fechar o Discord e continuar"}}})
	if b != idProceed {
		return false, nil
	}
	return true, ui.Progress(title, "Fechando o Discord…", nil, func(set func(string)) error {
		set("Aguarde um instante.")
		return a.cfg.CloseDiscord(ps)
	})
}

func (a *app) guiInstall() int {
	ready, err := a.cfg.Preflight()
	if err != nil {
		return a.guiError("Não foi possível instalar o Telinha", err)
	}
	chosen, ok := a.pickTargets(ready)
	if !ok {
		a.log.Printf("cancelled at target choice")
		return exitOK
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var st *core.Staged
	err = ui.Progress(title, "Instalando o Telinha", cancel, func(set func(string)) error {
		var err error
		st, err = a.cfg.Stage(ctx, a.source(), set)
		return err
	})
	if ctx.Err() != nil {
		a.cfg.DiscardStaged()
		a.log.Printf("cancelled during download")
		return exitOK
	}
	if err != nil {
		return a.guiError("Não foi possível instalar o Telinha", err)
	}

	proceed, err := a.askCloseDiscord("instalar")
	if !proceed {
		a.cfg.DiscardStaged()
		a.log.Printf("cancelled: user kept Discord open")
		return exitOK
	}
	if err != nil {
		a.cfg.DiscardStaged()
		return a.guiError("Não foi possível instalar o Telinha", err)
	}

	var res *core.Result
	err = ui.Progress(title, "Instalando o Telinha", nil, func(set func(string)) error {
		set("Ativando o Telinha no Discord…")
		var err error
		res, err = a.cfg.Apply(st, chosen)
		return err
	})
	if err != nil {
		return a.guiError("Não foi possível instalar o Telinha", err)
	}

	extra := ""
	var skipped []string
	for _, t := range a.cfg.Scan() {
		if t.State != core.StateReady && !t.Telinha() {
			skipped = append(skipped, t.Name+" ("+t.Detail+")")
		}
	}
	if len(skipped) > 0 {
		extra = "\n\nNão instalado em: " + strings.Join(skipped, "; ") + "."
	}
	ui.Show(ui.Dialog{Title: title, Icon: ui.IconApp, Common: ui.BtnClose,
		Instruction: "Pronto!",
		Content:     "Feche o Discord completamente e abra de novo. Depois ative o Telinha em Configurações → Vencord → Plugins." + extra,
		Expanded:    fmt.Sprintf("Telinha %s instalado em: %s.\nRegistro: %s", res.Version, targetNames(chosen), a.log.Path)})
	return exitOK
}

func (a *app) guiUninstall() int {
	proceed, err := a.askCloseDiscord("desinstalar")
	if !proceed {
		a.log.Printf("cancelled: user kept Discord open")
		return exitOK
	}
	if err != nil {
		return a.guiError("Não foi possível desinstalar o Telinha", err)
	}
	var res *core.UninstallResult
	err = ui.Progress(title, "Removendo o Telinha", nil, func(set func(string)) error {
		set("Devolvendo o Discord ao Vencord original…")
		var err error
		res, err = a.cfg.Uninstall()
		return err
	})
	if err != nil {
		return a.guiError("Não foi possível desinstalar o Telinha", err)
	}
	ui.Show(ui.Dialog{Title: title, Icon: ui.IconApp, Common: ui.BtnClose,
		Instruction: "O Telinha foi removido",
		Content:     "O Vencord continua instalado normalmente. Pode abrir o Discord de novo.",
		Expanded:    fmt.Sprintf("Stub do Vencord devolvido em: %s\nRegistro: %s", strings.Join(res.Restored, ", "), a.log.Path)})
	return exitOK
}
