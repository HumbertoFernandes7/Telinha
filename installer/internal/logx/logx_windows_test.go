// SPDX-License-Identifier: GPL-3.0-or-later

package logx

import (
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

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
