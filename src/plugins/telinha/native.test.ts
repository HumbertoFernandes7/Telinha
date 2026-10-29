/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do native.ts (processo main do Electron) com o `electron` e o `@main/csp` falsos de test/fakes: a lista de
// fontes do desktopCapturer, o ciclo prepareDisplayMedia -> handler de display media -> finishDisplayMedia (validade
// de 15 s do pedido, decisao de audio da janela pelo PID, espera de 6 s, callback que lanca) e os natives do audio da
// tela inteira. O PowerShell e o telinha-audio.exe sao falsos (mockSpawn); o Electron e o Windows de verdade ficam para
// a mao (addon/REAL-TEST.md).
// Rodar:  pnpm test:file src/plugins/telinha/native.test.ts

import assert from "node:assert/strict";
import { describe, test,type TestContext } from "node:test";

import { mockSpawn } from "@test/fakes/childProcess";
import { eventually, flushPromises, useFakeClock } from "@test/fakes/clock";
import { desktopCapturer, FakeSession, fakeSource, ipcEvent } from "@test/fakes/electron";
import { ConnectSrc, CspPolicies } from "@test/fakes/vencord/main/csp";
import { feed, feedErr, helperHost, pcm, powershellHost, setPlatform } from "@test/helpers/wpd-audio";

import {
    finishDisplayMedia,
    listSources,
    prepareDisplayMedia,
    readScreenAudio,
    resetDisplayMedia,
    screenAudioStatus,
    startScreenAudio,
    stopScreenAudio
} from "./native";
import { RELAY_URLS } from "./protocol";

const SCREEN = "screen:0:0";
const WINDOW = "window:1234:0";

/** Uma sessao do Electron de mentira; o fim do teste limpa o estado global do native.ts. */
function newSession(t: TestContext) {
    const session = new FakeSession();
    t.after(() => resetDisplayMedia(ipcEvent(session)));
    return session;
}

type Streams = { video?: { id: string; name: string; }; audio?: string; };

describe("CSP no carregamento do modulo", () => {
    test("libera so os relays do Trystero (connect-src), mesmo com o plugin desligado", () => {
        assert.deepEqual(Object.keys(CspPolicies), [...RELAY_URLS]);
        for (const url of RELAY_URLS) {
            assert.ok(url.startsWith("wss://"), url);
            assert.equal(CspPolicies[url], ConnectSrc);
        }
    });
});

