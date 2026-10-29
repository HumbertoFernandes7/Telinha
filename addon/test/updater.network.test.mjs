/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of the asynchronous half of addon/loader/updater.js: check() / download() against a fake GitHub (an in-memory
 * `fetch`, so nothing opens a socket): the release API, the asset downloads, every published SHA-256 source, the
 * rate limit, offline and timeout handling, a corrupt or hostile zip, and the way a download is staged on disk.
 *
 *   node --test addon/test/updater.network.test.mjs        (also run by `pnpm test:addon`)
 *
 * The contract under test (PAYLOAD.md section 8): nothing is installed unless the zip matches a SHA-256 GitHub published
 * AND passes the zip / manifest checks; a failure leaves addon\ and addon.new\ exactly as they were; network trouble is
 * "quiet" (retried at the next check, never shown to the user).
 *
 * What needs the real thing: Electron's net.fetch (proxy, redirects to GitHub's asset CDN) and GitHub's real responses
 * (run-update-test.mjs covers the redirect and ETag behaviour against a local HTTP server).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { deflateRawSync } from "node:zlib";

import { API, DOWNLOAD, fakeFetch, fakeGitHub, fsError, makeHome, makePayload, payloadZip, reply, REPO, sha256, updaterFor, upd, wrapFs } from "./fake/update-kit.mjs";

const V010 = () => makePayload({ version: "0.1.0", commit: "base0100" });
const NEW = makePayload({ version: "0.1.1", commit: "new00101" });
const NEW_ZIP = payloadZip(NEW);
const NAME = "Telinha-addon-v011.zip";

/** A home with 0.1.0 installed, a fake GitHub (nothing published yet) and an updater over both. */
function setup(t, { installed = V010(), staged, state, record, now, userAgent } = {}) {
    const h = makeHome({ installed, staged, state, record });
    t.after(() => h.cleanup());
    const gh = fakeGitHub();
    const u = updaterFor(h, { fetch: gh.fetch, now, userAgent });
    return { h, gh, u };
}

const leftovers = h => h.names(h.updateDir).filter(n => n.startsWith("staging-"));
/** Every file under `dir` whose name matches `re` (to prove nothing was extracted outside the staging folder). */
const findFiles = (dir, re) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? findFiles(join(dir, e.name), re) : re.test(e.name) ? [join(dir, e.name)] : []));
/** Nothing staged, nothing left behind, nothing extracted anywhere else. */
const untouched = h => {
    assert.equal(fs.existsSync(h.staged), false, "addon.new must not exist");
    assert.deepEqual(leftovers(h), [], "no staging leftovers");
    assert.equal(h.versionOf(h.addonDir), "0.1.0", "addon\\ untouched");
    assert.deepEqual(findFiles(h.root, /evil/), [], "nothing extracted outside");
};

describe("a newer release, the whole way (check with automatic download)", () => {
    test("asks releases/latest, downloads the zip and its .sha256, verifies, stages in addon.new, remembers it", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ phase: s.phase, ready: s.ready, latest: s.latest, error: s.error }, { phase: "ready", ready: "0.1.1", latest: { version: "0.1.1", tag: "v0.1.1" }, error: null });
        assert.deepEqual(s.installed, { version: "0.1.0", commit: "base0100" });
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.doesNotThrow(() => upd.verifyDir(h.staged));
        assert.equal(h.versionOf(h.addonDir), "0.1.0", "the live add-on is never touched by a download");
        assert.deepEqual(leftovers(h), []);
        const st = h.state();
        assert.deepEqual({ version: st.staged.version, commit: st.staged.commit, tag: st.staged.tag, asset: st.staged.asset, sha256: st.staged.sha256 }, { version: "0.1.1", commit: "new00101", tag: "v0.1.1", asset: NAME, sha256: sha256(NEW_ZIP) });
        assert.ok(st.lastCheck.etag);
        assert.equal(gh.fetch.calls[0].url, `${API}/repos/${REPO}/releases/latest`);
        assert.ok(u.lines.some(l => /update: staged, applied at the next Discord start/.test(l) && /GitHub \(digest do asset\)/.test(l) && new RegExp(`${NAME}\\.sha256`).test(l)));
    });

    test("requests carry the User-Agent with the installed version, the right Accept and no cache", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        await u.check({ autoDownload: true });
        const [api, sum, zip] = gh.fetch.calls;
        for (const c of gh.fetch.calls) {
            assert.equal(c.init.headers["User-Agent"], `Telinha-addon/0.1.0 (+https://github.com/${REPO})`);
            assert.equal(c.init.redirect, "follow");
            assert.equal(c.init.cache, "no-store");
            assert.ok(c.init.signal);
        }
        assert.equal(api.init.headers.Accept, "application/vnd.github+json");
        assert.equal(sum.init.headers.Accept, "application/octet-stream");
        assert.match(zip.url, /\.zip$/);
    });

    test("a second check sends If-None-Match: GitHub answers 304, nothing is downloaded again, the staged copy is 'ready'", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        await u.check({ autoDownload: true });
        const first = gh.fetch.calls.length;
        const s = await u.check({ autoDownload: true });
        assert.equal(s.phase, "ready");
        assert.equal(gh.fetch.calls.length, first + 1, "only the API call");
        assert.ok(gh.fetch.calls.at(-1).init.headers["If-None-Match"]);
    });

    test("a 304 after a restart (etag and release kept in state.json) also works", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        await u.check({ autoDownload: true });
        const u2 = updaterFor(h, { fetch: gh.fetch });
        const s = await u2.check({ autoDownload: true });
        assert.equal(s.phase, "ready");
        assert.equal(h.state().lastCheck.release.tag_name, "v0.1.1");
    });

    test("a 304 when we had nothing cached (a server that ignores us) is an error, not a crash", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(304, "");
        const s = await u.check({ autoDownload: true });
        assert.equal(s.phase, "error");
        assert.equal(s.error.kind, "http");
        assert.equal(s.error.quiet, true);
    });

    test("a newer staged copy replaces an older one still waiting in addon.new", async t => {
        const { h, gh, u } = setup(t, { staged: makePayload({ version: "0.0.9", commit: "x" }) });
        gh.publish("v0.1.1", NEW_ZIP);
        const s = await u.check({ autoDownload: true });
        assert.equal(s.phase, "ready");
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.deepEqual(leftovers(h), []);
    });

    test("a payload without a commit (older build scripts) stages fine; its commit is remembered as null", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", payloadZip(makePayload({ version: "0.1.1", commit: null })));
        assert.equal((await u.check({ autoDownload: true })).phase, "ready");
        assert.equal(h.state().staged.commit, null);
    });

    test("the release tag may carry a build suffix and a leading v; the zip's own version.json must agree", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1+build.7", NEW_ZIP);
        const s = await u.check({ autoDownload: true });
        assert.equal(s.phase, "ready");
        assert.deepEqual(s.latest, { version: "0.1.1", tag: "v0.1.1+build.7" });
    });

    test("a release body longer than 64 KB, more than 50 assets and odd asset fields are slimmed down in state.json", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const base = gh.release;
        gh.release = {
            ...base, body: `${"x".repeat(70_000)}`,
            assets: [...base.assets, ...Array.from({ length: 60 }, (_, i) => ({ name: `extra-${i}.txt`, size: "NaN", digest: 5, browser_download_url: null }))]
        };
        await u.check({ autoDownload: false });
        const rel = h.state().lastCheck.release;
        assert.equal(rel.body.length, 64 * 1024);
        assert.equal(rel.assets.length, 50);
        const odd = rel.assets.find(a => a.name === "extra-0.txt");
        assert.deepEqual(odd, { name: "extra-0.txt", size: 0, digest: "", browser_download_url: "" });
        assert.equal("author" in rel, false);
    });
});

