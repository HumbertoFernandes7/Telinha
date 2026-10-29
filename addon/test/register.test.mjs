/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of addon/loader/register.js (the renderer-side registration the loader prepends to the plugin bundle).
 *
 *   node --test addon/test/register.test.mjs        (also run by `pnpm test:addon`)
 *
 * register.js only ever runs inside Discord's main world, glued to the plugin bundle, so here it is run as its OWN
 * script in a node:vm context with a fake `Vencord` / `VencordNative`. The script is compiled from the exact bytes of the
 * file under the file's own URL, so V8's coverage maps straight back onto addon/loader/register.js (scripts/coverage.mjs
 * keeps vm scripts whose URL is inside the repo). The runtime contract is untouched: nothing here edits the loader.
 *
 * What cannot be covered without a real Discord: that Vencord's real startAllPlugins() later starts the plugins this
 * file registers (run-renderer-test.mjs shows it with the real Vencord renderer bundle, but through a vm script that
 * coverage cannot map); the boot report's effect on the loader (run-update-test.mjs covers that end to end).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "loader", "register.js");
const SOURCE = readFileSync(FILE, "utf8");
const TAG = "[Telinha]";

/** Plain copy of anything that came out of the vm (other realm: prototypes differ, so deepStrictEqual would fail). */
const plain = x => JSON.parse(JSON.stringify(x));

/** A manual clock + timer queue: `Date.now()` and `setTimeout` inside the page. */
function makeClock(start = 1_000_000) {
    const clock = { now: start, timers: [] };
    clock.setTimeout = (fn, ms) => {
        clock.timers.push({ fn, ms });
        return clock.timers.length;
    };
    /** Runs the oldest queued timer, `ms` later. Returns false when nothing is queued. */
    clock.step = () => {
        const t = clock.timers.shift();
        if (!t) return false;
        clock.now += t.ms;
        t.fn();
        return true;
    };
    return clock;
}

/** A Vencord look-alike with the parts register.js touches; every callback is recorded. */
function makeVencord({ plugins = {}, settingsPlugins = {}, enabled = () => true, wreq } = {}) {
    const calls = { addPatch: [], startPlugin: [], listeners: [], isPluginEnabled: [] };
    const V = {
        Plugins: {
            plugins,
            addPatch: (patch, name) => calls.addPatch.push([patch, name]),
            isPluginEnabled: name => (calls.isPluginEnabled.push(name), enabled(name)),
            startPlugin: p => (calls.startPlugin.push(p.name), (p.started = true))
        },
        Api: { Settings: { SettingsStore: { addChangeListener: (path, fn) => calls.listeners.push([path, fn]) } } },
        Settings: { plugins: settingsPlugins },
        Webpack: { wreq }
    };
    return { V, calls };
}

/**
 * Runs register.js in a fresh vm context. `vencord` undefined = a page without Vencord. Returns the sandbox, the
 * console lines (`[level] message`), the clock and `run()` (evaluates the script again in the same world).
 */
function makePage({ vencord, native, boot, clock = makeClock() } = {}) {
    const lines = [];
    const push = level => (...args) => lines.push([level, ...args]);
    const sandbox = {
        console: { log: push("log"), warn: push("warn"), error: push("error") },
        setTimeout: clock.setTimeout,
        clock
    };
    if (vencord) sandbox.Vencord = vencord;
    if (native) sandbox.VencordNative = native;
    if (boot !== undefined) sandbox.__TelinhaAddonBoot = boot;
    const context = vm.createContext(sandbox);
    vm.runInContext("Date.now = () => clock.now;", context);
    const run = () => new vm.Script(SOURCE, { filename: pathToFileURL(FILE).href }).runInContext(context);
    run();
    return {
        sandbox, lines, clock, run, context,
        register: p => sandbox.__TelinhaAddonRegister(p),
        text: level => lines.filter(l => l[0] === level).map(l => l.slice(1).map(String).join(" "))
    };
}

