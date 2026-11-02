/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Página do plugin, logo abaixo de "Formato de vídeo" (settings.ts → codecStatus): com o AV1 fixado, o que falta para ele
// ir (reinicie o Discord, esta placa não codifica AV1...) e o botão de reiniciar quando falta só isso (core/av1Flag.ts).
// Some quando não há nada a dizer.

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { av1FlagNeedsRestart, codecStatusLines, refreshAv1Flag, subscribeAv1Flag } from "@plugins/telinha/core/av1Flag";
import { relaunchDiscord } from "@plugins/telinha/core/update";
import { settings } from "@plugins/telinha/settings";
import { showToast, useEffect, useState } from "@webpack/common";

import { cl } from "./common";

export function CodecStatus() {
    // re-renderiza quando o formato muda e quando o main responde
    settings.use(["codec"]);
    const [, setVersion] = useState(0);
    useEffect(() => {
        const off = subscribeAv1Flag(() => setVersion(v => v + 1));
        void refreshAv1Flag();
        return off;
    }, []);

    const lines = codecStatusLines();
    if (!lines.length) return null;
    const restart = () => {
        if (!relaunchDiscord()) showToast({ text: "Feche o Discord por completo (inclusive da bandeja) e abra de novo", variant: "default" });
    };

    return (
        <div className={cl("capture-boost")}>
            {lines.map(line => <Paragraph key={line}>{line}</Paragraph>)}
            {av1FlagNeedsRestart() && (
                <Button size="small" variant="secondary" onClick={restart}>
                    Reiniciar o Discord agora
                </Button>
            )}
        </div>
    );
}

/** O que settings.ts entrega ao Vencord (OptionType.COMPONENT chama a função direto, sem JSX). */
export function codecStatusElement() {
    return <CodecStatus />;
}