describe("check without automatic download, up to date, skipped, already staged", () => {
    test("'Atualizar automaticamente' off: reports 'available', downloads nothing; download() then stages it", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const s = await u.check({ autoDownload: false });
        assert.equal(s.phase, "available");
        assert.equal(gh.fetch.count(/\.zip/), 0);
        assert.ok(u.lines.some(l => /new version available \(automatic updates are off\)/.test(l)));
        const d = await u.download();
        assert.equal(d.phase, "ready");
        assert.equal(h.versionOf(h.staged), "0.1.1");
    });

    test("same or older release: up to date, nothing downloaded or staged", async t => {
        for (const tag of ["v0.1.0", "v0.0.9"]) {
            const { h, gh, u } = setup(t);
            gh.publish(tag, payloadZip(makePayload({ version: tag.slice(1), commit: "c" })));
            const s = await u.check({ autoDownload: true });
            assert.equal(s.phase, "up-to-date", tag);
            assert.equal(gh.fetch.count(/\.zip/), 0);
            untouched(h);
        }
    });

    test("a draft or pre-release (releases/latest never returns one, but be safe): no candidate, up to date", async t => {
        for (const opt of [{ prerelease: true }, { draft: true }]) {
            const { gh, u } = setup(t);
            gh.publish("v0.1.1", NEW_ZIP, opt);
            const s = await u.check({ autoDownload: true });
            assert.equal(s.phase, "up-to-date");
            assert.equal(s.latest, null);
            assert.equal(gh.fetch.count(/\.zip/), 0);
        }
    });

    test("a version that already failed to start is skipped (no download loop) and reported as skipped", async t => {
        const { h, gh, u } = setup(t, { state: { format: 1, bad: { "0.1.1": { at: "x", reason: "failed" } } } });
        gh.publish("v0.1.1", NEW_ZIP);
        const s = await u.check({ autoDownload: true });
        assert.equal(s.phase, "up-to-date");
        assert.equal(s.skipped, "0.1.1");
        assert.equal(gh.fetch.count(/\.zip/), 0);
        untouched(h);
        assert.ok(u.lines.some(l => /latest version skipped, it failed to start before/.test(l)));
        gh.publish("v0.1.2", payloadZip(makePayload({ version: "0.1.2", commit: "n2" })));
        const next = await u.check({ autoDownload: false });
        assert.equal(next.skipped, null, "the next release is not skipped");
    });

    test("the staged copy is already the latest: phase 'ready' with no download", async t => {
        const { gh, u } = setup(t, { staged: NEW });
        gh.publish("v0.1.1", NEW_ZIP);
        const s = await u.check({ autoDownload: true });
        assert.equal(s.phase, "ready");
        assert.equal(gh.fetch.count(/\.zip/), 0);
    });

    test("status() reports a staged newer copy as ready even before any check (settings page after a restart)", t => {
        const { u } = setup(t, { staged: NEW });
        const s = u.status();
        assert.deepEqual({ supported: s.supported, phase: s.phase, ready: s.ready, error: s.error }, { supported: true, phase: "ready", ready: "0.1.1", error: null });
    });

    test("status() does not call a staged older, bad or unreadable copy ready", t => {
        assert.equal(setup(t, { staged: makePayload({ version: "0.0.9", commit: "o" }) }).u.status().ready, null);
        assert.equal(setup(t, { staged: NEW, state: { format: 1, bad: { "0.1.1": {} } } }).u.status().ready, null);
        const broken = setup(t, { staged: NEW });
        fs.writeFileSync(join(broken.h.staged, "version.json"), "{ nope");
        assert.equal(broken.u.status().ready, null);
    });

    test("status() surfaces the last rollback", t => {
        const { u } = setup(t, { state: { format: 1, bad: {}, lastRollback: { version: "0.1.1", to: "0.1.0", at: "x", reason: "r" } } });
        assert.equal(u.status().lastRollback.version, "0.1.1");
    });
});

