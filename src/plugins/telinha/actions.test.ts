/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da API do nucleo para a UI (actions.ts): cada funcao e chamada como a UI chama e o que se confere e o que a
// pessoa veria (getState()), o que sai pela sala (Trystero falso) e as mensagens em portugues. As funcoes que so
// repassam ao nucleo (kick, approve, watch...) sao exercitadas dentro de uma call de verdade, como no harness; a
// autorizacao do Discord roda ponta a ponta com um OAuth falso (test/helpers/wpc-oauth.ts).
// Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/actions.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { getEventLog, getState, resetState, setState } from "@plugins/telinha/store";
import type { RemotePeer, TelinhaState } from "@plugins/telinha/types";
import { installWebAudio } from "@test/fakes/audio";
import { eventually, flushPromises, useFakeClock } from "@test/fakes/clock";
import { installNative } from "@test/fakes/native";
import { FluxDispatcher, FRIEND_ID, modals, OTHER_ID, resetVencordFakes } from "@test/fakes/vencord";
import { videoSenderStats } from "@test/fakes/webrtc";
import { discordOAuth } from "@test/helpers/wpc-oauth";
import { type Call, friendArrives, goLive, joinCall } from "@test/helpers/wpc-session";

import {
    approveViewer, authorizeAndRewatch, authorizeTelinhaIdentity, clearLastError, declineViewer, findPeerByDiscordId, friendsAccessAvailable, generateStreamPassword,
    getConnectionInfo, getLocalIdentity, getLocalPreviewStream, getScreenAudioStatus, getStreamPassword, identityEnabled, kickViewer, listSources, screenAudioSupported,
    setStreamAccess, startSession, startStreaming, stopSession, stopStreaming, submitWatchPassword, subscribeLocalIdentityState, unblockViewer, unlinkTelinhaIdentity,
    unwatch, watch
} from "./actions";

const EMPTY: TelinhaState = { inRoom: false, channelId: null, peers: [], local: null, viewing: {}, lastError: null, blocked: [], identityAlerts: [] };
const peerOf = (peerId: string, over: Partial<RemotePeer>): RemotePeer => ({ peerId, discordUserId: FRIEND_ID, username: "amigo", streaming: false, admitted: true, ...over });
const logLines = () => getEventLog().map(e => e.msg);

describe("lista de telas e janelas", () => {
    afterEach(() => {
        clearLastError();
        resetVencordFakes();
    });

    test("com a parte nativa: devolve id, nome, tipo e miniatura (so se houver) e pede miniaturas de 320x180", async () => {
        const native = installNative({
            listSources: async () => ({
                sources: [
                    { id: "screen:0:0", name: "Tela 1", kind: "screen", thumbnail: "data:image/png;base64,AAAA" },
                    { id: "window:7:0", name: "Jogo", kind: "window", thumbnail: "" }
                ]
            })
        });
        try {
            const sources = await listSources();
            assert.deepEqual(sources, [
                { id: "screen:0:0", name: "Tela 1", kind: "screen", thumbnail: "data:image/png;base64,AAAA" },
                { id: "window:7:0", name: "Jogo", kind: "window" }
            ]);
            assert.deepEqual(native.calls.map(c => [c.name, c.args]), [["listSources", [320, 180]]]);
        } finally {
            native.restore();
        }
    });

    test("o main avisa de um problema parcial: as fontes vem e o aviso vai para o diagnostico", async () => {
        const native = installNative({ listSources: async () => ({ sources: [{ id: "screen:0:0", name: "Tela", kind: "screen" }], error: "miniatura da janela 7 falhou" }) });
        try {
            assert.equal((await listSources()).length, 1);
            assert.ok(logLines().includes("Listar fontes: miniatura da janela 7 falhou"));
        } finally {
            native.restore();
        }
    });

    test("a chamada ao main falha: lista vazia e o erro aparece na barra do Telinha", async () => {
        const native = installNative({
            listSources: async () => {
                throw new Error("IPC caiu");
            }
        });
        try {
            assert.deepEqual(await listSources(), []);
            await flushPromises();
            assert.equal(getState().lastError, "Não foi possível listar telas e janelas: Error: IPC caiu");
        } finally {
            native.restore();
        }
    });

    test("sem a parte nativa (Discord aberto antes da instalacao): a frase de reiniciar o Discord, sem prefixo", async () => {
        assert.deepEqual(await listSources(), []);
        await flushPromises();
        assert.match(getState().lastError ?? "", /^A parte nativa do Telinha não está carregada\. .*feche o Discord por completo/);
        assert.doesNotMatch(getState().lastError ?? "", /Não foi possível listar/);
    });

    test("clearLastError limpa o aviso (e nao faz nada se nao havia)", async () => {
        await listSources();
        await flushPromises();
        assert.ok(getState().lastError);
        clearLastError();
        await flushPromises();
        assert.equal(getState().lastError, null);
        const before = getState();
        clearLastError();
        await flushPromises();
        assert.equal(getState(), before, "nada foi republicado");
    });
});

