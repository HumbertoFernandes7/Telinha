/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A UI de identidade num build SEM Client ID do Discord (test/helpers/wpf-identity-off.ts): o aviso da barra e a secao
// das configuracoes nao desenham nada (tudo como na v0.1.0), e o estado local fica "desligado".
// Rodar:  pnpm test:file src/plugins/telinha/ui/IdentityUI.identity-off.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";
import "@test/helpers/wpf-identity-off";

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { authorizeTelinhaIdentity, getLocalIdentity, identityEnabled, unlinkTelinhaIdentity } from "@plugins/telinha/actions";
import { act, render, screen } from "@test/fakes/render";
import { caughtErrors } from "@test/fakes/vencord";

import { IdentityBanner, IdentitySection } from "./IdentityUI";

describe("sem Client ID no build", () => {
    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    test("o recurso esta desligado", () => {
        assert.equal(identityEnabled(), false);
        assert.deepEqual(getLocalIdentity(), { status: "disabled" });
    });

    test("o aviso da barra e a secao das configuracoes nao desenham nada", () => {
        const banner = render(<IdentityBanner />);
        assert.equal(banner.container.innerHTML, "");
        banner.unmount();

        const section = render(<IdentitySection />);
        assert.equal(section.container.innerHTML, "");
        assert.equal(screen.queryByRole("button"), null);
    });

    test("tentar autorizar mesmo assim nao abre nada e continua desligado", async () => {
        assert.equal(await authorizeTelinhaIdentity(), false);
        await act(async () => unlinkTelinhaIdentity());
        assert.deepEqual(getLocalIdentity(), { status: "disabled" });
    });
});
