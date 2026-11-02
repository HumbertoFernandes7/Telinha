/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Página do plugin, logo abaixo das opções da live com jogo pesado (settings.ts → captureBoostStatus): o que cada uma faz
// agora (ligada, reinicie o Discord, não faz nada neste PC...) e o botão de reiniciar quando falta só isso
// (core/captureBoost.ts). Some quando não há nada a dizer.

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { captureBoostLines, captureBoostNeedsRestart, refreshGpuCapture, subscribeCaptureBoost } from "@plugins/telinha/core/captureBoost";
import { relaunchDiscord } from "@plugins/telinha/core/update";
import { settings } from "@plugins/telinha/settings";
import { showToast, useEffect, useState } from "@webpack/common";

import { cl } from "./common";

export function CaptureBoostStatus() {
    // re-renderiza quando as opcoes mudam e quando o main responde
    settings.use(["gpuCapture"]);
    const [, setVersion] = useState(0);
    useEffect(() => {
        const off = subscribeCaptureBoost(() => setVersion(v => v + 1));
        void refreshGpuCapture();
        return off;
    }, []);

    const lines = captureBoostLines();
    if (!lines.length) return null;
    const restart = () => {
        if (!relaunchDiscord()) showToast({ text: "Feche o Discord por completo (inclusive da bandeja) e abra de novo", variant: "default" });
    };

    return (
        <div className={cl("capture-boost")}>
            {lines.map(line => <Paragraph key={line}>{line}</Paragraph>)}
            {captureBoostNeedsRestart() && (
                <Button size="small" variant="secondary" onClick={restart}>
                    Reiniciar o Discord agora
                </Button>
            )}
        </div>
    );
}

/** O que settings.ts entrega ao Vencord (OptionType.COMPONENT chama a função direto, sem JSX). */
export function captureBoostStatusElement() {
    return <CaptureBoostStatus />;
}
