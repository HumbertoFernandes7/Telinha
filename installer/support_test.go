// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/ui"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winproc"
)

// swap puts v into *target until the end of the test.
func swap[T any](t *testing.T, target *T, v T) {
	t.Helper()
	old := *target
	*target = v
	t.Cleanup(func() { *target = old })
}

// capture runs fn with os.Stdout and os.Stderr redirected to files and returns what was printed.
func capture(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	dir := testutil.TempDir(t)
	fo, err := os.Create(filepath.Join(dir, "out"))
	if err != nil {
		t.Fatal(err)
	}
	fe, err := os.Create(filepath.Join(dir, "err"))
	if err != nil {
		t.Fatal(err)
	}
	oldOut, oldErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = fo, fe
	func() {
		defer func() { os.Stdout, os.Stderr = oldOut, oldErr }()
		fn()
	}()
	fo.Close()
	fe.Close()
	return string(testutil.Read(t, fo.Name())), string(testutil.Read(t, fe.Name()))
}

// setStdin makes os.Stdin a file holding content, or nothing at all (a program started without input).
func setStdin(t *testing.T, content *string) {
	t.Helper()
	old := os.Stdin
	t.Cleanup(func() { os.Stdin = old })
	if content == nil {
		os.Stdin = nil
		return
	}
	p := filepath.Join(testutil.TempDir(t), "stdin")
	testutil.Write(t, p, []byte(*content))
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	os.Stdin = f
}

func typed(s string) *string { return &s }

// sandboxFolders points the "Windows folders" of newApp at fresh folders for this test only.
func sandboxFolders(t *testing.T) (roaming, local string) {
	t.Helper()
	dir := testutil.TempDir(t)
	roaming, local = filepath.Join(dir, "Roaming"), filepath.Join(dir, "Local")
	for _, d := range []string{roaming, local} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("APPDATA", roaming)
	t.Setenv("LOCALAPPDATA", local)
	swap(t, &knownFolderPath, func(id *windows.KNOWNFOLDERID, _ uint32) (string, error) {
		if id == windows.FOLDERID_LocalAppData {
			return local, nil
		}
		return roaming, nil
	})
	return roaming, local
}

// withProcs installs a fake process table (nothing is ever listed or closed for real).
func withProcs(t *testing.T, ps ...winproc.Process) *testutil.FakeProcs {
	t.Helper()
	f := &testutil.FakeProcs{Procs: ps}
	swap[core.Processes](t, &systemProcesses, f)
	return f
}

// discordProc is a Discord process started from the fake root (what the process table lists while it runs).
func (f *fakeTrees) discordProc(pid uint32) winproc.Process {
	return winproc.Process{PID: pid, Name: "Discord.exe", Path: filepath.Join(f.discordRoot, "app-1.0.9266", "Discord.exe")}
}

// addFlavor adds another Discord next to the first one (with Vencord's stub, or a plain Discord) and returns its
// root; it is part of what options() hands to --discord-dir.
func (f *fakeTrees) addFlavor(t *testing.T, name string, vencord bool) string {
	t.Helper()
	root := filepath.Join(f.dir, "Local", name)
	if vencord {
		testutil.DiscordWithVencord(t, root, "app-1.0.9266", filepath.Join(f.appdata, "Vencord", "dist", "patcher.js"))
	} else {
		testutil.DiscordVanilla(t, root, "app-1.0.9266")
	}
	f.extraRoots = append(f.extraRoots, root)
	return root
}

// payloadZip builds another payload zip (another version) under the fake tree.
func (f *fakeTrees) payloadZip(t *testing.T, version string) string {
	t.Helper()
	pl := filepath.Join(f.dir, "payload-"+version)
	testutil.Payload(t, pl, version, map[string]string{"telinha.renderer.js": "// renderer " + version})
	z := filepath.Join(f.dir, "Telinha-addon-"+version+".zip")
	testutil.Zip(t, pl, z, nil)
	return z
}

// cli runs the command line like main does (flags parsed for real) against the fake trees and returns what
// it printed.
func (f *fakeTrees) cli(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	all := []string{"--appdata", f.appdata, "--discord-dir", f.discordRoot}
	for _, r := range f.extraRoots {
		all = append(all, "--discord-dir", r)
	}
	o, err := parseFlags(append(all, args...), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr = capture(t, func() { code = runCLI(o) })
	return code, stdout, stderr
}

// ------------------------------------------------------------------------------------------------ fake UI

type progressCall struct {
	title, instruction string
	cancellable        bool
}

// fakeUI answers the GUI's dialogs from a script instead of opening windows.
type fakeUI struct {
	t  *testing.T
	mu sync.Mutex

	answers    map[string][2]int // by Instruction
	dialogs    []ui.Dialog
	progresses []progressCall
	opened     []string
	workErrs   map[string]error // by progress instruction: returned instead of running the work
	onProgress func(instruction string, cancel func())
}

func newFakeUI(t *testing.T) *fakeUI {
	t.Helper()
	f := &fakeUI{t: t, answers: map[string][2]int{}, workErrs: map[string]error{}}
	swap(t, &showDialog, f.dialog)
	swap(t, &showProgress, f.progress)
	swap(t, &openURL, func(url string) {
		f.mu.Lock()
		f.opened = append(f.opened, url)
		f.mu.Unlock()
	})
	// runGUI wires these two package globals of the ui package
	swap(t, &ui.Logf, ui.Logf)
	swap(t, &ui.AutoClick, ui.AutoClick)
	return f
}

// answer scripts the reply to the dialog whose main instruction is instruction.
func (f *fakeUI) answer(instruction string, button int, radio ...int) *fakeUI {
	r := 0
	if len(radio) > 0 {
		r = radio[0]
	}
	f.answers[instruction] = [2]int{button, r}
	return f
}

func (f *fakeUI) dialog(d ui.Dialog) (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dialogs = append(f.dialogs, d)
	a, ok := f.answers[d.Instruction]
	if !ok {
		f.t.Errorf("unexpected dialog %q (%s)", d.Instruction, d.Content)
		return ui.IDCANCEL, 0
	}
	return a[0], a[1]
}

// progress runs the work in another goroutine, like the real dialog does, and waits for it.
func (f *fakeUI) progress(title, instruction string, cancel func(), work func(set func(string)) error) error {
	f.mu.Lock()
	f.progresses = append(f.progresses, progressCall{title, instruction, cancel != nil})
	hook := f.onProgress
	fail := f.workErrs[instruction]
	f.mu.Unlock()
	if hook != nil {
		hook(instruction, cancel)
	}
	if fail != nil {
		return fail
	}
	done := make(chan error, 1)
	go func() { done <- work(func(string) {}) }()
	return <-done
}

func (f *fakeUI) shown(instruction string) []ui.Dialog {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []ui.Dialog
	for _, d := range f.dialogs {
		if d.Instruction == instruction {
			out = append(out, d)
		}
	}
	return out
}

func (f *fakeUI) instructions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, d := range f.dialogs {
		out = append(out, d.Instruction)
	}
	return out
}

func (f *fakeUI) progressed(instruction string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.progresses {
		if p.instruction == instruction {
			n++
		}
	}
	return n
}

func contains(t *testing.T, what, got string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("%s lacks %q:\n%s", what, w, got)
		}
	}
}
