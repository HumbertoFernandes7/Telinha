/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do audio do PC sem o Discord pelo PipeWire (core/audio/screenAudioPipeWire.ts): o leitor do pw-dump --monitor,
// quais fluxos sao ligados ao no do Telinha (o Discord nunca) e o acompanhamento com pw-dump/pw-link de mentira
// (mockSpawn). O pw-record e a captura inteira ficam no screenAudioMain.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/audio/screenAudioPipeWire.test.ts

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type FakeChildProcess, mockSpawn } from "@test/fakes/childProcess";
import { flushPromises } from "@test/fakes/clock";

import { jsonArraySplitter, pipeWireExitReason, pipeWireSpawnReason, plannedLinks, type PwObject, pwRecordArgs, startPipeWireLinks } from "./screenAudioPipeWire";

const OWN = "telinha-screen-audio-1-1";

const node = (id: number, props: Record<string, unknown>): PwObject => ({ id, type: "PipeWire:Interface:Node", info: { props } });
const port = (id: number, nodeId: number, direction: "input" | "output", channel: string): PwObject =>
    ({ id, type: "PipeWire:Interface:Port", info: { direction, props: { "node.id": nodeId, "audio.channel": channel } } });
const stream = (id: number, props: Record<string, unknown> = {}) => node(id, { "media.class": "Stream/Output/Audio", "application.process.binary": "firefox", ...props });

/** O no do Telinha (10) com as entradas FL (11) e FR (12), como o pw-record abre. */
const own = () => [node(10, { "node.name": OWN, "media.class": "Stream/Input/Audio" }), port(11, 10, "input", "FL"), port(12, 10, "input", "FR")];
const firefox = () => [stream(20, { "application.name": "Firefox", "application.process.binary": "firefox-esr" }), port(21, 20, "output", "FL"), port(22, 20, "output", "FR")];
/** A voz da call no Flatpak do Discord (o "WEBRTC VoiceEngine" do discord_voice). */
const discordVoice = () => [
    stream(30, { "application.name": "WEBRTC VoiceEngine", "application.process.binary": "Discord", "pipewire.access.portal.app_id": "com.discordapp.Discord" }),
    port(31, 30, "output", "FL"), port(32, 30, "output", "FR")
];

/** O texto do pw-dump --monitor para um lote (arrays com indentacao, como ele escreve). */
const dumpText = (objects: unknown[]) => JSON.stringify(objects, null, 2) + "\n";

describe("pwRecordArgs", () => {
    test("PCM cru no stdout no formato do contrato, num no que nada liga sozinho e que manda silencio", () => {
        const args = pwRecordArgs(OWN);
        assert.deepEqual(args.slice(0, 10), ["--raw", "--target", "0", "--format", "f32", "--rate", "48000", "--channels", "2", "-P"]);
        assert.match(args[10], /node\.name = "telinha-screen-audio-1-1"/);
        assert.match(args[10], /node\.autoconnect = false/);
        assert.match(args[10], /node\.always-process = true/);
        assert.equal(args.at(-1), "-");
    });
});

describe("motivos em pt-BR", () => {
    test("ENOENT = faltam as ferramentas; outro erro diz o codigo; saida com e sem a linha do stderr; sinal", () => {
        assert.equal(pipeWireSpawnReason(Object.assign(new Error("x"), { code: "ENOENT" }), "pw-dump"),
            "as ferramentas do PipeWire (pw-record, pw-dump e pw-link) não estão instaladas (faltou o pw-dump)");
        assert.equal(pipeWireSpawnReason(Object.assign(new Error("negado"), { code: "EACCES" }), "pw-record"), "não foi possível abrir o pw-record: EACCES negado");
        assert.equal(pipeWireExitReason(255, null, "can't connect: Host is down"), "a captura de áudio do PipeWire parou (código 255 — can't connect: Host is down)");
        assert.equal(pipeWireExitReason(null, null, null), "a captura de áudio do PipeWire parou (código ?)");
        assert.equal(pipeWireExitReason(null, "SIGTERM", "x"), "a captura de áudio do PipeWire foi encerrada");
        assert.equal(pipeWireSpawnReason({} as NodeJS.ErrnoException, "pw-link"), "não foi possível abrir o pw-link:  [object Object]");
        assert.equal(pipeWireSpawnReason(undefined as unknown as NodeJS.ErrnoException, "pw-link"), "não foi possível abrir o pw-link:  undefined");
    });
});

