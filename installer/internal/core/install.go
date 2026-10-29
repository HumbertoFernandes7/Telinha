// SPDX-License-Identifier: GPL-3.0-or-later

package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/asar"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/discord"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/fsutil"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/payload"
	"github.com/HumbertoFernandes7/Telinha/installer/internal/stub"
)

// Preflight checks there is something to install into. It returns the ready targets, or a Problem
// (no Discord / no official Vencord) whose message explains what to do.
func (c *Config) Preflight() ([]Target, error) {
	targets := c.Scan()
	c.logf("preflight: %d Discord target(s) found", len(targets))
	if len(targets) == 0 {
		return nil, problem(CodeNoDiscord, "Não encontramos o Discord neste computador. Instale o Discord (discord.com), abra-o uma vez e rode este instalador de novo.", nil)
	}
	var ready []Target
	var details string
	for _, t := range targets {
		c.logf("scan: %s %s kind=%s state=%s %s", t.Name, t.App, t.Kind, t.State, t.Detail)
		if t.State == StateReady {
			ready = append(ready, t)
		} else {
			details += fmt.Sprintf("%s (%s): %s\n", t.Name, t.App, t.Detail)
		}
	}
	if len(ready) == 0 {
		msg := "O Telinha funciona junto com o Vencord oficial, e ele não está instalado no seu Discord. Instale o Vencord primeiro (vencord.dev) e depois rode este instalador de novo."
		for _, t := range targets {
			switch t.State {
			case StatePatcherMissing:
				msg = "O Vencord está registrado no Discord, mas os arquivos dele sumiram. Rode o instalador do Vencord (vencord.dev) e escolha Reparar; depois rode este instalador de novo."
			case StateCustomVencord:
				msg = "O Discord está usando um Vencord fora da pasta padrão (versão de desenvolvimento ou de teste). Reinstale o Vencord oficial pelo instalador do vencord.dev e rode este instalador de novo."
			case StateUnknown:
				msg = "O Discord foi modificado por outro programa que o Telinha não reconhece. Rode o instalador do Vencord (vencord.dev) e escolha Reparar; depois rode este instalador de novo."
			}
		}
		return nil, problem(CodeNoVencord, msg, errors.New(details))
	}
	c.logf("preflight: ready to install into %s", targetList(ready))
	return ready, nil
}

// PayloadSource says where the payload comes from.
type PayloadSource struct {
	Local  string          // a .zip or a folder holding version.json; "" = latest GitHub release
	SHA256 string          // expected SHA-256 of a local zip (optional)
	Client *payload.Client // GitHub client (when Local == "")
}

// Staged is a verified payload in %APPDATA%\Telinha\addon.new (or nothing to do when UpToDate).
type Staged struct {
	Manifest *payload.Manifest
	Source   *SourceInfo
	UpToDate bool // identical to the installed payload: nothing to swap
}

