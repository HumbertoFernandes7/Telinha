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

// The calls below act on the console of whoever runs the program (they attach to a terminal, hide a window).
// They are variables so the tests can stand in for them and exercise the decisions around them.
var (
	// attachToParentConsole is AttachConsole(ATTACH_PARENT_PROCESS); true when it worked.
	attachToParentConsole = func() bool {
		const attachParentProcess = ^uintptr(0)
		r, _, _ := procAttachConsole.Call(attachParentProcess)
		return r != 0
	}
	// openConsoleOutput opens the console's output buffer.
	openConsoleOutput = func() (*os.File, error) { return os.OpenFile("CONOUT$", os.O_WRONLY, 0) }
	// consoleProcessCount is how many processes share this console (2 slots are enough to tell "only us").
	consoleProcessCount = func() uint32 {
		var pids [2]uint32
		n, _, _ := procGetConsoleProcessList.Call(uintptr(unsafe.Pointer(&pids[0])), 2)
		return uint32(n)
	}
	// hideConsoleWindow is ShowWindow(console, SW_HIDE).
	hideConsoleWindow = func() {
		const swHide = 0
		procShowWindow.Call(consoleWindow(), swHide)
	}
)

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
	if !attachToParentConsole() {
		return
	}
	if f, err := openConsoleOutput(); err == nil {
		os.Stdout, os.Stderr = f, f
	}
}

// hideOwnConsole hides the console window of the console build when it was double-clicked (the console
// belongs to this process only), so GUI mode looks the same in both builds.
func hideOwnConsole() {
	if !hasOwnConsole {
		return
	}
	if consoleProcessCount() == 1 {
		hideConsoleWindow()
	}
}
