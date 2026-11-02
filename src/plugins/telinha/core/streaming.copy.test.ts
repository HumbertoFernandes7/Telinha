/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da copia na hora dentro da transmissao (core/streaming.ts + core/captureCopy.ts), com a "Captura pela placa de
// vídeo" valendo nesta partida e o navegador da copia falso (test/fakes/captureCopy.ts): os envios recebem a faixa
// copiada (com o contentHint), o resto continua na faixa ORIGINAL (tamanho, "ended"), espectador novo pede um reenvio,
// parar solta tudo, a copia morrendo no meio volta os envios para a original (replaceTrack), e sem a opcao ou sem as
// APIs nada muda (a original vai direto).
// Rodar:  pnpm test:file src/plugins/telinha/core/streaming.copy.test.ts

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getState } from "@plugins/telinha/store";
import { type FakeCopyEnv, fakeCopyEnv } from "@test/fakes/captureCopy";
import { installNative } from "@test/fakes/native";
import { FRIEND_ID, OTHER_ID, pluginSettings } from "@test/fakes/vencord";
import { captureStream, type FakeMediaStreamTrack } from "@test/fakes/webrtc";
import {
    connectViewer, createRig, destroyRig, enterCall, logMark, screenOptions, type StreamingRig, streamsTo, turns, videoSenderOf, windowOptions
} from "@test/helpers/wpb-streaming";

import { refreshGpuCapture, resetCaptureBoostForTests } from "./captureBoost";
import { resetCaptureCopyForTests, setCaptureCopyEnvForTests } from "./captureCopy";
import { captureTrackOf, rt } from "./context";
import { startStreaming, stopStreaming } from "./streaming";

const TEXTURE_ON = { loader: true, build: 26300, supported: true, saved: true, requested: true, applied: true, loaderNote: null, enableFeatures: null, saveError: null };

let rig: StreamingRig;
let fake: FakeCopyEnv;
/** a faixa de video que o getDisplayMedia falso entregou por ultimo */
let captured: FakeMediaStreamTrack | null = null;

async function textureCapture(on: boolean) {
    rig.native.restore();
    rig.native = installNative(on ? { gpuCaptureStatus: async () => TEXTURE_ON } : {});
    resetCaptureBoostForTests();
    if (on) await refreshGpuCapture();
}

before(async () => {
    rig = createRig();
    // "Todos da call" sem pedir aprovacao a quem nao provou a identidade
    pluginSettings.set("requireVerifiedIdentity", false);
    await enterCall(rig, [FRIEND_ID, OTHER_ID]);
    rig.rtc.mediaDevices.getDisplayMediaImpl = constraints => {
        const s = captureStream({ audio: !!constraints.audio, video: { width: 2560, height: 1440, frameRate: 60 } });
        captured = s.getVideoTracks()[0];
        return Promise.resolve(s);
    };
    await textureCapture(true);
});

after(async () => {
    pluginSettings.set("requireVerifiedIdentity", true);
    resetCaptureCopyForTests();
    resetCaptureBoostForTests();
    await destroyRig(rig);
});

beforeEach(() => {
    fake = fakeCopyEnv();
    setCaptureCopyEnvForTests(fake.env);
});

afterEach(async () => {
    stopStreaming();
    await turns();
});

