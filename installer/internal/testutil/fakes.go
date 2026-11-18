// SPDX-License-Identifier: GPL-3.0-or-later

package testutil

import (
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/winproc"
)

// FakeProcs is a process table for the tests (it satisfies core.Processes): the real winproc.System would
// list, and kill, the real Discord. Close "kills" what it is asked to unless Stuck is set.
type FakeProcs struct {
	mu sync.Mutex

	Procs    []winproc.Process
	ListErr  error // List fails with it
	CloseErr error // Close reports it (the processes are still killed unless Stuck)
	Stuck    bool  // the processes survive Close

	Closed     []uint32 // pids Close was asked to end, in order
	ListCalls  int
	CloseCalls int
}

// List returns the table.
func (f *FakeProcs) List() ([]winproc.Process, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ListCalls++
	if f.ListErr != nil {
		return nil, f.ListErr
	}
	return append([]winproc.Process(nil), f.Procs...), nil
}

// Close removes ps from the table.
func (f *FakeProcs) Close(ps []winproc.Process, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.CloseCalls++
	if f.Stuck {
		return errors.New("access denied")
	}
	kill := map[uint32]bool{}
	for _, p := range ps {
		kill[p.PID] = true
		f.Closed = append(f.Closed, p.PID)
	}
	var left []winproc.Process
	for _, p := range f.Procs {
		if !kill[p.PID] {
			left = append(left, p)
		}
	}
	f.Procs = left
	return f.CloseErr
}

// Set replaces the table.
func (f *FakeProcs) Set(ps ...winproc.Process) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Procs = ps
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// LoopbackTransport wraps base so that it only talks to the machine itself (the httptest servers); every other
// host fails at once.
func LoopbackTransport(base http.RoundTripper) http.RoundTripper {
	return roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Hostname() {
		case "127.0.0.1", "localhost", "::1":
			return base.RoundTrip(r)
		}
		return nil, errors.New("testutil: the network is blocked in tests: " + r.URL.String())
	})
}

// LoopbackOnly makes http.DefaultTransport refuse every host except the machine itself for the rest of the
// test: a test that forgot to point the installer at a fake GitHub fails instead of downloading from the real one.
func LoopbackOnly(t testing.TB) {
	t.Helper()
	old := http.DefaultTransport
	http.DefaultTransport = LoopbackTransport(old)
	t.Cleanup(func() { http.DefaultTransport = old })
}
