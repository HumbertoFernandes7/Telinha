// SPDX-License-Identifier: GPL-3.0-or-later

package stub

import (
	"strings"
	"testing"
)

func TestParseRejectsMalformedPaths(t *testing.T) {
	head := "// Telinha stub v1\n"
	for name, js := range map[string]string{
		"patcher with a bad escape": head + "const TELINHA_LOADER = \"a\";\nconst VENCORD_PATCHER = \"C:\\x\\p.js\";\n",
		"loader with a bad escape":  head + "const TELINHA_LOADER = \"C:\\x\\m.js\";\nconst VENCORD_PATCHER = \"p\";\n",
		"two patcher lines":         head + "const VENCORD_PATCHER = \"a\";\nconst VENCORD_PATCHER = \"b\";\n",
		"empty patcher":             head + "const VENCORD_PATCHER = \"\";\n",
		"nothing":                   head,
		"marker in the middle":      "x\n" + head + "const VENCORD_PATCHER = \"a\";\n",
	} {
		if info, err := Parse(js); err == nil {
			t.Errorf("%s: accepted %+v", name, info)
		}
	}
	// a stub with two loader lines still parses: only the patcher is required (callers refuse an empty loader themselves)
	info, err := Parse(head + "const TELINHA_LOADER = \"a\";\nconst TELINHA_LOADER = \"b\";\nconst VENCORD_PATCHER = \"p\";\n")
	if err != nil || info.Loader != "" || info.Patcher != "p" {
		t.Fatalf("%+v %v", info, err)
	}
	// lines must start at the beginning of a line
	if info, err := Parse(head + "  const VENCORD_PATCHER = \"p\";\n"); err == nil {
		t.Fatalf("an indented line was accepted: %+v", info)
	}
	// Windows line endings after the semicolon do not matter
	if info, err := Parse(head + "const VENCORD_PATCHER = \"p\";\r\nconst TELINHA_LOADER = \"l\";\r\n"); err != nil || info.Patcher != "p" || info.Loader != "l" {
		t.Fatalf("CRLF: %+v %v", info, err)
	}
}

func TestRenderChecksTheRoundTrip(t *testing.T) {
	// the loader's placeholder sits in a comment: the rendered stub parses, but not to the loader we asked for
	tpl := "// Telinha stub v1\nconst TELINHA_LOADER = \"decoy\"; // " + LoaderPlaceholder + "\nconst VENCORD_PATCHER = " + PatcherPlaceholder + ";\n"
	_, err := Render(tpl, `C:\t\main.js`, `C:\v\patcher.js`)
	if err == nil || !strings.Contains(err.Error(), "round-trip") {
		t.Fatalf("got %v", err)
	}
	// and the same template written properly works
	good := "// Telinha stub v1\nconst TELINHA_LOADER = " + LoaderPlaceholder + ";\nconst VENCORD_PATCHER = " + PatcherPlaceholder + ";\n"
	out, err := Render(good, `C:\t\main.js`, `C:\v\patcher.js`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `const TELINHA_LOADER = "C:\\t\\main.js";`) {
		t.Fatalf("paths must be JSON strings: %q", out)
	}
}

func TestRenderRejectsAnEmptyOrUnparsableResult(t *testing.T) {
	for name, tpl := range map[string]string{
		"no placeholders at all": "// Telinha stub v1\n",
		"placeholders twice":     "// Telinha stub v1\n" + LoaderPlaceholder + LoaderPlaceholder + PatcherPlaceholder,
		"only the patcher":       "// Telinha stub v1\nconst VENCORD_PATCHER = " + PatcherPlaceholder + ";\n",
	} {
		if _, err := Render(tpl, "l", "p"); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// an empty patcher path cannot be found again later: refused
	good := "// Telinha stub v1\nconst TELINHA_LOADER = " + LoaderPlaceholder + ";\nconst VENCORD_PATCHER = " + PatcherPlaceholder + ";\n"
	if _, err := Render(good, `C:\l\main.js`, ""); err == nil {
		t.Fatal("an empty Vencord path was rendered")
	}
}

func TestJSString(t *testing.T) {
	for in, want := range map[string]string{
		"":                 `""`,
		`C:\a\b`:           `"C:\\a\\b"`,
		`a "q" <b> & c`:    `"a \"q\" <b> & c"`, // no HTML escaping, like JSON.stringify
		"line\nbreak\ttab": `"line\nbreak\ttab"`,
		"é ✓":              `"é ✓"`,
		"\u2028 separator": `"\u2028 separator"`, // Go always escapes these two (JSON.stringify does not); both are the same JS string
		"\x00 nul":         `"\u0000 nul"`,
	} {
		if got := JSString(in); got != want {
			t.Errorf("JSString(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestIsTelinha(t *testing.T) {
	for in, want := range map[string]bool{
		"// Telinha stub v1\n": true, "// Telinha stub": true, "// Telinha": false, "": false,
		" // Telinha stub v1": false, "require(\"x\")": false, "// telinha stub": false,
	} {
		if got := IsTelinha(in); got != want {
			t.Errorf("IsTelinha(%q) = %v", in, got)
		}
	}
}