describe("cópia na hora na transmissão", () => {
    test("os envios recebem a faixa copiada; tamanho, contentHint e o resto ficam com a captura original", async () => {
        const since = logMark();
        await startStreaming(windowOptions({ quality: "1440p60" }));
        const local = rt.local!;
        const generator = fake.generators[0];
        assert.ok(generator, "o gerador da cópia foi criado");
        assert.equal(fake.processors[0].track, captured, "o processador lê a faixa do getDisplayMedia");
        assert.deepEqual(local.stream.getVideoTracks(), [generator], "o que vai para os envios é a cópia");
        assert.equal(captureTrackOf(local), captured, "a faixa original fica guardada para o resto");
        assert.equal(captured!.contentHint, "motion");
        assert.equal(generator.contentHint, "motion", "o encoder lê o contentHint da faixa que o envio usa");
        // o tamanho vem da captura (2560x1440); o gerador falso diz 1920x1080: lido dele, viria o aviso de "1080p"
        assert.equal(local.info.width, 2560);
        assert.equal(getState().local?.sizeNote, undefined);
        assert.ok(since().some(l => l.startsWith("Captura pela placa: cópia na hora ligada (WebGPU, nvidia ampere)")));

        const pc = await connectViewer(rig, "peerA", FRIEND_ID, "ana");
        rig.room.receive("watch", { op: "start" }, "peerA");
        await turns();
        assert.equal(streamsTo(rig.room, "peerA").at(-1)?.stream, local.stream);
        assert.equal(videoSenderOf(pc)?.track, generator);
        assert.equal(fake.worker.ops().filter(o => o === "refresh").length, 1, "espectador novo: o último quadro é reenviado (tela parada)");
    });

    test("com a janela mudando de tamanho, o tamanho lido é o da captura, não o do gerador", async () => {
        await startStreaming(windowOptions({ quality: "1440p60" }));
        captured!.setSettings({ width: 1280, height: 720 });
        fake.generators[0].setSettings({ width: 2560, height: 1440 });
        await turns();
        rig.clock.tick(1000);
        await turns();
        assert.equal(getState().local?.sizeNote, "2K escolhido, a janela tem 720p: enviando 720p");
    });

    test("a captura termina sozinha: a transmissão para (mensagem da placa), a cópia e o gerador param", async () => {
        await startStreaming(screenOptions());
        const since = logMark();
        captured!.end();
        await turns();
        assert.equal(rt.local, null);
        assert.equal(getState().lastError, "A transmissão parou: a placa de vídeo provavelmente reiniciou. É só transmitir de novo.");
        assert.equal(fake.generators[0].readyState, "ended");
        assert.equal(fake.worker.ops().at(-1), "stop");
        assert.ok(since().includes("Transmissão encerrada (a captura terminou)"));
    });

    test("parar: a captura original, o gerador e o Worker param", async () => {
        await startStreaming(screenOptions());
        const generator = fake.generators[0];
        stopStreaming();
        assert.equal(captured!.readyState, "ended");
        assert.equal(generator.readyState, "ended");
        assert.equal(fake.worker.ops().at(-1), "stop");
        rig.clock.tick(1500);
        assert.equal(fake.worker.terminated, true);
    });

    test("a cópia morre no meio: os envios voltam para a captura original (replaceTrack) e quem entra depois recebe a original", async () => {
        await startStreaming(screenOptions());
        const pc = await connectViewer(rig, "peerB", OTHER_ID, "bia");
        rig.room.receive("watch", { op: "start" }, "peerB");
        await turns();
        const refreshes = fake.worker.ops().filter(o => o === "refresh").length;
        assert.equal(videoSenderOf(pc)?.track, fake.generators[0]);
        const since = logMark();
        fake.worker.fail("out of memory");
        await turns();
        assert.equal(videoSenderOf(pc)?.track, captured, "o envio voltou para a captura direta");
        assert.deepEqual(rt.local!.stream.getVideoTracks(), [captured]);
        assert.equal(rt.local!.copy, null);
        assert.equal(fake.generators[0].readyState, "ended");
        assert.deepEqual(since(), ["Captura pela placa: a cópia na hora parou (o Worker caiu: out of memory); os envios voltam para a captura direta"]);
        assert.ok(rt.local, "a transmissão continua");

        // quem entra depois da falha recebe a captura original
        const late = await connectViewer(rig, "peerC", "600000000000000006", "caio");
        rig.room.receive("watch", { op: "start" }, "peerC");
        await turns();
        assert.equal(videoSenderOf(late)?.track, captured);
        assert.equal(fake.worker.ops().filter(o => o === "refresh").length, refreshes, "sem cópia, nada de reenvio");
    });

    test("sem MediaStreamTrackGenerator: uma linha, e a captura vai direto (como antes)", async () => {
        setCaptureCopyEnvForTests({ ...fake.env, MediaStreamTrackGenerator: undefined });
        const since = logMark();
        await startStreaming(screenOptions());
        assert.deepEqual(rt.local!.stream.getVideoTracks(), [captured]);
        assert.equal(rt.local!.copy, null);
        assert.ok(since().includes("Captura pela placa: cópia na hora indisponível (sem MediaStreamTrackProcessor/Generator); a captura vai direto para os envios"));
    });

    test("sem a captura pela placa de vídeo nesta partida: nenhuma cópia (o caminho pelo processador já copia)", async () => {
        await textureCapture(false);
        try {
            await startStreaming(screenOptions());
            assert.equal(fake.workers.length, 0);
            assert.deepEqual(rt.local!.stream.getVideoTracks(), [captured]);
            assert.equal(rt.local!.captureTrack, captured);
        } finally {
            stopStreaming();
            await textureCapture(true);
        }
    });

    test("trocar de fonte no ar: a cópia antiga para e a nova liga", async () => {
        await startStreaming(screenOptions());
        const first = fake.workers[0];
        await startStreaming(windowOptions());
        assert.equal(first.ops().at(-1), "stop");
        assert.equal(fake.workers.length, 2);
        assert.deepEqual(rt.local!.stream.getVideoTracks(), [fake.generators[1]]);
    });
});
