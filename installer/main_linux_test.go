// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
)

func TestFlatpakAllow(t *testing.T) {
	defer func(f func(*syscall.Credential, ...string) ([]byte, error)) { runFlatpak = f }(runFlatpak)
	var calls [][]string
	var fail bool
	runFlatpak = func(_ *syscall.Credential, args ...string) ([]byte, error) {
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
