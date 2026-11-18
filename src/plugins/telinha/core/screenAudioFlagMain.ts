/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE: importado apenas pelo native.ts.
//
// O som da tela pelo proprio Chromium do Discord: o dispositivo loopbackWithoutChrome captura o som do Windows EXCLUINDO a
// arvore do processo onde roda o servico de audio. Para a exclusao pegar o Discord inteiro (a voz da call toca no
// renderer), o servico de audio tem que rodar DENTRO do main: o Discord precisa abrir com
// --disable-features=AudioServiceOutOfProcess,RestrictOwnAudioAddChromiumBack. Como o "Captura pela placa de vídeo" e o AV1,
// so vale a partir da partida do Discord: quem aplica e o loader do add-on (addon/loader/main.js → applyCaptureFlags), que
// le a chave screenAudioInChromium do %APPDATA%\Telinha\capture-flags.json antes do app ficar pronto e publica o que fez em
// globalThis.__TelinhaAddon.capture.screenAudioInChromium ({ asked, applied, disableFeatures }). Aqui so se grava a chave
// (para a proxima partida) e se le o que o loader fez nesta.
//
// Nada roda no carregamento do modulo.

import { MIN_WINDOWS_BUILD } from "./audio/screenAudioMain";
import { loaderCapture, readCaptureFlags, writeCaptureFlags } from "./captureBoostMain";

/** O disable-features do som da tela nesta partida do Discord e o que esta salvo para a proxima. */
export interface ScreenAudioFlagStatus {
    /** o loader do add-on desta partida sabe aplicar o pedido (false: build do fork, loader antigo ou --vanilla) */
    loader: boolean;
    /** o capture-flags.json pede o recurso agora (vale na proxima partida) */
    saved: boolean;
    /** o usuario desligou pelo interruptor (a ligacao automatica nao religa ate ele ligar de novo) */
    userOff: boolean;
    /** build do Windows visto pelo loader (0 = desconhecido) */
    build: number;
    /** o arquivo pedia o recurso quando o Discord abriu */
    requested: boolean;
    /** as duas features estavam no disable-features quando o app ficou pronto; null = nao foi pedido */
    applied: boolean | null;
    /** o disable-features final visto pelo loader no app ready; null = nao foi pedido */
    disableFeatures: string | null;
    /** o loader nao conseguiu aplicar o pedido (em ingles, do main.log); null = sem erro */
    loaderReason: string | null;
    /** a ultima gravacao falhou (em pt-BR) */
    saveError: string | null;
}

interface LoaderScreenAudio {
    asked?: unknown;
    applied?: unknown;
    disableFeatures?: unknown;
    reason?: unknown;
}

/** O loader desta partida conhece a chave (um loader de antes desta versao nao publica screenAudioInChromium). */
function screenAudioLoader() {
    const capture = loaderCapture();
    const state = capture?.screenAudioInChromium as LoaderScreenAudio | null | undefined;
    return capture && state && typeof state === "object" && typeof state.asked === "boolean" ? { capture, state } : null;
}

export function screenAudioFlagStatusMain(saveError: string | null = null): ScreenAudioFlagStatus {
    const loader = screenAudioLoader();
    return {
        loader: !!loader,
        saved: loader ? readCaptureFlags(loader.capture.file).screenAudioInChromium : false,
        userOff: loader ? readCaptureFlags(loader.capture.file).screenAudioInChromiumUserOff : false,
        build: typeof loader?.capture.build === "number" ? loader.capture.build : 0,
        requested: loader?.state.asked === true,
        applied: typeof loader?.state.applied === "boolean" ? loader.state.applied : null,
        disableFeatures: typeof loader?.state.disableFeatures === "string" && loader.state.disableFeatures ? loader.state.disableFeatures.slice(0, 500) : null,
        loaderReason: typeof loader?.state.reason === "string" && loader.state.reason ? loader.state.reason.slice(0, 300) : null,
        saveError
    };
}

/** Windows velho demais para o loopback por processo (mesmo minimo do ajudante: core/audio/screenAudioMain.ts); null = serve. */
export function screenAudioWindowsProblem(build: number): string | null {
    return build >= MIN_WINDOWS_BUILD ? null : `o som da tela pelo Chromium exige Windows 10 versão 2004 ou mais novo (este é o build ${build || "?"})`;
}

/**
 * Grava o pedido para a proxima partida do Discord (so a chave screenAudioInChromium; as outras ficam como estao). Sem o
 * loader do add-on que conhece a chave, nao grava nada. Nunca lanca: o erro volta em saveError.
 */
export function setScreenAudioFlagMain(on: boolean): ScreenAudioFlagStatus {
    const loader = screenAudioLoader();
    if (!loader) return screenAudioFlagStatusMain();
    if (on === true) {
        const old = screenAudioWindowsProblem(screenAudioFlagStatusMain().build);
        if (old) return screenAudioFlagStatusMain(old);
    }
    try {
        // ligar apaga o "desligado pelo usuario"; desligar o grava (a ligacao automatica respeita)
        writeCaptureFlags(loader.capture.file, { screenAudioInChromium: on === true, screenAudioInChromiumUserOff: on !== true });
        return screenAudioFlagStatusMain();
    } catch (e) {
        return screenAudioFlagStatusMain(`não consegui salvar o pedido do som da tela pelo Chromium (${e instanceof Error ? e.message : String(e)})`.slice(0, 300));
    }
}