describe("what a failing GitHub looks like (all quiet: retried at the next check)", () => {
    test("no release published yet (404)", async t => {
        const { gh, u } = setup(t);
        gh.mode = "no-release";
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ phase: s.phase, kind: s.error.kind, quiet: s.error.quiet }, { phase: "error", kind: "no-release", quiet: true });
    });

    test("offline: the fetch rejects", async t => {
        const { h, gh, u } = setup(t);
        gh.mode = "offline";
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "offline", quiet: true });
        assert.ok(u.lines.some(l => /check failed \(offline, will retry at the next check\)/.test(l) && /fetch failed/.test(l)));
        untouched(h);
    });

    test("no fetch in this process at all", async t => {
        const h = makeHome({ installed: V010() });
        t.after(() => h.cleanup());
        const u = updaterFor(h, { fetch: null });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "offline", quiet: true });
        assert.match(s.error.message, /sem acesso à rede/);
    });

    test("HTTP 500 / 502 / 503", async t => {
        for (const status of [500, 502, 503, 410]) {
            const { gh, u } = setup(t);
            gh.hooks.before = () => reply(status, "x");
            const s = await u.check({ autoDownload: true });
            assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "http", quiet: true }, String(status));
            assert.match(s.error.message, new RegExp(`HTTP ${status}`));
        }
    });

    test("a 403 that is not a rate limit (remaining > 0, no Retry-After) is a plain http error", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(403, "{}", { headers: { "x-ratelimit-remaining": "42" } });
        const s = await u.check({ autoDownload: true });
        assert.equal(s.error.kind, "http");
        assert.equal(u.status().error.kind, "http");
    });

    test("the timeout: a request that never answers is aborted after 30 s", async t => {
        const { gh, u } = setup(t);
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let aborted = false;
        gh.hooks.before = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        }));
        const pending = u.check({ autoDownload: true });
        t.mock.timers.tick(29_999);
        assert.equal(aborted, false);
        t.mock.timers.tick(1);
        const s = await pending;
        assert.equal(aborted, true);
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "offline", quiet: true });
    });

    test("the zip download gets 10 minutes, the small requests 30 seconds", async t => {
        const { gh, u } = setup(t);
        const delays = [];
        const real = globalThis.setTimeout;
        t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => {
            delays.push(ms);
            return real(fn, ms, ...rest);
        });
        gh.publish("v0.1.1", NEW_ZIP);
        await u.check({ autoDownload: true });
        assert.deepEqual(delays, [30_000, 30_000, 600_000]);
    });
});

