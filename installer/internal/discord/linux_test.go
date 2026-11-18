// SPDX-License-Identifier: GPL-3.0-or-later

package discord

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func mkResources(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestFlatAppFolder(t *testing.T) {
	root := filepath.Join(t.TempDir(), "discord")
	if got := AppFolders(root); got != nil {
		t.Fatalf("missing root: %q", got)
	}
	mkResources(t, root)
	if got := AppFolders(root); !reflect.DeepEqual(got, []string{FlatApp}) {
		t.Fatalf("flat root: %q", got)
	}
	if got := ResourcesDir(root, Newest(root)); got != filepath.Join(root, "resources") {
		t.Fatalf("ResourcesDir: %s", got)
	}
	// app-* folders win (a Windows layout that also has a stray resources folder)
	mkResources(t, filepath.Join(root, "app-1.0.1"))
	if got := AppFolders(root); !reflect.DeepEqual(got, []string{"app-1.0.1"}) {
		t.Fatalf("app-* root: %q", got)
	}
}

func TestFindLinux(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	sys := filepath.Join(base, "usr", "share")
	opt := filepath.Join(base, "opt")
	sysFlatpak := filepath.Join(base, "var", "lib", "flatpak", "app")
	defer func(d []string, f string) { linuxSystemDirs, flatpakSystemApps = d, f }(linuxSystemDirs, flatpakSystemApps)
	linuxSystemDirs, flatpakSystemApps = []string{sys, opt}, sysFlatpak

	if got := FindLinux(home); len(got) != 0 {
		t.Fatalf("empty machine: %+v", got)
	}

	mkResources(t, filepath.Join(sys, "discord"))
	mkResources(t, filepath.Join(opt, "discord-canary"))
	mkResources(t, filepath.Join(home, ".local", "share", "DiscordPTB"))
	flatpak := filepath.Join(sysFlatpak, "com.discordapp.Discord", "current", "active", "files", "discord")
	mkResources(t, flatpak)
	userFlatpak := filepath.Join(home, ".local", "share", "flatpak", "app", "com.discordapp.DiscordCanary", "current", "active", "files", "discord-canary")
	mkResources(t, userFlatpak)
	if err := os.MkdirAll(filepath.Join(opt, "discord"), 0o755); err != nil { // no resources: not an install
		t.Fatal(err)
	}

	type found struct {
		Branch, Root, Exe, Flatpak string
		User                       bool
	}
	var got []found
	for _, in := range FindLinux(home) {
		if !in.Detected {
			t.Errorf("%s not marked Detected", in.Root)
		}
		got = append(got, found{in.Branch, in.Root, in.Exe, in.Flatpak, in.FlatpakUser})
	}
	want := []found{
		{"stable", filepath.Join(sys, "discord"), "Discord", "", false},
		{"stable", flatpak, "Discord", "com.discordapp.Discord", false},
		{"ptb", filepath.Join(home, ".local", "share", "DiscordPTB"), "DiscordPTB", "", false},
		{"canary", filepath.Join(opt, "discord-canary"), "DiscordCanary", "", false},
		{"canary", userFlatpak, "DiscordCanary", "com.discordapp.DiscordCanary", true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FindLinux:\n got %+v\nwant %+v", got, want)
	}
}

// The same install reached through a symlink (e.g. /opt/discord -> /usr/share/discord) counts once.
func TestFindLinuxSymlinkCountsOnce(t *testing.T) {
	base := t.TempDir()
	sys := filepath.Join(base, "usr", "share")
	opt := filepath.Join(base, "opt")
	defer func(d []string, f string) { linuxSystemDirs, flatpakSystemApps = d, f }(linuxSystemDirs, flatpakSystemApps)
	linuxSystemDirs, flatpakSystemApps = []string{sys, opt}, filepath.Join(base, "flatpak")
	mkResources(t, filepath.Join(sys, "discord"))
	if err := os.MkdirAll(opt, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(sys, "discord"), filepath.Join(opt, "discord")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if got := FindLinux(filepath.Join(base, "home")); len(got) != 1 || got[0].Root != filepath.Join(sys, "discord") {
		t.Fatalf("FindLinux: %+v", got)
	}
}
