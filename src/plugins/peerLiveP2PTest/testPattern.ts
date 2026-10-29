/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Stream sintetico: canvas 1280x720 a 60 fps (padrao em movimento + relogio grande com
// milissegundos para estimar a latencia a olho) + um tom baixinho de oscilador.
// A pagina tools/p2p-test/p2p-test.js desenha o mesmo padrao.

export const PATTERN_WIDTH = 1280;
export const PATTERN_HEIGHT = 720;
export const PATTERN_FPS = 60;
/** Teto do encoder de video no transmissor (o padrao do Chromium, ~2,5 Mbps, mascararia o link). */
export const TEST_MAX_BITRATE_KBPS = 8000;

export type TestPattern = {
    stream: MediaStream;
    stop(): void;
};

export function formatClock(d = new Date()) {
    const p = (n: number, l = 2) => String(n).padStart(l, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * Relogio de quadros. requestAnimationFrame para com a janela oculta e setInterval na thread
 * principal cai para ~1 Hz em segundo plano; timers de Worker nao sofrem esse corte, entao o
 * padrao continua a 60 fps com o Discord minimizado. Se o Worker falhar, volta para setInterval.
 */
function startTicker(fps: number, onTick: () => void): () => void {
    let fallback: ReturnType<typeof setInterval> | null = null;
    const useInterval = () => {
        if (!fallback) fallback = setInterval(onTick, 1000 / fps);
    };
    let worker: Worker | null = null;
    try {
        const src = `setInterval(() => postMessage(0), ${1000 / fps});`;
        const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        worker = new Worker(url);
        URL.revokeObjectURL(url);
        worker.onmessage = () => onTick();
        worker.onerror = () => {
            console.warn("[PeerLive P2P] Worker do relógio falhou; usando setInterval (limitado em segundo plano)");
            worker?.terminate();
            worker = null;
            useInterval();
        };
    } catch {
        useInterval();
    }
    return () => {
        worker?.terminate();
        if (fallback) clearInterval(fallback);
    };
}

export function createTestPattern(label: string): TestPattern {
    const canvas = document.createElement("canvas");
    canvas.width = PATTERN_WIDTH;
    canvas.height = PATTERN_HEIGHT;
    const ctx = canvas.getContext("2d")!;
    const W = PATTERN_WIDTH, H = PATTERN_HEIGHT;
    const t0 = performance.now();
    let frame = 0;

    const draw = () => {
        const t = (performance.now() - t0) / 1000;
        frame++;

        // fundo com barras coloridas rolando (detecta travadas e perda de quadros)
        const barW = W / 8;
        const offset = (t * 240) % barW;
        for (let i = -1; i < 9; i++) {
            ctx.fillStyle = `hsl(${(i * 45 + t * 30) % 360} 70% 32%)`;
            ctx.fillRect(i * barW + offset, 0, barW + 1, H);
        }

        // quadrado quicando
        const bx = (Math.sin(t * 1.7) * 0.5 + 0.5) * (W - 120);
        const by = (Math.abs(Math.sin(t * 2.3))) * (H - 120);
        ctx.fillStyle = "#fff";
        ctx.fillRect(bx, by, 120, 120);

        // ponteiro girando (1 volta por segundo)
        ctx.save();
        ctx.translate(W - 110, 110);
        ctx.rotate(t * Math.PI * 2);
        ctx.fillStyle = "#ffeb3b";
        ctx.fillRect(-4, -90, 8, 90);
        ctx.restore();

        // faixa do relogio
        ctx.fillStyle = "rgba(0,0,0,0.78)";
        ctx.fillRect(0, H / 2 - 110, W, 220);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 150px Consolas, 'Courier New', monospace";
        ctx.fillText(formatClock(), W / 2, H / 2);

        ctx.font = "bold 28px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(0, 0, W, 48);
        ctx.fillStyle = "#fff";
        ctx.fillText(`PeerLive P2P · padrão de teste · ${label}`, 16, 10);
        ctx.textAlign = "right";
        ctx.fillText(`quadro ${frame}`, W - 16, 10);
    };

    draw();
    const stopTicker = startTicker(PATTERN_FPS, draw);
    const stream = canvas.captureStream(PATTERN_FPS);
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) videoTrack.contentHint = "motion";

    let audioCtx: AudioContext | null = null;
    try {
        audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 220;
        const gain = audioCtx.createGain();
        gain.gain.value = 0.015;
        const dest = audioCtx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        osc.start();
        dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    } catch (e) {
        console.warn("[PeerLive P2P] sem trilha de áudio de teste:", e);
    }

    return {
        stream,
        stop() {
            stopTicker();
            stream.getTracks().forEach(track => track.stop());
            audioCtx?.close().catch(() => { });
        }
    };
}
