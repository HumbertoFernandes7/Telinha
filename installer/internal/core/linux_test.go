// SPDX-License-Identifier: GPL-3.0-or-later

package core

import (
	"bytes"
	"errors"
	"io"
	"log"
	"path/filepath"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

// A Linux flatpak Discord: resources right in the root (no app-* folders), and the sandbox has to be opened to
// the Telinha home.
func TestLinuxFlatpakInstallUninstall(t *testing.T) {
	dir := testutil.TempDir(t)
	appdata := filepath.Join(dir, "config")
	patcher := testutil.Vencord(t, appdata)
	root := filepath.Join(dir, "flatpak", "app", "com.discordapp.Discord", "current", "active", "files", "discord")
	res := testutil.DiscordWithVencord(t, root, discord.FlatApp, patcher)
	original := testutil.Read(t, filepath.Join(res, "app.asar"))

	var granted []string
	grantErr := errors.New("flatpak: not installed")
	var failGrant bool
	cfg := &Config{
		AppData:  appdata,
		Installs: []discord.Install{{Branch: "stable", Name: "Discord (Flatpak)", Root: root, Exe: "Discord", Flatpak: "com.discordapp.Discord"}},
		Procs:    &fakeProcs{},
		Log:      log.New(io.Discard, "", 0),
		GrantAccess: func(in discord.Install, dir string) error {
			granted = append(granted, in.Flatpak+" "+dir)
			if failGrant {
				return grantErr
			}
			return nil
		},
	}
	payloadDir := filepath.Join(dir, "payload")
	testutil.Payload(t, payloadDir, "0.1.0", nil)

	ready, err := cfg.Preflight()
	if err != nil || len(ready) != 1 || ready[0].Resources != res {
		t.Fatalf("preflight: %v %+v", err, ready)
	}
	st, err := cfg.Stage(t.Context(), PayloadSource{Local: payloadDir}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r, err := cfg.Apply(st, ready)
	if err != nil {
		t.Fatal(err)
	}
	if in := discord.Inspect(res); in.Kind != discord.KindTelinhaStub || in.Patcher != patcher {
		t.Fatalf("after install: %+v", in)
	}
	if len(granted) != 1 || granted[0] != "com.discordapp.Discord "+cfg.Home() {
		t.Fatalf("sandbox access: %q", granted)
	}
	backup := filepath.Join(cfg.Home(), "backup", "discord", "app.asar")
	if len(r.Targets) != 1 || r.Targets[0].Backup == nil || *r.Targets[0].Backup != backup || !bytes.Equal(testutil.Read(t, backup), original) {
		t.Fatalf("backup: %+v", r.Targets)
	}

	// a failed grant is reported (the stub then falls back to plain Vencord, PAYLOAD.md 3.1)
	failGrant = true
	if _, err := cfg.Apply(nil, ready); !errors.Is(err, grantErr) {
		t.Fatalf("Apply with a failing grant: %v", err)
	}

	u, err := cfg.Uninstall()
	if err != nil || len(u.Restored) != 1 {
		t.Fatalf("uninstall: %v %+v", err, u)
	}
	if !bytes.Equal(testutil.Read(t, filepath.Join(res, "app.asar")), original) {
		t.Fatal("uninstall did not put Vencord's stub back")
	}
}

// Packaged Discords (deb, rpm, tar.gz) have no sandbox: nothing to grant.
func TestLinuxPackageNeedsNoGrant(t *testing.T) {
	dir := testutil.TempDir(t)
	appdata := filepath.Join(dir, "config")
	patcher := testutil.Vencord(t, appdata)
	root := filepath.Join(dir, "usr", "share", "discord")
	testutil.DiscordWithVencord(t, root, discord.FlatApp, patcher)
	payloadDir := filepath.Join(dir, "payload")
	testutil.Payload(t, payloadDir, "0.1.0", nil)
	cfg := &Config{
		AppData:     appdata,
		Installs:    []discord.Install{{Branch: "stable", Name: "Discord", Root: root, Exe: "Discord"}},
		Procs:       &fakeProcs{},
		Log:         log.New(io.Discard, "", 0),
		GrantAccess: func(discord.Install, string) error { t.Fatal("GrantAccess called for a non-flatpak"); return nil },
	}
	ready, err := cfg.Preflight()
	if err != nil {
		t.Fatal(err)
	}
	st, err := cfg.Stage(t.Context(), PayloadSource{Local: payloadDir}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cfg.Apply(st, ready); err != nil {
		t.Fatal(err)
	}
}
