/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of addon/loader/main.js, the boot half: --vanilla, Vencord failing to load, the log file, the updater being
 * created (or failing to), mainFetch, and the hand-off to a freshly swapped-in (or rolled-back) loader with every way it
 * can go wrong.
 *
 *   node --test addon/test/main.boot.test.mjs        (also run by `pnpm test:addon`)
 *
 * Same set-up as main.hooks.test.mjs: main.js runs in this process from a byte-identical copy under the OS temp dir
 * against a fake electron. The hand-off tests use the REAL updater.js on a fake %APPDATA%\Telinha tree (addon\, addon.new,
 * addon.prev, state.json) and a tiny stand-in for the new version's main.js, so the swap, the rollback and the
 * "require the loader that is in this folder now" logic all run for real. run-update-test.mjs does the same end to end with
 * the real Vencord build; here the failure branches are the point.
 *
 * What needs a real Discord: Electron's require() of a loader inside the live app.asar / %APPDATA% (REAL-TEST.md).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, test } from "node:test";

import { fsError, wrapFs } from "./fake/update-kit.mjs";
import { loaderPayload, loaderScratch, makeElectron, makeLoaderTree, realLoaderFile, STUB_UPDATER, useWorld, vencordLike } from "./fake/loader-kit.mjs";

// the loader trees stay after the run (coverage of a loader copy is mapped back to addon/loader/ at report time)
const BASE = loaderScratch("main-boot");

/**
 * Another version's main.js: the real loader with a few lines appended (the same trick run-update-test.mjs uses). The file
 * keeps the real loader as its prefix, so when the old loader's copy is replaced by this one during a swap, scripts/coverage.mjs
 * still recognises it and maps the old loader's coverage onto addon/loader/main.js.
 */
const withTail = js => Buffer.concat([realLoaderFile("main.js"), Buffer.from(`\n;${js}\n`)]);
/** boot() records what it was handed. */
const HANDING = withTail(`module.exports = { boot: opts => { globalThis.__handedTo = opts; return "handed:" + opts.telinhaHandoff; }, updaterLoadError: null };`);
const THROWS_AT_LOAD = withTail("throw new Error('simulated broken loader');");

const OLD = (extra = {}) => loaderPayload({ version: "0.1.0", commit: "base0100", ...extra });
const NEW = mainSource => loaderPayload({ version: "0.1.1", commit: "new00101", replace: { "main.js": mainSource } });

/**
 * One boot of a loader copy. `tree`: makeLoaderTree options; `world`: useWorld options; `opts`: what the stub passes to boot();
 * `argv`: extra process.argv entries; `before(tree, w)`: runs after the tree and world exist, before the boot.
 */
function boot(t, { installed = OLD(), tree: treeOpts = {}, world = {}, patcher = vencordLike(), opts = {}, argv = [], before, noBoot = false } = {}) {
    const tree = makeLoaderTree({ installed, base: BASE, ...treeOpts });
    const w = useWorld(t, { patcher, argv, ...world });
    before?.(tree, w);
    const loader = tree.load();
    const vanilla = t.mock.fn();
    let result;
    let thrown = null;
    if (!noBoot) {
        try {
            result = loader.boot({ vencordPatcher: tree.patcher, vanilla, ...opts });
        } catch (err) {
            thrown = err;
        }
    }
    return { tree, w, loader, state: loader.state, electron: w.electron, vanilla, result, thrown, logs: w.logs, req: createRequire(tree.mainPath), opts: { vencordPatcher: tree.patcher, vanilla, ...opts } };
}

const SKIP_SLEEP = t => t.mock.method(Atomics, "wait", () => "timed-out");

