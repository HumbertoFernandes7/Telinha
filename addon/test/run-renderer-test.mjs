/*
 * Offline test of the renderer side: the REAL Telinha payload on a REAL (official) Vencord renderer.js, in a node:vm
 * "Discord main world".
 *
 *   node addon/test/run-renderer-test.mjs [--vencord-dist <dir>] [--payload <dir>] [--rebuild]
 *
 * Uses the exact script the real Vencord preload executed in run-main-test.mjs (%TEMP%\tl-addon\served-renderer-s1.js)
 * when present (and newer than the payload), otherwise builds it with the loader's own buildRendererPayload(). Then
 * loads a fake Discord webpack runtime (as https://discord.com/assets/...) whose modules are shaped like the Discord
 * code each Telinha patch targets, to show Vencord's patcher applies all of them to our `$self`.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import vm from "vm";

import { makeChecker, pickPayload, pickVencordDist, SCRATCH } from "./common.mjs";
import { makePage, runScript } from "./vm-page.mjs";

const require = createRequire(import.meta.url);
const { buildRendererPayload, wrapAddonRenderer } = require("../loader/payload.js");
const { check, finish } = makeChecker();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const asyncErrors = [];
process.on("unhandledRejection", e => asyncErrors.push(e));

const payload = pickPayload();
const { manifest } = payload;
// same concatenation as loader/main.js readAddonRenderer()
const addonJs = readFileSync(join(payload.dir, "register.js"), "utf8") + "\n;\n" + readFileSync(join(payload.dir, manifest.renderer), "utf8");
const vencordDist = pickVencordDist();
const vencordJs = readFileSync(join(vencordDist, "renderer.js"), "utf8");
const served = join(SCRATCH, "served-renderer-s1.js");
const useServed = !process.argv.includes("--rebuild") && existsSync(served) && statSync(served).mtimeMs >= statSync(join(payload.dir, "version.json")).mtimeMs;
const page0 = useServed
    ? { code: readFileSync(served, "utf8"), from: served + " (what the real Vencord preload executed in run-main-test)" }
    : { code: buildRendererPayload(vencordJs, addonJs, manifest).code, from: "buildRendererPayload()" };
console.log(`Vencord renderer: ${vencordDist}  [${vencordJs.split("\n")[0]}]\nPayload: ${payload.dir} (${payload.version.commit})\nServed script: ${page0.from}\n`);

const P = 'Vencord.Plugins.plugins["Telinha"]';
const commentSafe = s => (String(s).includes("*/") ? null : `/* ${s} */`);

/**
 * A Discord webpack runtime with one module per Telinha patch, shaped like the real call sites (see the comments in
 * src/plugins/telinha/index.tsx and ui/callView/patches.ts), plus an unrelated module and Discord's jsx runtime.
 *   5001 account panel  `(0,r.jsx)(Panel,{...,userTag:u,occluded:!1})`
 *   5002 voice user row `(0,r.jsx)(VoiceUserIcons,{...,isHovered:h})`
 *   5003 CallTile       `u.type===ek.lp.USER?(0,r.jsx)("div",{...containerDimensions:{...}}):null,e2,R?null:...`
 */
const fakeWebpack = finds => `(() => {
    var __webpack_modules__ = {
        // minified like Discord's bundles: the patches' regexes match minified code (no spaces)
        5001: function(e,t,n){${finds.account}var r=n(5099),P=function Panel(){};e.exports={render:function(u){return(0,r.jsx)(P,{className:"panel",userTag:u,occluded:!1})}}},
        5002: function(e,t,n){${finds.voiceUser}var r=n(5099),I=function VoiceUserIcons(){};e.exports={row:function(u,h){return(0,r.jsx)(I,{disabled:!1,user:u,collapsed:!1,isHovered:h})}}},
        5003: function(e,t,n){var r=n(5099),W={A:function(){}},ek={lp:{USER:"USER"}};function O(){}O.displayName="CallTileOverlay";e.exports={tile:function(u,e2,R){return[u.type===ek.lp.USER?(0,r.jsx)("div",{className:"fx",children:(0,r.jsx)(W.A,{userId:u.user.id,containerDimensions:{width:1,height:2}})}):null,e2,R?null:"overlay"]}}},
        5004: function(e,t,n){e.exports={other:function(){return"untouched"}}},
        5099: function (e, t, n) { e.exports = { jsx: function (type, props) { return { from: "discord-jsx", type: type, props: props }; }, jsxs: function (type, props) { return { from: "discord-jsxs", type: type, props: props }; } }; }
    };
    var __webpack_module_cache__ = {};
    function r(e){var t=__webpack_module_cache__[e];if(void 0!==t)return t.exports;var o=__webpack_module_cache__[e]={id:e,loaded:!1,exports:{}};return __webpack_modules__[e].call(o.exports,o,o.exports,r),o.loaded=!0,o.exports}
    r.m = __webpack_modules__;
    r.c = __webpack_module_cache__;
    r.u = function (e) { return e + ".js"; };
    r.p = "/assets/";
    globalThis.__fakeWreq = r;
})();`;

