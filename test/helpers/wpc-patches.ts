/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-C: runs a plugin patch the way Vencord's patcher does (src/utils/patches.ts + patchWebpack): `\i` in the match means
// "any identifier", `$self` in the replacement means the plugin's own object, and the module's code goes through
// String.prototype.replace. A test feeds it a sample of Discord's minified code and checks the call that comes out,
// even runs it. Whether the regex still matches the CURRENT Discord bundle needs the live client: not testable here.
//
//   const out = applyPatch(patches[0], '(0,r.jsx)(i.Z,{userTag:d,occluded:f})');
//   // → '(0,Vencord.Plugins.plugins["Telinha"].panelJsx.jsx)(i.Z,{userTag:d,occluded:f})'

export interface PatchLike {
    find: string | RegExp;
    replacement: { match: string | RegExp; replace: string | ((substring: string, ...groups: string[]) => string); };
}

/** The `$self` text Vencord substitutes: how a patched module reaches the plugin object. */
export const SELF = "Vencord.Plugins.plugins[\"Telinha\"]";

/** Vencord's canonicalizeMatch, for the `\i` macro (the `#{intl::KEY}` macro is not used by the Telinha patches' matches). */
export function canonicalizeMatch(match: string | RegExp): string | RegExp {
    if (typeof match === "string") return match;
    const source = match.source.replaceAll(/(\\*)\\i/g, (all, leading: string) =>
        leading.length % 2 === 0 ? `${leading}(?:[A-Za-z_$][\\w$]*)` : all.slice(1));
    return new RegExp(source, match.flags);
}

/** What the patcher does to a module's code with this patch (the code is returned unchanged when the match fails). */
export function applyPatch(patch: PatchLike, code: string): string {
    const { match, replace } = patch.replacement;
    const regex = canonicalizeMatch(match);
    if (typeof replace === "function") return code.replace(regex, (...args) => replace(...args as [string, ...string[]]).replaceAll("$self", SELF));
    return code.replace(regex, replace.replaceAll("$self", SELF));
}

/** Evaluates an expression of patched code with the given free variables in scope (Vencord, the module's imports...). */
export function evalExpression(code: string, scope: Record<string, unknown>): unknown {
    return new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope));
}