describe("listSources", () => {
    test("pede telas e janelas, sem icones, com a miniatura pedida (320x180 por padrao)", async () => {
        desktopCapturer.reset();
        await listSources(ipcEvent(), 320, 180);
        assert.deepEqual(desktopCapturer.calls[0], { types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    });

    test("o tamanho da miniatura e limitado (16x9 a 640x360), arredondado, e valores invalidos viram 320x180", async () => {
        const cases: [unknown, unknown, number, number][] = [
            [1, 1, 16, 9],
            [9999, 9999, 640, 360],
            [100.6, 50.4, 101, 50],
            [0, 0, 320, 180],
            [Number.NaN, Number.NaN, 320, 180],
            [undefined, undefined, 320, 180],
            ["abc", "abc", 320, 180],
            [-5, -5, 16, 9],
            ["200", "100", 200, 100]
        ];
        for (const [w, h, wantW, wantH] of cases) {
            desktopCapturer.reset();
            await listSources(ipcEvent(), w as number, h as number);
            assert.deepEqual(desktopCapturer.calls[0], { types: ["screen", "window"], thumbnailSize: { width: wantW, height: wantH }, fetchWindowIcons: false }, `${String(w)}x${String(h)}`);
        }
    });

    test("devolve id, nome, tipo e a miniatura em JPEG base64; miniatura vazia ou ausente fica sem thumbnail", async () => {
        desktopCapturer.reset();
        desktopCapturer.sources = [
            fakeSource(SCREEN, "Tela 1"),
            fakeSource(WINDOW, "Jogo"),
            fakeSource("window:77:0", "Sem miniatura", null),
            { ...fakeSource("screen:1:0", "Tela 2"), thumbnail: undefined as never }
        ];
        const { sources, error } = await listSources(ipcEvent(), 320, 180);
        assert.equal(error, undefined);
        assert.deepEqual(sources.map(s => [s.id, s.name, s.kind]), [
            [SCREEN, "Tela 1", "screen"],
            [WINDOW, "Jogo", "window"],
            ["window:77:0", "Sem miniatura", "window"],
            ["screen:1:0", "Tela 2", "screen"]
        ]);
        assert.equal(sources[0].thumbnail, "data:image/jpeg;base64," + Buffer.from(`jpeg:${SCREEN}`).toString("base64"));
        assert.equal(sources[1].thumbnail, "data:image/jpeg;base64," + Buffer.from(`jpeg:${WINDOW}`).toString("base64"));
        assert.equal(sources[2].thumbnail, undefined);
        assert.equal(sources[3].thumbnail, undefined);
    });

    test("ids fora do formato (screen|window:<n>:<n>) e fontes sem nome sao descartados; ids negativos passam", async () => {
        desktopCapturer.reset();
        desktopCapturer.sources = [
            fakeSource("screen:abc:0", "id ruim"),
            fakeSource("window:12:3:4", "id com 4 partes"),
            fakeSource("foo:1:1", "tipo desconhecido"),
            fakeSource("window:123456789012345678901:0", "hwnd de 21 digitos"),
            fakeSource("screen:0:12345678901", "terceiro campo grande"),
            fakeSource("window:5:0", ""),
            fakeSource("screen:-1:-2", "Monitor negativo"),
            fakeSource("window:99:0", "Valida")
        ];
        const { sources } = await listSources(ipcEvent(), 320, 180);
        assert.deepEqual(sources.map(s => s.id), ["screen:-1:-2", "window:99:0"]);
    });

    test("sem fontes: lista vazia sem erro", async () => {
        desktopCapturer.reset();
        desktopCapturer.sources = [];
        assert.deepEqual(await listSources(ipcEvent(), 320, 180), { sources: [] });
    });

    test("o desktopCapturer falha (rejeita ou lanca texto): lista vazia e o erro em texto, sem rejeitar", async () => {
        desktopCapturer.reset();
        desktopCapturer.getSourcesImpl = async () => {
            throw new Error("Failed to get sources");
        };
        assert.deepEqual(await listSources(ipcEvent(), 320, 180), { sources: [], error: "Error: Failed to get sources" });
        desktopCapturer.getSourcesImpl = () => Promise.reject("sem permissao");
        assert.deepEqual(await listSources(ipcEvent(), 320, 180), { sources: [], error: "sem permissao" });
        desktopCapturer.reset();
    });
});

describe("prepareDisplayMedia", () => {
    test("id de fonte invalido lanca e nao instala handler", t => {
        const session = newSession(t);
        for (const bad of ["", "screen:0", "window:1:2:3", "desktop:1:1", "screen:a:b", 5, undefined, null, { id: SCREEN }]) {
            assert.throws(() => prepareDisplayMedia(ipcEvent(session), bad as string, "Nome", false), /Id de fonte inválido/, String(bad));
        }
        assert.throws(() => prepareDisplayMedia(ipcEvent(session), "x", "n", false), { message: "Id de fonte inválido: x" });
        assert.equal(session.handler, null);
        assert.equal(session.handlerHistory.length, 0);
    });

    test("instala o handler na sessao de quem chamou e o reinstala a cada pedido (outro plugin pode ter trocado)", t => {
        const session = newSession(t);
        assert.equal(prepareDisplayMedia(ipcEvent(session), SCREEN, "Tela", false), true);
        const first = session.handler;
        assert.equal(typeof first, "function");
        // outro plugin pegou o lugar do handler
        session.setDisplayMediaRequestHandler(() => undefined);
        assert.equal(prepareDisplayMedia(ipcEvent(session), SCREEN, "Tela", false), true);
        assert.notEqual(session.handler, first);
        assert.equal(session.handlerHistory.length, 3);
    });
});

describe("handler de display media", () => {
    test("tela inteira: entrega o video escolhido e nunca audio (o audio da tela vem do helper)", async t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela 1", true);
        const result = await session.requestDisplayMedia({ audioRequested: true });
        assert.deepEqual(result?.streams, { video: { id: SCREEN, name: "Tela 1" } });
        assert.deepEqual(finishDisplayMedia(ev), {
            handlerCalled: true,
            audioRequested: true,
            audio: null,
            error: null
        });
    });

    test("finishDisplayMedia entrega o relatorio uma vez, remove o handler e some o pedido", async t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        await session.requestDisplayMedia();
        assert.equal(finishDisplayMedia(ev)?.audioRequested, false);
        assert.equal(session.handler, null);
        assert.equal(session.handlerHistory.length, 2, "instalado e depois removido");
        assert.equal(finishDisplayMedia(ev), null, "ja entregue");
    });

    test("finishDisplayMedia sem nenhum getDisplayMedia no meio: relatorio nulo e handler removido", t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        assert.equal(finishDisplayMedia(ev), null);
        assert.equal(session.handler, null);
    });

    test("preparar de novo zera o relatorio do pedido anterior", async t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        await session.requestDisplayMedia();
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        assert.equal(finishDisplayMedia(ev), null);
    });

    test("o nome da fonte: vazio, ausente ou nao-texto viram o id; acima de 200 caracteres e cortado", async t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        for (const [name, expected] of [["", SCREEN], [undefined, SCREEN], [42, SCREEN], ["n".repeat(250), "n".repeat(200)], ["Minha tela", "Minha tela"]] as const) {
            prepareDisplayMedia(ev, SCREEN, name as unknown as string, false);
            const result = await session.requestDisplayMedia();
            assert.equal((result?.streams as Streams).video?.name, expected, String(name).slice(0, 20));
        }
    });

    test("sem pedido preparado (um segundo getDisplayMedia, ou o de outro plugin): recusa e registra o motivo", async t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        await session.requestDisplayMedia();
        const second = await session.requestDisplayMedia();
        assert.deepEqual(second?.streams, {}, "callback({}) recusa; o TypeError sincrono do Electron e engolido");
        assert.equal(finishDisplayMedia(ev)?.error, "nenhum pedido preparado pelo Telinha");
    });

    test("o pedido vale 15 s: com 15000 ms ainda serve, com 15001 ms expirou", async t => {
        const clock = useFakeClock(t);
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        clock.tick(15_000);
        const ok = await session.requestDisplayMedia();
        assert.deepEqual(ok?.streams, { video: { id: SCREEN, name: "Tela" } });
        assert.equal(finishDisplayMedia(ev)?.error, null);

        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        clock.tick(15_001);
        const expired = await session.requestDisplayMedia();
        assert.deepEqual(expired?.streams, {});
        assert.equal(finishDisplayMedia(ev)?.error, "pedido preparado expirou");
    });

    test("callback() que lanca com um stream valido: o erro vai para o relatorio, sem escapar no main", async t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        await session.handler!({ audioRequested: false, videoRequested: true }, () => {
            throw new Error("callback quebrou");
        });
        assert.equal(finishDisplayMedia(ev)?.error, "callback() lançou: Error: callback quebrou");
    });

    test("callback() que lanca um valor que nao e Error: vai como texto", async t => {
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        await session.handler!({}, () => {
            throw "texto solto";
        });
        assert.equal(finishDisplayMedia(ev)?.error, "callback() lançou: texto solto");
    });

    test("a mesma limpeza vale para duas sessoes: finish remove o handler das duas; remocao que lanca e engolida", async t => {
        class BrokenSession extends FakeSession {
            override setDisplayMediaRequestHandler(handler: Parameters<FakeSession["setDisplayMediaRequestHandler"]>[0]) {
                if (handler === null) throw new Error("sessao destruida");
                super.setDisplayMediaRequestHandler(handler);
            }
        }
        const a = new FakeSession();
        const broken = new BrokenSession();
        t.after(() => resetDisplayMedia(ipcEvent(a)));
        prepareDisplayMedia(ipcEvent(a), SCREEN, "Tela", false);
        prepareDisplayMedia(ipcEvent(broken), SCREEN, "Tela", false);
        assert.equal(typeof a.handler, "function");
        assert.equal(typeof broken.handler, "function");
        finishDisplayMedia(ipcEvent(a));
        assert.equal(a.handler, null, "uma sessao quebrada nao impede de limpar a outra");
    });
});