// The plugin's real jsx shims need Discord's React (not in this fake page): record the calls instead.
const SPIES = `(() => {
    const p = ${P}; const calls = globalThis.__spyCalls = [];
    const spy = name => ({ jsx: (t, props) => (calls.push([name, "jsx", t?.name]), "SPY:" + name), jsxs: (t, props) => (calls.push([name, "jsxs", t?.name]), "SPY:" + name) });
    p.panelJsx = spy("panelJsx"); p.voiceUserIconsJsx = spy("voiceUserIconsJsx");
    const real = p.renderCallTileStream;
    p.renderCallTileStream = (participant, isUser) => (calls.push(["renderCallTileStream", isUser]), isUser ? "SPY:tile" : real(participant, isUser));
})();`;

async function boot(code, storedSettings) {
    const page = makePage({ storedSettings, pluginHelpers: { Telinha: { listSources: async () => ({ sources: [] }) } } });
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

const queuedPatches = $ => JSON.parse($(`JSON.stringify(Vencord.WebpackPatcher.patches.filter(p => p.plugin === "Telinha").map(p => ({ find: String(p.find), match: [].concat(p.replacement).map(r => String(r.match)) })))`));

// ------------------------------------------------------------------------------------------- A: fresh install
console.log("A first boot (no saved settings)");
let saved;
let finds;
{
    const p = await boot(page0.code, {});
    const { $ } = p;
    check("Vencord renderer evaluated, Vencord global defined", !p.thrown && $("typeof Vencord") === "object", String(p.thrown));
    check("add-on ran via ipc-hook with PluginMeta patched", $("JSON.stringify(__TelinhaAddonBoot)") === JSON.stringify({ via: "ipc-hook", metaPatched: true, metaReason: null }));
    check("registered into Vencord.Plugins.plugins, enabled by default, before webpack", $("JSON.stringify(TelinhaAddon.registrations.Telinha)") === '{"enabled":true,"webpackAlreadyRunning":false}' && $("Vencord.Webpack.wreq === undefined"));
    const queued = queuedPatches($);
    check("3 patches queued in Vencord's patch list (account panel, voice user row, call tile)", queued.length === 3, queued);
    finds = {
        account: commentSafe(queued.find(q => q.match[0].includes("userTag"))?.find),
        voiceUser: commentSafe(queued.find(q => q.match[0].includes("isHovered"))?.find)
    };
    check("intl finds canonicalised by Vencord (no #{intl::} left)", queued.every(q => !q.find.includes("#{intl::")) && finds.account && finds.voiceUser, queued.map(q => q.find));
    check("settings UI source (Object.values(plugins)) lists it, with a settings cog", $(`Object.values(Vencord.Plugins.plugins).some(p => p.name === "Telinha") && Vencord.Plugins.hasAnyVisibleSettings(${P})`));
    check("settings defaults", $(`JSON.stringify([Vencord.Settings.plugins.Telinha.enabled, Vencord.Settings.plugins.Telinha.codec, Vencord.Settings.plugins.Telinha.rejectOutsiders, Vencord.Settings.plugins.Telinha.groupPassword])`) === '[true,"auto",true,""]');

    $(SPIES);
    runScript(p.context, fakeWebpack(finds), "https://discord.com/assets/web.fake0001.js");
    check("Vencord adopted the fake Discord webpack instance", $("Vencord.Webpack.wreq === __fakeWreq"));
    check("PATCH APPLIED account panel: jsx routed through $self.panelJsx", $(`__fakeWreq(5001).render("TAG")`) === "SPY:panelJsx");
    check("PATCH APPLIED voice user row: jsx routed through $self.voiceUserIconsJsx", $(`__fakeWreq(5002).row({ id: "1" }, true)`) === "SPY:voiceUserIconsJsx");
    const tile = JSON.parse($(`JSON.stringify(__fakeWreq(5003).tile({ type: "USER", user: { id: "42" } }, "E2", false))`));
    check("PATCH APPLIED call tile: $self.renderCallTileStream inserted right after the tile content", tile[1] === "E2" && tile[2] === "SPY:tile" && tile[3] === "overlay", tile);
    const tile2 = JSON.parse($(`JSON.stringify(__fakeWreq(5003).tile({ type: "STREAM", user: { id: "42" } }, "E2", false))`));
    check("call tile, non-user participant: the plugin's real renderCallTileStream returns null", tile2[2] === null && tile2.length === 4, tile2);
    check("other modules untouched", $("__fakeWreq(5004).other()") === "untouched");
    check("all applied patches left Vencord's pending list", $(`Vencord.WebpackPatcher.patches.filter(p => p.plugin === "Telinha").length`) === 0);
    check("no 'Patch by Telinha errored/had no effect' on the console", !p.consoleLines.some(l => /Patch by Telinha/.test(l)), p.consoleLines.filter(l => /Patch by/.test(l)));

    $(`Vencord.Settings.plugins.Telinha.codec = "vp9"; Vencord.Settings.plugins.Telinha.rejectOutsiders = false; Vencord.Settings.plugins.Telinha.groupPassword = "senha-teste";`);
    await sleep(10);
    const last = p.savedSettings.at(-1);
    check("setting changes persisted through VencordNative.settings.set", last?.plain?.plugins?.Telinha?.codec === "vp9" && last.plain.plugins.Telinha.rejectOutsiders === false && last.plain.plugins.Telinha.groupPassword === "senha-teste", last?.plain?.plugins?.Telinha);
    check("the plugin reads the live values", $(`JSON.stringify([${P}.settings.store.codec, ${P}.settings.store.rejectOutsiders])`) === '["vp9",false]');

    let pluginList = null;
    try {
        pluginList = $(`Vencord.Plugins.plugins.SupportHelper.commands.find(c => c.name === "vencord-plugins").execute().content`);
    } catch (e) {
        pluginList = "THREW " + e;
    }
    check("SupportHelper /vencord-plugins works and lists Telinha as a UserPlugin", /Enabled UserPlugins \(1\)[\s\S]*Telinha/.test(pluginList), pluginList?.slice?.(0, 200));
    check("toolbox actions + settings about component exposed", $(`typeof ${P}.toolboxActions === "function" && typeof ${P}.settingsAboutComponent === "function"`));
    check("context menu patch exposed for Vencord's startPlugin", $(`typeof ${P}.contextMenus?.["user-context"] === "function"`));
    check("toggle needs restart (has patches), like any patching plugin", $(`Vencord.Plugins.pluginRequiresRestart(${P})`) === true);
    check("styles.css injected as a <style> once the document has a head", $(`document.head.children.some(c => c.id === "telinha-addon-styles.css" && c.textContent.length > 1000)`));

    $(`Vencord.Settings.plugins.Telinha.enabled = false`);
    await sleep(10);
    saved = p.savedSettings.at(-1).plain;
    check("disabled state persisted, other settings kept", saved.plugins.Telinha.enabled === false && saved.plugins.Telinha.codec === "vp9");
    const errors = p.consoleLines.filter(l => /^\[error\]/.test(l));
    check("no console errors", errors.length === 0, errors.slice(0, 3));
}

// ------------------------------------------------------------------------------------------- B: restart, disabled
console.log("\nB restart with the plugin disabled");
{
    const p = await boot(page0.code, saved);
    const { $ } = p;
    check("still listed (toggleable) but not enabled", $(`"Telinha" in Vencord.Plugins.plugins`) && $("TelinhaAddon.registrations.Telinha.enabled") === false);
    check("no patches queued while disabled", $(`Vencord.WebpackPatcher.patches.filter(p => p.plugin === "Telinha").length`) === 0);
    $(`Vencord.Settings.plugins.Telinha.enabled = true`);
    await sleep(10);
    saved = p.savedSettings.at(-1).plain;
}

// ------------------------------------------------------------------------------------------- C: restart, re-enabled
console.log("\nC restart after re-enabling");
{
    const p = await boot(page0.code, saved);
    const { $ } = p;
    $(SPIES);
    runScript(p.context, fakeWebpack(finds), "https://discord.com/assets/web.fake0002.js");
    check("enabled again, saved settings survived restarts, patches applied", $("TelinhaAddon.registrations.Telinha.enabled") === true && $(`${P}.settings.store.codec`) === "vp9" && $(`__fakeWreq(5001).render("T")`) === "SPY:panelJsx");
}

// ------------------------------------------------------------------------------------------- D: control
console.log("\nD control: same add-on WITHOUT the PluginMeta entry");
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

// ------------------------------------------------------------------------------------------- E: no Vencord
console.log("\nE Telinha renderer without Vencord (e.g. served alone): refuses quietly");
{
    const p = await boot(wrapAddonRenderer(addonJs, { via: "control" }), {});
    check("no throw out of the wrapper, error logged once", !p.thrown && p.consoleLines.some(l => /Vencord renderer not found/.test(l)), p.consoleLines.slice(0, 3));
}

if (asyncErrors.length) console.log(`\n(async errors in the fake page: ${asyncErrors.map(e => String(e).split("\n")[0].slice(0, 140)).join(" | ")})`);
finish();
