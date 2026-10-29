// SPDX-License-Identifier: GPL-3.0-or-later

package logx

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

func TestBigLogIsRotatedAtOpen(t *testing.T) {
	dir := filepath.Join(testutil.TempDir(t), "logs")
	main := filepath.Join(dir, "installer.log")
	testutil.Write(t, main, bytes.Repeat([]byte("old line\n"), maxSize/9+10)) // just over 512 KiB
	Open(dir, nil).Printf("fresh start")
	got := string(testutil.Read(t, main))
	if strings.Contains(got, "old line") || !strings.Contains(got, "fresh start") {
		t.Fatalf("the new log must start empty: %q", got)
	}
	if rotated := testutil.Read(t, main+".1"); !bytes.HasPrefix(rotated, []byte("old line")) {
		t.Fatalf("installer.log.1 should hold the old lines: %d bytes", len(rotated))
	}

	// a log under the limit is only appended to
	dir2 := filepath.Join(testutil.TempDir(t), "logs")
	testutil.Write(t, filepath.Join(dir2, "installer.log"), []byte("small\n"))
	Open(dir2, nil).Printf("more")
	if got := string(testutil.Read(t, filepath.Join(dir2, "installer.log"))); !strings.HasPrefix(got, "small\n") {
		t.Fatalf("%q", got)
	}
	if _, err := os.Stat(filepath.Join(dir2, "installer.log.1")); err == nil {
		t.Fatal("a small log was rotated")
	}

	// the next rotation replaces an older installer.log.1 (only one generation is kept)
	testutil.Write(t, main+".1", []byte("ancient\n"))
	testutil.Write(t, main, bytes.Repeat([]byte("newer line\n"), maxSize/11+10))
	Open(dir, nil).Printf("again")
	if rotated := testutil.Read(t, main+".1"); bytes.Contains(rotated, []byte("ancient")) || !bytes.HasPrefix(rotated, []byte("newer line")) {
		t.Fatalf("installer.log.1 was not replaced: %q...", rotated[:20])
	}
}

func TestExtraWriterGetsEveryLine(t *testing.T) {
	dir := filepath.Join(testutil.TempDir(t), "logs")
	var extra bytes.Buffer
	lf := Open(dir, &extra)
	lf.Printf("to both %d", 1)
	lf.Printf("and again")
	if got := extra.String(); !strings.Contains(got, "to both 1\n") || !strings.Contains(got, "and again\n") {
		t.Fatalf("extra: %q", got)
	}
	if got := string(testutil.Read(t, filepath.Join(dir, "installer.log"))); !strings.Contains(got, "to both 1\n") {
		t.Fatalf("file: %q", got)
	}
	// lines carry a date and a time with microseconds
	if !strings.Contains(extra.String(), ":") || !strings.Contains(extra.String(), "/") {
		t.Fatalf("no timestamp: %q", extra.String())
	}
}

// The appender is what the logger writes to; a stray reference to it after Close must stay silent too.
func TestWriteAfterCloseIsDropped(t *testing.T) {
	dir := filepath.Join(testutil.TempDir(t), "logs")
	lf := Open(dir, nil)
	lf.Printf("kept")
	lf.Close()
	n, err := lf.app.Write([]byte("late line\n"))
	if err != nil || n != len("late line\n") {
		t.Fatalf("%d %v", n, err)
	}
	if got := string(testutil.Read(t, filepath.Join(dir, "installer.log"))); strings.Contains(got, "late line") {
		t.Fatalf("a closed log wrote: %q", got)
	}
}

// Nothing can be written anywhere: the installer must go on without a log, and say where it tried last.
func TestNoWritablePlaceAtAll(t *testing.T) {
	root := testutil.TempDir(t)
	blocker := filepath.Join(root, "blocker")
	testutil.Write(t, blocker, []byte("a file, not a folder"))
	t.Setenv("TMP", filepath.Join(blocker, "tmp"))
	t.Setenv("TEMP", filepath.Join(blocker, "tmp"))

	lf := Open(filepath.Join(blocker, "logs"), nil)
	lf.Printf("first")
	lf.Printf("second") // the last candidate is tried again with every line
	if !lf.Degraded() {
		t.Fatal("not degraded")
	}
	if filepath.Dir(lf.Where()) != filepath.Join(blocker, "tmp") || !strings.HasPrefix(filepath.Base(lf.Where()), "TelinhaInstaller-") {
		t.Fatalf("Where() = %q: it should name the last place that was tried", lf.Where())
	}
	lf.Close()
}

func TestPathsAreNamedAfterThePid(t *testing.T) {
	dir := filepath.Join(testutil.TempDir(t), "logs")
	lf := Open(dir, nil)
	got := lf.app.paths
	if len(got) != 3 || got[0] != filepath.Join(dir, "installer.log") ||
		!strings.HasPrefix(filepath.Base(got[1]), "installer-") || !strings.HasSuffix(got[1], ".log") ||
		filepath.Dir(got[2]) != filepath.Clean(os.TempDir()) || !strings.HasPrefix(filepath.Base(got[2]), "TelinhaInstaller-") {
		t.Fatalf("candidates: %v", got)
	}
}