describe("audio da janela (decisao pelo PID)", () => {
    // [saida do PowerShell, codigo, device esperado, motivo esperado]
    const cases: [string, string, number, string | null, string][] = [
        ["processo comum", "TELINHA|4321|0|chrome\r\n", 0, "applicationLoopback:4321", "áudio só do processo chrome"],
        ["app UWP com o processo real achado", "TELINHA|99|1|Calculator\r\n", 0, "applicationLoopback:99", "áudio só do processo Calculator (app UWP)"],
        ["app UWP que ficou no ApplicationFrameHost", "TELINHA|99|1|ApplicationFrameHost\r\n", 0, null, "app UWP cujo processo real não foi identificado; transmitindo sem áudio"],
        ["ApplicationFrameHost em outra caixa", "TELINHA|99|1|applicationframehost\r\n", 0, null, "app UWP cujo processo real não foi identificado; transmitindo sem áudio"],
        ["ApplicationFrameHost sem o flag UWP e um processo qualquer", "TELINHA|99|0|ApplicationFrameHost\r\n", 0, "applicationLoopback:99", "áudio só do processo ApplicationFrameHost"],
        ["a janela e do Discord (nome)", "TELINHA|123|0|Discord\r\n", 0, null, "janela do próprio Discord: o áudio incluiria as vozes da call; transmitindo sem áudio"],
        ["a janela e do Discord PTB (nome)", "TELINHA|123|0|DiscordPTB\r\n", 0, null, "janela do próprio Discord: o áudio incluiria as vozes da call; transmitindo sem áudio"],
        ["a janela e do proprio processo main (PID)", `TELINHA|${process.pid}|0|node\r\n`, 0, null, "janela do próprio Discord: o áudio incluiria as vozes da call; transmitindo sem áudio"],
        ["PID acima de 32 bits", "TELINHA|4294967296|0|big\r\n", 0, null, "PID inválido (4294967296); transmitindo sem áudio"],
        ["PID no limite de 32 bits", "TELINHA|4294967295|0|max\r\n", 0, "applicationLoopback:4294967295", "áudio só do processo max"],
        ["a janela nao existe mais (saida 3)", "", 3, null, "processo da janela não encontrado; transmitindo sem áudio"],
        ["saida sem a linha esperada", "lixo\r\n", 0, null, "processo da janela não encontrado; transmitindo sem áudio"]
    ];

    for (const [title, stdout, code, device, reason] of cases) {
        test(`janela com audio pedido: ${title}`, async t => {
            powershellHost(t, { stdout, code });
            const session = newSession(t);
            const ev = ipcEvent(session);
            prepareDisplayMedia(ev, WINDOW, "Janela", true);
            const result = await session.requestDisplayMedia({ audioRequested: true });
            const expected: Streams = { video: { id: WINDOW, name: "Janela" } };
            if (device) expected.audio = device;
            assert.deepEqual(result?.streams, expected);
            assert.deepEqual(finishDisplayMedia(ev), { handlerCalled: true, audioRequested: true, audio: { device, reason }, error: null });
        });
    }

    test("o Chromium nao pediu audio (audioRequested false): a busca do PID corre mas o resultado nao e usado", async t => {
        const procs = powershellHost(t, { stdout: "TELINHA|4321|0|chrome\r\n" });
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, WINDOW, "Janela", true);
        const result = await session.requestDisplayMedia({ audioRequested: false });
        assert.deepEqual(result?.streams, { video: { id: WINDOW, name: "Janela" } });
        assert.deepEqual(finishDisplayMedia(ev), { handlerCalled: true, audioRequested: false, audio: null, error: null });
        assert.equal(procs.spawned.length, 1, "a busca comecou ja no prepare, em paralelo");
        // deixa a busca solta terminar (o timer de 5 s do PowerShell so some quando o processo fecha)
        await eventually(() => procs.spawned[0].exitCode !== null);
        await flushPromises();
        await flushPromises();
    });

    test("o Telinha nao quer audio (wantAudio diferente de true): nem procura o processo da janela", async t => {
        const procs = powershellHost(t, { stdout: "TELINHA|4321|0|chrome\r\n" });
        const session = newSession(t);
        const ev = ipcEvent(session);
        for (const want of [false, "sim", 1, undefined]) {
            prepareDisplayMedia(ev, WINDOW, "Janela", want as boolean);
            const result = await session.requestDisplayMedia({ audioRequested: true });
            assert.deepEqual(result?.streams, { video: { id: WINDOW, name: "Janela" } }, String(want));
            assert.equal(finishDisplayMedia(ev)?.audio, null);
        }
        assert.equal(procs.spawned.length, 0);
    });

    test("o PowerShell trava e passa de 5 s: a busca devolve null e segue sem audio ('processo da janela nao encontrado')", async t => {
        setPlatform(t, "win32");
        const clock = useFakeClock(t);
        const hung = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, WINDOW, "Janela", true);
        const request = session.requestDisplayMedia({ audioRequested: true });
        await clock.tickAsync(5000, 1000);
        const result = await request;
        assert.deepEqual(result?.streams, { video: { id: WINDOW, name: "Janela" } });
        assert.equal(finishDisplayMedia(ev)?.audio?.reason, "processo da janela não encontrado; transmitindo sem áudio");
        assert.equal(hung.spawned[0].killed, true);
    });

    test("a busca do PID nao volta em 6 s: segue sem audio ('demorou demais')", async t => {
        setPlatform(t, "win32");
        const clock = useFakeClock(t);
        const hung = mockSpawn(t, p => {
            p.exitOnKill = false;
        });
        const session = newSession(t);
        const ev = ipcEvent(session);
        prepareDisplayMedia(ev, WINDOW, "Janela", true);
        const request = session.requestDisplayMedia({ audioRequested: true });
        // os dois prazos (5 s do PowerShell e 6 s da espera) vencem no mesmo tick: vale o da espera
        clock.tick(6000);
        const result = await request;
        assert.deepEqual(result?.streams, { video: { id: WINDOW, name: "Janela" } });
        assert.deepEqual(finishDisplayMedia(ev)?.audio, { device: null, reason: "busca do processo da janela demorou demais; transmitindo sem áudio" });
        assert.equal(hung.spawned.length, 1);
    });
});

