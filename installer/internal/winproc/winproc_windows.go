// SPDX-License-Identifier: GPL-3.0-or-later
//
// Telinha installer: listing and closing processes (Discord must be closed before app.asar can be
// replaced: Electron keeps it open). Process listing follows findProcessIdByName from the official
// Vencord installer (https://github.com/Vencord/Installer, find_discord_windows.go, GPL-3.0,
// Copyright (c) 2023 Vendicated and Vencord contributors).

package winproc

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Process is one running process.
type Process struct {
	PID  uint32
	Name string // executable file name, e.g. "Discord.exe"
	Path string // full image path, "" when it could not be read
}

// System is the real implementation (the core package takes an interface so tests can fake it).
type System struct{}

// List returns all running processes.
func (System) List() ([]Process, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	var out []Process
	e := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		out = append(out, Process{PID: e.ProcessID, Name: windows.UTF16ToString(e.ExeFile[:]), Path: imagePath(e.ProcessID)})
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return out, err
	}
	return out, nil
}

func imagePath(pid uint32) string {
	if pid == 0 {
		return ""
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

var (
	user32          = windows.NewLazySystemDLL("user32.dll")
	procPostMessage = user32.NewProc("PostMessageW")
	enumTarget      map[uint32]bool
	enumCallback    = syscall.NewCallback(func(hwnd windows.HWND, _ uintptr) uintptr {
		var pid uint32
		if _, err := windows.GetWindowThreadProcessId(hwnd, &pid); err == nil && enumTarget[pid] {
			const wmClose = 0x0010
			procPostMessage.Call(uintptr(hwnd), wmClose, 0, 0)
		}
		return 1
	})
)

// Close asks the processes to close (WM_CLOSE to their top-level windows), waits up to grace, then
// terminates whatever is left and waits for it to exit. Discord usually just hides to the tray on
// WM_CLOSE, so the forced part is what normally ends it (the Vencord installer kills it outright).
func (System) Close(ps []Process, grace time.Duration) error {
	if len(ps) == 0 {
		return nil
	}
	enumTarget = map[uint32]bool{}
	for _, p := range ps {
		enumTarget[p.PID] = true
	}
	_ = windows.EnumWindows(enumCallback, nil)
	enumTarget = nil

	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) && anyAlive(ps) {
		time.Sleep(200 * time.Millisecond)
	}

	var errs []error
	for _, p := range ps {
		h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, p.PID)
		if err != nil {
			continue // already gone
		}
		if err := windows.TerminateProcess(h, 1); err != nil && alive(p.PID) {
			errs = append(errs, fmt.Errorf("%s (pid %d): %w", p.Name, p.PID, err))
		}
		_, _ = windows.WaitForSingleObject(h, 10_000)
		windows.CloseHandle(h)
	}
	if anyAlive(ps) {
		errs = append(errs, errors.New("some processes are still running"))
	}
	return errors.Join(errs...)
}

func anyAlive(ps []Process) bool {
	for _, p := range ps {
		if alive(p.PID) {
			return true
		}
	}
	return false
}

func alive(pid uint32) bool {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, err := windows.WaitForSingleObject(h, 0)
	return err == nil && ev == uint32(windows.WAIT_TIMEOUT)
}
