/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Página do plugin: a placa de vídeo que travou com H.264 neste PC (core/stuckEncoder.ts). Só aparece com o travamento
// lembrado: a linha "A placa de vídeo travou com H.264 neste PC em 31/10; usando VP9." e o botão que esquece o
// travamento para o automático tentar o H.264 da placa de novo. Também aparece com o AV1 salvo como "offHw" (o Chromium
// trocou a placa pelo software): a linha diz que o AV1 saiu da placa e o mesmo botão o esquece (forgetStuckEncoder).

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { dualGpuParagraphs } from "@plugins/telinha/core/gpuAdapters";
import { av1ProbeRecord, dualGpuTip, environment, forgetStuckEncoder, type RetryOutcome, shortDate, stuckLine, stuckRecord } from "@plugins/telinha/core/stuckEncoder";
import { settings } from "@plugins/telinha/settings";
import { showToast, useEffect, useState } from "@webpack/common";

/** O aviso depois do botao, conforme o que ele fez (core/stuckEncoder.ts → forgetStuckEncoder). */
const RETRY_TOAST: Record<RetryOutcome, string> = {
    testing: "Pronto: testando a placa de vídeo agora. Se ela não travar no teste, a próxima pessoa que assistir recebe o H.264 dela.",
    restart: "Pronto: a placa de vídeo é testada de novo quando você reiniciar o Discord.",
    now: "Pronto: a próxima pessoa que assistir recebe o H.264 da placa de vídeo de novo."
};

export function StuckEncoderSection() {
    // re-renderiza quando o registro muda (o botao, ou um travamento novo com a pagina aberta)
    settings.withPrivateSettings<{ stuckHwH264?: unknown; hwAv1Probe?: unknown; }>().use(["stuckHwH264", "hwAv1Probe"]);
    // a lista de placas chega junto com o ambiente (lido uma vez por sessao): re-renderiza quando ele chega
    const [, setVersion] = useState(0);
    useEffect(() => {
        let alive = true;
        void environment().then(() => {
            if (alive) setVersion(v => v + 1);
        });
        return () => {
            alive = false;
        };
    }, []);
    const record = stuckRecord();
    const tip = record ? dualGpuTip() : null;
    // o AV1 que saiu da placa (offHw): o botao tambem o esquece; so o "travou" de verdade fica
    const av1 = av1ProbeRecord();
    const av1Off = av1?.verdict === "offHw" ? av1 : null;
    if (!record && !av1Off) return null;

    const retry = () => {
        showToast({ text: RETRY_TOAST[forgetStuckEncoder()], variant: "success" });
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            {record && <Paragraph>{stuckLine(record)}</Paragraph>}
            {tip && dualGpuParagraphs(tip).map(paragraph => <Paragraph key={paragraph}>{paragraph}</Paragraph>)}
            {av1Off && <Paragraph>{`O AV1 saiu da placa de vídeo neste PC em ${shortDate(av1Off.at)}; ele fica desligado até você tentar de novo.`}</Paragraph>}
            <Button size="small" variant="secondary" onClick={retry}>
                Tentar a placa de vídeo de novo
            </Button>
        </div>
    );
}