/** A plugin as definePlugin() produces it, with the pieces register.js looks at. */
const plugin = (extra = {}) => ({ name: "Telinha", description: "test", authors: [], patches: [], ...extra });

describe("register.js: no usable Vencord", () => {
    const broken = {
        "no Vencord at all": undefined,
        "no Plugins": {},
        "Plugins without the plugins object": { Plugins: { addPatch() { } }, Api: { Settings: { SettingsStore: {} } }, Settings: {} },
        "Plugins.addPatch missing": { Plugins: { plugins: {} }, Api: { Settings: { SettingsStore: {} } }, Settings: {} },
        "no Api.Settings.SettingsStore": { Plugins: { plugins: {}, addPatch() { } }, Api: {}, Settings: {} },
        "no Settings": { Plugins: { plugins: {}, addPatch() { } }, Api: { Settings: { SettingsStore: {} } } }
    };
    for (const [label, vencord] of Object.entries(broken)) {
        test(`${label}: logs once, registers nothing, answers { enabled: false }`, () => {
            const page = makePage({ vencord });
            assert.equal(page.text("error").length, 1);
            assert.match(page.text("error")[0], /^\[Telinha\] addon: Vencord renderer not found or incompatible/);
            assert.deepEqual(plain(page.register(plugin())), { enabled: false, error: "Vencord not found" });
            assert.deepEqual(plain(page.sandbox.TelinhaAddon.registrations), {});
        });
    }

    test("exposes the boot info the loader injected (TelinhaAddon.boot), or null", () => {
        const withBoot = makePage({ boot: { via: "ipc-hook", metaPatched: true, metaReason: null } });
        assert.deepEqual(plain(withBoot.sandbox.TelinhaAddon.boot), { via: "ipc-hook", metaPatched: true, metaReason: null });
        assert.equal(makePage().sandbox.TelinhaAddon.boot, null);
    });
});

describe("register.js: evaluated twice (e.g. the fallback preload and the IPC hook both served it)", () => {
    test("the second run changes nothing: same registry object, same register function", () => {
        const { V } = makeVencord();
        const page = makePage({ vencord: V });
        const firstRegister = page.sandbox.__TelinhaAddonRegister;
        const firstApi = page.sandbox.TelinhaAddon;
        page.register(plugin());
        page.run();
        assert.equal(page.sandbox.__TelinhaAddonRegister, firstRegister);
        assert.equal(page.sandbox.TelinhaAddon, firstApi);
        assert.deepEqual(plain(page.sandbox.TelinhaAddon.registrations), { Telinha: { enabled: true, webpackAlreadyRunning: false } });
    });
});

