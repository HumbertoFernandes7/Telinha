// SPDX-License-Identifier: GPL-3.0-or-later

package discord

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

// rawAsar builds an archive from a header the test writes by hand (asar.BuildStub always has index.js).
func rawAsar(header, data string) []byte {
	b := binary.LittleEndian.AppendUint32(nil, 4)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(header)+8))
	b = binary.LittleEndian.AppendUint32(b, uint32(len(header)+4))
	b = binary.LittleEndian.AppendUint32(b, uint32(len(header)))
	return append(append(b, header...), data...)
}

func TestCompareVersionsAllBranches(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"app-1.0.0", "app-1.0", 1}, // the longer one is newer
		{"app-1.0", "app-1.0.0", -1},
		{"app-1.0.9", "app-1.0.10", -1}, // numbers, not text
		{"APP-1.0.9", "app-1.0.9", 0},   // case does not matter
		{"1.0.9", "app-1.0.9", 0},       // the prefix is optional
		{"app-1.0.beta", "app-1.0.alpha", 1},
		{"app-1.0.alpha", "app-1.0.beta", -1},
		{"app-1.0.alpha", "app-1.0.alpha", 0},
		{"app-1.0.5", "app-1.0.5a", -1},
		{"app-1.0.5a", "app-1.0.5", 1},
		{"app-2", "app-10", -1},
		{"", "", 0},
	} {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestFolderHelpers(t *testing.T) {
	root := testutil.TempDir(t)
	if Newest(filepath.Join(root, "missing")) != "" || len(AppFolders(filepath.Join(root, "missing"))) != 0 {
		t.Fatal("a missing root has no app folders")
	}
	os.MkdirAll(filepath.Join(root, "Discord"), 0o755)
	if Newest(filepath.Join(root, "Discord")) != "" {
		t.Fatal("a root without app-* folders has no newest")
	}
	// a plain file named like an app folder is not one
	testutil.Write(t, filepath.Join(root, "Discord", "app-9.9.9"), []byte("file"))
	if Newest(filepath.Join(root, "Discord")) != "" {
		t.Fatal("a file is not an app folder")
	}
	if got := ResourcesDir(`C:\L\Discord`, "app-1.0.1"); got != `C:\L\Discord\app-1.0.1\resources` {
		t.Fatalf("ResourcesDir %s", got)
	}
}

func TestFromDirNormalises(t *testing.T) {
	for dir, branch := range map[string]string{
		`C:\x\discordptb`:         "ptb",
		`C:\x\DISCORDCANARY\`:     "canary",
		`C:\x\DiscordDevelopment`: "development",
		`C:\x\.\Discord`:          "stable",
		`C:\x\Discord2`:           "custom",
	} {
		in := FromDir(dir)
		if in.Branch != branch || in.Detected || in.Root != filepath.Clean(dir) {
			t.Errorf("%s: %+v", dir, in)
		}
	}
	if in := FromDir(`C:\tmp\fake`); in.Name != "Discord (fake)" {
		t.Fatalf("custom installs are named after their folder: %q", in.Name)
	}
}

func TestInspectUnreadableAppAsar(t *testing.T) {
	dir := testutil.TempDir(t)
	res := testutil.DiscordWithVencord(t, filepath.Join(dir, "Discord"), "app-1.0.1", `C:\v\patcher.js`)
	testutil.LockFile(t, filepath.Join(res, "app.asar")) // another program has it open exclusively
	in := Inspect(res)
	if in.Kind != KindUnknown || !in.HasOriginal {
		t.Fatalf("an app.asar that cannot be read is unknown, never assumed to be ours: %+v", in)
	}
}

func TestClassify(t *testing.T) {
	// anything over the stub size limit is Discord's own archive, whatever it holds
	big := make([]byte, MaxStubSize+1)
	if in := Classify(big, true); in.Kind != KindDiscordOriginal || !in.HasOriginal || in.Bytes != nil {
		t.Fatalf("big: %+v", in)
	}
	if in := Classify(make([]byte, MaxStubSize), false); in.Kind != KindDiscordOriginal {
		t.Fatalf("exactly the limit but not an archive: %+v", in)
	}
	// a valid archive without index.js is somebody else's stub
	noIndex := rawAsar(`{"files":{"package.json":{"size":2,"offset":"0"}}}`, "{}")
	if _, err := asar.ReadFile(noIndex, "index.js"); err != asar.ErrNotFound {
		t.Fatalf("fixture: %v", err)
	}
	if in := Classify(noIndex, false); in.Kind != KindUnknown {
		t.Fatalf("no index.js: %+v", in)
	}
	// an unreadable archive is left alone as "original" (it is not small enough to be a stub of ours)
	if in := Classify([]byte("tiny"), false); in.Kind != KindDiscordOriginal {
		t.Fatalf("not an archive: %+v", in)
	}
	// Vencord's own stub
	vs := asar.VencordStub(`C:\v\patcher.js`)
	if in := Classify(vs, true); in.Kind != KindVencordStub || in.Patcher != `C:\v\patcher.js` || !in.HasOriginal || len(in.Bytes) != len(vs) || in.Loader != "" {
		t.Fatalf("vencord: %+v", in)
	}
	// an index.js that is neither Vencord's nor ours
	if in := Classify(asar.BuildStub("console.log(1)"), false); in.Kind != KindUnknown || in.Patcher != "" {
		t.Fatalf("other: %+v", in)
	}
}

func TestInspectHasOriginalIsIndependentOfTheStub(t *testing.T) {
	dir := testutil.TempDir(t)
	res := filepath.Join(dir, "resources")
	os.MkdirAll(res, 0o755)
	if in := Inspect(res); in.HasOriginal || in.Kind != KindMissing {
		t.Fatalf("%+v", in)
	}
	testutil.Write(t, filepath.Join(res, "_app.asar"), []byte("x"))
	if in := Inspect(res); !in.HasOriginal || in.Kind != KindMissing {
		t.Fatalf("an original without a stub: %+v", in)
	}
	if in := Inspect(filepath.Join(dir, "no-such-resources")); in.Kind != KindMissing || in.HasOriginal {
		t.Fatalf("no resources folder: %+v", in)
	}
}
