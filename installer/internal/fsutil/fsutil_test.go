// SPDX-License-Identifier: GPL-3.0-or-later

package fsutil

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// tmp is a short temp folder (short paths keep Windows happy), removed at the end. These tests stay
// self-contained (no internal/testutil): the packages above fsutil import both.
func tmp(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "tlfs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func write(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fast(t *testing.T) {
	t.Helper()
	old := RetryDelay
	RetryDelay = time.Millisecond
	t.Cleanup(func() { RetryDelay = old })
}

// lock opens path without sharing (what an antivirus scan or a running program does): other opens, renames
// and deletes fail with a sharing violation until unlock.
func lock(t *testing.T, path string) (unlock func()) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	done := false
	unlock = func() {
		if !done {
			done = true
			windows.CloseHandle(h)
		}
	}
	t.Cleanup(unlock)
	return unlock
}

func TestIsBusy(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		busy bool
	}{
		"nil":               {nil, false},
		"plain error":       {errors.New("boom"), false},
		"not exist":         {fs.ErrNotExist, false},
		"permission":        {fs.ErrPermission, true},
		"wrapped":           {fmt.Errorf("x: %w", fs.ErrPermission), true},
		"sharing violation": {fmt.Errorf("rename: %w", windows.ERROR_SHARING_VIOLATION), true},
		"lock violation":    {windows.ERROR_LOCK_VIOLATION, true},
		"access denied":     {windows.ERROR_ACCESS_DENIED, true},
		"file not found":    {windows.ERROR_FILE_NOT_FOUND, false},
		"other errno":       {syscall.Errno(1), false},
	} {
		if got := IsBusy(tc.err); got != tc.busy {
			t.Errorf("%s: IsBusy = %v, want %v", name, got, tc.busy)
		}
	}
}

func TestRetry(t *testing.T) {
	fast(t)
	t.Run("first try", func(t *testing.T) {
		calls := 0
		if err := Retry(func() error { calls++; return nil }); err != nil || calls != 1 {
			t.Fatalf("err %v after %d calls", err, calls)
		}
	})
	t.Run("a real error is not retried", func(t *testing.T) {
		calls := 0
		boom := errors.New("boom")
		if err := Retry(func() error { calls++; return boom }); err != boom || calls != 1 {
			t.Fatalf("err %v after %d calls", err, calls)
		}
	})
	t.Run("busy then free", func(t *testing.T) {
		calls := 0
		err := Retry(func() error {
			calls++
			if calls < 4 {
				return windows.ERROR_SHARING_VIOLATION
			}
			return nil
		})
		if err != nil || calls != 4 {
			t.Fatalf("err %v after %d calls", err, calls)
		}
	})
	t.Run("busy for good gives up after 10 tries", func(t *testing.T) {
		calls := 0
		err := Retry(func() error { calls++; return windows.ERROR_SHARING_VIOLATION })
		if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) || calls != 10 {
			t.Fatalf("err %v after %d calls", err, calls)
		}
	})
	t.Run("waits RetryDelay between tries", func(t *testing.T) {
		RetryDelay = 20 * time.Millisecond
		defer func() { RetryDelay = time.Millisecond }()
		start := time.Now()
		calls := 0
		_ = Retry(func() error {
			calls++
			if calls < 3 {
				return fs.ErrPermission
			}
			return nil
		})
		if d := time.Since(start); d < 35*time.Millisecond {
			t.Fatalf("two retries took only %v", d)
		}
	})
}

func TestRetryAgainstARealSharingViolation(t *testing.T) {
	fast(t)
	dir := tmp(t)
	f := filepath.Join(dir, "held.txt")
	write(t, f, "x")
	unlock := lock(t, f)
	calls := 0
	err := Retry(func() error {
		calls++
		if calls == 3 {
			unlock() // the other program lets go during our retries
		}
		return os.Remove(f)
	})
	if err != nil || calls != 3 {
		t.Fatalf("remove: %v after %d calls", err, calls)
	}
	if Exists(f) {
		t.Fatal("file still there")
	}
}

func TestWriteFileAtomic(t *testing.T) {
	fast(t)
	dir := tmp(t)
	p := filepath.Join(dir, "app.asar")

	// creates, then replaces; no temp file is left
	if err := WriteFileAtomic(p, []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(p, []byte("two")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "two" {
		t.Fatalf("content %q", b)
	}
	if Exists(p + ".telinha-tmp") {
		t.Fatal("temp file left behind")
	}

	// the temp file cannot be written: no folder
	if err := WriteFileAtomic(filepath.Join(dir, "nope", "x"), []byte("x")); err == nil {
		t.Fatal("write into a missing folder succeeded")
	}

	// a file that is held open: the rename keeps failing, the temp file is cleaned up
	unlock := lock(t, p)
	err := WriteFileAtomic(p, []byte("three"))
	unlock()
	if err == nil || !IsBusy(err) {
		t.Fatalf("held file: %v", err)
	}
	if Exists(p + ".telinha-tmp") {
		t.Fatal("temp file left behind after a failed rename")
	}
	if b, _ := os.ReadFile(p); string(b) != "two" {
		t.Fatalf("the held file changed: %q", b)
	}

	// ...and it works once the other program lets go while we retry
	unlock = lock(t, p)
	RetryDelay = 30 * time.Millisecond
	time.AfterFunc(80*time.Millisecond, unlock)
	if err := WriteFileAtomic(p, []byte("four")); err != nil {
		t.Fatalf("after release: %v", err)
	}
	if b, _ := os.ReadFile(p); string(b) != "four" {
		t.Fatalf("content %q", b)
	}
}

func TestSameContentAndPredicates(t *testing.T) {
	dir := tmp(t)
	f := filepath.Join(dir, "a.txt")
	write(t, f, "abc")
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "missing")

	if !SameContent(f, []byte("abc")) || SameContent(f, []byte("abd")) || SameContent(f, nil) || SameContent(missing, []byte("abc")) || SameContent(sub, nil) {
		t.Fatal("SameContent")
	}
	for name, tc := range map[string]struct {
		got  bool
		want bool
	}{
		"Exists file":    {Exists(f), true},
		"Exists dir":     {Exists(sub), true},
		"Exists missing": {Exists(missing), false},
		"IsFile file":    {IsFile(f), true},
		"IsFile dir":     {IsFile(sub), false},
		"IsFile missing": {IsFile(missing), false},
		"IsDir file":     {IsDir(f), false},
		"IsDir dir":      {IsDir(sub), true},
		"IsDir missing":  {IsDir(missing), false},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %v", name, tc.got)
		}
	}
}