describe("register.js: registering a late plugin", () => {
    test("enabled plugin: listed, settings wired, patches queued, started at Init, result logged", () => {
        const { V, calls } = makeVencord();
        const page = makePage({ vencord: V });
        const onChange = () => { };
        const patch = { find: "a", replacement: { match: /x/, replace: "y" } };
        const p = plugin({
            patches: [patch], startAt: "Init",
            settings: { def: { codec: { onChange }, plain: { }, other: {} } }
        });
        const result = page.register(p);

        assert.deepEqual(plain(result), { enabled: true, webpackAlreadyRunning: false });
        assert.equal(V.Plugins.plugins.Telinha, p, "the object the settings UI lists and `$self` resolves to");
        assert.equal(p.settings.pluginName, "Telinha");
        assert.deepEqual(calls.listeners.map(([path]) => path), ["plugins.Telinha.codec"], "only keys with onChange get a listener");
        assert.equal(calls.listeners[0][1], onChange);
        assert.deepEqual(calls.addPatch, [[patch, "Telinha"]]);
        assert.deepEqual(calls.startPlugin, ["Telinha"]);
        assert.deepEqual(plain(page.sandbox.TelinhaAddon.registrations.Telinha), { enabled: true, webpackAlreadyRunning: false });
        const logged = page.lines.find(l => l[0] === "log");
        assert.equal(logged[1], TAG);
        assert.equal(logged[2], "addon: registered Telinha");
        assert.deepEqual(plain(logged[3]), { enabled: true, webpackAlreadyRunning: false });
    });

    test("enabled plugin that starts later (DOMContentLoaded / WebpackReady): queued but not started here", () => {
        const { V, calls } = makeVencord();
        const page = makePage({ vencord: V });
        page.register(plugin({ patches: [{ find: "a" }], startAt: "WebpackReady" }));
        assert.equal(calls.addPatch.length, 1);
        assert.deepEqual(calls.startPlugin, []);
    });

    test("plugin without patches, settings or startAt registers cleanly", () => {
        const { V, calls } = makeVencord();
        const page = makePage({ vencord: V });
        const bare = { name: "Telinha" };
        assert.deepEqual(plain(page.register(bare)), { enabled: true, webpackAlreadyRunning: false });
        assert.deepEqual(calls.addPatch, []);
        assert.deepEqual(calls.startPlugin, []);
    });

    test("disabled plugin: listed (so the user can enable it) but no patches, no start, no dependencies", () => {
        const { V, calls } = makeVencord({ enabled: () => false });
        const page = makePage({ vencord: V });
        const result = page.register(plugin({ patches: [{ find: "a" }], startAt: "Init", dependencies: ["SomeAPI"], commands: [{}] }));
        assert.deepEqual(plain(result), { enabled: false, webpackAlreadyRunning: false });
        assert.ok(V.Plugins.plugins.Telinha);
        assert.deepEqual(calls.addPatch, []);
        assert.deepEqual(calls.startPlugin, []);
    });

    test("a plugin of that name already there (a Vencord build that bundles it): the add-on copy stays passive", () => {
        const bundled = plugin({ patches: [{ find: "bundled" }] });
        const { V, calls } = makeVencord({ plugins: { Telinha: bundled } });
        const page = makePage({ vencord: V });
        const result = page.register(plugin({ startAt: "Init" }));
        assert.deepEqual(plain(result), { enabled: false, duplicate: true });
        assert.equal(V.Plugins.plugins.Telinha, bundled, "the existing plugin is not replaced");
        assert.deepEqual(calls.isPluginEnabled, []);
        assert.deepEqual(calls.addPatch, []);
        assert.match(page.text("warn")[0], /already has a plugin named Telinha; the add-on copy stays passive/);
        assert.deepEqual(plain(page.sandbox.TelinhaAddon.registrations.Telinha), { enabled: false, duplicate: true });
    });

    test("webpack already running: still registers, warns that some patches may miss modules", () => {
        const { V } = makeVencord({ wreq: function wreq() { } });
        const page = makePage({ vencord: V });
        const result = page.register(plugin());
        assert.deepEqual(plain(result), { enabled: true, webpackAlreadyRunning: true });
        assert.ok(page.text("warn").some(l => /webpack was already initialised; some patches may miss modules/.test(l)));
    });

    test("webpack not exposed at all (no Webpack object) counts as not running", () => {
        const { V } = makeVencord();
        delete V.Webpack;
        const page = makePage({ vencord: V });
        assert.deepEqual(plain(page.register(plugin())), { enabled: true, webpackAlreadyRunning: false });
    });
});

