/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Os ids de dispositivo de audio que o handler de display media (native.ts) entrega ao Chromium. Modulo proprio e puro
// (sem electron) porque o native.ts so pode exportar funcoes IPC (PluginNative); os testes importam daqui.
//
// Nada roda no carregamento do modulo.

const APP_LOOPBACK_RE = /^applicationLoopback:([1-9]\d{0,9})$/;

/**
 * O dispositivo do Chromium (Windows) que captura o som do PC EXCLUINDO a arvore do processo onde roda o servico de audio.
 * So e seguro com o servico de audio dentro do main do Discord: fora dele, a voz da call (renderer) vazaria na live.
 */
export const LOOPBACK_WITHOUT_CHROME = "loopbackWithoutChrome";

/** O Chromium da CHECK-crash com um id `applicationLoopback:` malformado: so passam formatos exatos. */
export function isValidLoopbackDevice(device: string) {
    const match = APP_LOOPBACK_RE.exec(device);
    return !!match && Number(match[1]) <= 0xFFFFFFFF;
}

/** O dispositivo so passa se combina com a fonte: applicationLoopback valido numa janela, loopbackWithoutChrome numa tela. */
export function deviceFitsSource(sourceId: string, device: string) {
    return sourceId.startsWith("screen:") ? device === LOOPBACK_WITHOUT_CHROME : sourceId.startsWith("window:") && isValidLoopbackDevice(device);
}
