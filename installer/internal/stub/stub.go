// SPDX-License-Identifier: GPL-3.0-or-later
//
// Telinha installer: rendering and recognising the Telinha stub (resources\app.asar -> index.js),
// per addon/PAYLOAD.md section 3. The template itself ships in the payload (stub-template.js).

package stub

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

const (
	LoaderPlaceholder  = "__TELINHA_LOADER__"
	PatcherPlaceholder = "__VENCORD_PATCHER__"
)

// Marker identifies a Telinha stub: index.js starts with it (the full first line is "// Telinha stub v1 ...").
const Marker = "// Telinha stub"

var (
	patcherRe = regexp.MustCompile(`(?m)^const VENCORD_PATCHER = ("(?:[^"\\]|\\.)*");`)
	loaderRe  = regexp.MustCompile(`(?m)^const TELINHA_LOADER = ("(?:[^"\\]|\\.)*");`)
)

// Info is what a Telinha stub points at.
type Info struct {
	Loader  string // Telinha loader (main.js in the addon folder)
	Patcher string // official Vencord patcher.js
}

// IsTelinha reports whether index.js is a Telinha stub.
func IsTelinha(indexJS string) bool {
	return strings.HasPrefix(indexJS, Marker)
}

// Parse extracts the loader and Vencord patcher paths from a Telinha stub.
func Parse(indexJS string) (Info, error) {
	if !IsTelinha(indexJS) {
		return Info{}, errors.New("not a Telinha stub")
	}
	var info Info
	if m := patcherRe.FindAllStringSubmatch(indexJS, -1); len(m) == 1 {
		if err := json.Unmarshal([]byte(m[0][1]), &info.Patcher); err != nil {
			return Info{}, fmt.Errorf("bad VENCORD_PATCHER: %w", err)
		}
	}
	if m := loaderRe.FindAllStringSubmatch(indexJS, -1); len(m) == 1 {
		if err := json.Unmarshal([]byte(m[0][1]), &info.Loader); err != nil {
			return Info{}, fmt.Errorf("bad TELINHA_LOADER: %w", err)
		}
	}
	if info.Patcher == "" {
		return Info{}, errors.New("Telinha stub without exactly one VENCORD_PATCHER line")
	}
	return info, nil
}

// Render fills a stub template (byte for byte, no normalisation). Each placeholder must appear exactly
// once, and the result must parse back to the same paths (so uninstall can always find Vencord again).
func Render(template, loaderPath, patcherPath string) (string, error) {
	for _, p := range []string{LoaderPlaceholder, PatcherPlaceholder} {
		if n := strings.Count(template, p); n != 1 {
			return "", fmt.Errorf("stub template: placeholder %s found %d times (want 1)", p, n)
		}
	}
	out := strings.Replace(template, LoaderPlaceholder, JSString(loaderPath), 1)
	out = strings.Replace(out, PatcherPlaceholder, JSString(patcherPath), 1)
	info, err := Parse(out)
	if err != nil {
		return "", fmt.Errorf("stub template: rendered stub does not parse: %w", err)
	}
	if info.Patcher != patcherPath || info.Loader != loaderPath {
		return "", errors.New("stub template: rendered stub does not round-trip")
	}
	return out, nil
}

// JSString is JavaScript's JSON.stringify for a string (no HTML escaping).
func JSString(s string) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimSuffix(b.String(), "\n")
}
