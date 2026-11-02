/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do detector de jogo pesado (core/gpuPriorityAuto.ts): funcao pura, sem relogio nem native. Cobre os dois lados de
// cada limite, a faixa de histerese, a leitura repetida, o intervalo minimo e o limite de trocas, a falta do peso da live
// e a fonte (janela x maior 3D).
// Rodar:  pnpm test:file src/plugins/telinha/core/gpuPriorityAuto.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    type AutoState, decide, HEAVY_GAME_3D, HEAVY_TOTAL_3D, initialAutoState, LIGHT_GAME_3D, LIGHT_READINGS, LIGHT_TOTAL_3D, MAX_SWITCHES, MIN_SWITCH_MS, NO_WEIGHT_MS
} from "./gpuPriorityAuto";
import type { LiveWeight } from "./liveWeight";

let clock = 0;
function weight(game3D: number | null, total3D: number, patch: Partial<NonNullable<LiveWeight["game"]>> = {}): LiveWeight {
    clock += 10_000;
    return {
        at: clock,
        discord: { "3D": 4, VideoEncode: 12, VideoDecode: 0, Copy: 2 },
        discordCpu: 6,
        discordGpuMemoryMb: 400,
        game: game3D === null ? null : { pid: 100, name: "GoW.exe", load3D: game3D, source: "window", ...patch },
        total: { "3D": total3D, VideoEncode: 12, VideoDecode: 0, Copy: 3 }
    };
}

const HEAVY = () => weight(97, 99);
const LIGHT = () => weight(31, 50);

/** alimenta leituras uma a uma (cada uma 10 s depois da outra); devolve o ultimo resultado */
function feed(s: AutoState, readings: LiveWeight[], start = 0) {
    let state = s;
    let now = start;
    const changes: { to: string; why: string; }[] = [];
    const notes: string[] = [];
    for (const w of readings) {
        now += 10_000;
        const d = decide(state, w, now);
        state = d.state;
        if (d.change) changes.push(d.change);
        if (d.note) notes.push(d.note);
    }
    return { state, now, changes, notes };
}

describe("estado inicial", () => {
    test("comeca em alta, sem trocas", () => {
        const s = initialAutoState(5);
        assert.equal(s.want, "high");
        assert.equal(s.switches, 0);
        assert.equal(s.switchedAt, 5);
        assert.equal(s.lastAt, null);
        assert.equal(s.frozen, false);
    });
});

describe("subir para o tempo real", () => {
    test("uma leitura pesada ja basta, e a primeira troca nao espera o intervalo", () => {
        const s = initialAutoState(0);
        const d = decide(s, HEAVY(), 10_000);
        assert.equal(d.change?.to, "realtime");
        assert.equal(d.change?.why, "jogo GoW.exe 3D 97%, placa no total 99%");
        assert.equal(d.state.want, "realtime");
        assert.equal(d.state.switches, 1);
        assert.equal(d.state.switchedAt, 10_000);
        assert.equal(d.note, null);
    });

    test("nao muda o estado recebido", () => {
        const s = initialAutoState(0);
        const before = { ...s };
        decide(s, HEAVY(), 10_000);
        assert.deepEqual(s, before);
    });

    test("limites: o jogo com 3D no limite sobe, 1 ponto abaixo nao", () => {
        const s = initialAutoState(0);
        assert.equal(decide(s, weight(HEAVY_GAME_3D, 99), 10_000).change?.to, "realtime");
        assert.equal(decide(s, weight(HEAVY_GAME_3D - 1, 99), 10_000).change, null);
    });

    test("limites: a placa no total no limite sobe, 1 ponto abaixo nao", () => {
        const s = initialAutoState(0);
        assert.equal(decide(s, weight(97, HEAVY_TOTAL_3D), 10_000).change?.to, "realtime");
        assert.equal(decide(s, weight(97, HEAVY_TOTAL_3D - 1), 10_000).change, null);
    });

    test("sem jogo nao sobe, mesmo com a placa cheia", () => {
        assert.equal(decide(initialAutoState(0), weight(null, 99), 10_000).change, null);
    });

    test("o motivo cita o maior 3D fora do Discord quando a fonte e a tela inteira", () => {
        const d = decide(initialAutoState(0), weight(95, 99, { source: "top", name: "X.exe" }), 10_000);
        assert.equal(d.change?.why, "maior 3D fora do Discord: X.exe 3D 95%, placa no total 99%");
    });

    test("sem o nome do processo, cita o pid", () => {
        const d = decide(initialAutoState(0), weight(95, 99, { name: null, pid: 4321 }), 10_000);
        assert.equal(d.change?.why, "jogo processo 4321 3D 95%, placa no total 99%");
    });

    test("ja em tempo real, outra leitura pesada nao troca de novo", () => {
        const r = feed(initialAutoState(0), [HEAVY(), HEAVY(), HEAVY()]);
        assert.equal(r.changes.length, 1);
        assert.equal(r.state.want, "realtime");
        assert.equal(r.state.light, 0);
    });
});