describe("som da tela inteira (disponibilidade)", () => {
    test("o plugin sabe transmitir som da tela inteira", () => {
        assert.equal(screenAudioSupported, true);
    });

    test("sem a parte nativa: diz por que", async () => {
        assert.deepEqual(await getScreenAudioStatus(), { available: false, reason: "a parte nativa do Telinha não está carregada" });
    });

    test("com o ajudante: a resposta do main chega sem mudar; sem ele, o motivo dele", async () => {
        const audio = installWebAudio();
        const ok = installNative({ screenAudioStatus: async () => ({ available: true }) });
        try {
            assert.deepEqual(await getScreenAudioStatus(), { available: true });
        } finally {
            ok.restore();
        }
        const missing = installNative();
        try {
            const status = await getScreenAudioStatus();
            assert.equal(status.available, false);
            assert.match(status.reason ?? "", /telinha-audio\.exe/);
        } finally {
            missing.restore();
            audio.restore();
        }
    });
});

describe("procurar o peer pelo Discord ID", () => {
    test("com duas conexoes da mesma pessoa, a que provou a identidade; sem prova, a primeira; ninguem, nada", () => {
        setState({ ...EMPTY, peers: [peerOf("p1", { identity: "unverified" }), peerOf("p2", { identity: "verified" }), peerOf("p3", { discordUserId: OTHER_ID })] });
        assert.equal(findPeerByDiscordId(FRIEND_ID)?.peerId, "p2");
        assert.equal(findPeerByDiscordId(OTHER_ID)?.peerId, "p3");
        assert.equal(findPeerByDiscordId("999"), undefined);

        setState({ ...EMPTY, peers: [peerOf("p1", { identity: "unverified" }), peerOf("p2", { identity: "pending" })] });
        assert.equal(findPeerByDiscordId(FRIEND_ID)?.peerId, "p1");
        resetState();
    });

    test("a senha 'Gerar' sai no formato palavra-NN e a identidade esta ligada neste build", () => {
        for (let i = 0; i < 20; i++) assert.match(generateStreamPassword(), /^[a-z]+-[1-9]\d$/);
        assert.equal(identityEnabled(), true);
        assert.equal(friendsAccessAvailable(), true);
    });
});

describe("sem estar em uma call", () => {
    before(() => {
        startSession();
    });

    after(() => {
        stopSession();
        clearLastError();
    });

    test("a sessao assina o Discord e para de assinar quando o plugin para", () => {
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 1);
        startSession(); // ligar de novo nao duplica
        assert.equal(FluxDispatcher.listenerCount("VOICE_CHANNEL_SELECT"), 1);
        assert.equal(getState().inRoom, false);
    });

    test("transmitir pede para entrar numa call e deixa o aviso na barra", async () => {
        await assert.rejects(goLive(), /Entre em um canal de voz para transmitir\./);
        await flushPromises();
        assert.equal(getState().lastError, "Entre em um canal de voz para transmitir.");
    });

    test("assistir, expulsar, permitir, recusar, liberar e trocar o modo nao fazem nada (e dizem que nao)", async () => {
        watch("peerX");
        await flushPromises();
        assert.equal(getState().viewing.peerX?.error, "Você não está em um canal de voz com o Telinha ativo.");
        unwatch("peerX");

        assert.equal(kickViewer("peerX"), false);
        assert.equal(approveViewer("peerX"), false);
        assert.equal(declineViewer("peerX"), false);
        assert.equal(unblockViewer(FRIEND_ID), false);
        assert.equal(submitWatchPassword("peerX", "senha"), false);
        assert.throws(() => setStreamAccess("all"), /Você não está transmitindo\./);
        assert.equal(getStreamPassword(), null);
        assert.equal(getLocalPreviewStream(), null);
        assert.equal(await getConnectionInfo("peerX"), null);
        stopStreaming(); // sem transmissao: nada a parar
    });
});

