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
const stream = (id: number, props: Record<string, unknown> = {}) => node(id, { "media.class": "Stream/Output/Audio", ...props });

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
