// SPDX-License-Identifier: GPL-3.0-or-later

package logx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

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

func TestUnusableFolderFallsBackToTemp(t *testing.T) {
	testutil.WindowsOnly(t)
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
