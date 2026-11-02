/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * The REAL telinha-audio.exe of the built payload, in its one-shot modes (whole-screen audio is run-main-test.mjs S1's
 * --probe): --version, and --gpu-priority, which sets the GPU scheduling priority class of processes in the caller's own
 * process tree (the plugin calls it for Discord's main and GPU processes while streaming, core/captureBoostMain.ts, with
 * --raise so that a class already at HIGH or above is never lowered, and back with --if-class high).
 *
 *   node addon/test/run-helper-test.mjs [--payload <dir>]       (also run by `pnpm test:addon`, after build:addon)
 *
 * The targets are this node process (the helper's parent, like Discord main) and a child of it, at HIGH and back to
 * NORMAL; never REALTIME, never a process outside this tree. Whether Windows accepts the change depends on the machine
 * (a runner may have no GPU): either answer must follow the protocol, and when HIGH is accepted, the class must still be
 * there after the helper exited (the restore reads it as "before"). Skipped off Windows, or without a built helper
 * outside CI. Nothing here touches Discord or %APPDATA%.
 */
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

import { argValue, makeChecker, REPO } from "./common.mjs";

const { check, finish } = makeChecker();
const exe = join(argValue("--payload") ?? join(REPO, "dist", "addon", "payload"), "telinha-audio.exe");

if (process.platform !== "win32" || !existsSync(exe)) {
    const why = process.platform !== "win32" ? "not Windows" : `no ${exe} (pnpm build:helper, then pnpm build:addon)`;
    if (process.env.CI && process.platform === "win32") {
        check(`the built helper is there (${why})`, false);
        finish();
    }
    console.log(`SKIPPED: ${why}`);
    process.exit(0);
}
console.log(`Helper under test: ${exe}\n`);

const run = (...args) => {
    const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    return { code: r.status, out: (r.stdout ?? "").trim().split(/\r?\n/).filter(Boolean), err: (r.stderr ?? "").trim(), error: r.error?.message };
};

const HAGS_RE = /^hags (on|off|unknown)$/;
const okLine = pid => new RegExp(`^ok pid=${pid} before=([A-Z_]+|CLASS-?\\d+) after=([A-Z_]+|CLASS-?\\d+)$`);
const errorLine = (pid, stages) => new RegExp(`^error (${stages}) 0x[0-9A-F]{8} pid=${pid} .+$`);

/**
 * One --gpu-priority call on one pid: exit 0 with "ok ... after=<cls>", or exit 6 with an error line from OpenProcess or
 * the D3DKMT calls. Returns the parsed answer.
 */
function setClass(label, pid, cls) {
    const r = run("--gpu-priority", String(pid), "--class", cls);
    const ok = r.out[1] && okLine(pid).exec(r.out[1]);
    const fine = r.out.length === 2 && HAGS_RE.test(r.out[0]) && r.err === ""
        && (r.code === 0 ? !!ok && ok[2] === cls.toUpperCase() : r.code === 6 && errorLine(pid, "open|get|set").test(r.out[1]));
    console.log(`        (${label}: exit ${r.code}, ${JSON.stringify(r.out)})`);
    check(`${label}: protocol (hags line + one ok/error line, exit 0/6)`, fine, r);
    return { ...r, before: ok?.[1] ?? null, after: ok?.[2] ?? null };
}

// ---------------------------------------------------------------------------------------------- H1 version
console.log("H1 version");
{
    const r = run("--version");
    check("--version says telinha-audio 3 (--gpu-priority with --raise / --if-class)", r.code === 0 && r.out[0] === "telinha-audio 3", r);
}

// ---------------------------------------------------------------------------------------------- H2 this process
console.log("H2 --gpu-priority on the caller (what the plugin does with Discord main)");
/** Windows accepted HIGH on this process (a runner may refuse: H5 then only checks the protocol) */
let accepted = false;
{
    const up = setClass("HIGH on this node process", process.pid, "high");
    accepted = up.code === 0;
    if (up.code === 0) {
        const down = setClass("back to NORMAL", process.pid, "normal");
        check("the class stayed HIGH after the helper exited (read back as 'before' by the next call)", down.before === "HIGH" && down.after === "NORMAL", down);
    } else {
        console.log("        (this machine refused the change: only the protocol is checked)");
    }
}

// ---------------------------------------------------------------------------------------------- H3 a child
console.log("H3 --gpu-priority on a child of the caller (what the plugin does with Discord's GPU process)");
{
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });
    try {
        const up = setClass("HIGH on a child process", child.pid, "high");
        if (up.code === 0) setClass("the child back to NORMAL", child.pid, "normal");
    } finally {
        child.kill();
    }
}