// Stage downloads (or reads) the payload, verifies it and extracts it to addon.new. It does not need
// Discord to be closed. progress gets short pt-BR status lines.
func (c *Config) Stage(ctx context.Context, src PayloadSource, progress func(string)) (*Staged, error) {
	if progress == nil {
		progress = func(string) {}
	}
	if err := os.MkdirAll(c.Home(), 0o755); err != nil {
		return nil, problem(CodeFailed, "Não foi possível criar a pasta do Telinha.", err)
	}
	st := &Staged{}
	var file string
	if src.Local != "" {
		st.Source = &SourceInfo{Kind: "local", Path: src.Local}
		file = src.Local
		if fsutil.IsFile(file) {
			sum, err := payload.FileSHA256(file)
			if err != nil {
				return nil, problem(CodePayload, "Não foi possível ler o pacote do Telinha.", err)
			}
			st.Source.SHA256 = sum
			if src.SHA256 != "" {
				if err := payload.Verify(sum, []payload.Expected{{SHA256: src.SHA256, Source: "--sha256"}}); err != nil {
					return nil, problem(CodePayload, "O pacote do Telinha não confere com o SHA-256 informado.", err)
				}
			}
		}
		c.logf("payload: local %s sha256=%s", file, st.Source.SHA256)
	} else {
		progress("Procurando a versão mais recente do Telinha…")
		rel, asset, err := src.Client.Latest(ctx)
		if errors.Is(err, payload.ErrNoRelease) {
			return nil, problem(CodePayload, "Ainda não há uma versão do Telinha publicada para instalar. Tente de novo mais tarde.", err)
		} else if err != nil {
			return nil, problem(CodePayload, "Não foi possível falar com o GitHub para baixar o Telinha. Verifique sua internet e tente de novo.", err)
		}
		c.logf("payload: release %s (prerelease=%v) asset %s (%d bytes, digest %q)", rel.TagName, rel.Prerelease, asset.Name, asset.Size, asset.Digest)
		checks, err := src.Client.ReleaseChecks(ctx, rel, asset)
		if err != nil {
			return nil, problem(CodePayload, "Não foi possível baixar o Telinha. Verifique sua internet e tente de novo.", err)
		}
		for _, h := range checks.Hashes {
			c.logf("payload: expected sha256 %s (%s)", h.SHA256, h.Source)
		}
		if len(checks.Hashes) == 0 && checks.Manifest == nil {
			c.logf("payload: WARNING no published checksum for %s; relying on HTTPS + version.json inside the zip", asset.Name)
		}
		progress("Baixando o Telinha " + rel.TagName + "…")
		file = filepath.Join(c.Home(), "download.zip.tmp")
		defer os.Remove(file)
		sum, err := src.Client.Download(ctx, asset, file, checks.Hashes)
		if errors.Is(err, payload.ErrChecksum) {
			return nil, problem(CodePayload, "O arquivo baixado do Telinha não confere com o publicado (SHA-256). Nada foi alterado; tente de novo mais tarde.", err)
		} else if err != nil {
			return nil, problem(CodePayload, "O download do Telinha falhou. Verifique sua internet e tente de novo.", err)
		}
		c.logf("payload: downloaded sha256=%s", sum)
		st.Source = &SourceInfo{Kind: "github", Release: rel.TagName, Asset: asset.Name, SHA256: sum}
		progress("Verificando os arquivos do Telinha…")
		m, ignored, err := c.stageFile(file)
		if err != nil {
			return nil, err
		}
		if checks.Manifest != nil && !payload.SameFiles(checks.Manifest, m) {
			_ = fsutil.RemoveAll(filepath.Join(c.Home(), payload.NewDir))
			return nil, problem(CodePayload, "O pacote baixado não confere com o version.json publicado. Nada foi alterado; tente de novo mais tarde.", errors.New("zip version.json differs from release version.json"))
		}
		return c.finishStage(st, m, ignored)
	}
	progress("Verificando os arquivos do Telinha…")
	m, ignored, err := c.stageFile(file)
	if err != nil {
		return nil, err
	}
	return c.finishStage(st, m, ignored)
}

func (c *Config) stageFile(file string) (*payload.Manifest, []string, error) {
	m, ignored, err := payload.Stage(file, c.Home())
	if errors.Is(err, payload.ErrTooNew) {
		return nil, nil, problem(CodePayload, "Esta versão do Telinha precisa de um instalador mais novo. Baixe o instalador mais recente na página do Telinha.", err)
	} else if err != nil {
		return nil, nil, problem(CodePayload, "O pacote do Telinha está incompleto ou corrompido. Nada foi alterado.", err)
	}
	return m, ignored, nil
}

func (c *Config) finishStage(st *Staged, m *payload.Manifest, ignored []string) (*Staged, error) {
	st.Manifest = m
	if len(ignored) > 0 {
		c.logf("payload: ignored files not listed in version.json: %v", ignored)
	}
	c.logf("payload: staged %s, %d files, vencordBaseCommit %s", m.Label(), len(m.Files), m.VencordBaseCommit)
	if cur, err := payload.ReadInstalled(c.AddonDir()); err == nil && payload.SameFiles(cur, m) {
		st.UpToDate = true
		_ = fsutil.RemoveAll(filepath.Join(c.Home(), payload.NewDir))
		c.logf("payload: identical to the installed one, keeping it")
	}
	return st, nil
}

// DiscardStaged removes a staged payload that will not be applied (the user cancelled).
func (c *Config) DiscardStaged() {
	_ = fsutil.RemoveAll(filepath.Join(c.Home(), payload.NewDir))
}

// PayloadOK reports whether a complete, verified payload is installed.
func (c *Config) PayloadOK() bool {
	_, err := payload.ReadInstalled(c.AddonDir())
	return err == nil
}

// Result is what Apply did.
type Result struct {
	Version   string
	Targets   []RecordTarget // stubs written
	Unchanged []string       // already up to date
}

