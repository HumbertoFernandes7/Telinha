// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

// These tests exercise the decisions of console_windows.go. The calls that really attach to a terminal or hide
// a window are the seams the tests replace: running them here would change (or hide) the console of whoever
// runs the tests.

func TestUsable(t *testing.T) {
	dir := testutil.TempDir(t)
	if usable(nil) {
		t.Fatal("nil is not usable")
	}
	// a file, a pipe and the NUL device are all fine to write to / read from
	f, err := os.Create(filepath.Join(dir, "f"))
	if err != nil {
		t.Fatal(err)
	}
	if !usable(f) {
		t.Fatal("a file is usable")
	}
	f.Close()
	if usable(f) { // a closed handle
		t.Fatal("a closed file is not usable")
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if !usable(r) || !usable(w) {
		t.Fatal("a pipe is usable")
	}
	r.Close()
	w.Close()
	nul, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer nul.Close()
	if !usable(nul) {
		t.Fatal("NUL is usable")
	}
}

func TestCanPrompt(t *testing.T) {
	setStdin(t, nil)
	if canPrompt() {
		t.Fatal("no stdin: cannot ask")
	}
	setStdin(t, typed("s\n"))
	if !canPrompt() {
		t.Fatal("input is there: can ask")
	}
}

func TestConsoleWindowAgreesWithHasOwnConsole(t *testing.T) {
	if (consoleWindow() != 0) != hasOwnConsole {
		t.Fatalf("hasOwnConsole=%v consoleWindow=%#x", hasOwnConsole, consoleWindow())
	}
	// read-only calls: harmless anywhere
	_ = consoleProcessCount()
	if f, err := openConsoleOutput(); err == nil {
		f.Close()
	}
}

func TestAttachParentConsole(t *testing.T) {
	type calls struct{ attach, open int }
	setup := func(t *testing.T, own bool, attachOK bool, openErr error) (*calls, *os.File) {
		t.Helper()
		c := &calls{}
		swap(t, &hasOwnConsole, own)
		swap(t, &attachToParentConsole, func() bool { c.attach++; return attachOK })
		console, err := os.Create(filepath.Join(testutil.TempDir(t), "CONOUT"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { console.Close() })
		swap(t, &openConsoleOutput, func() (*os.File, error) {
			c.open++
			if openErr != nil {
				return nil, openErr
			}
			return console, nil
		})
		return c, console
	}
	// the standard handles of the test are restored whatever happens
	oldOut, oldErr := os.Stdout, os.Stderr
	t.Cleanup(func() { os.Stdout, os.Stderr = oldOut, oldErr })

	unusableStdout := func(t *testing.T) {
		t.Helper()
		f, err := os.Create(filepath.Join(testutil.TempDir(t), "closed"))
		if err != nil {
			t.Fatal(err)
		}
		f.Close() // a closed handle: what a GUI process has when started from a shortcut
		os.Stdout = f
	}

	t.Run("a console of its own: nothing to do", func(t *testing.T) {
		c, _ := setup(t, true, true, nil)
		unusableStdout(t)
		before := os.Stdout
		attachParentConsole()
		if c.attach != 0 || os.Stdout != before {
			t.Fatalf("%+v", c)
		}
	})
	t.Run("redirected output is left alone", func(t *testing.T) {
		c, _ := setup(t, false, true, nil)
		os.Stdout = oldOut // the test's own stdout is a pipe or a file
		if !usable(os.Stdout) {
			t.Skip("the test runner's stdout is not usable here")
		}
		attachParentConsole()
		if c.attach != 0 || os.Stdout != oldOut {
			t.Fatalf("%+v", c)
		}
	})
	t.Run("no parent console to attach to", func(t *testing.T) {
		c, _ := setup(t, false, false, nil)
		unusableStdout(t)
		before := os.Stdout
		attachParentConsole()
		if c.attach != 1 || c.open != 0 || os.Stdout != before {
			t.Fatalf("%+v", c)
		}
	})
	t.Run("attached: output goes to the terminal", func(t *testing.T) {
		c, console := setup(t, false, true, nil)
		unusableStdout(t)
		attachParentConsole()
		if c.attach != 1 || c.open != 1 || os.Stdout != console || os.Stderr != console {
			t.Fatalf("%+v stdout=%v stderr=%v", c, os.Stdout, os.Stderr)
		}
	})
	t.Run("attached but the output buffer cannot be opened", func(t *testing.T) {
		c, _ := setup(t, false, true, os.ErrPermission)
		unusableStdout(t)
		before, beforeErr := os.Stdout, os.Stderr
		attachParentConsole()
		if c.attach != 1 || c.open != 1 || os.Stdout != before || os.Stderr != beforeErr {
			t.Fatalf("%+v", c)
		}
	})
}

func TestHideOwnConsole(t *testing.T) {
	hidden := 0
	swap(t, &hideConsoleWindow, func() { hidden++ })
	count := uint32(1)
	swap(t, &consoleProcessCount, func() uint32 { return count })

	swap(t, &hasOwnConsole, false)
	hideOwnConsole()
	if hidden != 0 {
		t.Fatal("hid a console this process does not own")
	}

	hasOwnConsole = true
	count = 1 // double-clicked: the console belongs to this process alone
	hideOwnConsole()
	if hidden != 1 {
		t.Fatalf("hidden %d", hidden)
	}
	for _, n := range []uint32{2, 3, 0} { // started from a terminal (others share the console) or the call failed
		count = n
		hideOwnConsole()
	}
	if hidden != 1 {
		t.Fatalf("hid a console shared with %d other processes", count)
	}
}
