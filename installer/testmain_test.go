// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/fsutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/testutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/ui"
)

// TestMain makes sure that nothing in this package's tests can reach the real machine, whatever a test
// forgets to fake: the Windows folders point into a throw-away sandbox (also through %APPDATA% and
// %LOCALAPPDATA%), the process table is a fake that never kills anything, the dialogs refuse to open, the
// console is left alone and only the machine itself can be reached over the network. Tests replace these
// seams (and put them back) when they need something specific.
func TestMain(m *testing.M) {
	sandbox, err := os.MkdirTemp("", "tli-main")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	roaming, local := filepath.Join(sandbox, "Roaming"), filepath.Join(sandbox, "Local")
	for _, d := range []string{roaming, local} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	os.Setenv("APPDATA", roaming)
	os.Setenv("LOCALAPPDATA", local)
	os.Unsetenv("VENCORD_USER_DATA_DIR")
	os.Unsetenv("TELINHA_TEST_AUTOCLICK_MS")

	knownFolderPath = func(id *windows.KNOWNFOLDERID, _ uint32) (string, error) {
		if id == windows.FOLDERID_LocalAppData {
			return local, nil
		}
		return roaming, nil
	}
	systemProcesses = &testutil.FakeProcs{}
	checkWindows = func() error { return nil }
	attachConsole = func() {}
	hideConsole = func() {}
	showDialog = func(d ui.Dialog) (int, int) { panic("a dialog was shown without a fake UI: " + d.Instruction) }
	showProgress = func(_, instruction string, _ func(), _ func(func(string)) error) error {
		panic("a progress dialog was shown without a fake UI: " + instruction)
	}
	openURL = func(url string) { panic("a browser was opened without a fake UI: " + url) }
	http.DefaultTransport = testutil.LoopbackTransport(http.DefaultTransport)
	fsutil.RetryDelay = time.Millisecond // locked files stand in for "Discord still has it open"

	code := m.Run()
	os.RemoveAll(sandbox)
	os.Exit(code)
}
