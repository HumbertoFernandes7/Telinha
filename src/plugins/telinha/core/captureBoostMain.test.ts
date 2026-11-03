/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado main da live com jogo pesado (core/captureBoostMain.ts, pelos natives de native.ts).
// "Captura pela placa de vídeo": o estado vem do que o loader do add-on publicou nesta partida
// (globalThis.__TelinhaAddon.capture) e do capture-flags.json, que a opcao grava para a proxima partida; o arquivo fica
// numa pasta temporaria. "Prioridade da captura na placa de vídeo": o telinha-audio.exe --gpu-priority de mentira
// (mockSpawn) responde como o de verdade; o processo da GPU vem do app.getAppMetrics() do electron falso.
// O Windows (os.release / process.platform) e o exe sao trocados por teste (helperHost). Nunca roda o helper de verdade
// (addon/test/run-helper-test.mjs faz isso) nem toca o %APPDATA% de verdade.
// Rodar:  pnpm test:file src/plugins/telinha/core/captureBoostMain.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, type TestContext } from "node:test";

import { gpuCaptureStatus, gpuRealtimeStatus, setGpuCapture, setGpuPriority, setGpuRealtimeBlocked } from "@plugins/telinha/native";
import { mockSpawn } from "@test/fakes/childProcess";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { app, ipcEvent } from "@test/fakes/electron";
import { answer, feed, helperHost } from "@test/helpers/wpd-audio";

import {
    GPU_CAPTURE_MIN_BUILD, gpuCaptureStatusMain, type GpuPriorityReport, resetGpuPriorityForTests, setGpuCaptureMain, setGpuPriorityMain
} from "./captureBoostMain";

const g = globalThis as { __TelinhaAddon?: unknown; };
let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tl-capture-"));
    file = join(dir, "capture-flags.json");
});

afterEach(() => {
    delete g.__TelinhaAddon;
    rmSync(dir, { recursive: true, force: true });
});

/** O que o loader publicou nesta partida (addon/loader/main.js → applyCaptureFlags). */
function loader(capture: Record<string, unknown> = {}) {
    g.__TelinhaAddon = { capture: { file, build: 26300, wgcTexture: false, applied: null, enableFeatures: null, reason: null, ...capture } };
}

const saved = () => JSON.parse(readFileSync(file, "utf8"));

describe("o estado da opcao", () => {
    test("Windows 11 24H2+, ligada e aplicada nesta partida: tudo vem do loader e do arquivo", t => {
        helperHost(t, { build: 26300 });
        loader({ wgcTexture: true, applied: true, enableFeatures: "X,WebRtcAllowWgcUsingTexture" });
        writeFileSync(file, JSON.stringify({ format: 1, wgcTexture: true }));
        assert.deepEqual(gpuCaptureStatus(ipcEvent()), {
            loader: true, build: 26300, supported: true, saved: true, requested: true, applied: true, loaderNote: null,
            enableFeatures: "X,WebRtcAllowWgcUsingTexture", saveError: null
        });
    });

    test("Windows mais antigo que o 24H2 (no limite e abaixo), versao sem build e outro sistema", t => {
        const host = helperHost(t, { build: GPU_CAPTURE_MIN_BUILD - 1 });
        loader({ wgcTexture: true, applied: false, reason: "Windows build 26099: needs 24H2" });
        const st = gpuCaptureStatusMain();
        assert.deepEqual([st.build, st.supported, st.applied, st.loaderNote], [26099, false, false, "Windows build 26099: needs 24H2"]);

        host.setBuild(GPU_CAPTURE_MIN_BUILD);
        assert.equal(gpuCaptureStatusMain().supported, true);

        host.setBuild("10.0");
        assert.equal(gpuCaptureStatusMain().build, 0);

        host.setBuild(26300);
        host.setPlatform("linux");
        assert.deepEqual([gpuCaptureStatusMain().build, gpuCaptureStatusMain().supported], [0, false]);
    });

    test("sem o loader do add-on (build do fork, loader antigo, caminho estranho): nada salvo, nada pedido", t => {
        helperHost(t, { build: 26300 });
        for (const addon of [undefined, {}, { capture: null }, { capture: { file: 42 } }, { capture: { file: "relativo.json" } }]) {
            g.__TelinhaAddon = addon;
            const st = gpuCaptureStatusMain();
            assert.deepEqual([st.loader, st.saved, st.requested, st.applied], [false, false, false, null], JSON.stringify(addon));
        }
    });

    test("arquivo ausente, quebrado ou sem true: nao salva; campos estranhos do loader ficam de fora", t => {
        helperHost(t, { build: 26300 });
        loader({ wgcTexture: "sim", applied: "talvez", reason: "", enableFeatures: 7 });
        assert.equal(gpuCaptureStatusMain().saved, false);
        writeFileSync(file, "{ quebrado");
        assert.equal(gpuCaptureStatusMain().saved, false);
        writeFileSync(file, JSON.stringify({ wgcTexture: 1 }));
        const st = gpuCaptureStatusMain();
        assert.deepEqual([st.saved, st.requested, st.applied, st.loaderNote, st.enableFeatures], [false, false, null, null, null]);
    });
});

