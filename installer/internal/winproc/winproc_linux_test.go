// SPDX-License-Identifier: GPL-3.0-or-later

package winproc

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestListFindsThisProcess(t *testing.T) {
	ps, err := System{}.List()
	if err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	for _, p := range ps {
		if p.PID == uint32(os.Getpid()) {
			if p.Path != exe || p.Name != filepath.Base(exe) {
				t.Fatalf("this process listed as %+v, want path %s", p, exe)
			}
			return
		}
	}
	t.Fatalf("pid %d not listed (%d processes)", os.Getpid(), len(ps))
}

// Close is only ever pointed at a child started here.
func TestCloseEndsAChild(t *testing.T) {
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Skipf("no sleep here: %v", err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }() // reap it, as Discord's own parent does
	p := Process{PID: uint32(cmd.Process.Pid), Name: "sleep"}
	if !alive(p.PID) {
		t.Fatal("child not alive")
	}
	if err := (System{}).Close([]Process{p}, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("child still running")
	}
}

func TestAliveIgnoresZombies(t *testing.T) {
	defer func(r string) { procRoot = r }(procRoot)
	procRoot = t.TempDir()
	write := func(pid, stat string) {
		if err := os.MkdirAll(filepath.Join(procRoot, pid), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(procRoot, pid, "stat"), []byte(stat), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("10", "10 (Discord) S 1 10 10 0")
	write("11", "11 (we (ird) Z 1 11 11 0")
	write("12", "12 (a) Z) R 1 12 12 0") // a ") Z" inside the name is not the state
	for pid, want := range map[uint32]bool{10: true, 11: false, 12: true, 13: false} {
		if got := alive(pid); got != want {
			t.Errorf("alive(%d) = %v, want %v", pid, got, want)
		}
	}
}
