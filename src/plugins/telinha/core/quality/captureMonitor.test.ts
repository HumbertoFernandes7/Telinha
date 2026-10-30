/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do detector de captura preta/congelada (core/quality/captureMonitor.ts). O <video> e o canvas sao os falsos de
// test/fakes/dom.ts: media.setFrame() da um quadro ao <video>, canvas2d.pixels() e a imagem que o getImageData devolve
// (64x36). O contador de quadros da fonte vem de MediaStreamTrack.stats.totalFrames ou do media-source de um sender
// (noteSourceFrames). Amostra a cada 500 ms (relogio falso).
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/captureMonitor.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { type FakeClock, useFakeClock } from "@test/fakes/clock";
import { canvas2d, media, resetMedia } from "@test/fakes/dom";
import { type FakeMediaStreamTrack, installWebRtc, videoTrack, type WebRtcEnv } from "@test/fakes/webrtc";
import { logsDuring } from "@test/helpers/wpb-quality";

import { BLACK_WARNING, CaptureMonitor, FROZEN_WARNING } from "./captureMonitor";

/**
 * Avanca de 500 em 500 ms: num tick so, os timers mockados do Node rodam todos com Date.now() (e performance.now())
 * ja no fim do tick, e as amostras de um intervalo longo sairiam todas no mesmo instante.
 */
function advance(clock: FakeClock, ms: number) {
    for (let left = ms; left > 0; left -= 500) clock.tick(Math.min(500, left));
}

const fill = (value: number) => (w: number, h: number) => new Uint8ClampedArray(w * h * 4).fill(value);
const BLACK = fill(0);
const GRAY = fill(128);

let rtc: WebRtcEnv;
before(() => {
    rtc = installWebRtc();
});
after(() => rtc.restore());
afterEach(() => resetMedia());

interface Run {
    monitor: CaptureMonitor;
    warnings: (string | null)[];
    track: FakeMediaStreamTrack;
    video: HTMLVideoElement;
}

/** Monitor iniciado com um <video> que ja tem quadro (1920x1080). `frames`: track.stats.totalFrames (null = sem stats). */
function startMonitor(kind: "screen" | "window", frames: { totalFrames: number; } | null = null): Run {
    const track = videoTrack();
    if (frames) (track as unknown as { stats: unknown; }).stats = frames;
    const warnings: (string | null)[] = [];
    const monitor = new CaptureMonitor({ track: track as unknown as MediaStreamTrack, kind, onWarning: w => warnings.push(w) });
    assert.equal(monitor.start(), true);
    const video = media.played.at(-1) as HTMLVideoElement;
    media.setFrame(video, { width: 1920, height: 1080 });
    return { monitor, warnings, track, video };
}

describe("captura preta", () => {
    test("preta por 2 s: avisa (tela ou janela); volta ao normal quando aparece imagem", async t => {
        const clock = useFakeClock(t);
        canvas2d.pixels = BLACK;
        const { monitor, warnings } = startMonitor("screen");
        advance(clock, 2000);
        assert.deepEqual(warnings, [], "1,5 s preta ainda nao");
        const lines = await logsDuring(() => advance(clock, 500));
        assert.deepEqual(warnings, [BLACK_WARNING]);
        assert.deepEqual(lines, ["Captura preta há 2 s (tela cheia exclusiva ou conteúdo protegido?)"]);

        advance(clock, 5000);
        assert.deepEqual(warnings, [BLACK_WARNING], "nao repete");
        canvas2d.pixels = GRAY;
        const back = await logsDuring(() => advance(clock, 500));
        assert.deepEqual(warnings, [BLACK_WARNING, null]);
        assert.deepEqual(back, ["Captura normal de novo (a imagem não está mais preta)"]);
        monitor.stop();
    });

    test("escura mas com algum ponto claro (acima de 24) nao e preta", t => {
        const clock = useFakeClock(t);
        canvas2d.pixels = (w, h) => {
            const px = new Uint8ClampedArray(w * h * 4);
            px.fill(200, 0, 4);
            return px;
        };
        const { monitor, warnings } = startMonitor("screen");
        advance(clock, 10_000);
        assert.deepEqual(warnings, []);
        monitor.stop();
    });
});

