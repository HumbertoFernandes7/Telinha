/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of the synchronous half of addon/loader/updater.js, the part that runs at every Discord start and moves the
 * add-on folders: startup() (swap addon.new -> addon, roll back a version that never confirmed a good start), the lock,
 * the run markers of other Discords, state.json / install.json, the boot marker (markServed / confirmBoot).
 *
 *   node --test addon/test/updater.startup.test.mjs        (also run by `pnpm test:addon`)
 *
 * Everything on fake %APPDATA%\Telinha trees under the OS temp dir. Failures that Windows produces (files briefly locked
 * by an antivirus scan or a process that just exited: EBUSY / EPERM, a lock left by a crashed Discord, a second Discord
 * running from the same folder) are injected by wrapping fs methods and process.kill; the retry sleeps are mocked.
 *
 * What needs a real Windows machine: the real file locking behaviour (an open file blocking a rename) and the real
 * timing of antivirus scans. The rename retry logic is verified against injected EBUSY/EPERM only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { fakeKill, fsError, makeHome, makePayload, processList, upd, updaterFor, wrapFs, writePayload } from "./fake/update-kit.mjs";

const V010 = () => makePayload({ version: "0.1.0", commit: "base0100" });
const V011 = () => makePayload({ version: "0.1.1", commit: "new00101" });

/** The state.json trial of a swapped-in version. */
const trialFor = (payload, previous, extra = {}) => ({
    version: payload.version, commit: payload.commit, previous: previous.version, previousCommit: previous.commit,
    swappedAt: "2026-10-29T00:00:00.000Z", armed: false, unarmedStarts: 0, previousRecord: null, ...extra
});

const home = (t, opts) => {
    const h = makeHome({ installed: V010(), ...opts });
    t.after(() => h.cleanup());
    return h;
};

/** Runs startup() of a fresh updater (a new Discord start). */
const start = (h, opts, args) => {
    const u = updaterFor(h, opts);
    return Object.assign(u, { result: u.startup(args) });
};

// Each test gets its own run-marker slot: the marker lives on globalThis (one per process in production)
let savedMarker;
beforeEach(() => {
    savedMarker = globalThis.__TelinhaRunMarker;
});
afterEach(() => {
    const m = globalThis.__TelinhaRunMarker;
    if (m && m !== savedMarker) clearInterval(m.timer);
    if (savedMarker) globalThis.__TelinhaRunMarker = savedMarker;
    else delete globalThis.__TelinhaRunMarker;
});

describe("startup(): nothing to do", () => {
    test("no version.json in addon\\: updates are off this session (the unreadable install is logged, never thrown)", t => {
        const h = home(t, { installed: null });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /installed version\.json is unreadable; updates are off this session/.test(l)));
        assert.equal(u.installed, null);
        assert.deepEqual(u.status().installed, null);
        assert.deepEqual(u.confirmBoot(), { confirmed: false });
        assert.doesNotThrow(() => u.markServed());
    });

    test("actions: false (a hand-off that already went two levels deep): only the run marker, nothing moved", t => {
        const h = home(t, { staged: V011() });
        const u = start(h, undefined, { actions: false });
        assert.equal(u.result, null);
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.ok(fs.existsSync(join(h.runDir, String(process.pid))));
    });

    test("a plain start with nothing staged and no trial leaves everything alone", t => {
        const h = home(t);
        assert.equal(start(h).result, null);
        assert.equal(h.state(), null, "no state.json is written for nothing");
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
    });

    test("staging folders left by dead processes are cleaned, ours and unrelated names are kept", t => {
        const h = home(t);
        fs.mkdirSync(join(h.updateDir, "staging-1-111"), { recursive: true });
        fs.mkdirSync(join(h.updateDir, `staging-${process.pid}-5`), { recursive: true });
        fs.mkdirSync(join(h.updateDir, "keep-me"), { recursive: true });
        fs.writeFileSync(join(h.updateDir, "staging-notadir"), "x");
        start(h);
        assert.deepEqual(h.names(h.updateDir), ["keep-me", `staging-${process.pid}-5`, "run", "staging-notadir"].sort());
    });

    test("an unreadable update folder is not an error (cleanLeftovers shrugs)", t => {
        const h = home(t);
        wrapFs(t, fs, "readdirSync", (orig, p, ...rest) => {
            if (p === h.updateDir) throw fsError("EACCES");
            return orig(p, ...rest);
        });
        assert.equal(start(h).result, null);
    });
});

describe("startup(): the trial of a version that is no longer the installed one", () => {
    test("the add-on was replaced since (installer, manual copy): the trial is dropped and state written", t => {
        const h = home(t, { state: { format: 1, bad: {}, trial: trialFor(V011(), V010(), { version: "0.9.0", commit: "elsewhere" }) } });
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.state().trial, undefined);
        assert.ok(u.lines.some(l => /dropping the trial of a version that is no longer installed/.test(l)));
    });

    test("same version but another build counts as another version", t => {
        const h = home(t, { state: { format: 1, bad: {}, trial: trialFor(V010(), V010(), { commit: "otherbuild" }) } });
        start(h);
        assert.equal(h.state().trial, undefined);
    });
});

