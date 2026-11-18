// SPDX-License-Identifier: GPL-3.0-or-later

// Package winver checks the Windows version: Telinha supports Windows 10 2004 (build 19041) or newer
// (the per-process audio loopback used for whole-screen audio is not available before that).
package winver

import "fmt"

// MinBuild is Windows 10 version 2004.
const MinBuild = 19041

// Supported reports whether a Windows version is new enough.
func Supported(major, build uint32) bool {
	return major > 10 || (major == 10 && build >= MinBuild)
}

// check is Check with the version source injected (the tests feed it old versions).
func check(current func() (major, minor, build uint32)) error {
	major, minor, build := current()
	if !Supported(major, build) {
		return fmt.Errorf("Windows %d.%d build %d", major, minor, build)
	}
	return nil
}
