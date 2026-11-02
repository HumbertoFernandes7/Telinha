/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da leitura dos contadores da placa de video do typeperf (core/liveWeightCounters.ts): o CSV como o typeperf do
// Windows 11 pt-BR escreve (medido em 02/11/2026), um cabecalho traduzido (as colunas sao reconhecidas pela instancia),
// as mensagens fora do CSV, e a soma como o Gerenciador de Tarefas (motor = soma dos processos, tipo = o motor mais
// ocupado; o Discord e um grupo de processos; o jogo e o processo de fora com mais 3D).
// Rodar:  pnpm test:file src/plugins/telinha/core/liveWeightCounters.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    aggregate, consoleText, type CounterSample, ENGINE_KINDS, enginePids, isHeaderLine, parseColumn, parseDataLine, parseHeader, splitCsvLine
} from "./liveWeightCounters";

const LUID = "luid_0x00000000_0x0000B82B";
const engine = (pid: number, eng: number, type: string, host = String.raw`\\HUMBERTO-PC\GPU Engine`, counter = "Utilization Percentage") =>
    `${host}(pid_${pid}_${LUID}_phys_0_eng_${eng}_engtype_${type})\\${counter}`;
const memory = (pid: number) => String.raw`\\HUMBERTO-PC\GPU Process Memory(pid_` + `${pid}_${LUID}_phys_0)\\Dedicated Usage`;

const DISCORD_MAIN = 10116;
const DISCORD_GPU = 22156;
const GAME = 27368;
const DWM = 1480;
const DISCORD = new Set([DISCORD_MAIN, DISCORD_GPU]);

/** As colunas na ordem que o typeperf escreve (por pid, depois por motor), com os tipos que ficam de fora no meio. */
const COLUMNS = [
    engine(DISCORD_MAIN, 0, "3D"),
    engine(DISCORD_MAIN, 6, "VideoEncode"),
    engine(DISCORD_MAIN, 13, "Security_1"),
    engine(DISCORD_GPU, 0, "3D"),
    engine(DISCORD_GPU, 2, "VideoDecode"),
    engine(DISCORD_GPU, 3, "Copy"),
    engine(DISCORD_GPU, 4, "Copy"),
    engine(DISCORD_GPU, 6, "VideoEncode"),
    engine(DISCORD_GPU, 7, "OFA_0"),
    engine(GAME, 0, "3D"),
    engine(GAME, 8, "3D"),
    engine(GAME, 3, "Copy"),
    engine(DWM, 0, "3D"),
    engine(0, 0, "3D"),
    memory(DISCORD_MAIN),
    memory(DISCORD_GPU),
    memory(GAME)
];

const csvLine = (fields: string[]) => fields.map(f => `"${f}"`).join(",");
const HEADER = csvLine(["(PDH-CSV 4.0)", ...COLUMNS]);

/** Uma linha de valores na ordem de COLUMNS. */
function row(time: string, v: Partial<Record<number, string>>) {
    return csvLine([time, ...COLUMNS.map((_, i) => v[i] ?? "0.000000")]);
}

const MB = 1024 * 1024;

/** O que o typeperf escreveu de verdade, em linhas (a 1a vazia, a mensagem do fim na pagina de codigo do console). */
const OUTPUT = [
    "",
    HEADER,
    row("11/02/2026 14:06:07.656", {
        0: "2.000000", 1: "1.500000", 2: "33.000000",
        3: "3.000000", 4: "0.000000", 5: "1.000000", 6: "4.000000", 7: "10.500000", 8: "50.000000",
        9: "88.000000", 10: "5.000000", 11: "2.000000", 12: "6.000000", 13: "99.000000",
        14: String(100 * MB), 15: String(300 * MB), 16: String(4000 * MB)
    }),
    row("11/02/2026 14:06:12.683", {
        0: "4.000000", 1: "0.500000",
        3: "1.000000", 5: "3.000000", 7: "11.500000",
        9: "94.000000", 10: "1.000000", 12: "8.000000",
        14: String(100 * MB), 15: String(500 * MB)
    }),
    "Saindo, aguarde...                         ",
    "O comando foi conclu¡do com \u0088xito."
];

