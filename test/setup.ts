/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Preloaded into every unit-test process (`--import ./test/setup.ts` in package.json): what the Discord renderer
// always has and the add-on build provides, so plugin modules load in plain Node.
// - JSX: the plugin's .tsx compile to VencordCreateElement/VencordFragment (tsconfig.test.json, same as the add-on
//   build); here they are the real React's, resolved on first use (non-React tests never load React).
// - VencordNative exists but has no plugin natives (= "the native part is not loaded"): @test/fakes/native adds them.
// - `import "./x.css"` (index.tsx) loads as an empty module.
// - No network: fetch rejects (route answers with installFetch from @test/fakes/fetch).
// - The core's own log lines ("[Telinha] ..." on the console, core/log.ts) are dropped: tests read them from
//   getEventLog() (store.ts). TELINHA_TEST_ECHO=1 prints them.

import { createRequire } from "node:module";

import { blockNetwork } from "./fakes/fetch";

const requireLazy = createRequire(__filename);
const g = globalThis as Record<string, unknown>;

g.VencordFragment = Symbol.for("react.fragment");
g.VencordCreateElement = (...args: unknown[]) => (requireLazy("react") as { createElement(...a: unknown[]): unknown; }).createElement(...args);
g.VencordNative ??= { pluginHelpers: {} };
blockNetwork();

if (!process.env.TELINHA_TEST_ECHO) {
    for (const level of ["log", "info", "warn", "error"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            if (args[0] === "[Telinha]") return;
            original(...args);
        };
    }
}

// CommonJS is what tsx compiles the tests to (package.json has no "type": "module")
requireLazy.extensions[".css"] = (module: { exports: unknown; }) => {
    module.exports = {};
};
