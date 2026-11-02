/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Peso da live" (core/liveWeightMain.ts no processo main, core/liveWeight.ts no renderer): a leitura dos contadores de
// desempenho da placa de video do Windows (os mesmos numeros do Gerenciador de Tarefas), em CSV do typeperf.exe. Sem Node:
// so texto e numeros, para os testes e os dois lados.
//
// O typeperf escreve uma linha de cabecalho e uma linha de valores por amostra (formato PDH-CSV 4.0, medido em 02/11/2026
// no Windows 11 pt-BR, RTX 3070):
//   "(PDH-CSV 4.0)","\\PC\GPU Engine(pid_10116_luid_0x00000000_0x0000B82B_phys_0_eng_0_engtype_3D)\Utilization Percentage",...
//   "11/02/2026 14:06:07.656","0.000000",...
// Uma coluna por motor da placa (luid + phys + eng) e por processo (pid). Cada valor e a porcentagem do tempo em que o
// motor trabalhou para aquele processo NO INTERVALO desde a amostra anterior (um contador de taxa: a media do intervalo,
// nao um instante). O "\GPU Process Memory(*)\Dedicated Usage" vem com a instancia sem o motor (pid_..._luid_..._phys_0)
// e o valor em bytes.
//
// As colunas sao reconhecidas pela INSTANCIA (pid_..._engtype_...), nunca pelo nome do objeto ou do contador: um Windows
// em outra lingua pode traduzir "GPU Engine" e "Utilization Percentage" no cabecalho (no pt-BR nao traduz), mas a
// instancia e sempre a mesma. As linhas que nao sao CSV ("Saindo, aguarde...", "O comando foi concluído com êxito.", as
// mensagens de erro, na pagina de codigo do console) ficam de fora.
//
// Como o Gerenciador de Tarefas soma: a carga de um MOTOR e a soma dos processos nele (no maximo 100%); a de um TIPO
// (3D, codificar...) e a do motor mais ocupado daquele tipo (uma placa tem varios motores "Copy", e a NVIDIA mais de um
// "3D"). Para um grupo de processos (o Discord) e igual, so com os processos do grupo.

/** Os tipos de motor que o peso da live mostra (os outros, Security, VR, OFA, LegacyOverlay, Compute..., ficam de fora). */
export type EngineKind = "3D" | "VideoEncode" | "VideoDecode" | "Copy";
export const ENGINE_KINDS: readonly EngineKind[] = ["3D", "VideoEncode", "VideoDecode", "Copy"];

/** Porcentagem (0..100) por tipo de motor. */
export type EngineLoad = Record<EngineKind, number>;

export type CounterColumn =
    | { kind: "engine"; pid: number; /** luid + phys + eng: o motor fisico */ engine: string; type: EngineKind | null; }
    | { kind: "memory"; pid: number; };

/** Uma amostra do typeperf: os valores na ordem das colunas do cabecalho daquela execucao (null = vazio/invalido). */
export interface CounterSample {
    columns: readonly (CounterColumn | null)[];
    values: readonly (number | null)[];
}

/** A media de uma janela de amostras. */
export interface WeightWindow {
    samples: number;
    /** os processos do Discord juntos */
    discord: EngineLoad;
    /** a placa toda (todos os processos) */
    total: EngineLoad;
    /** memoria dedicada da placa usada pelo Discord (bytes); null = o contador nao veio */
    discordMemory: number | null;
    /** o processo de fora do Discord que mais usou o 3D (o jogo); null = nenhum */
    topPid: number | null;
    /** o 3D desse processo (0..100) */
    top3D: number;
}

const INSTANCE_RE = /\(pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)(?:_eng_(\d+)_engtype_([^)]*))?\)/i;

/**
 * engtype → tipo. AMD com VCN tem um motor so para codificar e decodificar ("VideoCodec"): conta como codificar (quem
 * transmite usa ele para codificar; com AMD, o "codificar" inclui decodificar o que voce assiste).
 */
function engineKind(engtype: string): EngineKind | null {
    const t = engtype.replace(/_\d+$/, "");
    if (t === "3D" || t === "VideoEncode" || t === "VideoDecode" || t === "Copy") return t;
    if (t === "VideoCodec") return "VideoEncode";
    return null;
}

