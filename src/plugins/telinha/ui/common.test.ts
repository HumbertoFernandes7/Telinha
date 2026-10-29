/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos auxiliares puros da UI (ui/common.ts): textos que o usuario le (avisos de identidade, resumo da
// transmissao, motivo da recusa), nomes/avatares vindos do UserStore do Discord, valores padrao das configuracoes e
// o runAction, que nunca deixa um erro do nucleo escapar do clique.
// Rodar:  pnpm test:file src/plugins/telinha/ui/common.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import type { IdentityAlert, RemotePeer, TelinhaState, ViewDeniedReason } from "@plugins/telinha/types";
import { flushPromises } from "@test/fakes/clock";
import { FRIEND_ID, loggerLines, makeUser, ME_ID, OTHER_ID, pluginSettings, resetVencordFakes, SelectedChannelStore, toasts, UserStore, VOICE_CHANNEL_ID } from "@test/fakes/vencord";

import {
    ACCENT, accessBadge, avatarUrl, cl, currentUserId, defaultAccess, defaultQuality, deniedTitle, displayName, errorText, findPeer,
    identityAlertBlocksAll, identityAlertText, inVoiceChannel, peerName, pluralPeople, QUALITY_OPTIONS, runAction, shareAudioByDefault,
    streamSummary, watchersLabel
} from "./common";

function peer(patch: Partial<RemotePeer> = {}): RemotePeer {
    return { peerId: "peerA", discordUserId: FRIEND_ID, username: "amigo", streaming: true, admitted: true, ...patch };
}

describe("ui/common: textos e valores padrao", () => {
    beforeEach(() => resetVencordFakes());

    test("cl prefixa as classes com vc-telinha- e ignora as falsas", () => {
        assert.equal(cl("bar", false, "bar-live"), "vc-telinha-bar vc-telinha-bar-live");
        assert.equal(cl("tag", 0 && "x"), "vc-telinha-tag");
        assert.equal(ACCENT, "#0b8a83");
    });

    test("QUALITY_OPTIONS oferece as 3 qualidades escolhiveis", () => {
        assert.deepEqual(QUALITY_OPTIONS.map(o => o.value), ["1080p60", "720p60", "1080p30"]);
        assert.deepEqual(QUALITY_OPTIONS.map(o => o.label), ["1080p · 60 fps", "720p · 60 fps", "1080p · 30 fps"]);
    });

    describe("errorText", () => {
        test("Error: a mensagem; sem mensagem, o nome", () => {
            assert.equal(errorText(new Error("sem permissao")), "sem permissao");
            assert.equal(errorText(new TypeError("")), "TypeError");
        });

        test("texto puro, objeto e valor que o JSON nao aceita", () => {
            assert.equal(errorText("falhou"), "falhou");
            assert.equal(errorText({ code: 7 }), '{"code":7}');
            const circular: Record<string, unknown> = {};
            circular.self = circular;
            assert.equal(errorText(circular), "[object Object]");
            // o JSON nao da texto para undefined/simbolo/funcao: o retorno e sempre um texto
            assert.equal(errorText(undefined), "undefined");
            assert.equal(errorText(Symbol("x")), "Symbol(x)");
        });
    });

    describe("runAction: erro do nucleo nunca escapa do clique", () => {
        test("sucesso: roda a acao e nao avisa nada", async () => {
            let ran = 0;
            runAction("parar", () => ++ran);
            runAction("parar de novo", () => Promise.resolve(++ran));
            await flushPromises();
            assert.equal(ran, 2);
            assert.deepEqual(toasts, []);
            assert.deepEqual(loggerLines, []);
        });

        test("excecao sincrona: toast critico com a mensagem e linha no log", () => {
            runAction("kickViewer", () => {
                throw new Error("Esse pedido nao existe mais");
            });
            assert.deepEqual(toasts, [{ text: "Telinha: Esse pedido nao existe mais", variant: "critical" }]);
            assert.equal(loggerLines.length, 1);
            assert.equal(loggerLines[0].level, "error");
            assert.equal(loggerLines[0].logger, "Telinha UI");
            assert.equal(loggerLines[0].args[0], "kickViewer falhou");
        });

        test("Promise rejeitada: mesmo aviso, so depois que ela rejeita", async () => {
            runAction("stopStreaming", () => Promise.reject(new Error("captura ja parou")));
            assert.deepEqual(toasts, [], "ainda nao rejeitou");
            await flushPromises();
            assert.deepEqual(toasts, [{ text: "Telinha: captura ja parou", variant: "critical" }]);
        });

        test("com onError, o aviso vai para quem chamou e nao ha toast", async () => {
            const messages: string[] = [];
            runAction("a", () => {
                throw "texto solto";
            }, m => messages.push(m));
            runAction("b", () => Promise.reject(new Error("depois")), m => messages.push(m));
            await flushPromises();
            assert.deepEqual(messages, ["texto solto", "depois"]);
            assert.deepEqual(toasts, []);
            assert.equal(loggerLines.length, 2);
        });

        test("resultado que nao e Promise (nem null) e ignorado", () => {
            runAction("x", () => null);
            runAction("y", () => ({ then: 5 }));
            runAction("z", () => "ok");
            assert.deepEqual(toasts, []);
        });
    });

    describe("valores padrao vindos das configuracoes do plugin", () => {
        test("defaultQuality: a escolhida; valor invalido cai para 1080p60", () => {
            assert.equal(defaultQuality(), "1080p60");
            pluginSettings.set("defaultQuality", "720p60");
            assert.equal(defaultQuality(), "720p60");
            pluginSettings.set("defaultQuality", "4k");
            assert.equal(defaultQuality(), "1080p60");
            pluginSettings.set("defaultQuality", undefined);
            assert.equal(defaultQuality(), "1080p60");
        });

        test("defaultAccess: o modo marcado nas configuracoes (desconhecido vira Todos da call)", () => {
            assert.equal(defaultAccess(), "all");
            for (const mode of ["friends", "approval", "password"] as const) {
                pluginSettings.set("defaultAccess", mode);
                assert.equal(defaultAccess(), mode, mode);
            }
            pluginSettings.set("defaultAccess", "qualquer-coisa");
            assert.equal(defaultAccess(), "all");
        });

        test("shareAudioByDefault: ligado, a nao ser que esteja explicitamente desligado", () => {
            assert.equal(shareAudioByDefault(), true);
            pluginSettings.set("shareAudioByDefault", false);
            assert.equal(shareAudioByDefault(), false);
            pluginSettings.set("shareAudioByDefault", undefined);
            assert.equal(shareAudioByDefault(), true);
        });

        test("accessBadge: so os modos com restricao tem etiqueta", () => {
            assert.equal(accessBadge(undefined), null);
            assert.equal(accessBadge("all"), null);
            assert.equal(accessBadge("friends"), "👥 só amigos");
            assert.equal(accessBadge("approval"), "✋ com aprovação");
            assert.equal(accessBadge("password"), "🔒 com senha");
            assert.equal(accessBadge("desconhecido" as never), null);
        });
    });

    describe("usuarios, canais e nomes do Discord", () => {
        test("currentUserId: o usuario logado, ou nada se deslogado", () => {
            assert.equal(currentUserId(), ME_ID);
            UserStore.setCurrentUser(null);
            assert.equal(currentUserId(), undefined);
        });

        test("inVoiceChannel acompanha o SelectedChannelStore", () => {
            assert.equal(inVoiceChannel(), false);
            SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
            assert.equal(inVoiceChannel(), true);
        });

        test("displayName: apelido global, senao usuario do Discord, senao o nome anunciado, senao Alguem", () => {
            UserStore.addUsers(makeUser(FRIEND_ID, "ana_dev", { globalName: "Ana" }), makeUser(OTHER_ID, "beto"));
            assert.equal(displayName(FRIEND_ID, "anunciada"), "Ana");
            assert.equal(displayName(OTHER_ID, "anunciado"), "beto");
            assert.equal(displayName("999999999999999999", "so-anunciado"), "so-anunciado");
            assert.equal(displayName("999999999999999999"), "Alguém");
            assert.equal(displayName(undefined), "Alguém");
            assert.equal(displayName(undefined, "so-fallback"), "so-fallback");
        });

        test("peerName: usa o nome do Discord do id anunciado; sem peer, Alguem", () => {
            UserStore.addUsers(makeUser(FRIEND_ID, "ana_dev", { globalName: "Ana" }));
            assert.equal(peerName(peer()), "Ana");
            assert.equal(peerName(peer({ discordUserId: OTHER_ID, username: "beto" })), "beto");
            assert.equal(peerName(undefined), "Alguém");
        });

        test("findPeer acha a conexao pelo peerId", () => {
            const state = { peers: [peer({ peerId: "a" }), peer({ peerId: "b" })] } as TelinhaState;
            assert.equal(findPeer(state, "b")?.peerId, "b");
            assert.equal(findPeer(state, "c"), undefined);
        });

        test("avatarUrl: URL do Discord no tamanho pedido; sem usuario, sem URL; erro do Discord nao quebra", t => {
            UserStore.addUsers(makeUser(FRIEND_ID, "ana"));
            assert.match(avatarUrl(FRIEND_ID)!, /size=40/);
            assert.match(avatarUrl(FRIEND_ID, 64)!, /size=64/);
            assert.equal(avatarUrl(undefined), undefined);
            assert.equal(avatarUrl(OTHER_ID), undefined, "usuario desconhecido do Discord");
            t.mock.method(UserStore, "getUser", () => ({
                getAvatarURL() {
                    throw new Error("avatar indisponivel");
                }
            }));
            assert.equal(avatarUrl(FRIEND_ID), undefined);
        });
    });

    describe("rotulos de quantidade", () => {
        test("pluralPeople e watchersLabel", () => {
            assert.equal(pluralPeople(1, "pessoa", "pessoas"), "1 pessoa");
            assert.equal(pluralPeople(0, "pessoa", "pessoas"), "0 pessoas");
            assert.equal(pluralPeople(3, "pessoa", "pessoas"), "3 pessoas");
            assert.equal(watchersLabel(0), "ninguém assistindo ainda");
            assert.equal(watchersLabel(1), "1 pessoa assistindo");
            assert.equal(watchersLabel(2), "2 pessoas assistindo");
        });
    });

    test("deniedTitle: um titulo claro para cada motivo de recusa", () => {
        const reasons: Record<ViewDeniedReason, string> = {
            kicked: "O transmissor encerrou sua visualização",
            declined: "O transmissor recusou sua visualização",
            timeout: "O transmissor não respondeu ao seu pedido",
            duplicate: "Transmissão bloqueada por segurança",
            friendsOnly: "Esta transmissão é só para amigos de Ana",
            notVerified: "Autorize o Telinha no Discord para assistir",
            tooManyAttempts: "Senha errada vezes demais"
        };
        for (const [reason, title] of Object.entries(reasons)) assert.equal(deniedTitle(reason as ViewDeniedReason, "Ana"), title, reason);
        assert.equal(deniedTitle("outro" as ViewDeniedReason, "Ana"), "O transmissor recusou sua visualização", "motivo novo cai no generico");
    });

    describe("identityAlertText e identityAlertBlocksAll", () => {
        const alert = (patch: Partial<IdentityAlert>): IdentityAlert => ({ discordUserId: FRIEND_ID, username: "ana", peerIds: ["a", "b"], self: false, ...patch });

        test("alguem diz ser voce", () => {
            assert.equal(identityAlertText(alert({ self: true, discordUserId: ME_ID })), "Uma conexão na call diz ser você — alguém pode estar se passando por você");
        });

        test("duas conexoes (duplicate, o padrao) e mais de duas", () => {
            UserStore.addUsers(makeUser(FRIEND_ID, "ana", { globalName: "Ana" }));
            assert.equal(identityAlertText(alert({})), "Duas conexões dizem ser Ana — uma pode ser falsa");
            assert.equal(identityAlertText(alert({ kind: "duplicate", peerIds: ["a", "b", "c"] })), "3 conexões dizem ser Ana — uma pode ser falsa");
        });

        test("impostor: singular e plural, so as nao verificadas ficam bloqueadas", () => {
            assert.equal(
                identityAlertText(alert({ kind: "impostor", peerIds: ["a"] })),
                "Uma conexão não verificada diz ser ana, que já provou a identidade — só ela fica bloqueada"
            );
            assert.equal(
                identityAlertText(alert({ kind: "impostor", peerIds: ["a", "b"] })),
                "2 conexões não verificadas dizem ser ana, que já provou a identidade — só elas ficam bloqueadas"
            );
        });

        test("prova falsa: singular e plural, ignoradas", () => {
            assert.equal(identityAlertText(alert({ kind: "fake", peerIds: ["a"] })), "Uma conexão apresentou uma prova de identidade falsa de ana — ignorada");
            assert.equal(identityAlertText(alert({ kind: "fake", peerIds: ["a", "b"] })), "2 conexões apresentaram uma prova de identidade falsa de ana — ignoradas");
        });

        test("so o conflito sem ninguem verificado deixa as duas conexoes sem a transmissao", () => {
            assert.equal(identityAlertBlocksAll(alert({})), true);
            assert.equal(identityAlertBlocksAll(alert({ kind: "duplicate" })), true);
            assert.equal(identityAlertBlocksAll(alert({ kind: "impostor" })), false);
            assert.equal(identityAlertBlocksAll(alert({ kind: "fake" })), false);
            assert.equal(identityAlertBlocksAll(alert({ self: true })), false);
        });
    });

    describe("streamSummary", () => {
        const info = { kind: "screen" as const, title: "", hasAudio: true, width: 1920, height: 1080, fps: 60 };

        test("sem informacao: so Transmitindo", () => {
            assert.equal(streamSummary(undefined), "Transmitindo");
        });

        test("tela inteira com resolucao, fps e som", () => {
            assert.equal(streamSummary(info), "Tela inteira · 1080p · 60 fps · com som");
        });

        test("janela com titulo, sem fps e sem som", () => {
            assert.equal(streamSummary({ ...info, kind: "window", title: "Jogo", fps: 0, hasAudio: false }), "Janela: Jogo · 1080p · sem som");
        });

        test("janela sem titulo e sem resolucao conhecida", () => {
            assert.equal(streamSummary({ ...info, kind: "window", title: "", width: 0, height: 0 }), "Janela: sem título · com som");
        });
    });
});
