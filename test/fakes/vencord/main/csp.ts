/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@main/csp` (main process): the same values the add-on build's shim exports. native.ts writes the relays
// into CspPolicies at module load; a test reads them from here.

export const ConnectSrc = ["connect-src"];
export const ImageSrc = [...ConnectSrc, "img-src"];
export const CspPolicies: Record<string, string[]> = {};
