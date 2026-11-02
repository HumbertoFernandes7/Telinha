/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do transmissor (core/streaming.ts) pelo nucleo inteiro, so com os fakes: comecar/parar, cada erro da captura,
// audio da janela e da tela inteira, a captura que termina sozinha, trocar de fonte no ar, o envio para cada espectador
// (addStream que chega atrasado ou falha), os eventos da sessao e o tick de 1 s. O relogio e falso no arquivo inteiro
// (test/helpers/wpb-streaming.ts): o tick da sessao so roda quando o teste avanca o tempo.
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { STREAM_KIND_SCREEN } from "@plugins/telinha/protocol";
import { getState } from "@plugins/telinha/store";
import type { StreamOptions } from "@plugins/telinha/types";
import { installWebAudio } from "@test/fakes/audio";
import { defaultTelinhaNatives, installNative } from "@test/fakes/native";
import { FRIEND_ID, OTHER_ID, pluginSettings } from "@test/fakes/vencord";
import { audioTrack, captureStream, FakeMediaStream, type FakeMediaStreamTrack, videoSenderStats } from "@test/fakes/webrtc";
import {
    canvas2d, connectViewer, createRig, destroyRig, enterCall, leaveCall, logMark, media, removalsFrom, repliesTo, screenOptions, seconds, setMembers,
    type StreamingRig, streamsTo, turns, videoSenderOf, windowOptions
} from "@test/helpers/wpb-streaming";

import { refreshGpuCapture, resetCaptureBoostForTests } from "./captureBoost";
import { rt } from "./context";
import { BLACK_WARNING } from "./quality/captureMonitor";
import {
    approveViewer, getStreamAccess, getStreamPassword, kickViewer, sendPlanFor, startStreaming, stopStreaming, tick
} from "./streaming";

// discordUserIds (snowflakes) dos espectadores falsos, alem de FRIEND_ID e OTHER_ID
const ID = {
    a: FRIEND_ID, b: OTHER_ID, c: "600000000000000006", d: "700000000000000007", e: "800000000000000008", f: "900000000000000009",
    g: "110000000000000011", h: "120000000000000012", i: "130000000000000013", j: "140000000000000014", k: "150000000000000015",
    l: "160000000000000016", m: "170000000000000017", n: "180000000000000018", o: "190000000000000019", p: "210000000000000021",
    q: "220000000000000022", r: "230000000000000023", s: "240000000000000024"
};

const ENTER_CALL = "Entre em um canal de voz para transmitir.";
const REFUSED = "A captura foi recusada. Se a janela foi fechada, escolha outra.";
const NOT_CAPTURABLE = "Não foi possível capturar essa fonte (a janela foi fechada ou está protegida).";
const NEEDS_CLICK = "O Discord só permite iniciar a captura logo após um clique. Tente de novo.";
const NOT_INTERCEPTED = "O pedido de captura não chegou ao Telinha (outro plugin pode estar interceptando a captura de tela).";

let rig: StreamingRig;

/** A captura e os nativos voltam ao padrao (1920x1080@60, handler ok, sem ajudante de audio). */
function resetCapture() {
    rig.rtc.mediaDevices.getDisplayMediaImpl = constraints => Promise.resolve(captureStream({ audio: !!constraints.audio }));
    Object.assign(rig.native.telinha, defaultTelinhaNatives());
}

const callsOf = (name: string) => rig.native.calls.filter(c => c.name === name);
const lastPresenceTo = (peerId: string) => rig.room.sentOn("presence", peerId).at(-1)?.data;

before(() => {
    rig = createRig();
});

after(() => destroyRig(rig));

