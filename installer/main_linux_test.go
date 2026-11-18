// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"errors"
	"os/user"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
)

func TestFlatpakAllow(t *testing.T) {
	defer func(f func(*syscall.Credential, []string, ...string) ([]byte, error)) { runFlatpak = f }(runFlatpak)
	var calls [][]string
	var fail bool
	runFlatpak = func(_ *syscall.Credential, _ []string, args ...string) ([]byte, error) {
		calls = append(calls, args)
		if fail {
			return []byte("error: no such app"), errors.New("exit status 1")
		}
		return nil, nil
	}
	home := filepath.Join("/home/u/.config", "Telinha")
	if err := flatpakAllow(discord.Install{Flatpak: "com.discordapp.Discord"}, home); err != nil {
		t.Fatal(err)
	}
	if err := flatpakAllow(discord.Install{Flatpak: "com.discordapp.DiscordCanary", FlatpakUser: true}, home); err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"override", "--system", "--filesystem=" + home, "com.discordapp.Discord"},
		{"override", "--user", "--filesystem=" + home, "com.discordapp.DiscordCanary"},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("flatpak calls:\n got %q\nwant %q", calls, want)
	}
	fail = true
	err := flatpakAllow(discord.Install{Flatpak: "com.discordapp.Discord"}, home)
	if err == nil || !strings.Contains(err.Error(), "no such app") {
		t.Fatalf("a failing flatpak should say why: %v", err)
	}
}

func TestDefaultAppDataFollowsXDG(t *testing.T) {
	if sudoUser() != nil {
		t.Skip("running under sudo")
	}
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	if got := defaultAppData(); got != "/tmp/xdg" {
		t.Fatalf("defaultAppData() = %q", got)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/home/someone")
	if got := defaultAppData(); got != "/home/someone/.config" {
		t.Fatalf("defaultAppData() = %q", got)
	}
}

// Under sudo, flatpak --user must see the user's HOME and XDG folders, not root's.
func TestUserEnv(t *testing.T) {
	t.Setenv("HOME", "/root")
	t.Setenv("XDG_DATA_HOME", "/root/.local/share")
	t.Setenv("XDG_CONFIG_HOME", "/root/.config")
	t.Setenv("TELINHA_KEEP", "yes")
	env := userEnv(&user.User{Username: "u", HomeDir: "/home/u"})
	got := map[string]string{}
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if _, dup := got[k]; dup {
			t.Fatalf("%s set twice: %q", k, env)
		}
		got[k] = v
	}
	if got["HOME"] != "/home/u" || got["USER"] != "u" || got["LOGNAME"] != "u" || got["TELINHA_KEEP"] != "yes" {
		t.Fatalf("env: %q", env)
	}
	for _, k := range []string{"XDG_DATA_HOME", "XDG_CONFIG_HOME"} {
		if _, ok := got[k]; ok {
			t.Fatalf("%s leaked from root: %q", k, env)
		}
	}
}
