/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A opcao "Aceleracao de hardware" do Discord (Configuracoes → Avancado). Sem ela o Discord nao decodifica o video pela
// placa de video, e a live pesa o PC de quem transmite; por isso quem esta com ela desligada nao assiste (core/viewing.ts).
// Tudo vem do DiscordNative.gpuSettings, no renderer; se o Discord nao expoe isso (versao antiga, outro cliente) o
// estado e "desconhecido" (null) e ninguem e bloqueado. Nada roda ao carregar o modulo.

import { errorText, log } from "./log";

type GpuSettings = { getEnableHardwareAcceleration?: unknown; setEnableHardwareAcceleration?: unknown; };

function gpuSettings(): GpuSettings | undefined {
    return (globalThis as { DiscordNative?: { gpuSettings?: GpuSettings; }; }).DiscordNative?.gpuSettings;
}

/** true = ligada, false = DESLIGADA, null = nao deu para saber. Valor em vigor desde que o Discord abriu. Nunca lanca. */
export function discordHwAccelSetting(): boolean | null {
    try {
        const gs = gpuSettings();
        if (typeof gs?.getEnableHardwareAcceleration !== "function") return null;
        const value = (gs.getEnableHardwareAcceleration as () => unknown).call(gs);
        return typeof value === "boolean" ? value : null;
    } catch {
        return null;
    }
}

/** Liga a opcao e o Discord reinicia sozinho (o proprio setEnableHardwareAcceleration faz o relaunch). false = nao deu. */
export function enableHwAccelAndRestart(): boolean {
    try {
        const gs = gpuSettings();
        if (typeof gs?.setEnableHardwareAcceleration !== "function") {
            log.warn("Aceleração de hardware: o Discord não expõe como ligar sozinho");
            return false;
        }
        (gs.setEnableHardwareAcceleration as (on: boolean) => unknown).call(gs, true);
        log.info("Aceleração de hardware: ligada pelo Telinha, o Discord vai reiniciar");
        return true;
    } catch (e) {
        log.warn(`Aceleração de hardware: não consegui ligar (${errorText(e)})`);
        return false;
    }
}

/** A linha do "Copiar diagnóstico". */
export function hwAccelDiagnostics(): string {
    const s = discordHwAccelSetting();
    return `aceleração de hardware do Discord: ${s === null ? "desconhecida" : s ? "ligada" : "DESLIGADA"}`;
}