describe("register.js: what initPluginManager() does for bundled plugins, done late", () => {
    const deps = names => Object.fromEntries(names.map(n => [n, { name: n, patches: [{ find: n }], startAt: "Init" }]));

    test("explicit dependencies are enabled: flagged, patches queued, started at Init", () => {
        const plugins = deps(["CommandsAPI", "SomeAPI"]);
        const { V, calls } = makeVencord({ plugins, settingsPlugins: { CommandsAPI: { enabled: false }, SomeAPI: { enabled: false } } });
        const page = makePage({ vencord: V });
        page.register(plugin({ dependencies: ["SomeAPI"], patches: [] }));
        assert.equal(plugins.SomeAPI.isDependency, true);
        assert.equal(V.Settings.plugins.SomeAPI.enabled, true);
        assert.deepEqual(calls.addPatch, [[{ find: "SomeAPI" }, "SomeAPI"]]);
        assert.deepEqual(calls.startPlugin, ["SomeAPI"]);
        assert.equal(V.Settings.plugins.CommandsAPI.enabled, false, "unrelated APIs stay off");
    });

    test("a dependency Vencord already enabled is only flagged: its patches were queued by initPluginManager", () => {
        const plugins = deps(["SomeAPI"]);
        const { V, calls } = makeVencord({ plugins, settingsPlugins: { SomeAPI: { enabled: true } } });
        const page = makePage({ vencord: V });
        page.register(plugin({ dependencies: ["SomeAPI"] }));
        assert.equal(plugins.SomeAPI.isDependency, true);
        assert.deepEqual(calls.addPatch, []);
        assert.deepEqual(calls.startPlugin, []);
    });

    test("a dependency that starts later and has no patches: enabled, nothing queued, not started", () => {
        const plugins = { LateAPI: { name: "LateAPI", startAt: "WebpackReady" } };
        const { V, calls } = makeVencord({ plugins, settingsPlugins: { LateAPI: { enabled: false } } });
        const page = makePage({ vencord: V });
        page.register(plugin({ dependencies: ["LateAPI"] }));
        assert.equal(V.Settings.plugins.LateAPI.enabled, true);
        assert.deepEqual(calls.addPatch, []);
        assert.deepEqual(calls.startPlugin, []);
    });

    test("a dependency Vencord does not have: warns and goes on", () => {
        const { V, calls } = makeVencord();
        const page = makePage({ vencord: V });
        const result = page.register(plugin({ dependencies: ["GhostAPI"], startAt: "Init" }));
        assert.deepEqual(plain(result), { enabled: true, webpackAlreadyRunning: false });
        assert.ok(page.text("warn").some(l => /missing dependency GhostAPI/.test(l)));
        assert.deepEqual(calls.startPlugin, ["Telinha"]);
    });

    test("API plugins implied by the features the plugin uses (same table as Vencord)", () => {
        const names = ["CommandsAPI", "MessageEventsAPI", "ChatInputButtonAPI", "MemberListDecoratorsAPI", "MessageAccessoriesAPI", "MessageDecorationsAPI", "MessagePopoverAPI", "BadgeAPI"];
        const plugins = deps(names);
        const settingsPlugins = Object.fromEntries(names.map(n => [n, { enabled: false }]));
        const { V, calls } = makeVencord({ plugins, settingsPlugins });
        const page = makePage({ vencord: V });
        page.register(plugin({
            commands: [{ name: "x" }], onBeforeMessageEdit() { }, onBeforeMessageSend() { }, onMessageClick() { }, chatBarButton: {},
            renderMemberListDecorator() { }, renderMessageAccessory() { }, renderMessageDecoration() { }, messagePopoverButton: {}, userProfileBadge: {}
        }));
        for (const n of names) assert.equal(V.Settings.plugins[n].enabled, true, `${n} enabled`);
        assert.deepEqual([...calls.startPlugin].sort(), [...names].sort(), "every API started at Init; the plugin itself has no startAt");
    });

    test("an empty `commands` list does not need CommandsAPI; a missing feature needs nothing", () => {
        const plugins = deps(["CommandsAPI"]);
        const { V } = makeVencord({ plugins, settingsPlugins: { CommandsAPI: { enabled: false } } });
        const page = makePage({ vencord: V });
        page.register(plugin({ commands: [] }));
        assert.equal(V.Settings.plugins.CommandsAPI.enabled, false);
        assert.equal(plugins.CommandsAPI.isDependency, undefined);
    });

    test("event handlers are bound to the plugin (`this` is the plugin when Vencord calls them)", () => {
        const { V } = makeVencord({ plugins: deps(["MessageEventsAPI", "MemberListDecoratorsAPI", "MessageAccessoriesAPI", "MessageDecorationsAPI"]), settingsPlugins: Object.fromEntries(["MessageEventsAPI", "MemberListDecoratorsAPI", "MessageAccessoriesAPI", "MessageDecorationsAPI"].map(n => [n, { enabled: true }])) });
        const page = makePage({ vencord: V });
        const seen = {};
        const p = plugin({
            onBeforeMessageEdit() { seen.edit = this; }, onBeforeMessageSend() { seen.send = this; }, onMessageClick() { seen.click = this; },
            renderMemberListDecorator() { seen.member = this; }, renderMessageAccessory() { seen.accessory = this; }, renderMessageDecoration() { seen.decoration = this; }
        });
        page.register(p);
        const { onBeforeMessageEdit, onBeforeMessageSend, onMessageClick, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration } = p;
        for (const fn of [onBeforeMessageEdit, onBeforeMessageSend, onMessageClick, renderMemberListDecorator, renderMessageAccessory, renderMessageDecoration]) fn();
        assert.deepEqual(Object.keys(seen).sort(), ["accessory", "click", "decoration", "edit", "member", "send"]);
        for (const who of Object.values(seen)) assert.equal(who, p);
    });
});

