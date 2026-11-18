/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Página do plugin (settings.ts → screenAudioChromium): "Som da tela pelo próprio Discord (sem o ajudante)", com o estado
// (ligado nesta partida, pedido para a próxima, desligado) e o interruptor, que grava o pedido para a próxima partida do
// Discord (core/screenAudioChromium.ts). Falta só reabrir o Discord: o botão de reiniciar.

import { Button } from "@components/Button";
import { FormSwitch } from "@components/FormSwitch";
import {
    refreshScreenAudioChromium,
    screenAudioChromiumLine,
    screenAudioChromiumNeedsRestart,
    screenAudioFlagState,
    setScreenAudioChromiumWanted,
    subscribeScreenAudioChromium
} from "@plugins/telinha/core/screenAudioChromium";
import { relaunchDiscord } from "@plugins/telinha/core/update";
import { showToast, useEffect, useState } from "@webpack/common";

import { cl } from "./common";

export function ScreenAudioChromiumOption() {
    const [, setVersion] = useState(0);
    useEffect(() => {
        const off = subscribeScreenAudioChromium(() => setVersion(v => v + 1));
        void refreshScreenAudioChromium();
        return off;
    }, []);

    const st = screenAudioFlagState();
    const restart = () => {
        if (!relaunchDiscord()) showToast({ text: "Feche o Discord por completo (inclusive da bandeja) e abra de novo", variant: "default" });
    };

    return (
        <div className={cl("capture-boost")}>
            <FormSwitch
                title="Som da tela pelo próprio Discord (sem o ajudante)"
                description={screenAudioChromiumLine(st)}
                value={st?.saved === true}
                disabled={!st?.loader}
                onChange={v => void setScreenAudioChromiumWanted(v)}
                hideBorder
            />
            {screenAudioChromiumNeedsRestart(st) && (
                <Button size="small" variant="secondary" onClick={restart}>
                    Reiniciar o Discord agora
                </Button>
            )}
        </div>
    );
}

/** O que settings.ts entrega ao Vencord (OptionType.COMPONENT chama a função direto, sem JSX). */
export function screenAudioChromiumElement() {
    return <ScreenAudioChromiumOption />;
}