/** Os campos de uma linha CSV (aspas duplas, "" dentro de aspas). */
export function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let i = 0;
    const n = line.length;
    while (i <= n) {
        if (line[i] === "\"") {
            let field = "";
            i++;
            while (i < n) {
                if (line[i] === "\"") {
                    if (line[i + 1] === "\"") {
                        field += "\"";
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                field += line[i++];
            }
            out.push(field);
            // ate a proxima virgula
            while (i < n && line[i] !== ",") i++;
            i++;
        } else {
            const comma = line.indexOf(",", i);
            const end = comma < 0 ? n : comma;
            out.push(line.slice(i, end));
            i = end + 1;
        }
    }
    return out;
}

/** A coluna de um campo do cabecalho; null = nao e um contador que o peso da live le. */
export function parseColumn(field: string): CounterColumn | null {
    const m = INSTANCE_RE.exec(field);
    if (!m) return null;
    const pid = Number(m[1]);
    if (m[4] === undefined) return { kind: "memory", pid };
    return { kind: "engine", pid, engine: `${m[2]}_${m[3]}_${m[4]}`.toLowerCase(), type: engineKind(m[5]) };
}

/** A linha e o cabecalho do typeperf ("(PDH-CSV 4.0)",...)? */
export const isHeaderLine = (line: string) => /^"\(PDH-CSV [\d.]+\)"/.test(line);

/** As colunas do cabecalho (a 1a, a hora, fica de fora: o indice i vale para o valor i da linha de dados). */
export function parseHeader(line: string): (CounterColumn | null)[] {
    return splitCsvLine(line).slice(1).map(parseColumn);
}

/** Um valor do CSV ("12.345678"; um Windows com virgula decimal tambem passa). Vazio, " " e texto viram null. */
function parseValue(field: string): number | null {
    const t = field.trim().replace(",", ".");
    if (!t || !/^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(t)) return null;
    const v = Number(t);
    return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Uma linha de dados ("11/02/2026 14:06:07.656","0.000000",...) com as colunas do cabecalho daquela execucao; null = nao
 * e linha de dados (mensagem do typeperf) ou nao bate com o cabecalho.
 */
export function parseDataLine(line: string, columns: readonly (CounterColumn | null)[]): CounterSample | null {
    if (!line.startsWith("\"") || isHeaderLine(line)) return null;
    const fields = splitCsvLine(line);
    if (!/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4} \d{1,2}:\d{2}:\d{2}/.test(fields[0])) return null;
    const values = fields.slice(1).map(parseValue);
    if (values.length !== columns.length) return null;
    return { columns, values };
}

const zeroLoad = (): EngineLoad => ({ "3D": 0, VideoEncode: 0, VideoDecode: 0, Copy: 0 });
const pct = (v: number) => Math.min(100, Math.max(0, v));

interface EngineSum {
    type: EngineKind;
    all: number;
    discord: number;
}

/** Uma amostra: carga por tipo do Discord e da placa, o 3D de cada processo de fora do Discord e a memoria do Discord. */
function sampleLoads(sample: CounterSample, discordPids: ReadonlySet<number>) {
    const engines = new Map<string, EngineSum>();
    const pid3D = new Map<number, number>();
    let memory: number | null = null;
    sample.columns.forEach((col, i) => {
        const v = sample.values[i];
        if (!col || v == null) return;
        const ours = discordPids.has(col.pid);
        if (col.kind === "memory") {
            if (ours) memory = (memory ?? 0) + v;
            return;
        }
        if (!col.type) return;
        const sum = engines.get(col.engine) ?? { type: col.type, all: 0, discord: 0 };
        engines.set(col.engine, sum);
        sum.all += v;
        if (ours) sum.discord += v;
        // pid 0: o proprio Windows (o agendador), nunca o jogo
        else if (col.type === "3D" && col.pid > 0) pid3D.set(col.pid, Math.max(pid3D.get(col.pid) ?? 0, pct(v)));
    });
    const discord = zeroLoad();
    const total = zeroLoad();
    for (const e of engines.values()) {
        discord[e.type] = Math.max(discord[e.type], pct(e.discord));
        total[e.type] = Math.max(total[e.type], pct(e.all));
    }
    return { discord, total, pid3D, memory };
}

/** A media das amostras (vazia: tudo zero, samples 0). O jogo e o processo de fora do Discord com mais 3D na media. */
export function aggregate(samples: readonly CounterSample[], discordPids: ReadonlySet<number>): WeightWindow {
    const discord = zeroLoad();
    const total = zeroLoad();
    const pid3D = new Map<number, number>();
    let memorySum = 0;
    let memoryCount = 0;
    for (const s of samples) {
        const loads = sampleLoads(s, discordPids);
        for (const k of ENGINE_KINDS) {
            discord[k] += loads.discord[k];
            total[k] += loads.total[k];
        }
        for (const [pid, v] of loads.pid3D) pid3D.set(pid, (pid3D.get(pid) ?? 0) + v);
        if (loads.memory != null) {
            memorySum += loads.memory;
            memoryCount++;
        }
    }
    const n = samples.length;
    if (n) {
        for (const k of ENGINE_KINDS) {
            discord[k] /= n;
            total[k] /= n;
        }
    }
    let topPid: number | null = null;
    let top3D = 0;
    for (const [pid, sum] of pid3D) {
        const avg = sum / n;
        if (avg > top3D) [topPid, top3D] = [pid, avg];
    }
    return { samples: n, discord, total, discordMemory: memoryCount ? memorySum / memoryCount : null, topPid, top3D };
}

/** Os pids presentes nas colunas de engine (para saber se um processo novo ainda nao entrou nesta execucao do typeperf). */
export function enginePids(columns: readonly (CounterColumn | null)[]): Set<number> {
    const out = new Set<number>();
    for (const c of columns) if (c?.kind === "engine") out.add(c.pid);
    return out;
}

/**
 * O texto que o typeperf escreve fora do CSV (mensagens, erros) vem na pagina de codigo do console (850 no Windows pt-BR):
 * so as letras do portugues sao traduzidas; o resto fora do ASCII vira "?".
 */
const CP850: Record<number, string> = {
    0x80: "Ç", 0x81: "ü", 0x82: "é", 0x83: "â", 0x85: "à", 0x87: "ç", 0x88: "ê", 0x8A: "è", 0x90: "É", 0x93: "ô", 0x94: "ö",
    0xA0: "á", 0xA1: "í", 0xA2: "ó", 0xA3: "ú", 0xA4: "ñ", 0xB5: "Á", 0xB6: "Â", 0xC6: "ã", 0xC7: "Ã", 0xD6: "Í", 0xE0: "Ó",
    0xE2: "Ô", 0xE4: "õ", 0xE5: "Õ", 0xE9: "Ú"
};

/** Uma linha de texto em bytes "latin1" (como o main a le) → texto legivel (CP850). */
export function consoleText(latin1: string): string {
    let out = "";
    for (const ch of latin1) {
        const c = ch.charCodeAt(0);
        out += c < 0x80 ? ch : CP850[c] ?? "?";
    }
    return out.trim();
}
