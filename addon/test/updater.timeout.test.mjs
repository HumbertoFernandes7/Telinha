/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Regression tests for the download time limits of addon/loader/updater.js (30 s for GitHub's API and the small asset
 * files, 10 minutes for the zip): a response whose body stalls AFTER the headers arrived must be aborted when that time is up.
 *
 *   node --test addon/test/updater.timeout.test.mjs        (also run by `pnpm test:addon`)
 *
 * The limits used to cover only the wait for the response headers (the timer was cleared as soon as fetch() resolved), so a
 * connection that went quiet in the middle of the body hung the check forever: check() keeps handing out the same pending
 * promise, so no further update check ran until Discord was restarted, and the settings page stayed on "baixando...".
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fakeGitHub, makeHome, makePayload, payloadZip, reply, updaterFor } from "./fake/update-kit.mjs";

const NEW = makePayload({ version: "0.1.1", commit: "new00101" });
const NEW_ZIP = payloadZip(NEW);

/** A response with good headers whose body never delivers anything until the request's signal aborts. */
const stalled = signal => ({
    status: 200, ok: true, headers: { get: () => null },
    body: {
        getReader: () => ({
            read: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })))),
            cancel: async () => { }
        })
    }
});

const turns = async (n = 10) => {
    for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
};
/** Resolves to the promise's value, or to "HUNG" if it is still pending after a few turns of the event loop. */
const settled = async p => {
    let done = false;
    let value;
    p.then(v => { done = true; value = v; });
    await turns();
    return done ? value : "HUNG";
};

function setup(t) {
    const h = makeHome({ installed: makePayload({ version: "0.1.0", commit: "base0100" }) });
    t.after(() => h.cleanup());
    const gh = fakeGitHub();
    return { h, gh, u: updaterFor(h, { fetch: gh.fetch }) };
}

describe("time limits cover the body, not just the headers", () => {
    test("GitHub's release JSON stalling mid-body is aborted after 30 s: a quiet 'offline' report, and the next check can run", async t => {
        const { gh, u } = setup(t);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        gh.hooks.before = (url, init) => (/releases\/latest$/.test(url) ? stalled(init.signal) : undefined);
        const pending = u.check({});
        await turns();
        t.mock.timers.tick(29_999);
        assert.equal(await settled(pending), "HUNG", "not before the time is up");
        t.mock.timers.tick(1);
        const s = await settled(pending);
        assert.notEqual(s, "HUNG", "the stalled check must end");
        assert.deepEqual({ phase: s.phase, kind: s.error.kind, quiet: s.error.quiet }, { phase: "error", kind: "offline", quiet: true });
        assert.match(s.error.message, /download foi interrompido/);

        gh.hooks.before = null;
        gh.publish("v0.1.0", payloadZip(makePayload({ version: "0.1.0", commit: "base0100" })));
        const next = await settled(u.check({}));
        assert.equal(next.phase, "up-to-date", "a later check is not stuck behind the stalled one");
    });

    test("the zip stalling mid-body gets 10 minutes, then is aborted: nothing staged", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        gh.hooks.before = (url, init) => (/\.zip$/.test(url) ? stalled(init.signal) : undefined);
        const pending = u.check({ autoDownload: true });
        await turns();
        t.mock.timers.tick(30_000);
        assert.equal(await settled(pending), "HUNG", "the zip is not held to the 30 s limit of the small requests");
        t.mock.timers.tick(10 * 60_000 - 30_000 - 1);
        assert.equal(await settled(pending), "HUNG");
        t.mock.timers.tick(1);
        const s = await settled(pending);
        assert.notEqual(s, "HUNG", "the stalled download must end at the 10 minute limit");
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "offline", quiet: true });
        assert.equal(h.versionOf(h.staged), null);
        assert.deepEqual(h.names(h.updateDir).filter(n => n.startsWith("staging-")), []);
    });

    test("every time limit is cleared when its request is over (success or not): none is left to keep a process alive", async t => {
        const timers = new Set();
        const realSet = globalThis.setTimeout;
        const realClear = globalThis.clearTimeout;
        t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => {
            const id = realSet(fn, ms, ...rest);
            if (ms === 30_000 || ms === 600_000) timers.add(id);
            return id;
        });
        t.mock.method(globalThis, "clearTimeout", id => {
            timers.delete(id);
            return realClear(id);
        });
        for (const mode of ["ok", "no-release", "500", "offline", "rate-limit"]) {
            const { gh, u } = setup(t);
            gh.publish("v0.1.1", NEW_ZIP);
            gh.mode = mode;
            await u.check({ autoDownload: true });
            assert.equal(timers.size, 0, `timers left after mode ${mode}`);
        }
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { sumFile: "no hash in here\n" });
        await u.check({ autoDownload: true });
        assert.equal(timers.size, 0, "timers left after a refused .sha256");
        gh.hooks.before = () => reply(200, Buffer.alloc(5 * 1024 * 1024, 0x20), { chunk: 1024 * 1024 });
        await u.check({});
        assert.equal(timers.size, 0, "timers left after an oversized body");
    });
});
