// SPDX-License-Identifier: GPL-3.0-or-later

package stub

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

func TestRenderMatchesNodeReference(t *testing.T) {
	dir := testutil.TestdataDir()
	var paths struct{ Patcher, Loader string }
	if err := json.Unmarshal(testutil.Read(t, filepath.Join(dir, "paths.json")), &paths); err != nil {
		t.Fatal(err)
	}
	idx, err := Render(testutil.StubTemplate(t), paths.Loader, paths.Patcher)
	if err != nil {
		t.Fatal(err)
	}
	want := testutil.Read(t, filepath.Join(dir, "telinha-stub.asar"))
	if got := asar.BuildStub(idx); !bytes.Equal(got, want) {
		t.Fatalf("stub differs from the Node reference (addon/installer):\n got %q\nwant %q", got, want)
	}
}

// The fixture must stay identical to the template the payload ships (when the repo is around).
func TestFixtureIsCurrentTemplate(t *testing.T) {
	src := filepath.Join(testutil.TestdataDir(), "..", "..", "..", "addon", "loader", "stub-template.js")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Skip("addon/loader/stub-template.js not available:", err)
	}
	if string(b) != testutil.StubTemplate(t) {
		t.Fatal("internal/testdata/stub-template.js is out of date: copy addon/loader/stub-template.js")
	}
}

func TestRenderParseRoundTrip(t *testing.T) {
	tpl := testutil.StubTemplate(t)
	for _, p := range [][2]string{
		{`C:\Users\a\AppData\Roaming\Telinha\addon\main.js`, `C:\Users\a\AppData\Roaming\Vencord\dist\patcher.js`},
		{`C:\Users\Zé "Q" & <b>\Telinha\addon\main.js`, `D:\Ünïcödé\Vencord\dist\patcher.js`},
	} {
		idx, err := Render(tpl, p[0], p[1])
		if err != nil {
			t.Fatal(err)
		}
		if !IsTelinha(idx) || !strings.HasPrefix(idx, "// Telinha stub v1") {
			t.Fatal("rendered stub lacks the marker")
		}
		if strings.Contains(idx, `\u003c`) || strings.Contains(idx, `\u0026`) {
			t.Fatal("HTML escaping leaked into the stub")
		}
		info, err := Parse(idx)
		if err != nil || info.Loader != p[0] || info.Patcher != p[1] {
			t.Fatalf("parse: %+v %v", info, err)
		}
	}
}

func TestRenderRejectsBadTemplates(t *testing.T) {
	good := testutil.StubTemplate(t)
	for name, tpl := range map[string]string{
		"no loader":     strings.Replace(good, LoaderPlaceholder, `"x"`, 1),
		"two patchers":  good + "\n// " + PatcherPlaceholder,
		"no marker":     strings.Replace(good, "// Telinha stub", "// Something", 1),
		"no const line": strings.Replace(good, "const VENCORD_PATCHER = ", "let VENCORD_PATCHER = ", 1),
	} {
		if _, err := Render(tpl, `C:\l\main.js`, `C:\v\patcher.js`); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParse(t *testing.T) {
	if _, err := Parse(`require("x")`); err == nil {
		t.Fatal("Vencord stub parsed as Telinha")
	}
	if _, err := Parse("// Telinha stub v1\nconst TELINHA_LOADER = \"a\";\n"); err == nil {
		t.Fatal("stub without patcher accepted")
	}
	info, err := Parse("// Telinha stub v9\nconst TELINHA_LOADER = \"a\";\nconst VENCORD_PATCHER = \"C:\\\\v\\\\patcher.js\";\n")
	if err != nil || info.Patcher != `C:\v\patcher.js` || info.Loader != "a" {
		t.Fatalf("%+v %v", info, err)
	}
}