describe("startup(): rolling back a version that never confirmed a good start", () => {
    const armedHome = (t, { record = true, trial = {}, state = {}, withPrev = true } = {}) => {
        const prev = V010();
        const current = V011();
        return home(t, {
            installed: current, prev: withPrev ? prev : null, record,
            state: { format: 1, bad: {}, trial: trialFor(current, prev, { armed: true, ...trial }), ...state }
        });
    };

    test("armed trial: addon.prev comes back, the failed version is marked bad and not kept, install.json follows", t => {
        const h = armedHome(t, { trial: { previousRecord: { version: "0.1.0", commit: "base0100", source: { kind: "github", release: "v0.1.0", asset: "a.zip", sha256: "b".repeat(64) } } } });
        const u = start(h);
        assert.deepEqual({ ...u.result }, { kind: "rolledBack", from: "0.1.1", to: "0.1.0" });
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
        assert.deepEqual(h.names(join(h.root, "Telinha")).filter(n => n.startsWith("addon")), ["addon"], "no addon.prev / addon.old / addon.new left");
        const s = h.state();
        assert.equal(s.trial, undefined);
        assert.ok(s.bad["0.1.1"]);
        assert.equal(s.bad["0.1.1"].commit, "new00101");
        assert.match(s.bad["0.1.1"].reason, /did not confirm a good start/);
        assert.deepEqual({ version: s.lastRollback.version, to: s.lastRollback.to }, { version: "0.1.1", to: "0.1.0" });
        const r = h.record();
        assert.equal(r.version, "0.1.0");
        assert.equal(r.commit, "base0100");
        assert.equal(r.source.release, "v0.1.0", "the source the installer recorded before the update is restored");
        assert.equal(r.updatedBy, "telinha-auto-rollback");
        assert.match(r.installedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        assert.equal(r.targets.length, 1, "the installer's targets are kept");
        assert.ok(u.lines.some(l => /ROLLED BACK/.test(l)));
    });

    test("without a recorded previous install.json: version/commit from addon.prev, the stale source is dropped", t => {
        const h = armedHome(t, { trial: { previousRecord: null } });
        start(h);
        const r = h.record();
        assert.equal(r.version, "0.1.0");
        assert.equal(r.commit, "base0100");
        assert.equal("source" in r, false);
    });

    test("a recorded previous version that is not the one in addon.prev is not trusted", t => {
        const h = armedHome(t, { trial: { previousRecord: { version: "0.0.5", commit: "zzz", source: { kind: "github" } } } });
        start(h);
        assert.equal(h.record().version, "0.1.0");
        assert.equal(h.record().commit, "base0100");
        assert.equal("source" in h.record(), false);
    });

    test("a staged-state entry for the failed version is forgotten too", t => {
        const h = armedHome(t, { state: { staged: { version: "0.1.1", commit: "new00101", tag: "v0.1.1" } } });
        start(h);
        assert.equal(h.state().staged, undefined);
    });

    test("a staged-state entry for another version is kept", t => {
        const h = armedHome(t, { state: { staged: { version: "0.1.5", commit: "x", tag: "v0.1.5" } } });
        start(h);
        assert.equal(h.state().staged.version, "0.1.5");
    });

    test("no install.json to update (never created by the loader): the rollback still works", t => {
        const h = armedHome(t, { record: false });
        assert.equal(start(h).result.kind, "rolledBack");
        assert.equal(h.record(), null);
    });

    test("a corrupt install.json is left alone, not rewritten", t => {
        const h = armedHome(t, { record: false });
        fs.writeFileSync(h.recordFile, "[1,2]");
        start(h);
        assert.equal(fs.readFileSync(h.recordFile, "utf8"), "[1,2]");
        fs.writeFileSync(h.recordFile, "{ not json");
        start(armedHome(t, { record: false }));
        assert.equal(fs.readFileSync(h.recordFile, "utf8"), "{ not json");
    });

    test("install.json that cannot be written: logged, rollback not undone", t => {
        const h = armedHome(t);
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (to === h.recordFile) throw fsError("EXDEV", "cross-device");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result.kind, "rolledBack");
        assert.ok(u.lines.some(l => /install\.json not updated/.test(l)));
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
    });

    test("another Discord is running from this folder: the rollback waits, the trial is kept", t => {
        const h = armedHome(t);
        fs.mkdirSync(h.runDir, { recursive: true });
        fs.writeFileSync(join(h.runDir, "4242"), "{}");
        fakeKill(t, { alive: [4242] });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /rollback waits, another Discord is running from this add-on/.test(l)));
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
        assert.equal(h.state().trial.armed, true);
    });

    test("an armed trial of a version that is no longer the installed one is dropped, not rolled back", t => {
        const h = armedHome(t);
        const s = h.state();
        s.trial = trialFor(V011(), V010(), { armed: true, version: "0.9.9", commit: "other" });
        fs.writeFileSync(h.stateFile, JSON.stringify(s));
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.state().trial, undefined);
        assert.equal(h.versionOf(h.addonDir), "0.1.1", "the add-on in addon\\ is not judged by another version's trial");
    });

    test("the lock is held by another process: nothing is moved, the trial stays for the next start", t => {
        const h = armedHome(t);
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
        assert.equal(h.state().trial.armed, true);
        assert.ok(fs.existsSync(h.lock), "somebody else's lock is not ours to remove");
    });

    test("no usable addon.prev: the failed version is kept, the trial is dropped (nothing to go back to)", t => {
        const h = armedHome(t, { withPrev: false });
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
        assert.equal(h.state().trial, undefined);
        assert.ok(u.lines.some(l => /ERROR cannot roll back, no usable previous version; keeping/.test(l)));
    });

    test("a tampered addon.prev is as good as none", t => {
        const h = armedHome(t);
        fs.writeFileSync(join(h.prev, "main.js"), "tampered");
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.state().trial, undefined);
        assert.ok(u.lines.some(l => /cannot roll back/.test(l) && /does not match version\.json/.test(l)));
    });

    test("addon.prev holding the very version that failed is refused (would roll back to itself)", t => {
        const h = armedHome(t, { withPrev: false });
        const current = V011();
        for (const [n, b] of current.files) fs.mkdirSync(h.prev, { recursive: true }), fs.writeFileSync(join(h.prev, n), b);
        fs.writeFileSync(join(h.prev, "version.json"), current.manifestBytes);
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /addon\.prev is the failed version itself/.test(l)));
        assert.equal(h.state().trial, undefined);
    });

    test("addon\\ locked (EBUSY on every try): the rollback is postponed, nothing changed, the trial stays", t => {
        const h = armedHome(t);
        const wait = t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.addonDir) throw fsError("EBUSY");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /rollback postponed, the add-on folder is in use/.test(l)));
        assert.equal(wait.mock.callCount(), 4, "5 attempts, a pause between each");
        assert.deepEqual(wait.mock.calls.map(c => c.arguments[3]), [200, 200, 200, 200]);
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
        assert.equal(h.versionOf(h.prev), "0.1.0");
        assert.equal(h.state().trial.armed, true);
    });

    test("addon.prev cannot be moved into place: addon\\ is put back, postponed", t => {
        const h = armedHome(t);
        t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.prev) throw fsError("EPERM");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /rollback postponed, could not restore addon\.prev/.test(l)));
        assert.equal(h.versionOf(h.addonDir), "0.1.1", "the folder that was moved aside is back");
        assert.equal(h.versionOf(h.prev), "0.1.0");
    });

    test("...and when putting addon\\ back fails too, the failure is swallowed (and logged as the postponed rollback)", t => {
        const h = armedHome(t);
        t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.prev || from === h.old) throw fsError("EPERM");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /could not restore addon\.prev/.test(l)));
    });
});