describe("janela congelada", () => {
    test("janela sem quadros novos (track.stats) e imagem identica por 3 s: avisa; quadros voltando: normal", async t => {
        const clock = useFakeClock(t);
        canvas2d.pixels = GRAY;
        const frames = { totalFrames: 100 };
        const { monitor, warnings } = startMonitor("window", frames);
        advance(clock, 3500);
        assert.deepEqual(warnings, []);
        const lines = await logsDuring(() => advance(clock, 500));
        assert.deepEqual(warnings, [FROZEN_WARNING]);
        assert.deepEqual(lines, ["Captura congelada: a janela não manda quadros novos há 4 s (minimizada?)"]);

        frames.totalFrames = 160;
        const back = await logsDuring(() => advance(clock, 500));
        assert.deepEqual(warnings, [FROZEN_WARNING, null]);
        assert.deepEqual(back, ["Captura normal de novo (quadros voltaram a chegar)"]);
        monitor.stop();
    });

    test("imagem parada com quadros chegando (desktop, menu pausado) nao e congelada; tela inteira nunca e", t => {
        const clock = useFakeClock(t);
        canvas2d.pixels = GRAY;
        const frames = { totalFrames: 0 };
        const win = startMonitor("window", frames);
        for (let i = 0; i < 20; i++) {
            frames.totalFrames += 30;
            advance(clock, 500);
        }
        assert.deepEqual(win.warnings, []);
        win.monitor.stop();

        const screen = startMonitor("screen", { totalFrames: 5 });
        advance(clock, 10_000);
        assert.deepEqual(screen.warnings, []);
        screen.monitor.stop();
    });

    test("sem track.stats: o contador do media-source de um sender; parado e velho (> 6 s) nao serve; trocar de sender recomeca", t => {
        const clock = useFakeClock(t);
        canvas2d.pixels = GRAY;
        const { monitor, warnings } = startMonitor("window");
        monitor.noteSourceFrames("A", 50);
        for (let i = 0; i < 8; i++) {
            advance(clock, 500);
            monitor.noteSourceFrames("A", 50);
        }
        assert.deepEqual(warnings, [FROZEN_WARNING], "o contador do sender A parou");

        // outro sender (A saiu): o contador dele comeca agora
        monitor.noteSourceFrames("B", 7);
        advance(clock, 500);
        assert.deepEqual(warnings, [FROZEN_WARNING, null]);

        // B nunca mais relata: 3 s depois o contador dele parece parado (avisa); passados 6 s sem relato ele e velho
        // demais para dizer que a fonte parou (o aviso sai)
        advance(clock, 7000);
        assert.deepEqual(warnings, [FROZEN_WARNING, null, FROZEN_WARNING, null]);
        monitor.stop();
    });

    test("com track.stats o contador dos senders e ignorado; stats que lancam valem como ausentes", t => {
        const clock = useFakeClock(t);
        canvas2d.pixels = GRAY;
        const frames = { totalFrames: 0 };
        const withStats = startMonitor("window", frames);
        for (let i = 0; i < 10; i++) {
            frames.totalFrames += 30;
            withStats.monitor.noteSourceFrames("A", 1); // parado, mas a faixa diz que chegam quadros
            advance(clock, 500);
        }
        assert.deepEqual(withStats.warnings, []);
        withStats.monitor.stop();

        const broken = startMonitor("window");
        Object.defineProperty(broken.track, "stats", {
            get() {
                throw new Error("stats indisponivel");
            }
        });
        for (let i = 0; i < 10; i++) {
            broken.monitor.noteSourceFrames("A", 1);
            advance(clock, 500);
        }
        assert.deepEqual(broken.warnings, [FROZEN_WARNING], "sem stats da faixa: vale o do sender");
        broken.monitor.stop();
    });
});

