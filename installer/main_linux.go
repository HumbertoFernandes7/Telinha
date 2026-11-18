// SPDX-License-Identifier: GPL-3.0-or-later
//
// Linux: there is no GUI, only the command line. Discord's files belong to root (deb, rpm, flatpak), so the
// installer usually runs under sudo; it then still works for the user who called it (SUDO_USER): their
// ~/.config holds Vencord/ and Telinha/, and everything it writes there is handed back to them.

package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
)

var (
	checkWindows  = func() error { return nil }
	attachConsole = func() {}
	hideConsole   = func() {}
	// runFlatpak runs the flatpak command (tests replace it)
	runFlatpak = func(cred *syscall.Credential, env []string, args ...string) ([]byte, error) {
		cmd := exec.Command("flatpak", args...)
		cmd.Env = env // nil = inherit
		if cred != nil {
			cmd.SysProcAttr = &syscall.SysProcAttr{Credential: cred}
		}
		return cmd.CombinedOutput()
	}
)

// sudoUser is the user who ran `sudo TelinhaInstaller ...` (nil when not running as root under sudo).
func sudoUser() *user.User {
	if os.Geteuid() != 0 {
		return nil
	}
	name := os.Getenv("SUDO_USER")
	if name == "" || name == "root" {
		return nil
	}
	u, err := user.Lookup(name)
	if err != nil {
		return nil
	}
	return u
}

func homeDir() string {
	if u := sudoUser(); u != nil {
		return u.HomeDir
	}
	h, _ := os.UserHomeDir()
	return h
}

// defaultAppData is ~/.config (or $XDG_CONFIG_HOME): where the official Vencord installer puts Vencord/dist.
func defaultAppData() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" && sudoUser() == nil {
		return x
	}
	if h := homeDir(); h != "" {
		return filepath.Join(h, ".config")
	}
	return ""
}

func findDiscord() []discord.Install { return discord.FindLinux(homeDir()) }

func setupPlatform(cfg *core.Config) { cfg.GrantAccess = flatpakAllow }

// flatpakAllow adds dir to the flatpak's filesystem permissions (read-write: the add-on writes its logs and
// updates there), like the Vencord installer does for Vencord/dist.
func flatpakAllow(in discord.Install, dir string) error {
	scope := "--system"
	var cred *syscall.Credential
	var env []string
	if in.FlatpakUser {
		scope = "--user"
		// under sudo, --user would change root's overrides: run it as the user who owns the install
		if u := sudoUser(); u != nil {
			cred = credential(u)
			if cred != nil {
				env = userEnv(u)
			}
		}
	}
	args := []string{"override", scope, "--filesystem=" + dir, in.Flatpak}
	if out, err := runFlatpak(cred, env, args...); err != nil {
		return fmt.Errorf("flatpak %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// userEnv is root's environment seen as the user: sudo may leave HOME (and the XDG folders) pointing at root's.
func userEnv(u *user.User) []string {
	var env []string
	for _, kv := range os.Environ() {
		switch strings.SplitN(kv, "=", 2)[0] {
		case "HOME", "USER", "LOGNAME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME":
		default:
			env = append(env, kv)
		}
	}
	return append(env, "HOME="+u.HomeDir, "USER="+u.Username, "LOGNAME="+u.Username)
}

func credential(u *user.User) *syscall.Credential {
	uid, err1 := strconv.ParseUint(u.Uid, 10, 32)
	gid, err2 := strconv.ParseUint(u.Gid, 10, 32)
	if err1 != nil || err2 != nil {
		return nil
	}
	return &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}
}

// platformFinish gives the Telinha home back to the sudo user: Discord runs as them and must write its logs and
// updates there.
func platformFinish(cfg *core.Config) {
	u := sudoUser()
	if u == nil {
		return
	}
	c := credential(u)
	if c == nil {
		return
	}
	_ = filepath.WalkDir(cfg.Home(), func(p string, _ fs.DirEntry, err error) error {
		if err == nil {
			_ = os.Lchown(p, int(c.Uid), int(c.Gid))
		}
		return nil
	})
}

// canPrompt: stdin is a terminal (the question about closing Discord can be answered).
func canPrompt() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// runGUI: no window on Linux; started without an action, the installer explains how to use it.
func runGUI(*options) int {
	fmt.Fprintln(os.Stderr, `TelinhaInstaller (Linux) funciona pela linha de comando. Com o Discord e o Vencord oficial já instalados:

  sudo ./TelinhaInstaller --install     instala ou atualiza o Telinha
  sudo ./TelinhaInstaller --uninstall   devolve o Discord ao Vencord original
  ./TelinhaInstaller --status           mostra o que está instalado

(sudo porque os arquivos do Discord pertencem ao root; --help lista todas as opções)`)
	return exitUsage
}
