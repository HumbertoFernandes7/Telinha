// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"io"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/winver"
)

func TestParseFlags(t *testing.T) {
	o, err := parseFlags([]string{"--install", "--yes", "--payload", `C:\p.zip`, "--discord-dir", `C:\a\Discord`, "--discord-dir", `C:\a\DiscordPTB`, "--appdata", `C:\r`}, io.Discard)
	if err != nil || !o.install || !o.yes || o.payload != `C:\p.zip` || len(o.discordDirs) != 2 || o.appdata != `C:\r` || !o.cli() {
		t.Fatalf("%+v %v", o, err)
	}
	if o, _ := parseFlags(nil, io.Discard); o.cli() {
		t.Fatal("no flags must mean GUI")
	}
	if o, _ := parseFlags([]string{"--payload", "x"}, io.Discard); o.cli() {
		t.Fatal("overrides alone keep the GUI (for testing it on fake trees)")
	}
	for _, bad := range [][]string{{"--install", "--uninstall"}, {"--nope"}, {"extra"}} {
		if _, err := parseFlags(bad, io.Discard); err == nil {
			t.Errorf("%v accepted", bad)
		}
	}
}

func TestWindowsVersionGate(t *testing.T) {
	for _, c := range []struct {
		major, build uint32
		ok           bool
	}{{10, 19041, true}, {10, 19045, true}, {10, 22631, true}, {10, 18363, false}, {6, 9600, false}, {11, 1, true}} {
		if winver.Supported(c.major, c.build) != c.ok {
			t.Errorf("%d.%d: want %v", c.major, c.build, c.ok)
		}
	}
	if err := winver.Check(); err != nil {
		t.Logf("this machine is below the minimum: %v", err)
	}
}
