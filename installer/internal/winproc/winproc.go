// SPDX-License-Identifier: GPL-3.0-or-later

// Package winproc lists and closes processes (Windows: winproc_windows.go, Linux: winproc_linux.go).
package winproc

// Process is one running process.
type Process struct {
	PID  uint32
	Name string // executable file name, e.g. "Discord.exe" (Windows) or "Discord" (Linux)
	Path string // full image path, "" when it could not be read
}

// System is the real implementation (the core package takes an interface so tests can fake it).
type System struct{}
