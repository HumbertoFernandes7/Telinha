// SPDX-License-Identifier: GPL-3.0-or-later

package logx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

func TestLinesAreOnDiskWithoutClose(t *testing.T) {
	dir := filepath.Join(testutil.TempDir(t), "logs")
	lf := Open(dir, nil)
	lf.Printf("first")
	lf.Printf("second %d", 2)
	// no Close: a process that leaves through os.Exit must not lose anything
	got := string(testutil.Read(t, filepath.Join(dir, "installer.log")))
	if !strings.Contains(got, "first\n") || !strings.Contains(got, "second 2\n") {
		t.Fatalf("log: %q", got)
	}
	if lf.Degraded() || lf.Where() != filepath.Join(dir, "installer.log") {
		t.Fatalf("where %q degraded %v", lf.Where(), lf.Degraded())
	}
	// a second run appends, it does not truncate
	Open(dir, nil).Printf("third")
	if got := string(testutil.Read(t, filepath.Join(dir, "installer.log"))); !strings.Contains(got, "first") || !strings.Contains(got, "third") {
		t.Fatalf("second run: %q", got)
	}
}

func TestCloseStopsLogging(t *testing.T) {
	dir := filepath.Join(testutil.TempDir(t), "logs")
	lf := Open(dir, nil)
	lf.Printf("kept")
	lf.Close()
	lf.Close()
	lf.Printf("dropped")
	got := string(testutil.Read(t, filepath.Join(dir, "installer.log")))
	if !strings.Contains(got, "kept") || strings.Contains(got, "dropped") {
		t.Fatalf("log: %q", got)
	}
	// nothing may recreate the folder once it is purged
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	lf.Printf("after purge")
	if _, err := os.Stat(dir); err == nil {
		t.Fatal("a closed log recreated the folder")
	}
}

func TestLockedLogFallsBackToPerRunFile(t *testing.T) {
	dir := filepath.Join(testutil.TempDir(t), "logs")
	main := filepath.Join(dir, "installer.log")
	testutil.Write(t, main, []byte("old line\n"))
	// another program holds installer.log without sharing it
	name, _ := windows.UTF16PtrFromString(main)
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	locked := true
	defer func() {
		if locked {
			windows.CloseHandle(h)
		}
	}()

	lf := Open(dir, nil)
	lf.Printf("run line")
	if !lf.Degraded() || filepath.Dir(lf.Where()) != dir || lf.Where() == main {
		t.Fatalf("expected a per-run file next to installer.log, got %q", lf.Where())
	}
	got := string(testutil.Read(t, lf.Where()))
	if !strings.Contains(got, "run line\n") || !strings.Contains(got, "cannot write "+main) {
		t.Fatalf("fallback log: %q", got)
	}
	lf.Printf("another line")
	if got := string(testutil.Read(t, lf.Where())); !strings.Contains(got, "another line\n") || strings.Count(got, "cannot write") != 1 {
		t.Fatalf("fallback log: %q", got)
	}
	windows.CloseHandle(h)
	locked = false
	if got := string(testutil.Read(t, main)); got != "old line\n" {
		t.Fatalf("locked file changed: %q", got)
	}
}

func TestUnusableFolderFallsBackToTemp(t *testing.T) {
	root := testutil.TempDir(t)
	tmp := filepath.Join(root, "tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMP", tmp)
	t.Setenv("TEMP", tmp)
	// "logs" is a file, so neither installer.log nor the per-run file can be created there
	blocked := filepath.Join(root, "logs")
	testutil.Write(t, blocked, []byte("not a folder"))

	lf := Open(blocked, nil)
	lf.Printf("still logged")
	if !lf.Degraded() || filepath.Dir(lf.Where()) != tmp {
		t.Fatalf("expected a file in %s, got %q", tmp, lf.Where())
	}
	got := string(testutil.Read(t, lf.Where()))
	if !strings.Contains(got, "still logged\n") || strings.Count(got, "cannot write") != 2 {
		t.Fatalf("temp log: %q", got)
	}
}
