// SPDX-License-Identifier: GPL-3.0-or-later

package asar

import (
	"encoding/binary"
	"testing"
)

func rawArchive(header, data string) []byte {
	b := binary.LittleEndian.AppendUint32(nil, 4)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(header)+8))
	b = binary.LittleEndian.AppendUint32(b, uint32(len(header)+4))
	b = binary.LittleEndian.AppendUint32(b, uint32(len(header)))
	return append(append(b, header...), data...)
}

// A path with a backslash escape JSON does not know matches the stub's shape but is not a path.
func TestParseVencordIndexJSInvalidEscape(t *testing.T) {
	for _, s := range []string{`require("C:\x\patcher.js")`, `require("\u00zz")`} {
		if got := ParseVencordIndexJS(s); got != "" {
			t.Errorf("%q parsed as %q", s, got)
		}
	}
	// escapes JSON does know are fine
	if got := ParseVencordIndexJS(`require("C:\\a\\\"b\"\u00e9")`); got != `C:\a\"b"é` {
		t.Fatalf("got %q", got)
	}
}

func TestReadFileRejectsMalformedEntries(t *testing.T) {
	for name, header := range map[string]string{
		"offset is not a number": `{"files":{"index.js":{"size":1,"offset":"abc"}}}`,
		"negative offset":        `{"files":{"index.js":{"size":1,"offset":"-1"}}}`,
		"negative size":          `{"files":{"index.js":{"size":-1,"offset":"0"}}}`,
		"no size":                `{"files":{"index.js":{"offset":"0"}}}`,
		"a folder":               `{"files":{"index.js":{"files":{}}}}`,
		"unpacked":               `{"files":{"index.js":{"size":1,"offset":"0","unpacked":true}}}`,
		"not json":               `{"files":`,
		"past the end":           `{"files":{"index.js":{"size":5,"offset":"0"}}}`,
	} {
		_, err := ReadFile(rawArchive(header, "x"), "index.js")
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		wantNotFound := name == "no size" || name == "a folder" || name == "unpacked"
		if (err == ErrNotFound) != wantNotFound {
			t.Errorf("%s: %v (ErrNotFound=%v expected)", name, err, wantNotFound)
		}
	}
	if got, err := ReadFile(rawArchive(`{"files":{"index.js":{"size":3,"offset":"2"}}}`, "xxabc"), "index.js"); err != nil || string(got) != "abc" {
		t.Fatalf("offset: %q %v", got, err)
	}
	// header sizes that point outside the archive
	b := rawArchive(`{"files":{}}`, "")
	binary.LittleEndian.PutUint32(b[4:8], 1<<30)
	if _, err := ReadFile(b, "index.js"); err == nil {
		t.Fatal("header size past the end accepted")
	}
	b = rawArchive(`{"files":{}}`, "")
	binary.LittleEndian.PutUint32(b[12:16], 1<<30)
	if _, err := ReadFile(b, "index.js"); err == nil {
		t.Fatal("header string size past the end accepted")
	}
}

func TestBuildStubIsDeterministicAndAligned(t *testing.T) {
	for _, js := range []string{"", "a", "ab", "abc", "abcd", "// Telinha stub\n" + string(make([]byte, 1000))} {
		a, b := BuildStub(js), BuildStub(js)
		if string(a) != string(b) {
			t.Fatalf("not deterministic for %d bytes", len(js))
		}
		if hs := binary.LittleEndian.Uint32(a[4:8]); hs%4 != 0 {
			t.Fatalf("header size %d is not 4-byte aligned", hs)
		}
	}
}