func TestCopyFile(t *testing.T) {
	dir := tmp(t)
	src, dst := filepath.Join(dir, "src.txt"), filepath.Join(dir, "dst.txt")
	write(t, src, "new content")
	write(t, dst, "old and much longer content")
	if err := CopyFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "new content" {
		t.Fatalf("dst %q (must be truncated)", b)
	}

	if err := CopyFile(filepath.Join(dir, "missing"), dst); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing source: %v", err)
	}
	if err := CopyFile(src, filepath.Join(dir, "no", "such", "dst")); err == nil {
		t.Fatal("copy into a missing folder succeeded")
	}
	// a folder opens fine on Windows but cannot be read: the copy fails half way and reports it
	if err := CopyFile(dir, filepath.Join(dir, "from-dir.txt")); err == nil {
		t.Fatal("copying a folder as a file succeeded")
	}
}

func TestCopyTree(t *testing.T) {
	dir := tmp(t)
	src, dst := filepath.Join(dir, "src"), filepath.Join(dir, "dst")
	write(t, filepath.Join(src, "a.txt"), "a")
	write(t, filepath.Join(src, "deep", "er", "b.txt"), "b")
	if err := os.MkdirAll(filepath.Join(src, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := CopyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]string{"a.txt": "a", filepath.Join("deep", "er", "b.txt"): "b"} {
		if b, err := os.ReadFile(filepath.Join(dst, p)); err != nil || string(b) != want {
			t.Errorf("%s: %q %v", p, b, err)
		}
	}
	if !IsDir(filepath.Join(dst, "empty")) {
		t.Error("empty folder not copied")
	}

	// copying again over the same destination is fine (files are truncated)
	if err := CopyTree(src, dst); err != nil {
		t.Fatalf("second copy: %v", err)
	}

	// a missing source: the walk reports it
	if err := CopyTree(filepath.Join(dir, "missing"), filepath.Join(dir, "out")); err == nil {
		t.Fatal("missing source accepted")
	}
	// the destination is a file: no folder can be made there
	blocker := filepath.Join(dir, "blocker")
	write(t, blocker, "x")
	if err := CopyTree(src, blocker); err == nil {
		t.Fatal("copy over a file accepted")
	}
	// the destination of one file is a folder: the file copy fails
	clash := filepath.Join(dir, "clash")
	if err := os.MkdirAll(filepath.Join(clash, "a.txt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := CopyTree(src, clash); err == nil {
		t.Fatal("file over a folder accepted")
	}
}

// Anything that is neither a regular file nor a folder (a symlink, a junction) is refused.
func TestCopyTreeRejectsLinks(t *testing.T) {
	dir := tmp(t)
	src := filepath.Join(dir, "src")
	write(t, filepath.Join(src, "real.txt"), "x")
	if err := os.Symlink(filepath.Join(src, "real.txt"), filepath.Join(src, "link.txt")); err != nil {
		// no symlink privilege here: a directory junction (no privilege needed) is the same kind of entry
		other := filepath.Join(dir, "other")
		if err := os.Mkdir(other, 0o755); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(src, "junction"), other).CombinedOutput(); err != nil {
			t.Skipf("cannot create a symlink or a junction here: %v %s", err, out)
		}
	}
	if err := CopyTree(src, filepath.Join(dir, "dst")); err == nil {
		t.Fatal("a link was copied")
	}
}

func TestRemoveAll(t *testing.T) {
	fast(t)
	dir := tmp(t)
	tree := filepath.Join(dir, "tree")
	write(t, filepath.Join(tree, "a", "b.txt"), "b")
	if err := RemoveAll(tree); err != nil || Exists(tree) {
		t.Fatalf("remove: %v exists=%v", err, Exists(tree))
	}
	if err := RemoveAll(tree); err != nil {
		t.Fatalf("removing what is not there: %v", err)
	}

	// a file held open blocks the removal until it is released
	write(t, filepath.Join(tree, "held.txt"), "h")
	unlock := lock(t, filepath.Join(tree, "held.txt"))
	if err := RemoveAll(tree); err == nil {
		t.Fatal("removed a tree with a file held open")
	}
	RetryDelay = 30 * time.Millisecond
	time.AfterFunc(80*time.Millisecond, unlock)
	if err := RemoveAll(tree); err != nil || Exists(tree) {
		t.Fatalf("after release: %v exists=%v", err, Exists(tree))
	}
}
