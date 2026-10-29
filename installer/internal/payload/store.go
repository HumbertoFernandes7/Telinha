// SPDX-License-Identifier: GPL-3.0-or-later

// Package payload gets the Telinha add-on payload (GitHub release zip, local zip or folder), verifies it
// against its version.json and installs it into %APPDATA%\Telinha\addon atomically (addon/PAYLOAD.md 1, 4.4).
package payload

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/fsutil"
)

const (
	AddonDir     = "addon"      // %APPDATA%\Telinha\addon
	NewDir       = "addon.new"  // staging
	OldDir       = "addon.old"  // transient during the swap
	PrevDir      = "addon.prev" // previous version, kept for --rollback
	ManifestName = "version.json"

	SupportedPayloadFormat = 1
	SupportedStubFormat    = 1

	maxManifest      = 4 << 20
	maxFiles         = 500
	maxExtractedSize = 256 << 20
)

// Manifest is the payload's version.json.
type Manifest struct {
	Name              string               `json:"name"`
	PayloadFormat     int                  `json:"payloadFormat"`
	Version           string               `json:"version"`
	Commit            string               `json:"commit"`
	VencordBaseCommit string               `json:"vencordBaseCommit"`
	VencordVersion    string               `json:"vencordVersion"`
	BuiltAt           string               `json:"builtAt"`
	PluginName        string               `json:"pluginName"`
	LoaderEntry       string               `json:"loaderEntry"`
	StubTemplate      string               `json:"stubTemplate"`
	StubFormat        int                  `json:"stubFormat"`
	Files             map[string]FileEntry `json:"files"`
}

type FileEntry struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// ErrTooNew means the payload needs a newer installer.
var ErrTooNew = errors.New("payload format not supported by this installer")

// Label is "0.1.0 (a6e4044d)" for messages.
func (m *Manifest) Label() string {
	v := m.Version
	if v == "" {
		v = "?"
	}
	if m.Commit != "" {
		v += " (" + m.Commit + ")"
	}
	return v
}

// ParseManifest parses and validates version.json.
func ParseManifest(data []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("version.json: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate checks the manifest against what this installer understands.
func (m *Manifest) Validate() error {
	if m.PayloadFormat != SupportedPayloadFormat || m.StubFormat != SupportedStubFormat {
		return fmt.Errorf("%w (payloadFormat %d, stubFormat %d)", ErrTooNew, m.PayloadFormat, m.StubFormat)
	}
	if len(m.Files) == 0 || len(m.Files) > maxFiles {
		return fmt.Errorf("version.json: %d files listed", len(m.Files))
	}
	var total int64
	for name, f := range m.Files {
		if !ValidName(name) || strings.EqualFold(name, ManifestName) {
			return fmt.Errorf("version.json: invalid file name %q", name)
		}
		if f.Size < 0 || len(f.SHA256) != 64 || strings.Trim(strings.ToLower(f.SHA256), "0123456789abcdef") != "" {
			return fmt.Errorf("version.json: bad entry for %q", name)
		}
		total += f.Size
	}
	if total > maxExtractedSize {
		return fmt.Errorf("version.json: payload too large (%d bytes)", total)
	}
	for _, need := range []struct{ what, name string }{{"loaderEntry", m.LoaderEntry}, {"stubTemplate", m.StubTemplate}} {
		if need.name == "" {
			return fmt.Errorf("version.json: %s missing", need.what)
		}
		if _, ok := m.Files[need.name]; !ok {
			return fmt.Errorf("version.json: %s %q is not in files", need.what, need.name)
		}
	}
	return nil
}

var reserved = map[string]bool{"con": true, "prn": true, "aux": true, "nul": true}

// ValidName accepts flat, ordinary file names only (the payload has no subfolders).
func ValidName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 200 || strings.ContainsAny(name, `/\:*?"<>|`) ||
		strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return false
	}
	for _, r := range name {
		if r < 0x20 {
			return false
		}
	}
	stem := strings.ToLower(strings.SplitN(name, ".", 2)[0])
	if reserved[stem] || (len(stem) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) && stem[3] >= '0' && stem[3] <= '9') {
		return false
	}
	return true
}

