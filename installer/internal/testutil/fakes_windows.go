// SPDX-License-Identifier: GPL-3.0-or-later

package testutil

import (
	"sync"
	"testing"

	"golang.org/x/sys/windows"
)

// LockFile opens path without sharing and locks all of its bytes (what a running program or an antivirus scan
// does): renames, deletes and other opens fail with a sharing violation, and reading fails with a lock violation,
// until the returned function is called (also done at the end of the test).
//
// The byte lock is what keeps reads out when the test runs with SeBackupPrivilege enabled (an elevated Git Bash
// enables it for what it starts, as on the CI runner): Go opens a file for reading with FILE_FLAG_BACKUP_SEMANTICS,
// and such an open gets past a share-0 handle that only reads. A byte-range lock holds whatever the privileges.
func LockFile(t testing.TB, path string) (unlock func()) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("locking %s: %v", path, err)
	}
	// from offset 0 (the zeroed Overlapped), 2^64-1 bytes: the whole file, however it grows
	all := new(windows.Overlapped)
	if err := windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, ^uint32(0), ^uint32(0), all); err != nil {
		windows.CloseHandle(h)
		t.Fatalf("locking %s: %v", path, err)
	}
	var once sync.Once
	unlock = func() {
		once.Do(func() {
			windows.UnlockFileEx(h, 0, ^uint32(0), ^uint32(0), all)
			windows.CloseHandle(h)
		})
	}
	t.Cleanup(unlock)
	return unlock
}

// HoldFile opens path the way a running program that merely has it open does (Go's os.Open does the same):
// everyone may still read and write it, but it cannot be renamed or deleted (nor can the folder holding it be
// renamed) until the returned function is called (also done at the end of the test).
func HoldFile(t testing.TB, path string) (release func()) {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("holding %s: %v", path, err)
	}
	var once sync.Once
	release = func() { once.Do(func() { windows.CloseHandle(h) }) }
	t.Cleanup(release)
	return release
}