describe("startStreaming: validacao e erros de captura", () => {
    afterEach(() => {
        stopStreaming();
        resetCapture();
    });

    test("fora de uma call: pede para entrar num canal de voz e nao abre a captura", async () => {
        await assert.rejects(startStreaming(screenOptions()), { message: ENTER_CALL });
        await turns(1);
        assert.equal(getState().lastError, ENTER_CALL);
        assert.equal(rig.rtc.mediaDevices.displayMediaCalls.length, 0);
        assert.equal(callsOf("prepareDisplayMedia").length, 0);
    });

    test("opcoes invalidas: recusadas antes de abrir a captura, com a frase pronta", async () => {
        await enterCall(rig, [ID.a]);
        const cases: [Partial<Record<keyof StreamOptions, unknown>>, string][] = [
            [{ source: undefined }, "Fonte de captura inválida."],
            [{ source: { id: "screen:abc", name: "x", kind: "screen" } }, "Fonte de captura inválida."],
            [{ source: { id: 42, name: "x", kind: "screen" } }, "Fonte de captura inválida."],
            [{ quality: "4k" }, "Qualidade inválida."],
            [{ access: "todos" }, "Opção de \"Quem pode assistir\" inválida."],
            [{ access: "password" }, "Digite ou gere uma senha para esta transmissão."],
            [{ access: "password", password: "   " }, "Digite ou gere uma senha para esta transmissão."],
            [{ access: "password", password: 42 }, "Digite ou gere uma senha para esta transmissão."],
            [{ access: "password", password: "x".repeat(65) }, "A senha pode ter no máximo 64 caracteres."]
        ];
        for (const [over, message] of cases) {
            await assert.rejects(startStreaming(screenOptions(over as Partial<StreamOptions>)), { message }, JSON.stringify(over));
        }
        assert.equal(rig.rtc.mediaDevices.displayMediaCalls.length, 0);
        assert.equal(getStreamAccess(), null);
    });

    test("outro pedido enquanto a captura abre: 'ja esta sendo iniciada', e o primeiro segue", async () => {
        let release!: (ok: boolean) => void;
        rig.native.telinha.prepareDisplayMedia = () => new Promise<boolean>(resolve => {
            release = resolve;
        });
        const first = startStreaming(screenOptions());
        await assert.rejects(startStreaming(screenOptions()), { message: "A transmissão já está sendo iniciada." });
        release(true);
        await first;
        assert.equal(getStreamAccess(), "all");
        assert.equal(rig.rtc.mediaDevices.displayMediaCalls.length, 1);
    });

    test("sem a parte nativa do plugin: a mensagem manda reabrir o Discord", async () => {
        rig.native.restore();
        try {
            await assert.rejects(startStreaming(screenOptions()), /^Error: A parte nativa do Telinha não está carregada/);
        } finally {
            rig.native = installNative();
        }
        await turns(1);
        assert.match(getState().lastError ?? "", /^A parte nativa do Telinha não está carregada/);
    });

    test("o getDisplayMedia recusa: cada erro vira uma frase que diz o que fazer", async () => {
        const cases: [string, unknown, string][] = [
            ["NotAllowedError", new DOMException("Permission denied", "NotAllowedError"), REFUSED],
            ["NotFoundError", new DOMException("no source", "NotFoundError"), NOT_CAPTURABLE],
            ["NotReadableError", new DOMException("could not start video source", "NotReadableError"), NOT_CAPTURABLE],
            ["AbortError", new DOMException("aborted", "AbortError"), NOT_CAPTURABLE],
            ["sem ativacao", new DOMException("getDisplayMedia requires transient activation", "InvalidStateError"), NEEDS_CLICK],
            ["sem gesto", new Error("must be handling a user gesture to show a permission request"), NEEDS_CLICK],
            ["outro erro", new TypeError("boom"), "Falha ao capturar: TypeError: boom"],
            ["texto", "quebrou", "Falha ao capturar: quebrou"],
            ["sem erro nenhum", undefined, "Falha ao capturar: undefined"]
        ];
        for (const [label, error, message] of cases) {
            const since = logMark();
            rig.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.reject(error);
            await assert.rejects(startStreaming(screenOptions()), { message }, label);
            await turns(1);
            assert.equal(getState().lastError, message, label);
            assert.equal(getState().local, null, label);
            assert.deepEqual(since(), ['Iniciando transmissão: tela "Tela inteira" em 1080p60 sem áudio', `Não foi possível transmitir: ${message}`], label);
        }
        assert.equal(callsOf("finishDisplayMedia").length, cases.length, "o relatorio do handler e lido em cada falha");
    });

    test("o handler de captura nao foi chamado (outro plugin interceptou): diz isso, seja qual for o erro", async () => {
        rig.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
        rig.native.telinha.finishDisplayMedia = async () => ({ handlerCalled: false, audioRequested: false, audio: null, error: null });
        await assert.rejects(startStreaming(screenOptions()), { message: NOT_INTERCEPTED });

        // sem relatorio nenhum (o nativo falhou): tambem nao da para saber se o handler rodou
        rig.native.telinha.finishDisplayMedia = () => Promise.reject(new Error("ipc caiu"));
        await assert.rejects(startStreaming(screenOptions()), { message: NOT_INTERCEPTED });
    });

    test("o handler de captura reporta um erro: vai para o log e a frase segue o erro do getDisplayMedia", async () => {
        const since = logMark();
        rig.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.reject(new DOMException("gone", "NotFoundError"));
        rig.native.telinha.finishDisplayMedia = async () => ({ handlerCalled: true, audioRequested: false, audio: null, error: "fonte nao encontrada" });
        await assert.rejects(startStreaming(screenOptions()), { message: NOT_CAPTURABLE });
        assert.ok(since().includes("Handler de captura: fonte nao encontrada"));
    });

    test("captura sem faixa de video: recusada, e a faixa que veio e parada", async () => {
        const audio = audioTrack();
        rig.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.resolve(new FakeMediaStream([audio]));
        await assert.rejects(startStreaming(screenOptions()), { message: "A captura veio sem vídeo." });
        assert.equal(audio.readyState, "ended");
        assert.equal(getStreamAccess(), null);
    });

    test("erro que nao e um Error (o nativo rejeita com um texto): vira Error com o mesmo texto", async () => {
        rig.native.telinha.prepareDisplayMedia = () => Promise.reject("nativo caiu");
        const err = await startStreaming(screenOptions()).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof Error);
        assert.equal(err.message, "nativo caiu");
        await turns(1);
        assert.equal(getState().lastError, "nativo caiu");
    });
});