describe("startup(): activating a staged update", () => {
    test("swaps addon.new in, keeps the old version as addon.prev, records the trial and the release in install.json", t => {
        const h = home(t, { staged: V011() });
        const u = start(h);
        assert.deepEqual({ ...u.result }, { kind: "swapped", from: "0.1.0", to: "0.1.1" });
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
        assert.equal(h.versionOf(h.prev), "0.1.0");
        assert.equal(fs.existsSync(h.staged), false);
        assert.equal(fs.existsSync(h.old), false);
        const trial = h.state().trial;
        assert.deepEqual({ version: trial.version, commit: trial.commit, previous: trial.previous, previousCommit: trial.previousCommit, armed: trial.armed, unarmedStarts: trial.unarmedStarts },
            { version: "0.1.1", commit: "new00101", previous: "0.1.0", previousCommit: "base0100", armed: false, unarmedStarts: 0 });
        assert.deepEqual(trial.previousRecord, { version: "0.1.0", commit: "base0100", source: { kind: "github", release: "v0.1.0", asset: "a.zip", sha256: "a".repeat(64) } });
        assert.equal(h.state().staged, undefined);
        const r = h.record();
        assert.deepEqual([r.version, r.commit, r.updatedBy], ["0.1.1", "new00101", "telinha-auto-update"]);
        assert.equal("source" in r, false, "no release known for this staged copy: the old source is not kept");
        assert.ok(u.lines.some(l => /update: activated/.test(l)));
    });

    test("a staged copy the updater itself downloaded (state.staged): its release goes into install.json", t => {
        const h = home(t, { staged: V011(), state: { format: 1, bad: {}, staged: { version: "0.1.1", commit: "new00101", tag: "v0.1.1", asset: "Telinha-addon-v011.zip", sha256: "c".repeat(64) } } });
        start(h);
        assert.deepEqual(h.record().source, { kind: "github", release: "v0.1.1", asset: "Telinha-addon-v011.zip", sha256: "c".repeat(64) });
    });

    test("a state.staged entry of another build is not trusted for the record", t => {
        const h = home(t, { staged: V011(), state: { format: 1, bad: {}, staged: { version: "0.1.1", commit: "someone-else", tag: "v0.1.1", asset: "x.zip", sha256: "c".repeat(64) } } });
        start(h);
        assert.equal("source" in h.record(), false);
    });

    test("with no install.json at all (record: false) the swap still happens and previousRecord is null", t => {
        const h = home(t, { staged: V011(), record: false });
        start(h);
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
        assert.equal(h.state().trial.previousRecord, null);
        assert.equal(h.record(), null);
    });

    test("an older addon.prev and a leftover addon.old are replaced", t => {
        const h = home(t, { staged: V011(), prev: makePayload({ version: "0.0.1", commit: "ancient" }) });
        fs.mkdirSync(h.old, { recursive: true });
        fs.writeFileSync(join(h.old, "junk.txt"), "x");
        start(h);
        assert.equal(h.versionOf(h.prev), "0.1.0");
        assert.equal(fs.existsSync(h.old), false);
    });

    test("a rename hit by a short lock (EBUSY, EPERM) is retried after a pause and the swap goes through", t => {
        const h = home(t, { staged: V011() });
        const wait = t.mock.method(Atomics, "wait", () => "timed-out");
        let failures = 0;
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.addonDir && failures < 2) {
                failures++;
                throw fsError(failures === 1 ? "EBUSY" : "EPERM");
            }
            return orig(from, to);
        });
        assert.equal(start(h).result.kind, "swapped");
        assert.equal(failures, 2);
        assert.equal(wait.mock.callCount(), 2);
    });

    test("a failure that is not a lock (ENOENT, EXDEV) is not retried", t => {
        const h = home(t, { staged: V011() });
        const wait = t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.addonDir) throw fsError("EXDEV");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(wait.mock.callCount(), 0);
        assert.ok(u.lines.some(l => /the add-on folder is in use; the update waits for the next start/.test(l)));
    });

    test("when Atomics.wait is not allowed (it throws), the pause is simply skipped", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => { throw new TypeError("Atomics.wait cannot be called in this context"); });
        let failed = false;
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.addonDir && !failed) {
                failed = true;
                throw fsError("EBUSY");
            }
            return orig(from, to);
        });
        assert.equal(start(h).result.kind, "swapped");
    });

    test("addon\\ locked: nothing moved, addon.new kept for the next start", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.addonDir) throw fsError("EBUSY");
            return orig(from, to);
        });
        const u = start(h, { now: () => Date.parse("2026-10-31T03:00:00Z") });
        assert.equal(u.result, null);
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.deepEqual(h.state(), {
            format: 1, bad: {},
            waiting: { version: "0.1.1", reason: "in-use", detail: { code: "EBUSY" }, at: "2026-10-31T03:00:00.000Z", starts: 1 }
        }, "no trial, no staged entry: only why it waits");
    });

    test("addon.new cannot be put in place: the old addon\\ is moved back, the staged copy waits", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.staged) throw fsError("EBUSY");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.ok(u.lines.some(l => /could not activate the staged add-on; it waits for the next start/.test(l)));
    });

    test("...and if the old addon\\ cannot be moved back either, it is logged as an ERROR", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.staged || from === h.old) throw fsError("EPERM");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /ERROR could not put the add-on folder back/.test(l)));
    });

    test("the old version cannot be kept as addon.prev: the swap stands, no rollback is possible, addon.old is cleaned", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.old && to === h.prev) throw fsError("EPERM");
            return orig(from, to);
        });
        const u = start(h);
        assert.equal(u.result.kind, "swapped");
        assert.ok(u.lines.some(l => /previous version not kept as addon\.prev \(no rollback possible\)/.test(l)));
        assert.equal(fs.existsSync(h.prev), false);
        assert.equal(fs.existsSync(h.old), false);
    });

    test("a staged copy that no longer verifies is discarded, with its state entry", t => {
        const h = home(t, { staged: V011(), state: { format: 1, bad: {}, staged: { version: "0.1.1", commit: "new00101", tag: "v0.1.1" } } });
        fs.writeFileSync(join(h.staged, "main.js"), "tampered after staging");
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(fs.existsSync(h.staged), false);
        assert.equal(h.state().staged, undefined);
        assert.ok(u.lines.some(l => /staged add-on is invalid, discarding it/.test(l)));
    });

    test("a staged copy that is not newer (same or older) is discarded: never a downgrade", t => {
        for (const v of ["0.1.0", "0.0.9"]) {
            const h = home(t, { staged: makePayload({ version: v, commit: `c${v}` }) });
            const u = start(h);
            assert.equal(u.result, null, v);
            assert.equal(fs.existsSync(h.staged), false, v);
            assert.equal(h.versionOf(h.addonDir), "0.1.0");
            assert.ok(u.lines.some(l => /not a newer, good version; discarding it/.test(l)));
        }
    });

    test("a staged copy of a version that already failed is discarded", t => {
        const h = home(t, { staged: V011(), state: { format: 1, bad: { "0.1.1": { at: "x", reason: "test" } } } });
        assert.equal(start(h).result, null);
        assert.equal(fs.existsSync(h.staged), false);
        assert.ok(h.state().bad["0.1.1"], "the memory of the failure is kept");
    });

    test("the current version is still on trial: the staged update waits until it confirms a good start", t => {
        const cur = V011();
        const h = home(t, { installed: cur, staged: makePayload({ version: "0.1.2", commit: "n2" }), prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010()) } });
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
        assert.equal(h.versionOf(h.staged), "0.1.2");
        assert.ok(u.lines.some(l => /staged update waits until the current version confirms a good start/.test(l)));
        assert.equal(h.state().trial.unarmedStarts, 1);
    });

    test("another Discord is running: the swap waits, the staged copy stays", t => {
        const h = home(t, { staged: V011() });
        fs.mkdirSync(h.runDir, { recursive: true });
        fs.writeFileSync(join(h.runDir, "4242"), "{}");
        fakeKill(t, { alive: [4242] });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /staged update waits, another Discord is running from this add-on/.test(l) && /4242/.test(l)));
        assert.equal(h.versionOf(h.staged), "0.1.1");
    });

    test("the lock is held by another process: the swap waits for the next start", t => {
        const h = home(t, { staged: V011() });
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        assert.equal(start(h).result, null);
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
    });

    test("the lock is released afterwards, success or not", t => {
        const h = home(t, { staged: V011() });
        start(h);
        assert.equal(fs.existsSync(h.lock), false);
        const h2 = home(t, { staged: V011() });
        fs.writeFileSync(join(h2.staged, "main.js"), "tampered");
        start(h2);
        assert.equal(fs.existsSync(h2.lock), false);
    });
});

describe("the trial counter (a version whose renderer is never served)", () => {
    test("counts the starts without the renderer; past 5 the trial is dropped and the version is kept", t => {
        const cur = V011();
        const h = home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010()) } });
        for (let n = 1; n <= 5; n++) {
            start(h);
            assert.equal(h.state().trial.unarmedStarts, n);
        }
        const u = start(h);
        assert.equal(h.state().trial, undefined);
        assert.ok(u.lines.some(l => /the renderer never loaded during the trial; keeping the version/.test(l)));
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
    });

    test("a trial written without a counter starts counting at 1", t => {
        const cur = V011();
        const trial = trialFor(cur, V010());
        delete trial.unarmedStarts;
        const h = home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial } });
        start(h);
        assert.equal(h.state().trial.unarmedStarts, 1);
    });
});

describe("the lock (swap.lock)", () => {
    const armed = t => {
        const cur = V011();
        return home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010(), { armed: true }) } });
    };
    const ago = (file, ms) => fs.utimesSync(file, new Date(Date.now() - ms), new Date(Date.now() - ms));

    test("a lock left by a crashed Discord (older than 2 minutes) is taken over", t => {
        const h = armed(t);
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        ago(h.lock, 5 * 60_000);
        assert.equal(start(h).result.kind, "rolledBack");
        assert.equal(fs.existsSync(h.lock), false);
    });

    test("a fresh lock (under 2 minutes) is respected", t => {
        const h = armed(t);
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        ago(h.lock, 30_000);
        assert.equal(start(h).result, null);
    });

    test("a lock that vanishes while we look at it counts as stale (and is taken)", t => {
        const h = armed(t);
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        wrapFs(t, fs, "statSync", (orig, p, ...rest) => {
            if (p === h.lock) throw fsError("ENOENT");
            return orig(p, ...rest);
        });
        assert.equal(start(h).result.kind, "rolledBack");
    });

    test("a stale lock that cannot be removed: gives up (null), moves nothing", t => {
        const h = armed(t);
        t.mock.method(Atomics, "wait", () => "timed-out");
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        ago(h.lock, 5 * 60_000);
        wrapFs(t, fs, "rmSync", (orig, p, ...rest) => {
            if (p === h.lock) throw fsError("EPERM");
            return orig(p, ...rest);
        });
        const u = start(h);
        assert.equal(u.result, null);
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
    });

    test("an error other than 'already exists' while taking the lock propagates (main.js logs it as 'update startup')", t => {
        const h = armed(t);
        wrapFs(t, fs, "openSync", (orig, p, ...rest) => {
            if (p === h.lock) throw fsError("EACCES", "no access");
            return orig(p, ...rest);
        });
        assert.throws(() => start(h), /no access/);
    });

    test("the lock file's descriptor closing badly does not matter", t => {
        const h = armed(t);
        let lockFd = null;
        wrapFs(t, fs, "openSync", (orig, p, ...rest) => {
            const fd = orig(p, ...rest);
            if (p === h.lock) lockFd = fd;
            return fd;
        });
        wrapFs(t, fs, "closeSync", (orig, fd) => {
            orig(fd);
            if (fd === lockFd) throw fsError("EIO");
        });
        assert.equal(start(h).result.kind, "rolledBack");
        assert.equal(fs.existsSync(h.lock), false);
    });
});

