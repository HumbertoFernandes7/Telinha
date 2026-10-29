// SPDX-License-Identifier: GPL-3.0-or-later

// Package fsutil has the small file helpers the installer needs: atomic writes with retries (Windows
// briefly keeps files locked after a process exits or while an antivirus scans them) and tree copies.
package fsutil

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Retry runs fn up to 10 times, 300 ms apart, while it fails with a "file in use"/"access denied" error.
func Retry(fn func() error) error {
	var err error
	for i := 0; i < 10; i++ {
		if err = fn(); err == nil || !IsBusy(err) {
			return err
		}
		time.Sleep(300 * time.Millisecond)
	}
	return err
}

// WriteFileAtomic writes data to a temp file next to path and renames it over path.
func WriteFileAtomic(path string, data []byte) error {
	tmp := path + ".telinha-tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := Retry(func() error { return os.Rename(tmp, path) }); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// SameContent reports whether path exists and holds exactly data.
func SameContent(path string, data []byte) bool {
	cur, err := os.ReadFile(path)
	return err == nil && bytes.Equal(cur, data)
}

// Exists reports whether path exists (file or folder).
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// IsFile reports whether path is an existing regular file.
func IsFile(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular()
}

// IsDir reports whether path is an existing folder.
func IsDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// CopyFile copies a regular file (contents only).
func CopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// CopyTree copies the regular files and folders of src into dst (created). Symlinks are rejected.
func CopyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case d.Type().IsRegular():
			return CopyFile(p, target)
		default:
			return fmt.Errorf("unsupported file type: %s", p)
		}
	})
}

// RemoveAll is os.RemoveAll with retries.
func RemoveAll(path string) error {
	return Retry(func() error { return os.RemoveAll(path) })
}

// IsBusy reports whether err looks like a sharing violation / lock (worth retrying).
func IsBusy(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, fs.ErrPermission) {
		return true
	}
	return isSharingViolation(err)
}
