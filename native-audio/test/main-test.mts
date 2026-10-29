// Uso (depois do tone-test, que gera os .wav): com o tom B tocando FORA desta arvore, ex. no bash:
//   powershell -Command "(New-Object Media.SoundPlayer '<pasta>/toneB.wav').PlayLooping(); Start-Sleep 30" &
//   node_modules/.bin/tsx native-audio/test/main-test.mts <caminho\telinha-audio.exe> <pasta>
// End-to-end test of screenAudioMain.ts outside Electron. This node process plays the role of Discord main:
// it excludes ITS OWN process tree (process.pid), and its child A plays FA; tone B (FB) was started by the
// outer shell (outside this tree). Expect FA absent and FB present. PCM stays in memory.
import { spawn, spawnSync } from "child_process";
import { join } from "path";

import * as m from "../../src/plugins/telinha/core/audio/screenAudioMain.ts";

const EXE = process.argv[2];
const DIR = process.argv[3];
const FA = 617, FB = 1373, RATE = 48000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function goertzelAmp(x: Float32Array, freq: number) {
    const c = 2 * Math.cos(2 * Math.PI * freq / RATE);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
    return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length;
}

async function pull(id: number, ms: number) {
    const chunks: Uint8Array[] = []; let reads = 0, empty = 0, maxGap = 0, last = Date.now(), ended: any = null;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const r = await m.readScreenAudioMain(id, 200);
        reads++;
        const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now;
        if (r.pcm) {
            if (r.pcm.byteOffset !== 0 || r.pcm.byteLength !== r.pcm.buffer.byteLength || r.pcm.byteLength % 8) throw new Error("pcm not exact/aligned");
            chunks.push(r.pcm);
        } else empty++;
        if (r.ended) { ended = r; break; }
    }
    const bytes = chunks.reduce((a, c) => a + c.byteLength, 0);
    const all = new Uint8Array(bytes); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    const f = new Float32Array(all.buffer);
    const L = new Float32Array(f.length / 2); for (let i = 0; i < L.length; i++) L[i] = f[2 * i];
    const a = L.subarray(Math.min(L.length, RATE / 2));
    return { reads, empty, maxGapMs: maxGap, frames: L.length, seconds: (L.length / RATE).toFixed(2), ampA: goertzelAmp(a, FA).toFixed(4), ampB: goertzelAmp(a, FB).toFixed(4), ended };
}

m.setScreenAudioHelperPathForTests(EXE);
console.log("status:", await m.screenAudioStatusMain());

const A = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$p = New-Object System.Media.SoundPlayer '${join(DIR, "toneA.wav")}'; $p.PlayLooping(); Start-Sleep 40`], { windowsHide: true, stdio: "ignore" });
await sleep(2000);
try {
    const s = await m.startScreenAudioMain(process.pid);
    console.log("start:", s);
    if (!s.ok) process.exit(1);
    console.log(`exclude own tree (A=${A.pid} is my child) [expect A no, B yes]:`, await pull(s.id, 3000));
    m.stopScreenAudioMain(s.id);
    console.log("read after stop:", await m.readScreenAudioMain(s.id, 100));

    // restart supersedes: second start stops the first
    const s1 = await m.startScreenAudioMain(process.pid);
    const s2 = await m.startScreenAudioMain(process.pid);
    console.log("old id after restart:", s1.ok && await m.readScreenAudioMain(s1.id, 50), "| new ok:", s2.ok);

    // helper killed from outside mid-capture -> ended with reason
    if (s2.ok) {
        await pull(s2.id, 500);
        spawnSync("taskkill", ["/im", "telinha-audio.exe", "/f"], { windowsHide: true });
        const r = await pull(s2.id, 2000);
        console.log("after external kill:", r.ended);
    }

    // idle watchdog: start and do not read for 6.5 s
    const s3 = await m.startScreenAudioMain(process.pid);
    await sleep(6500);
    console.log("after 6.5 s without reads:", s3.ok && await m.readScreenAudioMain(s3.id, 50));

    // missing helper
    m.setScreenAudioHelperPathForTests(join(DIR, "nope.exe"));
    console.log("missing exe status:", await m.screenAudioStatusMain());
    console.log("missing exe start:", await m.startScreenAudioMain(process.pid));
    const left = spawnSync("tasklist", ["/fi", "IMAGENAME eq telinha-audio.exe", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    console.log("leftover helpers:", /telinha-audio/i.test(left) ? left : "none");
} finally {
    A.kill();
}