function parseOutput(lines: string[]) {
    let columns: ReturnType<typeof parseHeader> | null = null;
    const samples: CounterSample[] = [];
    const notes: string[] = [];
    for (const line of lines) {
        if (isHeaderLine(line)) columns = parseHeader(line);
        else if (columns && parseDataLine(line, columns)) samples.push(parseDataLine(line, columns)!);
        else if (line.trim()) notes.push(consoleText(line));
    }
    return { columns, samples, notes };
}

describe("o CSV do typeperf", () => {
    test("cabecalho: uma coluna por motor e processo (luid+phys+eng), a memoria sem motor; a hora fica de fora", () => {
        const columns = parseHeader(HEADER);
        assert.equal(columns.length, COLUMNS.length);
        assert.deepEqual(columns[0], { kind: "engine", pid: DISCORD_MAIN, engine: "0x00000000_0x0000b82b_0_0", type: "3D" });
        assert.deepEqual(columns[2], { kind: "engine", pid: DISCORD_MAIN, engine: "0x00000000_0x0000b82b_0_13", type: null }, "Security_1 fica de fora");
        assert.equal(columns[8]?.kind === "engine" && columns[8].type, null, "OFA_0 fica de fora");
        assert.deepEqual(columns[14], { kind: "memory", pid: DISCORD_MAIN });
        assert.deepEqual(ENGINE_KINDS, ["3D", "VideoEncode", "VideoDecode", "Copy"]);
        assert.ok(isHeaderLine(HEADER));
        assert.ok(!isHeaderLine(row("11/02/2026 14:06:07.656", {})));
    });

    test("as amostras saem das linhas de dados; o vazio e o fim do typeperf ficam de fora (o texto em CP850 vira legivel)", () => {
        const { samples, notes } = parseOutput(OUTPUT);
        assert.equal(samples.length, 2);
        assert.equal(samples[0].values[0], 2);
        assert.equal(samples[0].values[14], 100 * MB);
        assert.deepEqual(notes, ["Saindo, aguarde...", "O comando foi concluído com êxito."]);
    });

    test("cabecalho traduzido (outro Windows pode traduzir o objeto e o contador): a instancia decide a coluna", () => {
        const localized = csvLine([
            "(PDH-CSV 4.0)",
            engine(DISCORD_GPU, 6, "VideoEncode", String.raw`\\PC\GPU-Modul`, "Auslastung in Prozent"),
            String.raw`\\PC\GPU-Prozessspeicher(pid_` + `${GAME}_${LUID}_phys_0)\\Dedizierte Nutzung`
        ]);
        const columns = parseHeader(localized);
        assert.deepEqual(columns, [
            { kind: "engine", pid: DISCORD_GPU, engine: "0x00000000_0x0000b82b_0_6", type: "VideoEncode" },
            { kind: "memory", pid: GAME }
        ]);
        const sample = parseDataLine(csvLine(["02.11.2026 14:06:07.656", "12,5", "1024"]), columns)!;
        assert.deepEqual(sample.values, [12.5, 1024], "virgula decimal tambem passa");
    });

    test("coluna que nao e do peso da live, valor vazio/invalido e linha que nao bate com o cabecalho", () => {
        assert.equal(parseColumn(String.raw`\\PC\Processor(_Total)\% Processor Time`), null);
        const columns = parseHeader(csvLine(["(PDH-CSV 4.0)", engine(1, 0, "3D"), engine(1, 1, "Copy"), engine(1, 2, "VideoCodec_0")]));
        assert.equal(columns[2]?.kind === "engine" && columns[2].type, "VideoEncode", "o VCN da AMD (VideoCodec) conta como codificar");
        assert.deepEqual(parseDataLine(csvLine(["11/02/2026 14:06:07.656", " ", "abc", "-1"]), columns)!.values, [null, null, null]);
        assert.equal(parseDataLine(csvLine(["11/02/2026 14:06:07.656", "1"]), columns), null, "faltam colunas");
        assert.equal(parseDataLine(csvLine(["Erro", "1", "2", "3"]), columns), null, "sem a hora");
        assert.equal(parseDataLine("Erro: nenhum contador válido.", columns), null);
        assert.equal(parseDataLine(csvLine(["(PDH-CSV 4.0)", "a", "b", "c"]), columns), null, "outro cabecalho");
    });

    test("splitCsvLine: aspas, aspas dobradas, campos sem aspas e vazios", () => {
        assert.deepEqual(splitCsvLine(""), [""]);
        assert.deepEqual(splitCsvLine("a,b"), ["a", "b"]);
        assert.deepEqual(splitCsvLine("a,"), ["a", ""]);
        assert.deepEqual(splitCsvLine("\"x\"\"y\",\"z\""), ["x\"y", "z"]);
        assert.deepEqual(splitCsvLine("\"aberto"), ["aberto"]);
        assert.deepEqual(splitCsvLine("\"a\"lixo,b"), ["a", "b"]);
    });

    test("consoleText: CP850 do portugues; o resto fora do ASCII vira ?", () => {
        assert.equal(consoleText("INFORMA\u0080åES: nÆo ÿ  "), "INFORMAÇÕES: não ?");
    });

    test("enginePids: os processos com colunas de motor (a memoria nao conta)", () => {
        assert.deepEqual([...enginePids(parseHeader(HEADER))].sort((a, b) => a - b), [0, DWM, DISCORD_MAIN, DISCORD_GPU, GAME]);
        assert.deepEqual([...enginePids([null, { kind: "memory", pid: 5 }])], []);
    });
});

