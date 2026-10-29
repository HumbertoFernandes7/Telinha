/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O "Quem pode assistir" num build SEM Client ID do Discord (test/helpers/wpf-identity-off.ts): sem a prova de
// identidade nao ha como saber quem e amigo, entao "Só meus amigos" fica indisponivel (nao da para escolher), a
// explicacao diz por que, e o valor padrao das configuracoes cai para "Só quem eu aprovar".
// Rodar:  pnpm test:file src/plugins/telinha/ui/AccessPicker.identity-off.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";
import "@test/helpers/wpf-identity-off";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { friendsAccessAvailable, identityEnabled } from "@plugins/telinha/actions";
import { resetState } from "@plugins/telinha/store";
import type { AccessMode } from "@plugins/telinha/types";
import { fireEvent, render, screen } from "@test/fakes/render";
import { caughtErrors, pluginSettings, resetVencordFakes } from "@test/fakes/vencord";
import { useState } from "@webpack/common";

import { AccessPicker } from "./AccessPicker";
import { defaultAccess } from "./common";

function Picker({ initial = "all" as AccessMode, log }: { initial?: AccessMode; log: string[]; }) {
    const [access, setAccess] = useState<AccessMode>(initial);
    return <AccessPicker access={access} onAccess={a => (log.push(a), setAccess(a))} password="" onPassword={() => { }} />;
}

describe("sem Client ID no build", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
    });

    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    test("o plugin sabe que a identidade esta desligada", () => {
        assert.equal(identityEnabled(), false);
        assert.equal(friendsAccessAvailable(), false);
    });

    test("Só meus amigos aparece como indisponivel e nao da para escolher; a explicacao diz por que", () => {
        const log: string[] = [];
        render(<Picker log={log} />);
        const select = screen.getByRole("combobox") as HTMLSelectElement;
        const friends = [...select.options].find(o => o.value === "friends")!;
        assert.equal(friends.textContent, "Só meus amigos do Discord (indisponível)");
        assert.equal(friends.disabled, true);
        assert.deepEqual([...select.options].filter(o => !o.disabled).map(o => o.value), ["all", "approval", "password"]);
        screen.getByText(/"Só meus amigos do Discord" está indisponível: esta versão do Telinha não tem a prova de identidade do Discord\./);

        // mesmo que o Discord entregue a escolha (select nativo deixa forcar), o componente a recusa
        fireEvent.change(select, { target: { value: "friends" } });
        assert.deepEqual(log, [], "o pai nao foi avisado");
        fireEvent.change(select, { target: { value: "approval" } });
        assert.deepEqual(log, ["approval"]);
    });

    test("Todos da call: a explicacao nao fala de identidade verificada (nao existe neste build)", () => {
        render(<Picker log={[]} />);
        screen.getByText("Quem está no seu canal de voz assiste direto.");
        assert.equal(screen.queryByText(/identidade verificada/), null);
    });

    test("o padrao das configuracoes Só meus amigos vira Só quem eu aprovar", () => {
        pluginSettings.set("defaultAccess", "friends");
        assert.equal(defaultAccess(), "approval");
        pluginSettings.set("defaultAccess", "password");
        assert.equal(defaultAccess(), "password");
    });
});
