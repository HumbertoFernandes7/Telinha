// SPDX-License-Identifier: GPL-3.0-or-later

package discord

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/stub"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
)

func TestFindAndAppFolders(t *testing.T) {
	local := testutil.TempDir(t)
	testutil.DiscordWithVencord(t, filepath.Join(local, "Discord"), "app-1.0.9266", `C:\v\patcher.js`)
	testutil.DiscordWithVencord(t, filepath.Join(local, "Discord"), "app-1.0.10000", `C:\v\patcher.js`)
	testutil.DiscordWithVencord(t, filepath.Join(local, "Discord"), "app-1.0.999", `C:\v\patcher.js`)
	os.MkdirAll(filepath.Join(local, "Discord", "app-1.0.20000"), 0o755) // no resources: ignored
	os.MkdirAll(filepath.Join(local, "Discord", "app-foo", "resources"), 0o755)
	os.MkdirAll(filepath.Join(local, "Discord", "packages"), 0o755)
	testutil.DiscordVanilla(t, filepath.Join(local, "DiscordPTB"), "app-1.0.1100")
	os.MkdirAll(filepath.Join(local, "DiscordCanary"), 0o755) // root without app-*: not an install

	got := Find(local)
	if len(got) != 2 || got[0].Branch != "stable" || got[1].Branch != "ptb" || got[1].Exe != "DiscordPTB.exe" || !got[0].Detected {
		t.Fatalf("Find: %+v", got)
	}
	want := []string{"app-1.0.999", "app-1.0.9266", "app-1.0.10000"}
	if f := AppFolders(filepath.Join(local, "Discord")); !reflect.DeepEqual(f, want) {
		t.Fatalf("AppFolders: %v", f)
	}
	if n := Newest(filepath.Join(local, "Discord")); n != "app-1.0.10000" {
		t.Fatalf("Newest: %s", n)
	}
	if Find("") != nil || Find(filepath.Join(local, "nothing")) != nil {
		t.Fatal("Find on missing folder")
	}
}

func TestFromDir(t *testing.T) {
	if in := FromDir(`C:\x\DiscordCanary\`); in.Branch != "canary" || in.Exe != "DiscordCanary.exe" || in.Detected {
		t.Fatalf("%+v", in)
	}
	if in := FromDir(`C:\tmp\fake`); in.Branch != "custom" || in.Exe != "Discord.exe" {
		t.Fatalf("%+v", in)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"app-1.0.9266", "app-1.0.10000", -1},
		{"app-1.0.10000", "app-1.0.9266", 1},
		{"app-1.0", "app-1.0.0", -1},
		{"app-1.0.5", "app-1.0.5", 0},
		{"app-2", "app-1.9.9", 1},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("%s vs %s = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestInspect(t *testing.T) {
	dir := testutil.TempDir(t)
	res := func(name string) string { return filepath.Join(dir, name, "resources") }

	os.MkdirAll(res("missing"), 0o755)
	if in := Inspect(res("missing")); in.Kind != KindMissing {
		t.Fatalf("missing: %+v", in)
	}

	os.MkdirAll(filepath.Join(res("dir"), "app.asar"), 0o755)
	if in := Inspect(res("dir")); in.Kind != KindUnknown {
		t.Fatalf("dir: %+v", in)
	}

	testutil.DiscordVanilla(t, filepath.Join(dir, "vanilla"), "x")
	if in := Inspect(filepath.Join(dir, "vanilla", "x", "resources")); in.Kind != KindDiscordOriginal || in.HasOriginal {
		t.Fatalf("vanilla: %+v", in)
	}

	testutil.Write(t, filepath.Join(res("garbage"), "app.asar"), []byte("not an asar at all, just text"))
	if in := Inspect(res("garbage")); in.Kind != KindDiscordOriginal {
		t.Fatalf("garbage: %+v", in)
	}

	testutil.Write(t, filepath.Join(res("other"), "app.asar"), asar.BuildStub(`require("./openasar")`+";"))
	if in := Inspect(res("other")); in.Kind != KindUnknown {
		t.Fatalf("other mod: %+v", in)
	}

	testutil.DiscordWithVencord(t, filepath.Join(dir, "vencord"), "x", `C:\v\patcher.js`)
	in := Inspect(filepath.Join(dir, "vencord", "x", "resources"))
	if in.Kind != KindVencordStub || in.Patcher != `C:\v\patcher.js` || !in.HasOriginal || len(in.Bytes) == 0 {
		t.Fatalf("vencord: %+v", in)
	}

	idx, err := stub.Render(testutil.StubTemplate(t), `C:\t\main.js`, `C:\v\patcher.js`)
	if err != nil {
		t.Fatal(err)
	}
	testutil.Write(t, filepath.Join(res("telinha"), "app.asar"), asar.BuildStub(idx))
	in = Inspect(res("telinha"))
	if in.Kind != KindTelinhaStub || in.Patcher != `C:\v\patcher.js` || in.Loader != `C:\t\main.js` {
		t.Fatalf("telinha: %+v", in)
	}

	testutil.Write(t, filepath.Join(res("broken"), "app.asar"), asar.BuildStub("// Telinha stub v1\n// no paths\n"))
	if in := Inspect(res("broken")); in.Kind != KindTelinhaStub || in.Patcher != "" {
		t.Fatalf("broken telinha: %+v", in)
	}
}
