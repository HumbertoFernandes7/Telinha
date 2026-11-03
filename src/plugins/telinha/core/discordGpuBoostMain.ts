/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts (o lado do renderer e o core/discordGpuBoost.ts, que so importa tipos daqui).
//
// O registro do que o Telinha pediu ao Discord em "Tempo real" (setGPUBoostEnabledByPid): quais processos (pid, papel, classe de
// antes) estao em REALTIME por conta do Telinha. Fica na memoria do processo main, que sobrevive a um reload e a uma queda do
// renderer (o sessionStorage so sobrevive ao reload: um renderer novo comeca sem ele, e o Discord ficaria em REALTIME ate
// reiniciar). O main morre junto com o Discord, e ai os processos que ele pediu tambem ja nao existem: nada a desfazer.
// Nada roda no carregamento do modulo e nada aqui toca o disco ou o Discord.

/** Um processo que o Telinha pediu ao Discord para pôr em REALTIME. */
export interface GpuBoostRecordEntry {
    pid: number;
    role: "Discord" | "GPU";
    /** a classe que o processo tinha antes de o Telinha mexer */
    classBefore: string;
    /** quando o pedido foi aceito (ms desde 1970) */
    at: number;
}

/** No maximo: o Discord tem poucos processos de video (principal + GPU); o resto seria lixo. */
export const GPU_BOOST_RECORD_MAX = 16;

let record: GpuBoostRecordEntry[] = [];

/** So as entradas bem formadas (pid inteiro > 0, papel Discord|GPU, classBefore texto, at numero); um pid repetido fica com o ultimo; no maximo GPU_BOOST_RECORD_MAX. */
export function cleanGpuBoostRecord(list: unknown): GpuBoostRecordEntry[] {
    if (!Array.isArray(list)) return [];
    const byPid = new Map<number, GpuBoostRecordEntry>();
    for (const e of list) {
        if (!e || typeof e !== "object") continue;
        const { pid, role, classBefore, at } = e as Record<string, unknown>;
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
        if (role !== "Discord" && role !== "GPU") continue;
        if (typeof classBefore !== "string" || typeof at !== "number") continue;
        byPid.delete(pid);
        byPid.set(pid, { pid, role, classBefore, at });
    }
    return [...byPid.values()].slice(-GPU_BOOST_RECORD_MAX);
}

/** O que esta registrado (uma copia). */
export function readGpuBoostRecordMain(): GpuBoostRecordEntry[] {
    return record.map(e => ({ ...e }));
}

/** Troca o registro inteiro pela lista (limpa); devolve o que ficou. Lista que nao e array limpa o registro. */
export function writeGpuBoostRecordMain(list: unknown): GpuBoostRecordEntry[] {
    record = cleanGpuBoostRecord(list);
    return readGpuBoostRecordMain();
}

/** So para testes: esquece o registro. */
export function resetGpuBoostRecordForTests() {
    record = [];
}
