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

import { gpuCaptureStatus, setGpuCapture, setGpuPriority } from "@plugins/telinha/native";
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
        assert.deepEqual(saved(), { format: 1, wgcTexture: true });
        assert.equal(setGpuCaptureMain(false).saved, false);
        assert.deepEqual(saved(), { format: 1, wgcTexture: false });
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
        app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: GPU, type: "GPU" }, { pid: 51_302, type: "Tab" }];
        app.getAppMetricsImpl = null;
        app.listeners = {};
        app.onImpl = null;
    });

    /** O helper responde como o de verdade: `before(pid)` = a classe de cada um antes; `refuse` = os pids recusados. */
    function helperAnswers(t: TestContext, { before = (_pid: string): string => "NORMAL", refuse = [] as string[], hags = "on" } = {}) {
        helperHost(t);
        return mockSpawn(t, p => {
            const pids = p.args[1].split(",");
            const cls = p.args[3].toUpperCase();
            const lines = [`hags ${hags}`, ...pids.map(pid => (refuse.includes(pid) ? `error open 0x80070005 pid=${pid} Acesso negado.` : `ok pid=${pid} before=${before(pid)} after=${cls}`))];
            answer(p, { stdout: lines.join("\r\n") + "\r\n", code: refuse.some(r => pids.includes(r)) ? 6 : 0 });
        });
    }

    const target = (pid: number, role: "Discord" | "GPU", before: string | null, after: string | null, error: string | null = null) => ({ pid, role, before, after, error });

    test("HIGH no Discord e no processo da GPU; ao parar, cada um volta ao que era; sem nada a voltar, nem abre o helper", async t => {
        const procs = helperAnswers(t);
        const up = await setGpuPriority(ipcEvent(), "high");
        assert.deepEqual(procs.spawned[0].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "high"]);
        assert.deepEqual(procs.spawned[0].options, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        const expected: GpuPriorityReport = {
            mode: "high", ok: true, done: 2, hags: "on", reason: null, refused: false, raised: 2, quiet: false, notes: [],
            targets: [target(ME, "Discord", "NORMAL", "HIGH"), target(GPU, "GPU", "NORMAL", "HIGH")]
        };
        assert.deepEqual(up, expected);

        const down = await setGpuPriority(ipcEvent(), "restore");
        assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "normal"]);
        assert.deepEqual([down.mode, down.ok, down.done, down.raised], ["restore", true, 2, 0]);

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
        assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME}`, "--class", "normal"]);
    });

    test("quem ja estava em HIGH fica como estava; a classe de antes e a que volta", async t => {
        const procs = helperAnswers(t, { before: pid => (pid === String(ME) ? "ABOVE_NORMAL" : "HIGH") });
        const up = await setGpuPriorityMain("high");
        assert.deepEqual([up.ok, up.raised], [true, 1]);
        await setGpuPriorityMain("restore");
        assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME}`, "--class", "above_normal"]);
    });

    test("dois processos com classes diferentes antes: um helper por classe na volta", async t => {
        const procs = helperAnswers(t, { before: pid => (pid === String(ME) ? "BELOW_NORMAL" : "IDLE") });
        await setGpuPriorityMain("high");
        const down = await setGpuPriorityMain("restore");
        assert.deepEqual(procs.spawned.slice(1).map(p => p.args[3]).sort(), ["below_normal", "idle"]);
        assert.deepEqual([down.ok, down.done, down.targets.length, down.hags], [true, 2, 2, "on"]);
    });

    test("subir duas vezes (trocar de fonte) nao esquece a classe de antes", async t => {
        let call = 0;
        const procs = helperAnswers(t, { before: () => (call++ < 2 ? "NORMAL" : "HIGH") });
        await setGpuPriorityMain("high");
        const second = await setGpuPriorityMain("high");
        assert.deepEqual([second.ok, second.raised], [true, 2]);
        await setGpuPriorityMain("restore");
        assert.equal(procs.spawned[2].args[3], "normal");
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
        app.appMetrics = [null, { pid: ME, type: "GPU" }, { pid: 0, type: "GPU" }, { pid: 1.5, type: "GPU" }, { pid: 777, type: "Utility" }];
        await setGpuPriorityMain("high");
        assert.equal(procs.spawned[0].args[1], `${ME}`);
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
            { stdout: `hags off\nok pid=999 before=NORMAL after=HIGH\nerror set 0xC0000061 pid=999 x\nerror tree 0x80070005 pid=${GPU}\nok pid=${ME} before=NORMAL after=HIGH\n`, code: 6 },
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
            ["hags on", ok(ME, "HIGH", "HIGH"), ok(NEW_GPU, "NORMAL", "HIGH")],
            ["hags on", ok(NEW_GPU, "HIGH", "NORMAL")],
            ["hags on", ok(ME, "HIGH", "ABOVE_NORMAL")]
        );
        await setGpuPriorityMain("high");
        const down = await setGpuPriorityMain("restore");
        assert.deepEqual([down.raised, down.done], [2, 0], "uma chamada por classe: ABOVE_NORMAL e NORMAL, as duas falharam");
        app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: NEW_GPU, type: "GPU" }];
        const up = await setGpuPriorityMain("high");
        assert.deepEqual(procs.spawned.slice(3, 5).map(p => p.args), [
            ["--gpu-priority", `${GPU}`, "--class", "normal"],
            ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "high"]
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
            assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "high"]);
            const down = await setGpuPriorityMain("restore");
            assert.equal(down.notes.length, 1);
            assert.match(down.notes[0], new RegExp(`^o processo da GPU do Discord reiniciou às \\d\\d:\\d\\d:\\d\\d UTC \\(${GPU} → ${NEW_GPU}\\): alta de novo$`));
            assert.deepEqual(procs.spawned[2].args, ["--gpu-priority", `${ME},${NEW_GPU}`, "--class", "normal"], "o antigo nao esta mais na volta");
            assert.deepEqual((await setGpuPriorityMain("restore")).notes, [], "a nota sai uma vez so");
        });

        test("o Windows deu o pid antigo ao processo novo: vale o que nasceu depois da queda (creationTime)", async t => {
            const clock = useFakeClock(t);
            const procs = helperAnswers(t);
            await setGpuPriorityMain("high");
            const crashedAt = clock.epoch();
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: GPU, type: "GPU", creationTime: crashedAt - 3_600_000 }];
            gone();
            await after(clock, 2000); // ainda o antigo (nasceu bem antes da queda)
            assert.equal(procs.spawned.length, 1);
            app.appMetrics = [{ pid: ME, type: "Browser" }, { pid: GPU, type: "GPU", creationTime: crashedAt - 1000 }];
            await after(clock, 2000);
            assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME},${GPU}`, "--class", "high"]);
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
            assert.deepEqual(procs.spawned[1].args, ["--gpu-priority", `${ME}`, "--class", "normal"]);
        });

        test("o novo nao sobe (o Windows recusa, ou o helper sumiu): a nota diz por que", async t => {
            const clock = useFakeClock(t);
            const host = helperHost(t);
            const answers = [
                ["hags on", ok(ME, "NORMAL", "HIGH"), ok(GPU, "NORMAL", "HIGH")],
                ["hags on", ok(ME, "HIGH", "HIGH"), `error open 0x80070005 pid=${NEW_GPU} Acesso negado.`]
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