describe("startStreaming: tela, janela e audio", () => {
    afterEach(() => {
        stopStreaming();
        resetCapture();
    });

    test("tela inteira sem audio: a captura pedida, a presenca anunciada e o estado publicado; parar desfaz tudo", async () => {
        await connectViewer(rig, "peerA", ID.a, "amigo");
        const since = logMark();
        await startStreaming(screenOptions({ quality: "1080p30" }));

        assert.deepEqual(callsOf("prepareDisplayMedia").at(-1)?.args, ["screen:0:0", "Tela inteira", false]);
        assert.deepEqual(rig.rtc.mediaDevices.displayMediaCalls.at(-1), {
            video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } },
            audio: false
        });
        assert.deepEqual(lastPresenceTo("peerA").stream, { kind: "screen", title: "Tela inteira", hasAudio: false, width: 1920, height: 1080, fps: 60, access: "all" });
        assert.equal(lastPresenceTo("peerA").streaming, true);
        await turns(1);
        const local = getState().local!;
        assert.deepEqual([local.quality, local.hasAudio, local.access, local.viewers, local.source.id], ["1080p30", false, "all", [], "screen:0:0"]);
        assert.equal(getState().lastError, null);
        const video = rt.local!.stream.getVideoTracks()[0];
        assert.equal(video.contentHint, "motion");
        assert.deepEqual(since(), [
            'Iniciando transmissão: tela "Tela inteira" em 1080p30 sem áudio',
            "Transmitindo 1920x1080 @ 60 fps · quem pode assistir: Todos da call",
            // core/captureBoost.ts: o modo da captura, para comparar com e sem a "Captura pela placa de vídeo"
            "Modo da captura: padrão (cópia pelo processador) · prioridade na placa de vídeo: normal (opção desligada)"
        ]);

        const stopLogs = logMark();
        stopStreaming();
        assert.equal(video.readyState, "ended");
        assert.equal(lastPresenceTo("peerA").streaming, false);
        await turns(1);
        assert.equal(getState().local, null);
        assert.deepEqual(stopLogs(), ["Transmissão encerrada (parada pelo usuário)"]);

        // parar de novo, sem transmissao: nada acontece
        stopStreaming();
        assert.deepEqual(stopLogs(), ["Transmissão encerrada (parada pelo usuário)"]);
    });

    test("transmissao nova sem escolher quem pode assistir: 'Todos da call'", async () => {
        await startStreaming(screenOptions({ access: undefined }));
        assert.equal(getStreamAccess(), "all");
        assert.equal(lastPresenceTo("peerA").stream.access, "all");
    });

    test("captura sem tamanho nas configuracoes: vale o perfil escolhido; o titulo e cortado em 200 caracteres", async () => {
        rig.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.resolve(captureStream({ video: { width: undefined, height: undefined, frameRate: undefined } }));
        await startStreaming(screenOptions({ quality: "720p60", source: { id: "screen:1:0", name: "x".repeat(250), kind: "screen" } }));
        const { stream } = lastPresenceTo("peerA");
        assert.deepEqual([stream.width, stream.height, stream.fps, stream.title.length], [1280, 720, 60, 200]);
    });

    test("janela com audio: o audio do processo da janela vem no getDisplayMedia", async () => {
        rig.native.telinha.finishDisplayMedia = async () => ({ handlerCalled: true, audioRequested: true, audio: { device: "loopback", reason: "processo do jogo (pid 1234)" }, error: null });
        const since = logMark();
        await startStreaming(windowOptions({ withAudio: true }));

        assert.deepEqual(callsOf("prepareDisplayMedia").at(-1)?.args, ["window:1234:0", "Jogo", true]);
        assert.deepEqual(rig.rtc.mediaDevices.displayMediaCalls.at(-1)?.audio, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
        await turns(1);
        assert.equal(getState().local?.hasAudio, true);
        assert.equal(rt.local!.stream.getAudioTracks()[0].contentHint, "music");
        assert.deepEqual(since(), [
            'Iniciando transmissão: janela "Jogo" em 1080p60 com áudio',
            "Áudio: capturando — processo do jogo (pid 1234)",
            "Transmitindo 1920x1080 @ 60 fps com áudio · quem pode assistir: Todos da call",
            "Modo da captura: padrão (cópia pelo processador) · prioridade na placa de vídeo: normal (opção desligada)"
        ]);
    });

    test("janela com audio pedido, mas sem faixa de audio e sem relatorio do handler: transmite so a imagem", async () => {
        rig.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.resolve(captureStream());
        rig.native.telinha.finishDisplayMedia = () => Promise.reject(new Error("ipc caiu"));
        const since = logMark();
        await startStreaming(windowOptions({ withAudio: true }));
        await turns(1);
        assert.equal(getState().local?.hasAudio, false);
        assert.ok(since().includes("Áudio: sem faixa de áudio — sem decisão do handler"));
    });

    test("tela inteira com audio: a faixa do ajudante (o PC sem o Discord) entra no stream e para junto", async () => {
        const audio = installWebAudio();
        try {
            rig.native.telinha.startScreenAudio = async () => ({ ok: true, id: 7, sampleRate: 48000, channels: 2 });
            rig.native.telinha.readScreenAudio = () => new Promise(() => { }); // nada chega: a faixa fica no ar
            const since = logMark();
            await startStreaming(screenOptions({ withAudio: true }));

            assert.deepEqual(callsOf("prepareDisplayMedia").at(-1)?.args, ["screen:0:0", "Tela inteira", false], "o getDisplayMedia nao pede audio para a tela");
            assert.equal(rig.rtc.mediaDevices.displayMediaCalls.at(-1)?.audio, false);
            await turns(1);
            assert.equal(getState().local?.hasAudio, true);
            assert.equal(rt.local!.stream.getAudioTracks()[0].label, "MediaStreamAudioDestinationNode");
            assert.ok(since().includes("Áudio da tela: capturando o PC sem o Discord"));

            stopStreaming();
            await turns();
            assert.deepEqual(callsOf("stopScreenAudio").at(-1)?.args, [7], "parar a transmissao encerra o ajudante");
        } finally {
            audio.restore();
        }
    });

    test("o audio da tela para no meio: a transmissao continua, com o aviso", async () => {
        const audio = installWebAudio();
        try {
            let endAudio!: (r: unknown) => void;
            rig.native.telinha.startScreenAudio = async () => ({ ok: true, id: 8, sampleRate: 48000, channels: 2 });
            rig.native.telinha.readScreenAudio = () => new Promise(resolve => {
                endAudio = resolve;
            });
            await startStreaming(screenOptions({ withAudio: true }));
            endAudio({ pcm: null, ended: true, reason: "o ajudante fechou" });
            await turns();
            assert.notEqual(getState().local, null, "a transmissao segue");
            assert.equal(getState().lastError, "A transmissão continua, mas sem áudio: o ajudante fechou.");
        } finally {
            audio.restore();
        }
    });

    test("sem o ajudante de audio: transmite a tela so com imagem, com um aviso no log", async () => {
        const since = logMark();
        await startStreaming(screenOptions({ withAudio: true }));
        await turns(1);
        assert.equal(getState().local?.hasAudio, false);
        const lines = since();
        assert.ok(lines.includes("Sem áudio da tela: sem ajudante de áudio (fake). Transmitindo a tela sem áudio."), lines.join("\n"));
        assert.ok(lines.includes("Áudio da tela: sem faixa de áudio"));
    });

    test("sair do canal de voz enquanto a captura abre: a captura e fechada e o erro explica", async () => {
        const captured: FakeMediaStream[] = [];
        rig.rtc.mediaDevices.getDisplayMediaImpl = async () => {
            await leaveCall(rig);
            captured.push(captureStream());
            return captured[0];
        };
        await assert.rejects(startStreaming(screenOptions()), { message: "Você saiu do canal de voz enquanto a transmissão começava." });
        assert.equal(captured.length, 1);
        assert.ok(captured[0].getTracks().every(t => t.readyState === "ended"));
        await turns(1);
        assert.equal(getState().lastError, "Você saiu do canal de voz enquanto a transmissão começava.");
        // de volta a call (sala nova): os proximos testes usam esta
        await enterCall(rig);
    });

    test("a captura termina sozinha (janela fechada): a transmissao para, tira o stream de quem assiste e avisa", async () => {
        pluginSettings.set("requireVerifiedIdentity", false);
        try {
            await connectViewer(rig, "peerB", ID.b, "bia");
            await startStreaming(windowOptions());
            rig.room.receive("watch", { op: "start" }, "peerB");
            assert.equal(streamsTo(rig.room, "peerB").length, 1);
            await turns();
            const since = logMark();
            const video = streamsTo(rig.room, "peerB")[0].stream.getVideoTracks()[0] as FakeMediaStreamTrack;
            video.end();
            await turns(1);
            assert.equal(getState().local, null);
            assert.equal(getState().lastError, "A transmissão parou: a janela foi fechada ou a captura foi interrompida.");
            assert.equal(removalsFrom(rig.room, "peerB").length, 1);
            assert.deepEqual(since(), [
                "A captura terminou sozinha (janela fechada ou captura interrompida pelo sistema)",
                "Transmissão encerrada (a captura terminou)"
            ]);
        } finally {
            pluginSettings.set("requireVerifiedIdentity", true);
        }
    });

    test("a captura termina sozinha com a captura pela placa de video valendo: o log e a mensagem dizem que a placa pode ter reiniciado", async () => {
        rig.native.restore();
        rig.native = installNative({
            gpuCaptureStatus: async () => ({ loader: true, build: 26300, supported: true, saved: true, requested: true, applied: true, loaderNote: null, enableFeatures: null, saveError: null })
        });
        try {
            await refreshGpuCapture();
            await startStreaming(screenOptions());
            await turns();
            const since = logMark();
            (rt.local!.stream.getVideoTracks()[0] as FakeMediaStreamTrack).end();
            await turns(1);
            assert.equal(getState().local, null);
            assert.equal(getState().lastError, "A transmissão parou: a placa de vídeo provavelmente reiniciou. É só transmitir de novo.");
            assert.deepEqual(since(), [
                "A captura terminou sozinha com a captura pela placa de vídeo ligada: provavelmente a placa de vídeo reiniciou ou trocou (o Chromium não volta sozinho nesse caso)",
                "Transmissão encerrada (a captura terminou)"
            ]);
        } finally {
            rig.native.restore();
            rig.native = installNative();
            resetCaptureBoostForTests();
        }
    });

    test("trocar de fonte no ar: quem assiste continua (com a captura nova) e o modo de acesso continua", async () => {
        await connectViewer(rig, "peerC", ID.c, "caio");
        await startStreaming(screenOptions({ access: "approval" }));
        rig.room.receive("watch", { op: "start" }, "peerC");
        assert.equal(approveViewer("peerC"), true);
        const oldStream = streamsTo(rig.room, "peerC")[0].stream;

        const since = logMark();
        await startStreaming(windowOptions({ access: undefined }));
        assert.equal(getStreamAccess(), "approval", "sem escolha nova, o modo continua");
        assert.ok(oldStream.getTracks().every(t => t.readyState === "ended"), "a captura antiga foi parada");
        assert.equal(removalsFrom(rig.room, "peerC").at(-1)?.stream, oldStream);
        const sends = streamsTo(rig.room, "peerC");
        assert.equal(sends.length, 2);
        assert.notEqual(sends[1].stream, oldStream, "recebe a captura nova");
        await turns(1);
        assert.deepEqual([getState().local?.source.id, getState().local?.viewers], ["window:1234:0", ["peerC"]]);
        assert.ok(since().includes("Transmissão encerrada (trocando de fonte)"));

        // um "ended" atrasado da faixa antiga nao derruba a transmissao nova
        oldStream.getVideoTracks()[0].dispatchEvent(new Event("ended"));
        await turns(1);
        assert.equal(getState().local?.source.id, "window:1234:0");
        assert.equal(getState().lastError, null);

        // com uma escolha nova, ela vale; quem assiste continua
        await startStreaming(screenOptions({ access: "all" }));
        assert.equal(getStreamAccess(), "all");
        await turns(1);
        assert.deepEqual(getState().local?.viewers, ["peerC"]);
    });

    test("trocar de fonte com senha: a senha continua valendo; ao parar ela some", async () => {
        await startStreaming(screenOptions({ access: "password", password: "  pipoca-42 " }));
        assert.equal(getStreamPassword(), "pipoca-42", "normalizada");
        await startStreaming(windowOptions({ access: undefined }));
        assert.equal(getStreamPassword(), "pipoca-42");
        stopStreaming();
        assert.equal(getStreamPassword(), null);
    });

    test("trocar de fonte e a captura nova falha: a transmissao atual continua, com quem assiste", async () => {
        await startStreaming(screenOptions({ access: "approval" }));
        rig.room.receive("watch", { op: "start" }, "peerC");
        approveViewer("peerC");
        const current = rt.local!.stream;
        rig.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
        await assert.rejects(startStreaming(windowOptions({ access: undefined })), { message: REFUSED });
        await turns(1);
        assert.deepEqual([getState().local?.source.id, getState().local?.viewers], ["screen:0:0", ["peerC"]]);
        assert.ok(current.getTracks().every(t => t.readyState === "live"));
    });

    test("falha ao tirar o stream dos espectadores ao parar: so vira aviso, e a transmissao para", async t => {
        await connectViewer(rig, "peerD", ID.d, "duda");
        await startStreaming(screenOptions({ access: "approval" }));
        rig.room.receive("watch", { op: "start" }, "peerD");
        approveViewer("peerD");
        t.mock.method(rig.room, "removeStream", () => {
            throw new Error("sala fechando");
        });
        const since = logMark();
        stopStreaming();
        await turns(1);
        assert.equal(getState().local, null);
        assert.ok(since().includes("Falha ao remover o stream dos espectadores: Error: sala fechando"));
    });
});

