/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts (que so pode exportar handlers IPC).
// A trava do som da tela pelo Chromium (loopbackWithoutChrome). Nada roda no carregamento do modulo.

import { app } from "electron";

import { screenAudioFlagStatusMain, screenAudioWindowsProblem } from "./screenAudioFlagMain";

function errorText(e: unknown) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** O som da tela pelo Chromium do Discord da para usar AGORA? `reason` em pt-BR (para o log e a UI). */
export interface ScreenAudioChromiumStatus {
    available: boolean;
    reason: string;
}

/** O servico de audio do Chromium (audio.mojom.AudioService, "Audio Service") num processo Utility. */
const AUDIO_SERVICE_RE = /audio/i;

/**
 * A trava do som da tela pelo Chromium. Passa SO com as duas coisas: (1) o loader do add-on aplicou nesta partida o
 * --disable-features=AudioServiceOutOfProcess,RestrictOwnAudioAddChromiumBack (core/screenAudioFlagMain.ts → applied
 * === true) e (2) o app.getAppMetrics() nao mostra o servico de audio num processo Utility (um Utility sem nome tambem
 * reprova: nao da para provar que nao e o de audio). Qualquer duvida reprova: a voz da call nunca vai para a live.
 */
export function screenAudioChromiumStatusMain(): ScreenAudioChromiumStatus {
    const flag = screenAudioFlagStatusMain();
    if (!flag.loader)
        return { available: false, reason: "o carregador do add-on desta partida do Discord não sabe ligar o som da tela pelo Chromium (atualize o Telinha e reabra o Discord)" };
    const old = screenAudioWindowsProblem(flag.build);
    if (old) return { available: false, reason: old };
    if (flag.applied !== true) {
        if (flag.requested && flag.applied === false)
            return { available: false, reason: "o Discord abriu sem as opções do som da tela pelo Chromium (outro programa pode ter mudado o disable-features); reabra o Discord" };
        if (flag.saved) return { available: false, reason: "o som da tela pelo Chromium foi pedido para a próxima partida: reabra o Discord para ativar" };
        return { available: false, reason: "o som da tela pelo Chromium não está ligado nesta partida do Discord" };
    }

    let metrics: unknown;
    try {
        metrics = app.getAppMetrics();
    } catch (e) {
        return { available: false, reason: `não consegui ver os processos do Discord para confirmar onde roda o serviço de áudio (${errorText(e).slice(0, 120)})` };
    }
    if (!Array.isArray(metrics))
        return { available: false, reason: "não consegui ver os processos do Discord para confirmar onde roda o serviço de áudio" };
    for (const m of metrics as { type?: unknown; serviceName?: unknown; name?: unknown; pid?: unknown; }[]) {
        if (m?.type !== "Utility") continue;
        const service = typeof m.serviceName === "string" ? m.serviceName : "";
        const name = typeof m.name === "string" ? m.name : "";
        if (!service && !name)
            return { available: false, reason: "um processo auxiliar do Discord sem nome pode ser o serviço de áudio; reabra o Discord" };
        if (AUDIO_SERVICE_RE.test(service) || AUDIO_SERVICE_RE.test(name))
            return { available: false, reason: `o serviço de áudio do Discord ainda roda separado (processo ${typeof m.pid === "number" ? m.pid : "?"}); reabra o Discord por completo, inclusive da bandeja` };
    }
    return { available: true, reason: "o serviço de áudio roda dentro do processo principal do Discord: o som da tela sai sem o Discord" };
}