describe("rate limit (GitHub asks us to wait)", () => {
    const limited = (gh, headers, status = 403) => { gh.hooks.before = () => reply(status, "{}", { headers }); };

    test("403 with x-ratelimit-remaining 0: quiet error, waits until GitHub's reset; automatic checks stay silent until then", async t => {
        let clock = Date.parse("2026-10-29T12:00:00Z");
        const { gh, u } = setup(t, { now: () => clock });
        const resetAt = Math.floor(clock / 1000) + 1800;
        limited(gh, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "rate-limit", quiet: true });
        const calls = gh.fetch.calls.length;
        const again = await u.check({ autoDownload: true });
        assert.equal(gh.fetch.calls.length, calls, "no request during the limit");
        assert.equal(again.phase, "error", "the previous outcome is still what the page shows");
        clock = (resetAt + 1) * 1000;
        gh.hooks.before = null;
        gh.publish("v0.1.1", NEW_ZIP);
        const after = await u.check({ autoDownload: true });
        assert.equal(after.phase, "ready");
    });

    test("a manual check goes out during the limit", async t => {
        const { gh, u } = setup(t);
        limited(gh, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) });
        await u.check({ autoDownload: true });
        gh.hooks.before = null;
        gh.publish("v0.1.1", NEW_ZIP);
        const s = await u.check({ autoDownload: true, manual: true });
        assert.equal(s.phase, "ready");
    });

    test("download() is manual too: it is not held back by the limit", async t => {
        const { gh, u } = setup(t);
        limited(gh, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) });
        await u.check({});
        gh.hooks.before = null;
        gh.publish("v0.1.1", NEW_ZIP);
        assert.equal((await u.download()).phase, "ready");
    });

    test("429 with Retry-After and no reset header: waits that many seconds", async t => {
        let clock = 1_000_000_000_000;
        const { gh, u } = setup(t, { now: () => clock });
        limited(gh, { "retry-after": "120" }, 429);
        await u.check({});
        const calls = gh.fetch.calls.length;
        clock += 119_000;
        await u.check({});
        assert.equal(gh.fetch.calls.length, calls);
        clock += 2_000;
        await u.check({});
        assert.equal(gh.fetch.calls.length, calls + 1);
    });

    test("403 with only Retry-After counts as a rate limit; a reset time already past falls back to Retry-After", async t => {
        let clock = 1_000_000_000_000;
        const { gh, u } = setup(t, { now: () => clock });
        limited(gh, { "retry-after": "60", "x-ratelimit-reset": String(Math.floor(clock / 1000) - 100) });
        const s = await u.check({});
        assert.equal(s.error.kind, "rate-limit");
        const calls = gh.fetch.calls.length;
        clock += 59_000;
        await u.check({});
        assert.equal(gh.fetch.calls.length, calls);
        clock += 2_000;
        await u.check({});
        assert.equal(gh.fetch.calls.length, calls + 1);
    });

    test("429 with no hint at all: an hour", async t => {
        let clock = 1_000_000_000_000;
        const { gh, u } = setup(t, { now: () => clock });
        limited(gh, {}, 429);
        await u.check({});
        const calls = gh.fetch.calls.length;
        clock += 59 * 60_000;
        await u.check({});
        assert.equal(gh.fetch.calls.length, calls);
        clock += 2 * 60_000;
        await u.check({});
        assert.equal(gh.fetch.calls.length, calls + 1);
    });

    test("rate-limited while downloading the zip itself: the same quiet error, nothing staged", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        gh.hooks.before = url => (/\.zip$/.test(url) ? reply(429, "", { headers: { "retry-after": "10" } }) : undefined);
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "rate-limit", quiet: true });
        untouched(h);
    });
});

describe("response bodies: size limits and broken connections", () => {
    test("Content-Length over the limit is refused before reading (a release JSON of 5 MB)", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(200, "{}", { headers: { "content-length": String(5 * 1024 * 1024) } });
        const s = await u.check({});
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "invalid", quiet: false });
        assert.match(s.error.message, /grande demais/);
    });

    test("a body that outgrows the limit while streaming (no Content-Length) is cut off and refused", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(200, Buffer.alloc(5 * 1024 * 1024, 0x20), { chunk: 1024 * 1024 });
        const s = await u.check({});
        assert.equal(s.error.kind, "invalid");
        assert.ok(u.lines.some(l => /more than 4194304 bytes/.test(l)));
    });

    test("...even when cancelling the stream fails", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(200, Buffer.alloc(5 * 1024 * 1024, 0x20), { chunk: 1024 * 1024, cancelFails: true });
        assert.equal((await u.check({})).error.kind, "invalid");
    });

    test("a runtime fetch without a streaming body (arrayBuffer only) works, and is limited the same way", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const real = gh.fetch;
        void real;
        gh.hooks.before = async url => {
            if (/releases\/latest$/.test(url)) return reply(200, JSON.stringify(gh.release), { noStream: true });
            return undefined;
        };
        assert.equal((await u.check({ autoDownload: false })).phase, "available");
        gh.hooks.before = () => reply(200, Buffer.alloc(5 * 1024 * 1024, 0x20), { noStream: true });
        assert.equal((await u.check({})).error.kind, "invalid");
    });

    test("the connection breaking mid-body is a quiet 'offline' (download interrupted)", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(200, "x".repeat(100), { chunk: 10, failRead: 3 });
        const s = await u.check({});
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "offline", quiet: true });
        assert.match(s.error.message, /download foi interrompido/);
    });

    test("a release JSON that is not JSON: a quiet 'http' error ('resposta inválida')", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(200, "<html>captive portal</html>");
        const s = await u.check({});
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "http", quiet: true });
        assert.match(s.error.message, /resposta inválida/);
    });

    test("a Content-Length that is not a number is ignored", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        gh.hooks.before = url => (/releases\/latest$/.test(url) ? reply(200, JSON.stringify(gh.release), { headers: { "content-length": "unknown" } }) : undefined);
        assert.equal((await u.check({})).phase, "available");
    });
});