describe("other Discords running from the same add-on (run markers)", () => {
    const staged = t => home(t, { staged: V011() });
    const marker = (h, name, ageMs = 0) => {
        fs.mkdirSync(h.runDir, { recursive: true });
        const file = join(h.runDir, String(name));
        fs.writeFileSync(file, "{}");
        if (ageMs) fs.utimesSync(file, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
        return file;
    };

    test("a live other process blocks the swap; our own marker never does", t => {
        const h = staged(t);
        marker(h, 4242);
        fakeKill(t, { alive: [4242] });
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(fs.existsSync(join(h.runDir, "4242")), "a live marker is kept");
        assert.ok(fs.existsSync(join(h.runDir, String(process.pid))), "ours is written");
    });

    test("a pid that exists but belongs to another user (EPERM) counts as alive", t => {
        const h = staged(t);
        marker(h, 4343);
        fakeKill(t, { eperm: [4343] });
        assert.equal(start(h).result, null);
        assert.ok(h.versionOf(h.staged));
    });

    test("dead pids (ESRCH) and markers that are too old (pid reuse) are ignored and removed; the swap goes ahead", t => {
        const h = staged(t);
        const dead = marker(h, 999999);
        const old = marker(h, 4242, 13 * 60 * 60_000);
        fakeKill(t, { alive: [4242] });
        assert.equal(start(h).result.kind, "swapped");
        assert.equal(fs.existsSync(dead), false);
        assert.equal(fs.existsSync(old), false, "alive but older than 12 h: a reused pid, not a Discord");
    });

    test("names that are not process ids are ignored and removed", t => {
        const h = staged(t);
        const files = ["abc", "0", "-5", "12.5", "1e3x"].map(n => marker(h, n));
        const kill = t.mock.method(process, "kill", () => true);
        assert.equal(start(h).result.kind, "swapped");
        assert.deepEqual(files.map(f => fs.existsSync(f)), files.map(() => false));
        assert.equal(kill.mock.callCount(), 0, "no signal is sent to a made-up pid");
    });

    test("a marker that vanishes while we look at it is skipped", t => {
        const h = staged(t);
        const gone = marker(h, 4242);
        wrapFs(t, fs, "statSync", (orig, p, ...rest) => {
            if (p === gone) throw fsError("ENOENT");
            return orig(p, ...rest);
        });
        fakeKill(t, { alive: [4242] });
        assert.equal(start(h).result.kind, "swapped");
    });

    test("no run folder at all: nobody else is running", t => {
        const h = staged(t);
        wrapFs(t, fs, "readdirSync", (orig, p, ...rest) => {
            if (p === h.runDir) throw fsError("ENOENT");
            return orig(p, ...rest);
        });
        assert.equal(start(h).result.kind, "swapped");
    });
});

describe("registerRun (this process's marker)", () => {
    test("writes <pid> with pid, time and installed version, and removes it when the process exits", t => {
        const h = home(t);
        delete globalThis.__TelinhaRunMarker;
        const once = t.mock.method(process, "once", () => process);
        const u = updaterFor(h, { now: () => Date.parse("2026-10-29T12:00:00Z") });
        u.startup({ actions: false });
        const file = join(h.runDir, String(process.pid));
        assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { pid: process.pid, at: "2026-10-29T12:00:00.000Z", version: "0.1.0" });
        assert.equal(globalThis.__TelinhaRunMarker.file, file);
        assert.equal(once.mock.callCount(), 1);
        assert.equal(once.mock.calls[0].arguments[0], "exit");
        once.mock.calls[0].arguments[1]();
        assert.equal(fs.existsSync(file), false);
    });

    test("an exit handler that cannot remove the marker stays silent", t => {
        const h = home(t);
        delete globalThis.__TelinhaRunMarker;
        const once = t.mock.method(process, "once", () => process);
        updaterFor(h).startup({ actions: false });
        wrapFs(t, fs, "rmSync", () => { throw fsError("EPERM"); });
        assert.doesNotThrow(() => once.mock.calls[0].arguments[1]());
    });

    test("a second updater in the same process replaces the first one's timer and registers no second exit handler", t => {
        const h = home(t);
        delete globalThis.__TelinhaRunMarker;
        const once = t.mock.method(process, "once", () => process);
        const clear = t.mock.method(globalThis, "clearInterval");
        updaterFor(h).startup({ actions: false });
        const first = globalThis.__TelinhaRunMarker.timer;
        updaterFor(h).startup({ actions: false });
        assert.equal(once.mock.callCount(), 1);
        assert.ok(clear.mock.calls.some(c => c.arguments[0] === first), "the first heartbeat is stopped");
        assert.notEqual(globalThis.__TelinhaRunMarker.timer, first);
    });

    test("a marker of another folder in the same process is not stopped (only the same file is replaced)", t => {
        delete globalThis.__TelinhaRunMarker;
        t.mock.method(process, "once", () => process);
        const clear = t.mock.method(globalThis, "clearInterval");
        const a = home(t);
        const b = home(t);
        updaterFor(a).startup({ actions: false });
        const first = globalThis.__TelinhaRunMarker.timer;
        updaterFor(b).startup({ actions: false });
        assert.equal(clear.mock.calls.some(c => c.arguments[0] === first), false);
        clearInterval(first);
    });

    test("a live Discord touches its marker every 5 minutes (so an old marker means a dead process)", t => {
        const h = home(t);
        delete globalThis.__TelinhaRunMarker;
        t.mock.method(process, "once", () => process);
        t.mock.timers.enable({ apis: ["setInterval"] });
        let clock = Date.parse("2026-10-29T12:00:00Z");
        const u = updaterFor(h, { now: () => clock });
        u.startup({ actions: false });
        const file = join(h.runDir, String(process.pid));
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).at, "2026-10-29T12:00:00.000Z");
        clock += 5 * 60_000;
        t.mock.timers.tick(5 * 60_000);
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).at, "2026-10-29T12:05:00.000Z");
        wrapFs(t, fs, "writeFileSync", () => { throw fsError("EBUSY"); });
        assert.doesNotThrow(() => t.mock.timers.tick(5 * 60_000));
    });

    test("the run folder cannot be created: logged, the start goes on", t => {
        const h = home(t);
        wrapFs(t, fs, "mkdirSync", (orig, p, ...rest) => {
            if (p === h.runDir) throw fsError("EACCES", "denied");
            return orig(p, ...rest);
        });
        const u = updaterFor(h);
        assert.equal(u.startup(), null);
        assert.ok(u.lines.some(l => /run marker not written "denied"/.test(l)), u.lines.join("\n"));
    });
});

describe("state.json", () => {
    test("missing: silently a fresh state; unreadable or too large: logged and started over", t => {
        const h = home(t);
        const u = updaterFor(h);
        assert.deepEqual(u.readState(), { format: 1, bad: {} });
        assert.deepEqual(u.lines, []);
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.stateFile, "{ truncated");
        assert.deepEqual(u.readState(), { format: 1, bad: {} });
        assert.ok(u.lines.some(l => /state\.json unreadable, starting over/.test(l)));
        fs.writeFileSync(h.stateFile, Buffer.alloc(5 * 1024 * 1024, 0x20));
        u.lines.length = 0;
        assert.deepEqual(u.readState(), { format: 1, bad: {} });
        assert.equal(u.lines.length, 1);
    });

    test("valid JSON that is not an object is a fresh state too (no log: nothing was unreadable)", t => {
        const h = home(t, { state: "[1, 2]" });
        const u = updaterFor(h);
        assert.deepEqual(u.readState(), { format: 1, bad: {} });
        fs.writeFileSync(h.stateFile, "null");
        assert.deepEqual(u.readState(), { format: 1, bad: {} });
        assert.deepEqual(u.lines, []);
    });

    test("a state whose `bad` is not an object is repaired; other fields and the format are normalised", t => {
        for (const bad of [undefined, null, [], "x", 3]) {
            const h = home(t, { state: { format: 7, bad, lastCheck: { at: "x" } } });
            const s = updaterFor(h).readState();
            assert.deepEqual(s.bad, {});
            assert.equal(s.format, 1);
            assert.deepEqual(s.lastCheck, { at: "x" });
        }
    });
});