describe("boot(): the plain path and its safety nets", () => {
    test("a normal boot: state published on globalThis, 'boot' and 'loaded' logged, Vencord required once", t => {
        const { state, logs, tree } = boot(t);
        assert.equal(globalThis.__TelinhaAddon, state);
        assert.equal(typeof state.bootedAt, "number");
        assert.ok(logs.log.some(l => /^\[Telinha\] boot /.test(l)));
        assert.ok(logs.log.some(l => /^\[Telinha\] loaded /.test(l)));
        assert.match(tree.mainLog(), /\[\d+\] boot \{.*"handoff":0/);
        assert.match(tree.mainLog(), /loaded \{.*"natives":2/);
        assert.equal(state.vencordLoaded, true);
    });

    test("--vanilla: Vencord alone, no hooks, no updates, the loader's state still published", t => {
        const { state, electron, tree } = boot(t, { argv: ["--vanilla"], tree: { staged: NEW(HANDING) } });
        assert.equal(state.vencordLoaded, true);
        assert.deepEqual([state.rendererHooked, state.ipcMapHooked, state.nativesLoaded, state.version], [false, false, false, null]);
        assert.equal(electron.ipcMain.sendSync("VencordPreloadGetRendererJs"), "var Vencord={};//vencord", "Vencord's answer is not touched");
        assert.equal(tree.versionOf(tree.addonDir), "0.1.0");
        assert.equal(tree.versionOf(tree.staged), "0.1.1", "a staged update is left for a normal start");
        assert.equal(globalThis.__TelinhaAddon, state);
    });

    test("--vanilla with Vencord failing too: Discord starts without mods", t => {
        const { state, vanilla } = boot(t, { argv: ["--vanilla"], patcher: () => { throw new Error("vencord is down"); } });
        assert.equal(vanilla.mock.callCount(), 1);
        assert.equal(state.vanillaFallback, true);
        assert.equal(state.vencordLoaded, false);
    });

    test("Vencord's patcher throwing: ipcMain restored, Discord started without mods, the failure kept in state and log", t => {
        const { state, vanilla, electron, tree, logs } = boot(t, { patcher: () => { throw new Error("vencord is down"); } });
        assert.equal(vanilla.mock.callCount(), 1);
        assert.deepEqual([state.vanillaFallback, state.vencordLoaded], [true, false]);
        assert.ok(state.errors.some(e => /^vencord: Error: vencord is down/.test(e)));
        assert.equal(Object.hasOwn(electron.ipcMain, "on"), false, "our ipcMain wrapper is removed again");
        assert.match(tree.mainLog(), /Vencord failed to load, starting Discord without mods/);
        assert.ok(logs.error.some(l => /addon: vencord failed/.test(l)));
    });

    test("restoring the ipcMain hooks a second time is harmless (a second boot of the same loader module)", t => {
        const { tree, loader, electron } = boot(t);
        assert.equal(Object.hasOwn(electron.ipcMain, "on"), false, "restored by the first boot");
        const broken = join(tree.root, "Vencord", "dist2", "patcher.js");
        fs.mkdirSync(join(tree.root, "Vencord", "dist2"), { recursive: true });
        fs.writeFileSync(broken, "throw new Error('second vencord is down');\n");
        process.argv.push("--vanilla");
        const vanilla = t.mock.fn();
        loader.boot({ vencordPatcher: broken, vanilla });
        assert.equal(vanilla.mock.callCount(), 1);
        assert.equal(loader.state.vanillaFallback, true);
        assert.equal(Object.hasOwn(electron.ipcMain, "on"), false);
    });

    test("an error that happens AFTER Vencord re-pointed require.main (Discord itself threw) is not ours to hide", t => {
        const { thrown, vanilla, electron } = boot(t, { patcher: () => { process.mainModule.filename = "C:/discord/app.asar/main.js"; throw new Error("discord blew up"); } });
        assert.match(thrown?.message ?? "", /discord blew up/);
        assert.equal(vanilla.mock.callCount(), 0);
        assert.equal(Object.hasOwn(electron.ipcMain, "on"), false, "still restored on the way out");
    });

    test("the very first log line failing (broken console) is recorded as 'boot' and the boot goes on", t => {
        const { state } = boot(t, {
            before: () => {
                console.log.mock.restore();
                let first = true;
                t.mock.method(console, "log", () => {
                    if (first) {
                        first = false;
                        throw new Error("console broke");
                    }
                });
            }
        });
        assert.ok(state.errors.some(e => /^boot: Error: console broke/.test(e)));
        assert.equal(state.vencordLoaded, true);
        assert.equal(state.rendererHooked, true);
    });

    test("opts.telinhaUpdate (set by a loader handing over) is recorded as state.update", t => {
        const { state } = boot(t, { opts: { telinhaUpdate: { kind: "swapped", from: "0.1.0", to: "0.1.1" } } });
        assert.deepEqual(state.update, { kind: "swapped", from: "0.1.0", to: "0.1.1" });
    });
});

describe("the log file (%APPDATA%\\Telinha\\logs\\main.log)", () => {
    test("lines carry a timestamp and the pid; non-string arguments are written as JSON", t => {
        const { tree } = boot(t);
        const lines = tree.mainLog().trim().split("\n");
        assert.ok(lines.length >= 2);
        for (const l of lines) assert.match(l, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[\d+\] /);
        assert.ok(lines.some(l => /boot \{"vencordPatcher":/.test(l)));
    });

    test("a log larger than 256 KB is rotated to main.log.1 before the next line", t => {
        const { tree } = boot(t, {
            before: tree => {
                fs.mkdirSync(join(tree.home, "logs"), { recursive: true });
                fs.writeFileSync(join(tree.home, "logs", "main.log"), "x".repeat(300 * 1024));
            }
        });
        assert.equal(fs.statSync(join(tree.home, "logs", "main.log.1")).size, 300 * 1024);
        assert.ok(fs.statSync(tree.logFile).size < 10_000);
    });

    test("a log folder that cannot be created is not an error (Discord's stdout goes nowhere on Windows, the log is a courtesy)", t => {
        const { state, logs } = boot(t, { before: tree => fs.writeFileSync(join(tree.home, "logs"), "i am a file, not a folder") });
        assert.equal(state.vencordLoaded, true);
        assert.deepEqual(state.errors, []);
        assert.ok(logs.log.some(l => /^\[Telinha\] loaded /.test(l)), "console output still happens");
    });
});

describe("the updater inside the loader", () => {
    test("createUpdater gets this folder, a logger into main.log, the loader's fetch and the test API base (if any)", t => {
        const { tree } = boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }), before: () => { process.env.TELINHA_UPDATE_API = "http://127.0.0.1:4321"; } });
        const [created] = globalThis.__updStub.created;
        assert.equal(created.addonDir, tree.addonDir);
        assert.equal(created.apiBase, "http://127.0.0.1:4321");
        assert.equal(typeof created.fetch, "function");
        created.log("plain message");
        created.log("with data", { a: 1 });
        assert.match(tree.mainLog(), /plain message\n/);
        assert.match(tree.mainLog(), /with data \{"a":1\}/);
    });

    test("without TELINHA_UPDATE_API the API base is left to the updater (undefined, never an empty string)", t => {
        boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }), before: () => { process.env.TELINHA_UPDATE_API = ""; } });
        assert.equal(globalThis.__updStub.created[0].apiBase, undefined);
    });

    test("an updater.js that does not even load: the loader runs without updates and exports the load error", t => {
        const { loader, state, electron } = boot(t, { installed: OLD({ replace: { "updater.js": "throw new Error('broken updater');\n" } }) });
        assert.match(String(loader.updaterLoadError), /broken updater/);
        assert.ok(state.errors.some(e => /^updater: Error: broken updater/.test(e)));
        assert.equal(state.vencordLoaded, true);
        assert.equal(state.rendererHooked, true);
        assert.equal("TelinhaAddon" in electron.ipcMain.sendSync("VencordGetPluginIpcMethodMap"), false, "no loader natives without an updater");
    });

    test("createUpdater throwing: logged, no updater, the boot goes on", t => {
        const { state } = boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }), before: () => { globalThis.__updStub = { createThrows: new Error("cannot create") }; } });
        assert.ok(state.errors.some(e => /^updater: Error: cannot create/.test(e)));
        assert.equal(state.vencordLoaded, true);
        assert.equal(state.addonChannels.length, 0);
    });

    test("updater.startup() throwing: logged as 'update startup', Vencord and the add-on still start", t => {
        const { state } = boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }), before: () => { globalThis.__updStub = { startupThrows: new Error("state.json locked") }; } });
        assert.ok(state.errors.some(e => /^update startup: Error: state\.json locked/.test(e)));
        assert.equal(state.rendererHooked, true);
        assert.equal(state.update, null);
    });

    test("depth: the hand-off depth is passed on as startup({ actions }): two levels deep, no more moves", t => {
        const stub = { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }) };
        boot(t, { ...stub, opts: { telinhaHandoff: 1 } });
        assert.deepEqual(globalThis.__updStub.calls.find(c => c[0] === "startup")[1], { actions: true });
        boot(t, { ...stub, opts: { telinhaHandoff: 2 } });
        assert.deepEqual(globalThis.__updStub.calls.filter(c => c[0] === "startup").at(-1)[1], { actions: false });
        boot(t, { ...stub, opts: { telinhaHandoff: "not a number" } });
        assert.deepEqual(globalThis.__updStub.calls.filter(c => c[0] === "startup").at(-1)[1], { actions: true });
    });
});