// ---------------------------------------------------------------------------------------------- H4 refusals
console.log("H4 refusals: outside the caller's tree, REALTIME, bad arguments");
{
    const outside = process.ppid;
    const r = run("--gpu-priority", String(outside), "--class", "high");
    check("a process outside the caller's tree (this node's parent) is refused before it is opened", r.code === 6 && r.out.length === 2 && HAGS_RE.test(r.out[0])
        && r.out[1].startsWith(`error tree 0x80070005 pid=${outside} `), r);

    // a child that already exited: "gone" (or "tree", if Windows already gave its pid to some other process)
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    await new Promise(resolve => dead.once("exit", resolve));
    const g = run("--gpu-priority", String(dead.pid), "--class", "normal");
    console.log(`        (an exited child: exit ${g.code}, ${JSON.stringify(g.out)})`);
    check("a process that already exited is reported as gone (nothing to restore in it)", g.code === 6 && g.out.length === 2
        && (g.out[1].startsWith(`error gone 0x80070057 pid=${dead.pid} `) || g.out[1].startsWith(`error tree 0x80070005 pid=${dead.pid} `)), g);

    const rt = run("--gpu-priority", String(process.pid), "--class", "realtime");
    check("--class realtime is refused (exit 2, nothing changed)", rt.code === 2 && rt.out.length === 0 && /realtime nao e permitido/.test(rt.err), rt);
    const rtUpper = run("--gpu-priority", String(process.pid), "--class", "REALTIME");
    check("... in any case", rtUpper.code === 2 && rtUpper.out.length === 0, rtUpper);

    const bad = [
        ["--gpu-priority", String(process.pid)],
        ["--class", "high"],
        ["--gpu-priority", "abc", "--class", "high"],
        ["--gpu-priority", "0", "--class", "high"],
        ["--gpu-priority", "1,", "--class", "high"],
        ["--gpu-priority", "1,2,3,4,5,6,7,8,9", "--class", "high"],
        ["--gpu-priority", String(process.pid), "--class", "turbo"],
        ["--gpu-priority", String(process.pid), "--class", "high", "--probe"],
        ["--gpu-priority", String(process.pid), "--class", "high", "--parent", String(process.pid)],
        ["--gpu-priority", String(process.pid), "--class", "high", "--class", "normal"],
        ["--gpu-priority", String(process.pid), "--class", "high", "--raise", "--if-class", "high"],
        ["--gpu-priority", String(process.pid), "--class", "high", "--raise", "--raise"],
        ["--gpu-priority", String(process.pid), "--class", "normal", "--if-class", "realtime"],
        ["--gpu-priority", String(process.pid), "--class", "normal", "--if-class"],
        ["--probe", "--raise"],
        ["--sessions", "--if-class", "high"]
    ];
    for (const args of bad) {
        const b = run(...args);
        check(`usage error: ${args.join(" ")}`, b.code === 2 && b.out.length === 0 && /^error usage 0x80070057 /.test(b.err), b);
    }
}

// ---------------------------------------------------------------------------------------------- H5 raise / if-class
console.log("H5 --raise never lowers; --if-class only changes a process still in that class (what the plugin does)");
{
    const keepLine = pid => new RegExp(`^keep pid=${pid} class=([A-Z_]+|CLASS-?\\d+)$`);
    /** One conditional call on this process: exit 0 with "ok ..." or "keep ...", or exit 6 with an error line. */
    const call = (label, cls, ...extra) => {
        const r = run("--gpu-priority", String(process.pid), "--class", cls, ...extra);
        const ok = r.out[1] && okLine(process.pid).exec(r.out[1]);
        const keep = r.out[1] && keepLine(process.pid).exec(r.out[1]);
        const fine = r.out.length === 2 && HAGS_RE.test(r.out[0]) && r.err === ""
            && (r.code === 0 ? !!(ok || keep) : r.code === 6 && errorLine(process.pid, "open|get|set").test(r.out[1]));
        console.log(`        (${label}: exit ${r.code}, ${JSON.stringify(r.out)})`);
        check(`${label}: protocol (hags line + one ok/keep/error line, exit 0/6)`, fine, r);
        return { ...r, before: ok?.[1] ?? null, after: ok?.[2] ?? null, kept: keep?.[1] ?? null };
    };
    const start = accepted ? setClass("this process at NORMAL to start", process.pid, "normal") : null;
    if (start?.code === 0) {
        const up = call("--raise from NORMAL", "high", "--raise");
        check("--raise from NORMAL sets HIGH", up.before === "NORMAL" && up.after === "HIGH", up);
        const again = call("--raise again", "high", "--raise");
        check("--raise on a process already at HIGH leaves it (keep class=HIGH)", again.kept === "HIGH", again);
        const lower = call("--raise to a lower class", "above_normal", "--raise");
        check("--raise never lowers (above_normal over HIGH: keep class=HIGH)", lower.kept === "HIGH", lower);
        const other = call("--if-class of another class", "normal", "--if-class", "above_normal");
        check("--if-class leaves a process that is in another class (keep class=HIGH)", other.kept === "HIGH", other);
        const back = call("--if-class high back to NORMAL", "normal", "--if-class", "high");
        check("--if-class high puts a process still at HIGH back to NORMAL", back.before === "HIGH" && back.after === "NORMAL", back);
    } else {
        call("--raise on a machine that refused HIGH", "high", "--raise");
        console.log("        (this machine refused the change: only the protocol is checked)");
    }
}

finish();
