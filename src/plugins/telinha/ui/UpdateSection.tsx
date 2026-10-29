/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Página do plugin: versão instalada, "Procurar atualização" e a linha de status (em dia / baixando / pronto,
// reinicie / erro curto). O trabalho fica no processo main (core/update.ts → addon/loader/updater.js).

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import {
    type AddonUpdateStatus, checkForUpdateNow, describeUpdate, downloadUpdateNow, getUpdateStatus, refreshUpdateStatus,
    relaunchDiscord, subscribeUpdates, updatesSupported
} from "@plugins/telinha/core/update";
import { showToast, useEffect, useState } from "@webpack/common";

import { cl } from "./common";

export function UpdateSection() {
    const [status, setStatus] = useState<AddonUpdateStatus | null>(getUpdateStatus());
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const off = subscribeUpdates(() => setStatus(getUpdateStatus()));
        void refreshUpdateStatus();
        return off;
    }, []);

    if (!updatesSupported())
        return <Paragraph>Versão: desconhecida. A atualização automática só funciona com o Telinha instalado pelo TelinhaInstaller.</Paragraph>;

    const inProgress = status?.phase === "checking" || status?.phase === "downloading";
    const working = busy || inProgress;
    // right after the click, before the main process reports "checking"
    const line = busy && !inProgress ? "Procurando atualização…" : describeUpdate(status);
    const run = (fn: () => Promise<unknown>) => {
        setBusy(true);
        fn().finally(() => setBusy(false));
    };
    const restart = () => {
        if (!relaunchDiscord()) showToast({ text: "Feche o Discord por completo e abra de novo para usar a versão nova", variant: "default" });
    };

    return (
        <div className={cl("update")}>
            <Paragraph>
                Versão instalada: <strong>{status?.installed?.version ?? "…"}</strong>
            </Paragraph>
            <Paragraph className={cl("update-status")}>{line}</Paragraph>
            <div className={cl("update-buttons")}>
                <Button size="small" variant="secondary" disabled={working} onClick={() => run(checkForUpdateNow)}>
                    Procurar atualização
                </Button>
                {status?.phase === "available" && (
                    <Button size="small" disabled={working} onClick={() => run(downloadUpdateNow)}>
                        Atualizar
                    </Button>
                )}
                {status?.phase === "ready" && (
                    <Button size="small" onClick={restart}>
                        Reiniciar agora
                    </Button>
                )}
            </div>
        </div>
    );
}