describe("the boot marker: markServed() and confirmBoot()", () => {
    const trialHome = (t, trial = {}, extra = {}) => {
        const cur = V011();
        return home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010(), trial), ...extra } });
    };

    test("markServed arms the trial once, with a time stamp", t => {
        const h = trialHome(t);
        const u = updaterFor(h, { now: () => Date.parse("2026-10-29T12:00:00Z") });
        u.markServed();
        assert.equal(h.state().trial.armed, true);
        assert.equal(h.state().trial.armedAt, "2026-10-29T12:00:00.000Z");
        assert.ok(u.lines.some(l => /boot marker set \(renderer served\)/.test(l)));
        const stamp = fs.statSync(h.stateFile).mtimeMs;
        u.markServed();
        assert.equal(fs.statSync(h.stateFile).mtimeMs, stamp, "the second call changes nothing");
    });

    test("markServed with no trial, or a trial of another build, or one already armed: nothing written", t => {
        const h = home(t);
        updaterFor(h).markServed();
        assert.equal(h.state(), null);
        const other = trialHome(t, { version: "9.9.9", commit: "other" });
        updaterFor(other).markServed();
        assert.equal(other.state().trial.armed, false);
        const armed = trialHome(t, { armed: true, armedAt: "before" });
        updaterFor(armed).markServed();
        assert.equal(armed.state().trial.armedAt, "before");
    });

    test("markServed that cannot write is logged, never thrown (a locked state.json must not stop Discord)", t => {
        const h = trialHome(t);
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (to === h.stateFile) throw fsError("EXDEV");
            return orig(from, to);
        });
        const u = updaterFor(h);
        assert.doesNotThrow(() => u.markServed());
        assert.ok(u.lines.some(l => /boot marker not written/.test(l)));
        assert.deepEqual(h.names(h.updateDir).filter(n => n.includes(".tmp-")), [], "the temp file of the failed atomic write is removed");
    });

    test("a failed atomic write whose temp file cannot be removed either still reports the original failure", t => {
        const h = trialHome(t);
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (to === h.stateFile) throw fsError("EXDEV", "cross-device");
            return orig(from, to);
        });
        wrapFs(t, fs, "rmSync", (orig, p, ...rest) => {
            if (String(p).includes(".tmp-")) throw fsError("EPERM");
            return orig(p, ...rest);
        });
        const u = updaterFor(h);
        u.markServed();
        assert.ok(u.lines.some(l => /boot marker not written "cross-device"/.test(l)), u.lines.join("\n"));
    });

    test("confirmBoot: the plugin reported a good start -> trial over, answers { confirmed: true }", t => {
        const h = trialHome(t, { armed: true });
        const u = updaterFor(h);
        assert.deepEqual(u.confirmBoot({ info: { enabled: true } }), { confirmed: true });
        assert.equal(h.state().trial, undefined);
        assert.ok(u.lines.some(l => /good start confirmed/.test(l)));
        assert.deepEqual(u.confirmBoot(), { confirmed: true }, "a second report is a no-op");
    });

    test("confirmBoot with main-process problems is not a confirmation and leaves the trial armed", t => {
        const h = trialHome(t, { armed: true });
        const u = updaterFor(h);
        assert.deepEqual(u.confirmBoot({ healthy: false, problems: ["plugin natives not loaded"], info: null }), { confirmed: false });
        assert.equal(h.state().trial.armed, true);
        assert.ok(u.lines.some(l => /good start NOT confirmed/.test(l)));
        assert.deepEqual(u.confirmBoot({ healthy: true }), { confirmed: true }, "a later healthy report still works");
    });

    test("confirmBoot clears a 'bad' mark of the version that is now running fine (installed again on purpose)", t => {
        const h = home(t, { state: { format: 1, bad: { "0.1.0": { at: "x", reason: "old failure" }, "0.0.9": { at: "y" } } } });
        updaterFor(h).confirmBoot();
        assert.deepEqual(Object.keys(h.state().bad), ["0.0.9"]);
    });

    test("confirmBoot for a start with nothing to record writes nothing", t => {
        const h = home(t);
        assert.deepEqual(updaterFor(h).confirmBoot(), { confirmed: true });
        assert.equal(h.state(), null);
    });

    test("confirmBoot that cannot write: logged, but the start counts as confirmed in this process", t => {
        const h = trialHome(t, { armed: true });
        wrapFs(t, fs, "writeFileSync", (orig, p, ...rest) => {
            if (String(p).includes(".tmp-")) throw fsError("EIO", "disk error");
            return orig(p, ...rest);
        });
        const u = updaterFor(h);
        assert.deepEqual(u.confirmBoot(), { confirmed: true });
        assert.ok(u.lines.some(l => /could not record the good start/.test(l)));
    });
});

describe("rollbackNow() (the new loader could not even start)", () => {
    test("rolls back in this same start and marks the version bad", t => {
        const cur = V011();
        const h = home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010()) } });
        const r = updaterFor(h).rollbackNow("its loader threw during boot");
        assert.deepEqual({ ...r }, { kind: "rolledBack", from: "0.1.1", to: "0.1.0" });
        assert.equal(h.versionOf(h.addonDir), "0.1.0");
        assert.equal(h.state().bad["0.1.1"].reason, "its loader threw during boot");
    });

    test("with no trial there is nothing to roll back", t => {
        const h = home(t);
        assert.equal(updaterFor(h).rollbackNow("x"), null);
    });

    test("a lock held elsewhere: null", t => {
        const cur = V011();
        const h = home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010()) } });
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        assert.equal(updaterFor(h).rollbackNow("x"), null);
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
    });

    test("an unexpected failure (cannot even take the lock) is logged, never thrown", t => {
        const cur = V011();
        const h = home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010()) } });
        wrapFs(t, fs, "openSync", (orig, p, ...rest) => {
            if (p === h.lock) throw fsError("EACCES", "no access");
            return orig(p, ...rest);
        });
        const u = updaterFor(h);
        assert.equal(u.rollbackNow("x"), null);
        assert.ok(u.lines.some(l => /ERROR rollback failed "no access"/.test(l)), u.lines.join("\n"));
    });
});

describe("failures that are not Error objects (anything can be thrown) are logged by their text", () => {
    const BOOM = "disk exploded";
    const swapHome = t => home(t, { staged: V011() });
    const armedHome = t => {
        const cur = V011();
        return home(t, { installed: cur, prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010(), { armed: true }) } });
    };
    const failRename = (t, match) => wrapFs(t, fs, "renameSync", (orig, from, to) => {
        if (match(from, to)) throw BOOM;
        return orig(from, to);
    });
    const said = (u, re) => u.lines.some(l => re.test(l) && l.includes(BOOM));

    test("swap: addon\\ cannot be moved aside", t => {
        const h = swapHome(t);
        failRename(t, from => from === h.addonDir);
        assert.ok(said(start(h), /the add-on folder is in use/));
    });

    test("swap: addon.new cannot be moved in, and addon\\ cannot be put back", t => {
        const h = swapHome(t);
        failRename(t, from => from === h.staged || from === h.old);
        const u = start(h);
        assert.ok(said(u, /could not put the add-on folder back/));
        assert.ok(said(u, /could not activate the staged add-on/));
    });

    test("swap: the old version cannot be kept as addon.prev", t => {
        const h = swapHome(t);
        failRename(t, (from, to) => from === h.old && to === h.prev);
        assert.ok(said(start(h), /previous version not kept as addon\.prev/));
    });

    test("rollback: addon\\ cannot be moved aside", t => {
        const a = armedHome(t);
        failRename(t, from => from === a.addonDir);
        assert.ok(said(start(a), /rollback postponed, the add-on folder is in use/));
    });

    test("rollback: addon.prev cannot be moved in", t => {
        const b = armedHome(t);
        failRename(t, from => from === b.prev);
        assert.ok(said(start(b), /rollback postponed, could not restore addon\.prev/));
    });

    test("rollbackNow: the lock cannot be taken", t => {
        const h = armedHome(t);
        wrapFs(t, fs, "openSync", (orig, p, ...rest) => {
            if (p === h.lock) throw BOOM;
            return orig(p, ...rest);
        });
        assert.ok(said((() => { const u = updaterFor(h); u.rollbackNow("x"); return u; })(), /ERROR rollback failed/));
    });

    test("install.json cannot be written", t => {
        const h = armedHome(t);
        failRename(t, (from, to) => to === h.recordFile);
        assert.ok(said(start(h), /install\.json not updated/));
    });

    test("run marker folder cannot be created", t => {
        const h = home(t);
        wrapFs(t, fs, "mkdirSync", (orig, p, ...rest) => {
            if (p === h.runDir) throw BOOM;
            return orig(p, ...rest);
        });
        const u = updaterFor(h);
        u.startup();
        assert.ok(said(u, /run marker not written/));
    });

    test("markServed / confirmBoot cannot write state.json", t => {
        const h = armedHome(t);
        const s = h.state();
        s.trial.armed = false;
        fs.writeFileSync(h.stateFile, JSON.stringify(s));
        failRename(t, (from, to) => to === h.stateFile);
        const u = updaterFor(h);
        u.markServed();
        assert.ok(said(u, /boot marker not written/));
        u.confirmBoot();
        assert.ok(said(u, /could not record the good start/));
    });

    test("state.json cannot be read", t => {
        const h = home(t, { state: { format: 1, bad: {} } });
        wrapFs(t, fs, "readFileSync", (orig, p, ...rest) => {
            if (p === h.stateFile) throw BOOM;
            return orig(p, ...rest);
        });
        const u = updaterFor(h);
        assert.deepEqual(u.readState(), { format: 1, bad: {} });
        assert.ok(said(u, /state\.json unreadable, starting over/));
    });
});

