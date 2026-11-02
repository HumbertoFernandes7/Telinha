/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts.
//
// O AV1 da placa de video (o lado do renderer e o core/av1Flag.ts): no Windows, o WebRTC do Chromium 152 so usa o encoder
// AV1 da placa com o recurso WebRtcAV1HWEncode, desligado por padrao no Windows (rtc_video_encoder_factory.cc; sem ele, o
// AV1 do WebRTC e o libaom por software). Como o "Captura pela placa de vídeo", so vale a partir da partida do Discord:
// quem liga e o loader do add-on (addon/loader/main.js → applyCaptureFlags), que le a chave av1HwEncode do
// %APPDATA%\Telinha\capture-flags.json antes do app ficar pronto e publica o que fez em globalThis.__TelinhaAddon.capture
// (av1HwEncode, av1Applied). Aqui so se grava a chave (para a proxima partida) e se le o que o loader fez nesta.
//
// Nada roda no carregamento do modulo.

import { loaderCapture, readCaptureFlags, writeCaptureFlags } from "./captureBoostMain";

/** O que o WebRtcAV1HWEncode faz nesta partida do Discord e o que esta salvo para a proxima. */
export interface Av1FlagStatus {
    /** o loader do add-on desta partida sabe ligar o recurso (false: build do fork, loader antigo ou --vanilla) */
    loader: boolean;
    /** o capture-flags.json pede o recurso agora (vale na proxima partida) */
    saved: boolean;
    /** o arquivo pedia o recurso quando o Discord abriu */
    requested: boolean;
    /** o recurso estava no enable-features quando o app ficou pronto; null = nao foi pedido */
    applied: boolean | null;
    /** a ultima gravacao falhou (em pt-BR) */
    saveError: string | null;
}

/** O loader desta partida conhece a chave do AV1 (um loader de antes desta versao nao publica av1HwEncode). */
function av1Loader() {
    const capture = loaderCapture();
    return capture && typeof capture.av1HwEncode === "boolean" ? capture : null;
}

export function av1FlagStatusMain(saveError: string | null = null): Av1FlagStatus {
    const capture = av1Loader();
    return {
        loader: !!capture,
        saved: capture ? readCaptureFlags(capture.file).av1HwEncode : false,
        requested: capture?.av1HwEncode === true,
        applied: typeof capture?.av1Applied === "boolean" ? capture.av1Applied : null,
        saveError
    };
}

/**
 * Grava o pedido do recurso para a proxima partida do Discord (so a chave av1HwEncode; a "Captura pela placa de vídeo"
 * fica como esta). Sem o loader do add-on que conhece a chave, nao grava nada. Nunca lanca: o erro volta em saveError.
 */
export function setAv1FlagMain(on: boolean): Av1FlagStatus {
    const capture = av1Loader();
    if (!capture) return av1FlagStatusMain();
    try {
        writeCaptureFlags(capture.file, { av1HwEncode: on === true });
        return av1FlagStatusMain();
    } catch (e) {
        return av1FlagStatusMain(`não consegui salvar o pedido do AV1 da placa (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
    }
}