describe("gravar a opcao para a proxima partida", () => {
    test("liga e desliga: o arquivo inteiro de uma vez, sem sobra de temporario", t => {
        helperHost(t, { build: 26300 });
        loader();
        assert.equal(setGpuCapture(ipcEvent(), true).saved, true);
        assert.deepEqual(saved(), { format: 1, wgcTexture: true, av1HwEncode: false });
        assert.equal(setGpuCaptureMain(false).saved, false);
        assert.deepEqual(saved(), { format: 1, wgcTexture: false, av1HwEncode: false });
        assert.deepEqual(readdirSync(dir), ["capture-flags.json"]);
    });

    test("so true liga (o IPC pode trazer qualquer coisa)", t => {
        helperHost(t, { build: 26300 });
        loader();
        assert.equal(setGpuCapture(ipcEvent(), "true" as never).saved, false);
    });

    test("sem o loader: nao grava nada", t => {
        helperHost(t, { build: 26300 });
        const st = setGpuCaptureMain(true);
        assert.deepEqual([st.loader, st.saved, st.saveError], [false, false, null]);
        assert.equal(existsSync(file), false);
    });

    test("nao deu para gravar (no lugar do arquivo ha uma pasta): o erro volta em pt-BR e o temporario some", t => {
        helperHost(t, { build: 26300 });
        loader();
        mkdirSync(file);
        const st = setGpuCaptureMain(true);
        assert.match(st.saveError ?? "", /^não consegui salvar a opção \(/);
        assert.deepEqual(readdirSync(dir), ["capture-flags.json"]);
    });

    test("um erro que nao e Error vira texto; e apagar o temporario tambem pode falhar", t => {
        helperHost(t, { build: 26300 });
        loader();
        t.mock.method(fs, "writeFileSync", () => {
            throw "disco cheio";
        });
        t.mock.method(fs, "rmSync", () => {
            throw new Error("EBUSY");
        });
        const st = setGpuCaptureMain(true);
        t.mock.restoreAll(); // antes do afterEach, que apaga a pasta com o rmSync de verdade
        assert.equal(st.saveError, "não consegui salvar a opção (disco cheio)");
    });
});

describe("prioridade na placa de video (telinha-audio.exe --gpu-priority)", () => {
    const GPU = 51_234;
    const ME = process.pid;

    beforeEach(() => {
        resetGpuPriorityForTests();
        loader(); // o tempo real so existe com o loader (a pasta do gpu-priority.json); os testes sem ele o tiram
        app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: GPU, type: "GPU" }, { pid: 51_302, type: "Tab" }];
        app.getAppMetricsImpl = null;
        app.listeners = {};
        app.onImpl = null;
    });

    const CLASSES = ["IDLE", "BELOW_NORMAL", "NORMAL", "ABOVE_NORMAL", "HIGH", "REALTIME"];

    /**
     * O helper responde como o de verdade, lembrando a classe de cada pid entre as chamadas (`classes`): `before(pid)` = a
     * classe de cada um antes da primeira; `refuse` = os pids recusados. --raise so sobe quem esta abaixo; --if-class so
     * muda quem esta naquela classe; o resto ganha uma linha "keep". `realtime` = o que o Windows faz com o REALTIME:
     * "accept" (o de verdade), "refuse" (0xC0000061 em todos), "clamp" (aceita a chamada e mantem a classe) e "old" (um helper
     * antigo, que nao conhece --allow-realtime).
     */
    function helperAnswers(t: TestContext, { before = (_pid: string): string => "NORMAL", refuse = [] as string[], hags = "on", realtime = "accept" as "accept" | "refuse" | "clamp" | "old" } = {}) {
        helperHost(t);
        const classes = new Map<string, string>();
        const procs = mockSpawn(t, p => {
            const pids = p.args[1].split(",");
            const cls = p.args[3].toUpperCase();
            const [condition, ifClass] = p.args.slice(4);
            const line = (pid: string) => {
                if (refuse.includes(pid)) return `error open 0x80070005 pid=${pid} Acesso negado.`;
                const now = classes.get(pid) ?? before(pid);
                const lower = CLASSES.indexOf(now) < CLASSES.indexOf(cls);
                if (cls === "REALTIME" && realtime === "refuse" && lower) return `error set 0xC0000061 pid=${pid} privilegio ausente`;
                if (cls === "REALTIME" && realtime === "clamp" && lower) return `ok pid=${pid} before=${now} after=${now}`;
                const keep = condition === "--raise" ? CLASSES.indexOf(now) >= CLASSES.indexOf(cls) : condition === "--if-class" && now !== ifClass.toUpperCase();
                if (keep) return `keep pid=${pid} class=${now}`;
                classes.set(pid, cls);
                return `ok pid=${pid} before=${now} after=${cls}`;
            };
            if (cls === "REALTIME" && realtime === "old") return answer(p, { stderr: "error usage 0x80070057 uso: telinha-audio.exe ...\n", code: 2 });
            const lines = [`hags ${hags}`, ...pids.map(line)];
            answer(p, { stdout: lines.join("\r\n") + "\r\n", code: lines.some(l => l.startsWith("error ")) ? 6 : 0 });
        });
        return Object.assign(procs, { classes });
    }

    const target = (pid: number, role: "Discord" | "GPU", before: string | null, after: string | null, error: string | null = null, kept = false) => ({ pid, role, before, after, kept, error });
    /** o processo da GPU que o Discord ja deixou em REALTIME: o Telinha nao mexe */
    const keptRealtime = (pid = GPU) => target(pid, "GPU", "REALTIME", "REALTIME", null, true);

    test("HIGH no Discord e no processo da GPU; ao parar, cada um volta ao que era; sem nada a voltar, nem abre o helper", async t => {
        const procs = helperAnswers(t);
        const up = await setGpuPriority(ipcEvent(), "high");
        assert.deepEqual(procs.spawned[0].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "high", "--raise"], "so sobe: nunca abaixa");
        assert.deepEqual(procs.spawned[0].options, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        const expected: GpuPriorityReport = {
            mode: "high", ok: true, done: 2, hags: "on", reason: null, refused: false, raised: 2, quiet: false, notes: [], level: "HIGH", realtimeRefused: false, realtimeBlocked: null,
            targets: [target(ME, "Discord", "NORMAL", "HIGH"), target(GPU, "GPU", "NORMAL", "HIGH")]
        };
        assert.deepEqual(up, expected);

        const down = await setGpuPriority(ipcEvent(), "restore");
        assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "normal", "--if-class", "high"], "so volta quem ainda esta em HIGH");
        assert.deepEqual([down.mode, down.ok, down.done, down.raised], ["restore", true, 2, 0]);
        assert.deepEqual(down.targets, [target(ME, "Discord", "HIGH", "NORMAL"), target(GPU, "GPU", "HIGH", "NORMAL")]);
        assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "NORMAL", [GPU]: "NORMAL" });

        const again = await setGpuPriorityMain("restore");
        assert.equal(procs.spawned.length, 2);
        assert.deepEqual([again.ok, again.done, again.targets, again.hags], [true, 0, [], null]);
    });

    test("o Windows recusa (talvez sem administrador): diz que recusou, nada fica lembrado para voltar", async t => {
        const procs = helperAnswers(t, { refuse: [String(ME), String(GPU)] });
        const up = await setGpuPriorityMain("high");
        assert.deepEqual([up.ok, up.done, up.refused, up.raised, up.reason], [false, 0, true, 0, null]);
        assert.equal(up.targets[0].error, "open 0x80070005 Acesso negado.");
        await setGpuPriorityMain("restore");
        assert.equal(procs.spawned.length, 1);
    });

    test("so o processo da GPU recusado: o principal sobe e so ele volta", async t => {
        const procs = helperAnswers(t, { refuse: [String(GPU)] });
        const up = await setGpuPriorityMain("high");
        assert.deepEqual([up.ok, up.done, up.refused, up.raised], [false, 1, true, 1]);
        await setGpuPriorityMain("restore");
        assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME}`, "--class", "normal", "--if-class", "high"]);
    });

    test("quem ja estava em HIGH fica como estava; a classe de antes e a que volta", async t => {
        const procs = helperAnswers(t, { before: pid => (pid === String(ME) ? "ABOVE_NORMAL" : "HIGH") });
        const up = await setGpuPriorityMain("high");
        assert.deepEqual([up.ok, up.done, up.raised], [true, 2, 1]);
        assert.deepEqual(up.targets[1], target(GPU, "GPU", "HIGH", "HIGH", null, true));
        await setGpuPriorityMain("restore");
        assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME}`, "--class", "above_normal", "--if-class", "high"]);
    });

    test("o processo da GPU ja em REALTIME (o Discord poe): fica como esta, nunca e baixado nem voltado, e a volta o cita", async t => {
        // o log do dono em 02/11/2026: "GPU do Discord 17188 REALTIME→HIGH", e a volta nem citava o processo da GPU
        const procs = helperAnswers(t, { before: pid => (pid === String(GPU) ? "REALTIME" : "NORMAL") });
        const up = await setGpuPriorityMain("high");
        assert.deepEqual([up.ok, up.done, up.raised, up.refused], [true, 2, 1, false]);
        assert.deepEqual(up.targets, [target(ME, "Discord", "NORMAL", "HIGH"), keptRealtime()]);

        const down = await setGpuPriorityMain("restore");
        assert.deepEqual(procs.spawned.map(p => p.args[1]), [`${ME},${GPU}`, `${ME}`], "a volta so passa o que subiu");
        assert.deepEqual([down.ok, down.done, down.raised, down.quiet], [true, 2, 0, false]);
        assert.deepEqual(down.targets, [target(ME, "Discord", "HIGH", "NORMAL"), keptRealtime()], "o processo da GPU entra no relatorio, sem ter sido mexido");
        assert.equal(procs.classes.has(String(GPU)), false, "a classe do processo da GPU nunca foi trocada");

        const again = await setGpuPriorityMain("restore");
        assert.deepEqual([again.targets, procs.spawned.length], [[], 2], "citado uma vez so");
    });

    test("tudo ja em HIGH ou acima: nada sobe, nada volta e a volta e silenciosa", async t => {
        const procs = helperAnswers(t, { before: pid => (pid === String(GPU) ? "REALTIME" : "HIGH") });
        const up = await setGpuPriorityMain("high");
        assert.deepEqual([up.ok, up.done, up.raised], [true, 2, 0]);
        const down = await setGpuPriorityMain("restore");
        assert.equal(procs.spawned.length, 1, "nada a voltar: o helper nem abre");
        assert.deepEqual([down.ok, down.done, down.quiet, down.targets.map(t => t.kept)], [true, 2, true, [true, true]]);
    });

    test("a volta so mexe no que o Telinha mudou: o que outro pos em outra classe no meio da transmissao fica", async t => {
        const procs = helperAnswers(t);
        await setGpuPriorityMain("high");
        procs.classes.set(String(GPU), "REALTIME"); // o Discord pos o processo da GPU em REALTIME depois da subida
        const down = await setGpuPriorityMain("restore");
        assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "normal", "--if-class", "high"]);
        assert.deepEqual([down.ok, down.done, down.raised, down.quiet], [true, 2, 0, false]);
        assert.deepEqual(down.targets, [target(ME, "Discord", "HIGH", "NORMAL"), keptRealtime()]);
        assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "NORMAL", [GPU]: "REALTIME" }, "REALTIME nao foi baixado");
        assert.equal((await setGpuPriorityMain("restore")).targets.length, 0, "e saiu da lista");
    });

    test("dois processos com classes diferentes antes: um helper por classe na volta", async t => {
        const procs = helperAnswers(t, { before: pid => (pid === String(ME) ? "BELOW_NORMAL" : "IDLE") });
        await setGpuPriorityMain("high");
        const down = await setGpuPriorityMain("restore");
        assert.deepEqual(procs.spawned.slice(1).map(p => p.args[3]).sort(), ["below_normal", "idle"]);
        assert.deepEqual([down.ok, down.done, down.targets.length, down.hags], [true, 2, 2, "on"]);
    });

    test("subir duas vezes nao esquece a classe de antes (na 2a o helper so diz que ja esta em HIGH)", async t => {
        const procs = helperAnswers(t);
        await setGpuPriorityMain("high");
        const second = await setGpuPriorityMain("high");
        assert.deepEqual([second.ok, second.raised, second.targets.map(t => t.kept)], [true, 2, [true, true]]);
        const down = await setGpuPriorityMain("restore");
        assert.equal(procs.spawned[2].args[3], "normal");
        assert.deepEqual(down.targets, [target(ME, "Discord", "HIGH", "NORMAL"), target(GPU, "GPU", "HIGH", "NORMAL")], "o que o Telinha subiu volta, nao vira 'ja estava'");
    });

    test("os pedidos vao um de cada vez, na ordem", async t => {
        const procs = helperAnswers(t);
        const up = setGpuPriorityMain("high");
        const down = setGpuPriorityMain("restore");
        await flushPromises();
        assert.equal(procs.spawned.length, 1, "o restore espera o high terminar");
        assert.deepEqual([(await up).ok, (await down).done], [true, 2]);
        assert.deepEqual(procs.spawned.map(p => p.args[3]), ["high", "normal"]);
    });

    test("quem e o processo da GPU: so type GPU com pid valido; getAppMetrics que lanca = so o principal", async t => {
        const procs = helperAnswers(t);
        // o "Video Capture" so atende cameras no Chromium 152: a captura da tela roda no principal (captureBoostMain.ts)
        const videoCapture = { pid: 777, type: "Utility", serviceName: "video_capture.mojom.VideoCaptureService", name: "Video Capture" };
        app.appMetrics = [null, { pid: ME, type: "GPU" }, { pid: 0, type: "GPU" }, { pid: 1.5, type: "GPU" }, videoCapture];
        await setGpuPriorityMain("high");
        assert.equal(procs.spawned[0].args[1], `${ME}`, "nem o utilitario de captura de video");
        resetGpuPriorityForTests();
        app.getAppMetricsImpl = () => {
            throw new Error("not ready");
        };
        await setGpuPriorityMain("high");
        assert.equal(procs.spawned[1].args[1], `${ME}`);
    });

    test("respostas estranhas do helper: linhas de outros pids, erro sem texto, HAGS desligado ou desconhecido, pid sem resposta", async t => {
        helperHost(t);
        const replies = [
            { stdout: `hags off\nok pid=999 before=NORMAL after=HIGH\nkeep pid=999 class=HIGH\nerror set 0xC0000061 pid=999 x\nerror tree 0x80070005 pid=${GPU}\nok pid=${ME} before=NORMAL after=HIGH\n`, code: 6 },
            { stdout: `hags unknown\nok pid=${ME} before=NORMAL after=HIGH\n`, code: 0 },
            { stdout: `ok pid=${ME} before=NORMAL after=ABOVE_NORMAL\nok pid=${GPU} before=NORMAL after=HIGH\nalgo que o helper nao diz\n`, code: 0 }
        ];
        mockSpawn(t, p => answer(p, replies.shift()));

        const tree = await setGpuPriorityMain("high");
        assert.deepEqual([tree.hags, tree.ok, tree.done, tree.refused], ["off", false, 1, false], "fora da arvore nao e recusa do Windows");
        assert.equal(tree.targets[1].error, "tree 0x80070005");
        resetGpuPriorityForTests();

        const missing = await setGpuPriorityMain("high");
        assert.deepEqual([missing.hags, missing.ok, missing.done], [null, false, 1]);
        assert.equal(missing.targets[1].error, "sem resposta do ajudante");
        resetGpuPriorityForTests();

        const clamped = await setGpuPriorityMain("high");
        assert.deepEqual([clamped.ok, clamped.done, clamped.raised], [false, 1, 1], "o que nao ficou em HIGH nao conta e nao volta");
    });

    test("o helper nao serve: antigo (sem o modo), Windows sem a funcao, saida estranha", async t => {
        helperHost(t);
        const replies: Parameters<typeof answer>[1][] = [
            { stderr: "error usage 0x80070057 uso: telinha-audio.exe ...\n", code: 2 },
            { stdout: "error api 0x8007007F D3DKMTSetProcessSchedulingPriorityClass indisponivel neste Windows\n", code: 6 },
            { code: 1 },
            { code: null, signal: "SIGKILL" }
        ];
        mockSpawn(t, p => answer(p, replies.shift()));
        assert.equal((await setGpuPriorityMain("high")).reason, "o ajudante do Telinha é de uma versão antiga");
        assert.equal((await setGpuPriorityMain("high")).reason, "o Windows não tem a função (0x8007007F)");
        assert.equal((await setGpuPriorityMain("high")).reason, "o ajudante do Telinha fechou com o código 1");
        const killed = await setGpuPriorityMain("high");
        assert.deepEqual([killed.ok, killed.reason, killed.targets[0].error], [false, "o ajudante do Telinha fechou com o código null", null]);
    });

    test("sem o helper ou fora do Windows: nem tenta, e diz por que; a volta sem o helper fica para depois", async t => {
        const host = helperHost(t, { exe: false });
        const procs = mockSpawn(t, p => answer(p, { stdout: `ok pid=${ME} before=NORMAL after=HIGH\nok pid=${GPU} before=NORMAL after=HIGH\n` }));
        assert.equal((await setGpuPriorityMain("high")).reason, "o ajudante do Telinha (telinha-audio.exe) não foi instalado");
        host.setExe(true);
        host.setPlatform("linux");
        assert.equal((await setGpuPriorityMain("high")).reason, "só funciona no Windows");
        assert.equal(procs.spawned.length, 0);

        host.setPlatform("win32");
        assert.equal((await setGpuPriorityMain("high")).raised, 2);
        host.setExe(false);
        const down = await setGpuPriorityMain("restore");
        assert.deepEqual([down.ok, down.reason, down.raised, down.quiet], [false, "o ajudante do Telinha (telinha-audio.exe) não foi instalado", 2, false]);
        host.setExe(true);
        const later = await setGpuPriorityMain("restore");
        assert.deepEqual([later.ok, later.raised, later.quiet], [true, 0, false]);
    });

    test("o Windows ou o antivirus bloqueia o helper (na hora do spawn ou depois)", async t => {
        helperHost(t);
        const blocked = t.mock.method(childProcess, "spawn", (() => {
            throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
        }) as never);
        assert.equal((await setGpuPriorityMain("high")).reason, "o Windows ou o antivírus bloqueou o ajudante do Telinha (telinha-audio.exe)");
        blocked.mock.restore();
        // o erro de abertura e depois a saida: a primeira resposta vence
        mockSpawn(t, p => setImmediate(() => {
            p.fail(Object.assign(new Error("x"), { code: "ENOENT" }));
            p.exit(0);
        }));
        assert.equal((await setGpuPriorityMain("high")).reason, "o ajudante do Telinha (telinha-audio.exe) não foi encontrado (o antivírus pode tê-lo removido)");
    });

    test("helper que nao responde em 12 s: morto, e o relatorio diz; kill que lanca e pipes com erro nao derrubam o main", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.kill = () => {
                throw new Error("EPERM");
            };
        });
        const pending = setGpuPriorityMain("high");
        await flushPromises();
        const [proc] = procs.spawned;
        proc.stdout.emit("error", new Error("EIO"));
        proc.stderr.emit("error", new Error("EIO"));
        let settled = false;
        void pending.then(() => (settled = true));
        clock.tick(11_999);
        await flushPromises();
        assert.equal(settled, false);
        clock.tick(1);
        assert.equal((await pending).reason, "o ajudante do Telinha não respondeu a tempo");
    });

    test("saida grande demais e cortada (o resto e ignorado)", async t => {
        helperHost(t);
        mockSpawn(t, p => setImmediate(async () => {
            await feed(p, `ok pid=${ME} before=NORMAL after=HIGH\n` + "x".repeat(9000) + "\n");
            await feed(p, `ok pid=${GPU} before=NORMAL after=HIGH\n`);
            p.exit(0);
        }));
        const up = await setGpuPriorityMain("high");
        assert.deepEqual([up.done, up.targets[1].error], [1, "sem resposta do ajudante"]);
    });

    /** O helper responde, na ordem, as linhas de cada chamada (`code` 6 quando ha um "error"). */
    function replies(t: TestContext, ...answers: string[][]) {
        helperHost(t);
        return mockSpawn(t, p => {
            const lines = answers.shift() ?? [];
            answer(p, { stdout: lines.join("\n") + "\n", code: lines.some(l => l.startsWith("error ")) ? 6 : 0 });
        });
    }
    const ok = (pid: number, from: string, to: string) => `ok pid=${pid} before=${from} after=${to}`;
    const keep = (pid: number, cls: string) => `keep pid=${pid} class=${cls}`;

    test("a volta que falha fica guardada e e tentada de novo; a mesma falha de novo nao vira outra linha (quiet)", async t => {
        const procs = replies(t,
            ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
            ["hags on", `error open 0x80070005 pid=${ME} Acesso negado.`, ok(GPU, "HIGH", "NORMAL")],
            ["hags on", `error open 0x80070005 pid=${ME} Acesso negado.`],
            ["hags on", ok(ME, "HIGH", "NORMAL")]
        );
        await setGpuPriorityMain("high");
        const first = await setGpuPriorityMain("restore");
        assert.deepEqual([first.ok, first.done, first.refused, first.raised, first.quiet], [false, 1, true, 1, false]);
        const again = await setGpuPriorityMain("restore"); // o inicio do plugin tenta de novo
        assert.equal(procs.spawned[2].args[1], `${ME}`);
        assert.deepEqual([again.ok, again.raised, again.quiet], [false, 1, true]);
        const finally_ = await setGpuPriorityMain("restore");
        assert.deepEqual([finally_.ok, finally_.raised, finally_.quiet], [true, 0, false]);
    });

    test("na volta, o processo que ja terminou (gone) ou cujo pid passou para outro (tree) sai da lista e conta como voltado", async t => {
        replies(t,
            ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
            ["hags on", `error gone 0x80070057 pid=${GPU} o processo terminou`, `error tree 0x80070005 pid=${ME} o pid passou para um processo fora da arvore de quem chamou`]
        );
        await setGpuPriorityMain("high");
        const down = await setGpuPriorityMain("restore");
        assert.deepEqual([down.ok, down.done, down.raised, down.refused], [true, 2, 0, false]);
    });

    test("a proxima transmissao volta em silencio o que ficou de um processo da GPU antigo, e o mesmo processo sobe lembrando a classe de antes", async t => {
        const NEW_GPU = 60_002; // nao e multiplo de 4: nunca e o pid deste processo (no Windows os pids sao)
        const procs = replies(t,
            ["hags on", ok(ME, "ABOVE_NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
            ["hags on", `error open 0x80070005 pid=${ME} Acesso negado.`],
            ["hags on", `error get 0xC0000022 pid=${GPU} acesso negado`],
            ["hags on", ok(GPU, "HIGH", "NORMAL")],
            ["hags on", keep(ME, "HIGH"), ok(NEW_GPU, "NORMAL", "HIGH")],
            ["hags on", ok(NEW_GPU, "HIGH", "NORMAL")],
            ["hags on", ok(ME, "HIGH", "ABOVE_NORMAL")]
        );
        await setGpuPriorityMain("high");
        const down = await setGpuPriorityMain("restore");
        assert.deepEqual([down.raised, down.done], [2, 0], "uma chamada por classe: ABOVE_NORMAL e NORMAL, as duas falharam");
        app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
        const up = await setGpuPriorityMain("high");
        assert.deepEqual(procs.spawned.slice(3, 5).map(p => p.args), [
            ["--gpu-priority", `${GPU}`, "--class", "normal", "--if-class", "high"],
            ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "high", "--raise"]
        ]);
        assert.deepEqual([up.ok, up.raised, up.targets.map(t => t.pid)], [true, 2, [ME, NEW_GPU]]);
        await setGpuPriorityMain("restore");
        // a ordem das chamadas segue a da lista, nao a dos pids: compara por pid
        assert.deepEqual(Object.fromEntries(procs.spawned.slice(5).map(p => [p.args[1], p.args[3]])), { [ME]: "above_normal", [NEW_GPU]: "normal" });
    });

    test("sem resposta a tempo: o que o helper ja tinha escrito vale; a volta que nao responde fica para depois", async t => {
        helperHost(t);
        const clock = useFakeClock(t);
        // o "high" escreve a linha do principal e trava; a volta so escreve o hags e trava
        const procs = mockSpawn(t, p => setImmediate(() => void feed(p, p.args[3] === "high" ? `hags on\n${ok(ME, "NORMAL", "HIGH")}\n` : "hags on\n")));
        const up = setGpuPriorityMain("high");
        await flushPromises();
        await flushPromises();
        clock.tick(12_000);
        const report = await up;
        assert.deepEqual([report.ok, report.done, report.raised, report.reason, report.hags], [false, 1, 1, "o ajudante do Telinha não respondeu a tempo", "on"]);
        assert.deepEqual(report.targets[1], target(GPU, "GPU", null, null), "sem linha, sem erro: so nao respondeu");

        const down = setGpuPriorityMain("restore");
        await flushPromises();
        await flushPromises();
        clock.tick(12_000);
        assert.deepEqual([(await down).ok, (await down).raised], [false, 1]);
        assert.equal(procs.spawned.length, 2);
    });

    describe("tempo real (modo realtime: HIGH e, por cima, REALTIME so com --allow-realtime)", () => {
        const REAL = ["--gpu-priority", `${ME},${GPU}`, "--class", "realtime", "--raise", "--allow-realtime"];
        const REFUSED_TEXT = "set 0xC0000061 privilegio ausente";

        test("(a) NORMAL → HIGH → REALTIME nos dois; a volta parte de REALTIME e cada um volta ao que era", async t => {
            const procs = helperAnswers(t);
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual(procs.spawned.map(p => p.args), [["--gpu-priority", `${ME},${GPU}`, "--class", "high", "--raise"], REAL], "duas fases; REALTIME so com --raise e --allow-realtime");
            assert.deepEqual([up.mode, up.ok, up.done, up.raised, up.level, up.realtimeRefused, up.refused, up.reason], ["realtime", true, 2, 2, "REALTIME", false, false, null]);
            assert.deepEqual(up.targets, [target(ME, "Discord", "HIGH", "REALTIME"), target(GPU, "GPU", "HIGH", "REALTIME")]);
            assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "REALTIME", [GPU]: "REALTIME" });

            const down = await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned[2].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "normal", "--if-class", "realtime"]);
            assert.deepEqual([down.ok, down.done, down.raised, down.level], [true, 2, 0, null]);
            assert.deepEqual(down.targets, [target(ME, "Discord", "REALTIME", "NORMAL"), target(GPU, "GPU", "REALTIME", "NORMAL")]);
            assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "NORMAL", [GPU]: "NORMAL" });
        });

        test("(b) o processo da GPU ja em REALTIME (o Discord poe): fica, so o principal sobe, e a volta nao mexe nele", async t => {
            const procs = helperAnswers(t, { before: pid => (pid === String(GPU) ? "REALTIME" : "NORMAL") });
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual(procs.spawned.map(p => p.args[1]), [`${ME},${GPU}`, `${ME}`], "a 2a fase so vai ao que ficou em HIGH");
            assert.deepEqual(up.targets, [target(ME, "Discord", "HIGH", "REALTIME"), keptRealtime()]);
            assert.deepEqual([up.ok, up.done, up.raised, up.level, up.realtimeRefused], [true, 2, 1, "REALTIME", false]);

            const down = await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned[2].args, ["--gpu-priority", `${ME}`, "--class", "normal", "--if-class", "realtime"]);
            assert.deepEqual(down.targets, [target(ME, "Discord", "REALTIME", "NORMAL"), keptRealtime()]);
            assert.equal(procs.classes.get(String(GPU)), undefined, "a classe do processo da GPU nunca foi trocada");
        });

        test("(c) o Windows recusa o REALTIME (0xC0000061): realtimeRefused, fica em HIGH e a volta parte de HIGH", async t => {
            const procs = helperAnswers(t, { realtime: "refuse" });
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([up.ok, up.done, up.realtimeRefused, up.refused, up.raised, up.level, up.reason], [false, 0, true, true, 2, null, null]);
            assert.deepEqual(up.targets.map(t => t.error), [REFUSED_TEXT, REFUSED_TEXT]);
            assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "HIGH", [GPU]: "HIGH" }, "nunca cai para NORMAL");

            const down = await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned[2].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "normal", "--if-class", "high"]);
            assert.deepEqual([down.ok, down.done], [true, 2]);
        });

        test("(d) o Windows aceita a chamada e mantem HIGH: conta como recusado, com o texto", async t => {
            const procs = helperAnswers(t, { realtime: "clamp" });
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([up.ok, up.done, up.realtimeRefused, up.refused, up.level], [false, 0, true, false, null]);
            assert.deepEqual(up.targets.map(t => [t.before, t.after, t.error]), [["HIGH", "HIGH", "o Windows manteve HIGH"], ["HIGH", "HIGH", "o Windows manteve HIGH"]]);
            await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned[2].args.slice(4), ["--if-class", "high"]);
        });

        test("(e) helper antigo (error usage na 2a fase): o motivo diz que falta o tempo real, e fica em HIGH", async t => {
            const procs = helperAnswers(t, { realtime: "old" });
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([up.ok, up.reason, up.realtimeRefused, up.raised, up.level], [false, "o ajudante do Telinha é de uma versão antiga (sem o tempo real)", false, 2, null]);
            assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "HIGH", [GPU]: "HIGH" });
            await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned[2].args.slice(4), ["--if-class", "high"]);
        });

        test("(f) high depois de realtime desce so o que o Telinha pos, para HIGH; depois o restore volta a NORMAL", async t => {
            const procs = helperAnswers(t);
            await setGpuPriorityMain("realtime");
            const down = await setGpuPriorityMain("high");
            assert.deepEqual(procs.spawned.slice(2).map(p => p.args), [
                ["--gpu-priority", `${ME},${GPU}`, "--class", "high", "--raise"],
                ["--gpu-priority", `${ME},${GPU}`, "--class", "high", "--if-class", "realtime"]
            ], "o --raise deixa o REALTIME como esta (keep) e a descida e outra chamada");
            assert.deepEqual(down.targets, [target(ME, "Discord", "REALTIME", "HIGH"), target(GPU, "GPU", "REALTIME", "HIGH")]);
            assert.deepEqual([down.ok, down.done, down.raised, down.level], [true, 2, 2, "HIGH"]);

            await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned[4].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "normal", "--if-class", "high"]);
            assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "NORMAL", [GPU]: "NORMAL" });
        });

        test("pedir realtime de novo nao desce nem sobe de novo: so a 1a fase (keep), e o nivel segue REALTIME", async t => {
            const procs = helperAnswers(t);
            await setGpuPriorityMain("realtime");
            const again = await setGpuPriorityMain("realtime");
            assert.equal(procs.spawned.length, 3, "nada ficou em HIGH para a 2a fase");
            assert.deepEqual([again.ok, again.level, again.raised, again.realtimeRefused], [true, "REALTIME", 2, false]);
        });

        test("(g) a descida acha que outro mudou a classe (keep): a entrada sai da lista e a volta nao toca nesse processo", async t => {
            const procs = replies(t,
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "REALTIME"), ok(GPU, "HIGH", "REALTIME")],
                ["hags on", keep(ME, "REALTIME"), keep(GPU, "REALTIME")],
                ["hags on", ok(ME, "REALTIME", "HIGH"), keep(GPU, "ABOVE_NORMAL")], // outro baixou o processo da GPU no meio
                ["hags on", ok(ME, "HIGH", "NORMAL")]
            );
            await setGpuPriorityMain("realtime");
            const down = await setGpuPriorityMain("high");
            assert.deepEqual(procs.spawned[3].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "high", "--if-class", "realtime"]);
            assert.deepEqual(down.targets, [target(ME, "Discord", "REALTIME", "HIGH"), keptRealtime()]); // o relatorio fica com o que o 1o passo viu
            assert.deepEqual([down.ok, down.raised, down.level], [true, 1, "HIGH"]);
            await setGpuPriorityMain("restore");
            assert.equal(procs.spawned[4].args[1], `${ME}`, "o processo da GPU saiu da lista");
        });

        test("a classe de um processo em REALTIME que outro baixou para HIGH: o \"high\" o acha em HIGH e nao pede a descida", async t => {
            const procs = helperAnswers(t);
            await setGpuPriorityMain("realtime");
            procs.classes.set(String(GPU), "HIGH"); // outro baixou o processo da GPU para HIGH
            const again = await setGpuPriorityMain("high");
            assert.deepEqual(procs.spawned.slice(2).map(p => p.args.slice(3)), [["high", "--raise"], ["high", "--if-class", "realtime"]], "so o principal desce");
            assert.equal(procs.spawned[3].args[1], `${ME}`);
            assert.deepEqual(again.targets.map(t => t.after), ["HIGH", "HIGH"]);
        });

        test("a descida que falha deixa a entrada em REALTIME e a proxima tenta de novo; um processo que terminou sai da lista", async t => {
            const procs = replies(t,
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "REALTIME"), ok(GPU, "HIGH", "REALTIME")],
                ["hags on", keep(ME, "REALTIME"), keep(GPU, "REALTIME")],
                ["hags on", `error open 0x80070005 pid=${ME} Acesso negado.`, `error gone 0x80070057 pid=${GPU} o processo terminou`],
                ["hags on", keep(ME, "REALTIME")],
                ["hags on", ok(ME, "REALTIME", "HIGH")],
                ["hags on", ok(ME, "HIGH", "NORMAL")]
            );
            await setGpuPriorityMain("realtime");
            const failed = await setGpuPriorityMain("high");
            assert.deepEqual([failed.ok, failed.refused, failed.raised, failed.targets[0].error], [false, true, 1, "open 0x80070005 Acesso negado."]);
            app.appMetrics = [{ pid: ME, type: "Browser" }]; // o processo da GPU terminou
            const retry = await setGpuPriorityMain("high");
            assert.equal(procs.spawned[5].args[1], `${ME}`, "so o que ficou em REALTIME");
            assert.deepEqual([retry.ok, retry.level, retry.targets[0].after], [true, "HIGH", "HIGH"]);
            const final = await setGpuPriorityMain("restore");
            assert.deepEqual([final.ok, final.raised], [true, 0]);
        });

        test("a descida sem o helper (sumiu): o relatorio diz por que e a entrada fica para a proxima", async t => {
            const host = helperHost(t);
            const lines = [
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "REALTIME"), ok(GPU, "HIGH", "REALTIME")]
            ];
            mockSpawn(t, p => answer(p, { stdout: (lines.shift() ?? []).join("\n") + "\n", code: 0 }));
            await setGpuPriorityMain("realtime");
            host.setExe(false);
            const down = await setGpuPriorityMain("high");
            assert.deepEqual([down.ok, down.raised, down.level], [false, 2, null]);
            assert.equal(down.reason, "o ajudante do Telinha (telinha-audio.exe) não foi instalado");
        });

        test("(h) quem ja estava em HIGH por outro vai a REALTIME; o restore o devolve a HIGH, a classe que tinha", async t => {
            const procs = helperAnswers(t, { before: pid => (pid === String(GPU) ? "HIGH" : "NORMAL") });
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual(up.targets, [target(ME, "Discord", "HIGH", "REALTIME"), target(GPU, "GPU", "HIGH", "REALTIME")]);
            assert.deepEqual([up.raised, up.level], [2, "REALTIME"]);
            const down = await setGpuPriorityMain("restore");
            assert.deepEqual(Object.fromEntries(procs.spawned.slice(2).map(p => [p.args[1], [p.args[3], p.args[5]]])), { [ME]: ["normal", "realtime"], [GPU]: ["high", "realtime"] });
            assert.deepEqual(down.targets, [target(ME, "Discord", "REALTIME", "NORMAL"), target(GPU, "GPU", "REALTIME", "HIGH")]);
            assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "NORMAL", [GPU]: "HIGH" });
        });

        test("outro pos o REALTIME entre as duas fases (keep na 2a): nao e do Telinha, volta de HIGH", async t => {
            const procs = replies(t,
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "REALTIME"), keep(GPU, "REALTIME")],
                ["hags on", ok(ME, "REALTIME", "NORMAL")],
                ["hags on", ok(GPU, "REALTIME", "NORMAL")]
            );
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([up.ok, up.raised, up.level], [true, 2, "REALTIME"]);
            await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned.slice(2).map(p => p.args), [
                ["--gpu-priority", `${ME}`, "--class", "normal", "--if-class", "realtime"],
                ["--gpu-priority", `${GPU}`, "--class", "normal", "--if-class", "high"]
            ]);
        });

        test("sem o helper: a 1a fase diz por que e a 2a nem roda", async t => {
            helperHost(t, { exe: false });
            const procs = mockSpawn(t, p => answer(p, { stdout: "" }));
            const none = await setGpuPriorityMain("realtime");
            assert.deepEqual([none.ok, none.reason, none.level, none.realtimeRefused, procs.spawned.length], [false, "o ajudante do Telinha (telinha-audio.exe) não foi instalado", null, false, 0]);
        });

        test("o Windows recusa ate o HIGH: nada ficou em HIGH, entao nada de REALTIME a pedir", async t => {
            const procs = helperAnswers(t, { refuse: [String(ME), String(GPU)] });
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([up.mode, up.ok, up.refused, up.realtimeRefused, up.raised, up.level, procs.spawned.length], ["realtime", false, true, false, 0, null, 1]);
        });

        test("o REALTIME recusado so no processo da GPU: o principal chega la e a volta tem um helper por classe atual", async t => {
            const procs = replies(t,
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "REALTIME"), `error set 0xC0000022 pid=${GPU} acesso negado`]
            );
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([up.ok, up.done, up.realtimeRefused, up.level, up.raised], [false, 1, true, null, 2]);
            await setGpuPriorityMain("restore");
            assert.deepEqual(procs.spawned.slice(2).map(p => [p.args[1], p.args[5]]), [[`${ME}`, "realtime"], [`${GPU}`, "high"]]);
        });
    });

    describe("tempo real: bloqueio e marcador (gpu-priority.json, ao lado do capture-flags.json)", () => {
        const gp = () => join(dir, "gpu-priority.json");
        const onDisk = () => JSON.parse(readFileSync(gp(), "utf8"));
        const writeState = (state: unknown) => writeFileSync(gp(), JSON.stringify(state));
        const DIED = (at: Date) => `o Discord fechou sem sair do tempo real (travou ou foi fechado à força) em ${String(at.getDate()).padStart(2, "0")}/${String(at.getMonth() + 1).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
        const realtimeCalls = (procs: { spawned: { args: string[]; }[]; }) => procs.spawned.filter(p => p.args.includes("--allow-realtime")).length;

        test("o marcador vai para o disco ANTES do REALTIME, fica enquanto algo esta em REALTIME e sai na volta", async t => {
            helperHost(t);
            const answers = [
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "REALTIME"), ok(GPU, "HIGH", "REALTIME")],
                ["hags on", ok(ME, "REALTIME", "NORMAL"), ok(GPU, "REALTIME", "NORMAL")]
            ];
            let beforePhase2: unknown = "nunca";
            mockSpawn(t, p => {
                if (p.args.includes("--allow-realtime")) beforePhase2 = existsSync(gp()) ? onDisk() : null;
                answer(p, { stdout: (answers.shift() ?? []).join("\n") + "\n", code: 0 });
            });
            assert.equal(existsSync(gp()), false, "nada e gravado antes de pedir o REALTIME");
            const up = await setGpuPriorityMain("realtime");
            assert.equal(up.level, "REALTIME");
            const { armed } = beforePhase2 as { armed: { pid: number; at: number; }; };
            assert.deepEqual([(beforePhase2 as { format: number; }).format, armed.pid, typeof armed.at, (beforePhase2 as { blocked: unknown; }).blocked], [1, ME, "number", null], "ja estava no disco quando o helper foi chamado");
            assert.deepEqual(onDisk().armed, armed, "segue armado: ha processos em REALTIME");

            const down = await setGpuPriorityMain("restore");
            assert.equal(down.ok, true);
            assert.deepEqual(onDisk(), { format: 1, blocked: null, armed: null });
            assert.deepEqual(readdirSync(dir), ["gpu-priority.json"], "sem sobra de temporario");
        });

        test("o armado so e regravado uma vez por partida; a descida do high tambem limpa o marcador", async t => {
            const clock = useFakeClock(t);
            const procs = replies(t,
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "REALTIME"), `error set 0xC0000022 pid=${GPU} acesso negado`],
                ["hags on", keep(ME, "REALTIME"), keep(GPU, "HIGH")],
                ["hags on", `error set 0xC0000022 pid=${GPU} acesso negado`],
                ["hags on", keep(ME, "REALTIME"), keep(GPU, "HIGH")],
                ["hags on", ok(ME, "REALTIME", "HIGH")]
            );
            await setGpuPriorityMain("realtime");
            const first = onDisk().armed;
            assert.equal(first.pid, ME);
            clock.tick(5000);
            await setGpuPriorityMain("realtime");
            assert.deepEqual(onDisk().armed, first, "ja armado por este processo: nao regrava");
            await setGpuPriorityMain("high");
            assert.equal(procs.spawned.length, 6);
            assert.deepEqual(onDisk(), { format: 1, blocked: null, armed: null });
        });

        test("o REALTIME recusado ou mantido em HIGH nao deixa o marcador, e recusar nao bloqueia o PC", async t => {
            helperAnswers(t, { realtime: "refuse" });
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([up.realtimeRefused, up.realtimeBlocked], [true, null]);
            assert.deepEqual(onDisk(), { format: 1, blocked: null, armed: null });
            assert.deepEqual(gpuRealtimeStatus(ipcEvent()), { available: true, blocked: null, reason: null });
        });

        test("outra partida do Discord achou o marcador armado (o Discord morreu com o REALTIME): bloqueia com o texto, limpa o marcador e fica em HIGH", async t => {
            const procs = helperAnswers(t);
            await setGpuPriorityMain("realtime");
            assert.equal(onDisk().armed.pid, ME);
            // o Discord morreu: a partida nova tem outro pid
            const armedAt = new Date(2026, 10, 2, 21, 5);
            writeState({ format: 1, blocked: null, armed: { pid: ME + 1, at: armedAt.getTime() } });
            resetGpuPriorityForTests();
            procs.classes.clear(); // o Discord novo nasce em NORMAL
            procs.spawned.length = 0;

            assert.deepEqual(gpuRealtimeStatus(ipcEvent()), { available: false, blocked: DIED(armedAt), reason: null });
            assert.equal(DIED(armedAt).endsWith("em 02/11 21:05"), true);
            const state = onDisk();
            assert.deepEqual([state.armed, state.blocked.why, typeof state.blocked.at], [null, DIED(armedAt), "number"]);

            const up = await setGpuPriorityMain("realtime");
            assert.equal(realtimeCalls(procs), 0, "nem pede o REALTIME");
            assert.deepEqual(up.targets.map(t => t.after), ["HIGH", "HIGH"]);
            assert.deepEqual([up.level, up.ok, up.realtimeRefused, up.reason, up.realtimeBlocked], ["HIGH", false, false, `tempo real desligado neste PC: ${DIED(armedAt)}`, DIED(armedAt)]);
            assert.deepEqual((await setGpuPriorityMain("high")).realtimeBlocked, DIED(armedAt), "todo relatorio traz o bloqueio");
        });

        test("um armado deste mesmo processo (a memoria foi esquecida) nao e queda", t => {
            helperHost(t);
            writeState({ format: 1, blocked: null, armed: { pid: ME, at: Date.now() } });
            assert.deepEqual(gpuRealtimeStatus(ipcEvent()), { available: true, blocked: null, reason: null });
            assert.equal(onDisk().armed.pid, ME);
        });

        test("o bloqueio fica no disco e vale na proxima partida; desbloquear (a escolha de novo na pagina) libera o REALTIME", async t => {
            const procs = helperAnswers(t);
            const blocked = setGpuRealtimeBlocked(ipcEvent(), "o encoder da placa de vídeo parou com o tempo real em 02/11 21:07");
            assert.deepEqual(blocked, { available: false, blocked: "o encoder da placa de vídeo parou com o tempo real em 02/11 21:07", reason: null });
            assert.deepEqual([onDisk().blocked.why, onDisk().armed], ["o encoder da placa de vídeo parou com o tempo real em 02/11 21:07", null]);

            resetGpuPriorityForTests(); // outra partida: o arquivo manda
            assert.equal(gpuRealtimeStatus(ipcEvent()).blocked, "o encoder da placa de vídeo parou com o tempo real em 02/11 21:07");
            const stays = await setGpuPriorityMain("realtime");
            assert.deepEqual([realtimeCalls(procs), stays.level, stays.reason], [0, "HIGH", "tempo real desligado neste PC: o encoder da placa de vídeo parou com o tempo real em 02/11 21:07"]);

            assert.deepEqual(setGpuRealtimeBlocked(ipcEvent(), null), { available: true, blocked: null, reason: null });
            assert.equal(onDisk().blocked, null);
            const again = await setGpuPriorityMain("realtime");
            assert.deepEqual([realtimeCalls(procs), again.level, again.reason, again.realtimeBlocked], [1, "REALTIME", null, null]);
        });

        test("setGpuRealtimeBlocked limpa o que vem do IPC: so texto bloqueia (cortado em 300), so null libera, texto vazio tem motivo", t => {
            helperHost(t);
            assert.equal(setGpuRealtimeBlocked(ipcEvent(), "x".repeat(500)).blocked?.length, 300);
            assert.equal(setGpuRealtimeBlocked(ipcEvent(), 42 as never).blocked?.length, 300, "numero e ignorado");
            assert.equal(setGpuRealtimeBlocked(ipcEvent(), undefined as never).blocked?.length, 300, "undefined tambem");
            assert.equal(setGpuRealtimeBlocked(ipcEvent(), "   ").blocked, "motivo não informado");
            assert.equal(setGpuRealtimeBlocked(ipcEvent(), null).blocked, null);
        });

        test("sem o loader (sem pasta): indisponivel, o realtime fica em HIGH e nada e gravado; o bloqueio vale so na memoria", async t => {
            const procs = helperAnswers(t);
            delete g.__TelinhaAddon;
            const up = await setGpuPriorityMain("realtime");
            assert.deepEqual([procs.spawned.length, up.level, up.ok, up.reason, up.realtimeBlocked], [1, "HIGH", false, "só com o Telinha instalado pelo TelinhaInstaller", null]);
            assert.deepEqual(gpuRealtimeStatus(ipcEvent()), { available: false, blocked: null, reason: "só com o Telinha instalado pelo TelinhaInstaller" });
            assert.equal(setGpuRealtimeBlocked(ipcEvent(), "x").blocked, "x");
            assert.deepEqual(readdirSync(dir), [], "nada gravado em lugar nenhum");
        });

        test("arquivo ausente, quebrado ou com campos estranhos: le como vazio", t => {
            helperHost(t);
            const empty = { available: true, blocked: null, reason: null };
            assert.deepEqual(gpuRealtimeStatus(ipcEvent()), empty, "ausente");
            for (const junk of ["{ quebrado", "null", JSON.stringify({ blocked: { why: 5, at: 1 }, armed: { pid: "x", at: 1 } }), JSON.stringify({ blocked: { why: "", at: 1 }, armed: { pid: 1.5, at: 1 } }), JSON.stringify({ blocked: { why: "x" }, armed: { pid: 7 } })]) {
                resetGpuPriorityForTests();
                writeFileSync(gp(), junk);
                assert.deepEqual(gpuRealtimeStatus(ipcEvent()), empty, junk);
                assert.equal(readFileSync(gp(), "utf8"), junk, "so ler nao reescreve");
            }
            resetGpuPriorityForTests();
            writeState({ format: 1, blocked: { at: 1, why: "y".repeat(400) }, armed: null });
            assert.equal(gpuRealtimeStatus(ipcEvent()).blocked, "y".repeat(300));
        });

        test("nao deu para gravar (no lugar do arquivo ha uma pasta): nunca lanca, o REALTIME nao e pedido sem a rede de seguranca e o motivo vem em pt-BR", async t => {
            const procs = helperAnswers(t);
            mkdirSync(gp());
            const up = await setGpuPriorityMain("realtime");
            assert.match(up.reason ?? "", /^tempo real não ligado: não consegui salvar o estado do tempo real \(/);
            assert.deepEqual([procs.spawned.length, up.level, up.ok, up.realtimeRefused], [1, "HIGH", false, false], "so a 1a fase");
            assert.deepEqual(readdirSync(dir), ["gpu-priority.json"], "o temporario foi apagado");
            const status = gpuRealtimeStatus(ipcEvent());
            assert.deepEqual([status.available, status.blocked], [false, null]);
            assert.match(status.reason ?? "", /^não consegui salvar o estado do tempo real \(/);

            const blocked = setGpuRealtimeBlocked(ipcEvent(), "x");
            assert.equal(blocked.blocked, "x", "a memoria bloqueia mesmo sem gravar");
            assert.match(blocked.reason ?? "", /^não consegui salvar/);
        });

        test("um erro que nao e Error vira texto", t => {
            helperHost(t);
            t.mock.method(fs, "writeFileSync", () => {
                throw "disco cheio";
            });
            t.mock.method(fs, "rmSync", () => {
                throw new Error("EBUSY");
            });
            const status = setGpuRealtimeBlocked(ipcEvent(), "x");
            t.mock.restoreAll();
            assert.equal(status.reason, "não consegui salvar o estado do tempo real (disco cheio)");
        });

        test("a saida normal do processo apaga o marcador (so o de agora); uma queda o deixa para a proxima partida", async t => {
            helperAnswers(t);
            const hooks: (() => void)[] = [];
            t.mock.method(process, "once", ((event: string, cb: () => void) => {
                if (event === "exit") hooks.push(cb);
                return process;
            }) as never);
            await setGpuPriorityMain("realtime");
            assert.equal(hooks.length, 1);
            assert.equal(onDisk().armed.pid, ME);
            hooks[0]();
            assert.deepEqual(onDisk(), { format: 1, blocked: null, armed: null });
            hooks[0](); // nada armado: nada a fazer
            resetGpuPriorityForTests();
            hooks[0](); // sem estado na memoria: nada a fazer
            assert.deepEqual(onDisk(), { format: 1, blocked: null, armed: null });
        });

        test("o gancho de saida e instalado uma vez, e o reset o tira", async t => {
            helperAnswers(t);
            const before = process.listenerCount("exit");
            await setGpuPriorityMain("realtime");
            assert.equal(process.listenerCount("exit"), before + 1);
            await setGpuPriorityMain("restore");
            await setGpuPriorityMain("realtime");
            assert.equal(process.listenerCount("exit"), before + 1, "uma vez so");
            resetGpuPriorityForTests();
            assert.equal(process.listenerCount("exit"), before);
        });
    });

    describe("o processo da GPU do Discord reinicia no meio da transmissao", () => {
        const NEW_GPU = 60_002; // nao e multiplo de 4: nunca e o pid deste processo (no Windows os pids sao)
        const gone = (type = "GPU") => app.emit("child-process-gone", {}, { type, reason: "crashed", exitCode: 1 });

        /** espera os timers de 2 s e a fila (helper respondendo por setImmediate) */
        async function after(clock: ReturnType<typeof useFakeClock>, ms: number) {
            clock.tick(ms);
            for (let i = 0; i < 5; i++) await flushPromises();
        }

        test("o pid antigo sai e o novo sobe assim que aparece; a nota (com a hora) vem no proximo relatorio", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t);
            await setGpuPriorityMain("high");
            app.appMetrics = [{ pid: ME, type: "Browser" }];
            gone();
            await after(clock, 2000); // o novo ainda nao apareceu
            assert.equal(procs.spawned.length, 1);
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
            await after(clock, 2000);
            assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "high", "--raise"]);
            const down = await setGpuPriorityMain("restore");
            assert.equal(down.notes.length, 1);
            assert.match(down.notes[0], new RegExp(`^o processo da GPU do Discord reiniciou às \\d\\d:\\d\\d:\\d\\d UTC \\(${GPU} → ${NEW_GPU}\\): alta de novo$`));
            assert.deepEqual(procs.spawned[2].args, ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "normal", "--if-class", "high"], "o antigo nao esta mais na volta");
            assert.deepEqual((await setGpuPriorityMain("restore")).notes, [], "a nota sai uma vez so");
        });

        test("o processo da GPU em REALTIME reinicia e o novo tambem nasce em REALTIME: nenhum dos dois e mexido", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t, { before: pid => (pid === String(ME) ? "NORMAL" : "REALTIME") });
            await setGpuPriorityMain("high");
            gone();
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
            await after(clock, 2000);
            assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "high", "--raise"]);
            const down = await setGpuPriorityMain("restore");
            assert.match(down.notes[0], new RegExp(`\\(${GPU} → ${NEW_GPU}\\): já estava REALTIME$`), "o antigo vem do que ficou como estava");
            assert.deepEqual(procs.spawned[2].args, ["--gpu-priority", `${ME}`, "--class", "normal", "--if-class", "high"]);
            assert.deepEqual(down.targets, [target(ME, "Discord", "HIGH", "NORMAL"), keptRealtime(NEW_GPU)], "so o novo é citado");
            assert.deepEqual(Object.fromEntries(procs.classes), { [ME]: "NORMAL" });
        });

        test("o Windows deu o pid antigo ao processo novo: vale o que nasceu depois da queda (creationTime)", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t);
            await setGpuPriorityMain("high");
            const crashedAt = clock.epoch();
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: GPU, type: "GPU", creationTime: crashedAt - 3_600_000 }];
            gone();
            procs.classes.delete(String(GPU)); // o processo novo nasce em NORMAL
            await after(clock, 2000); // ainda o antigo (nasceu bem antes da queda)
            assert.equal(procs.spawned.length, 1);
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: GPU, type: "GPU", creationTime: crashedAt - 1000 }];
            await after(clock, 2000);
            assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "high", "--raise"]);
            const down = await setGpuPriorityMain("restore");
            assert.match(down.notes[0], new RegExp(`\\(${GPU} → ${GPU}\\): alta de novo$`));
        });

        test("o novo nao aparece: 3 tentativas e uma nota", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t);
            await setGpuPriorityMain("high");
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: GPU, type: "GPU" }];
            gone();
            for (let i = 0; i < 3; i++) await after(clock, 2000);
            assert.equal(procs.spawned.length, 1);
            const down = await setGpuPriorityMain("restore");
            assert.match(down.notes[0], /^o processo da GPU do Discord reiniciou às .* UTC e o novo não apareceu: alta só no principal$/);
            assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME}`, "--class", "normal", "--if-class", "high"]);
        });

        test("o novo nao sobe (o Windows recusa, ou o helper sumiu): a nota diz por que", async t => {
            const clock = useFakeClock(t);
            const host = helperHost(t);
            const answers = [
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", keep(ME, "HIGH"), `error open 0x80070005 pid=${NEW_GPU} Acesso negado.`]
            ];
            mockSpawn(t, p => answer(p, { stdout: (answers.shift() ?? []).join("\n") + "\n", code: 0 }));
            await setGpuPriorityMain("high");
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
            gone();
            await after(clock, 2000);
            gone(); // de novo: o novo tambem cai, e o helper sumiu
            host.setExe(false);
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU + 4, type: "GPU" }];
            await after(clock, 2000);
            host.setExe(true);
            const { notes } = await setGpuPriorityMain("high");
            assert.match(notes[0], new RegExp(`\\(${GPU} → ${NEW_GPU}\\): não subiu de novo \\(open 0x80070005 Acesso negado\\.\\)$`));
            assert.match(notes[1], new RegExp(`\\(\\? → ${NEW_GPU + 4}\\): não subiu de novo \\(o ajudante do Telinha \\(telinha-audio\\.exe\\) não foi instalado\\)$`));
        });

        test("outro tipo de processo, ou sem transmissao: nada; a transmissao que para antes do novo aparecer: nada sobe", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t);
            gone(); // ainda sem ouvinte: nada
            await setGpuPriorityMain("high");
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
            gone("Utility");
            app.emit("child-process-gone", {}, undefined);
            await after(clock, 2000);
            assert.equal(procs.spawned.length, 1);
            gone();
            await setGpuPriorityMain("restore");
            await after(clock, 2000);
            assert.equal(procs.spawned.length, 2, "so a volta");
            gone(); // depois da volta: nada
            await after(clock, 2000);
            assert.equal(procs.spawned.length, 2);
        });

        test("a GPU cai enquanto a volta espera o helper: nada quebra e a lista fica limpa", async t => {
            const procs = helperAnswers(t);
            await setGpuPriorityMain("high");
            const restoring = setGpuPriorityMain("restore");
            await flushPromises();
            gone();
            const down = await restoring;
            assert.deepEqual([down.ok, down.raised, procs.spawned.length], [true, 0, 2]);
        });

        test("(i) o processo da GPU reinicia com o tempo real ligado: o novo sobe so para HIGH, e o principal desce para HIGH", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t);
            await setGpuPriorityMain("realtime");
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
            gone();
            procs.classes.delete(String(GPU)); // o processo novo nasce em NORMAL
            await after(clock, 2000);
            assert.deepEqual(procs.spawned.slice(2).map(p => p.args), [
                ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "high", "--raise"],
                ["--gpu-priority", `${ME}`, "--class", "high", "--if-class", "realtime"]
            ], "nunca REALTIME sozinho no novo; o principal desce para HIGH");
            assert.equal(procs.classes.get(String(NEW_GPU)), "HIGH");
            const down = await setGpuPriorityMain("restore");
            assert.match(down.notes[0], new RegExp(`\\(${GPU} → ${NEW_GPU}\\): alta de novo$`));
            assert.deepEqual(procs.spawned[4].args, ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "normal", "--if-class", "high"]);
        });

        test("o processo da GPU cai com o tempo real do Telinha ligado: o REALTIME fica desligado neste PC e o proximo realtime so chega a HIGH", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t);
            await setGpuPriorityMain("realtime");
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
            gone();
            procs.classes.delete(String(GPU));
            await after(clock, 2000);
            await after(clock, 0); // a descida do principal e a 2a chamada do helper
            const why = "o processo da GPU do Discord caiu com o tempo real ligado";
            assert.deepEqual(gpuRealtimeStatus(ipcEvent()), { available: false, blocked: why, reason: null });
            assert.deepEqual(JSON.parse(readFileSync(join(dir, "gpu-priority.json"), "utf8")).blocked.why, why);
            assert.equal(JSON.parse(readFileSync(join(dir, "gpu-priority.json"), "utf8")).armed, null, "o principal desceu para HIGH: nada mais em REALTIME");

            const before = procs.spawned.length;
            const up = await setGpuPriorityMain("realtime");
            assert.equal(procs.spawned.slice(before).some(p => p.args.includes("--allow-realtime")), false);
            assert.deepEqual(up.targets.map(t => t.after), ["HIGH", "HIGH"]);
            assert.deepEqual([up.reason, up.realtimeBlocked], [`tempo real desligado neste PC: ${why}`, why]);
        });

        test("a GPU em REALTIME que o Discord pos (nao e do Telinha) cai: nao bloqueia", async t => {
            const clock = useFakeClock(t);
            helperAnswers(t, { before: pid => (pid === String(GPU) ? "REALTIME" : "NORMAL") });
            await setGpuPriorityMain("realtime");
            gone();
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
            await after(clock, 2000);
            assert.equal(gpuRealtimeStatus(ipcEvent()).blocked, null);
        });

        test("app.on que lanca: a prioridade funciona, so sem o ouvinte", async t => {
            app.onImpl = () => {
                throw new Error("app not ready");
            };
            helperAnswers(t);
            assert.equal((await setGpuPriorityMain("high")).ok, true);
            assert.deepEqual(app.listeners, {});
        });
    });
});
