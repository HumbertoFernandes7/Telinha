// SPDX-License-Identifier: GPL-3.0-or-later

// Package logx writes %APPDATA%\Telinha\logs\installer.log (rotated to installer.log.1 at 512 KiB).
package logx

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

const maxSize = 512 << 10

// File is an open log file.
type File struct {
	*log.Logger
	f    *os.File
	Path string
}

// Open opens (appending) <dir>\installer.log. On failure it returns a logger that discards output.
func Open(dir string, extra io.Writer) *File {
	p := filepath.Join(dir, "installer.log")
	lf := &File{Path: p}
	var w io.Writer = io.Discard
	if err := os.MkdirAll(dir, 0o755); err == nil {
		if fi, err := os.Stat(p); err == nil && fi.Size() > maxSize {
			_ = os.Rename(p, p+".1")
		}
		if f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
			lf.f, w = f, f
		}
	}
	if extra != nil {
		w = io.MultiWriter(w, extra)
	}
	lf.Logger = log.New(w, "", log.LstdFlags|log.Lmicroseconds)
	return lf
}

// Close closes the file (needed before deleting %APPDATA%\Telinha).
func (l *File) Close() {
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
		l.Logger.SetOutput(io.Discard)
	}
}
