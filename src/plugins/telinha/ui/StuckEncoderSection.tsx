/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Página do plugin: a placa de vídeo que travou com H.264 neste PC (core/stuckEncoder.ts). Só aparece com o travamento
// lembrado: a linha "A placa de vídeo travou com H.264 neste PC em 31/10; usando VP9." e o botão que esquece o
// travamento para o automático tentar o H.264 da placa de novo.

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { forgetStuckEncoder, type RetryOutcome, stuckLine, stuckRecord } from "@plugins/telinha/core/stuckEncoder";
import { settings } from "@plugins/telinha/settings";
import { showToast } from "@webpack/common";

/** O aviso depois do botao, conforme o que ele fez (core/stuckEncoder.ts → forgetStuckEncoder). */
const RETRY_TOAST: Record<RetryOutcome, string> = {
    testing: "Pronto: testando a placa de vídeo agora. Se ela não travar no teste, a próxima pessoa que assistir recebe o H.264 dela.",
    restart: "Pronto: a placa de vídeo é testada de novo quando você reiniciar o Discord.",
    now: "Pronto: a próxima pessoa que assistir recebe o H.264 da placa de vídeo de novo."
};

export function StuckEncoderSection() {
    // re-renderiza quando o registro muda (o botao, ou um travamento novo com a pagina aberta)
    settings.withPrivateSettings<{ stuckHwH264?: unknown; }>().use(["stuckHwH264"]);
    const record = stuckRecord();
    if (!record) return null;

    const retry = () => {
        showToast({ text: RETRY_TOAST[forgetStuckEncoder()], variant: "success" });
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <Paragraph>{stuckLine(record)}</Paragraph>
            <Button size="small" variant="secondary" onClick={retry}>
                Tentar a placa de vídeo de novo
            </Button>
        </div>
    );
}
