// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"os"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winver"
)

var (
	knownFolderPath = windows.KnownFolderPath
	// checkWindows returns an error when this Windows is too old (nil when it is new enough).
	checkWindows = winver.Check
	// attachConsole / hideConsole are the console tricks of main; tests must not run the real ones.
	attachConsole = attachParentConsole
	hideConsole   = hideOwnConsole
)

func knownFolder(id *windows.KNOWNFOLDERID, env string) string {
	if p, err := knownFolderPath(id, 0); err == nil && p != "" {
		return p
	}
	return os.Getenv(env)
}

// defaultAppData is %APPDATA% (Vencord\ and Telinha\ live there).
func defaultAppData() string { return knownFolder(windows.FOLDERID_RoamingAppData, "APPDATA") }

// findDiscord looks for the Discord flavors in %LOCALAPPDATA%.
func findDiscord() []discord.Install {
	return discord.Find(knownFolder(windows.FOLDERID_LocalAppData, "LOCALAPPDATA"))
}

func setupPlatform(*core.Config) {}

func platformFinish(*core.Config) {}
