/*
 * Builds the Telinha add-on payload for the OFFICIAL Vencord (contract: addon/PAYLOAD.md), then smoke-tests it.
 *
 *   pnpm build:addon            (= node addon/build/build-addon.mjs)
 *   options: --out <dir>            default dist/addon
 *            --helper <exe>         default native-audio/bin/telinha-audio.exe, else dist/telinha-audio.exe
 *            --vencord-dist <dir>   official Vencord build for the smoke (default %APPDATA%\Vencord\dist.backup-oficial-*)
 *            --skip-smoke
 *
 * Output: <out>/payload/ (the files of %APPDATA%\Telinha\addon\), <out>/Telinha-addon-<commit>.zip (+ .sha256).
 *
 * The plugin (src/plugins/telinha) is compiled against this repo's Vencord sources WITHOUT bundling Vencord: every
 * `@api/*`, `@components/*`, `@utils/*`, `@webpack(/common)` import becomes a shim over the running Vencord's
 * `window.Vencord` exports (shared settings store, finders, React). `@utils/types` is the only inlined module (identity
 * definePlugin + enum constants, checked against src/utils/types.ts). Any other Vencord import fails the build.
 * Natives: native.ts as CommonJS, `@main/csp` shimmed to a global the loader merges into its CSP chain.
 */
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import esbuild from "esbuild";
import { zipSync } from "fflate";
import { builtinModules, createRequire } from "module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const ADDON_VERSION = "0.1.0";
const PLUGIN_DIR = "src/plugins/telinha";
const PLUGIN_NAME = "Telinha";
const HELPER = "telinha-audio.exe";
const LOADER_FILES = ["main.js", "payload.js", "preload.js", "register.js", "stub-template.js"];

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDON = resolve(HERE, "..");
const REPO = resolve(ADDON, "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);

function die(msg) {
    console.error(`\n[build:addon] FAILED - ${msg}`);
    process.exit(1);
}

const git = (...a) => {
    try {
        return execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
};
const sha256 = buf => createHash("sha256").update(buf).digest("hex");

// ------------------------------------------------------------------------------------------- inputs
const outRoot = resolve(REPO, arg("--out", "dist/addon"));
const payloadDir = join(outRoot, "payload");

const helperCandidates = arg("--helper") ? [resolve(arg("--helper"))] : [join(REPO, "native-audio", "bin", HELPER), join(REPO, "dist", HELPER)];
const helperSrc = helperCandidates.find(existsSync);
if (!helperSrc) die(`${HELPER} not found (looked in ${helperCandidates.join(", ")}). Build it with: native-audio\\build.cmd --copy-to-dist`);
const otherHelper = helperCandidates.find(p => p !== helperSrc && existsSync(p));
if (otherHelper && sha256(readFileSync(otherHelper)) !== sha256(readFileSync(helperSrc)))
    console.warn(`[build:addon] warning: ${otherHelper} differs from ${helperSrc}; using the latter`);

const shortHead = git("rev-parse", "--short=8", "HEAD") ?? "nogit";
const dirty = !!git("status", "--porcelain");
const commit = shortHead + (dirty ? "-dirty" : "");
const vencordBaseCommit = (git("merge-base", "HEAD", "upstream/main") ?? "").slice(0, 8) || null;
if (!vencordBaseCommit) console.warn("[build:addon] warning: could not find the upstream Vencord base commit (git remote 'upstream' missing?)");
const vencordVersion = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const builtAt = new Date().toISOString();

// ------------------------------------------------------------------------------------------- shims
const UTILS_TYPES_SHIM = `
export default function definePlugin(p) { return p; }
export const OptionType = { STRING: 0, NUMBER: 1, BIGINT: 2, BOOLEAN: 3, SELECT: 4, SLIDER: 5, COMPONENT: 6, CUSTOM: 7 };
export const StartAt = { Init: "Init", DOMContentLoaded: "DOMContentLoaded", WebpackReady: "WebpackReady" };
export const ReporterTestable = { None: 2, Start: 4, Patches: 8, FluxEvents: 16 };
`;

/** The window.Vencord object a Vencord module path maps to (named imports are read from it), or null. */
function shimTarget(path) {
    let m;
    if (path === "@webpack/common") return "Vencord.Webpack.Common";
    if (path === "@webpack") return "Vencord.Webpack";
    if ((m = /^@api\/(\w+)$/.exec(path))) return `Vencord.Api.${m[1]}`;
    if (/^@components\/\w+$/.test(path)) return "Vencord.Components";
    if (/^@utils\/\w+$/.test(path) && path !== "@utils/types") return "Vencord.Util";
    return null;
}

function rendererShim(path) {
    if (path === "@utils/types") return UTILS_TYPES_SHIM; // pure: definePlugin is identity, enums are constants
    const m = /^@components\/(\w+)$/.exec(path);
    // __esModule so esbuild's interop uses `default` (`import ErrorBoundary from "@components/ErrorBoundary"`)
    if (m) return `module.exports = { ...Vencord.Components, __esModule: true, default: Vencord.Components.${m[1]} };`;
    const target = shimTarget(path);
    return target ? `module.exports = ${target};` : null;
}

const used = { renderer: new Set(), main: new Set() };
const builtinRe = new RegExp(`^(node:)?(${builtinModules.map(m => m.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")})$`);

const vencordShimPlugin = kind => ({
    name: "telinha-addon-shims",
    setup(build) {
        build.onResolve({ filter: /^(@api|@components|@utils|@webpack|@shared|@main|@debug)(\/|$)|^~/ }, ({ path }) => {
            if (kind === "main" && path === "@main/csp") return { path, namespace: "vencord-shim" };
            if (kind === "renderer" && rendererShim(path) != null) return { path, namespace: "vencord-shim" };
            return { errors: [{ text: `${path} has no add-on shim (${kind} bundle): it would bundle a private copy of Vencord internals` }] };
        });
        build.onResolve({ filter: /^@vencord\/discord-types/ }, ({ path }) => ({ errors: [{ text: `${path} must be a type-only import` }] }));
        if (kind === "renderer") {
            build.onResolve({ filter: builtinRe }, ({ path }) => ({ errors: [{ text: `${path}: node builtins can't be used in the renderer (use native.ts)` }] }));
            build.onResolve({ filter: /^(react|electron(\/.*)?)$/ }, ({ path }) => ({ errors: [{ text: `${path} can't be imported in the renderer` }] }));
            build.onLoad({ filter: /\.css$/ }, ({ path }) => ({
                loader: "js",
                contents: `const css = ${JSON.stringify(readFileSync(path, "utf8"))};
const add = () => { if (document.getElementById(${JSON.stringify("telinha-addon-" + basename(path))})) return; const s = document.createElement("style"); s.id = ${JSON.stringify("telinha-addon-" + basename(path))}; s.textContent = css; document.head.append(s); };
document.head ? add() : document.addEventListener("DOMContentLoaded", add, { once: true });`
            }));
        }
        build.onLoad({ filter: /.*/, namespace: "vencord-shim" }, ({ path }) => {
            used[kind].add(path);
            if (path === "@main/csp")
                return { contents: 'export const ConnectSrc = ["connect-src"]; export const ImageSrc = [...ConnectSrc, "img-src"]; export const CspPolicies = (globalThis.__TelinhaAddonCsp ??= {});', loader: "js" };
            return { contents: rendererShim(path), loader: "js" };
        });
    }
});

const defines = {
    IS_DEV: "false", IS_REPORTER: "false", IS_ANTI_CRASH_TEST: "false", IS_STANDALONE: "true", IS_UPDATER_DISABLED: "false",
    IS_WEB: "false", IS_EXTENSION: "false", IS_USERSCRIPT: "false", IS_DISCORD_DESKTOP: "true", IS_VESKTOP: "false",
    VERSION: JSON.stringify(`telinha-addon-${ADDON_VERSION}`), BUILD_TIMESTAMP: String(Date.parse(builtAt))
};

/** OptionType / StartAt in the shim must equal src/utils/types.ts (const enums are inlined by Vencord's build). */
function checkTypesShim() {
    const src = readFileSync(join(REPO, "src", "utils", "types.ts"), "utf8");
    const enumBody = name => /export const enum (\w+) \{([\s\S]*?)\}/g;
    const found = {};
    for (const m of src.matchAll(enumBody())) found[m[1]] = m[2];
    const optionType = (found.OptionType ?? "").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "").split(",").map(s => s.trim()).filter(Boolean);
    const expectOption = { STRING: 0, NUMBER: 1, BIGINT: 2, BOOLEAN: 3, SELECT: 4, SLIDER: 5, COMPONENT: 6, CUSTOM: 7 };
    const actualOption = Object.fromEntries(optionType.map((k, i) => [k, i]));
    if (JSON.stringify(actualOption) !== JSON.stringify(expectOption)) die(`@utils/types shim OptionType out of date: ${JSON.stringify(actualOption)}`);
    const startAt = [...(found.StartAt ?? "").matchAll(/(\w+)\s*=\s*"(\w+)"/g)].map(m => m[1] + "=" + m[2]).join(",");
    if (startAt !== "Init=Init,DOMContentLoaded=DOMContentLoaded,WebpackReady=WebpackReady") die(`@utils/types shim StartAt out of date: ${startAt}`);
}

// ------------------------------------------------------------------------------------------- build
checkTypesShim();
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(payloadDir, { recursive: true });

const pluginAbs = join(REPO, PLUGIN_DIR);
const indexFile = ["index.tsx", "index.ts"].map(f => join(pluginAbs, f)).find(existsSync);
const nativeFile = ["native.ts", "native.tsx"].map(f => join(pluginAbs, f)).find(existsSync);
if (!indexFile || !nativeFile) die(`${PLUGIN_DIR} must have index.tsx and native.ts`);
const banner = `/* Telinha add-on ${ADDON_VERSION} (${commit}), built ${builtAt} from ${PLUGIN_DIR} against Vencord ${vencordBaseCommit ?? "?"}. GPL-3.0-or-later. */`;

let renderer;
try {
    renderer = await esbuild.build({
        stdin: {
            contents: `import plugin from ${JSON.stringify("./" + relative(REPO, indexFile).replaceAll("\\", "/"))};
// Installed on purpose by the user: on by default (an explicit choice saved in Vencord's settings still wins).
plugin.enabledByDefault ??= true;
if (typeof globalThis.__TelinhaAddonRegister === "function") globalThis.__TelinhaAddonRegister(plugin);
else console.error("[Telinha] addon: register.js did not run; plugin not registered");`,
            resolveDir: REPO, sourcefile: "telinha-addon-entry.ts", loader: "ts"
        },
        bundle: true, format: "iife", target: ["esnext"], platform: "browser", minify: false, metafile: true, write: false,
        banner: { js: banner }, legalComments: "eof",
        tsconfig: join(REPO, "tsconfig.json"),
        jsx: "transform", jsxFactory: "VencordCreateElement", jsxFragment: "VencordFragment",
        inject: [join(REPO, "scripts", "build", "inject", "react.mjs")],
        define: defines, logLevel: "warning",
        plugins: [vencordShimPlugin("renderer")]
    });
} catch (e) {
    die(`renderer bundle: ${e.message}`);
}

let main;
try {
    main = await esbuild.build({
        entryPoints: [nativeFile], bundle: true, format: "cjs", platform: "node", target: ["esnext"], minify: false, write: false,
        metafile: true, tsconfig: join(REPO, "tsconfig.json"), external: ["electron", "original-fs"], logLevel: "warning",
        banner: { js: banner }, define: defines,
        plugins: [vencordShimPlugin("main")]
    });
} catch (e) {
    die(`main bundle: ${e.message}`);
}

// No Vencord source may end up inside the add-on (it must use the user's official Vencord at runtime)
const repoInputs = meta => Object.keys(meta.inputs).map(i => i.replaceAll("\\", "/")).filter(i => !i.startsWith("node_modules/") && !i.includes(":"));
const foreign = [...repoInputs(renderer.metafile), ...repoInputs(main.metafile)]
    .filter(i => !i.startsWith(PLUGIN_DIR + "/") && i !== "scripts/build/inject/react.mjs" && i !== "telinha-addon-entry.ts");
if (foreign.length) die(`Vencord sources would be bundled into the add-on: ${[...new Set(foreign)].join(", ")}`);

const rendererJs = renderer.outputFiles[0].text;
const mainJs = main.outputFiles[0].text;
writeFileSync(join(payloadDir, "telinha.renderer.js"), rendererJs);
writeFileSync(join(payloadDir, "telinha.main.js"), mainJs);
for (const f of LOADER_FILES) copyFileSync(join(ADDON, "loader", f), join(payloadDir, f));
copyFileSync(helperSrc, join(payloadDir, HELPER));

const manifest = {
    format: 1,
    pluginName: PLUGIN_NAME,
    renderer: "telinha.renderer.js",
    main: "telinha.main.js",
    meta: { folderName: "telinha-addon", userPlugin: true },
    helperDirEnv: "TELINHA_HELPER_DIR",
    preloadFallback: true,
    csp: {}
};
writeFileSync(join(payloadDir, "addon.json"), JSON.stringify(manifest, null, 4) + "\n");

const files = {};
for (const name of readdirSync(payloadDir).sort()) {
    const buf = readFileSync(join(payloadDir, name));
    files[name] = { size: buf.length, sha256: sha256(buf) };
}
const version = {
    name: "Telinha", payloadFormat: 1, version: ADDON_VERSION, commit, vencordBaseCommit, vencordVersion, builtAt,
    pluginName: PLUGIN_NAME, loaderEntry: "main.js", stubTemplate: "stub-template.js", stubFormat: 1, files
};
writeFileSync(join(payloadDir, "version.json"), JSON.stringify(version, null, 4) + "\n");

const zipName = `Telinha-addon-${commit}.zip`;
const mtime = new Date(builtAt);
const zipEntries = Object.fromEntries([...Object.keys(files), "version.json"].map(n => [n, [readFileSync(join(payloadDir, n)), { mtime, level: n.endsWith(".exe") ? 6 : 9 }]]));
const zip = Buffer.from(zipSync(zipEntries));
writeFileSync(join(outRoot, zipName), zip);
const zipHash = sha256(zip);
writeFileSync(join(outRoot, zipName + ".sha256"), `${zipHash}  ${zipName}\n`);

const shims = { renderer: [...used.renderer].sort(), main: [...used.main].sort() };
console.log(`built Telinha add-on ${ADDON_VERSION} (${commit}), Vencord base ${vencordBaseCommit}`);
console.log(`  renderer ${(rendererJs.length / 1024).toFixed(0)} KiB, natives ${(mainJs.length / 1024).toFixed(0)} KiB, helper ${relative(REPO, helperSrc)}`);
console.log(`  Vencord internals used through window.Vencord: ${shims.renderer.join(", ")}`);
console.log(`  payload: ${payloadDir}`);
for (const [n, f] of Object.entries(files)) console.log(`    ${n.padEnd(22)} ${String(f.size).padStart(8)}  ${f.sha256}`);
console.log(`  zip: ${join(outRoot, zipName)}\n  sha256: ${zipHash}`);

// ------------------------------------------------------------------------------------------- smoke
if (argv.includes("--skip-smoke")) {
    console.log("\n(smoke skipped)");
    process.exit(0);
}

const roaming = process.env.APPDATA && join(process.env.APPDATA, "Vencord");
const official = roaming && existsSync(roaming) && readdirSync(roaming).find(d => d.startsWith("dist.backup-oficial"));
const vencordDist = arg("--vencord-dist") ? resolve(arg("--vencord-dist")) : official ? join(roaming, official) : null;
if (!vencordDist || !existsSync(join(vencordDist, "renderer.js")))
    die("no official Vencord build for the smoke: pass --vencord-dist <dir with renderer.js> (or --skip-smoke)");
const vencordJs = readFileSync(join(vencordDist, "renderer.js"), "utf8");
const vencordHeader = vencordJs.slice(0, 200).split("\n")[0];

let failures = 0;
const check = (label, cond, extra) => {
    console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${!cond && extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
    if (!cond) failures++;
};
console.log(`\nsmoke vs ${vencordDist}  [${vencordHeader}]`);
const officialCommit = /Vencord ([0-9a-f]{7,})/.exec(vencordHeader)?.[1];
if (officialCommit && vencordBaseCommit && !vencordBaseCommit.startsWith(officialCommit) && !officialCommit.startsWith(vencordBaseCommit))
    console.warn(`  (note: official Vencord ${officialCommit} differs from the base commit ${vencordBaseCommit})`);
check("official Vencord renderer does not already bundle Telinha", !/name:"Telinha"/.test(vencordJs));

// Renderer: official renderer.js + exactly what the loader serves
const { makePage, runScript } = await import("../test/vm-page.mjs");
const { buildRendererPayload } = require("../loader/payload.js");
const addonJs = readFileSync(join(payloadDir, "register.js"), "utf8") + "\n;\n" + rendererJs;
const served = buildRendererPayload(vencordJs, addonJs, manifest);
check("PluginMeta entry patched into the served Vencord renderer", served.metaPatched, served.metaReason);
const page = makePage({ pluginHelpers: { Telinha: {} } });
let thrown = null;
try {
    runScript(page.context, served.code, "file:///VencordRenderer");
} catch (e) {
    thrown = e;
}
await new Promise(r => setTimeout(r, 50));
const $ = e => vm.runInContext(e, page.context);
const N = JSON.stringify(PLUGIN_NAME);
check("Vencord renderer + add-on evaluated", !thrown && $("typeof Vencord") === "object", String(thrown));
const reg = $(`JSON.stringify(globalThis.TelinhaAddon?.registrations?.[${N}] ?? null)`);
check(`Telinha registered, enabled, before webpack (${reg})`, reg === '{"enabled":true,"webpackAlreadyRunning":false}', page.consoleLines.filter(l => /error|Telinha/i.test(l)).slice(0, 5));
const pluginPatches = $(`Vencord.Plugins.plugins[${N}]?.patches?.length ?? -1`);
const queued = $(`Vencord.WebpackPatcher.patches.filter(p => p.plugin === ${N}).length`);
check(`all ${pluginPatches} patches queued in Vencord's patch list`, pluginPatches > 0 && queued === pluginPatches, { pluginPatches, queued });
check("$self canonicalised to Vencord.Plugins.plugins[\"Telinha\"]", $(`Vencord.WebpackPatcher.patches.filter(p => p.plugin === ${N}).every(p => [].concat(p.replacement).every(r => typeof r.replace === "function" || String(r.replace).includes('Vencord.Plugins.plugins["Telinha"]')))`));
check("listed for Settings -> Plugins, with a settings cog", $(`Object.values(Vencord.Plugins.plugins).some(p => p.name === ${N}) && Vencord.Plugins.hasAnyVisibleSettings(Vencord.Plugins.plugins[${N}])`));
check("settings defaults through Vencord's store", $(`Vencord.Settings.plugins[${N}].codec === "auto" && Vencord.Settings.plugins[${N}].rejectOutsiders === true && Vencord.Plugins.plugins[${N}].settings.store.defaultQuality === "1080p60"`));
$(`Vencord.Settings.plugins[${N}].codec = "vp9"`);
await new Promise(r => setTimeout(r, 10));
check("setting change visible to the plugin and persisted via VencordNative.settings.set", $(`Vencord.Plugins.plugins[${N}].settings.store.codec`) === "vp9" && page.savedSettings.at(-1)?.plain?.plugins?.Telinha?.codec === "vp9");
check("no CSS/style or registration errors on the console", !page.consoleLines.some(l => /^\[error\]/.test(l) && /Telinha/i.test(l)), page.consoleLines.filter(l => /^\[error\]/.test(l)).slice(0, 3));

// ABI: every property the bundle reads from a Vencord shim (`import_X.name`) exists in this official build
const requireToShim = Object.fromEntries([...rendererJs.matchAll(/var (require_\w+) = __commonJS\(\{\s*"vencord-shim:([^"]+)"/g)].map(m => [m[1], m[2]]));
const importToShim = Object.fromEntries([...rendererJs.matchAll(/var (import_\w+) = __toESM\((require_\w+)\(\)/g)].filter(m => requireToShim[m[2]]).map(m => [m[1], requireToShim[m[2]]]));
const accessed = new Set();
for (const m of rendererJs.matchAll(/\b(import_\w+)\.([A-Za-z_$][\w$]*)/g)) if (importToShim[m[1]]) accessed.add(`${importToShim[m[1]]}:${m[2]}`);
const missing = [...accessed].filter(key => {
    const [path, name] = key.split(":");
    const component = /^@components\/(\w+)$/.exec(path);
    if (component && name === "default") return !$(`Vencord.Components[${JSON.stringify(component[1])}] != null`);
    const target = shimTarget(path);
    return !target || !$(`(${target}) != null && ${JSON.stringify(name)} in (${target})`);
});
check(`ABI: all ${accessed.size} Vencord exports the bundle uses exist in the official build`, accessed.size > 10 && !missing.length, missing);

// Natives: the CommonJS bundle loads with plain electron, exports the natives, feeds the CSP, finds the helper via the loader's env var
process.env.FAKE_ROOT ??= mkdtempSync(join(tmpdir(), "tl-build-"));
const Module = require("module");
const fakeElectron = join(ADDON, "test", "fake", "electron-main.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === "electron" ? fakeElectron : origResolve.call(this, req, ...rest); };
const emptyHelperDir = mkdtempSync(join(tmpdir(), "tl-helper-"));
process.env.TELINHA_HELPER_DIR = emptyHelperDir;
let natives = {};
try {
    natives = require(join(payloadDir, "telinha.main.js"));
} catch (e) {
    check("natives bundle loads", false, String(e));
}
Module._resolveFilename = origResolve;
const fns = Object.keys(natives).filter(k => typeof natives[k] === "function");
const declared = [...readFileSync(nativeFile, "utf8").matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]).sort();
check(`natives exported (${fns.length}): ${fns.join(", ")}`, JSON.stringify([...fns].sort()) === JSON.stringify(declared) && fns.includes("screenAudioStatus"), declared);
const relays = Object.keys(globalThis.__TelinhaAddonCsp ?? {});
check(`native.ts CSP additions captured for the loader (${relays.length} relays)`, relays.length === 8 && relays.every(r => r.startsWith("wss://")), relays);
if (process.platform === "win32" && natives.screenAudioStatus) {
    const st = await natives.screenAudioStatus({});
    check("helper looked up in TELINHA_HELPER_DIR (empty dir -> 'não foi instalado', nothing spawned)", st?.available === false && /não foi instalado/.test(st.reason), st);
}
rmSync(emptyHelperDir, { recursive: true, force: true });
delete process.env.TELINHA_HELPER_DIR;
check(`${HELPER} in the payload is a PE executable`, readFileSync(join(payloadDir, HELPER)).subarray(0, 2).toString() === "MZ" && statSync(join(payloadDir, HELPER)).size > 4096);

console.log(failures ? `\nBUILD SMOKE FAILED (${failures})` : "\nBUILD SMOKE PASSED");
process.exit(failures ? 1 : 0);
