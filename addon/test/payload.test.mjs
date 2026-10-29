/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * Unit tests of addon/loader/payload.js: the pure helpers the main-process loader shares with the offline tests (the
 * PluginMeta patch of Vencord's renderer, the renderer wrapper, the CSP rewrite).
 *
 *   node --test addon/test/payload.test.mjs        (also run by `pnpm test:addon`)
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { PLUGIN_META_RE, patchPluginMeta, wrapAddonRenderer, buildRendererPayload, parsePolicy, addCspSources } = require("../loader/payload.js");

// minified like Vencord's `~plugins` module: `Xx={[a.name]:{folderName:"_api/badges",userPlugin:!1},...`
const VENCORD_JS = `var a=1;const Xx={[a.name]:{folderName:"_api/badges",userPlugin:!1},[b.name]:{folderName:"_core/x",userPlugin:!1}};var z=2;`;

describe("patchPluginMeta", () => {
    test("inserts the plugin as the first entry of the PluginMeta literal, leaving the rest as it was", () => {
        const meta = { folderName: "telinha-addon", userPlugin: true };
        const r = patchPluginMeta(VENCORD_JS, "Telinha", meta);
        assert.equal(r.ok, true);
        assert.equal(r.reason, null);
        assert.equal(r.code, VENCORD_JS.replace("Xx={", `Xx={"Telinha":${JSON.stringify(meta)},`));
    });

    test("accepts the spaced / quoted shapes a non-minified build has", () => {
        const spaced = `PluginMeta = { [p.name]: { "folderName": "x", userPlugin: false } }`;
        const r = patchPluginMeta(spaced, "T", { folderName: "f", userPlugin: true });
        assert.equal(r.ok, true);
        assert.ok(r.code.includes(`PluginMeta = { "T":{"folderName":"f","userPlugin":true},[p.name]`), r.code);
    });

    test("refuses when there is no PluginMeta literal: code untouched, reason says how many were found", () => {
        const r = patchPluginMeta("var nothing = 1;", "Telinha", {});
        assert.deepEqual(r, { code: "var nothing = 1;", ok: false, reason: "expected 1 PluginMeta literal, found 0" });
    });

    test("refuses when the pattern is ambiguous (two literals): never guesses", () => {
        const two = VENCORD_JS + VENCORD_JS.replace("Xx=", "Yy=");
        const r = patchPluginMeta(two, "Telinha", {});
        assert.equal(r.ok, false);
        assert.equal(r.code, two);
        assert.equal(r.reason, "expected 1 PluginMeta literal, found 2");
    });

    test("the exported pattern is global (matchAll needs it) and matches the minified shape", () => {
        assert.ok(PLUGIN_META_RE.global);
        assert.equal([...VENCORD_JS.matchAll(PLUGIN_META_RE)].length, 1);
    });
});

describe("buildRendererPayload", () => {
    const manifest = { pluginName: "Telinha" };

    test("Vencord's renderer (patched) first, then ours as its own wrapped script, with the default meta", () => {
        const r = buildRendererPayload(VENCORD_JS, "globalThis.ran = 1;", manifest);
        assert.equal(r.metaPatched, true);
        assert.equal(r.metaReason, null);
        assert.ok(r.code.startsWith(VENCORD_JS.replace("Xx={", 'Xx={"Telinha":{"folderName":"telinha-addon","userPlugin":true},')));
        assert.ok(r.code.endsWith(wrapAddonRenderer("globalThis.ran = 1;", { via: "ipc-hook", metaPatched: true, metaReason: null })));
    });

    test("manifest.meta overrides the default meta entry", () => {
        const r = buildRendererPayload(VENCORD_JS, "", { pluginName: "Telinha", meta: { folderName: "mine", userPlugin: false } });
        assert.ok(r.code.includes('"Telinha":{"folderName":"mine","userPlugin":false}'));
    });

    test("PluginMeta not found: the add-on still goes out, and the boot info says why it was not patched", () => {
        const r = buildRendererPayload("var vencord = 1;", "x", manifest);
        assert.equal(r.metaPatched, false);
        assert.match(r.metaReason, /found 0/);
        assert.ok(r.code.startsWith("var vencord = 1;"));
        assert.ok(r.code.includes('"metaPatched":false'));
        assert.ok(r.code.includes("expected 1 PluginMeta literal, found 0"));
    });
});

describe("wrapAddonRenderer", () => {
    /** Runs the wrapper like the page does: a classic script in a context with a console. */
    function runWrapped(addonJs, boot = { via: "test" }) {
        const errors = [];
        const sandbox = { console: { error: (...a) => errors.push(a.map(String).join(" ")) }, ran: 0 };
        const context = vm.createContext(sandbox);
        vm.runInContext(wrapAddonRenderer(addonJs, boot), context);
        return { sandbox, errors, context };
    }

    test("the add-on runs after setting the boot info, as its own script (indirect eval: global scope)", () => {
        const { sandbox, errors } = runWrapped("ran = (typeof __TelinhaAddonBoot === 'object' ? __TelinhaAddonBoot.via : 'no boot'); var leaked = 1;");
        assert.equal(sandbox.ran, "test");
        assert.equal(sandbox.leaked, 1, "runs in the global scope, not inside the wrapper's block");
        assert.deepEqual(errors, []);
    });

    test("a throwing add-on is contained: logged with the loader's message, the outer script goes on", () => {
        const { sandbox, errors } = runWrapped("throw new Error('plugin failed');");
        assert.equal(errors.length, 1);
        assert.match(errors[0], /^\[Telinha\] addon: renderer failed .*plugin failed/);
        assert.equal(sandbox.ran, 0);
    });

    test("code that is not valid JavaScript is also contained (a SyntaxError from eval)", () => {
        const { errors } = runWrapped("this is not javascript ((");
        assert.equal(errors.length, 1);
        assert.match(errors[0], /renderer failed/);
    });

    test("names itself with a sourceURL, and survives text that looks like the end of a string or comment", () => {
        const { errors } = runWrapped("// */ \"quoted\" `tpl` \\n\nran = 7;");
        assert.deepEqual(errors, []);
        assert.ok(wrapAddonRenderer("x", {}).includes("telinha-addon:///telinha.renderer.js"));
    });
});

describe("parsePolicy / addCspSources (same rules as Vencord's csp helpers)", () => {
    test("parsePolicy: directive -> value list; the first of a repeated directive wins; blanks ignored", () => {
        const policy = parsePolicy("default-src 'self'; script-src a b ;; connect-src  x\t y ; script-src ignored; ; img-src");
        assert.deepEqual(policy, { "default-src": ["'self'"], "script-src": ["a", "b"], "connect-src": ["x", "y"], "img-src": [] });
    });

    test("parsePolicy: an empty policy has no directives", () => {
        assert.deepEqual(parsePolicy(""), {});
        assert.deepEqual(parsePolicy(" ; ;"), {});
    });

    test("adds sources to an existing directive, once", () => {
        const headers = { "content-security-policy": ["default-src 'self'; connect-src 'self' wss://a"] };
        assert.equal(addCspSources(headers, { "wss://a": ["connect-src"], "wss://b": ["connect-src"] }), true);
        assert.deepEqual(headers, { "content-security-policy": ["default-src 'self'; connect-src 'self' wss://a wss://b"] });
    });

    test("a directive the page lacks starts from default-src (so it does not loosen anything by omission)", () => {
        const headers = { "content-security-policy": ["default-src 'self' blob:"] };
        addCspSources(headers, { "wss://x": ["connect-src"] });
        assert.equal(headers["content-security-policy"][0], "default-src 'self' blob:; connect-src 'self' blob: wss://x");
    });

    test("no default-src and no directive: the directive is created with just the source", () => {
        const headers = { "content-security-policy": ["img-src a"] };
        addCspSources(headers, { "wss://x": ["connect-src", "media-src"] });
        assert.equal(headers["content-security-policy"][0], "img-src a; connect-src wss://x; media-src wss://x");
    });

    test("finds the header whatever its case, takes a string value too, writes back an array under the same key", () => {
        const headers = { "Content-Security-Policy": "default-src 'self'", "X-Other": ["1"] };
        assert.equal(addCspSources(headers, { "wss://x": ["connect-src"] }), true);
        assert.deepEqual(headers["Content-Security-Policy"], ["default-src 'self'; connect-src 'self' wss://x"]);
        assert.deepEqual(headers["X-Other"], ["1"]);
        assert.equal(Object.keys(headers).length, 2);
    });

    test("no CSP header: reports false and touches nothing", () => {
        const headers = { "content-type": ["text/html"] };
        assert.equal(addCspSources(headers, { "wss://x": ["connect-src"] }), false);
        assert.deepEqual(headers, { "content-type": ["text/html"] });
    });

    test("like Vencord's own stringify, a directive left without values is dropped on the way out", () => {
        const headers = { "content-security-policy": ["default-src 'self'; upgrade-insecure-requests; block-all-mixed-content"] };
        addCspSources(headers, {});
        assert.equal(headers["content-security-policy"][0], "default-src 'self'");
    });

    test("no sources to add still normalises the header (rewrite is idempotent)", () => {
        const headers = { "content-security-policy": ["default-src 'self'; connect-src a"] };
        addCspSources(headers, {});
        const once = headers["content-security-policy"][0];
        addCspSources(headers, {});
        assert.equal(headers["content-security-policy"][0], once);
    });
});
