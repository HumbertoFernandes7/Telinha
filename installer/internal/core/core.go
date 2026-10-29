// SPDX-License-Identifier: GPL-3.0-or-later

// Package core is the install / repair / uninstall logic (addon/PAYLOAD.md sections 2-5), independent of
// the UI. Everything it touches comes from Config, so tests run it against fake trees.
package core

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winproc"
)

// Processes lists and closes processes (winproc.System in production, a fake in tests).
type Processes interface {
	List() ([]winproc.Process, error)
	Close(ps []winproc.Process, grace time.Duration) error
}

// Config says where everything is.
type Config struct {
	AppData            string            // Roaming folder: holds Vencord\ and Telinha\
	Installs           []discord.Install // Discord roots to work on
	Overridden         bool              // Installs came from --discord-dir: only touch processes running from them
	VencordDataDir     string            // VENCORD_USER_DATA_DIR, if set (Vencord's installer honours it)
	AllowCustomVencord bool              // accept a Vencord stub pointing outside the standard dist folder
	Procs              Processes
	Log                *log.Logger
	InstallerVersion   string
}

func (c *Config) logf(format string, args ...any) {
	if c.Log != nil {
		c.Log.Printf(format, args...)
	}
}

func (c *Config) logger() *log.Logger {
	if c.Log == nil {
		c.Log = log.New(io.Discard, "", 0)
	}
	return c.Log
}

// Home is %APPDATA%\Telinha.
func (c *Config) Home() string { return filepath.Join(c.AppData, "Telinha") }

// AddonDir is %APPDATA%\Telinha\addon.
func (c *Config) AddonDir() string { return filepath.Join(c.Home(), "addon") }

// BackupPath is %APPDATA%\Telinha\backup\<FlavorDir>\<app-ver>.app.asar.
func (c *Config) BackupPath(inst discord.Install, app string) string {
	return filepath.Join(c.Home(), "backup", filepath.Base(inst.Root), app+".app.asar")
}

// RecordPath is %APPDATA%\Telinha\install.json.
func (c *Config) RecordPath() string { return filepath.Join(c.Home(), "install.json") }

// OfficialPatchers are the patcher.js paths an official Vencord install uses.
func (c *Config) OfficialPatchers() []string {
	out := []string{filepath.Join(c.AppData, "Vencord", "dist", "patcher.js")}
	if c.VencordDataDir != "" {
		out = append(out, filepath.Join(c.VencordDataDir, "dist", "patcher.js"))
	}
	return out
}

func samePath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }

func under(p, dir string) bool {
	p, dir = filepath.Clean(p), filepath.Clean(dir)
	return len(p) > len(dir) && strings.EqualFold(p[:len(dir)], dir) && os.IsPathSeparator(p[len(dir)])
}

// Problem is an error with a message for the user (pt-BR) and a code for the UI.
type Problem struct {
	Code string // see the Code* constants
	Msg  string
	Err  error
}

const (
	CodeNoDiscord      = "no-discord"
	CodeNoVencord      = "no-vencord"
	CodeDiscordRunning = "discord-running"
	CodePayload        = "payload"
	CodeNotInstalled   = "not-installed"
	CodeFailed         = "failed"
)

func (p *Problem) Error() string {
	if p.Err != nil {
		return p.Msg + " (" + p.Err.Error() + ")"
	}
	return p.Msg
}

func (p *Problem) Unwrap() error { return p.Err }

// AsProblem returns err as a *Problem (wrapping unknown errors as CodeFailed).
func AsProblem(err error) *Problem {
	var p *Problem
	if errors.As(err, &p) {
		return p
	}
	return &Problem{Code: CodeFailed, Msg: "Algo deu errado.", Err: err}
}

func problem(code, msg string, err error) *Problem { return &Problem{Code: code, Msg: msg, Err: err} }

// discordExeNames are the process names of every Discord flavor (PAYLOAD.md 4.1).
var discordExeNames = []string{"Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe", "DiscordDevelopment.exe"}

// HelperExe is spawned by the plugin from the addon folder and keeps a file there open.
const HelperExe = "telinha-audio.exe"

// RunningProcesses returns the Discord processes (all flavors, tray included) and Telinha helpers that
// must be closed before files can be replaced. With --discord-dir overrides only processes started from
// those folders count, so tests on fake trees never touch the real Discord.
func (c *Config) RunningProcesses() ([]winproc.Process, error) {
	if c.Procs == nil {
		return nil, nil
	}
	all, err := c.Procs.List()
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, n := range discordExeNames {
		names[strings.ToLower(n)] = true
	}
	for _, in := range c.Installs {
		names[strings.ToLower(in.Exe)] = true
	}
	var out []winproc.Process
	for _, p := range all {
		name := strings.ToLower(p.Name)
		switch {
		case name == strings.ToLower(HelperExe):
			if p.Path != "" && under(p.Path, c.Home()) {
				out = append(out, p)
			}
		case names[name]:
			if !c.Overridden {
				out = append(out, p)
				continue
			}
			for _, in := range c.Installs {
				if p.Path != "" && under(p.Path, in.Root) {
					out = append(out, p)
					break
				}
			}
		}
	}
	return out, nil
}

// CloseDiscord closes the given processes (graceful first, then forced) and checks they are gone.
func (c *Config) CloseDiscord(ps []winproc.Process) error {
	if len(ps) == 0 {
		return nil
	}
	c.logf("closing %d process(es): %s", len(ps), procNames(ps))
	if err := c.Procs.Close(ps, 3*time.Second); err != nil {
		c.logf("close: %v", err)
	}
	left, err := c.RunningProcesses()
	if err != nil {
		return err
	}
	if len(left) > 0 {
		return problem(CodeDiscordRunning, "Não foi possível fechar o Discord. Feche-o pelo ícone perto do relógio (botão direito → Sair do Discord) e tente de novo.",
			fmt.Errorf("still running: %s", procNames(left)))
	}
	return nil
}

func procNames(ps []winproc.Process) string {
	var s []string
	for _, p := range ps {
		s = append(s, fmt.Sprintf("%s(%d)", p.Name, p.PID))
	}
	return strings.Join(s, ", ")
}

// ensureNotRunning refuses when Discord is running (callers ask the user and close it first).
func (c *Config) ensureNotRunning() error {
	ps, err := c.RunningProcesses()
	if err != nil {
		c.logf("listing processes failed: %v", err)
		return nil
	}
	if len(ps) > 0 {
		return problem(CodeDiscordRunning, "O Discord está aberto. Feche-o completamente (inclusive o ícone perto do relógio) e tente de novo.",
			fmt.Errorf("running: %s", procNames(ps)))
	}
	return nil
}