describe("builds without a commit, and an install.json that says little", () => {
    const bare = v => makePayload({ version: v, commit: null });

    test("a swap and a rollback of commit-less payloads against a bare install.json", t => {
        const h = home(t, { installed: bare("0.1.0"), staged: bare("0.1.1"), record: false });
        fs.writeFileSync(h.recordFile, JSON.stringify({ installedAt: "2026-01-01T00:00:00Z" }));
        const u = start(h);
        assert.equal(u.result.kind, "swapped");
        const trial = h.state().trial;
        assert.deepEqual([trial.commit, trial.previousCommit, trial.previousRecord], [null, null, { version: null, commit: null, source: null }]);
        assert.deepEqual(h.record().targets, [], "install.json without a targets list gets an empty one");
        assert.equal(h.record().commit, "");
        assert.equal(u.status().installed.commit, null);

        updaterFor(h).markServed();
        assert.equal(h.state().trial.armed, true, "a null commit equals a null commit");
        const back = start(h);
        assert.equal(back.result.kind, "rolledBack");
        assert.equal(h.state().bad["0.1.1"].commit, null);
        assert.equal(h.record().version, "0.1.0");
        assert.equal(h.record().commit, "");
    });

    test("a recorded previous version equal to addon.prev, but with no commit anywhere: the commit is ''", t => {
        const cur = bare("0.1.1");
        const h = home(t, { installed: cur, prev: bare("0.1.0"), state: { format: 1, bad: {}, trial: trialFor(cur, bare("0.1.0"), { armed: true, commit: null, previousRecord: { version: "0.1.0", commit: null, source: null } }) } });
        start(h);
        assert.equal(h.record().commit, "");
        assert.equal("source" in h.record(), false);
    });

    test("a trial whose commit is missing matches an installed build without a commit", t => {
        const cur = bare("0.1.1");
        const trial = trialFor(cur, bare("0.1.0"));
        delete trial.commit;
        const h = home(t, { installed: cur, prev: bare("0.1.0"), state: { format: 1, bad: {}, trial } });
        updaterFor(h).markServed();
        assert.equal(h.state().trial.armed, true);
    });

    test("version.json that is not a manifest (null, a number, no valid version, JSON gone wrong): the install is 'unreadable'", t => {
        for (const text of ["null", "5", '{"version":"nope"}', "{ broken", ""]) {
            const h = home(t);
            fs.writeFileSync(join(h.addonDir, "version.json"), text);
            const u = updaterFor(h);
            assert.equal(u.installed, null, JSON.stringify(text));
            assert.equal(u.startup(), null);
        }
    });
});

/** A run marker of another process (update\run\<pid>). */
const runMarker = (h, pid) => {
    fs.mkdirSync(h.runDir, { recursive: true });
    const file = join(h.runDir, String(pid));
    fs.writeFileSync(file, "{}");
    return file;
};
const NOW = Date.parse("2026-10-31T03:00:00Z");
const V012 = () => makePayload({ version: "0.1.2", commit: "n2" });
const armedOn011 = (t, extra = {}) => {
    const cur = V011();
    return home(t, { installed: cur, prev: V010(), staged: V012(), state: { format: 1, bad: {}, trial: trialFor(cur, V010(), { armed: true }) }, ...extra });
};

describe("run markers: only a Discord program can own one (a crash leaves the marker, Windows reuses the pid)", () => {
    const staged = t => home(t, { staged: V011() });

    test("a live pid that is not a Discord program: the stale marker is dropped and the swap goes ahead", t => {
        const h = staged(t);
        const file = runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        const u = start(h, { processNames: processList({ 4242: "svchost.exe", [process.pid]: "node.exe" }) });
        assert.equal(u.result.kind, "swapped");
        assert.equal(fs.existsSync(file), false);
        assert.ok(u.lines.some(l => /run marker of a Discord that is gone, dropped/.test(l) && l.includes('{"pid":4242,"exe":"svchost.exe"}')), u.lines.join("\n"));
        assert.equal(h.state().waiting, undefined);
    });

    test("...a service that answers EPERM, and a pid that left the list meanwhile: both dropped", t => {
        const h = staged(t);
        const service = runMarker(h, 4343);
        const gone = runMarker(h, 4444);
        fakeKill(t, { eperm: [4343], alive: [4444] });
        const u = start(h, { processNames: processList({ 4343: "MsMpEng.exe" }) });
        assert.equal(u.result.kind, "swapped");
        assert.deepEqual([fs.existsSync(service), fs.existsSync(gone)], [false, false]);
        assert.ok(u.lines.some(l => l.includes('{"pid":4444,"exe":null}')), u.lines.join("\n"));
    });

    test("a real Discord program (every flavor, any letter case) keeps its marker: the swap waits and says which", t => {
        fakeKill(t, { alive: [4242] });
        for (const exe of ["Discord.exe", "DISCORDPTB.EXE", "DiscordCanary.exe", "discorddevelopment.exe"]) {
            const h = staged(t);
            const file = runMarker(h, 4242);
            const u = start(h, { processNames: processList({ 4242: exe }) });
            assert.equal(u.result, null, exe);
            assert.ok(fs.existsSync(file), exe);
            assert.equal(h.versionOf(h.staged), "0.1.1", exe);
            assert.ok(u.lines.some(l => /staged update waits, another Discord is running from this add-on/.test(l) && l.includes(`{"pids":[4242],"exes":["${exe}"]}`)), exe);
            assert.deepEqual({ ...h.state().waiting, at: null }, { version: "0.1.1", reason: "others", detail: { pids: [4242], exes: [exe] }, at: null, starts: 1 }, exe);
        }
    });

    test("a stale marker next to a real Discord: the stale one goes, the swap still waits for the Discord", t => {
        const h = staged(t);
        const discord = runMarker(h, 4242);
        const stale = runMarker(h, 4343);
        fakeKill(t, { alive: [4242, 4343] });
        const u = start(h, { processNames: processList({ 4242: "Discord.exe", 4343: "chrome.exe" }) });
        assert.equal(u.result, null);
        assert.deepEqual([fs.existsSync(discord), fs.existsSync(stale)], [true, false]);
        assert.deepEqual(h.state().waiting.detail, { pids: [4242], exes: ["Discord.exe"] });
    });

    test("the list of programs cannot be read (tasklist failed): the marker counts as another Discord, as before, and it is logged", t => {
        const h = staged(t);
        const file = runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        const u = start(h); // updaterFor's default: no list of programs
        assert.equal(u.result, null);
        assert.ok(fs.existsSync(file));
        assert.ok(u.lines.some(l => /could not list the running programs; the run markers count as other Discords "no process list in the unit tests"/.test(l)), u.lines.join("\n"));
        assert.ok(u.lines.some(l => /staged update waits, another Discord is running/.test(l) && l.includes('{"pids":[4242]}')));
        assert.deepEqual(h.state().waiting.detail, { pids: [4242] }, "no program names when they could not be read");
    });

    test("an answer that is not a list of programs counts as unreadable too", t => {
        const h = staged(t);
        runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        const u = start(h, { processNames: () => ({ 4242: "svchost.exe" }) });
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /could not list the running programs.*"no list of programs"/.test(l)));
    });

    test("the list is read once per start, and only when some marker's pid answers", t => {
        fakeKill(t, { alive: [4242, 4343] });
        let calls = 0;
        const names = () => {
            calls++;
            return new Map([[4242, "Discord.exe"], [4343, "DiscordPTB.exe"]]);
        };
        const h = staged(t);
        runMarker(h, 4242);
        runMarker(h, 4343);
        start(h, { processNames: names });
        assert.equal(calls, 1);
        assert.deepEqual(h.state().waiting.detail, { pids: [4242, 4343], exes: ["Discord.exe", "DiscordPTB.exe"] });
        const h2 = staged(t);
        runMarker(h2, 999999);
        assert.equal(start(h2, { processNames: names }).result.kind, "swapped");
        assert.equal(calls, 1, "a dead pid needs no list");
        start(home(t), { processNames: names });
        assert.equal(calls, 1, "nothing staged and no trial: the markers are not even read");
    });

    test("an armed trial and a real Discord: the rollback waits (the trial is kept) and the staged update says why", t => {
        const h = armedOn011(t);
        runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        const u = start(h, { processNames: processList({ 4242: "DiscordCanary.exe" }) });
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /rollback waits, another Discord is running from this add-on/.test(l) && l.includes('"exes":["DiscordCanary.exe"]')));
        assert.equal(h.state().trial.armed, true);
        assert.equal(h.state().waiting.reason, "others");
        assert.equal(h.versionOf(h.addonDir), "0.1.1");
    });

    test("an armed trial whose marker pid is not a Discord anymore: the rollback goes ahead", t => {
        const h = armedOn011(t);
        const file = runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        assert.equal(start(h, { processNames: processList({ 4242: "explorer.exe" }) }).result.kind, "rolledBack");
        assert.equal(fs.existsSync(file), false);
    });

    test("by default the updater asks tasklist (Windows): the test runner that started this file is no Discord", t => {
        if (process.platform !== "win32") return t.skip("tasklist is Windows only");
        const h = staged(t);
        const file = runMarker(h, process.ppid);
        const lines = [];
        const u = upd.createUpdater({ addonDir: h.addonDir, log: (m, d) => lines.push(`${m} ${JSON.stringify(d)}`) });
        assert.equal(u.startup().kind, "swapped", lines.join("\n"));
        assert.equal(fs.existsSync(file), false);
        assert.ok(lines.some(l => /run marker of a Discord that is gone, dropped/.test(l) && l.includes(`"pid":${process.ppid}`)), lines.join("\n"));
    });
});

