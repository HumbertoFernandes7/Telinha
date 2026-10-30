/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes das configuracoes do plugin (settings.ts): as chaves salvas (nao podem mudar), os padroes, a migracao da
// opcao antiga "Aprovar quem vai assistir" e o que cada opcao faz no nucleo ao ser mudada (a ligacao dos onChange):
// a senha do grupo troca de sala (com 800 ms de espera), "recusar quem nao esta na call" muda quem e admitido, "exigir
// identidade verificada" libera os pedidos que esperavam, "qualidade automatica" liga/desliga o controlador.
// Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/settings.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { stopStreaming } from "@plugins/telinha/actions";
import { QUALITY } from "@plugins/telinha/core/streaming";
import { isStreamAccess } from "@plugins/telinha/protocol";
import { getEventLog, getState } from "@plugins/telinha/store";
import { eventually, useFakeClock } from "@test/fakes/clock";
import { trystero } from "@test/fakes/trystero";
import { OTHER_ID, pluginSettings, resetVencordFakes } from "@test/fakes/vencord";
import { type Call, friendArrives, goLive, joinCall } from "@test/helpers/wpc-session";

import { migrateAccessSettings, settings } from "./settings";

const STORED_KEYS = [
    "groupPassword", "rejectOutsiders", "defaultAccess", "requireVerifiedIdentity", "defaultQuality", "autoQuality", "shareAudioByDefault",
    "playSounds", "codec", "autoUpdate"
];

describe("as opcoes", () => {
    beforeEach(() => {
        resetVencordFakes();
    });

    test("as chaves salvas nao mudam (renomear apagaria a configuracao de quem ja usa)", () => {
        assert.deepEqual(Object.keys(settings.def), STORED_KEYS);
    });

    test("padroes: seguro e com tudo ligado", () => {
        assert.deepEqual(pluginSettings.defaults(), {
            groupPassword: "",
            rejectOutsiders: true,
            defaultAccess: "all",
            requireVerifiedIdentity: true,
            defaultQuality: "1080p60",
            autoQuality: true,
            shareAudioByDefault: true,
            playSounds: true,
            codec: "auto",
            autoUpdate: true
        });
    });

    test("toda opcao tem titulo e descricao em portugues na pagina do plugin", () => {
        for (const [key, def] of Object.entries(settings.def)) {
            assert.ok(def.displayName && def.displayName.length > 3, `${key}: displayName`);
            assert.ok(def.description && def.description.length > 20, `${key}: description`);
        }
    });

    test("os valores dos seletores sao aceitos pelo nucleo", () => {
        const values = (key: "defaultAccess" | "defaultQuality" | "codec") => (settings.def[key].options as { value: string; }[]).map(o => o.value);
        assert.deepEqual(values("defaultAccess"), ["all", "friends", "approval", "password"]);
        for (const mode of values("defaultAccess")) assert.ok(isStreamAccess(mode), `defaultAccess ${mode}`);
        assert.deepEqual(values("defaultQuality"), ["1080p60", "720p60", "1080p30"]);
        for (const quality of values("defaultQuality")) assert.ok(QUALITY[quality as keyof typeof QUALITY], `defaultQuality ${quality}`);
        assert.deepEqual(values("codec"), ["auto", "h264", "vp8", "vp9", "av1"]);
    });

    test("'Exigir identidade verificada' aparece (o build tem Client ID do Discord)", () => {
        assert.equal(settings.def.requireVerifiedIdentity.hidden(), false);
    });
});

describe("migracao de 'Aprovar quem vai assistir' (v0.1.0 -> v0.2.0)", () => {
    // No Vencord de verdade os padroes aparecem so quando alguem LE a opcao pelo store: settings.plain traz apenas o que
    // foi gravado em disco (a v0.1.0 nao conhecia defaultAccess). O modo lazy do fake e isso.
    function onDisk(values: Record<string, unknown>) {
        pluginSettings.load(values, { lazy: true });
    }

    beforeEach(() => {
        resetVencordFakes();
    });

    test("approveViewers ligado vira 'Só quem eu aprovar' e a chave antiga some", () => {
        onDisk({ approveViewers: true, groupPassword: "" });
        migrateAccessSettings();
        assert.equal(settings.plain.defaultAccess, "approval");
        assert.equal("approveViewers" in settings.plain, false);
        assert.equal(settings.plain.groupPassword, "", "o resto da configuracao fica como estava");
    });

    test("approveViewers desligado: so some a chave antiga, o padrao continua 'Todos da call'", () => {
        onDisk({ approveViewers: false });
        migrateAccessSettings();
        assert.equal("defaultAccess" in settings.plain, false, "nada gravado: vale o padrao");
        assert.equal("approveViewers" in settings.plain, false);
    });

    test("quem ja escolheu um modo novo mantem a escolha", () => {
        onDisk({ approveViewers: true, defaultAccess: "password" });
        migrateAccessSettings();
        assert.equal(settings.plain.defaultAccess, "password");
        assert.equal("approveViewers" in settings.plain, false);
    });

    test("configuracao limpa: nada muda; rodar de novo tambem nao", () => {
        onDisk({});
        migrateAccessSettings();
        migrateAccessSettings();
        assert.deepEqual(Object.keys(settings.plain), []);
    });

    test("depois de migrar, rodar de novo nao desfaz a escolha do usuario", () => {
        onDisk({ approveViewers: true });
        migrateAccessSettings();
        settings.store.defaultAccess = "friends";
        migrateAccessSettings();
        assert.equal(settings.plain.defaultAccess, "friends");
    });

    test("nunca lanca: sem configuracoes carregadas nao ha o que migrar; uma falha vira so um aviso no console", t => {
        const warn = t.mock.method(console, "warn", () => { });
        t.mock.getter(settings, "plain", () => undefined as never);
        migrateAccessSettings();
        assert.equal(warn.mock.callCount(), 0);
        t.mock.restoreAll();

        const warned = t.mock.method(console, "warn", () => { });
        t.mock.getter(settings, "plain", () => {
            throw new Error("Cannot access settings before plugin is initialized");
        });
        migrateAccessSettings();
        assert.equal(warned.mock.callCount(), 1);
        assert.match(String(warned.mock.calls[0].arguments[0]), /migração de "Aprovar quem vai assistir" falhou/);
    });
});

