// SPDX-License-Identifier: GPL-3.0-or-later

package discord

import (
	"os"
	"path/filepath"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/stub"
)

// Kind classifies resources\app.asar (addon/PAYLOAD.md 3.3).
type Kind string

const (
	KindMissing         Kind = "missing"
	KindDiscordOriginal Kind = "discord-original"
	KindVencordStub     Kind = "vencord-stub"
	KindTelinhaStub     Kind = "telinha-stub"
	KindUnknown         Kind = "unknown"
)

// MaxStubSize: anything bigger is Discord's own app.asar.
const MaxStubSize = 64 << 10

// Inspection is what one resources folder holds.
type Inspection struct {
	Kind        Kind
	HasOriginal bool   // resources\_app.asar exists (Vencord's own "patched" check)
	Patcher     string // Vencord patcher.js the stub loads (vencord-stub / telinha-stub)
	Loader      string // Telinha loader path (telinha-stub)
	Bytes       []byte // the stub bytes (vencord-stub / telinha-stub)
}

// Inspect classifies <resources>\app.asar.
func Inspect(resources string) Inspection {
	in := Inspection{Kind: KindMissing}
	if _, err := os.Stat(filepath.Join(resources, "_app.asar")); err == nil {
		in.HasOriginal = true
	}
	p := filepath.Join(resources, "app.asar")
	fi, err := os.Stat(p)
	switch {
	case err != nil:
		return in
	case fi.IsDir():
		in.Kind = KindUnknown
		return in
	case fi.Size() > MaxStubSize:
		in.Kind = KindDiscordOriginal
		return in
	}
	data, err := os.ReadFile(p)
	if err != nil {
		in.Kind = KindUnknown
		return in
	}
	return Classify(data, in.HasOriginal)
}

// Classify classifies app.asar bytes.
func Classify(data []byte, hasOriginal bool) Inspection {
	in := Inspection{Kind: KindDiscordOriginal, HasOriginal: hasOriginal}
	if len(data) > MaxStubSize {
		return in
	}
	index, err := asar.ReadFile(data, "index.js")
	if err != nil {
		if err == asar.ErrNotFound {
			in.Kind = KindUnknown
		}
		return in
	}
	if p := asar.ParseVencordIndexJS(string(index)); p != "" {
		in.Kind, in.Patcher, in.Bytes = KindVencordStub, p, data
		return in
	}
	if stub.IsTelinha(string(index)) {
		// Patcher stays "" when the VENCORD_PATCHER line can't be read; callers refuse to act on it.
		info, _ := stub.Parse(string(index))
		in.Kind, in.Patcher, in.Loader, in.Bytes = KindTelinhaStub, info.Patcher, info.Loader, data
		return in
	}
	in.Kind = KindUnknown
	return in
}