describe("a soma como o Gerenciador de Tarefas", () => {
    const { samples } = parseOutput(OUTPUT);

    test("Discord: por motor soma os processos dele; por tipo, o motor mais ocupado; media das amostras", () => {
        const w = aggregate(samples, DISCORD);
        assert.equal(w.samples, 2);
        // 3D: motor 0 = principal + GPU: (2+3) e (4+1) → 5 e 5
        assert.equal(w.discord["3D"], 5);
        // codificar: motor 6 = 1,5+10,5 e 0,5+11,5 → 12 e 12
        assert.equal(w.discord.VideoEncode, 12);
        assert.equal(w.discord.VideoDecode, 0);
        // copiar: dois motores (3 e 4); o mais ocupado: 4 e 3 → 3,5
        assert.equal(w.discord.Copy, 3.5);
        // memoria dedicada: 400 MB e 600 MB
        assert.equal(w.discordMemory, 500 * MB);
    });

    test("a placa toda: todos os processos (o pid 0 tambem), no maximo 100% por motor", () => {
        const w = aggregate(samples, DISCORD);
        // motor 0 (3D): 2+3+88+6+99 = 198 → 100; 4+1+94+8 = 107 → 100
        assert.equal(w.total["3D"], 100);
        assert.equal(w.total.VideoEncode, 12);
        // copiar: motor 3 = 1 (Discord) + 2 (jogo) = 3, motor 4 = 4 → 4; depois 3 e 0 → 3
        assert.equal(w.total.Copy, 3.5);
    });

    test("o jogo: o processo de fora do Discord com mais 3D (o motor mais ocupado dele), nunca o pid 0", () => {
        const w = aggregate(samples, DISCORD);
        assert.equal(w.topPid, GAME);
        assert.equal(w.top3D, 91);
        const onlyDwm = aggregate(samples, new Set([...DISCORD, GAME]));
        assert.equal(onlyDwm.topPid, DWM, "sem o jogo, o dwm (o 3D do proprio Windows) aparece");
        assert.equal(onlyDwm.top3D, 7);
    });

    test("sem amostras: zeros, sem jogo e sem memoria; amostra sem a memoria do Discord", () => {
        const w = aggregate([], DISCORD);
        assert.deepEqual(w, {
            samples: 0, discord: { "3D": 0, VideoEncode: 0, VideoDecode: 0, Copy: 0 }, total: { "3D": 0, VideoEncode: 0, VideoDecode: 0, Copy: 0 },
            discordMemory: null, topPid: null, top3D: 0
        });
        const columns = parseHeader(csvLine(["(PDH-CSV 4.0)", engine(DISCORD_GPU, 2, "VideoDecode"), memory(GAME)]));
        const s = parseDataLine(csvLine(["11/02/2026 14:06:07.656", "7.000000", "1"]), columns)!;
        const one = aggregate([s, { columns: [null], values: [5] }], DISCORD);
        assert.equal(one.discord.VideoDecode, 3.5);
        assert.equal(one.discordMemory, null);
    });
});
