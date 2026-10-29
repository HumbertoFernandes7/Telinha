/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-F helper: a build WITHOUT a Discord Client ID. The Client ID is a constant of core/identity/config.ts
// (isIdentityConfigured() = true in the repo), and a module's exports cannot be mocked (tsx compiles them to
// CommonJS getters). So the test file that wants the "identity off" build imports this module FIRST (before any plugin
// module): it swaps the loaded config module in Node's require cache for a copy whose isIdentityConfigured()
// answers false by default (still true for an explicit client id, as the real one). Every plugin module that
// loads afterwards (actions, common, core/identity, core/session...) sees the same answer, exactly like the
// plugin built without a Client ID. Each test file is its own process, so this never leaks into other files.
//
//   import "@test/fakes/dom";
//   import "@test/helpers/wpf-identity-off";       // before the plugin imports
//
// It must stay the first import with side effects: tsx runs the imports in order.

import { createRequire } from "node:module";

const req = createRequire(__filename);
const id = req.resolve("@plugins/telinha/core/identity/config");
const real = req(id) as Record<string, unknown> & { isIdentityConfigured(clientId?: string): boolean; };

const off: Record<string, unknown> = {};
for (const key of Object.keys(real)) Object.defineProperty(off, key, { enumerable: true, configurable: true, get: () => real[key] });
Object.defineProperty(off, "__esModule", { value: true });
Object.defineProperty(off, "isIdentityConfigured", {
    enumerable: true,
    // no argument = the build's own (absent) Client ID; an explicit one is judged as the real function does
    value: (clientId?: string) => clientId === undefined ? false : real.isIdentityConfigured(clientId)
});

const cached = req.cache[id];
if (!cached) throw new Error("wpf-identity-off: the config module is not in the require cache");
cached.exports = off;

export const identityOff = true;