describe("a release that cannot be used", () => {
    test("a release JSON that is `null`: it has no version number", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => reply(200, "null");
        const s = await u.check({});
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "invalid", quiet: true });
        assert.match(s.error.message, /a release \? não tem um número de versão/);
    });

    test("a tag that is not a version", async t => {
        const { gh, u } = setup(t);
        gh.publish("nightly", NEW_ZIP);
        const s = await u.check({});
        assert.equal(s.error.kind, "invalid");
        assert.match(s.error.message, /a release nightly não tem um número de versão/);
    });

    test("no Telinha-addon-*.zip among the assets", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { assets: [{ name: "TelinhaInstaller.exe", size: 1, digest: null, browser_download_url: `${DOWNLOAD}/v0.1.1/TelinhaInstaller.exe` }] });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "no-asset", quiet: true });
        assert.match(s.error.message, /versão 0\.1\.1 ainda não tem o pacote/);
    });

    test("a release object whose assets are not a list", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { assets: "nope" });
        assert.equal((await u.check({})).error.kind, "no-asset");
    });

    test("an asset URL outside the Telinha repository's release downloads is refused before any request to it", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        gh.release.assets[1].browser_download_url = "https://evil.example/Telinha-addon-v011.zip";
        gh.release.assets[2].browser_download_url = "https://github.com/someone/else/releases/download/v0.1.1/x.sha256";
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "invalid", quiet: false });
        assert.match(s.error.message, /fora do GitHub do Telinha/);
        assert.equal(gh.fetch.calls.some(c => /evil\.example/.test(c.url)), false);
        untouched(h);
    });

    test("the repository prefix is compared case-insensitively (GitHub URLs are)", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const lower = a => ({ ...a, browser_download_url: a.browser_download_url.replace(REPO, REPO.toLowerCase()) });
        gh.release.assets = gh.release.assets.map(lower);
        gh.hooks.before = url => (/\/releases\/download\//i.test(url) ? reply(200, gh.files.get(decodeURIComponent(url.split("/").pop()))) : undefined);
        assert.equal((await u.check({ autoDownload: true })).phase, "ready");
    });

    test("an HTTP error on an asset download is reported as such", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        gh.hooks.before = url => (/\.zip$/.test(url) ? reply(502, "bad gateway") : undefined);
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "http", quiet: true });
        untouched(h);
    });
});

describe("SHA-256: every published source must agree, and at least one must exist", () => {
    test("no hash published anywhere: refused, not quiet, nothing downloaded", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { digest: null, sumFile: null });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "checksum", quiet: false });
        assert.match(s.error.message, /não publicou SHA-256; nada foi instalado/);
        assert.equal(gh.fetch.count(/\.zip$/), 0, "the zip is not even downloaded");
        untouched(h);
    });

    test("each source alone is enough: digest, .sha256 file, release notes, a hash-carrying version.json", async t => {
        const cases = [
            ["asset digest", { sumFile: null }],
            [".sha256 file", { digest: null }],
            ["release notes", { digest: null, sumFile: null, body: `SHA-256 (${NAME}) = ${sha256(NEW_ZIP)}` }],
            ["version.json with a hash", { digest: null, sumFile: null, versionJson: JSON.stringify({ file: NAME, sha256: sha256(NEW_ZIP) }) }]
        ];
        for (const [label, opts] of cases) {
            const { h, gh, u } = setup(t);
            gh.publish("v0.1.1", NEW_ZIP, opts);
            const s = await u.check({ autoDownload: true });
            assert.equal(s.phase, "ready", label);
            assert.equal(h.versionOf(h.staged), "0.1.1", label);
        }
    });

    test("any one disagreeing source stops the update (checksum, not quiet), nothing staged", async t => {
        const wrong = "0".repeat(64);
        const cases = [
            ["asset digest", { digest: wrong }],
            [".sha256 file", { sumFile: `${wrong}  ${NAME}\n` }],
            ["release notes", { body: `SHA-256 (${NAME}) = ${wrong}` }],
            ["version.json hash", { versionJson: JSON.stringify({ sha256: wrong }) }]
        ];
        for (const [label, opts] of cases) {
            const { h, gh, u } = setup(t);
            gh.publish("v0.1.1", NEW_ZIP, opts);
            const s = await u.check({ autoDownload: true });
            assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "checksum", quiet: false }, label);
            assert.match(s.error.message, /não confere com o SHA-256 publicado/, label);
            untouched(h);
        }
    });

    test("a .sha256 asset without the zip's hash in it is itself an error", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { sumFile: "this file has no checksum\n" });
        const s = await u.check({ autoDownload: true });
        assert.equal(s.error.kind, "checksum");
        assert.match(s.error.message, /arquivo \.sha256 publicado não tem o SHA-256 do pacote/);
        untouched(h);
    });

    test("a version.json asset that is a payload manifest is used to cross-check the zip's contents", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { versionJson: NEW.manifestBytes.toString() });
        assert.equal((await u.check({ autoDownload: true })).phase, "ready");
        assert.ok(u.lines.some(l => /checkedAgainst/.test(l) || /GitHub \(digest do asset\)/.test(l)));
        assert.equal(h.versionOf(h.staged), "0.1.1");
    });

    test("...and when it lists other files than the zip holds, the package is refused", async t => {
        const lying = makePayload({ version: "0.1.1", commit: "new00101", replace: { "main.js": "// something else\n" } });
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { versionJson: lying.manifestBytes.toString() });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "invalid", quiet: false });
        assert.match(s.error.message, /não confere com o version\.json publicado/);
        untouched(h);
    });

    test("a version.json asset that is neither a manifest nor a hash is ignored", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { versionJson: '{"hello":"world"}' });
        assert.equal((await u.check({ autoDownload: true })).phase, "ready");
    });

    test("an incomplete download (fewer bytes than the asset's declared size) is a quiet retry, not a checksum failure", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { size: NEW_ZIP.length + 10 });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "offline", quiet: true });
        assert.match(s.error.message, /download veio incompleto/);
        untouched(h);
    });

    test("an asset declaring size 0 (unknown) is not size-checked", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP, { size: 0 });
        assert.equal((await u.check({ autoDownload: true })).phase, "ready");
    });
});