describe("jsonArraySplitter", () => {
    test("arrays um atras do outro, partidos em qualquer ponto, com colchetes e aspas escapadas dentro de textos", () => {
        const a = [{ id: 1, info: { props: { "media.name": "Música [ao vivo] \"x\" \\ {" } } }];
        const b = [{ id: 2, info: null }];
        const text = dumpText(a) + dumpText(b) + "[]\n";
        for (let cut = 1; cut < text.length; cut += 7) {
            const split = jsonArraySplitter();
            assert.deepEqual([...split(text.slice(0, cut)), ...split(text.slice(cut))], [a, b, []], `corte em ${cut}`);
        }
    });

    test("nada completo ainda: nenhum array; JSON ruim lanca", () => {
        const split = jsonArraySplitter();
        assert.deepEqual(split("[\n  {\n"), []);
        assert.throws(() => jsonArraySplitter()("[ 1, ]"));
    });
});

describe("plannedLinks", () => {
    test("sem o no do Telinha com as duas entradas: null", () => {
        assert.equal(plannedLinks([...firefox()], OWN), null);
        assert.equal(plannedLinks([own()[0], own()[1], ...firefox()], OWN), null, "so a entrada FL");
        assert.equal(plannedLinks([...own(), ...firefox()], "outro-no"), null);
    });

    test("cada saida de cada fluxo que toca vai para a entrada do mesmo lado; o Discord nunca", () => {
        assert.deepEqual(plannedLinks([...own(), ...firefox(), ...discordVoice()], OWN), [[21, 11], [22, 12]]);
    });

    test("o Discord sai pelo binario, pelo nome do app ou pelo app id do Flatpak (qualquer caixa)", () => {
        for (const props of [{ "application.process.binary": "DiscordCanary" }, { "application.name": "discord" }, { "pipewire.access.portal.app_id": "com.discordapp.DiscordPTB" }]) {
            assert.deepEqual(plannedLinks([...own(), stream(40, props), port(41, 40, "output", "FL")], OWN), [], JSON.stringify(props));
        }
    });

    test("so fluxos de saida: alto-falantes, microfones, capturas e o proprio no ficam de fora", () => {
        const others = [
            node(50, { "media.class": "Audio/Sink" }), port(51, 50, "output", "FL"),
            node(52, { "media.class": "Audio/Source" }), port(53, 52, "output", "FL"),
            node(54, { "media.class": "Stream/Input/Audio" }), port(55, 54, "output", "FL"),
            port(56, 10, "output", "FL"), // monitor do proprio no
            port(57, 99, "output", "FL") // porta de um no que (ainda) nao apareceu
        ];
        assert.deepEqual(plannedLinks([...own(), ...others], OWN), []);
    });

    test("canais: mono e centro nos dois lados, traseiros e laterais no seu lado, LFE e desconhecidos de fora", () => {
        const s = stream(60);
        const ports = ["MONO", "FC", "RL", "SL", "RR", "SR", "LFE", "AUX0"].map((ch, i) => port(61 + i, 60, "output", ch));
        assert.deepEqual(plannedLinks([...own(), s, ...ports], OWN), [[61, 11], [61, 12], [62, 11], [62, 12], [63, 11], [64, 11], [65, 12], [66, 12]]);
    });

    test("fluxos de modulos do PipeWire (node.link-group) ficam de fora: re-tocam a mistura com a voz da call", () => {
        for (const name of ["echo-cancel-playback", "loopback-123-output", "effect_output.filter", "combine-stream"]) {
            const s = stream(80, { "node.name": name, "node.link-group": "loopback-123", "application.process.binary": "pipewire" });
            assert.deepEqual(plannedLinks([...own(), s, port(81, 80, "output", "FL")], OWN), [], name);
        }
        // o link-group sozinho basta, mesmo com um binario de aplicativo comum
        assert.deepEqual(plannedLinks([...own(), stream(82, { "node.link-group": "x" }), port(83, 82, "output", "FL")], OWN), []);
    });

    test("sem application.process.binary (ausente, vazio ou nao texto): fica de fora", () => {
        for (const binary of [undefined, "", "  ", 42]) {
            const s = node(84, { "media.class": "Stream/Output/Audio", "application.name": "mpv", "application.process.binary": binary });
            assert.deepEqual(plannedLinks([...own(), s, port(85, 84, "output", "FL")], OWN), [], String(binary));
        }
    });

    test("binario do proprio servidor de som (pipewire, pipewire-pulse, wireplumber): fica de fora", () => {
        for (const binary of ["pipewire", "pipewire-pulse", "wireplumber", "PipeWire-Pulse"]) {
            assert.deepEqual(plannedLinks([...own(), stream(86, { "application.process.binary": binary }), port(87, 86, "output", "FL")], OWN), [], binary);
        }
    });

    test("mixers conhecidos (easyeffects, pulseeffects, jamesdsp) ficam de fora por binario, nome do app ou node.name", () => {
        const cases: Record<string, unknown>[] = [
            { "application.process.binary": "easyeffects" },
            { "application.process.binary": "gst-launch", "node.name": "easyeffects_sink" },
            { "application.name": "PulseEffects" },
            { "node.name": "ee_soe_output_level", "application.process.binary": "JamesDSP" }
        ];
        for (const props of cases) assert.deepEqual(plannedLinks([...own(), stream(88, props), port(89, 88, "output", "FL")], OWN), [], JSON.stringify(props));
    });

    test("o processo do Discord por PID (numero ou texto) fica de fora, mesmo com outro nome; outros PIDs continuam", () => {
        const withPid = (pid: unknown) => [...own(), stream(90, { "application.process.id": pid }), port(91, 90, "output", "FL")];
        assert.deepEqual(plannedLinks(withPid(4242), OWN, 4242), []);
        assert.deepEqual(plannedLinks(withPid("4242"), OWN, 4242), []);
        assert.deepEqual(plannedLinks(withPid(4243), OWN, 4242), [[91, 11]]);
        assert.deepEqual(plannedLinks(withPid(undefined), OWN, 4242), [[91, 11]]);
        assert.deepEqual(plannedLinks(withPid({}), OWN, 4242), [[91, 11]]);
        assert.deepEqual(plannedLinks(withPid(4242), OWN), [[91, 11]], "sem excludePid so vale o nome");
    });

    test("um aplicativo comum (firefox) continua ligado, ao lado dos excluidos", () => {
        const echo = [stream(92, { "node.link-group": "g" }), port(93, 92, "output", "FL")];
        assert.deepEqual(plannedLinks([...own(), ...firefox(), ...echo, ...discordVoice()], OWN, 1), [[21, 11], [22, 12]]);
    });

    test("objetos sem info ou sem props sao ignorados", () => {
        assert.deepEqual(plannedLinks([...own(), { id: 70 }, { id: 71, type: "PipeWire:Interface:Node", info: {} }, ...firefox()], OWN), [[21, 11], [22, 12]]);
    });
});