describe("voltar para alta", () => {
    /** em tempo real desde a primeira leitura (10 s) */
    function realtime() {
        return feed(initialAutoState(0), [HEAVY()]);
    }

    test("so depois de LIGHT_READINGS leituras leves seguidas e do intervalo minimo", () => {
        const up = realtime();
        // leituras 2 e 3: leves, ainda poucas
        const a = feed(up.state, [LIGHT(), LIGHT()], up.now);
        assert.equal(a.changes.length, 0);
        assert.equal(a.state.light, 2);
        // a 4a leitura (LIGHT_READINGS = 3) chega a 40 s da troca: falta o intervalo minimo, fica
        const b = feed(a.state, [LIGHT()], a.now);
        assert.equal(LIGHT_READINGS, 3);
        assert.equal(b.changes.length, 0);
        assert.equal(b.state.light, 3);
        // passado o intervalo, a proxima leitura leve volta
        const d = decide(b.state, LIGHT(), 10_000 + MIN_SWITCH_MS);
        assert.equal(d.change?.to, "high");
        assert.equal(d.change?.why, "jogo GoW.exe 3D 31% há 30 s");
        assert.equal(d.state.want, "high");
        assert.equal(d.state.switches, 2);
        assert.equal(d.state.light, 0);
    });

    test("no limite do intervalo minimo troca, 1 ms antes nao", () => {
        const up = realtime();
        const ready: AutoState = { ...up.state, light: LIGHT_READINGS - 1 };
        assert.equal(decide(ready, LIGHT(), up.state.switchedAt + MIN_SWITCH_MS - 1).change, null);
        assert.equal(decide(ready, LIGHT(), up.state.switchedAt + MIN_SWITCH_MS).change?.to, "high");
    });

    test("limites: jogo com 3D abaixo do limite e leve, no limite nao", () => {
        const up = realtime();
        const ready: AutoState = { ...up.state, light: LIGHT_READINGS - 1, switchedAt: 0 };
        assert.equal(decide(ready, weight(LIGHT_GAME_3D - 1, 99), MIN_SWITCH_MS).change?.to, "high");
        assert.equal(decide(ready, weight(LIGHT_GAME_3D, 99), MIN_SWITCH_MS).change, null);
    });

    test("limites: placa no total abaixo do limite e leve, no limite nao", () => {
        const up = realtime();
        const ready: AutoState = { ...up.state, light: LIGHT_READINGS - 1, switchedAt: 0 };
        const light = decide(ready, weight(80, LIGHT_TOTAL_3D - 1), MIN_SWITCH_MS);
        assert.equal(light.change?.to, "high");
        assert.equal(light.change?.why, "placa no total 74% há 30 s");
        assert.equal(decide(ready, weight(80, LIGHT_TOTAL_3D), MIN_SWITCH_MS).change, null);
    });

    test("sem jogo conta como leve, e o motivo diz isso", () => {
        const up = realtime();
        const ready: AutoState = { ...up.state, light: LIGHT_READINGS - 1, switchedAt: 0 };
        const d = decide(ready, weight(null, 99), MIN_SWITCH_MS);
        assert.equal(d.change?.to, "high");
        assert.equal(d.change?.why, "nenhum jogo usando a placa há 30 s");
    });

    test("o motivo na tela inteira cita o maior 3D fora do Discord", () => {
        const up = realtime();
        const ready: AutoState = { ...up.state, light: LIGHT_READINGS - 1, switchedAt: 0 };
        const d = decide(ready, weight(31, 99, { source: "top", name: "X.exe" }), MIN_SWITCH_MS);
        assert.equal(d.change?.why, "maior 3D fora do Discord: X.exe 3D 31% há 30 s");
    });

    test("uma leitura pesada no meio zera a contagem de leves", () => {
        const up = realtime();
        const r = feed(up.state, [LIGHT(), LIGHT(), HEAVY()], up.now);
        assert.equal(r.state.light, 0);
        assert.equal(r.state.want, "realtime");
    });

    test("a faixa de histerese mantem o estado e zera a contagem", () => {
        const up = realtime();
        const r = feed(up.state, [LIGHT(), LIGHT(), weight(50, 85)], up.now);
        assert.equal(r.state.light, 0);
        assert.equal(r.state.want, "realtime");
        assert.equal(r.changes.length, 0);
    });

    test("em alta, leitura leve nao faz nada", () => {
        const r = feed(initialAutoState(0), [LIGHT(), LIGHT(), LIGHT(), LIGHT()]);
        assert.equal(r.changes.length, 0);
        assert.equal(r.state.light, 0);
        assert.equal(r.state.want, "high");
    });

    test("em alta, a faixa de histerese nao sobe", () => {
        const r = feed(initialAutoState(0), [weight(50, 85), weight(59, 99), weight(97, 89)]);
        assert.equal(r.changes.length, 0);
    });
});

