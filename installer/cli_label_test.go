// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
)

func TestTargetAppLabel(t *testing.T) {
	if got := targetAppLabel("app-1.0.9"); got != " app-1.0.9" {
		t.Fatalf("app-* folder: %q", got)
	}
	if got := targetAppLabel(discord.FlatApp); got != "" {
		t.Fatalf("flat root: %q", got)
	}
}
