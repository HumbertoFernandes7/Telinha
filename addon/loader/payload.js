/*
 * Telinha add-on - pure helpers shared by the main-process loader and the offline tests
 * (no electron import here, so tests can load this file directly).
 */
"use strict";

// Vencord's generated `~plugins` module (scripts/build/common.mjs:184-188) emits
//   export const PluginMeta = { [p0.name]: {"folderName":..., "userPlugin":...}, ... }
// which esbuild minifies to `Xx={[a.name]:{folderName:"_api/badges",userPlugin:!1},...`.
// PluginMeta is module-private (not reachable from window.Vencord), but the settings modal
// (src/components/settings/tabs/plugins/PluginModal.tsx:167-177) and SupportHelper's /vencord-plugins
// (src/plugins/_core/supportHelper.tsx:116-117) dereference PluginMeta[plugin.name] without `?.`.
const PLUGIN_META_RE = /([\w$]+\s*=\s*\{\s*)(\[[\w$]+\.name\]\s*:\s*\{\s*"?folderName"?\s*:)/g;

/** Inserts `"<name>": <meta>` as the first entry of Vencord's PluginMeta object literal. */
function patchPluginMeta(code, pluginName, meta) {
    const matches = [...code.matchAll(PLUGIN_META_RE)];
    if (matches.length !== 1)
        return { code, ok: false, reason: `expected 1 PluginMeta literal, found ${matches.length}` };

    const at = matches[0].index + matches[0][1].length;
    const entry = `${JSON.stringify(pluginName)}:${JSON.stringify(meta)},`;
    return { code: code.slice(0, at) + entry + code.slice(at), ok: true, reason: null };
}

/**
 * Wraps the addon renderer so it runs as its own script (own sourceURL, own try/catch) right after the code
 * it is appended to. Indirect eval keeps Vencord's `//# sourceURL` / `//# sourceMappingURL` footer the last
 * magic comments of the outer script. Vencord's CSP patch always adds 'unsafe-eval' (src/main/csp/index.ts:120).
 */
function wrapAddonRenderer(addonJs, bootInfo) {
    const source = addonJs + "\n//# sourceURL=telinha-addon:///telinha.renderer.js\n";
    return "\n;try{globalThis.__TelinhaAddonBoot=" + JSON.stringify(bootInfo) + ";(0,eval)(" + JSON.stringify(source) + ")}" +
        "catch(e){console.error(\"[Telinha] addon: renderer failed\",e)}\n";
}

/** What the hooked `VencordPreloadGetRendererJs` answers: Vencord's renderer (PluginMeta-patched) + ours. */
function buildRendererPayload(vencordJs, addonJs, manifest) {
    const meta = patchPluginMeta(vencordJs, manifest.pluginName, manifest.meta ?? { folderName: "telinha-addon", userPlugin: true });
    const code = meta.code + wrapAddonRenderer(addonJs, { via: "ipc-hook", metaPatched: meta.ok, metaReason: meta.reason });
    return { code, metaPatched: meta.ok, metaReason: meta.reason };
}

// --- CSP (same parse/stringify rules as Vencord's src/main/csp/index.ts:82-98) ---

function parsePolicy(policy) {
    const result = {};
    for (const directive of policy.split(";")) {
        const [key, ...values] = directive.trim().split(/\s+/g);
        if (key && !Object.prototype.hasOwnProperty.call(result, key)) result[key] = values;
    }
    return result;
}

const stringifyPolicy = policy => Object.entries(policy)
    .filter(([, values]) => values?.length)
    .map(directive => directive.flat().join(" "))
    .join("; ");

/** Adds `sources` ({ "wss://host": ["connect-src"] }) to the CSP header in place. Returns whether a header was found. */
function addCspSources(headers, sources) {
    const key = Object.keys(headers).find(h => h.toLowerCase() === "content-security-policy");
    if (!key) return false;
    const raw = Array.isArray(headers[key]) ? headers[key][0] : headers[key];
    const csp = parsePolicy(String(raw));
    for (const [source, directives] of Object.entries(sources)) {
        for (const directive of directives) {
            csp[directive] ??= [...(csp["default-src"] ?? [])];
            if (!csp[directive].includes(source)) csp[directive].push(source);
        }
    }
    headers[key] = [stringifyPolicy(csp)];
    return true;
}

module.exports = { PLUGIN_META_RE, patchPluginMeta, wrapAddonRenderer, buildRendererPayload, parsePolicy, addCspSources };