describe("why a staged update waits (state.json `waiting`, handed to the plugin by status())", () => {
    const at = { now: () => NOW };

    test("another Discord: reason 'others', and status() gives it with the ready version", t => {
        const h = home(t, { staged: V011() });
        runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        const u = start(h, { ...at, processNames: processList({ 4242: "DiscordPTB.exe" }) });
        const s = u.status();
        assert.deepEqual([s.phase, s.ready], ["ready", "0.1.1"]);
        assert.deepEqual(s.waiting, { reason: "others", detail: { pids: [4242], exes: ["DiscordPTB.exe"] }, at: "2026-10-31T03:00:00.000Z", starts: 1 });
    });

    test("each start in a row that waits for the same version counts; a newer staged version starts over at 1", t => {
        const h = home(t, { staged: V011() });
        runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        const names = processList({ 4242: "Discord.exe" });
        for (let n = 1; n <= 3; n++) {
            start(h, { processNames: names });
            assert.equal(h.state().waiting.starts, n);
        }
        fs.rmSync(h.staged, { recursive: true, force: true });
        writePayload(h.staged, V012());
        const u = start(h, { processNames: names });
        assert.deepEqual([h.state().waiting.version, h.state().waiting.starts], ["0.1.2", 1]);
        assert.equal(u.status().waiting.starts, 1);
    });

    test("a previous record with a counter that makes no sense starts over at 1", t => {
        for (const waiting of ["text", { version: "0.1.1", reason: "others", starts: "many" }, { version: "0.1.1", reason: "others", starts: 0 }]) {
            const h = home(t, { staged: V011(), state: { format: 1, bad: {}, waiting } });
            runMarker(h, 4242);
            const kill = fakeKill(t, { alive: [4242] });
            start(h, { processNames: processList({ 4242: "Discord.exe" }) });
            kill.mock.restore();
            assert.equal(h.state().waiting.starts, 1, JSON.stringify(waiting));
        }
    });

    test("the current version still on trial: reason 'trial'", t => {
        const cur = V011();
        const h = home(t, { installed: cur, staged: V012(), prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010()) } });
        const u = start(h, at);
        assert.deepEqual(u.status().waiting, { reason: "trial", detail: null, at: "2026-10-31T03:00:00.000Z", starts: 1 });
    });

    test("a staged folder whose version.json cannot be read: recorded without a version, so status() shows no reason", t => {
        const cur = V011();
        const h = home(t, { installed: cur, staged: V012(), prev: V010(), state: { format: 1, bad: {}, trial: trialFor(cur, V010()) } });
        fs.writeFileSync(join(h.staged, "version.json"), "{ not json");
        const u = start(h);
        assert.deepEqual([h.state().waiting.version, h.state().waiting.reason], [null, "trial"]);
        assert.equal(u.status().waiting, null);
    });

    test("addon.new cannot be moved in (antivirus): reason 'activate-failed' with the error code", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => "timed-out");
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.staged) throw fsError("EPERM");
            return orig(from, to);
        });
        assert.equal(start(h).result, null);
        assert.deepEqual([h.state().waiting.reason, h.state().waiting.detail], ["activate-failed", { code: "EPERM" }]);
    });

    test("a failure without an error code is recorded with code null", t => {
        const h = home(t, { staged: V011() });
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === h.addonDir) throw "not an Error";
            return orig(from, to);
        });
        start(h);
        assert.deepEqual([h.state().waiting.reason, h.state().waiting.detail], ["in-use", { code: null }]);
    });

    test("swap.lock held by another start: reason 'locked', and now a log line (it used to be silent)", t => {
        const h = home(t, { staged: V011() });
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        const u = start(h);
        assert.equal(u.result, null);
        assert.ok(u.lines.some(l => /swap\.lock is held by another Discord start \(under 2 minutes old\); the add-on folders wait for the next start/.test(l)), u.lines.join("\n"));
        assert.deepEqual([h.state().waiting.reason, h.state().waiting.detail], ["locked", null]);
    });

    test("an old swap.lock that cannot be removed: logged, reason 'locked'", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => "timed-out");
        fs.mkdirSync(h.updateDir, { recursive: true });
        fs.writeFileSync(h.lock, "");
        fs.utimesSync(h.lock, new Date(Date.now() - 5 * 60_000), new Date(Date.now() - 5 * 60_000));
        wrapFs(t, fs, "rmSync", (orig, p, ...rest) => {
            if (p === h.lock) throw fsError("EPERM");
            return orig(p, ...rest);
        });
        const u = start(h);
        assert.ok(u.lines.some(l => /an old swap\.lock could not be removed; the add-on folders wait for the next start/.test(l)), u.lines.join("\n"));
        assert.equal(h.state().waiting.reason, "locked");
    });

    test("a staged copy that does not verify and cannot even be deleted: reason 'unknown'", t => {
        const h = home(t, { staged: V011() });
        t.mock.method(Atomics, "wait", () => "timed-out");
        fs.writeFileSync(join(h.staged, "main.js"), "tampered");
        wrapFs(t, fs, "rmSync", (orig, p, ...rest) => {
            if (p === h.staged) throw fsError("EPERM");
            return orig(p, ...rest);
        });
        start(h);
        assert.deepEqual([h.state().waiting.reason, h.state().waiting.detail], ["unknown", null]);
    });

    test("the swap goes through, the staged copy is discarded, or addon.new is gone: an old reason is cleared", t => {
        const old = { version: "0.1.1", reason: "others", detail: { pids: [1] }, at: "x", starts: 2 };
        const swapped = home(t, { staged: V011(), state: { format: 1, bad: {}, waiting: old } });
        assert.equal(start(swapped).result.kind, "swapped");
        assert.equal(swapped.state().waiting, undefined);

        const tampered = home(t, { staged: V011(), state: { format: 1, bad: {}, waiting: old } });
        fs.writeFileSync(join(tampered.staged, "main.js"), "tampered");
        start(tampered);
        assert.equal(tampered.state().waiting, undefined);

        const gone = home(t, { state: { format: 1, bad: {}, waiting: old } });
        assert.equal(start(gone).result, null);
        assert.deepEqual(gone.state(), { format: 1, bad: {} });
    });

    test("a rollback blocked by swap.lock, by addon\\ in use or by addon.prev that will not move: each reason recorded", t => {
        const locked = armedOn011(t);
        fs.mkdirSync(locked.updateDir, { recursive: true });
        fs.writeFileSync(locked.lock, "");
        start(locked);
        assert.equal(locked.state().waiting.reason, "locked");

        t.mock.method(Atomics, "wait", () => "timed-out");
        const inUse = armedOn011(t);
        const prevStuck = armedOn011(t);
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (from === inUse.addonDir) throw fsError("EBUSY");
            if (from === prevStuck.prev) throw fsError("EACCES");
            return orig(from, to);
        });
        start(inUse);
        assert.deepEqual([inUse.state().waiting.reason, inUse.state().waiting.detail], ["in-use", { code: "EBUSY" }]);
        start(prevStuck);
        assert.deepEqual([prevStuck.state().waiting.reason, prevStuck.state().waiting.detail], ["activate-failed", { code: "EACCES" }]);
        assert.equal(prevStuck.state().trial.armed, true, "the rollback rule is unchanged: still pending");
    });

    test("no usable addon.prev: the trial is dropped and the staged update waits one start (reason 'trial')", t => {
        const h = armedOn011(t, { prev: null });
        start(h);
        assert.equal(h.state().trial, undefined);
        assert.equal(h.state().waiting.reason, "trial");
    });

    test("a rollback that goes through clears an old reason (the staged update is tried again at the next start)", t => {
        const h = armedOn011(t);
        const s = h.state();
        fs.writeFileSync(h.stateFile, JSON.stringify({ ...s, waiting: { version: "0.1.2", reason: "others", starts: 1 } }));
        assert.equal(start(h).result.kind, "rolledBack");
        assert.equal(h.state().waiting, undefined);
    });

    test("an armed trial waiting on another Discord with nothing staged records no reason", t => {
        const h = armedOn011(t, { staged: null });
        runMarker(h, 4242);
        fakeKill(t, { alive: [4242] });
        start(h, { processNames: processList({ 4242: "Discord.exe" }) });
        assert.equal(h.state().waiting, undefined);
    });

    test("status(): only the reason of the version ready now, only when well formed; missing fields filled in", t => {
        const cases = [
            [{ version: "0.1.0", reason: "others" }, null],
            ["text", null],
            [{ version: "0.1.1" }, null],
            [{ version: "0.1.1", reason: "in-use" }, { reason: "in-use", detail: null, at: null, starts: 1 }],
            [{ version: "0.1.1", reason: "in-use", starts: 0 }, { reason: "in-use", detail: null, at: null, starts: 1 }],
            [{ version: "0.1.1", reason: "in-use", starts: 4, at: "a", detail: { code: "EBUSY" } }, { reason: "in-use", detail: { code: "EBUSY" }, at: "a", starts: 4 }]
        ];
        for (const [waiting, expected] of cases) {
            const h = home(t, { staged: V011(), state: { format: 1, bad: {}, waiting } });
            assert.deepEqual(updaterFor(h).status().waiting, expected, JSON.stringify(waiting));
        }
        const nothingStaged = home(t, { state: { format: 1, bad: {}, waiting: { version: "0.1.1", reason: "in-use" } } });
        assert.equal(updaterFor(nothingStaged).status().waiting, null);
    });
});