describe("mainFetch (what the updater downloads with)", () => {
    const fetchOf = t => boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }) });
    const created = () => globalThis.__updStub.created[0].fetch;

    test("Electron's net.fetch when it exists (Chromium's network stack: proxy, redirects)", async t => {
        const { electron } = fetchOf(t);
        electron.net.answer = () => new Response("from net", { status: 200 });
        const res = await created()("https://api.github.com/x", { headers: { a: "b" } });
        assert.equal(await res.text(), "from net");
        assert.deepEqual(electron.net.requests[0], ["https://api.github.com/x", { headers: { a: "b" } }]);
    });

    test("Node's fetch when electron has no net (or net.fetch is not a function)", async t => {
        for (const electron of [makeElectron({ withNet: false }), Object.assign(makeElectron({ withNet: false }), { net: {} })]) {
            const calls = [];
            const real = globalThis.fetch;
            globalThis.fetch = async (url, init) => (calls.push([String(url), init]), new Response("from node"));
            try {
                boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }), world: { electron } });
                const res = await created()("https://api.github.com/y", { cache: "no-store" });
                assert.equal(await res.text(), "from node");
                assert.deepEqual(calls, [["https://api.github.com/y", { cache: "no-store" }]]);
            } finally {
                globalThis.fetch = real;
            }
        }
    });

    test("electron not even loadable: Node's fetch", async t => {
        const real = globalThis.fetch;
        globalThis.fetch = async () => new Response("from node");
        try {
            boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }), world: { electron: null }, patcher: null });
            assert.equal(await (await created()("https://x")).text(), "from node");
        } finally {
            globalThis.fetch = real;
        }
    });

    test("no fetch anywhere: a rejected promise ('no fetch in this process'), never a throw", async t => {
        const real = globalThis.fetch;
        globalThis.fetch = undefined;
        try {
            boot(t, { installed: OLD({ replace: { "updater.js": STUB_UPDATER } }), world: { electron: makeElectron({ withNet: false }) } });
            await assert.rejects(() => created()("https://x"), /no fetch in this process/);
        } finally {
            globalThis.fetch = real;
        }
    });
});

