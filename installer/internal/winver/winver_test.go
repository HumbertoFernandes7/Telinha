// SPDX-License-Identifier: GPL-3.0-or-later

package winver

import (
	"strings"
	"testing"
)

func TestSupported(t *testing.T) {
	for _, c := range []struct {
		major, build uint32
		ok           bool
	}{
		{10, MinBuild, true}, {10, MinBuild - 1, false}, {10, 22631, true}, {10, 0, false},
		{11, 1, true}, {6, 9600, false}, {6, 99999, false}, {5, 2600, false},
	} {
		if got := Supported(c.major, c.build); got != c.ok {
			t.Errorf("Supported(%d, %d) = %v, want %v", c.major, c.build, got, c.ok)
		}
	}
}

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

func TestCheckRefusesOldWindows(t *testing.T) {
	old := func() (uint32, uint32, uint32) { return 6, 3, 9600 }
	err := check(old)
	if err == nil {
		t.Fatal("Windows 8.1 accepted")
	}
	if msg := err.Error(); !strings.Contains(msg, "6.3") || !strings.Contains(msg, "9600") {
		t.Fatalf("the message should say which Windows this is: %q", msg)
	}
	if err := check(func() (uint32, uint32, uint32) { return 10, 0, MinBuild - 1 }); err == nil {
		t.Fatal("Windows 10 1909 accepted")
	}
	if err := check(func() (uint32, uint32, uint32) { return 10, 0, MinBuild }); err != nil {
		t.Fatalf("Windows 10 2004 refused: %v", err)
	}
	if err := check(func() (uint32, uint32, uint32) { return 11, 0, 26100 }); err != nil {
		t.Fatalf("Windows 11 refused: %v", err)
	}
}