describe("a zip that matches its SHA-256 but is not a good payload", () => {
    /** Publishes `zip` as v0.1.1 with a matching hash, checks and expects an 'invalid' refusal. */
    async function refused(t, zip, re, { tag = "v0.1.1" } = {}) {
        const { h, gh, u } = setup(t);
        gh.publish(tag, zip);
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ phase: s.phase, kind: s.error?.kind, quiet: s.error?.quiet }, { phase: "error", kind: "invalid", quiet: false });
        assert.match(s.error.message, /pacote baixado está incompleto ou inválido|não é mais novo|diz versão|já falhou/);
        assert.ok(u.lines.some(l => re.test(l)), `log: ${re}\n${u.lines.join("\n")}`);
        untouched(h);
    }

    test("not a zip at all, and a truncated zip", async t => {
        await refused(t, Buffer.from("this is not a zip file at all".repeat(10)), /not a zip file/);
        await refused(t, NEW_ZIP.subarray(0, NEW_ZIP.length - 300), /not a zip file|malformed zip/);
    });

    test("Zip Slip: ../evil.js, ..\\evil.js, a nested folder — nothing is extracted anywhere", async t => {
        for (const name of ["../evil.js", "..\\evil.js", "sub/evil.js", "C:evil.js"]) {
            await refused(t, payloadZip(NEW, { extra: [{ name, data: "pwned" }] }), /unsafe or nested entry in the zip/);
        }
    });

    test("a listed file whose bytes were changed after the manifest was written", async t => {
        await refused(t, payloadZip(NEW, { without: ["main.js"], extra: [{ name: "main.js", data: "// tampered\n" }] }), /main\.js has 12 bytes|SHA-256 does not match version\.json/);
    });

    test("the zip's own version.json disagrees with the release tag", async t => {
        const other = makePayload({ version: "0.1.2", commit: "mis00102" });
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", payloadZip(other));
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "invalid", quiet: false });
        assert.match(s.error.message, /o pacote diz versão 0\.1\.2, mas a release é 0\.1\.1; nada foi instalado/);
        untouched(h);
    });

    test("a version marked bad while the zip was downloading (another Discord rolled it back meanwhile)", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        gh.hooks.before = url => {
            if (/\.zip$/.test(url)) {
                fs.mkdirSync(h.updateDir, { recursive: true });
                fs.writeFileSync(h.stateFile, JSON.stringify({ format: 1, bad: { "0.1.1": { at: "x", reason: "failed elsewhere" } } }));
            }
            return undefined;
        };
        const s = await u.check({ autoDownload: true });
        assert.equal(s.error.kind, "invalid");
        assert.match(s.error.message, /a versão 0\.1\.1 já falhou ao iniciar; ignorada/);
        untouched(h);
    });

    test("entries the manifest does not list are ignored (logged), not extracted", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", payloadZip(NEW, { extra: [{ name: "README.txt", data: "hi" }] }));
        assert.equal((await u.check({ autoDownload: true })).phase, "ready");
        assert.ok(u.lines.some(l => /zip entries not listed in version\.json ignored/.test(l) && /README\.txt/.test(l)));
        assert.equal(fs.existsSync(join(h.staged, "README.txt")), false);
        assert.deepEqual(h.names(h.staged), ["addon.json", "main.js", "stub-template.js", "version.json"]);
    });

    test("a zip bomb is refused by the size the directory declares", async t => {
        const bomb = payloadZip(NEW, { without: ["main.js"], extra: [{ name: "main.js", data: "A", size: 16, crc: 0, compressed: deflateRawSync(Buffer.alloc(200_000, 0x41)) }] });
        await refused(t, bomb, /main\.js: bad compressed data \(ERR_BUFFER_TOO_LARGE\)/);
    });
});

describe("staging on disk: a failure leaves no half-written update", () => {
    test("a file that cannot be written: 'disk' error (not quiet), staging folder removed, addon.new not created", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        wrapFs(t, fs, "writeFileSync", (orig, p, ...rest) => {
            if (String(p).includes("staging-") && String(p).endsWith("main.js")) throw fsError("ENOSPC", "no space left on device");
            return orig(p, ...rest);
        });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "disk", quiet: false });
        assert.ok(u.lines.some(l => /no space left on device/.test(l)));
        untouched(h);
        assert.equal(h.state().staged, undefined);
    });

    test("files written with other content than the zip held (a failing disk / antivirus): verified on disk, refused", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        wrapFs(t, fs, "writeFileSync", (orig, p, data, ...rest) => orig(p, String(p).endsWith("main.js") && String(p).includes("staging-") ? "corrupted on the way" : data, ...rest));
        const s = await u.check({ autoDownload: true });
        assert.equal(s.error.kind, "disk");
        assert.ok(u.lines.some(l => /main\.js does not match version\.json/.test(l)));
        untouched(h);
    });

    test("a staged version.json that names another commit than the zip's is refused ('staged copy differs')", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        wrapFs(t, fs, "writeFileSync", (orig, p, data, ...rest) => {
            if (String(p).includes("staging-") && String(p).endsWith("version.json")) {
                const m = JSON.parse(String(data));
                m.commit = "somebody-else";
                return orig(p, JSON.stringify(m), ...rest);
            }
            return orig(p, data, ...rest);
        });
        const s = await u.check({ autoDownload: true });
        assert.equal(s.error.kind, "disk");
        assert.ok(u.lines.some(l => /staged copy differs/.test(l)));
        untouched(h);
    });

    test("the final rename into addon.new failing: 'disk' error, staging folder cleaned", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (to === h.staged) throw fsError("EXDEV", "cross-device link");
            return orig(from, to);
        });
        const s = await u.check({ autoDownload: true });
        assert.equal(s.error.kind, "disk");
        untouched(h);
    });

    test("state.json that cannot be written after staging: reported as a plain failure ('other'), the staged copy stays valid", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        fs.mkdirSync(h.updateDir, { recursive: true });
        // the first write (lastCheck) works; the second one (the staged entry) fails
        let writes = 0;
        wrapFs(t, fs, "renameSync", (orig, from, to) => {
            if (to === h.stateFile && ++writes === 2) throw fsError("EXDEV", "cross-device link");
            return orig(from, to);
        });
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ phase: s.phase, error: s.error }, { phase: "ready", error: null }, "addon.new verifies, so the page may still call it ready");
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.ok(u.lines.some(l => /check failed \(other\)/.test(l)));
    });

    test("a state folder that is not a folder: the check fails as 'other' and logs the stack", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        fs.writeFileSync(h.updateDir, "i am a file");
        const s = await u.check({ autoDownload: true });
        assert.deepEqual({ phase: s.phase, kind: s.error.kind, quiet: s.error.quiet }, { phase: "error", kind: "other", quiet: false });
        assert.match(s.error.message, /a verificação falhou/);
        assert.ok(u.lines.some(l => /check failed \(other\)/.test(l)));
    });
});

