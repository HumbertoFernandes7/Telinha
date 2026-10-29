/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da busca do PID dono de uma janela (nativeWindowPid.ts): a leitura do id `window:<HWND>:<n>` e o que sai do
// PowerShell (linha `TELINHA|pid|uwp|nome`), tudo com mockSpawn no lugar do child_process.spawn: o PowerShell de
// verdade nunca roda aqui (a busca real das janelas e o EnumWindows ficam para a mao, ver README dos testes).
// Rodar:  pnpm test:file src/plugins/telinha/nativeWindowPid.test.ts

import assert from "node:assert/strict";
import { describe, test,type TestContext } from "node:test";

import { mockSpawn } from "@test/fakes/childProcess";
import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { answer, feed, powershellHost, setPlatform } from "@test/helpers/wpd-audio";

import { getWindowProcessInfo, parseWindowSourceId } from "./nativeWindowPid";

const WINDOW = "window:1234:0";

/** Troca uma variavel de ambiente ate o fim do teste (undefined = remove). */
function setEnv(t: TestContext, name: string, value: string | undefined) {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
    });
}

/** Uma busca: o PowerShell responde `stdout` e sai com `code`. */
async function lookup(t: TestContext, stdout: string, code: number | null = 0) {
    powershellHost(t, { stdout, code });
    return getWindowProcessInfo(WINDOW);
}

describe("parseWindowSourceId", () => {
    test("le o HWND de window:<HWND>:<n>", () => {
        assert.equal(parseWindowSourceId("window:1234:0"), 1234n);
        assert.equal(parseWindowSourceId("window:65538:7"), 65538n);
        assert.equal(parseWindowSourceId("window:007:0"), 7n, "zeros a esquerda");
    });

    test("o maior HWND de 64 bits passa; um a mais, nao", () => {
        assert.equal(parseWindowSourceId("window:18446744073709551615:0"), 18446744073709551615n);
        assert.equal(parseWindowSourceId("window:18446744073709551616:0"), null);
        assert.equal(parseWindowSourceId("window:123456789012345678901:0"), null, "21 digitos nem passam do regex");
    });

    test("telas, zero, formatos quebrados e valores que nao sao texto viram null", () => {
        for (const bad of ["screen:0:0", "window:0:0", "window:0000:0", "window:12:", "window:12", "window::0", "window:-5:0", "window:1a:0", "window:12:x",
            "window:12:3:4", " window:12:0", "window:12:0 ", "WINDOW:12:0", "", "window:1';calc;':0"]) {
            assert.equal(parseWindowSourceId(bad), null, JSON.stringify(bad));
        }
        for (const notText of [undefined, null, 1234, {}, ["window:1:0"]]) {
            assert.equal(parseWindowSourceId(notText as unknown as string), null, String(notText));
        }
    });
});