// Stage puts the payload at src (a .zip or a folder holding version.json) into <home>\addon.new, copying
// only version.json and the files it lists, each checked for size and SHA-256. Returns the manifest and
// the names present in src but not listed (ignored).
func Stage(src, home string) (*Manifest, []string, error) {
	staging := filepath.Join(home, NewDir)
	if err := fsutil.RemoveAll(staging); err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return nil, nil, err
	}
	var (
		m       *Manifest
		ignored []string
		err     error
	)
	if fsutil.IsDir(src) {
		m, ignored, err = stageDir(src, staging)
	} else {
		m, ignored, err = stageZip(src, staging)
	}
	if err != nil {
		_ = fsutil.RemoveAll(staging)
		return nil, nil, err
	}
	return m, ignored, nil
}

func stageDir(src, staging string) (*Manifest, []string, error) {
	data, err := readLimited(filepath.Join(src, ManifestName))
	if err != nil {
		return nil, nil, fmt.Errorf("payload folder: %w", err)
	}
	m, err := ParseManifest(data)
	if err != nil {
		return nil, nil, err
	}
	for name, fe := range m.Files {
		in, err := os.Open(filepath.Join(src, name))
		if err != nil {
			return nil, nil, fmt.Errorf("payload: %s listed in version.json is missing: %w", name, err)
		}
		err = writeVerified(in, filepath.Join(staging, name), name, fe)
		in.Close()
		if err != nil {
			return nil, nil, err
		}
	}
	if err := os.WriteFile(filepath.Join(staging, ManifestName), data, 0o644); err != nil {
		return nil, nil, err
	}
	var ignored []string
	if entries, err := os.ReadDir(src); err == nil {
		for _, e := range entries {
			if _, ok := m.Files[e.Name()]; !ok && e.Name() != ManifestName {
				ignored = append(ignored, e.Name())
			}
		}
	}
	return m, ignored, nil
}