describe("mudar uma opcao sem a sessao do plugin ligada nao faz nada", () => {
    test("senha do grupo, recusar de fora, identidade e qualidade automatica", t => {
        const clock = useFakeClock(t);
        pluginSettings.set("groupPassword", "segredo");
        pluginSettings.set("rejectOutsiders", false);
        pluginSettings.set("requireVerifiedIdentity", false);
        pluginSettings.set("autoQuality", false);
        clock.tick(5000);
        assert.equal(trystero.rooms.length, 0, "nenhuma sala foi aberta");
        assert.equal(getState().inRoom, false);
        pluginSettings.reset();
    });
});

describe("mudar uma opcao com a call no ar", () => {
    let call: Call;

    before(async () => {
        resetVencordFakes();
        call = await joinCall();
    });

    after(() => {
        stopStreaming();
        call.close();
    });

    test("'Recusar quem nao esta na call': quem esta fora so entra enquanto a opcao estiver desligada", async () => {
        await friendArrives(call.room, "peerOut", { discordUserId: OTHER_ID, username: "de fora" });
        const admitted = () => getState().peers.find(p => p.peerId === "peerOut")?.admitted;
        assert.equal(admitted(), false, "padrao: ignorado");

        pluginSettings.set("rejectOutsiders", false);
        await eventually(() => admitted() === true);

        pluginSettings.set("rejectOutsiders", true);
        await eventually(() => admitted() === false);
    });

    test("'Exigir identidade verificada' desligado: o pedido que esperava Permitir e atendido na hora", async () => {
        const pc = await friendArrives(call.room, "peerA");
        await goLive({ access: "all" });
        call.room.receive("watch", { op: "start" }, "peerA");
        await eventually(() => getState().local?.pendingViewers?.length === 1);
        assert.equal(call.room.streamsAdded.length, 0, "esperando Permitir: nao recebe nada");

        pluginSettings.set("requireVerifiedIdentity", false);
        await eventually(() => getState().local?.viewers.includes("peerA"));
        assert.equal(getState().local?.pendingViewers?.length, 0);
        assert.equal(call.room.streamsAdded.length, 1, "o stream foi para ele");
        assert.ok(pc.getSenders().length > 0);

        // ligar de novo nao derruba quem ja assiste
        pluginSettings.set("requireVerifiedIdentity", true);
        await eventually(() => getState().local?.viewers.includes("peerA"));
    });

    test("'Qualidade automatica': desligar e ligar de novo recomeca o controlador e avisa no diagnostico", async () => {
        pluginSettings.set("autoQuality", false);
        assert.ok(getEventLog().some(e => /Qualidade automática desligada: todos recebem/.test(e.msg)));
        await eventually(() => getState().local?.autoQuality == null);

        pluginSettings.set("autoQuality", true);
        assert.ok(getEventLog().some(e => /Qualidade automática ligada \(teto/.test(e.msg)));
        await eventually(() => getState().local?.autoQuality);
        stopStreaming();
    });

    test("'Senha do grupo': troca de sala depois de 800 ms sem mexer (varias digitacoes = uma troca so)", async () => {
        const first = call.room;
        pluginSettings.set("groupPassword", "a");
        pluginSettings.set("groupPassword", "ab");
        assert.equal(trystero.rooms.length, 1, "ainda na sala velha");

        await eventually(() => trystero.rooms.length === 2, { timeoutMs: 4000 });
        const second = trystero.lastRoom!;
        assert.equal(second.config.password, "ab");
        await eventually(() => first.left);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(trystero.rooms.length, 2, "uma troca so");
    });
});
