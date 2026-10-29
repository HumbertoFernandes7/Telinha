/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of addon/loader/stub-template.js: the stub the installer writes into resources/app.asar/index.js in place of
 * Vencord's one-liner. The format is FIXED on users' PCs (PAYLOAD.md section 3): these tests pin the contract and never
 * change it.
 *
 *   node --test addon/test/stub-template.test.mjs        (also run by `pnpm test:addon`)
 *
 * Two ways of running the same text:
 *   1. the template as it is on disk, in a node:vm context where the two placeholders are plain globals and `require` is a
 *      fake. The script is compiled from the exact bytes under the template's own URL, so V8's coverage maps onto
 *      addon/loader/stub-template.js (a rendered stub never could: its offsets move once the paths are in).
 *   2. the stub rendered by the installer's renderStub() (what is really on disk), run in a vm too, to pin that the two
 *      paths survive the JSON-literal substitution (backslashes, quotes, unicode, `$&`-style replacement patterns) and
 *      that the rendered file is the template with only those two tokens changed.
 *
 * What needs a real Discord: that Electron's real `require` inside app.asar resolves `fs`/`path`/`electron` the same way
 * (run-main-test.mjs boots the rendered stub through the fake electron and the real Vencord patcher: S1, S3, S4, S5).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "..", "loader", "stub-template.js");
const TEMPLATE = readFileSync(FILE, "utf8");
const nodeRequire = createRequire(import.meta.url);
const { renderStub } = nodeRequire("../installer/install.js");

const LOADER = join("C:", "Users", "Ana", "AppData", "Roaming", "Telinha", "addon", "main.js");
const PATCHER = join("C:", "Users", "Ana", "AppData", "Roaming", "Vencord", "dist", "patcher.js");
const STUB_FILE = join("C:", "Users", "Ana", "AppData", "Local", "Discord", "app-1.0.9002", "resources", "app.asar", "index.js");
const ASAR = join(dirname(STUB_FILE), "..", "_app.asar");

/**
 * Runs `source` (the template with placeholders as globals, or a rendered stub) as a classic script.
 * `existing` = paths that "exist"; `modules` = what require(path) returns, or an Error to throw.
 */
function runStub(source, { existing = [], modules = {}, filename = pathToFileURL(FILE).href, placeholders = true } = {}) {
    const events = [];
    const errors = [];
    const mainModule = { filename: STUB_FILE };
    const fake = {
        fs: { existsSync: p => (events.push(["existsSync", p]), existing.includes(p)) },
        path: nodeRequire("node:path"),
        electron: { app: { setAppPath: p => events.push(["setAppPath", p]) } }
    };
    const fakeRequire = id => {
        events.push(["require", id]);
        if (id in fake) return fake[id];
        if (id === join(ASAR, "package.json")) return { main: "app_bootstrap/index.js" };
        if (id in modules) {
            if (modules[id] instanceof Error) throw modules[id];
            return modules[id];
        }
        // Discord's own entry, required through the asar path after vanilla() re-pointed require.main.filename
        if (id === mainModule.filename) return {};
        throw new Error(`unexpected require(${id})`);
    };
    fakeRequire.main = mainModule;
    const sandbox = { require: fakeRequire, console: { error: (...a) => errors.push(a) } };
    if (placeholders) Object.assign(sandbox, { __TELINHA_LOADER__: LOADER, __VENCORD_PATCHER__: PATCHER });
    const context = vm.createContext(sandbox);
    new vm.Script(source, { filename }).runInContext(context);
    return { events, errors, mainModule };
}

const required = events => events.filter(e => e[0] === "require").map(e => e[1]);

describe("the template itself", () => {
    test("has the two placeholders exactly once each, and no other token", () => {
        assert.equal(TEMPLATE.split("__TELINHA_LOADER__").length, 2);
        assert.equal(TEMPLATE.split("__VENCORD_PATCHER__").length, 2);
        assert.match(TEMPLATE, /^const TELINHA_LOADER = __TELINHA_LOADER__;$/m);
        assert.match(TEMPLATE, /^const VENCORD_PATCHER = __VENCORD_PATCHER__;$/m);
    });

    test("starts with the marker the installer recognises (inspect() / uninstall depend on it)", () => {
        assert.ok(TEMPLATE.startsWith("// Telinha stub v1"));
    });
});