describe("intervalo minimo para subir de novo", () => {
    test("depois de voltar, uma leitura pesada espera MIN_SWITCH_MS", () => {
        const high: AutoState = { ...initialAutoState(0), want: "high", switches: 2, switchedAt: 100_000, lastAt: 1 };
        assert.equal(decide(high, HEAVY(), 100_000 + MIN_SWITCH_MS - 1).change, null);
        const again = decide(high, HEAVY(), 100_000 + MIN_SWITCH_MS);
        assert.equal(again.change?.to, "realtime");
    });
});

describe("leitura repetida", () => {
    test("o mesmo at nao conta de novo (nem como leve)", () => {
        const up = feed(initialAutoState(0), [HEAVY()]);
        const light = LIGHT();
        const first = decide({ ...up.state, switchedAt: 0 }, light, 200_000);
        assert.equal(first.state.light, 1);
        const second = decide(first.state, light, 201_000);
        assert.equal(second.change, null);
        assert.equal(second.state.light, 1);
        assert.equal(second.state.lastAt, light.at);
    });

    test("o mesmo at pesado nao troca duas vezes", () => {
        const heavy = HEAVY();
        const first = decide(initialAutoState(0), heavy, 10_000);
        assert.equal(first.change?.to, "realtime");
        const down: AutoState = { ...first.state, want: "high", switchedAt: 0 };
        assert.equal(decide(down, heavy, 200_000).change, null);
    });
});

describe("trocando demais", () => {
    function flip(count: number) {
        let s = initialAutoState(0);
        let now = 0;
        const notes: string[] = [];
        const changes: string[] = [];
        for (let i = 0; i < count; i++) {
            const up = s.want === "high";
            // 3 leituras leves seguidas (ou 1 pesada), espacadas pelo intervalo minimo
            const readings = up ? [HEAVY()] : [LIGHT(), LIGHT(), LIGHT()];
            now += MIN_SWITCH_MS;
            for (const w of readings) {
                const d = decide(s, w, now);
                s = d.state;
                if (d.change) changes.push(d.change.to);
                if (d.note) notes.push(d.note);
            }
        }
        return { s, now, notes, changes };
    }

    test("as trocas reais alternam e a ultima permitida congela e avisa", () => {
        const r = flip(MAX_SWITCHES - 1);
        assert.equal(r.s.frozen, false);
        assert.equal(r.s.switches, MAX_SWITCHES - 1);
        assert.equal(r.s.want, "realtime");
        assert.deepEqual(r.changes, ["realtime", "high", "realtime", "high", "realtime"]);
        assert.deepEqual(r.notes, []);
        // a proxima (de tempo real para alta, depois de 3 leituras leves e do intervalo minimo) congela
        const last: AutoState = { ...r.s, light: LIGHT_READINGS - 1 };
        const d = decide(last, LIGHT(), r.now + MIN_SWITCH_MS);
        assert.equal(d.change?.to, "high");
        assert.equal(d.state.frozen, true);
        assert.equal(d.note, "trocando demais: fica em alta até o fim da transmissão");
    });

    test("congelando ao subir o aviso diz tempo real", () => {
        const almost: AutoState = { ...initialAutoState(0), want: "high", switches: MAX_SWITCHES - 1, switchedAt: 0 };
        const d = decide(almost, HEAVY(), MIN_SWITCH_MS);
        assert.equal(d.change?.to, "realtime");
        assert.equal(d.state.frozen, true);
        assert.equal(d.note, "trocando demais: fica em tempo real até o fim da transmissão");
    });

    test("congelado: nenhuma leitura troca mais e o aviso nao repete", () => {
        const frozen: AutoState = { ...initialAutoState(0), want: "realtime", frozen: true, switches: MAX_SWITCHES, switchedAt: 0, light: 2 };
        const r = feed(frozen, [LIGHT(), LIGHT(), LIGHT(), LIGHT()], 1_000_000);
        assert.equal(r.changes.length, 0);
        assert.equal(r.notes.length, 0);
        assert.equal(r.state.want, "realtime");
        assert.equal(r.state.frozen, true);
        const up: AutoState = { ...frozen, want: "high" };
        assert.equal(feed(up, [HEAVY()], 1_000_000).changes.length, 0);
    });
});