describe("register.js: registration that throws", () => {
    test("Vencord throwing inside registration: logged, { enabled: false, error }, no boot report", () => {
        const reports = [];
        const { V } = makeVencord({ enabled: () => { throw new Error("boom"); } });
        const page = makePage({ vencord: V, native: { pluginHelpers: { TelinhaAddon: { bootOk: info => reports.push(info) } } } });
        const result = page.register(plugin());
        assert.deepEqual(plain(result), { enabled: false, error: "Error: boom" });
        assert.match(page.text("error")[0], /addon: registration of Telinha failed/);
        assert.deepEqual(reports, []);
    });

    test("a plugin that is not even an object: the failure is reported without a name", () => {
        const { V } = makeVencord();
        const page = makePage({ vencord: V });
        const result = page.register(undefined);
        assert.equal(result.enabled, false);
        assert.match(result.error, /TypeError/);
        assert.match(page.text("error")[0], /registration of undefined failed/);
    });

    test("settings without a `def` object: registration fails cleanly (plugin stays listed, nothing started)", () => {
        const { V, calls } = makeVencord();
        const page = makePage({ vencord: V });
        const result = page.register(plugin({ settings: {}, startAt: "Init" }));
        assert.equal(result.enabled, false);
        assert.deepEqual(calls.startPlugin, []);
    });
});

