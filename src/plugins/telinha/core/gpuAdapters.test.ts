/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da regra pura da dica "duas placas de video" (core/gpuAdapters.ts): quais placas sao integradas, quando a dica
// vale ("disable" so sem tela embutida e com a integrada fora do desenho; "laptop" nunca manda desativar) e os textos.
// Rodar:  pnpm test:file src/plugins/telinha/core/gpuAdapters.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeAdapters, dualGpuHint, dualGpuParagraphs, type GpuAdapter, isIntegrated, realAdapters } from "./gpuAdapters";

const gpu = (vendorId: number, deviceId: number, name: string, driverVendor: string, extra: Partial<GpuAdapter> = {}): GpuAdapter => (
    { vendorId, deviceId, name, driverVendor, driverVersion: "1.0", active: false, preference: 0, ...extra }
);

/** O PC do amigo: a integrada (164E) vem primeiro e nao desenha; a RX 9070 XT desenha. */
const RAPHAEL = gpu(0x1002, 0x164E, "AMD Radeon(TM) Graphics", "AMD", { preference: 2 });
const RX9070 = gpu(0x1002, 0x7550, "AMD Radeon RX 9070 XT", "AMD", { active: true, preference: 3 });
const WARP = gpu(0x1414, 0x008C, "Microsoft Basic Render Driver", "Microsoft");
const NPU = gpu(0x8086, 0x7D1D, "Intel(R) AI Boost", "");
const UHD = gpu(0x8086, 0xA780, "Intel(R) UHD Graphics 770", "Intel");
const RTX = gpu(0x10DE, 0x2786, "NVIDIA GeForce RTX 4070", "NVIDIA", { active: true });
const ARC_B580 = gpu(0x8086, 0xE20B, "Intel(R) Arc(TM) B580 Graphics", "Intel", { active: true });

describe("isIntegrated / realAdapters", () => {
    test("a tabela de PCI ids", () => {
        assert.equal(isIntegrated(RAPHAEL), true);
        assert.equal(isIntegrated(gpu(0x1002, 0x9640, "x", "AMD")), true);
        assert.equal(isIntegrated(gpu(0x1002, 0x9900, "x", "AMD")), true);
        assert.equal(isIntegrated(RX9070), false);
        assert.equal(isIntegrated(UHD), true);
        assert.equal(isIntegrated(gpu(0x8086, 0x4907, "DG1", "Intel")), false);
        assert.equal(isIntegrated(gpu(0x8086, 0x56A0, "Arc A770", "Intel")), false);
        assert.equal(isIntegrated(ARC_B580), false);
        assert.equal(isIntegrated(RTX), false);
    });

    test("fabricante fora da tabela: so pelo gpuPreference (2 com outra em 3)", () => {
        const low = gpu(0x5143, 0x0001, "Qualcomm", "Qualcomm", { preference: 2 });
        const high = gpu(0x5143, 0x0002, "Qualcomm dGPU", "Qualcomm", { preference: 3 });
        assert.equal(isIntegrated(low, [low, high]), true);
        assert.equal(isIntegrated(high, [low, high]), false);
        assert.equal(isIntegrated(low, [low]), false);
    });

    test("software, virtual e NPU nao sao placas de verdade", () => {
        const list = [RAPHAEL, WARP, NPU, gpu(0, 0, "x", "x"), gpu(0xFFFF, 1, "x", "x"), gpu(0x15AD, 0x0405, "VMware", "VMware")];
        assert.deepEqual(realAdapters(list), [RAPHAEL]);
    });
});

describe("dualGpuHint", () => {
    test("o PC do amigo: sem tela embutida e a integrada nao desenha → disable", () => {
        const hint = dualGpuHint([RAPHAEL, RX9070], false, true);
        assert.equal(hint?.kind, "disable");
        assert.equal(hint?.integrated, RAPHAEL);
        assert.equal(hint?.dedicated, RX9070);
    });

    test("a ordem nao importa: a dedicada antes da integrada continua disable", () => {
        assert.equal(dualGpuHint([RX9070, RAPHAEL], false, true)?.kind, "disable");
    });

    test("com tela embutida, tela desconhecida ou a integrada ativa → laptop", () => {
        assert.equal(dualGpuHint([RAPHAEL, RX9070], true, true)?.kind, "laptop");
        assert.equal(dualGpuHint([RAPHAEL, RX9070], null, true)?.kind, "laptop");
        assert.equal(dualGpuHint([RAPHAEL, RX9070], undefined, true)?.kind, "laptop");
        assert.equal(dualGpuHint([{ ...RAPHAEL, active: true }, { ...RX9070, active: false }], false, true)?.kind, "laptop");
    });

    test("outros fabricantes", () => {
        assert.equal(dualGpuHint([RAPHAEL, RTX], false, true)?.kind, "disable", "AMD integrada + NVIDIA");
        assert.equal(dualGpuHint([UHD, RTX], true, true)?.kind, "laptop", "Intel UHD + RTX de notebook");
        assert.equal(dualGpuHint([UHD, ARC_B580], false, true)?.kind, "disable", "Intel UHD + Arc B580 de desktop");
    });

    test("sem integrada + dedicada: nada", () => {
        assert.equal(dualGpuHint([RTX, gpu(0x10DE, 0x2204, "NVIDIA GeForce RTX 3090", "NVIDIA")], false, true), null, "duas NVIDIA");
        assert.equal(dualGpuHint([RX9070, WARP], false, true), null, "uma placa + WARP");
        assert.equal(dualGpuHint([RX9070, NPU], false, true), null, "NPU nao conta");
        assert.equal(dualGpuHint([RAPHAEL, NPU], false, true), null, "NPU nao conta como dedicada");
    });

    test("sem lista (native antigo), lista vazia ou sem o registro do Baseline: nada", () => {
        assert.equal(dualGpuHint(undefined, false, true), null);
        assert.equal(dualGpuHint([], false, true), null);
        assert.equal(dualGpuHint([RAPHAEL, RX9070], false, false), null);
    });
});