describe("things thrown that are not Error objects, and sparse release data", () => {
    test("a fetch that rejects with a bare string is still an 'offline' report naming it", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => { throw "socket hang up"; };
        const s = await u.check({});
        assert.equal(s.error.kind, "offline");
        assert.ok(u.lines.some(l => /socket hang up/.test(l)));
    });

    test("a stream read that fails with a bare string is an interrupted download", async t => {
        const { gh, u } = setup(t);
        gh.hooks.before = () => ({
            status: 200, ok: true, headers: { get: () => null },
            body: { getReader: () => ({ read: () => Promise.reject("reset by peer"), cancel: async () => { } }) }
        });
        const s = await u.check({});
        assert.deepEqual({ kind: s.error.kind, quiet: s.error.quiet }, { kind: "offline", quiet: true });
        assert.ok(u.lines.some(l => /reset by peer/.test(l)));
    });

    test("staging that fails with a bare string is a 'disk' report naming it", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        wrapFs(t, fs, "writeFileSync", (orig, p, ...rest) => {
            if (String(p).includes("staging-")) throw "quota exceeded";
            return orig(p, ...rest);
        });
        const s = await u.check({ autoDownload: true });
        assert.equal(s.error.kind, "disk");
        assert.ok(u.lines.some(l => /quota exceeded/.test(l)));
        untouched(h);
    });

    test("an unexpected non-Error failure in the middle of a check is reported as 'other' with its text", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        wrapFs(t, fs, "mkdirSync", (orig, p, ...rest) => {
            if (p === h.updateDir) throw "no folder for you";
            return orig(p, ...rest);
        });
        const s = await u.check({});
        assert.equal(s.error.kind, "other");
        assert.ok(u.lines.some(l => /check failed \(other\)/.test(l) && /no folder for you/.test(l)));
    });

    test("a release with no notes and with assets that are null or have no name is read as having none", async t => {
        const { h, gh, u } = setup(t);
        gh.hooks.before = url => (/releases\/latest$/.test(url) ? reply(200, JSON.stringify({ tag_name: "v0.1.1", assets: [null, {}, { name: "x.zip" }] })) : undefined);
        const s = await u.check({});
        assert.equal(s.error.kind, "no-asset");
        const rel = h.state().lastCheck.release;
        assert.equal(rel.body, "");
        assert.deepEqual(rel.assets.map(a => a.name), ["", "", "x.zip"], "the response is remembered (for the ETag) even though it had nothing usable");
    });
});

describe("check() / download() bookkeeping", () => {
    test("concurrent calls share one run", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const a = u.check({ autoDownload: true });
        const b = u.check({ autoDownload: false, manual: true });
        assert.equal(a, b);
        await a;
        assert.equal(gh.fetch.count(/releases\/latest$/), 1);
    });

    test("status() is 'checking' while the request is out, 'downloading' while the zip comes in", async t => {
        const { gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const gates = [];
        gh.hooks.before = url => {
            if (/releases\/latest$/.test(url) || /\.zip$/.test(url)) return new Promise(resolve => gates.push({ url, release: () => resolve(undefined) }));
            return undefined;
        };
        const run = u.check({ autoDownload: true });
        assert.equal(u.status().phase, "checking");
        gates.shift().release();
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        assert.equal(u.status().phase, "downloading");
        gates.shift().release();
        const s = await run;
        assert.equal(s.phase, "ready");
    });

    test("download() waits for a check in flight, then runs its own (manual, automatic download)", async t => {
        const { h, gh, u } = setup(t);
        gh.publish("v0.1.1", NEW_ZIP);
        const slow = u.check({ autoDownload: false });
        const s = await u.download();
        assert.equal((await slow).phase, "available", "the check in flight finished as it was asked to: no download");
        assert.equal(s.phase, "ready");
        assert.equal(h.versionOf(h.staged), "0.1.1");
        assert.equal(gh.fetch.count(/releases\/latest$/), 2);
    });

    test("a manual check clears a previous error on success", async t => {
        const { gh, u } = setup(t);
        gh.mode = "offline";
        assert.equal((await u.check({})).phase, "error");
        gh.mode = "ok";
        gh.publish("v0.1.0", payloadZip(V010()));
        const s = await u.check({});
        assert.deepEqual({ phase: s.phase, error: s.error }, { phase: "up-to-date", error: null });
        assert.ok(s.checkedAt > 0);
    });

    test("with no readable installed version nothing is checked: a plain 'installed' error (not quiet)", async t => {
        const h = makeHome({ installed: null });
        t.after(() => h.cleanup());
        const gh = fakeGitHub();
        const u = updaterFor(h, { fetch: gh.fetch });
        const s = await u.check({});
        assert.deepEqual({ phase: s.phase, kind: s.error.kind, quiet: s.error.quiet }, { phase: "error", kind: "installed", quiet: false });
        assert.equal(gh.fetch.calls.length, 0);
        assert.equal(u.status().installed, null);
    });
});

