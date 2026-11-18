// SPDX-License-Identifier: GPL-3.0-or-later
//
// Telinha installer: listing and closing processes on Linux (/proc and signals).

package winproc

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// procRoot is /proc (tests point it at a fake tree).
var procRoot = "/proc"

// List returns all running processes. Name is the executable's file name ("Discord"); when /proc/<pid>/exe
// can't be read (another user's process, without root) it falls back to comm, which the kernel cuts at 15 bytes.
func (System) List() ([]Process, error) {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil, err
	}
	var out []Process
	for _, e := range entries {
		pid, err := strconv.ParseUint(e.Name(), 10, 32)
		if err != nil {
			continue
		}
		dir := filepath.Join(procRoot, e.Name())
		p := Process{PID: uint32(pid)}
		if exe, err := os.Readlink(filepath.Join(dir, "exe")); err == nil {
			p.Path = strings.TrimSuffix(exe, " (deleted)")
			p.Name = filepath.Base(p.Path)
		} else if comm, err := os.ReadFile(filepath.Join(dir, "comm")); err == nil {
			p.Name = strings.TrimSpace(string(comm))
		} else {
			continue // exited meanwhile
		}
		out = append(out, p)
	}
	return out, nil
}

// Close sends SIGTERM (Discord quits on it, tray icon included), waits up to grace, then SIGKILLs whatever is
// left and waits for it to exit.
func (System) Close(ps []Process, grace time.Duration) error {
	if len(ps) == 0 {
		return nil
	}
	errs := signal(ps, syscall.SIGTERM)
	if waitGone(ps, grace) {
		return errors.Join(errs...)
	}
	errs = append(errs, signal(ps, syscall.SIGKILL)...)
	if !waitGone(ps, 10*time.Second) {
		errs = append(errs, errors.New("some processes are still running"))
	}
	return errors.Join(errs...)
}

func signal(ps []Process, sig syscall.Signal) []error {
	var errs []error
	for _, p := range ps {
		if err := syscall.Kill(int(p.PID), sig); err != nil && !errors.Is(err, syscall.ESRCH) {
			errs = append(errs, fmt.Errorf("%s (pid %d): %w", p.Name, p.PID, err))
		}
	}
	return errs
}

func waitGone(ps []Process, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for anyAlive(ps) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
	return true
}

func anyAlive(ps []Process) bool {
	for _, p := range ps {
		if alive(p.PID) {
			return true
		}
	}
	return false
}

// alive: the process exists and is not a zombie (a dead child its parent has not reaped yet).
func alive(pid uint32) bool {
	stat, err := os.ReadFile(filepath.Join(procRoot, strconv.FormatUint(uint64(pid), 10), "stat"))
	if err != nil {
		return false
	}
	// "<pid> (<comm>) <state> ...": comm may hold spaces and parentheses, so look after the last ')'
	s := string(stat)
	i := strings.LastIndexByte(s, ')')
	return i < 0 || !strings.HasPrefix(s[i+1:], " Z")
}
