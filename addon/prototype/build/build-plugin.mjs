/*
 * Feasibility build: bundles an UNCHANGED Vencord-style plugin folder (default: src/plugins/peerLive) as an addon
 * payload for official Vencord, then smoke-tests the result offline.
 *
 *   node addon/prototype/build/build-plugin.mjs [--plugin src/plugins/peerLive] [--out <dir>] [--vencord-dist <dir>]
 *
 * Renderer bundle: Vencord's own modules are NOT bundled; every `@api/*`, `@components/*`, `@utils/*`,
 * `@webpack(/common)` import becomes a tiny shim reading the running Vencord's `window.Vencord` exports, so the
 * plugin shares Vencord's settings store, webpack finders, plugin manager and React. Plain `.css` imports become
 * a <style> tag. Main bundle: native.ts with `@main/csp` shimmed to a global the loader merges into its CSP chain.
 * Output (default %TEMP%\pl-addon\build): <name>.renderer.js, <name>.main.js, addon.json, shims-used.json.
 */
import esbuild from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = resolve(HERE, "..");
const REPO = resolve(PROTO, "..", "..");
const arg = (name, def) => (process.argv.indexOf(name) !== -1 ? process.argv[process.argv.indexOf(name) + 1] : def);

const pluginDir = resolve(REPO, arg("--plugin", "src/plugins/peerLive"));
const outDir = resolve(arg("--out", join(tmpdir(), "pl-addon", "build")));
mkdirSync(outDir, { recursive: true });
const used = { renderer: new Set(), main: new Set() };

// ------------------------------------------------------------------------------------------- shims
const UTILS_TYPES_SHIM = `
export default function definePlugin(p) { return p; }
export const OptionType = { STRING: 0, NUMBER: 1, BIGINT: 2, BOOLEAN: 3, SELECT: 4, SLIDER: 5, COMPONENT: 6, CUSTOM: 7 };
export const StartAt = { Init: "Init", DOMContentLoaded: "DOMContentLoaded", WebpackReady: "WebpackReady" };
export const ReporterTestable = { None: 2, Start: 4, Patches: 8, FluxEvents: 16 };
`;

function rendererShim(path) {
    if (path === "@utils/types") return UTILS_TYPES_SHIM; // pure: definePlugin is identity, enums are constants
    if (path === "@webpack/common") return "module.exports = Vencord.Webpack.Common;";
    if (path === "@webpack") return "module.exports = Vencord.Webpack;";
    let m;
    if ((m = /^@api\/(\w+)$/.exec(path))) return `module.exports = Vencord.Api.${m[1]};`;
    // __esModule so esbuild's interop uses `default` (e.g. `import ErrorBoundary from "@components/ErrorBoundary"`)
    if ((m = /^@components\/(\w+)$/.exec(path))) return `module.exports = { ...Vencord.Components, __esModule: true, default: Vencord.Components.${m[1]} };`;
    if (/^@utils\/\w+$/.test(path)) return "module.exports = Vencord.Util;";
    return null;
}

const vencordShimPlugin = (kind) => ({
    name: "vencord-shims",
    setup(build) {
        build.onResolve({ filter: /^(@api|@components|@utils|@webpack|@shared|@main|@debug)(\/|$)|^~/ }, ({ path }) => {
            if (kind === "main" && path === "@main/csp") return { path, namespace: "vencord-shim" };
            if (kind === "renderer" && rendererShim(path) != null) return { path, namespace: "vencord-shim" };
            return { errors: [{ text: `${path} has no addon shim (${kind} bundle): it would bundle a private copy of Vencord internals` }] };
        });
        build.onResolve({ filter: /^@vencord\/discord-types/ }, ({ path }) => ({ errors: [{ text: `${path} must be a type-only import` }] }));
        build.onLoad({ filter: /.*/, namespace: "vencord-shim" }, ({ path }) => {
            used[kind].add(path);
            if (path === "@main/csp")
                return { contents: 'export const ConnectSrc = ["connect-src"]; export const ImageSrc = [...ConnectSrc, "img-src"]; export const CspPolicies = (globalThis.__PeerLiveAddonCsp ??= {});', loader: "js" };
            return { contents: rendererShim(path), loader: "js" };
        });
        if (kind === "renderer") {
            build.onLoad({ filter: /\.css$/ }, ({ path }) => ({
                loader: "js",
                contents: `const css = ${JSON.stringify(readFileSync(path, "utf8"))};
const add = () => { const s = document.createElement("style"); s.id = ${JSON.stringify("peerlive-addon-" + basename(path))}; s.textContent = css; document.head.append(s); };
document.head ? add() : document.addEventListener("DOMContentLoaded", add, { once: true });`
            }));
        }
    }
});

const defines = {
    IS_DEV: "false", IS_REPORTER: "false", IS_ANTI_CRASH_TEST: "false", IS_STANDALONE: "true", IS_UPDATER_DISABLED: "false",
    IS_WEB: "false", IS_EXTENSION: "false", IS_USERSCRIPT: "false", IS_DISCORD_DESKTOP: "true", IS_VESKTOP: "false",
    VERSION: JSON.stringify("addon"), BUILD_TIMESTAMP: String(Date.now())
};

// ------------------------------------------------------------------------------------------- build
const name = basename(pluginDir);
const indexFile = ["index.tsx", "index.ts"].map(f => join(pluginDir, f)).find(existsSync);
const nativeFile = ["native.ts", "native.tsx"].map(f => join(pluginDir, f)).find(existsSync);

