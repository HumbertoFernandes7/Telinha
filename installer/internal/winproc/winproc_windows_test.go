// SPDX-License-Identifier: GPL-3.0-or-later

package winproc

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// childEnv turns the test binary into a throw-away helper process: "sleep" does nothing for a minute (no
// window, only a forced end stops it) and "window" owns one hidden top-level window that quits when it gets
// WM_CLOSE. Close() is only ever pointed at processes started here, never at anything else on the machine.
const childEnv = "TELINHA_WINPROC_CHILD"

func TestMain(m *testing.M) {
	switch os.Getenv(childEnv) {
	case "":
		os.Exit(m.Run())
	case "sleep":
		fmt.Println("ready")
		time.Sleep(time.Minute)
		os.Exit(0)
	case "window":
		windowChild()
	}
	os.Exit(2)
}

// windowChild creates a hidden top-level window and pumps messages until WM_CLOSE.
func windowChild() {
	runtime.LockOSThread()
	user32 := windows.NewLazySystemDLL("user32.dll")
	registerClassEx := user32.NewProc("RegisterClassExW")
	createWindowEx := user32.NewProc("CreateWindowExW")
	defWindowProc := user32.NewProc("DefWindowProcW")
	getMessage := user32.NewProc("GetMessageW")
	dispatchMessage := user32.NewProc("DispatchMessageW")
	postQuitMessage := user32.NewProc("PostQuitMessage")

	const wmClose = 0x0010
	wndProc := syscall.NewCallback(func(hwnd, msg, wparam, lparam uintptr) uintptr {
		if msg == wmClose {
			postQuitMessage.Call(0)
			return 0
		}
		r, _, _ := defWindowProc.Call(hwnd, msg, wparam, lparam)
		return r
	})
	class, _ := windows.UTF16PtrFromString("TelinhaWinprocTest")
	var hinst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hinst)
	wc := struct {
		size                              uint32
		style                             uint32
		wndProc                           uintptr
		clsExtra, wndExtra                int32
		instance, icon, cursor, backgound uintptr
		menu, class                       *uint16
		iconSm                            uintptr
	}{wndProc: wndProc, instance: uintptr(hinst), class: class}
	wc.size = uint32(unsafe.Sizeof(wc))
	if r, _, err := registerClassEx.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		fmt.Println("no-window", err)
		os.Exit(3)
	}
	hwnd, _, err := createWindowEx.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(class)), 0, 0, 0, 10, 10, 0, 0, uintptr(hinst), 0)
	if hwnd == 0 {
		fmt.Println("no-window", err)
		os.Exit(3)
	}
	fmt.Println("ready")
	var msg [48]byte // MSG on 64-bit Windows
	for {
		if r, _, _ := getMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0); int32(r) <= 0 {
			break
		}
		dispatchMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
	}
	os.Exit(0) // what a window that was closed does
}

// child is a helper process started by the test.
type child struct {
	cmd  *exec.Cmd
	once sync.Once
	err  error
}

func (c *child) wait() error {
	c.once.Do(func() { c.err = c.cmd.Wait() })
	return c.err
}

func (c *child) pid() uint32 { return uint32(c.cmd.Process.Pid) }

// startChild starts a helper and waits until it says it is ready. ok=false: the helper could not get a window.
func startChild(t *testing.T, mode string) (c *child, ok bool) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), childEnv+"="+mode)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	c = &child{cmd: cmd}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = c.wait()
	})
	line := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(out).ReadString('\n')
		line <- strings.TrimSpace(s)
	}()
	select {
	case s := <-line:
		return c, s == "ready"
	case <-time.After(20 * time.Second):
		t.Fatal("the helper process never said it was ready")
		return nil, false
	}
}

func TestListFindsOwnAndChildProcesses(t *testing.T) {
	c, ok := startChild(t, "sleep")
	if !ok {
		t.Fatal("sleep helper not ready")
	}
	ps, err := System{}.List()
	if err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	var self, kid, idle *Process
	for i := range ps {
		switch ps[i].PID {
		case uint32(os.Getpid()):
			self = &ps[i]
		case c.pid():
			kid = &ps[i]
		case 0:
			idle = &ps[i]
		}
	}
	if self == nil || kid == nil {
		t.Fatalf("own process %v / child %v not listed (%d processes)", self, kid, len(ps))
	}
	for _, p := range []*Process{self, kid} {
		if !strings.EqualFold(p.Name, filepath.Base(exe)) || !strings.EqualFold(p.Path, exe) {
			t.Errorf("pid %d: name %q path %q, want %q", p.PID, p.Name, p.Path, exe)
		}
	}
	if idle == nil || idle.Path != "" {
		t.Errorf("pid 0 should be listed without a path: %+v", idle)
	}
}

func TestImagePathAndAlive(t *testing.T) {
	exe, _ := os.Executable()
	if got := imagePath(uint32(os.Getpid())); !strings.EqualFold(got, exe) {
		t.Fatalf("imagePath(self) = %q, want %q", got, exe)
	}
	if imagePath(0) != "" {
		t.Fatal("pid 0 has no image")
	}
	const gone = 0xFFFFFFF0 // not a pid that exists
	if imagePath(gone) != "" || alive(gone) {
		t.Fatal("a pid that does not exist has no image and is not alive")
	}
	if !alive(uint32(os.Getpid())) || !anyAlive([]Process{{PID: gone}, {PID: uint32(os.Getpid())}}) || anyAlive([]Process{{PID: gone}}) || anyAlive(nil) {
		t.Fatal("alive / anyAlive")
	}
}

func TestCloseNothingAndGone(t *testing.T) {
	if err := (System{}).Close(nil, time.Second); err != nil {
		t.Fatal(err)
	}
	// a process that has already ended counts as closed
	c, ok := startChild(t, "sleep")
	if !ok {
		t.Fatal("sleep helper not ready")
	}
	pid := c.pid()
	_ = c.cmd.Process.Kill()
	_ = c.wait()
	start := time.Now()
	if err := (System{}).Close([]Process{{PID: pid, Name: "gone.exe"}}, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("closing a process that is already gone waited %v", time.Since(start))
	}
}

// A window-less process ignores WM_CLOSE, so after the grace period it is terminated.
func TestCloseTerminatesWhatIgnoresWMClose(t *testing.T) {
	c, ok := startChild(t, "sleep")
	if !ok {
		t.Fatal("sleep helper not ready")
	}
	ps := []Process{{PID: c.pid(), Name: "winproc.test.exe"}}
	start := time.Now()
	if err := (System{}).Close(ps, 300*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) < 300*time.Millisecond {
		t.Fatalf("did not wait for the grace period: %v", time.Since(start))
	}
	if alive(c.pid()) {
		t.Fatal("process still alive after Close")
	}
	_ = c.wait()
	if code := c.cmd.ProcessState.ExitCode(); code != 1 {
		t.Fatalf("exit code %d, want 1 (TerminateProcess)", code)
	}
}

// A process with a window gets WM_CLOSE and ends by itself, well before a long grace period runs out.
func TestCloseAsksPoliteFirst(t *testing.T) {
	c, ok := startChild(t, "window")
	if !ok {
		t.Skip("this session cannot create a window")
	}
	ps := []Process{{PID: c.pid(), Name: "winproc.test.exe"}}
	start := time.Now()
	if err := (System{}).Close(ps, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 4*time.Second {
		t.Fatalf("a window that quits on WM_CLOSE took %v", d)
	}
	_ = c.wait()
	if code := c.cmd.ProcessState.ExitCode(); code != 0 {
		t.Fatalf("exit code %d, want 0: the process was killed instead of closed", code)
	}
}
