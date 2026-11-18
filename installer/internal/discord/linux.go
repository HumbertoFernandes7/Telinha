// SPDX-License-Identifier: GPL-3.0-or-later
//
// Telinha installer: finding Discord installs on Linux. Plain path logic (no build tag), so it is tested on
// every platform.
//
// The folders follow find_discord_linux.go of the official Vencord installer
// (https://github.com/Vencord/Installer, GPL-3.0, Copyright (c) 2023 Vendicated and Vencord contributors).

package discord

import (
	"os"
	"path/filepath"
)

type linuxBranch struct {
	branch, name, exe string
	dirs              []string // folder names packages use for it (deb, rpm, tar.gz, AUR...)
	flatpakID         string   // Flathub app id ("" = not on Flathub)
	flatpakDir        string   // the folder inside the flatpak's files/
}

var linuxBranches = []linuxBranch{
	{"stable", "Discord", "Discord", []string{"discord", "Discord"}, "com.discordapp.Discord", "discord"},
	{"ptb", "Discord PTB", "DiscordPTB", []string{"discord-ptb", "discordptb", "DiscordPTB"}, "", ""},
	{"canary", "Discord Canary", "DiscordCanary", []string{"discord-canary", "discordcanary", "DiscordCanary"}, "com.discordapp.DiscordCanary", "discord-canary"},
	{"development", "Discord Development", "DiscordDevelopment", []string{"discord-development", "discorddevelopment", "DiscordDevelopment"}, "", ""},
}

// Where packages put Discord ("" entries are relative to the user's home). Variables so the tests can aim
// FindLinux at a fake tree.
var (
	linuxSystemDirs    = []string{"/usr/share", "/usr/lib", "/usr/lib64", "/opt"}
	linuxHomeDirs      = []string{".local/share", ".dvm"}
	flatpakSystemApps  = "/var/lib/flatpak/app"
	flatpakUserAppsRel = ".local/share/flatpak/app"
)

// FindLinux returns the Discord installs of a Linux machine (home is the user's home folder): packaged ones
// (/usr/share/discord, /opt/discord, ~/.local/share/...) and flatpaks (system-wide and --user). Each counts once,
// even when reached through a symlink. Snap is left out: its files can't be changed.
func FindLinux(home string) []Install {
	var out []Install
	var seen []os.FileInfo
	add := func(in Install) {
		fi, err := os.Stat(in.Root)
		if err != nil || len(AppFolders(in.Root)) == 0 {
			return
		}
		for _, s := range seen {
			if os.SameFile(s, fi) {
				return
			}
		}
		seen = append(seen, fi)
		in.Detected = true
		out = append(out, in)
	}
	var parents []string
	parents = append(parents, linuxSystemDirs...)
	for _, d := range linuxHomeDirs {
		parents = append(parents, filepath.Join(home, d))
	}
	for _, b := range linuxBranches {
		for _, p := range parents {
			for _, d := range b.dirs {
				add(Install{Branch: b.branch, Name: b.name, Root: filepath.Join(p, d), Exe: b.exe})
			}
		}
		if b.flatpakID == "" {
			continue
		}
		for _, f := range []struct {
			apps string
			user bool
		}{{flatpakSystemApps, false}, {filepath.Join(home, flatpakUserAppsRel), true}} {
			// "current/active" follows Discord's updates (a new deployment drops the stub, as it does Vencord's)
			root := filepath.Join(f.apps, b.flatpakID, "current", "active", "files", b.flatpakDir)
			add(Install{Branch: b.branch, Name: b.name + " (Flatpak)", Root: root, Exe: b.exe, Flatpak: b.flatpakID, FlatpakUser: f.user})
		}
	}
	return out
}