describe("pedidos para assistir e o envio para cada espectador", () => {
    before(() => {
        // "Todos da call" sem exigir identidade verificada: o pedido vira envio direto
        pluginSettings.set("requireVerifiedIdentity", false);
    });

    after(() => {
        pluginSettings.set("requireVerifiedIdentity", true);
    });

    afterEach(() => {
        stopStreaming();
        rig.room.addStreamMode = "resolve";
    });

    test("pedido de quem esta na call: o stream vai so para ele, com os parametros de envio; 'stop' tira", async () => {
        const pc = await connectViewer(rig, "peerE", ID.e, "edu");
        await startStreaming(screenOptions());
        const since = logMark();
        rig.room.receive("watch", { op: "start" }, "peerE");
        assert.deepEqual(streamsTo(rig.room, "peerE").map(c => c.metadata), [{ kind: STREAM_KIND_SCREEN }]);
        await turns();
        const sender = videoSenderOf(pc)!;
        assert.deepEqual(sender.encoding, { active: true, maxBitrate: 20_000_000, maxFramerate: 60, scaleResolutionDownBy: 1, priority: "high", networkPriority: "high" });
        assert.equal(sender.params.degradationPreference, "balanced", "VP9: encoder por software");
        assert.deepEqual(getState().local?.viewers, ["peerE"]);
        assert.deepEqual(since(), [
            "Enviando para edu (peerE): codec VP9 (automático: o espectador não decodifica H.264 por hardware → VP9)",
            "Envio para edu (peerE): 1080p 60 fps, até 20000 kbps, encoder por software: equilibra resolução e fps (num soluço os dois cedem um pouco)"
        ]);

        // pedir de novo assistindo: nada muda
        rig.room.receive("watch", { op: "start" }, "peerE");
        assert.equal(streamsTo(rig.room, "peerE").length, 1);

        rig.room.receive("watch", { op: "stop" }, "peerE");
        assert.equal(removalsFrom(rig.room, "peerE").length, 1);
        await turns(1);
        assert.deepEqual(getState().local?.viewers, []);
        assert.ok(since().includes("edu (peerE) deixou de receber a transmissão (parou de assistir)"));
        // "stop" de quem nao assiste: nada a tirar
        rig.room.receive("watch", { op: "stop" }, "peerE");
        assert.equal(removalsFrom(rig.room, "peerE").length, 1);
    });

    test("sendPlanFor: a banda (inicio fixo, teto da qualidade) para qualquer peer; o codec so para quem assiste", async () => {
        await startStreaming(screenOptions({ quality: "720p60" }));
        assert.equal(sendPlanFor(null), null);
        assert.deepEqual(sendPlanFor("peerE"), { codec: null, h264Profile: null, bitrate: { startKbps: 4000, maxKbps: 12000 }, label: "edu (peerE)" }, "ainda nao assiste");
        rig.room.receive("watch", { op: "start" }, "peerE");
        assert.deepEqual(sendPlanFor("peerE"), { codec: "vp9", h264Profile: null, bitrate: { startKbps: 4000, maxKbps: 12000 }, label: "edu (peerE)" });
        stopStreaming();
        assert.deepEqual(sendPlanFor("peerE"), { codec: null, h264Profile: null, bitrate: { startKbps: 4000, maxKbps: 20000 }, label: "edu (peerE)" }, "sem transmissao");
    });

    test("addStream que termina depois de o espectador desistir: o envio e desfeito (e uma falha nisso so avisa)", async t => {
        const pc = await connectViewer(rig, "peerF", ID.f, "fabi");
        await startStreaming(screenOptions());
        rig.room.addStreamMode = "manual";
        rig.room.receive("watch", { op: "start" }, "peerF");
        rig.room.receive("watch", { op: "stop" }, "peerF");
        assert.equal(removalsFrom(rig.room, "peerF").length, 1);

        const since = logMark();
        rig.room.settleStreams(true);
        await turns();
        assert.equal(removalsFrom(rig.room, "peerF").length, 2, "tira de novo o que chegou atrasado");
        assert.deepEqual(since(), ["Envio para fabi (peerF) desfeito (ele deixou de ser espectador enquanto a mídia era preparada)"]);
        assert.ok(pc.getSenders().every(s => s.setCalls.length === 0), "sem parametros de envio para quem desistiu");

        // de novo, com o removeStream falhando
        rig.room.receive("watch", { op: "start" }, "peerF");
        rig.room.receive("watch", { op: "stop" }, "peerF");
        t.mock.method(rig.room, "removeStream", () => {
            throw new Error("peer sumiu");
        });
        rig.room.settleStreams(true);
        await turns();
        assert.ok(since().includes("Falha ao remover o stream: Error: peer sumiu"));
    });

    test("addStream que falha: o espectador sai da lista (e pode pedir de novo)", async () => {
        await connectViewer(rig, "peerG", ID.g, "gabi");
        await startStreaming(screenOptions());
        rig.room.addStreamMode = "reject";
        const since = logMark();
        rig.room.receive("watch", { op: "start" }, "peerG");
        await turns();
        assert.deepEqual(getState().local?.viewers, []);
        assert.equal(getState().local?.autoQuality?.viewers.peerG, undefined, "a qualidade automatica esqueceu ele");
        assert.ok(since().includes("Falha ao enviar o stream para gabi (peerG): Error: fake addStream falhou"));

        rig.room.addStreamMode = "resolve";
        rig.room.receive("watch", { op: "start" }, "peerG");
        await turns();
        assert.deepEqual(getState().local?.viewers, ["peerG"]);
    });

    test("addStream que falha depois de o espectador desistir: o envio e desfeito", async () => {
        await startStreaming(screenOptions());
        rig.room.addStreamMode = "manual";
        rig.room.receive("watch", { op: "start" }, "peerG");
        rig.room.receive("watch", { op: "stop" }, "peerG");
        const since = logMark();
        rig.room.settleStreams(false);
        await turns();
        assert.deepEqual(since(), [
            "Falha ao enviar o stream para gabi (peerG): Error: fake addStream falhou",
            "Envio para gabi (peerG) desfeito (ele deixou de ser espectador enquanto a mídia era preparada)"
        ]);
    });

    test("pedir, desistir e pedir de novo antes da midia ficar pronta: so o envio atual aplica os parametros", async () => {
        const pc = await connectViewer(rig, "peerH", ID.h, "heitor");
        await startStreaming(screenOptions());
        rig.room.addStreamMode = "manual";
        rig.room.receive("watch", { op: "start" }, "peerH");
        rig.room.receive("watch", { op: "stop" }, "peerH");
        rig.room.receive("watch", { op: "start" }, "peerH");
        const since = logMark();

        rig.room.settleStreams(true, 1); // o primeiro addStream (de um envio que ja foi substituido)
        await turns();
        assert.deepEqual(since(), [], "nem desfaz (ele assiste) nem aplica (nao e o envio atual)");
        assert.ok(pc.getSenders().every(s => s.setCalls.length === 0));

        rig.room.settleStreams(true);
        await turns();
        assert.equal(videoSenderOf(pc)?.setCalls.length, 1);
        assert.deepEqual(since(), ["Envio para heitor (peerH): 1080p 60 fps, até 20000 kbps, encoder por software: equilibra resolução e fps (num soluço os dois cedem um pouco)"]);
    });

    test("addStream antigo que falha com um pedido novo no ar: o espectador continua pelo envio novo", async () => {
        await startStreaming(screenOptions());
        rig.room.addStreamMode = "manual";
        rig.room.receive("watch", { op: "start" }, "peerH");
        rig.room.receive("watch", { op: "stop" }, "peerH");
        rig.room.receive("watch", { op: "start" }, "peerH");
        rig.room.settleStreams(false, 1); // falha o primeiro: ele assiste pelo segundo
        await turns();
        assert.deepEqual(getState().local?.viewers, ["peerH"]);
        rig.room.settleStreams(true);
    });

    test("'stop' com o removeStream falhando: so avisa, e ele sai da lista de quem assiste", async t => {
        await startStreaming(screenOptions());
        rig.room.receive("watch", { op: "start" }, "peerH");
        await turns();
        t.mock.method(rig.room, "removeStream", () => {
            throw new Error("transceiver fechado");
        });
        const since = logMark();
        rig.room.receive("watch", { op: "stop" }, "peerH");
        await turns(1);
        assert.deepEqual(getState().local?.viewers, []);
        assert.deepEqual(since(), [
            "Falha ao remover o stream: Error: transceiver fechado",
            "heitor (peerH) deixou de receber a transmissão (parou de assistir)"
        ]);
    });

    test("pedido sem transmissao no ar: responde com a presenca de novo (ele ve que voce parou)", async () => {
        const before = rig.room.sentOn("presence", "peerH").length;
        const since = logMark();
        rig.room.receive("watch", { op: "start" }, "peerH");
        assert.equal(rig.room.sentOn("presence", "peerH").length, before + 1);
        assert.equal(lastPresenceTo("peerH").streaming, false);
        assert.deepEqual(since(), ["heitor (peerH) pediu para assistir, mas você não está transmitindo"]);
    });

    test("pedido de quem esta fora da call: ignorado, sem resposta nenhuma", async () => {
        await connectViewer(rig, "peerI", ID.i, "ines", { inVoice: false });
        await startStreaming(screenOptions());
        const since = logMark();
        rig.room.receive("watch", { op: "start" }, "peerI");
        assert.deepEqual(repliesTo(rig.room, "peerI"), []);
        assert.equal(streamsTo(rig.room, "peerI").length, 0);
        assert.deepEqual(since(), ["ines (peerI) pediu para assistir, mas não está no seu canal de voz: recusado"]);
    });
});