describe("getWindowProcessInfo: o que e executado", () => {
    test("fora do Windows nao executa nada e devolve null", async t => {
        setPlatform(t, "linux");
        const procs = mockSpawn(t);
        assert.equal(await getWindowProcessInfo(WINDOW), null);
        assert.equal(procs.spawned.length, 0);
    });

    test("id invalido nao chega a abrir o PowerShell", async t => {
        setPlatform(t, "win32");
        const procs = mockSpawn(t);
        for (const bad of ["screen:0:0", "window:0:0", "window:1';calc;':0", undefined as unknown as string]) {
            assert.equal(await getWindowProcessInfo(bad), null);
        }
        assert.equal(procs.spawned.length, 0);
    });

    test("abre o powershell.exe do SystemRoot, escondido, sem stdin/stderr, com o script em -EncodedCommand (UTF-16LE base64)", async t => {
        setEnv(t, "SystemRoot", "C:\\Windows");
        const procs = powershellHost(t, { stdout: "TELINHA|4321|0|chrome\r\n" });
        await getWindowProcessInfo(WINDOW);
        const [proc] = procs.spawned;
        assert.equal(proc.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        assert.deepEqual(proc.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
        assert.equal(proc.args.length, 6);
        assert.deepEqual(proc.options, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

        const script = Buffer.from(proc.args[5], "base64").toString("utf16le");
        assert.match(script, /\$hwnd = \[uint64\]::Parse\('1234'\)/);
        assert.match(script, /Add-Type -TypeDefinition @'/);
        assert.match(script, /\[TelinhaWin\]::OwnerPid\(\$hwnd\)/);
        assert.match(script, /if \(\$ownerPid -eq 0\) \{ exit 3 \}/, "janela que nao existe: saida 3");
        assert.match(script, /\[Console\]::Out\.WriteLine\('TELINHA\|'/);
        assert.match(script, /ApplicationFrameHost/);
    });

    test("o HWND vai para o script so como digitos, mesmo o maior de 64 bits", async t => {
        const procs = powershellHost(t, { stdout: "TELINHA|1|0|x" });
        await getWindowProcessInfo("window:18446744073709551615:0");
        const script = Buffer.from(procs.spawned[0].args[5], "base64").toString("utf16le");
        assert.match(script, /\[uint64\]::Parse\('18446744073709551615'\)/);
    });

    test("sem SystemRoot usa o windir; sem nenhum dos dois, o powershell.exe do PATH", async t => {
        setEnv(t, "SystemRoot", undefined);
        setEnv(t, "windir", "D:\\Win");
        const procs = powershellHost(t, { stdout: "TELINHA|1|0|x" });
        await getWindowProcessInfo(WINDOW);
        assert.equal(procs.spawned[0].command, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");

        delete process.env.windir; // o setEnv de cima devolve o valor original no fim do teste
        await getWindowProcessInfo(WINDOW);
        assert.equal(procs.spawned[1].command, "powershell.exe");
    });
});

describe("getWindowProcessInfo: a resposta do PowerShell", () => {
    test("`TELINHA|pid|0|nome`: processo comum", async t => {
        assert.deepEqual(await lookup(t, "TELINHA|4321|0|chrome\r\n"), { pid: 4321, processName: "chrome", isUwpFrameHost: false });
    });

    test("`TELINHA|pid|1|nome`: app UWP (o PID e o do app real, que o script ja trocou)", async t => {
        assert.deepEqual(await lookup(t, "TELINHA|777|1|Calculator\n"), { pid: 777, processName: "Calculator", isUwpFrameHost: true });
    });

    test("ruido antes e depois da linha (avisos, linhas em branco) nao atrapalha; o nome e aparado", async t => {
        const out = "WARNING: algo\r\n\r\nTELINHA|55|0|  Meu App  \r\nmais lixo\r\n";
        assert.deepEqual(await lookup(t, out), { pid: 55, processName: "Meu App", isUwpFrameHost: false });
    });

    test("nome com acento (UTF-8) e nome vazio", async t => {
        powershellHost(t, { stdout: "TELINHA|9|0|Música\n" }, { stdout: "TELINHA|9|1|\n" });
        assert.deepEqual(await getWindowProcessInfo(WINDOW), { pid: 9, processName: "Música", isUwpFrameHost: false });
        assert.deepEqual(await getWindowProcessInfo(WINDOW), { pid: 9, processName: "", isUwpFrameHost: true });
    });

    test("a linha chega em pedacos (varios 'data')", async t => {
        setPlatform(t, "win32");
        mockSpawn(t, p => setImmediate(async () => {
            await feed(p, "TELINHA|43");
            await feed(p, "21|0|chr");
            await feed(p, "ome\n");
            p.exit(0);
        }));
        assert.deepEqual(await getWindowProcessInfo(WINDOW), { pid: 4321, processName: "chrome", isUwpFrameHost: false });
    });

    test("sem a linha TELINHA, saida vazia ou PID invalido: null", async t => {
        const bad = ["nada util\n", "", "TELINHA|0|0|x\n", "TELINHA|99999999999999999999|0|x\n", "TELINHA|abc|0|x\n", "TELINHA|12|2|x\n", "TELINHA|12|0\n"];
        powershellHost(t, ...bad.map(stdout => ({ stdout })));
        for (const out of bad) assert.equal(await getWindowProcessInfo(WINDOW), null, JSON.stringify(out));
    });

    test("saida diferente de 0 (3 = janela nao existe, 1 = erro do script): null, mesmo com texto no stdout", async t => {
        powershellHost(t, { stdout: "", code: 3 }, { stdout: "TELINHA|4321|0|chrome\n", code: 1 }, { stdout: "", code: null });
        for (let i = 0; i < 3; i++) assert.equal(await getWindowProcessInfo(WINDOW), null, `chamada ${i}`);
    });

    test("so os primeiros 64 KB da saida sao guardados: a linha dentro do primeiro pedaco vale", async t => {
        setPlatform(t, "win32");
        mockSpawn(t, p => setImmediate(async () => {
            await feed(p, "TELINHA|5|0|cedo\n" + "x".repeat(70_000));
            await feed(p, "TELINHA|6|0|tarde\n");
            p.exit(0);
        }));
        assert.deepEqual(await getWindowProcessInfo(WINDOW), { pid: 5, processName: "cedo", isUwpFrameHost: false });
    });

    test("so os primeiros 64 KB da saida sao guardados: a linha que vem depois do corte nao conta", async t => {
        setPlatform(t, "win32");
        mockSpawn(t, p => setImmediate(async () => {
            await feed(p, "y".repeat(70_000));
            await feed(p, "TELINHA|6|0|tarde\n");
            p.exit(0);
        }));
        assert.equal(await getWindowProcessInfo(WINDOW), null);
    });
});

describe("getWindowProcessInfo: falhas do processo", () => {
    test("'error' ao abrir (ENOENT, bloqueado pelo antivirus): null", async t => {
        setPlatform(t, "win32");
        mockSpawn(t, p => setImmediate(() => p.fail(Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }))));
        assert.equal(await getWindowProcessInfo(WINDOW), null);
    });

    test("spawn que lanca na hora: null, sem excecao", async t => {
        setPlatform(t, "win32");
        mockSpawn(t, () => {
            throw new Error("EPERM");
        });
        assert.equal(await getWindowProcessInfo(WINDOW), null);
    });

    test("PowerShell que trava: depois de 5 s mata o processo e devolve null; uma saida tardia nao muda nada", async t => {
        setPlatform(t, "win32");
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const lookupPromise = getWindowProcessInfo(WINDOW);
        clock.tick(4999);
        await flushPromises();
        assert.equal(procs.spawned[0].killed, false);
        clock.tick(1);
        assert.equal(await lookupPromise, null);
        assert.equal(procs.spawned[0].killed, true);

        procs.spawned[0].writeStdout("TELINHA|1|0|tarde\n");
        procs.spawned[0].exit(0);
        await flushPromises();
    });

    test("kill que lanca no timeout tambem resulta em null", async t => {
        setPlatform(t, "win32");
        const clock = useFakeClock(t);
        mockSpawn(t, p => {
            p.kill = () => {
                throw new Error("EPERM");
            };
        });
        const lookupPromise = getWindowProcessInfo(WINDOW);
        clock.tick(5000);
        assert.equal(await lookupPromise, null);
    });

    test("resposta dentro do prazo: o timer e cancelado (nada dispara depois)", async t => {
        setPlatform(t, "win32");
        const clock = useFakeClock(t);
        const procs = mockSpawn(t, p => answer(p, { stdout: "TELINHA|8|0|ok\n" }));
        const info = await getWindowProcessInfo(WINDOW);
        assert.equal(info?.pid, 8);
        clock.tick(10_000);
        assert.equal(procs.spawned[0].killed, false);
    });
});