describe("recentLog(): the last update lines of main.log for 'Copiar diagnóstico'", () => {
    const line = (n, msg) => `2026-10-31T03:00:${String(n).padStart(2, "0")}.000Z [1234] ${msg}`;
    const withLogs = (t, files) => {
        const h = home(t);
        const dir = join(h.home, "logs");
        fs.mkdirSync(dir, { recursive: true });
        for (const [name, lines] of Object.entries(files)) fs.writeFileSync(join(dir, name), lines.join("\n") + "\n");
        return updaterFor(h, { logFile: join(dir, "main.log") });
    };

    test("without a log file (or none on disk): []", t => {
        assert.deepEqual(updaterFor(home(t)).recentLog(), []);
        assert.deepEqual(updaterFor(home(t), { logFile: join(os.tmpdir(), "tl-no-such-dir", "main.log") }).recentLog(), []);
    });

    test("the last 10 'update' lines, oldest first; ERROR update lines kept; every other line skipped", t => {
        const lines = [line(0, "boot {}")];
        for (let i = 1; i <= 12; i++) lines.push(line(i, `update: step ${i}`));
        lines.push(line(13, "ERROR update startup: Error: boom"), "    at stack (frame)", line(14, "loaded {}"), line(15, "renderer served {}"));
        const u = withLogs(t, { "main.log": lines });
        assert.deepEqual(u.recentLog(), [...[4, 5, 6, 7, 8, 9, 10, 11, 12].map(i => line(i, `update: step ${i}`)), line(13, "ERROR update startup: Error: boom")]);
        assert.deepEqual(u.recentLog(2), [line(12, "update: step 12"), line(13, "ERROR update startup: Error: boom")]);
    });

    test("main.log with too few: topped up from main.log.1 (older), never more than asked; main.log.1 alone works too", t => {
        const u = withLogs(t, { "main.log.1": [1, 2, 3, 4, 5].map(i => line(i, `update: old ${i}`)), "main.log": [6, 7, 8].map(i => line(i, `update: new ${i}`)) });
        assert.deepEqual(u.recentLog(5), [line(4, "update: old 4"), line(5, "update: old 5"), line(6, "update: new 6"), line(7, "update: new 7"), line(8, "update: new 8")]);
        assert.equal(u.recentLog().length, 8);
        const only = withLogs(t, { "main.log.1": [line(1, "update: rotated")] });
        assert.deepEqual(only.recentLog(), [line(1, "update: rotated")]);
    });

    test("the user's folder shows as ~ (plain and as JSON), IPv4 addresses as x.x.x.x, long lines are cut", t => {
        t.mock.method(os, "homedir", () => "C:\\Users\\Joao");
        const u = withLogs(t, {
            "main.log": [
                line(1, "update: the add-on folder is in use; the update waits for the next start \"EPERM: operation not permitted, rename 'C:\\Users\\Joao\\AppData\\Roaming\\Telinha\\addon'\""),
                line(2, 'update: install.json not updated "C:\\\\Users\\\\Joao\\\\AppData\\\\Roaming\\\\Telinha\\\\install.json"'),
                line(3, "update: check failed (offline) \"connect ECONNREFUSED 192.168.0.10:8080\" 0.2.7"),
                line(4, `update: ${"x".repeat(1000)}`)
            ]
        });
        const [a, b, c, d] = u.recentLog();
        assert.ok(a.includes("rename '~\\AppData\\Roaming\\Telinha\\addon'") && !a.includes("Joao"), a);
        assert.ok(b.includes('"~\\\\AppData\\\\Roaming\\\\Telinha\\\\install.json"') && !b.includes("Joao"), b);
        assert.ok(c.includes("ECONNREFUSED x.x.x.x:8080") && c.endsWith("0.2.7"), c);
        assert.equal(d.length, 401);
        assert.ok(d.endsWith("…"));
    });

    test("no known home folder (os.homedir fails): the lines stay as they are", t => {
        t.mock.method(os, "homedir", () => {
            throw new Error("no home");
        });
        const u = withLogs(t, { "main.log": [line(1, "update: C:\\Users\\Joao\\x")] });
        assert.deepEqual(u.recentLog(), [line(1, "update: C:\\Users\\Joao\\x")]);
    });
});

describe("createUpdater(): the shape of what it returns", () => {
    test("paths are all under the Telinha home next to addon\\; the user agent names the installed version", t => {
        const h = home(t, { installed: makePayload({ version: "0.7.1" }) });
        const u = updaterFor(h);
        assert.equal(u.paths.home, join(h.root, "Telinha"));
        assert.deepEqual([u.paths.staged, u.paths.prev, u.paths.old, u.paths.lock, u.paths.record].map(p => relative(u.paths.home, p)),
            ["addon.new", "addon.prev", "addon.old", join("update", "swap.lock"), "install.json"]);
        assert.equal(u.installed.version, "0.7.1");
        assert.equal(u.status().installed.version, "0.7.1");
    });
});
