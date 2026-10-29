// SPDX-License-Identifier: GPL-3.0-or-later

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/fsutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/payload"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/winproc"
)

// State says whether Telinha can be installed into one Discord flavor.
type State string

const (
	StateReady          State = "ready"           // official Vencord stub (or ours): can install
	StateNoApp          State = "no-app-folder"   // no app-*\resources folder
	StateNoVencord      State = "no-vencord"      // Discord's own app.asar: Vencord not installed
	StatePatcherMissing State = "patcher-missing" // the stub points to a patcher.js that does not exist
	StateCustomVencord  State = "custom-vencord"  // the stub points outside %APPDATA%\Vencord\dist
	StateUnknown        State = "unknown"         // something else replaced app.asar
)

// Target is the newest app-* folder of one Discord flavor and what it holds.
type Target struct {
	Install   discord.Install    `json:"-"`
	Flavor    string             `json:"flavor"`
	Name      string             `json:"name"`
	Root      string             `json:"root"`
	App       string             `json:"app"`
	Resources string             `json:"resources"`
	Inspect   discord.Inspection `json:"-"`
	Kind      discord.Kind       `json:"kind"`
	Patcher   string             `json:"vencordPatcher,omitempty"`
	State     State              `json:"state"`
	Detail    string             `json:"detail,omitempty"`
}

// Telinha reports whether the Telinha stub is in place.
func (t Target) Telinha() bool { return t.Kind == discord.KindTelinhaStub }

// Scan inspects the newest app-* folder of every configured install.
func (c *Config) Scan() []Target {
	var out []Target
	for _, in := range c.Installs {
		out = append(out, c.scanOne(in))
	}
	return out
}

func (c *Config) scanOne(in discord.Install) Target {
	t := Target{Install: in, Flavor: filepath.Base(in.Root), Name: in.Name, Root: in.Root}
	t.App = discord.Newest(in.Root)
	if t.App == "" {
		t.State, t.Detail = StateNoApp, "nenhuma pasta app-* com resources"
		return t
	}
	t.Resources = discord.ResourcesDir(in.Root, t.App)
	t.Inspect = discord.Inspect(t.Resources)
	t.Kind, t.Patcher = t.Inspect.Kind, t.Inspect.Patcher
	switch {
	case t.Kind == discord.KindDiscordOriginal || t.Kind == discord.KindMissing:
		t.State, t.Detail = StateNoVencord, "app.asar é o original do Discord"
	case t.Kind == discord.KindUnknown:
		t.State, t.Detail = StateUnknown, "app.asar foi trocado por outro mod ou formato desconhecido"
	case t.Patcher == "":
		t.State, t.Detail = StateUnknown, "stub do Telinha sem um caminho do Vencord legível"
	case !t.Inspect.HasOriginal:
		t.State, t.Detail = StateNoVencord, "resources\\_app.asar não existe"
	case !fsutil.IsFile(t.Patcher):
		t.State, t.Detail = StatePatcherMissing, "patcher.js do Vencord não encontrado: "+t.Patcher
	case !c.isOfficial(t.Patcher) && !c.AllowCustomVencord:
		t.State, t.Detail = StateCustomVencord, "o Vencord deste Discord não está na pasta padrão: "+t.Patcher
	default:
		t.State = StateReady
	}
	return t
}

func (c *Config) isOfficial(patcher string) bool {
	for _, p := range c.OfficialPatchers() {
		if samePath(p, patcher) {
			return true
		}
	}
	return false
}

// Status is everything --status shows.
type Status struct {
	Targets       []Target          `json:"discord"`
	Payload       *payload.Manifest `json:"payload,omitempty"`
	PayloadError  string            `json:"payloadError,omitempty"`
	PreviousReady bool              `json:"rollbackAvailable"`
	Record        *Record           `json:"install,omitempty"`
	Running       []winproc.Process `json:"running,omitempty"`
}

// Installed reports whether the Telinha stub is active in at least one Discord.
func (s *Status) Installed() bool {
	for _, t := range s.Targets {
		if t.Telinha() {
			return true
		}
	}
	return false
}

// Ready returns the targets Telinha can be installed into.
func (s *Status) Ready() []Target {
	var out []Target
	for _, t := range s.Targets {
		if t.State == StateReady {
			out = append(out, t)
		}
	}
	return out
}

// Status gathers the current state (read only).
func (c *Config) Status() *Status {
	s := &Status{Targets: c.Scan()}
	if fsutil.IsDir(c.AddonDir()) {
		m, err := payload.ReadInstalled(c.AddonDir())
		s.Payload = m
		if err != nil {
			s.PayloadError = err.Error()
		}
	}
	if prev := filepath.Join(c.Home(), payload.PrevDir); fsutil.IsDir(prev) {
		_, err := payload.ReadInstalled(prev)
		s.PreviousReady = err == nil
	}
	s.Record, _ = c.ReadRecord()
	s.Running, _ = c.RunningProcesses()
	return s
}

// Record is %APPDATA%\Telinha\install.json (PAYLOAD.md 4.7, plus installer/source details).
type Record struct {
	InstalledAt      string         `json:"installedAt"`
	Version          string         `json:"version"`
	Commit           string         `json:"commit"`
	Targets          []RecordTarget `json:"targets"`
	InstallerVersion string         `json:"installerVersion,omitempty"`
	Source           *SourceInfo    `json:"source,omitempty"`
}

type RecordTarget struct {
	Flavor         string  `json:"flavor"`
	App            string  `json:"app"`
	Resources      string  `json:"resources"`
	VencordPatcher string  `json:"vencordPatcher"`
	Previous       string  `json:"previous"`
	Backup         *string `json:"backup"`
}

// SourceInfo says where the installed payload came from.
type SourceInfo struct {
	Kind    string `json:"kind"` // github | local
	Release string `json:"release,omitempty"`
	Asset   string `json:"asset,omitempty"`
	Path    string `json:"path,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
}

// ReadRecord reads install.json (nil if absent).
func (c *Config) ReadRecord() (*Record, error) {
	data, err := os.ReadFile(c.RecordPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var r Record
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("install.json: %w", err)
	}
	return &r, nil
}

func (c *Config) writeRecord(r *Record) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(c.RecordPath(), append(data, '\n'))
}