describe("movimento", () => {
    test("null antes de 2 amostras; imagem mudando sobe para perto de 1; parada cai", t => {
        const clock = useFakeClock(t);
        let bright = false;
        canvas2d.pixels = (w, h) => {
            bright = !bright;
            return fill(bright ? 200 : 20)(w, h);
        };
        const { monitor } = startMonitor("screen");
        assert.equal(monitor.motion(), null);
        advance(clock, 500);
        assert.equal(monitor.motion(), null, "uma amostra so");
        advance(clock, 500);
        assert.equal(monitor.motion(), 1);
        advance(clock, 10_000);
        assert.equal(monitor.motion(), 1);

        canvas2d.pixels = GRAY;
        advance(clock, 10_000);
        assert.ok(monitor.motion()! < 0.15, `movimento ${monitor.motion()}`);
        monitor.stop();
    });
});

describe("ciclo de vida", () => {
    test("sem contexto 2D: nao comeca (false), sem aviso", () => {
        canvas2d.available = false;
        const monitor = new CaptureMonitor({ track: videoTrack() as unknown as MediaStreamTrack, kind: "screen", onWarning: () => assert.fail() });
        assert.equal(monitor.start(), false);
        assert.equal(media.played.length, 0);
    });

    test("erro ao montar o <video>: loga, para e devolve false", async t => {
        t.mock.method(document, "createElement", (tag: string) => {
            if (tag === "video") throw new Error("NotSupportedError");
            return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
        });
        const monitor = new CaptureMonitor({ track: videoTrack() as unknown as MediaStreamTrack, kind: "window", onWarning: () => { } });
        const lines = await logsDuring(() => assert.equal(monitor.start(), false));
        assert.deepEqual(lines, ["Monitor da captura indisponível: Error: NotSupportedError"]);
    });

    test("<video> ainda sem quadro: nao desenha", t => {
        const clock = useFakeClock(t);
        const { monitor, video } = startMonitor("screen");
        media.setFrame(video, { width: 0, height: 0, readyState: 4 });
        advance(clock, 2000);
        media.setFrame(video, { width: 1920, height: 1080, readyState: 1 });
        advance(clock, 2000);
        assert.equal(canvas2d.drawImageCalls, 0);
        media.setFrame(video, { width: 1920, height: 1080 });
        advance(clock, 500);
        assert.equal(canvas2d.drawImageCalls, 1);
        monitor.stop();
    });

    test("o canvas falhando 3 vezes seguidas: para o monitor (loga uma vez)", async t => {
        const clock = useFakeClock(t);
        const { monitor } = startMonitor("screen");
        canvas2d.pixels = () => {
            throw new DOMException("The canvas has been tainted", "SecurityError");
        };
        const lines = await logsDuring(() => advance(clock, 5000));
        assert.deepEqual(lines, ["Monitor da captura parou: SecurityError: The canvas has been tainted"]);
        canvas2d.pixels = GRAY;
        const before = canvas2d.drawImageCalls;
        advance(clock, 5000);
        assert.equal(canvas2d.drawImageCalls, before, "parado: nao amostra mais");
        monitor.stop();
    });

    test("stop solta o <video> (pausa, sem srcObject) e o timer, sem parar a faixa", t => {
        const clock = useFakeClock(t);
        const { monitor, video, track } = startMonitor("screen");
        assert.ok(video.srcObject);
        monitor.stop();
        assert.equal(video.paused, true);
        assert.equal(video.srcObject, null);
        assert.equal(track.readyState, "live");
        advance(clock, 5000);
        assert.equal(canvas2d.drawImageCalls, 0);
        monitor.stop();
    });
});
