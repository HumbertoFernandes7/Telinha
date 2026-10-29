// SPDX-License-Identifier: GPL-3.0-or-later
//
// Telinha installer: finding Discord installs on Windows.
//
// The list of branches/folders follows find_discord_windows.go of the official Vencord installer
// (https://github.com/Vencord/Installer, GPL-3.0, Copyright (c) 2023 Vendicated and Vencord contributors).

package discord

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Install is one Discord installation root (e.g. %LOCALAPPDATA%\Discord).
type Install struct {
	Branch   string // stable | ptb | canary | development | custom
	Name     string // user-facing name, e.g. "Discord PTB"
	Root     string // folder holding Update.exe and app-* folders
	Exe      string // main executable name, e.g. "DiscordPTB.exe"
	Detected bool   // found automatically in %LOCALAPPDATA% (not a --discord-dir override)
}

type branchInfo struct{ branch, dir, name, exe string }

var branches = []branchInfo{
	{"stable", "Discord", "Discord", "Discord.exe"},
	{"ptb", "DiscordPTB", "Discord PTB", "DiscordPTB.exe"},
	{"canary", "DiscordCanary", "Discord Canary", "DiscordCanary.exe"},
	{"development", "DiscordDevelopment", "Discord Development", "DiscordDevelopment.exe"},
}

// Find returns the Discord installs under localAppData that have at least one app-*\resources folder,
// in the order stable, ptb, canary, development.
func Find(localAppData string) []Install {
	var out []Install
	if localAppData == "" {
		return out
	}
	for _, b := range branches {
		root := filepath.Join(localAppData, b.dir)
		if len(AppFolders(root)) == 0 {
			continue
		}
		out = append(out, Install{Branch: b.branch, Name: b.name, Root: root, Exe: b.exe, Detected: true})
	}
	return out
}

// FromDir describes an install given explicitly (--discord-dir). The branch comes from the folder name
// when it is one of the standard ones.
func FromDir(root string) Install {
	root = filepath.Clean(root)
	base := filepath.Base(root)
	for _, b := range branches {
		if strings.EqualFold(base, b.dir) {
			return Install{Branch: b.branch, Name: b.name, Root: root, Exe: b.exe}
		}
	}
	return Install{Branch: "custom", Name: "Discord (" + base + ")", Root: root, Exe: "Discord.exe"}
}

var appFolderRe = regexp.MustCompile(`^app-\d+(\.\d+)*$`)

// AppFolders returns the names of the app-<version> folders that contain a resources folder, oldest
// first (numeric version order, so app-1.0.10000 sorts after app-1.0.9266).
func AppFolders(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() || !appFolderRe.MatchString(e.Name()) {
			continue
		}
		if fi, err := os.Stat(filepath.Join(root, e.Name(), "resources")); err != nil || !fi.IsDir() {
			continue
		}
		names = append(names, e.Name())
	}
	sort.SliceStable(names, func(i, j int) bool { return CompareVersions(names[i], names[j]) < 0 })
	return names
}

// Newest returns the newest app-* folder name, or "".
func Newest(root string) string {
	f := AppFolders(root)
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

// CompareVersions compares two app-<x.y.z> folder names numerically (non-numeric parts as text).
func CompareVersions(a, b string) int {
	pa := strings.Split(strings.TrimPrefix(strings.ToLower(a), "app-"), ".")
	pb := strings.Split(strings.TrimPrefix(strings.ToLower(b), "app-"), ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var sa, sb string
		if i < len(pa) {
			sa = pa[i]
		}
		if i < len(pb) {
			sb = pb[i]
		}
		na, ea := strconv.Atoi(sa)
		nb, eb := strconv.Atoi(sb)
		switch {
		case ea == nil && eb == nil:
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
		case sa == "" && sb != "":
			return -1
		case sb == "" && sa != "":
			return 1
		default:
			if c := strings.Compare(sa, sb); c != 0 {
				return c
			}
		}
	}
	return 0
}

// ResourcesDir returns <root>\<app>\resources.
func ResourcesDir(root, app string) string {
	return filepath.Join(root, app, "resources")
}