const renderer = await esbuild.build({
    stdin: {
        contents: `import plugin from ${JSON.stringify("./" + relative(REPO, indexFile).replaceAll("\\", "/"))}; globalThis.__PeerLiveAddonRegister(plugin);`,
        resolveDir: REPO, sourcefile: "addon-entry.ts", loader: "ts"
    },
    bundle: true, format: "iife", target: ["esnext"], platform: "browser", minify: false, metafile: true, write: false,
    tsconfig: join(REPO, "tsconfig.json"),
    jsx: "transform", jsxFactory: "VencordCreateElement", jsxFragment: "VencordFragment",
    inject: [join(REPO, "scripts", "build", "inject", "react.mjs")],
    define: defines, logLevel: "warning",
    plugins: [vencordShimPlugin("renderer")]
});
const rendererJs = renderer.outputFiles[0].text;
writeFileSync(join(outDir, `${name}.renderer.js`), rendererJs);

let mainJs = null;
if (nativeFile) {
    const main = await esbuild.build({
        entryPoints: [nativeFile], bundle: true, format: "cjs", platform: "node", target: ["esnext"], minify: false, write: false,
        metafile: true, tsconfig: join(REPO, "tsconfig.json"), external: ["electron", "original-fs"], define: defines, logLevel: "warning",
        plugins: [vencordShimPlugin("main")]
    });
    mainJs = main.outputFiles[0].text;
    writeFileSync(join(outDir, `${name}.main.js`), mainJs);
}

const pluginName = /name:\s*"([^"]+)"/.exec(readFileSync(indexFile, "utf8"))?.[1] ?? name;
writeFileSync(join(outDir, "addon.json"), JSON.stringify({
    pluginName, renderer: `${name}.renderer.js`, ...(mainJs ? { main: `${name}.main.js` } : {}),
    meta: { folderName: `peerlive-addon/${name}`, userPlugin: true }, preloadFallback: true, csp: {}
}, null, 4));
const shims = { renderer: [...used.renderer].sort(), main: [...used.main].sort() };
writeFileSync(join(outDir, "shims-used.json"), JSON.stringify(shims, null, 2));
const vencordInputs = Object.keys(renderer.metafile.inputs).filter(i => /^src\/(?!plugins\/)/.test(i.replaceAll("\\", "/")));

console.log(`built ${pluginName}: renderer ${(rendererJs.length / 1024).toFixed(0)} KiB${mainJs ? `, main ${(mainJs.length / 1024).toFixed(0)} KiB` : ""} -> ${outDir}`);
console.log("Vencord internals used through window.Vencord:", shims.renderer.join(", "));
console.log("Vencord source files bundled into the addon (must be none but the JSX inject):", vencordInputs.length ? vencordInputs : "none");

// ------------------------------------------------------------------------------------------- smoke
const { makePage, runScript } = await import("../test/vm-page.mjs");
const require = createRequire(import.meta.url);
const { buildRendererPayload } = require("../loader/payload.js");
const roaming = process.env.APPDATA && join(process.env.APPDATA, "Vencord");
const official = roaming && existsSync(roaming) && readdirSync(roaming).find(d => d.startsWith("dist.backup-oficial"));
const vencordDist = resolve(arg("--vencord-dist", official ? join(roaming, official) : join(REPO, "dist")));
const vencordJs = readFileSync(join(vencordDist, "renderer.js"), "utf8");

let ok = true;
const check = (label, cond, extra) => {
    console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${!cond && extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
    ok &&= !!cond;
};

if (vencordJs.includes(`name:"${pluginName}"`)) console.log(`(note: ${vencordDist} already bundles ${pluginName}; registration is expected to refuse the duplicate)`);
const addonJs = readFileSync(join(PROTO, "loader", "register.js"), "utf8") + "\n;\n" + rendererJs;
const page = makePage({ pluginHelpers: {} });
runScript(page.context, buildRendererPayload(vencordJs, addonJs, JSON.parse(readFileSync(join(outDir, "addon.json"), "utf8"))).code, "file:///VencordRenderer");
await new Promise(r => setTimeout(r, 50));
const $ = e => vm.runInContext(e, page.context);
console.log(`\nsmoke vs ${vencordDist}`);
const reg = $(`JSON.stringify(PeerLiveAddon.registrations[${JSON.stringify(pluginName)}] ?? null)`);
check(`${pluginName} registered in official Vencord (${reg})`, reg !== "null" && !reg.includes("error"), page.consoleLines.filter(l => /error|PeerLiveAddon/i.test(l)).slice(0, 5));
check("settings defined via the shared store", $(`typeof Vencord.Plugins.plugins[${JSON.stringify(pluginName)}]?.settings?.store`) === "object");
$(`Vencord.Settings.plugins[${JSON.stringify(pluginName)}].enabled = true`);
check("listed for the settings UI", $(`Object.values(Vencord.Plugins.plugins).some(p => p.name === ${JSON.stringify(pluginName)})`));

if (mainJs) {
    process.env.FAKE_ROOT ??= join(tmpdir(), "pl-addon", "build-fake-root");
    const Module = require("module");
    const fake = join(PROTO, "test", "fake", "electron-main.js");
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) { return req === "electron" ? fake : orig.call(this, req, ...rest); };
    const natives = require(join(outDir, `${name}.main.js`));
    Module._resolveFilename = orig;
    const fns = Object.keys(natives).filter(k => typeof natives[k] === "function");
    console.log("natives exported:", fns.join(", "));
    check("main bundle loads with plain electron and exports natives", fns.length > 0);
    check("native.ts CSP additions captured for the loader", Object.keys(globalThis.__PeerLiveAddonCsp ?? {}).length > 0, globalThis.__PeerLiveAddonCsp);
}
console.log(ok ? "\nBUILD SMOKE PASSED" : "\nBUILD SMOKE FAILED");
process.exit(ok ? 0 : 1);
