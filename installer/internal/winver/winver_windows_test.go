// SPDX-License-Identifier: GPL-3.0-or-later

package winver

import "testing"

func TestCurrentIsARealWindows(t *testing.T) {
	major, _, build := Current()
	if major < 6 || build == 0 {
		t.Fatalf("Current() = %d.x build %d", major, build)
	}
}

// Check on this very machine: it must agree with Supported (the machine running the tests may itself be too old).
func TestCheckAgreesWithSupported(t *testing.T) {
	major, _, build := Current()
	if err := Check(); (err == nil) != Supported(major, build) {
		t.Fatalf("Check() = %v for Windows %d build %d", err, major, build)
	}
}