describe("stub: the Telinha loader is there", () => {
    test("boots the loader with the Vencord patcher path and the vanilla() fallback, and does nothing else", () => {
        let bootArgs = null;
        const loader = { boot: opts => { bootArgs = opts; } };
        const { events, errors } = runStub(TEMPLATE, { existing: [LOADER], modules: { [LOADER]: loader } });
        assert.deepEqual(Object.keys(bootArgs).sort(), ["vanilla", "vencordPatcher"]);
        assert.equal(bootArgs.vencordPatcher, PATCHER);
        assert.equal(typeof bootArgs.vanilla, "function");
        assert.deepEqual(required(events), ["fs", LOADER], "Vencord's patcher is the loader's business now");
        assert.deepEqual(errors, []);
    });

    test("the vanilla() it hands over starts Discord's own app: re-points require.main, setAppPath, requires its main", () => {
        let vanilla;
        const { events, mainModule } = runStub(TEMPLATE, { existing: [LOADER], modules: { [LOADER]: { boot: o => { vanilla = o.vanilla; } } } });
        vanilla();
        const main = join(ASAR, "app_bootstrap/index.js");
        assert.equal(mainModule.filename, main);
        assert.deepEqual(events.filter(e => e[0] === "setAppPath"), [["setAppPath", ASAR]]);
        assert.deepEqual(required(events).slice(-3), [join(ASAR, "package.json"), "electron", main]);
    });

    test("a loader that throws while loading: logged, then straight to Vencord's patcher (Discord must start)", () => {
        const boom = new Error("simulated broken loader");
        const { events, errors } = runStub(TEMPLATE, { existing: [LOADER, PATCHER], modules: { [LOADER]: boom, [PATCHER]: {} } });
        assert.equal(errors.length, 1);
        assert.match(errors[0][0], /^\[Telinha\] loader failed to load, starting Vencord without Telinha/);
        assert.equal(errors[0][1], boom);
        assert.deepEqual(required(events), ["fs", LOADER, PATCHER]);
    });

    test("a loader without boot(): same fallback, quietly (an old or half-written loader)", () => {
        for (const loader of [{}, { boot: "not a function" }, null]) {
            const { events, errors } = runStub(TEMPLATE, { existing: [LOADER, PATCHER], modules: { [LOADER]: loader, [PATCHER]: {} } });
            assert.deepEqual(errors, []);
            assert.deepEqual(required(events), ["fs", LOADER, PATCHER], `loader = ${JSON.stringify(loader)}`);
        }
    });

    test("a loader that returns nothing usable and no Vencord either: Discord starts vanilla", () => {
        const { events, errors, mainModule } = runStub(TEMPLATE, { existing: [LOADER], modules: { [LOADER]: {} } });
        assert.equal(errors.length, 1);
        assert.match(errors[0][0], /^\[Telinha\] Neither Telinha nor Vencord found, starting Discord without mods/);
        assert.equal(mainModule.filename, join(ASAR, "app_bootstrap/index.js"));
        assert.deepEqual(events.filter(e => e[0] === "setAppPath"), [["setAppPath", ASAR]]);
    });
});

describe("stub: the Telinha folder is gone (uninstalled by hand, stub left behind)", () => {
    test("loader file missing, Vencord there: plain Vencord, the loader is never required", () => {
        const { events, errors } = runStub(TEMPLATE, { existing: [PATCHER], modules: { [PATCHER]: {} } });
        assert.deepEqual(errors, []);
        assert.deepEqual(required(events), ["fs", PATCHER]);
        assert.deepEqual(events.filter(e => e[0] === "existsSync").map(e => e[1]), [LOADER, PATCHER]);
    });

    test("neither the loader nor Vencord: the message, then Discord's own app", () => {
        const { events, errors, mainModule } = runStub(TEMPLATE);
        assert.equal(errors.length, 1);
        assert.match(errors[0][0], /^\[Telinha\] Neither Telinha nor Vencord found/);
        assert.equal(mainModule.filename, join(ASAR, "app_bootstrap/index.js"));
        assert.deepEqual(required(events).slice(-1), [join(ASAR, "app_bootstrap/index.js")]);
    });

    test("Vencord's patcher throwing is not swallowed (Discord itself may have thrown inside it)", () => {
        assert.throws(() => runStub(TEMPLATE, { existing: [PATCHER], modules: { [PATCHER]: new Error("patcher blew up") } }), /patcher blew up/);
    });
});

describe("stub: rendered by the installer (what is on disk)", () => {
    test("is the template with only the two tokens replaced, by JSON string literals, on their own lines", () => {
        const stub = renderStub(TEMPLATE, LOADER, PATCHER);
        assert.equal(stub, TEMPLATE.replace("__TELINHA_LOADER__", JSON.stringify(LOADER)).replace("__VENCORD_PATCHER__", JSON.stringify(PATCHER)));
        assert.equal(stub.split("\n").length, TEMPLATE.split("\n").length, "same lines (the installer's inspect() reads them by line)");
        assert.ok(stub.includes(`const TELINHA_LOADER = ${JSON.stringify(LOADER)};\n`));
        assert.ok(stub.includes(`const VENCORD_PATCHER = ${JSON.stringify(PATCHER)};\n`));
    });

    test("paths with backslashes, quotes, spaces, unicode and replace-pattern characters arrive intact", () => {
        const weird = [
            String.raw`C:\Users\João Silva\AppData\Roaming\Telinha\addon\main.js`,
            String.raw`C:\Program Files (x86)\a"b\c'd\$&\$1\main.js`,
            "D:\\Ünï\\\u2603\\x`y`\\${z}\\main.js",
            String.raw`\\server\share\Tel inha\addon\main.js`
        ];
        for (const loaderPath of weird) {
            const patcherPath = loaderPath.replace("main.js", "patcher.js");
            const stub = renderStub(TEMPLATE, loaderPath, patcherPath);
            let bootArgs = null;
            const { events } = runStub(stub, {
                existing: [loaderPath], modules: { [loaderPath]: { boot: o => { bootArgs = o; } } }, filename: "file:///rendered-stub.js", placeholders: false
            });
            assert.equal(bootArgs?.vencordPatcher, patcherPath, loaderPath);
            assert.ok(required(events).includes(loaderPath), loaderPath);
        }
    });

    test("the installer refuses a template that does not carry each token exactly once", () => {
        assert.throws(() => renderStub("const a = 1;", LOADER, PATCHER), /exactly once/);
        assert.throws(() => renderStub(TEMPLATE + "\n// __TELINHA_LOADER__", LOADER, PATCHER), /exactly once/);
    });
});