func stageZip(src, staging string) (*Manifest, []string, error) {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return nil, nil, fmt.Errorf("payload zip: %w", err)
	}
	defer zr.Close()
	entries := map[string]*zip.File{}
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, `\`, "/")
		if _, dup := entries[name]; dup {
			return nil, nil, fmt.Errorf("payload zip: duplicate entry %q", name)
		}
		entries[name] = f
	}
	mf, ok := entries[ManifestName]
	if !ok {
		return nil, nil, fmt.Errorf("payload zip: no %s at the zip root", ManifestName)
	}
	data, err := readZipEntry(mf, maxManifest)
	if err != nil {
		return nil, nil, err
	}
	m, err := ParseManifest(data)
	if err != nil {
		return nil, nil, err
	}
	for name, fe := range m.Files {
		f, ok := entries[name]
		if !ok {
			return nil, nil, fmt.Errorf("payload zip: %s listed in version.json is missing", name)
		}
		if !f.Mode().IsRegular() {
			return nil, nil, fmt.Errorf("payload zip: %s is not a regular file", name)
		}
		if f.UncompressedSize64 != uint64(fe.Size) {
			return nil, nil, fmt.Errorf("payload: %s has %d bytes, version.json says %d", name, f.UncompressedSize64, fe.Size)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, nil, fmt.Errorf("payload zip: %s: %w", name, err)
		}
		err = writeVerified(rc, filepath.Join(staging, name), name, fe)
		rc.Close()
		if err != nil {
			return nil, nil, err
		}
	}
	if err := os.WriteFile(filepath.Join(staging, ManifestName), data, 0o644); err != nil {
		return nil, nil, err
	}
	var ignored []string
	for name := range entries {
		if _, ok := m.Files[name]; !ok && name != ManifestName && !strings.HasSuffix(name, "/") {
			ignored = append(ignored, name)
		}
	}
	sort.Strings(ignored)
	return m, ignored, nil
}

// ErrFileMismatch: an extracted file does not match version.json.
var ErrFileMismatch = errors.New("payload file does not match version.json")

func writeVerified(r io.Reader, dst, name string, fe FileEntry) error {
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(r, fe.Size+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("payload: writing %s: %w", name, err)
	}
	if n != fe.Size {
		return fmt.Errorf("%w: %s has %d bytes, expected %d", ErrFileMismatch, name, n, fe.Size)
	}
	if sum := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(sum, fe.SHA256) {
		return fmt.Errorf("%w: %s SHA-256 %s, expected %s", ErrFileMismatch, name, sum, fe.SHA256)
	}
	return nil
}

func readZipEntry(f *zip.File, limit int64) ([]byte, error) {
	if f.UncompressedSize64 > uint64(limit) {
		return nil, fmt.Errorf("payload zip: %s too large", f.Name)
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("payload zip: %s too large", f.Name)
	}
	return data, nil
}

func readLimited(p string) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxManifest+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxManifest {
		return nil, fmt.Errorf("%s too large", p)
	}
	return data, nil
}

// Swap installs <home>\addon.new as <home>\addon: addon -> addon.old, addon.new -> addon, then addon.old
// becomes addon.prev (replacing an older one) so --rollback can bring it back. On failure the previous
// addon is restored and addon.new removed.
func Swap(home string) error {
	addon, staged := filepath.Join(home, AddonDir), filepath.Join(home, NewDir)
	old, prev := filepath.Join(home, OldDir), filepath.Join(home, PrevDir)
	if !fsutil.IsDir(staged) {
		return errors.New("no staged payload")
	}
	if err := fsutil.RemoveAll(old); err != nil {
		return err
	}
	hadOld := false
	if fsutil.Exists(addon) {
		if err := fsutil.Retry(func() error { return os.Rename(addon, old) }); err != nil {
			_ = fsutil.RemoveAll(staged)
			return fmt.Errorf("moving the current add-on aside: %w", err)
		}
		hadOld = true
	}
	if err := fsutil.Retry(func() error { return os.Rename(staged, addon) }); err != nil {
		if hadOld {
			_ = os.Rename(old, addon)
		}
		_ = fsutil.RemoveAll(staged)
		return fmt.Errorf("activating the new add-on: %w", err)
	}
	if hadOld {
		_ = fsutil.RemoveAll(prev)
		if err := os.Rename(old, prev); err != nil {
			_ = fsutil.RemoveAll(old)
		}
	}
	return nil
}

// Rollback swaps <home>\addon and <home>\addon.prev.
func Rollback(home string) error {
	addon, prev, old := filepath.Join(home, AddonDir), filepath.Join(home, PrevDir), filepath.Join(home, OldDir)
	if !fsutil.IsDir(prev) {
		return errors.New("no previous version to roll back to")
	}
	if _, err := ReadInstalled(prev); err != nil {
		return fmt.Errorf("previous version is not usable: %w", err)
	}
	if err := fsutil.RemoveAll(old); err != nil {
		return err
	}
	if fsutil.Exists(addon) {
		if err := fsutil.Retry(func() error { return os.Rename(addon, old) }); err != nil {
			return err
		}
	}
	if err := fsutil.Retry(func() error { return os.Rename(prev, addon) }); err != nil {
		_ = os.Rename(old, addon)
		return err
	}
	if fsutil.Exists(old) {
		return os.Rename(old, prev)
	}
	return nil
}

// ReadInstalled reads and verifies the payload in dir (normally <home>\addon).
func ReadInstalled(dir string) (*Manifest, error) {
	data, err := readLimited(filepath.Join(dir, ManifestName))
	if err != nil {
		return nil, err
	}
	m, err := ParseManifest(data)
	if err != nil {
		return nil, err
	}
	for name, fe := range m.Files {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			return m, fmt.Errorf("%w: %s missing", ErrFileMismatch, name)
		}
		h := sha256.New()
		n, err := io.Copy(h, f)
		f.Close()
		if err != nil || n != fe.Size || !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), fe.SHA256) {
			return m, fmt.Errorf("%w: %s", ErrFileMismatch, name)
		}
	}
	return m, nil
}

// SameFiles reports whether two manifests describe exactly the same files.
func SameFiles(a, b *Manifest) bool {
	if len(a.Files) != len(b.Files) {
		return false
	}
	for k, v := range a.Files {
		w, ok := b.Files[k]
		if !ok || w.Size != v.Size || !strings.EqualFold(w.SHA256, v.SHA256) {
			return false
		}
	}
	return true
}
