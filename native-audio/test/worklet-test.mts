// Uso: node_modules/.bin/tsx native-audio/test/worklet-test.mts   (simulacao, nao toca nada)
// Simulates the PCM player worklet: producer at 48 kHz * (1 + drift), 10 ms chunks, delivery batched by a
// janky "renderer" (random 0-30 ms delays + a 150-250 ms stall every ~7 s). Consumer pulls 128 frames per
// quantum at exactly 48 kHz. Checks underruns, fill convergence and output glitches (1 kHz sine continuity).
import { PCM_PLAYER_SOURCE } from "../../src/plugins/telinha/core/audio/worklet.ts";

function run(driftPpm: number, seconds: number, stalls: boolean, seed = 1) {
    let rnd = seed;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let Proc: any;
    const g: any = {
        sampleRate: 48000, currentFrame: 0,
        AudioWorkletProcessor: class { port: any = { onmessage: null, postMessage: (m: any) => g.stats.push(m) }; },
        registerProcessor: (_: string, c: any) => { Proc = c; }, stats: [] as any[]
    };
    new Function("sampleRate", "AudioWorkletProcessor", "registerProcessor", "currentFrameRef",
        PCM_PLAYER_SOURCE.replace(/currentFrame/g, "currentFrameRef.currentFrame"))(48000, g.AudioWorkletProcessor, g.registerProcessor, g);
    const p = new Proc({ processorOptions: { targetMs: 80, maxTargetMs: 200 } });

    const RATE = 48000, prodRate = RATE * (1 + driftPpm / 1e6);
    let prodPhase = 0, prodFrames = 0, pendingChunks: Float32Array[] = [], nextDeliver = 0, nextStall = 7;
    const out = new Float32Array(128), outR = new Float32Array(128);
    let prev = 0, glitches = 0, firstSound = -1;
    const fills: number[] = [];
    for (let q = 0; q * 128 < seconds * RATE; q++) {
        const t = q * 128 / RATE;
        // producer: whole 10 ms chunks generated up to time t
        while ((prodFrames + 480) / prodRate <= t) {
            const c = new Float32Array(960);
            for (let i = 0; i < 480; i++) { const v = 0.5 * Math.sin(prodPhase); prodPhase += 2 * Math.PI * 1000 / RATE; c[2 * i] = v; c[2 * i + 1] = v; }
            prodFrames += 480; pendingChunks.push(c);
        }
        // janky renderer: delivers everything pending at nextDeliver
        if (t >= nextDeliver) {
            for (const c of pendingChunks) p.port.onmessage({ data: c.buffer });
            pendingChunks = [];
            nextDeliver = t + rand() * 0.03;
            if (stalls && t >= nextStall) { nextDeliver = t + 0.15 + rand() * 0.1; nextStall = t + 7; }
        }
        g.currentFrame = q * 128;
        p.process([], [[out, outR]]);
        for (let i = 0; i < 128; i++) {
            if (firstSound < 0 && out[i] !== 0) firstSound = t;
            if (firstSound >= 0 && Math.abs(out[i] - prev) > 0.1) glitches++;
            prev = out[i];
        }
        if (q % 375 === 0) fills.push(p.count / 48);
    }
    const last = g.stats[g.stats.length - 1];
    return { driftPpm, stalls, firstSoundMs: Math.round(firstSound * 1000), glitches, underruns: p.underruns, droppedMs: Math.round(p.dropped / 48), finalTargetMs: Math.round(p.target / 48), fillLast10s: fills.slice(-10).map(f => Math.round(f)).join(","), ratio: last?.ratio?.toFixed(5) };
}

for (const [d, s] of [[0, false], [300, false], [-300, false], [1000, false], [300, true], [-300, true]] as const)
    console.log(JSON.stringify(run(d, 120, s)));