describe("dentro de uma call", () => {
    let call: Call;

    before(async () => {
        resetVencordFakes();
        call = await joinCall({ users: [FRIEND_ID, OTHER_ID] });
    });

    after(() => {
        stopStreaming();
        call.close();
        clearLastError();
    });

    const sentTo = (peerId: string) => call.room.sentOn("watch", peerId).map(m => m.data as { op: string; });

    test("o amigo que ainda nao transmite: pedir para assistir diz isso; findPeerByDiscordId acha a conexao dele", async () => {
        await friendArrives(call.room, "peerA");
        assert.equal(findPeerByDiscordId(FRIEND_ID)?.peerId, "peerA");

        watch("peerA");
        await eventually(() => getState().viewing.peerA?.status === "error");
        assert.equal(getState().viewing.peerA.error, "Esse amigo não está transmitindo agora.");
        unwatch("peerA");
        await eventually(() => !getState().viewing.peerA);
    });

    test("quando o amigo transmite: assistir manda o pedido; a conexao vira texto sem IP", async () => {
        const pc = (await friendArrives(call.room, "peerA", { streaming: true }));
        watch("peerA");
        assert.deepEqual(sentTo("peerA").at(-1), { op: "start" });

        pc.stats = videoSenderStats({ localCandidateType: "srflx", remoteCandidateType: "srflx", currentRoundTripTime: 0.035 });
        assert.equal(await getConnectionInfo("peerA"), "Conexão direta pela internet (P2P) · 35 ms");
        pc.stats = videoSenderStats({ localCandidateType: "host", remoteCandidateType: "host", currentRoundTripTime: 0.002 });
        assert.equal(await getConnectionInfo("peerA"), "Conexão direta, na mesma rede · 2 ms");
        pc.stats = [];
        assert.equal(await getConnectionInfo("peerA"), "Conectando…");

        assert.equal(await getConnectionInfo("ninguem"), null, "sem conexao com esse peer");
        pc.getStats = () => Promise.reject(new Error("pc fechado"));
        assert.equal(await getConnectionInfo("peerA"), null, "uma falha nas estatisticas vira 'sem informacao'");
        unwatch("peerA");
    });

    test("assistir com senha: a pessoa digita pela UI e so a prova sai", async () => {
        watch("peerA");
        call.room.receive("watch", { op: "password", nonce: "AAAAAAAAAAAAAAAAAAAAAA" }, "peerA");
        await eventually(() => getState().viewing.peerA?.passwordPrompt);
        assert.equal(submitWatchPassword("peerA", "pipoca-42"), true);
        await eventually(() => sentTo("peerA").some(m => typeof (m as { proof?: string; }).proof === "string"));
        unwatch("peerA");
    });

    test("transmitir: validacao do pedido, senha normalizada, previa local e troca do modo ao vivo", async () => {
        await assert.rejects(startStreaming({ source: { id: "nao-e-uma-fonte", name: "x", kind: "screen" }, quality: "1080p60", withAudio: false }), /Fonte de captura inválida\./);
        assert.equal(getLocalPreviewStream(), null, "ainda sem transmissao");

        await goLive({ access: "password", password: "  pipoca-42  " });
        await eventually(() => getState().local);
        assert.equal(getState().local?.access, "password");
        assert.equal(getStreamPassword(), "pipoca-42", "sem os espacos das pontas");
        const preview = getLocalPreviewStream();
        assert.equal(preview?.getVideoTracks().length, 1, "a previa e a propria captura");

        setStreamAccess("approval");
        await flushPromises();
        assert.equal(getState().local?.access, "approval");
        assert.equal(getStreamPassword(), null, "a senha so existe no modo 'Com senha'");
        assert.throws(() => setStreamAccess("password"), /Digite ou gere uma senha para esta transmissão\./);
        assert.throws(() => setStreamAccess("password", "x".repeat(65)), /no máximo 64 caracteres/);
        assert.throws(() => setStreamAccess("nao-existe" as never), /Opção de "Quem pode assistir" inválida\./);
        setStreamAccess("friends");
        await flushPromises();
        assert.equal(getState().local?.access, "friends");
        setStreamAccess("password", "melancia-10");
        assert.equal(getStreamPassword(), "melancia-10");
        setStreamAccess("approval");
        await flushPromises();
        assert.equal(getState().local?.access, "approval");
    });

    test("pedidos pendentes: permitir, recusar, expulsar e liberar", async () => {
        await friendArrives(call.room, "peerB", { discordUserId: OTHER_ID, username: "outro" });
        call.room.receive("watch", { op: "start" }, "peerA");
        call.room.receive("watch", { op: "start" }, "peerB");
        await eventually(() => getState().local?.pendingViewers?.length === 2);

        assert.equal(approveViewer("peerA"), true);
        await eventually(() => getState().local?.viewers.includes("peerA"));
        assert.equal(approveViewer("peerA"), false, "ja nao esta pendente");

        assert.equal(declineViewer("peerB"), true);
        await eventually(() => getState().blocked?.some(b => b.discordUserId === OTHER_ID && b.reason === "declined"));
        assert.ok(sentTo("peerB").some(m => m.op === "denied"), "ele soube da recusa");
        assert.equal(declineViewer("peerB"), false);

        assert.equal(unblockViewer(OTHER_ID), true);
        assert.equal(unblockViewer(OTHER_ID), false);
        await eventually(() => !getState().blocked?.length);

        assert.equal(kickViewer("peerA"), true);
        await eventually(() => !getState().local?.viewers.includes("peerA"));
        assert.ok(getState().blocked?.some(b => b.discordUserId === FRIEND_ID && b.reason === "kicked"));
        assert.equal(kickViewer("ninguem"), false);
        assert.equal(unblockViewer(FRIEND_ID), true);
    });

    test("parar de transmitir: some a previa e o estado 'transmitindo'", async () => {
        stopStreaming();
        await eventually(() => getState().local === null);
        assert.equal(getLocalPreviewStream(), null);
        assert.equal(getStreamPassword(), null);
    });
});

