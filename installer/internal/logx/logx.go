// SPDX-License-Identifier: GPL-3.0-or-later

// Package logx writes %APPDATA%\Telinha\logs\installer.log (rotated to installer.log.1 at 512 KiB).
//
// Every line is appended with its own open / write / close. Nothing is buffered in the process (the GUI
// build leaves through os.Exit right after a dialog closes) and no handle stays open for minutes while a
// dialog waits for a click, where an antivirus, an indexer or another program could get in its way. If
// the file cannot be written even after a few retries, the lines go to the next candidate (a per-run
// file in the same folder, then one in %TEMP%) instead of vanishing, and the first line written there
// says why.
package logx

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	maxSize   = 512 << 10
	tries     = 3
	retryWait = 60 * time.Millisecond
)

// File is the installer log.
type File struct {
	*log.Logger
	app *appender
}

// Open prepares <dir>\installer.log (appending). It never fails: see the package comment for what happens
// when the file cannot be written. extra, when not nil, also gets every line.
func Open(dir string, extra io.Writer) *File {
	pid := os.Getpid()
	paths := []string{
		filepath.Join(dir, "installer.log"),
		filepath.Join(dir, fmt.Sprintf("installer-%d.log", pid)),
		filepath.Join(os.TempDir(), fmt.Sprintf("TelinhaInstaller-%d.log", pid)),
	}
	if err := os.MkdirAll(dir, 0o755); err == nil {
		if fi, err := os.Stat(paths[0]); err == nil && fi.Size() > maxSize {
			_ = os.Rename(paths[0], paths[0]+".1")
		}
	}
	a := &appender{paths: paths}
	var w io.Writer = a
	if extra != nil {
		w = io.MultiWriter(a, extra)
	}
	return &File{Logger: log.New(w, "", log.LstdFlags|log.Lmicroseconds), app: a}
}

// Where is the file the lines are going to right now (the first candidate unless it failed).
func (l *File) Where() string {
	l.app.mu.Lock()
	defer l.app.mu.Unlock()
	return l.app.paths[l.app.cur]
}

// Degraded reports whether the main installer.log could not be written and a fallback file is in use.
func (l *File) Degraded() bool {
	l.app.mu.Lock()
	defer l.app.mu.Unlock()
	return l.app.cur != 0
}

// Close stops logging (needed before deleting %APPDATA%\Telinha). There is no handle to release: lines
// are already on disk. Calling it again is harmless.
func (l *File) Close() {
	l.app.mu.Lock()
	l.app.closed = true
	l.app.mu.Unlock()
	l.Logger.SetOutput(io.Discard)
}

// appender is the io.Writer behind the logger.
type appender struct {
	mu     sync.Mutex
	paths  []string // candidates, preferred first
	cur    int      // index of the one in use (sticky: a run's lines stay in one file)
	notes  []string // why earlier candidates failed, written at the top of the file that works
	closed bool
}

func (a *appender) Write(p []byte) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return len(p), nil
	}
	for ; a.cur < len(a.paths); a.cur++ {
		data := p
		if len(a.notes) > 0 {
			var head []byte
			for _, n := range a.notes {
				head = append(head, time.Now().Format("2006/01/02 15:04:05.000000 ")+n+"\n"...)
			}
			data = append(head, p...)
		}
		err := appendWithRetry(a.paths[a.cur], data)
		if err == nil {
			a.notes = nil
			return len(p), nil
		}
		if a.cur == len(a.paths)-1 {
			break // nothing left to fall back to: try this one again with the next line
		}
		a.notes = append(a.notes, fmt.Sprintf("log: cannot write %s (%v); this run is logged in %s instead", a.paths[a.cur], err, a.paths[a.cur+1]))
	}
	return len(p), nil // never make the installer fail because its log did
}

func appendWithRetry(path string, data []byte) error {
	var err error
	for i := 0; i < tries; i++ {
		if err = appendOnce(path, data); err == nil {
			return nil
		}
		if i < tries-1 {
			time.Sleep(retryWait)
		}
	}
	return err
}

func appendOnce(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