describe("apiBase and User-Agent", () => {
    const answers404 = () => fakeFetch(() => reply(404, "{}"));

    test("only a loopback http:// base is accepted besides api.github.com", async t => {
        const h = makeHome({ installed: V010() });
        t.after(() => h.cleanup());
        const accepted = ["http://127.0.0.1:8123", "http://localhost:80", "http://[::1]:9", "HTTP://127.0.0.1:5/", "http://127.0.0.1:8123///"];
        for (const apiBase of accepted) {
            const f = answers404();
            await updaterFor(h, { fetch: f, apiBase }).check({});
            assert.equal(f.calls[0].url, `${apiBase.replace(/\/+$/, "")}/repos/${REPO}/releases/latest`, apiBase);
        }
        for (const apiBase of ["http://evil.example", "https://127.0.0.1:8123", "http://127.0.0.1", "http://127.0.0.1.evil.example:80", "ftp://localhost:1", "", undefined]) {
            const f = answers404();
            await updaterFor(h, { fetch: f, apiBase }).check({});
            assert.equal(f.calls[0].url, `${API}/repos/${REPO}/releases/latest`, String(apiBase));
        }
    });

    test("with a loopback base, assets must come from that base (the offline tests' fake server)", async t => {
        const h = makeHome({ installed: V010() });
        t.after(() => h.cleanup());
        const base = "http://127.0.0.1:4555";
        const gh = fakeGitHub(base);
        gh.publish("v0.1.1", NEW_ZIP);
        for (const a of gh.release.assets) a.browser_download_url = a.browser_download_url.replace(DOWNLOAD, `${base}/releases/download`);
        const ok = updaterFor(h, { fetch: gh.fetch, apiBase: base });
        assert.equal((await ok.check({ autoDownload: true })).phase, "ready");
        // real GitHub download URLs are not allowed in loopback mode
        const h2 = makeHome({ installed: V010() });
        t.after(() => h2.cleanup());
        const gh2 = fakeGitHub(base);
        gh2.publish("v0.1.1", NEW_ZIP);
        const s = await updaterFor(h2, { fetch: gh2.fetch, apiBase: base }).check({ autoDownload: true });
        assert.equal(s.error.kind, "invalid");
    });

    test("the User-Agent can be given; without an installed version it says '?'", async t => {
        const h = makeHome({ installed: V010() });
        t.after(() => h.cleanup());
        const f = answers404();
        await updaterFor(h, { fetch: f, userAgent: "MyAgent/1" }).check({});
        assert.equal(f.calls[0].init.headers["User-Agent"], "MyAgent/1");
        const bare = makeHome({ installed: null });
        t.after(() => bare.cleanup());
        const f2 = answers404();
        const u = updaterFor(bare, { fetch: f2 });
        await u.check({});
        assert.equal(f2.calls.length, 0, "no installed version: no request at all");
        assert.equal(u.paths.home, bare.home);
    });

    test("without a fetch option the global fetch is the default", async t => {
        const h = makeHome({ installed: V010() });
        t.after(() => h.cleanup());
        const real = globalThis.fetch;
        const seen = [];
        globalThis.fetch = async url => (seen.push(String(url)), reply(404, "{}"));
        try {
            const u = upd.createUpdater({ addonDir: h.addonDir, log() { } });
            await u.check({});
        } finally {
            globalThis.fetch = real;
        }
        assert.deepEqual(seen, [`${API}/repos/${REPO}/releases/latest`]);
    });

    test("without a log function the updater is silent (nothing to call, nothing breaks)", async t => {
        const h = makeHome({ installed: V010(), staged: NEW });
        t.after(() => h.cleanup());
        const u = upd.createUpdater({ addonDir: h.addonDir, fetch: fakeFetch(() => new TypeError("offline")) });
        assert.equal(u.startup().kind, "swapped");
        assert.equal((await u.check({})).phase, "error");
    });

    test("the default `now` is the clock: install.json stamps come out in the current minute", async t => {
        const h = makeHome({ installed: V010(), staged: NEW });
        t.after(() => h.cleanup());
        const u = upd.createUpdater({ addonDir: h.addonDir, log() { }, fetch: null });
        assert.equal(u.startup({ actions: true })?.kind, "swapped");
        assert.ok(Math.abs(Date.parse(h.record().installedAt) - Date.now()) < 60_000);
    });
});
