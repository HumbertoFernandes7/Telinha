// SPDX-License-Identifier: GPL-3.0-or-later

package asar

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func golden(t *testing.T) (patcher string, vencord []byte) {
	t.Helper()
	dir := filepath.Join("..", "testdata")
	var paths struct{ Patcher string }
	b, err := os.ReadFile(filepath.Join(dir, "paths.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &paths); err != nil {
		t.Fatal(err)
	}
	vencord, err = os.ReadFile(filepath.Join(dir, "vencord-stub.asar"))
	if err != nil {
		t.Fatal(err)
	}
	return paths.Patcher, vencord
}

// The golden file was written by the Node reference (addon/installer/asar.js), itself checked byte for
// byte against a real Vencord-installer stub.
func TestVencordStubMatchesReference(t *testing.T) {
	patcher, want := golden(t)
	if got := VencordStub(patcher); !bytes.Equal(got, want) {
		t.Fatalf("VencordStub differs from the reference:\n got %q\nwant %q", got, want)
	}
}

// The DESIGN notes say the user's real Vencord stub is 219 bytes for this path.
func TestVencordStubKnownSize(t *testing.T) {
	if n := len(VencordStub(`C:\Users\Humbe\AppData\Roaming\Vencord\dist\patcher.js`)); n != 219 {
		t.Fatalf("size %d, want 219", n)
	}
}

func TestLayout(t *testing.T) {
	b := BuildStub("abc")
	hss := binary.LittleEndian.Uint32(b[12:16])
	hs := binary.LittleEndian.Uint32(b[4:8])
	if binary.LittleEndian.Uint32(b[0:4]) != 4 || hs%4 != 0 || hs-8 < hss || binary.LittleEndian.Uint32(b[8:12]) != hs-4 {
		t.Fatalf("bad size fields % x", b[:16])
	}
	pad := b[16+hss : 8+hs]
	if len(bytes.Trim(pad, "0")) != 0 {
		t.Fatalf("padding is not ASCII zeros: %q", pad)
	}
	if !bytes.HasSuffix(b, []byte("abc"+PackageJSON)) {
		t.Fatal("data section wrong")
	}
}

func TestReadFileRoundTrip(t *testing.T) {
	for _, idx := range []string{"", "x", "require(\"a\")", "// Telinha stub v1\nconst é = 1;\n"} {
		b := BuildStub(idx)
		got, err := ReadFile(b, "index.js")
		if err != nil || string(got) != idx {
			t.Fatalf("index.js %q: got %q, %v", idx, got, err)
		}
		pkg, err := ReadFile(b, "package.json")
		if err != nil || string(pkg) != PackageJSON {
			t.Fatalf("package.json: %q, %v", pkg, err)
		}
		if _, err := ReadFile(b, "nope.js"); err != ErrNotFound {
			t.Fatalf("missing file: %v", err)
		}
	}
}

func TestReadFileRejectsGarbage(t *testing.T) {
	for _, b := range [][]byte{nil, []byte("short"), bytes.Repeat([]byte{0xff}, 64), append([]byte{4, 0, 0, 0, 8, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0}, "{x"...)} {
		if _, err := ReadFile(b, "index.js"); err == nil {
			t.Fatalf("accepted %q", b)
		}
	}
	// entry pointing past the end
	hdr := `{"files":{"index.js":{"size":999,"offset":"0"}}}`
	b := binary.LittleEndian.AppendUint32(nil, 4)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(hdr)+8))
	b = binary.LittleEndian.AppendUint32(b, uint32(len(hdr)+4))
	b = binary.LittleEndian.AppendUint32(b, uint32(len(hdr)))
	b = append(b, hdr...)
	if _, err := ReadFile(b, "index.js"); err == nil {
		t.Fatal("accepted out-of-range entry")
	}
}

func TestParseVencordIndexJS(t *testing.T) {
	p := `C:\Users\A "quoted" & <odd>\Vencord\dist\patcher.js`
	if got := ParseVencordIndexJS(VencordIndexJS(p)); got != p {
		t.Fatalf("round trip: %q", got)
	}
	for _, s := range []string{"", `require("x");`, `require('x')`, `// Telinha stub v1` + "\n" + `require("x")`, `require("x") + 1`} {
		if got := ParseVencordIndexJS(s); got != "" {
			t.Fatalf("%q parsed as %q", s, got)
		}
	}
	if got := ParseVencordIndexJS("  require(\"C:\\\\x\")\n"); got != `C:\x` {
		t.Fatalf("trim: %q", got)
	}
}
