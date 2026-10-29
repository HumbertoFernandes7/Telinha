// Uso: node native-audio/test/tone-test.mjs <caminho\peerlive-audio.exe> <pasta para os .wav de teste>
// Toca dois tons baixos (617 Hz e 1373 Hz, -34 dBFS) por ~15 s e confere include/exclude/arvore/--parent.
// Standalone test of peerlive-audio.exe: two quiet tone players (A direct, B as child of cmd.exe),
// capture with include/exclude and measure each tone with Goertzel. PCM stays in memory (not saved).
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";

const EXE = process.argv[2];
const DIR = process.argv[3];
const FA = 617, FB = 1373, AMP = 0.02, RATE = 48000;

function wav(path, freq, seconds) {
    const n = RATE * seconds, data = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        const v = Math.round(Math.sin(2 * Math.PI * freq * i / RATE) * AMP * 32767);
        data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2);
    }
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(RATE, 24);
    h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
    writeFileSync(path, Buffer.concat([h, data]));
}

function goertzelAmp(x, freq) {
    const w = 2 * Math.PI * freq / RATE, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
    const power = s1 * s1 + s2 * s2 - c * s1 * s2;
    return 2 * Math.sqrt(Math.max(0, power)) / x.length;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function capture(args, ms) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const child = spawn(EXE, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const chunks = []; let err = ""; let readyAt = null; let firstDataAt = null;
        child.stdout.on("data", b => { if (firstDataAt == null) firstDataAt = Date.now() - t0; chunks.push(b); });
        child.stderr.on("data", b => { err += b; if (readyAt == null && /ready/.test(err)) readyAt = Date.now() - t0; });
        let endAt = null;
        setTimeout(() => { endAt = Date.now(); child.stdin.end(); }, ms);
        child.on("exit", code => {
            const pcm = Buffer.concat(chunks);
            const usable = pcm.length - (pcm.length % 8);
            const f = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + usable));
            const L = new Float32Array(f.length / 2);
            for (let i = 0; i < L.length; i++) L[i] = f[2 * i];
            // skip first 300 ms (start-up), analyse the rest
            const a = L.subarray(Math.min(L.length, RATE * 0.3));
            let sum = 0; for (const v of a) sum += v * v;
            resolve({
                code, err: err.trim(), readyAt, firstDataAt, exitAfterStdinEndMs: endAt ? Date.now() - endAt : null,
                frames: L.length, expectedFrames: Math.round(RATE * (endAt - t0 - (readyAt ?? 0)) / 1000),
                rms: Math.sqrt(sum / Math.max(1, a.length)), ampA: goertzelAmp(a, FA), ampB: goertzelAmp(a, FB)
            });
        });
    });
}

const fmt = r => `exit=${r.code} ready@${r.readyAt}ms data@${r.firstDataAt}ms stop->exit ${r.exitAfterStdinEndMs}ms frames=${r.frames} (~expected ${r.expectedFrames}) rms=${r.rms.toFixed(4)} amp${FA}=${r.ampA.toFixed(4)} amp${FB}=${r.ampB.toFixed(4)} | ${r.err.replace(/\r?\n/g, " / ")}`;

const wa = join(DIR, "toneA.wav"), wb = join(DIR, "toneB.wav");
wav(wa, FA, 4); wav(wb, FB, 4);
const ps = f => ["-NoProfile", "-NonInteractive", "-Command", `$p = New-Object System.Media.SoundPlayer '${f}'; $p.PlayLooping(); Start-Sleep 25`];

// S0: idle: include our own node process tree (plays nothing) -> continuous silence via gap filling
console.log("S0 include idle node (silence fill):", fmt(await capture(["--include", String(process.pid)], 2500)));

const A = spawn("powershell.exe", ps(wa), { windowsHide: true, stdio: "ignore" });
const Bcmd = spawn("cmd.exe", ["/d", "/c", "powershell.exe", ...ps(wb)], { windowsHide: true, stdio: "ignore" });
console.log(`players: A powershell pid=${A.pid}, B = cmd pid=${Bcmd.pid} -> powershell child`);
await sleep(2500);

try {
    console.log("S1 exclude cmd(B) tree  [expect A yes, B no]:", fmt(await capture(["--exclude", String(Bcmd.pid)], 3000)));
    console.log("S2 exclude A            [expect A no,  B yes]:", fmt(await capture(["--exclude", String(A.pid)], 3000)));
    console.log("S3 include A            [expect A yes, B no ]:", fmt(await capture(["--include", String(A.pid)], 3000)));
    console.log("S4 include cmd(B) tree  [expect A no,  B yes]:", fmt(await capture(["--include", String(Bcmd.pid)], 3000)));
    // S5: --parent: parent dies -> helper exits on its own (stdin still open)
    const fake = spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 2"], { windowsHide: true, stdio: "ignore" });
    const t0 = Date.now();
    const h = spawn(EXE, ["--exclude", String(A.pid), "--parent", String(fake.pid)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let e5 = ""; h.stderr.on("data", b => e5 += b); h.stdout.resume();
    const code5 = await new Promise(r => h.on("exit", r));
    console.log(`S5 --parent exits when parent dies: exit=${code5} after ${Date.now() - t0}ms | ${e5.trim().replace(/\r?\n/g, " / ")}`);
} finally {
    A.kill(); spawn("taskkill", ["/pid", String(Bcmd.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
}