// Apply activates a staged payload (nil = keep the installed one: repair) and writes the Telinha stub into
// each chosen target (PAYLOAD.md 4.4-4.7). Discord must be closed.
func (c *Config) Apply(st *Staged, chosen []Target) (*Result, error) {
	c.logf("apply: begin, targets=%s, payload=%s", targetList(chosen), stagedState(st))
	if err := c.ensureNotRunning(); err != nil {
		c.logf("apply: refused: %v", err)
		return nil, err
	}
	if st != nil && !st.UpToDate {
		if err := payload.Swap(c.Home()); err != nil {
			return nil, problem(CodeFailed, "Não foi possível instalar os arquivos do Telinha. Feche o Discord e tente de novo.", err)
		}
		c.logf("payload: activated %s", st.Manifest.Label())
	}
	m, err := payload.ReadInstalled(c.AddonDir())
	if err != nil {
		if st == nil && !fsutil.IsDir(c.AddonDir()) {
			return nil, problem(CodeNotInstalled, "O Telinha não está instalado. Use Instalar.", err)
		}
		return nil, problem(CodePayload, "Os arquivos do Telinha estão incompletos. Use Instalar para baixá-los de novo.", err)
	}
	template, err := os.ReadFile(filepath.Join(c.AddonDir(), m.StubTemplate))
	if err != nil {
		return nil, problem(CodePayload, "Os arquivos do Telinha estão incompletos. Use Instalar para baixá-los de novo.", err)
	}
	loader := filepath.Join(c.AddonDir(), m.LoaderEntry)

	res := &Result{Version: m.Label()}
	var errs []error
	for _, t := range chosen {
		rt, changed, err := c.applyOne(t.Install, string(template), loader)
		if err != nil {
			c.logf("apply %s: %v", t.Name, err)
			errs = append(errs, fmt.Errorf("%s: %w", t.Name, err))
			continue
		}
		if changed {
			res.Targets = append(res.Targets, *rt)
		} else {
			res.Unchanged = append(res.Unchanged, rt.Flavor+`\`+rt.App)
		}
		rec := c.recordFor(st, m)
		rec.Targets = mergeTargets(rec.Targets, *rt)
		if err := c.writeRecord(rec); err != nil {
			c.logf("install.json: %v", err)
		} else {
			c.logf("install.json: written %s (%d target(s))", c.RecordPath(), len(rec.Targets))
		}
	}
	if len(errs) > 0 {
		return res, problem(CodeFailed, "Não foi possível ativar o Telinha em todos os Discords. Feche o Discord completamente e tente de novo.", errors.Join(errs...))
	}
	c.logf("apply: done, Telinha %s, %d stub(s) written, %d already up to date", res.Version, len(res.Targets), len(res.Unchanged))
	return res, nil
}

func targetList(ts []Target) string {
	var n []string
	for _, t := range ts {
		n = append(n, t.Name+" "+t.App)
	}
	if len(n) == 0 {
		return "none"
	}
	return strings.Join(n, ", ")
}

func stagedState(st *Staged) string {
	switch {
	case st == nil:
		return "keep the installed one"
	case st.UpToDate:
		return "staged, identical to the installed one"
	}
	return "staged " + st.Manifest.Label()
}

func (c *Config) recordFor(st *Staged, m *payload.Manifest) *Record {
	old, _ := c.ReadRecord()
	rec := &Record{InstalledAt: time.Now().UTC().Format(time.RFC3339), Version: m.Version, Commit: m.Commit, InstallerVersion: c.InstallerVersion}
	if old != nil {
		rec.Targets = old.Targets
		rec.Source = old.Source
	}
	if st != nil && st.Source != nil {
		rec.Source = st.Source
	}
	return rec
}

func mergeTargets(list []RecordTarget, t RecordTarget) []RecordTarget {
	for i := range list {
		if samePath(list[i].Resources, t.Resources) {
			list[i] = t
			return list
		}
	}
	return append(list, t)
}

// applyOne backs up Vencord's stub (when that is what is there) and writes ours, atomically, then checks.
func (c *Config) applyOne(in discord.Install, template, loader string) (*RecordTarget, bool, error) {
	t := c.scanOne(in) // re-read: things may have changed since the user clicked
	if t.State != StateReady {
		return nil, false, fmt.Errorf("not ready (%s): %s", t.State, t.Detail)
	}
	rt := &RecordTarget{Flavor: t.Flavor, App: t.App, Resources: t.Resources, VencordPatcher: t.Patcher, Previous: string(t.Kind)}
	if bp := c.BackupPath(in, t.App); fsutil.IsFile(bp) {
		rt.Backup = &bp
	}
	rendered, err := stub.Render(template, loader, t.Patcher)
	if err != nil {
		return nil, false, err
	}
	want := asar.BuildStub(rendered)
	appAsar := filepath.Join(t.Resources, "app.asar")

	if t.Kind == discord.KindVencordStub {
		bp := c.BackupPath(in, t.App)
		if err := os.MkdirAll(filepath.Dir(bp), 0o755); err != nil {
			return nil, false, err
		}
		if err := fsutil.WriteFileAtomic(bp, t.Inspect.Bytes); err != nil {
			return nil, false, fmt.Errorf("backup: %w", err)
		}
		rt.Backup = &bp
		c.logf("backup: %s -> %s (%d bytes)", appAsar, bp, len(t.Inspect.Bytes))
	}

	if fsutil.SameContent(appAsar, want) {
		c.logf("stub: %s already up to date", appAsar)
		return rt, false, nil
	}
	if err := fsutil.WriteFileAtomic(appAsar, want); err != nil {
		return nil, false, fmt.Errorf("writing %s: %w", appAsar, err)
	}
	after := discord.Inspect(t.Resources)
	if after.Kind != discord.KindTelinhaStub || after.Patcher != t.Patcher {
		return nil, false, fmt.Errorf("verification failed after writing %s (kind %s)", appAsar, after.Kind)
	}
	c.logf("stub: wrote %s (%d bytes, was %s, patcher %s)", appAsar, len(want), t.Kind, t.Patcher)
	return rt, true, nil
}

// UninstallResult is what Uninstall did.
type UninstallResult struct {
	Restored []string // flavor\app folders that got Vencord's stub back
}

// Uninstall puts Vencord's stub back wherever ours is (every app-* folder of every flavor) and removes
// the add-on, backups and install.json (PAYLOAD.md 5). Logs stay; see Purge. Vencord is never touched.
func (c *Config) Uninstall() (*UninstallResult, error) {
	c.logf("uninstall: begin")
	if err := c.ensureNotRunning(); err != nil {
		c.logf("uninstall: refused: %v", err)
		return nil, err
	}
	res := &UninstallResult{}
	var errs []error
	for _, in := range c.Installs {
		for _, app := range discord.AppFolders(in.Root) {
			res2, err := c.restoreOne(in, app)
			if err != nil {
				c.logf("uninstall %s %s: %v", in.Name, app, err)
				errs = append(errs, fmt.Errorf("%s %s: %w", in.Name, app, err))
			} else if res2 {
				res.Restored = append(res.Restored, filepath.Base(in.Root)+`\`+app)
			}
		}
	}
	if len(errs) > 0 {
		// keep our files: the stub still works (and falls back to plain Vencord without them)
		return res, problem(CodeFailed, "Não foi possível devolver o Discord ao Vencord original. Feche o Discord completamente e tente de novo.", errors.Join(errs...))
	}
	for _, name := range []string{payload.AddonDir, payload.NewDir, payload.OldDir, payload.PrevDir, "backup", "install.json", "download.zip.tmp"} {
		p := filepath.Join(c.Home(), name)
		if !fsutil.Exists(p) {
			continue
		}
		if err := fsutil.RemoveAll(p); err != nil {
			c.logf("uninstall: removing %s: %v", p, err)
			errs = append(errs, err)
		} else {
			c.logf("uninstall: removed %s", p)
		}
	}
	if len(errs) > 0 {
		return res, problem(CodeFailed, "O Discord voltou ao Vencord original, mas alguns arquivos do Telinha não puderam ser apagados ("+c.Home()+").", errors.Join(errs...))
	}
	c.logf("uninstall: done, Vencord stub restored in %d app folder(s)", len(res.Restored))
	return res, nil
}

func (c *Config) restoreOne(in discord.Install, app string) (bool, error) {
	resources := discord.ResourcesDir(in.Root, app)
	info := discord.Inspect(resources)
	if info.Kind != discord.KindTelinhaStub {
		return false, nil
	}
	if info.Patcher == "" {
		return false, fmt.Errorf("our stub in %s has no readable VENCORD_PATCHER; run Vencord's installer (Repair)", resources)
	}
	want := asar.VencordStub(info.Patcher)
	how := "regenerated"
	if b, err := os.ReadFile(c.BackupPath(in, app)); err == nil {
		if bi := discord.Classify(b, true); bi.Kind == discord.KindVencordStub && bi.Patcher == info.Patcher {
			want, how = b, "backup"
		}
	}
	appAsar := filepath.Join(resources, "app.asar")
	if err := fsutil.WriteFileAtomic(appAsar, want); err != nil {
		return false, err
	}
	after := discord.Inspect(resources)
	if after.Kind != discord.KindVencordStub || after.Patcher != info.Patcher {
		return false, fmt.Errorf("verification failed after restoring %s (kind %s)", appAsar, after.Kind)
	}
	c.logf("uninstall: restored Vencord stub in %s (%s, %d bytes)", appAsar, how, len(want))
	return true, nil
}

// Purge removes %APPDATA%\Telinha entirely (logs included). Close the log file first.
func (c *Config) Purge() error {
	return fsutil.RemoveAll(c.Home())
}

// Rollback swaps the add-on with the previous version kept by the last update. Discord must be closed.
func (c *Config) Rollback() (*payload.Manifest, error) {
	if err := c.ensureNotRunning(); err != nil {
		return nil, err
	}
	if err := payload.Rollback(c.Home()); err != nil {
		return nil, problem(CodeFailed, "Não há uma versão anterior do Telinha para voltar.", err)
	}
	m, err := payload.ReadInstalled(c.AddonDir())
	if err != nil {
		return nil, problem(CodePayload, "A versão anterior do Telinha está incompleta.", err)
	}
	c.logf("rollback: now %s", m.Label())
	return m, nil
}