describe("register.js: boot report to the loader (PAYLOAD.md section 8)", () => {
    const natives = reports => ({ pluginHelpers: { TelinhaAddon: { bootOk: info => (reports.push(plain(info)), Promise.resolve({ confirmed: true })) } } });

    test("plugin already started by Vencord at Init: reported right away", () => {
        const reports = [];
        const { V } = makeVencord();
        const page = makePage({ vencord: V, native: natives(reports) });
        page.register(plugin({ startAt: "Init" }));
        assert.deepEqual(reports, [{ enabled: true, started: true, via: "register" }]);
        assert.equal(page.clock.timers.length, 0, "no polling needed");
    });

    test("plugin that starts later: polled every second, reported once when it started", () => {
        const reports = [];
        const { V } = makeVencord();
        const page = makePage({ vencord: V, native: natives(reports) });
        const p = plugin({ startAt: "WebpackReady" });
        page.register(p);
        assert.deepEqual(reports, []);
        assert.deepEqual(page.clock.timers.map(t => t.ms), [1000]);
        page.clock.step();
        page.clock.step();
        assert.deepEqual(reports, []);
        p.started = true;
        page.clock.step();
        assert.deepEqual(reports, [{ enabled: true, started: true, via: "register" }]);
        assert.equal(page.clock.timers.length, 0, "stops polling");
    });

    test("plugin that never starts: gives up after 5 minutes with a warning, nothing reported", () => {
        const reports = [];
        const { V } = makeVencord();
        const page = makePage({ vencord: V, native: natives(reports) });
        page.register(plugin({ startAt: "WebpackReady" }));
        let polls = 0;
        while (page.clock.step()) polls++;
        assert.ok(polls >= 299 && polls <= 302, `about one poll a second for 5 minutes (${polls})`);
        assert.deepEqual(reports, []);
        assert.ok(page.text("warn").some(l => /Telinha did not start; this start is not confirmed/.test(l)));
    });

    test("disabled plugin: reported as registered, not started", () => {
        const reports = [];
        const { V } = makeVencord({ enabled: () => false });
        const page = makePage({ vencord: V, native: natives(reports) });
        page.register(plugin());
        assert.deepEqual(reports, [{ enabled: false, started: false, via: "register" }]);
    });

    test("duplicate plugin: reported as 'duplicate'", () => {
        const reports = [];
        const { V } = makeVencord({ plugins: { Telinha: plugin() } });
        const page = makePage({ vencord: V, native: natives(reports) });
        page.register(plugin());
        assert.deepEqual(reports, [{ enabled: false, started: false, via: "duplicate" }]);
    });

    test("no loader natives in the page (no VencordNative, no pluginHelpers, no TelinhaAddon, no bootOk): nothing is sent", () => {
        for (const native of [undefined, {}, { pluginHelpers: {} }, { pluginHelpers: { TelinhaAddon: {} } }, { pluginHelpers: { TelinhaAddon: { bootOk: "nope" } } }]) {
            const page = makePage({ vencord: makeVencord({ enabled: () => false }).V, native });
            assert.deepEqual(plain(page.register(plugin())), { enabled: false, webpackAlreadyRunning: false });
            assert.deepEqual(page.text("error"), []);
        }
    });

    test("the loader refusing the report (rejected promise): only a warning, the registration result is unchanged", async () => {
        const { V } = makeVencord({ enabled: () => false });
        const page = makePage({ vencord: V, native: { pluginHelpers: { TelinhaAddon: { bootOk: () => Promise.reject(new Error("ipc gone")) } } } });
        const result = page.register(plugin());
        assert.deepEqual(plain(result), { enabled: false, webpackAlreadyRunning: false });
        await new Promise(r => setImmediate(r));
        assert.ok(page.text("warn").some(l => /addon: boot report failed .*ipc gone/.test(l)), page.text("warn").join("\n"));
    });

    test("bootOk throwing synchronously: caught, warned, registration result unchanged", () => {
        const { V } = makeVencord({ enabled: () => false });
        const page = makePage({ vencord: V, native: { pluginHelpers: { TelinhaAddon: { bootOk: () => { throw new Error("sync boom"); } } } } });
        const result = page.register(plugin());
        assert.deepEqual(plain(result), { enabled: false, webpackAlreadyRunning: false });
        assert.ok(page.text("warn").some(l => /addon: boot report failed .*sync boom/.test(l)));
    });

    test("bootOk answering without a promise is fine too", () => {
        const { V } = makeVencord({ enabled: () => false });
        let got = null;
        const page = makePage({ vencord: V, native: { pluginHelpers: { TelinhaAddon: { bootOk: info => (got = plain(info), { confirmed: true }) } } } });
        page.register(plugin());
        assert.deepEqual(got, { enabled: false, started: false, via: "register" });
    });

    test("the TAG used in messages is the loader's", () => {
        assert.equal(TAG, "[Telinha]");
        assert.ok(SOURCE.includes(`const TAG = "${TAG}"`));
    });
});
