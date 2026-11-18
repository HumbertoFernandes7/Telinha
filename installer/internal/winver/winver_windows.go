// SPDX-License-Identifier: GPL-3.0-or-later

package winver

import "golang.org/x/sys/windows"

// Current returns the real Windows version (RtlGetVersion is not affected by compatibility shims).
func Current() (major, minor, build uint32) {
	v := windows.RtlGetVersion()
	return v.MajorVersion, v.MinorVersion, v.BuildNumber
}

// Check returns an error when this Windows is too old.
func Check() error { return check(Current) }
