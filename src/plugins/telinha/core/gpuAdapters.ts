/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Dica "duas placas de video" (puro, sem Discord/Vencord): com o H.264 Baseline travado e um PC com uma placa integrada
// (dentro do processador) e uma dedicada, a integrada pode estar pegando a gravacao. A ordem das placas NAO decide (o
// MFTEnum2 pode listar a integrada primeiro mesmo filtrado pela dedicada); a ordem so aparece no diagnostico.
// A tabela de PCI ids e palpite (listas publicas pci.ids): erro = a dica nao aparece, ou aparece em duas dedicadas raras.

/** Uma placa de `gpuEnvironment().adapters` (native.ts), na ordem do Chromium. */
export interface GpuAdapter {
    vendorId: number;
    deviceId: number;
    /** deviceString do Chromium (nome do Windows) */
    name: string;
    driverVendor: string;
    driverVersion: string;
    active: boolean;
    /** gpuPreference do Chromium: 0 nenhum, 1 padrao, 2 baixo consumo, 3 alto desempenho */
    preference: number;
}

export interface DualGpuHint {
    /** "disable": sem tela embutida e a integrada nao desenha; "laptop": nunca mandar desativar */
    kind: "disable" | "laptop";
    integrated: GpuAdapter;
    dedicated: GpuAdapter;
}

const between = (n: number, lo: number, hi: number) => n >= lo && n <= hi;

/** Software, virtual ou sem fabricante: nao e uma placa de verdade. */
function isSoftware(a: GpuAdapter) {
    return a.vendorId === 0x0000 || a.vendorId === 0xFFFF || a.vendorId === 0x15AD || (a.vendorId === 0x1414 && a.deviceId === 0x008C);
}

/** As placas de verdade: sem software/virtual e sem NPU (sem `driverVendor`). */
export function realAdapters(list: readonly GpuAdapter[]): GpuAdapter[] {
    return list.filter(a => !isSoftware(a) && a.driverVendor !== "");
}

/** Integrada (dentro do processador)? Pela tabela de PCI ids; fabricante fora dela: so pelo gpuPreference (2 com outra em 3). */
export function isIntegrated(a: GpuAdapter, list: readonly GpuAdapter[] = [a]): boolean {
    const d = a.deviceId;
    switch (a.vendorId) {
        case 0x1002:
            return d < 0x6000 || between(d, 0x9640, 0x964F) || between(d, 0x9800, 0x99FF);
        case 0x8086:
            return !(between(d, 0x4905, 0x4909) || between(d, 0x5690, 0x56CF) || between(d, 0xE200, 0xE2FF));
        case 0x10DE:
            return false;
        default:
            return a.preference === 2 && realAdapters(list).some(o => o !== a && o.preference === 3);
    }
}

/** A dica das duas placas, ou null. `stuck` = existe o registro do H.264 Baseline (os de High/H.265/AV1 nao contam). */
export function dualGpuHint(adapters: readonly GpuAdapter[] | undefined, internalDisplay: boolean | null | undefined, stuck: boolean): DualGpuHint | null {
    if (!stuck || !adapters?.length) return null;
    const real = realAdapters(adapters);
    const integrated = real.find(a => isIntegrated(a, adapters));
    const dedicated = real.find(a => a !== integrated && !isIntegrated(a, adapters));
    if (!integrated || !dedicated) return null;
    return { kind: internalDisplay === false && integrated.active === false ? "disable" : "laptop", integrated, dedicated };
}

const hex = (n: number) => n.toString(16).padStart(4, "0");
const PREFERENCE = ["", "", "baixo consumo", "alto desempenho"];

/** A linha do diagnostico: todas as placas na ordem do Chromium e se ha tela embutida. */
export function describeAdapters(adapters: readonly GpuAdapter[] | undefined, internalDisplay: boolean | null | undefined): string {
    if (!adapters) return "? (parte nativa antiga)";
    const list = adapters.map((a, i) => {
        const tags = [
            isSoftware(a) ? "software" : a.driverVendor === "" ? "NPU" : isIntegrated(a, adapters) ? "integrada" : "dedicada",
            ...(a.active ? ["ativa"] : []),
            ...(PREFERENCE[a.preference] ? [PREFERENCE[a.preference]] : [])
        ];
        return `#${i} ${hex(a.vendorId)}:${hex(a.deviceId)} "${a.name}" ${tags.join(", ")}`;
    });
    const display = internalDisplay === true ? "sim" : internalDisplay === false ? "não" : "?";
    return `${list.length ? list.join("; ") : "nenhuma"}; tela embutida: ${display}`;
}

/** O texto da dica, um parágrafo por item (nomes reais das placas). */
export function dualGpuParagraphs(hint: DualGpuHint): string[] {
    const integrated = hint.integrated.name || "a placa de dentro do processador";
    const dedicated = hint.dedicated.name || "a placa de vídeo";
    if (hint.kind === "laptop") {
        return [
            "Este PC tem duas placas de vídeo, e a de dentro do processador pode estar pegando a gravação da transmissão. "
            + "Como ela também cuida da tela, não desative nada: o Telinha continua transmitindo em VP9 (pelo processador), só gasta um pouco mais."
        ];
    }
    return [
        `Este PC tem duas placas de vídeo: a que vem dentro do processador (${integrated}) e a placa de vídeo (${dedicated}). `
        + "Pode ser que a de dentro do processador esteja pegando a gravação da transmissão e travando. Para usar só a placa de vídeo:",
        "1. Confira que o cabo do monitor está ligado na placa de vídeo, e não na saída da placa-mãe.",
        `2. Clique com o botão direito no Iniciar → Gerenciador de Dispositivos → Adaptadores de vídeo → botão direito em "${integrated}" → Desabilitar dispositivo.`,
        "3. Aperte \"Tentar a placa de vídeo de novo\" aqui embaixo e reinicie o Discord (feche por completo e abra de novo).",
        "Para desfazer: no mesmo lugar, botão direito nela → Habilitar dispositivo. "
        + "Se a tela apagar, passe o cabo do monitor para a placa de vídeo, ou reinicie o PC e habilite de novo."
    ];
}

/** O rabicho do aviso ao vivo da barra quando a dica existe. */
export const DUAL_GPU_BAR_SUFFIX = " Este PC tem duas placas de vídeo: veja a dica nas configurações do Telinha.";