describe("hand-off: startup() changed addon\\, so the boot goes to the loader that is there now", () => {
    const withStaged = (mainSource, extra = {}) => ({ tree: { staged: NEW(mainSource) }, ...extra });

    test("swapped in: the new loader gets the boot with depth 1 and the update record; its answer is ours", t => {
        const { result, state, tree, logs } = boot(t, withStaged(HANDING));
        assert.equal(result, "handed:1");
        assert.deepEqual({ ...state.update }, { kind: "swapped", from: "0.1.0", to: "0.1.1" });
        const handed = globalThis.__handedTo;
        assert.equal(handed.telinhaHandoff, 1);
        assert.deepEqual({ ...handed.telinhaUpdate }, { kind: "swapped", from: "0.1.0", to: "0.1.1" });
        assert.equal(handed.vencordPatcher, tree.patcher);
        assert.equal(tree.versionOf(tree.addonDir), "0.1.1");
        assert.equal(tree.versionOf(tree.prev), "0.1.0");
        assert.ok(logs.log.some(l => /update: handing the boot to Telinha 0\.1\.1/.test(l)));
        assert.equal(state.vencordLoaded, false, "this (old) loader did not start Vencord: the new one is in charge");
    });

    test("the new loader failing to load: rolled back at once, the old loader (still running here) boots in the same start", t => {
        const { state, tree } = boot(t, withStaged(THROWS_AT_LOAD));
        assert.deepEqual({ kind: state.update.kind, from: state.update.from, to: state.update.to, immediate: state.update.immediate }, { kind: "rolledBack", from: "0.1.1", to: "0.1.0", immediate: true });
        assert.ok(state.errors.some(e => /^swapped loader: Error: simulated broken loader/.test(e)));
        assert.equal(tree.versionOf(tree.addonDir), "0.1.0");
        assert.ok(tree.state().bad["0.1.1"]);
        assert.equal(state.vencordLoaded, true);
        assert.equal(state.rendererHooked, true, "Telinha 0.1.0 is fully hooked in");
        assert.equal(state.version, "0.1.0");
        assert.match(tree.mainLog(), /rolled back to 0\.1\.0 right away; starting it/);
    });

    test("a new loader with no boot(): refused ('main.js has no boot()'), rolled back", t => {
        const { state, tree } = boot(t, withStaged(withTail("module.exports = {};")));
        assert.ok(state.errors.some(e => /^swapped loader: Error: main\.js has no boot\(\)/.test(e)));
        assert.equal(tree.versionOf(tree.addonDir), "0.1.0");
        assert.equal(state.update.immediate, true);
    });

    test("a new loader whose updater.js does not load: refused (an older loader keeps its own version), rolled back", t => {
        const { state } = boot(t, withStaged(withTail("module.exports = { boot() { }, updaterLoadError: new Error('its updater is broken') };")));
        assert.ok(state.errors.some(e => /^swapped loader: Error: its updater\.js does not load: its updater is broken/.test(e)));
        assert.equal(state.update.kind, "rolledBack");
    });

    test("...whatever kind of value that load error is (a bare string is reported as it is)", t => {
        const { state } = boot(t, withStaged(withTail("module.exports = { boot() { }, updaterLoadError: 'string failure' };")));
        assert.ok(state.errors.some(e => /its updater\.js does not load: string failure/.test(e)));
    });

    test("the new boot() throwing: rolled back, and THIS start continues as plain Vencord (its hooks may be half installed)", t => {
        const { state, tree, thrown } = boot(t, withStaged(withTail("module.exports = { boot() { throw new Error('boom in new boot'); }, updaterLoadError: null };")));
        assert.equal(thrown, null);
        assert.ok(state.errors.some(e => /^swapped loader boot: Error: boom in new boot/.test(e)));
        assert.equal(state.vencordLoaded, true);
        assert.equal(state.rendererHooked, false, "no add-on this time");
        assert.equal(tree.versionOf(tree.addonDir), "0.1.0", "the next start is on the old version");
        assert.match(tree.state().bad["0.1.1"].reason, /its loader threw during boot \(boom in new boot\)/);
        assert.equal(globalThis.__TelinhaAddon, state);
        assert.match(tree.mainLog(), /starting Vencord without the add-on this time/);
    });

    test("the new boot() throwing after Vencord re-pointed require.main (Discord threw): rethrown, nothing rolled back", t => {
        const src = withTail("module.exports = { boot() { require.main.filename = 'C:/discord/app.asar/main.js'; throw new Error('discord blew up'); }, updaterLoadError: null };");
        const { thrown, tree } = boot(t, withStaged(src));
        assert.match(thrown?.message ?? "", /discord blew up/);
        assert.equal(tree.versionOf(tree.addonDir), "0.1.1", "not the add-on's fault");
        assert.equal(tree.state().bad["0.1.1"], undefined);
    });

    test("the new loader failing and the rollback itself being postponed (addon\\ in use): plain Vencord, the trial stays for the next start", t => {
        SKIP_SLEEP(t);
        const { state, tree } = boot(t, {
            ...withStaged(THROWS_AT_LOAD),
            before: tree => {
                let moves = 0;
                wrapFs(t, fs, "renameSync", (orig, from, to) => {
                    if (from === tree.addonDir && ++moves >= 2) throw fsError("EBUSY");
                    return orig(from, to);
                });
            }
        });
        assert.equal(state.update.kind, "swapped", "no 'immediate rollback' was recorded");
        assert.equal(state.update.immediate, undefined);
        assert.equal(state.vencordLoaded, true);
        assert.equal(state.rendererHooked, false);
        assert.ok(tree.state().trial, "still on trial: it will be rolled back at the next start");
        assert.match(tree.mainLog(), /starting Vencord without the add-on this time/);
    });

    test("a rolled-back start hands the boot to the restored loader; if THAT one cannot load, plain Vencord", t => {
        const trial = { version: "0.1.1", commit: "new00101", previous: "0.1.0", previousCommit: "base0100", swappedAt: "2026-10-29T00:00:00.000Z", armed: true, unarmedStarts: 0, previousRecord: null };
        const good = boot(t, { installed: loaderPayload({ version: "0.1.1", commit: "new00101" }), tree: { prev: OLD({ replace: { "main.js": HANDING } }), state: { format: 1, bad: {}, trial } } });
        assert.equal(good.result, "handed:1");
        assert.equal(good.state.update.kind, "rolledBack");
        assert.equal(good.tree.versionOf(good.tree.addonDir), "0.1.0");

        const broken = boot(t, { installed: loaderPayload({ version: "0.1.1", commit: "new00101" }), tree: { prev: OLD({ replace: { "main.js": THROWS_AT_LOAD } }), state: { format: 1, bad: {}, trial } } });
        assert.ok(broken.state.errors.some(e => /^rolledBack loader: Error: simulated broken loader/.test(e)));
        assert.equal(broken.state.vencordLoaded, true);
        assert.equal(broken.state.rendererHooked, false);
        assert.match(broken.tree.state().bad["0.1.1"].reason, /did not confirm a good start/, "the version that failed is marked bad by the rollback");
        assert.equal(broken.tree.state().trial, undefined, "and there is no trial left to roll back again");
    });

    test("plain Vencord after a failed hand-off, with Vencord broken too: Discord starts vanilla (never not at all)", t => {
        SKIP_SLEEP(t);
        const bad = withTail("module.exports = { boot() { throw new Error('boom in new boot'); }, updaterLoadError: null };");
        const { state, vanilla, tree } = boot(t, { ...withStaged(bad), patcher: () => { throw new Error("vencord is down"); } });
        assert.equal(vanilla.mock.callCount(), 1);
        assert.deepEqual([state.vanillaFallback, state.vencordLoaded], [true, false]);
        assert.ok(state.errors.some(e => /^vencord: Error: vencord is down/.test(e)));
        assert.equal(tree.versionOf(tree.addonDir), "0.1.0", "and the failed version was rolled back meanwhile");
    });

    test("...and when what failed there was Discord itself (require.main re-pointed), that error is rethrown", t => {
        const bad = withTail("module.exports = { boot() { throw new Error('boom in new boot'); }, updaterLoadError: null };");
        const { thrown, vanilla } = boot(t, { ...withStaged(bad), patcher: () => { process.mainModule.filename = "C:/discord/app.asar/main.js"; throw new Error("discord blew up"); } });
        assert.match(thrown?.message ?? "", /discord blew up/);
        assert.equal(vanilla.mock.callCount(), 0);
    });

    test("a rolled-back start whose restored loader cannot load, with Vencord broken: vanilla Discord", t => {
        const trial = { version: "0.1.1", commit: "new00101", previous: "0.1.0", previousCommit: "base0100", swappedAt: "2026-10-29T00:00:00.000Z", armed: true, unarmedStarts: 0, previousRecord: null };
        const { vanilla, state } = boot(t, {
            installed: loaderPayload({ version: "0.1.1", commit: "new00101" }),
            tree: { prev: OLD({ replace: { "main.js": THROWS_AT_LOAD } }), state: { format: 1, bad: {}, trial } },
            patcher: () => { throw new Error("vencord is down"); }
        });
        assert.equal(vanilla.mock.callCount(), 1);
        assert.equal(state.vanillaFallback, true);
    });

    test("two levels deep: no further swapping (telinhaHandoff 2), the staged update waits", t => {
        const { state, tree, result } = boot(t, { ...withStaged(HANDING), opts: { telinhaHandoff: 2 } });
        assert.equal(result, undefined);
        assert.equal(tree.versionOf(tree.addonDir), "0.1.0");
        assert.equal(tree.versionOf(tree.staged), "0.1.1");
        assert.equal(state.update, null);
        assert.equal(state.vencordLoaded, true);
    });

    test("nothing to do at startup: no hand-off, the loader runs itself", t => {
        const { result, state } = boot(t);
        assert.equal(result, undefined);
        assert.equal(state.update, null);
        assert.equal(state.rendererHooked, true);
    });
});

describe("module cache across a hand-off", () => {
    test("every module of the old version is forgotten before the new loader is required, so it is read from disk", t => {
        const { tree, req } = boot(t, { tree: { staged: NEW(HANDING) } });
        const onDisk = fs.readFileSync(join(tree.addonDir, "main.js"));
        assert.deepEqual(onDisk, HANDING, "the swapped-in main.js is the one on disk");
        const cached = req(join(tree.addonDir, "main.js"));
        assert.equal(cached.boot({ telinhaHandoff: 9 }), "handed:9", "and the one the module cache now holds is that one, not the old loader");
    });
});