describe("eventos da sessao e o tick de 1 s", () => {
    before(() => {
        pluginSettings.set("requireVerifiedIdentity", false);
    });

    after(() => {
        pluginSettings.set("requireVerifiedIdentity", true);
    });

    afterEach(() => {
        stopStreaming();
        canvas2d.pixels = null;
        canvas2d.available = true;
    });

    test("quem assiste sai da sala: sai da lista e da qualidade automatica; pedido pendente some", async () => {
        await connectViewer(rig, "peerJ", ID.j, "joao");
        await connectViewer(rig, "peerK", ID.k, "kaka");
        await startStreaming(screenOptions());
        rig.room.receive("watch", { op: "start" }, "peerJ");
        await turns(1);
        assert.ok(getState().local?.autoQuality?.viewers.peerJ);

        rig.room.disconnectPeer("peerJ");
        await turns(1);
        assert.deepEqual(getState().local?.viewers, []);
        assert.equal(getState().local?.autoQuality?.viewers.peerJ, undefined);

        // pedido pendente (modo "approval") de quem sai: some da lista de pendentes
        await startStreaming(screenOptions({ access: "approval" }));
        rig.room.receive("watch", { op: "start" }, "peerK");
        await turns(1);
        assert.equal(getState().local?.pendingViewers?.length, 1);
        rig.room.disconnectPeer("peerK");
        await turns(1);
        assert.deepEqual(getState().local?.pendingViewers, []);
        assert.equal(approveViewer("peerK"), false);
    });

    test("quem assiste sai do canal de voz: para de receber na hora", async () => {
        await connectViewer(rig, "peerJ2", ID.l, "joao");
        await startStreaming(screenOptions());
        rig.room.receive("watch", { op: "start" }, "peerJ2");
        const since = logMark();
        setMembers(rig, [...rig.members].filter(id => id !== ID.l));
        assert.equal(removalsFrom(rig.room, "peerJ2").length, 1);
        await turns(1);
        assert.deepEqual(getState().local?.viewers, []);
        assert.ok(since().includes("joao (peerJ2) deixou de receber a transmissão (saiu do seu canal de voz)"));
        setMembers(rig, [...rig.members, ID.l]);
    });

    test("desligar/ligar a qualidade automatica no ar: todos voltam ao teto e o estado diz isso", async () => {
        const idle = logMark();
        pluginSettings.set("autoQuality", false);
        pluginSettings.set("autoQuality", true);
        assert.deepEqual(idle().filter(l => l.startsWith("Qualidade automática")), [], "sem transmissao, nada a fazer");

        await startStreaming(screenOptions());
        const since = logMark();
        pluginSettings.set("autoQuality", false);
        await turns(1);
        assert.equal(getState().local?.autoQuality, null);
        pluginSettings.set("autoQuality", true);
        await turns(1);
        assert.equal(getState().local?.autoQuality?.current, "1080p60");
        assert.deepEqual(since(), [
            "Qualidade automática desligada: todos recebem 1080p 60 fps",
            "Qualidade automática ligada (teto 1080p 60 fps)"
        ]);
    });

    test("tick: quem deixou de poder receber sem nenhum evento avisar sai na proxima volta (defesa extra)", async () => {
        await connectViewer(rig, "peerJ3", ID.m, "joao");
        await connectViewer(rig, "peerK2", ID.n, "kaka");
        await connectViewer(rig, "peerL", ID.q, "lia");
        await startStreaming(screenOptions());
        for (const peerId of ["peerJ3", "peerK2", "peerL"]) rig.room.receive("watch", { op: "start" }, peerId);
        const since = logMark();
        // estado que a sessao muda sem avisar o streaming (escrito direto em rt: nenhum evento da sessao leva a isto)
        rt.peers.get("peerJ3")!.admitted = false;
        rt.peers.get("peerK2")!.duplicate = true;
        rt.blocked.set(ID.q, { discordUserId: ID.q, username: "lia", peerIds: new Set(["peerL"]), reason: "kicked" });
        tick();
        for (const peerId of ["peerJ3", "peerK2", "peerL"]) assert.equal(removalsFrom(rig.room, peerId).length, 1, peerId);
        assert.deepEqual(repliesTo(rig.room, "peerJ3"), [], "quem esta fora nao recebe resposta");
        assert.deepEqual(repliesTo(rig.room, "peerK2").at(-1), { op: "denied", reason: "duplicate" });
        assert.deepEqual(repliesTo(rig.room, "peerL").at(-1), { op: "denied", reason: "kicked" });
        assert.deepEqual(since(), [
            "joao (peerJ3) deixou de receber a transmissão (não está mais admitido)",
            "kaka (peerK2) deixou de receber a transmissão (outra conexão diz ser a mesma pessoa (identidade duplicada))",
            "lia (peerL) deixou de receber a transmissão (foi expulso por você)"
        ]);
        rt.peers.get("peerJ3")!.admitted = true;
        rt.peers.get("peerK2")!.duplicate = false;
        rt.blocked.delete(ID.q);
    });

    test("trocar de fonte com quem deixou de poder receber sem nenhum evento avisar: nao recebe a captura nova (defesa extra)", async () => {
        await connectViewer(rig, "peerM", ID.r, "malu");
        await connectViewer(rig, "peerN", ID.s, "nico");
        await startStreaming(screenOptions());
        rig.room.receive("watch", { op: "start" }, "peerM");
        rig.room.receive("watch", { op: "start" }, "peerN");
        rt.peers.get("peerM")!.admitted = false;
        rt.peers.get("peerN")!.duplicate = true;
        const since = logMark();
        await startStreaming(windowOptions());
        assert.equal(streamsTo(rig.room, "peerM").length, 1, "so a captura antiga");
        assert.equal(streamsTo(rig.room, "peerN").length, 1);
        assert.deepEqual(repliesTo(rig.room, "peerM"), []);
        assert.deepEqual(repliesTo(rig.room, "peerN").at(-1), { op: "denied", reason: "duplicate" });
        await turns(1);
        assert.deepEqual(getState().local?.viewers, []);
        const lines = since();
        assert.ok(lines.includes("malu (peerM) pediu para assistir, mas não está no seu canal de voz: recusado"));
        assert.ok(lines.includes("nico (peerN) pediu para assistir, mas outra conexão diz ser a mesma pessoa (identidade duplicada): recusado"));
        rt.peers.get("peerM")!.admitted = true;
        rt.peers.get("peerN")!.duplicate = false;
    });

    test("tick: pedido de senha sem resposta por 2 min e esquecido, com um aviso sobre versoes antigas", async () => {
        await startStreaming(screenOptions({ access: "password", password: "pipoca-42" }));
        rig.room.receive("watch", { op: "start" }, "peerJ3");
        assert.equal(repliesTo(rig.room, "peerJ3").at(-1)?.op, "password");
        const since = logMark();
        await seconds(rig, 119);
        assert.deepEqual(since().filter(l => l.includes("pedido de senha")), [], "ainda dentro dos 2 min");
        await seconds(rig, 2);
        assert.deepEqual(since().filter(l => l.includes("pedido de senha")), [
            "joao (peerJ3) não respondeu ao pedido de senha em 2 min: desistiu, ou usa uma versão antiga do Telinha (v0.1.0), "
            + "que não entende transmissão com senha (do lado dele o pedido expira sem resposta)"
        ]);
    });

    test("tick: a qualidade automatica le as estatisticas de envio a cada 2 s", async () => {
        const pc = await connectViewer(rig, "peerK3", ID.o, "kaka");
        await startStreaming(screenOptions());
        rig.room.receive("watch", { op: "start" }, "peerK3");
        await turns();
        const sender = videoSenderOf(pc)!;
        sender.stats = videoSenderStats();
        // 1o tick: o codec real (VP9) e logado; depois so a qualidade automatica le as estatisticas deste envio
        await seconds(rig, 2);
        const deltas: number[] = [];
        for (let i = 0; i < 4; i++) {
            const before = sender.getStatsCalls;
            await seconds(rig, 1);
            deltas.push(sender.getStatsCalls - before);
        }
        assert.equal(deltas[0] + deltas[1], 1, `uma leitura a cada 2 ticks: ${deltas}`);
        assert.equal(deltas[2] + deltas[3], 1, `uma leitura a cada 2 ticks: ${deltas}`);
    });

    test("monitor da captura: imagem preta por 2 s vira aviso no estado; voltando, o aviso some", async () => {
        await startStreaming(screenOptions());
        const video = media.played.at(-1)!;
        media.setFrame(video, { width: 64, height: 36 });
        canvas2d.pixels = (w, h) => new Uint8ClampedArray(w * h * 4);
        await seconds(rig, 3);
        assert.equal(getState().local?.captureWarning, BLACK_WARNING);
        canvas2d.pixels = null;
        await seconds(rig, 1);
        assert.equal(getState().local?.captureWarning, null);
    });

    test("monitor da captura sem canvas 2D: fica desligado e a transmissao segue sem avisos", async () => {
        canvas2d.available = false;
        canvas2d.pixels = (w, h) => new Uint8ClampedArray(w * h * 4);
        const played = media.played.length;
        await startStreaming(screenOptions());
        await seconds(rig, 3);
        assert.equal(media.played.length, played, "nenhum <video> do monitor");
        assert.equal(getState().local?.captureWarning, null);
    });

    test("sair da call transmitindo: a transmissao acaba, o motivo aparece e as expulsoes sao esquecidas", async () => {
        await connectViewer(rig, "peerK4", ID.p, "kaka");
        await startStreaming(screenOptions());
        rig.room.receive("watch", { op: "start" }, "peerJ3");
        assert.equal(kickViewer("peerK4"), true);
        await turns(1);
        assert.equal(getState().blocked?.length, 1);
        const since = logMark();
        await leaveCall(rig);
        await turns(1);
        assert.equal(getState().local, null);
        assert.equal(getState().lastError, "A transmissão foi encerrada porque você saiu do canal de voz.");
        assert.deepEqual(getState().blocked, []);
        assert.ok(since().includes("Transmissão encerrada (você saiu do canal de voz)"));
    });
});