describe("sem o peso da live", () => {
    test("antes de NO_WEIGHT_MS nao faz nada", () => {
        const s = initialAutoState(0);
        const a = decide(s, null, 1_000);
        assert.equal(a.change, null);
        assert.equal(a.note, null);
        assert.equal(a.state.noWeightSince, 1_000);
        const b = decide(a.state, null, 1_000 + NO_WEIGHT_MS - 1);
        assert.equal(b.note, null);
    });

    test("em NO_WEIGHT_MS avisa uma vez e fica em alta", () => {
        const a = decide(initialAutoState(0), null, 1_000);
        const b = decide(a.state, null, 1_000 + NO_WEIGHT_MS);
        assert.equal(b.note, "sem o peso da live: não dá para saber se um jogo pesa; fica em alta");
        assert.equal(b.change, null);
        const c = decide(b.state, null, 1_000 + NO_WEIGHT_MS + 5_000);
        assert.equal(c.note, null);
        assert.equal(c.change, null);
    });

    test("em tempo real, volta para alta junto com o aviso", () => {
        const up = feed(initialAutoState(0), [HEAVY()]);
        const a = decide(up.state, null, 20_000);
        const b = decide(a.state, null, 20_000 + NO_WEIGHT_MS);
        assert.equal(b.change?.to, "high");
        assert.equal(b.change?.why, "sem o peso da live");
        assert.equal(b.note, "sem o peso da live: não dá para saber se um jogo pesa; fica em alta");
        assert.equal(b.state.want, "high");
        assert.equal(b.state.switches, 2);
    });

    test("congelado em tempo real, ainda volta para alta (caminho seguro)", () => {
        const frozen: AutoState = { ...initialAutoState(0), want: "realtime", frozen: true, switches: MAX_SWITCHES };
        const a = decide(frozen, null, 1_000);
        const b = decide(a.state, null, 1_000 + NO_WEIGHT_MS);
        assert.equal(b.change?.to, "high");
        assert.equal(b.state.frozen, true);
        assert.match(b.note ?? "", /sem o peso da live/);
    });

    test("a leitura que volta zera a espera e o aviso vale de novo na proxima falta", () => {
        const a = decide(initialAutoState(0), null, 1_000);
        const b = decide(a.state, null, 1_000 + NO_WEIGHT_MS);
        assert.equal(b.state.noWeightNoted, true);
        const back = decide(b.state, LIGHT(), 50_000);
        assert.equal(back.state.noWeightSince, null);
        assert.equal(back.state.noWeightNoted, false);
        const gap = decide(back.state, null, 60_000);
        assert.equal(decide(gap.state, null, 60_000 + NO_WEIGHT_MS).note?.startsWith("sem o peso da live"), true);
    });

    test("uma falta curta seguida de leitura zera a espera", () => {
        const a = decide(initialAutoState(0), null, 1_000);
        assert.equal(a.state.noWeightSince, 1_000);
        const back = decide(a.state, LIGHT(), 5_000);
        assert.equal(back.state.noWeightSince, null);
    });

    test("a leitura repetida tambem conta como ter o peso", () => {
        const w = LIGHT();
        const first = decide(initialAutoState(0), w, 10_000);
        const gap = decide(first.state, null, 11_000);
        assert.equal(gap.state.noWeightSince, 11_000);
        const same = decide(gap.state, w, 12_000);
        assert.equal(same.state.noWeightSince, null);
        assert.equal(same.change, null);
    });
});
