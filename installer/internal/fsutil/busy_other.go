// SPDX-License-Identifier: GPL-3.0-or-later

//go:build !windows

package fsutil

// isSharingViolation: only Windows refuses to replace a file another process holds open.
func isSharingViolation(error) bool { return false }
