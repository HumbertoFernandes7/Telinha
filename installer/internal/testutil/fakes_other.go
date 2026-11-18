// SPDX-License-Identifier: GPL-3.0-or-later

//go:build !windows

package testutil

import "testing"

// LockFile and HoldFile stand for files a running program keeps open. Only Windows then refuses to rename or
// delete them, so elsewhere the tests that need one are skipped.
func LockFile(t testing.TB, path string) (unlock func()) {
	t.Helper()
	t.Skip("needs Windows file sharing rules")
	return func() {}
}

func HoldFile(t testing.TB, path string) (release func()) {
	t.Helper()
	t.Skip("needs Windows file sharing rules")
	return func() {}
}
