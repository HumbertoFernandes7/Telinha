/*
 * Offline test of the renderer side against a REAL Vencord renderer.js in a node:vm "Discord main world".
 *
 *   node addon/prototype/test/run-renderer-test.mjs [--vencord-dist <dir>]
 *
 * Uses the exact script the real Vencord preload executed in run-main-test.mjs (%TEMP%\pl-addon\served-renderer-s1.js)
 * when present, otherwise builds it with the loader's own buildRendererPayload(). Then loads a fake Discord
 * webpack runtime (as https://discord.com/assets/...) to show our patch is applied by Vencord's patcher.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

import { makePage, runScript } from "./vm-page.mjs";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = resolve(HERE, "..");
const REPO = resolve(PROTO, "..", "..");
const SCRATCH = join(tmpdir(), "pl-addon");
const { buildRendererPayload, wrapAddonRenderer } = require("../loader/payload.js");

function pickVencordDist() {
    const i = process.argv.indexOf("--vencord-dist");
    if (i !== -1) return resolve(process.argv[i + 1]);
    const roaming = process.env.APPDATA && join(process.env.APPDATA, "Vencord");
    const official = roaming && existsSync(roaming) && readdirSync(roaming).find(d => d.startsWith("dist.backup-oficial"));
    return official ? join(roaming, official) : join(REPO, "dist");
}

let failures = 0;
const check = (label, cond, extra) => {
    console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${!cond && extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
    if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const asyncErrors = [];
process.on("unhandledRejection", e => asyncErrors.push(e));

const manifest = JSON.parse(readFileSync(join(PROTO, "payload", "addon.json"), "utf8"));
// same concatenation as loader/main.js readAddonRenderer()
const addonJs = readFileSync(join(PROTO, "loader", "register.js"), "utf8") + "\n;\n" + readFileSync(join(PROTO, "payload", manifest.renderer), "utf8");
const vencordDist = pickVencordDist();
const vencordJs = readFileSync(join(vencordDist, "renderer.js"), "utf8");
const served = join(SCRATCH, "served-renderer-s1.js");
const payload = process.argv.includes("--rebuild") || !existsSync(served)
    ? { code: buildRendererPayload(vencordJs, addonJs, manifest).code, from: "buildRendererPayload()" }
    : { code: readFileSync(served, "utf8"), from: served + " (what the real Vencord preload executed)" };
console.log(`Vencord renderer: ${vencordDist}  [${vencordJs.split("\n")[0]}]\nPayload: ${payload.from}\n`);

// 4242: probe module; 4243: unrelated; 4244: shaped like Discord's account panel call site (find = the
// canonicalised #{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL} key, read from the queued patch).
const fakeWebpack = accountFind => `(() => {
    var __webpack_modules__ = {
        4242: function (e, t, n) { "PEERLIVE_ADDON_PROBE"; e.exports = { greet: function () { return "PROBE_ORIGINAL"; } }; },
        4243: function (e, t, n) { e.exports = { other: function () { return "untouched"; } }; },
        4244: function (e, t, n) { var s = {}; e.exports = { render: function (u) { s${accountFind}; return {userTag:u,occluded:!1}; } }; }
    };
    var __webpack_module_cache__ = {};
    function r(e){var t=__webpack_module_cache__[e];if(void 0!==t)return t.exports;var o=__webpack_module_cache__[e]={id:e,loaded:!1,exports:{}};return __webpack_modules__[e].call(o.exports,o,o.exports,r),o.loaded=!0,o.exports}
    r.m = __webpack_modules__;
    r.c = __webpack_module_cache__;
    r.u = function (e) { return e + ".js"; };
    r.p = "/assets/";
    globalThis.__fakeWreq = r;
})();`;

const helpers = { PeerLiveAddonHello: { ping: async m => ({ pong: m, from: "fake-main" }), armDisplayMedia: async () => true } };

async function boot(code, storedSettings) {
    const page = makePage({ storedSettings, pluginHelpers: helpers });
    let thrown = null;
    try {
        runScript(page.context, code, "file:///VencordRenderer");
    } catch (e) {
        thrown = e;
    }
    await sleep(50);
    const $ = expr => vm.runInContext(expr, page.context);
    return { ...page, thrown, $ };
}

// ------------------------------------------------------------------------------------------- A: fresh install
console.log("A first boot (no saved settings)");
let saved;
let accountFind;
{
    const p = await boot(payload.code, {});
    const { $ } = p;
    check("Vencord renderer evaluated, Vencord global defined", !p.thrown && $("typeof Vencord") === "object", String(p.thrown));
    check("addon ran via ipc-hook with PluginMeta patched", $("JSON.stringify(__PeerLiveAddonBoot)") === JSON.stringify({ via: "ipc-hook", metaPatched: true, metaReason: null }));
    check("registered into Vencord.Plugins.plugins, enabled, before webpack", $("JSON.stringify(PeerLiveAddon.registrations.PeerLiveAddonHello)") === '{"enabled":true,"webpackAlreadyRunning":false}' && $("Vencord.Webpack.wreq === undefined"));
    const queued = JSON.parse($(`JSON.stringify(Vencord.WebpackPatcher.patches.filter(p => p.plugin === "PeerLiveAddonHello").map(p => ({ find: String(p.find), replace: p.replacement.map(r => String(r.replace)) })))`));
    check("2 patches queued in Vencord's patches array", queued.length === 2, queued);
    check("$self canonicalised to Vencord.Plugins.plugins[\"PeerLiveAddonHello\"]", queued[0]?.replace[0] === 'Vencord.Plugins.plugins["PeerLiveAddonHello"].probeValue()', queued[0]);
    check("settings UI source (Object.values(plugins)) lists it, with a settings cog", $(`Object.values(Vencord.Plugins.plugins).some(p => p.name === "PeerLiveAddonHello") && Vencord.Plugins.hasAnyVisibleSettings(Vencord.Plugins.plugins.PeerLiveAddonHello)`));
    check("defaults: enabled (enabledByDefault) + greeting default", $(`Vencord.Settings.plugins.PeerLiveAddonHello.enabled === true && Vencord.Settings.plugins.PeerLiveAddonHello.greeting === "Olá do PeerLive (addon)!"`));

    // Discord's webpack runtime arrives (as a script from https://discord.com/assets/)
    accountFind = queued[1]?.find;
    runScript(p.context, fakeWebpack(accountFind), "https://discord.com/assets/web.fake0001.js");
    check("Vencord adopted the fake Discord webpack instance", $("Vencord.Webpack.wreq === __fakeWreq"));
    check("PATCH APPLIED: module 4242 now returns our setting", $("__fakeWreq(4242).greet()") === "Olá do PeerLive (addon)!", $("String(__fakeWreq(4242).greet())"));
    check("other modules untouched", $("__fakeWreq(4243).other()") === "untouched");
    check("account-panel-shaped module: userTag passes through our identity hook", $(`__fakeWreq(4244).render("TAG").userTag`) === "TAG" && $("Vencord.Plugins.plugins.PeerLiveAddonHello.accountPanelRenders") === 1);
    check("applied patches left Vencord's pending list", $(`Vencord.WebpackPatcher.patches.filter(p => p.plugin === "PeerLiveAddonHello").length`) === 0);

    $(`Vencord.Settings.plugins.PeerLiveAddonHello.greeting = "mudei a saudação"`);
    await sleep(10);
    const last = p.savedSettings.at(-1);
    check("setting change persisted through VencordNative.settings.set", last?.plain?.plugins?.PeerLiveAddonHello?.greeting === "mudei a saudação", last?.path);
    check("onChange from definePluginSettings fired", p.consoleLines.some(l => l.includes("greeting changed to mudei a saudação")));
    check("patched module reads the live setting", $("__fakeWreq(4242).greet()") === "mudei a saudação");

    $(`Vencord.Plugins.startAllPlugins("WebpackReady")`); // what src/Vencord.ts:149 does once Discord's webpack is ready
    await sleep(30);
    check("Vencord's own startAllPlugins started it", $("typeof Vencord.Plugins.plugins.PeerLiveAddonHello.startedAt") === "number" && $("Vencord.Plugins.plugins.PeerLiveAddonHello.started") === true);
    check("start() reached main via VencordNative.pluginHelpers", $("JSON.stringify(Vencord.Plugins.plugins.PeerLiveAddonHello.lastPing)") === '{"pong":"start","from":"fake-main"}');

    let pluginList = null;
    try {
        pluginList = $(`Vencord.Plugins.plugins.SupportHelper.commands.find(c => c.name === "vencord-plugins").execute().content`);
    } catch (e) {
        pluginList = "THREW " + e;
    }
    check("SupportHelper /vencord-plugins works and lists it as a UserPlugin", /Enabled UserPlugins \(1\)[\s\S]*PeerLiveAddonHello/.test(pluginList), pluginList?.slice?.(0, 200));
    check("toolbox action exposed for VencordToolbox", $(`typeof Vencord.Plugins.plugins.PeerLiveAddonHello.toolboxActions["PeerLive addon: ping main"]`) === "function");

    // Toggle off in Settings -> Plugins (PluginCard.toggleEnabled: plugin has patches -> flip + restart prompt)
    check("toggle needs restart (has patches), like any patching plugin", $("Vencord.Plugins.pluginRequiresRestart(Vencord.Plugins.plugins.PeerLiveAddonHello)") === true);
    $(`Vencord.Settings.plugins.PeerLiveAddonHello.enabled = false`);
    await sleep(10);
    saved = p.savedSettings.at(-1).plain;
    check("disabled state persisted", saved.plugins.PeerLiveAddonHello.enabled === false && saved.plugins.PeerLiveAddonHello.greeting === "mudei a saudação");
}

// ------------------------------------------------------------------------------------------- B: restart, disabled
console.log("\nB restart with the plugin disabled");
{
    const p = await boot(payload.code, saved);
    const { $ } = p;
    check("still listed (toggleable) but not enabled", $(`"PeerLiveAddonHello" in Vencord.Plugins.plugins`) && $("PeerLiveAddon.registrations.PeerLiveAddonHello.enabled") === false);
    check("no patches queued while disabled", $(`Vencord.WebpackPatcher.patches.filter(p => p.plugin === "PeerLiveAddonHello").length`) === 0);
    $(`Vencord.Settings.plugins.PeerLiveAddonHello.enabled = true`);
    await sleep(10);
    saved = p.savedSettings.at(-1).plain;
}

// ------------------------------------------------------------------------------------------- C: restart, re-enabled
console.log("\nC restart after re-enabling");
{
    const p = await boot(payload.code, saved);
    const { $ } = p;
    runScript(p.context, fakeWebpack(accountFind), "https://discord.com/assets/web.fake0002.js");
    check("enabled again, saved greeting survived restarts, patch applied", $("PeerLiveAddon.registrations.PeerLiveAddonHello.enabled") === true && $("__fakeWreq(4242).greet()") === "mudei a saudação");
}

// ------------------------------------------------------------------------------------------- D: control
console.log("\nD control: same addon WITHOUT the PluginMeta entry");
{
    const p = await boot(vencordJs + wrapAddonRenderer(addonJs, { via: "control", metaPatched: false }), {});
    let threw = false;
    try {
        p.$(`Vencord.Plugins.plugins.SupportHelper.commands.find(c => c.name === "vencord-plugins").execute()`);
    } catch (e) {
        threw = /userPlugin/.test(String(e));
    }
    check("/vencord-plugins crashes on PluginMeta[name].userPlugin (so the entry is required)", threw);
}

if (asyncErrors.length) console.log(`\n(async errors in the fake page: ${asyncErrors.map(e => String(e).split("\n")[0].slice(0, 140)).join(" | ")})`);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
