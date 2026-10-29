// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	procGetConsoleWindow      = kernel32.NewProc("GetConsoleWindow")
	procGetConsoleProcessList = kernel32.NewProc("GetConsoleProcessList")
	procAttachConsole         = kernel32.NewProc("AttachConsole")
	procShowWindow            = windows.NewLazySystemDLL("user32.dll").NewProc("ShowWindow")
)

func consoleWindow() uintptr {
	h, _, _ := procGetConsoleWindow.Call()
	return h
}

// hasOwnConsole: started with a console (console build, or launched from a terminal with one).
var hasOwnConsole = consoleWindow() != 0

// usable reports whether a standard handle is open (console, pipe or file).
func usable(f *os.File) bool {
	if f == nil {
		return false
	}
	t, err := windows.GetFileType(windows.Handle(f.Fd()))
	return err == nil && t != windows.FILE_TYPE_UNKNOWN
}

// canPrompt: stdin can be read (console build in a terminal, or input piped in). EOF counts as "no".
func canPrompt() bool { return usable(os.Stdin) }

// attachParentConsole makes CLI output visible when the GUI build (-H windowsgui) is run from a terminal
// without redirection. Redirected output (pipes, files) is left alone. Note: cmd.exe does not wait for
// GUI programs; use `start /wait TelinhaInstaller.exe --status` or the console build
// (TelinhaInstaller-cli.exe) when scripting.
func attachParentConsole() {
	if hasOwnConsole || usable(os.Stdout) {
		return
	}
	const attachParentProcess = ^uintptr(0)
	if r, _, _ := procAttachConsole.Call(attachParentProcess); r == 0 {
		return
	}
	if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout, os.Stderr = f, f
	}
}

// hideOwnConsole hides the console window of the console build when it was double-clicked (the console
// belongs to this process only), so GUI mode looks the same in both builds.
func hideOwnConsole() {
	if !hasOwnConsole {
		return
	}
	var pids [2]uint32
	n, _, _ := procGetConsoleProcessList.Call(uintptr(unsafe.Pointer(&pids[0])), 2)
	if n == 1 {
		const swHide = 0
		procShowWindow.Call(consoleWindow(), swHide)
	}
}
