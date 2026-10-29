/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do acesso as funcoes nativas (core/nativeApi.ts): presentes, ausentes e o VencordNative inteiro ausente.
// Rodar:  pnpm test:file src/plugins/telinha/core/nativeApi.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { installNative } from "@test/fakes/native";

import { getNative, getNativeOrNull } from "./nativeApi";

const g = globalThis as { VencordNative?: unknown; };
const original = g.VencordNative;

describe("nativeApi", () => {
    afterEach(() => {
        g.VencordNative = original;
    });

    test("com a parte nativa carregada: as funcoes do native.ts", async () => {
        const native = installNative();
        assert.ok(getNativeOrNull());
        assert.equal(getNative(), getNativeOrNull());
        await getNative().resetDisplayMedia();
        assert.deepEqual(native.calls.map(c => c.name), ["resetDisplayMedia"]);
        native.restore();
    });

    test("sem a parte nativa (pluginHelpers sem Telinha): null, e getNative explica o que fazer", () => {
        assert.equal(getNativeOrNull(), null);
        assert.throws(() => getNative(), /A parte nativa do Telinha não está carregada.*feche o Discord por completo/);
    });

    test("sem pluginHelpers ou sem VencordNative: null, sem lancar", () => {
        g.VencordNative = {};
        assert.equal(getNativeOrNull(), null);
        g.VencordNative = undefined;
        assert.equal(getNativeOrNull(), null);
        assert.throws(() => getNative(), /nativa/);
    });
});