describe("resetDisplayMedia", () => {
    test("limpa pedido, relatorio e handler e para a captura de audio da tela inteira", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const session = newSession(t);
        const ev = ipcEvent(session);

        const starting = startScreenAudio(ev);
        const [proc] = procs.spawned;
        await feedErr(proc, "ready 48000 2\n");
        const started = await starting;
        assert.equal(started.ok, true);
        const id = started.ok ? started.id : -1;

        prepareDisplayMedia(ev, SCREEN, "Tela", false);
        await session.requestDisplayMedia();
        resetDisplayMedia(ev);

        assert.equal(session.handler, null);
        assert.equal(finishDisplayMedia(ev), null, "o relatorio foi descartado");
        assert.deepEqual(await readScreenAudio(ev, id, 0), { pcm: null, ended: true, reason: "a captura de áudio já foi encerrada" });
        await flushPromises();
        assert.equal(proc.stdinEnded, true, "o helper recebeu o pedido de parada");
        proc.exit(0);
    });

    test("sem nada para limpar: nao faz nada", t => {
        const session = newSession(t);
        assert.doesNotThrow(() => resetDisplayMedia(ipcEvent(session)));
        assert.doesNotThrow(() => resetDisplayMedia(ipcEvent(session)));
    });
});

describe("natives do audio da tela inteira (ponte para o screenAudioMain)", () => {
    test("screenAudioStatus: consulta o helper (probe)", async t => {
        helperHost(t);
        mockSpawn(t, p => setImmediate(() => p.exit(0)));
        assert.equal((await screenAudioStatus(ipcEvent())).available, true);
    });

    test("startScreenAudio exclui o proprio processo main (a arvore do Discord) e devolve o id", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const starting = startScreenAudio(ipcEvent());
        const [proc] = procs.spawned;
        assert.deepEqual(proc.args, ["--exclude", String(process.pid), "--parent", String(process.pid)]);
        await feedErr(proc, "ready 48000 2\n");
        const started = await starting;
        assert.equal(started.ok, true);
        stopScreenAudio(ipcEvent());
        proc.exit(0);
    });

    test("readScreenAudio converte id e espera para numero (o IPC pode mandar qualquer coisa)", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const starting = startScreenAudio(ipcEvent());
        const [proc] = procs.spawned;
        await feedErr(proc, "ready 48000 2\n");
        const started = await starting;
        const id = started.ok ? started.id : -1;
        await feed(proc, pcm(3));
        const read = await readScreenAudio(ipcEvent(), String(id) as unknown as number, "0" as unknown as number);
        assert.equal(read.pcm?.byteLength, 24);
        assert.equal(read.ended, false);
        assert.deepEqual(await readScreenAudio(ipcEvent(), "abc" as unknown as number, 0), { pcm: null, ended: true, reason: "a captura de áudio já foi encerrada" });
        stopScreenAudio(ipcEvent());
        proc.exit(0);
    });

    test("stopScreenAudio com id numerico para so aquela captura; sem id (ou nao numerico) para a que estiver rodando", async t => {
        helperHost(t);
        const procs = mockSpawn(t);
        const starting = startScreenAudio(ipcEvent());
        const [proc] = procs.spawned;
        await feedErr(proc, "ready 48000 2\n");
        const started = await starting;
        const id = started.ok ? started.id : -1;

        stopScreenAudio(ipcEvent(), id + 100);
        await flushPromises();
        assert.equal(proc.stdinEnded, false, "id de outra captura: nada acontece");

        stopScreenAudio(ipcEvent(), "nao-e-numero" as unknown as number);
        await flushPromises();
        assert.equal(proc.stdinEnded, true, "id nao numerico vira 'qualquer uma'");
        proc.exit(0);

        const again = startScreenAudio(ipcEvent());
        const second = procs.spawned[1];
        await feedErr(second, "ready 48000 2\n");
        const secondStart = await again;
        stopScreenAudio(ipcEvent(), secondStart.ok ? secondStart.id : -1);
        await flushPromises();
        assert.equal(second.stdinEnded, true);
        second.exit(0);
    });
});