describe("prova de identidade do Discord (Autorizar)", () => {
    let call: Call;
    let discord: ReturnType<typeof discordOAuth>;

    before(async () => {
        resetVencordFakes();
        call = await joinCall({ users: [FRIEND_ID] });
        discord = discordOAuth();
        await friendArrives(call.room, "peerA", { streaming: true });
    });

    after(() => {
        discord.restore();
        call.close();
    });

    const status = () => getLocalIdentity().status;
    const starts = () => call.room.sentOn("watch", "peerA").filter(m => (m.data as { op: string; }).op === "start").length;

    test("antes de autorizar: configurada e ainda nao autorizada", async () => {
        await eventually(() => status() === "unauthorized");
        assert.equal(identityEnabled(), true);
    });

    test("cancelar o modal do Discord: nao autorizou e o estado volta", async () => {
        const done = authorizeTelinhaIdentity();
        await eventually(() => modals.top());
        assert.equal(status(), "authorizing");
        modals.close(modals.top()!.key);
        assert.equal(await done, false);
        assert.equal(status(), "unauthorized");
    });

    test("autorizar: abre o modal certo, troca o codigo, confere o proprio token e avisa quem escuta", async () => {
        const seen: string[] = [];
        const off = subscribeLocalIdentityState(() => seen.push(status()));
        const done = authorizeTelinhaIdentity();
        await eventually(() => modals.top());
        discord.approve();
        assert.equal(await done, true);

        assert.equal(status(), "ready");
        assert.deepEqual(seen, ["authorizing", "ready"]);
        const props = discord.lastProps!;
        assert.equal(props.responseType, "code");
        assert.deepEqual(props.scopes, ["openid"]);
        assert.equal(props.codeChallengeMethod, "S256");
        assert.equal(discord.tokenRequests.length, 1);
        assert.equal(discord.tokenRequests[0].get("grant_type"), "authorization_code");
        assert.equal(discord.tokenRequests[0].get("code"), "authcode");
        assert.ok(discord.tokenRequests[0].get("code_verifier"), "PKCE: o verifier vai na troca do codigo");

        off();
        assert.equal(modals.list().length, 0, "o Discord fecha a tela de autorizacao");
        assert.ok(logLines().some(l => /Identidade do Discord pronta/.test(l)));
    });

    test("recusado com 'notVerified', autorizar e pedir de novo: o pedido refeito sai 2,5 s depois", async t => {
        const clock = useFakeClock(t);
        watch("peerA");
        call.room.receive("watch", { op: "denied", reason: "notVerified" }, "peerA");
        await eventually(() => getState().viewing.peerA?.denied === "notVerified");
        const before = starts();

        const done = authorizeAndRewatch("peerA");
        await eventually(() => modals.top());
        discord.approve();
        assert.equal(await done, true);

        clock.tick(2499);
        assert.equal(starts(), before, "ainda esperando o transmissor conferir a prova nova");
        clock.tick(1);
        assert.equal(starts(), before + 1, "pediu de novo");
        await eventually(() => getState().viewing.peerA?.status === "connecting");
        unwatch("peerA");
    });

    test("autorizou, mas a pessoa ja nao esta mais recusada (parou de assistir): nao pede de novo", async t => {
        const clock = useFakeClock(t);
        watch("peerA");
        call.room.receive("watch", { op: "denied", reason: "notVerified" }, "peerA");
        await eventually(() => getState().viewing.peerA?.denied === "notVerified");
        const before = starts();

        const done = authorizeAndRewatch("peerA");
        await eventually(() => modals.top());
        discord.approve();
        assert.equal(await done, true);
        unwatch("peerA");
        await flushPromises(); // a tela ja viu a sessao sumir
        clock.tick(5000);
        assert.equal(starts(), before, "sem sessao: nada a refazer");
    });

    test("cancelou a autorizacao: nao pede de novo", async t => {
        const clock = useFakeClock(t);
        watch("peerA");
        call.room.receive("watch", { op: "denied", reason: "notVerified" }, "peerA");
        await eventually(() => getState().viewing.peerA?.denied === "notVerified");
        const before = starts();

        const done = authorizeAndRewatch("peerA");
        await eventually(() => modals.top());
        modals.close(modals.top()!.key);
        assert.equal(await done, false);
        clock.tick(5000);
        assert.equal(starts(), before);
        unwatch("peerA");
    });

    test("o Discord recusa a troca do codigo: o estado explica e nada fica autorizado", async () => {
        await unlinkTelinhaIdentity();
        assert.equal(status(), "unauthorized");
        discord.tokenStatus = 400;
        const done = authorizeTelinhaIdentity();
        await eventually(() => modals.top());
        discord.approve();
        assert.equal(await done, false);
        const state = getLocalIdentity();
        assert.equal(state.status, "error");
        assert.match(state.status === "error" ? state.error : "", /invalid_grant/);
        discord.tokenStatus = 200;
    });

    test("desvincular: esquece o token desta conta neste PC", async () => {
        const done = authorizeTelinhaIdentity();
        await eventually(() => modals.top());
        discord.approve();
        assert.equal(await done, true);
        assert.equal(status(), "ready");

        await unlinkTelinhaIdentity();
        assert.equal(status(), "unauthorized");
        assert.ok(logLines().some(l => /Telinha desvinculado desta conta/.test(l)));
    });
});