describe("describeAdapters e os textos", () => {
    test("a linha do diagnostico do PC do amigo, e a do native antigo", () => {
        assert.equal(describeAdapters([RAPHAEL, RX9070], false),
            '#0 1002:164e "AMD Radeon(TM) Graphics" integrada, baixo consumo; #1 1002:7550 "AMD Radeon RX 9070 XT" dedicada, ativa, alto desempenho; tela embutida: não');
        assert.equal(describeAdapters(undefined, undefined), "? (parte nativa antiga)");
        assert.equal(describeAdapters([UHD, WARP, NPU], true),
            '#0 8086:a780 "Intel(R) UHD Graphics 770" integrada; #1 1414:008c "Microsoft Basic Render Driver" software; #2 8086:7d1d "Intel(R) AI Boost" NPU; tela embutida: sim');
        assert.equal(describeAdapters([], null), "? (getGPUInfo sem placas)");
    });

    test("disable: nomes reais, passos e o desfazer; laptop: nunca manda desativar", () => {
        const disable = dualGpuParagraphs(dualGpuHint([RAPHAEL, RX9070], false, true)!).join("\n");
        assert.ok(disable.includes("AMD Radeon(TM) Graphics") && disable.includes("AMD Radeon RX 9070 XT"));
        assert.ok(disable.includes("Desabilitar dispositivo") && disable.includes("Habilitar dispositivo"));
        const laptop = dualGpuParagraphs(dualGpuHint([UHD, RTX], true, true)!).join("\n");
        assert.ok(!laptop.includes("Desabilitar"));
        assert.ok(laptop.includes("VP9"));
    });

    test("o texto do desativar avisa do notebook; o do notebook muda conforme o codec fixado e a tela", () => {
        const disable = dualGpuParagraphs(dualGpuHint([RAPHAEL, RX9070], false, true)!);
        assert.ok(disable.includes("Não faça isso em notebook: a tela dele depende da placa de dentro do processador."));
        assert.equal(disable[1], "Não faça isso em notebook: a tela dele depende da placa de dentro do processador.", "logo depois da introdução");
        assert.ok(disable[0].includes("a que vem dentro do processador (AMD Radeon(TM) Graphics) e a placa de vídeo separada (AMD Radeon RX 9070 XT)"));
        assert.ok(disable.some(p => p.endsWith("→ Desabilitar dispositivo → Sim.")));

        const pinned = dualGpuParagraphs(dualGpuHint([UHD, RTX], true, true)!, { pinned: true }).join("\n");
        assert.ok(pinned.includes("Para transmitir, escolha o codec Automático nas configurações do Telinha: ele vai em VP9 (pelo processador)."));
        assert.ok(!pinned.includes("continua transmitindo"));

        const internal = dualGpuParagraphs(dualGpuHint([UHD, RTX], true, true)!).join("\n");
        assert.ok(internal.includes("Como ela também cuida da tela, não desative nada:") && internal.includes("continua transmitindo em VP9"));

        const unknown = dualGpuParagraphs(dualGpuHint([UHD, RTX], null, true)!).join("\n");
        assert.ok(unknown.includes("Ela pode estar cuidando da tela, então não desative nada:") && !unknown.includes("Como ela também"));
        const active = dualGpuParagraphs(dualGpuHint([{ ...RAPHAEL, active: true }, { ...RX9070, active: false }], false, true)!).join("\n");
        assert.ok(active.includes("Ela pode estar cuidando da tela") && !active.includes("Como ela também"));
    });

    test("aspas no nome da placa viram apóstrofo na linha do diagnóstico", () => {
        assert.ok(describeAdapters([{ ...RX9070, name: 'My "GPU"' }], false).includes("\"My 'GPU'\""));
    });

    test("sem nome: o texto usa as descricoes genericas", () => {
        const text = dualGpuParagraphs(dualGpuHint([{ ...RAPHAEL, name: "" }, { ...RX9070, name: "" }], false, true)!).join("\n");
        assert.ok(text.includes("a placa de dentro do processador") && text.includes("a placa de vídeo"));
    });
});