describe("startPipeWireLinks", () => {
    function start(t: Parameters<typeof mockSpawn>[0]) {
        const procs = mockSpawn(t);
        const events = { ready: 0, fails: [] as string[] };
        const linker = startPipeWireLinks(OWN, { onReady: () => events.ready++, onFail: r => events.fails.push(r) });
        const dump = procs.spawned[0];
        const links = () => procs.spawned.filter(p => p.command === "pw-link").map(p => p.args);
        const send = async (objects: unknown[]) => {
            dump.writeStdout(dumpText(objects));
            await flushPromises();
        };
        return { procs, events, linker, dump, links, send };
    }

    test("acompanha o pw-dump; pronto quando o no aparece; liga cada fluxo uma vez so; o Discord nunca", async t => {
        const { events, dump, links, send } = start(t);
        assert.equal(dump.command, "pw-dump");
        assert.deepEqual(dump.args, ["--monitor", "--no-colors"]);
        assert.deepEqual(dump.options, { shell: false, stdio: ["pipe", "pipe", "pipe"] });

        await send(firefox());
        assert.equal(events.ready, 0, "o no do Telinha ainda nao apareceu");
        assert.deepEqual(links(), []);

        await send([...own(), ...discordVoice()]);
        assert.equal(events.ready, 1);
        assert.deepEqual(links(), [["21", "11"], ["22", "12"]]);

        // o mesmo fluxo de novo (o pw-dump manda o objeto inteiro a cada mudanca): nada de ligacao repetida
        await send(firefox());
        assert.equal(links().length, 2);
        assert.equal(events.ready, 1);

        // o fluxo sumiu e o id 21 voltou para outro fluxo: liga de novo
        await send([{ id: 21, info: null }, { id: 20, info: null }]);
        await send([stream(20, { "application.name": "mpv" }), port(21, 20, "output", "FL")]);
        assert.deepEqual(links().at(-1), ["21", "11"]);
        assert.equal(links().length, 3);
        assert.deepEqual(events.fails, []);
    });

    test("uma ligacao que falha nao derruba nada; sem o pw-link, para com o motivo", async t => {
        const { procs, events, send, links } = start(t);
        await send([...own(), ...firefox()]);
        const [first, second] = procs.spawned.filter(p => p.command === "pw-link");
        first.fail(Object.assign(new Error("Device or resource busy"), { code: "EBUSY" }));
        first.exit(1);
        assert.deepEqual(events.fails, []);
        second.fail(Object.assign(new Error("spawn pw-link ENOENT"), { code: "ENOENT" }));
        assert.deepEqual(events.fails, ["as ferramentas do PipeWire (pw-record, pw-dump e pw-link) não estão instaladas (faltou o pw-link)"]);
        assert.equal(procs.spawned[0].killed, true, "o pw-dump para junto");
        assert.equal(links().length, 2);
    });

    test("ligacao que falha (saida != 0) e refeita no proximo lote, no maximo 3 vezes; sucesso nao repete", async t => {
        const { procs, send, links } = start(t);
        const last = () => procs.spawned.filter(p => p.command === "pw-link").at(-1)!;
        await send([...own(), stream(20), port(21, 20, "output", "FL")]);
        assert.equal(links().length, 1);
        last().exit(1);
        await send([port(21, 20, "output", "FL")]); // segunda tentativa
        assert.equal(links().length, 2);
        last().exit(null, "SIGTERM");
        await send([port(21, 20, "output", "FL")]); // terceira
        assert.equal(links().length, 3);
        last().exit(1);
        await send([port(21, 20, "output", "FL")]); // acabaram as tentativas
        assert.equal(links().length, 3);

        // a porta some e volta: o contador recomeca
        await send([{ id: 21, info: null }]);
        await send([port(21, 20, "output", "FL")]);
        assert.equal(links().length, 4);
        last().exit(0);
        await send([port(21, 20, "output", "FL")]);
        assert.equal(links().length, 4, "saida 0 = ligou");
    });

    test("pw-link que sai com erro depois da porta sumir ou do stop nao pede nada de novo", async t => {
        const a = start(t);
        await a.send([...own(), stream(20), port(21, 20, "output", "FL")]);
        const [first] = a.procs.spawned.filter(p => p.command === "pw-link");
        await a.send([{ id: 21, info: null }]);
        first.exit(1);
        await a.send([{ id: 5, info: null }]);
        assert.equal(a.links().length, 1);

        const b = start(t);
        await b.send([...own(), stream(20), port(21, 20, "output", "FL")]);
        const [only] = b.procs.spawned.filter(p => p.command === "pw-link");
        b.linker.stop();
        only.exit(1);
        await b.send([port(21, 20, "output", "FL")]);
        assert.equal(b.links().length, 1);
    });

    test("excludePid chega ao filtro: o fluxo com o PID do Discord nao e ligado", async t => {
        const procs = mockSpawn(t);
        startPipeWireLinks(OWN, { onReady: () => { }, onFail: () => { } }, 4242);
        procs.spawned[0].writeStdout(dumpText([...own(), stream(20, { "application.process.id": "4242" }), port(21, 20, "output", "FL")]));
        await flushPromises();
        assert.deepEqual(procs.spawned.filter(p => p.command === "pw-link").map(p => p.args), []);
    });

    test("stop(): kill que lanca nao quebra; dados depois do stop sao ignorados", async t => {
        const { linker, dump, events, links } = start(t);
        dump.kill = () => {
            throw new Error("EPERM");
        };
        linker.stop();
        dump.writeStdout(dumpText([...own(), ...firefox()]));
        await flushPromises();
        assert.deepEqual(links(), []);
        assert.deepEqual(events, { ready: 0, fails: [] });
    });

    test("pw-link que lanca na hora derruba com o motivo; lote que nao e array e item sem id numerico sao ignorados", async t => {
        const procs = mockSpawn(t, p => {
            if (p.command === "pw-link") throw Object.assign(new Error("spawn pw-link ENOENT"), { code: "ENOENT" });
        });
        const fails: string[] = [];
        startPipeWireLinks(OWN, { onReady: () => { }, onFail: r => fails.push(r) });
        const dump = procs.spawned[0];
        dump.writeStdout(JSON.stringify({ nada: true }) + "\n" + JSON.stringify([null, { id: "x" }, { id: 20, info: null }]) + "\n");
        await flushPromises();
        assert.deepEqual(fails, []);
        dump.writeStdout(dumpText([...own(), ...firefox()]));
        await flushPromises();
        assert.deepEqual(fails, ["as ferramentas do PipeWire (pw-record, pw-dump e pw-link) não estão instaladas (faltou o pw-link)"]);
        assert.equal(procs.spawned.filter(p => p.command === "pw-link").length, 1);
    });

    test("stop no meio do laco de ligacoes: as seguintes nao sao pedidas e nao ha pronto", async t => {
        const ref = { stop: () => { } };
        const procs = mockSpawn(t, p => {
            if (p.command === "pw-link") ref.stop();
        });
        const events = { ready: 0 };
        ref.stop = startPipeWireLinks(OWN, { onReady: () => events.ready++, onFail: () => { } }).stop;
        procs.spawned[0].writeStdout(dumpText([...own(), ...firefox()]));
        await flushPromises();
        assert.equal(procs.spawned.filter(p => p.command === "pw-link").length, 1);
        assert.equal(events.ready, 0);
    });

    test("o pw-dump sai, falta ou manda lixo: um aviso so, com o motivo", async t => {
        const a = start(t);
        a.dump.exit(1);
        a.dump.exit(1);
        assert.deepEqual(a.events.fails, ["o PipeWire parou de avisar os fluxos de áudio (pw-dump saiu com código 1)"]);

        const b = start(t);
        b.dump.fail(Object.assign(new Error("spawn pw-dump ENOENT"), { code: "ENOENT" }));
        b.dump.exit(null, "SIGTERM");
        assert.deepEqual(b.events.fails, ["as ferramentas do PipeWire (pw-record, pw-dump e pw-link) não estão instaladas (faltou o pw-dump)"]);

        const c = start(t);
        c.dump.writeStdout("[ 1, ]\n");
        await flushPromises();
        assert.deepEqual(c.events.fails, ["o pw-dump mandou uma lista ilegível"]);
        assert.equal(c.dump.killed, true);
    });

    test("stop(): mata o pw-dump, sem aviso de falha e sem ligar mais nada", async t => {
        const { linker, dump, events, send, links } = start(t);
        linker.stop();
        assert.equal(dump.killed, true);
        await send([...own(), ...firefox()]);
        assert.deepEqual(links(), []);
        assert.deepEqual(events, { ready: 0, fails: [] });
    });

    test("spawn que lanca na hora: o motivo chega depois (nunca dentro da chamada)", async t => {
        mockSpawn(t, (p: FakeChildProcess) => {
            if (p.command === "pw-dump") throw Object.assign(new Error("spawn pw-dump ENOENT"), { code: "ENOENT" });
        });
        const fails: string[] = [];
        startPipeWireLinks(OWN, { onReady: () => { }, onFail: r => fails.push(r) });
        assert.deepEqual(fails, []);
        await flushPromises();
        assert.equal(fails.length, 1);
        assert.match(fails[0], /faltou o pw-dump/);
    });
});
