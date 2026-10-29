// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"context"
	"errors"

	"github.com/HumbertoFernandes7/Telinha/installer/internal/core"
)

// errCancelled: the user backed out (cancelled the download, kept Discord open, closed the picker).
var errCancelled = errors.New("cancelled by the user")

// installUI is what the front ends (CLI, GUI, tests) plug into the install sequence. Every hook is
// optional.
type installUI struct {
	// pick chooses among several ready Discords; ok=false means the user cancelled. nil = all of them.
	pick func(ready []core.Target) (chosen []core.Target, ok bool)
	// busy runs work while something shows progress (the GUI's progress dialog). cancellable says the
	// user may abort it (ctx is cancelled then). nil = run work inline.
	busy func(cancellable bool, work func(set func(string)) error) error
	// say gets short status lines (the CLI prints them). nil = dropped.
	say func(string)
	// closeDiscord gets Discord closed when it is running, asking first where that is needed.
	// proceed=false means the user said no. nil = nothing to close.
	closeDiscord func() (proceed bool, err error)
}

// install is the whole install/repair sequence: preflight, choose targets, download and verify (stage),
// close Discord, write the stubs (apply). The CLI, the GUI and the tests all go through it, so they all
// leave the same trail in installer.log. repair keeps the already installed files when they are complete.
func (a *app) install(ctx context.Context, repair bool, u installUI) (*core.Result, []core.Target, error) {
	say := u.say
	if say == nil {
		say = func(string) {}
	}
	busy := u.busy
	if busy == nil {
		busy = func(_ bool, work func(set func(string)) error) error { return work(say) }
	}
	a.log.Printf("install: begin (repair=%v, payload=%q)", repair, a.opt.payload)

	ready, err := a.cfg.Preflight()
	if err != nil {
		return nil, nil, err
	}
	chosen := ready
	if u.pick != nil {
		var ok bool
		if chosen, ok = u.pick(ready); !ok {
			a.log.Printf("install: cancelled at the target choice")
			return nil, nil, errCancelled
		}
	}
	a.log.Printf("install: targets chosen: %s", targetNames(chosen))

	var st *core.Staged
	if !repair || a.opt.payload != "" || !a.cfg.PayloadOK() {
		err = busy(true, func(set func(string)) error {
			var err error
			st, err = a.cfg.Stage(ctx, a.source(), set)
			return err
		})
		if ctx.Err() != nil {
			a.cfg.DiscardStaged()
			a.log.Printf("install: cancelled during the download")
			return nil, nil, errCancelled
		}
		if err != nil {
			return nil, nil, err
		}
	} else {
		a.log.Printf("install: repair with the files already installed (nothing to download)")
	}

	if u.closeDiscord != nil {
		proceed, err := u.closeDiscord()
		if !proceed {
			a.cfg.DiscardStaged()
			a.log.Printf("install: cancelled: the user kept Discord open")
			return nil, nil, errCancelled
		}
		if err != nil {
			a.cfg.DiscardStaged()
			return nil, nil, err
		}
	}

	var res *core.Result
	err = busy(false, func(set func(string)) error {
		set("Ativando o Telinha no Discord…")
		var err error
		res, err = a.cfg.Apply(st, chosen)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	a.log.Printf("install: finished, Telinha %s active in %s", res.Version, targetNames(chosen))
	return res, chosen, nil
}

// finish records the exit code and closes the log; every run ends through it (deferred in runCLI/runGUI).
func (a *app) finish(code int) {
	a.log.Printf("finished: exit code %d", code)
	a.log.Close()
}
