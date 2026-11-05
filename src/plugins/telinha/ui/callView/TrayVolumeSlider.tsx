/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O controle de volume da barra da call (o patch em patches.ts troca o slider do Discord por este componente).
// Quando a tile em foco esta tocando a live do amigo, o controle mexe no volume da live (ui/volumes.ts) e nao no volume
// da voz dele: nunca chama setLocalVolume nem toggleLocalMute. Em qualquer outro caso (sem live, contexto "stream",
// usuario invalido) devolve o slider do Discord intacto, e se este componente quebrar o ErrorBoundary tambem.

import ErrorBoundary from "@components/ErrorBoundary";
import { logger } from "@plugins/telinha/ui/common";
import { useVolume } from "@plugins/telinha/ui/volumes";
import { React } from "@webpack/common";
import type { ComponentType } from "react";

import { getTileAudioKey, registerTrayBar, useTrayVersion } from "./trayVolume";

interface Props {
    /** o slider do Discord */
    Slider: ComponentType<any>;
    /** as props que o Discord daria ao slider */
    discordProps: Record<string, any>;
    userId: unknown;
    context: unknown;
}

function Takeover({ Slider, discordProps, userId, volumeKey }: Pick<Props, "Slider" | "discordProps"> & { userId: string; volumeKey: string; }) {
    const [{ volume, muted }, set] = useVolume(volumeKey);

    // a janela desta barra (a da call pode ser a solta do Discord); sem uma valida, a principal
    const win: Window = typeof discordProps.currentWindow === "object" && discordProps.currentWindow !== null ? discordProps.currentWindow : window;
    React.useEffect(() => registerTrayBar(userId, win), [userId, win]);

    return (
        <Slider
            {...discordProps}
            value={muted ? 0 : Math.round(volume * 100)}
            muted={muted}
            maxValue={100}
            onValueChange={(v: number) => set({ volume: v / 100, muted: v === 0 })}
            onToggleMute={() => set(muted && volume === 0 ? { volume: 1, muted: false } : { volume, muted: !muted })} // desmutar em 0 devolve o som
        />
    );
}

function TrayVolumeInner({ Slider, discordProps, userId, context }: Props) {
    useTrayVersion();
    const volumeKey = context === "default" && typeof userId === "string" ? getTileAudioKey(userId) : null;
    if (volumeKey === null || typeof userId !== "string") return <Slider {...discordProps} />;
    return <Takeover Slider={Slider} discordProps={discordProps} userId={userId} volumeKey={volumeKey} />;
}

export const TrayVolume = ErrorBoundary.wrap(TrayVolumeInner, {
    displayName: "TelinhaTrayVolume",
    fallback: ({ wrappedProps }) => <wrappedProps.Slider {...wrappedProps.discordProps} />,
    onError: ({ error }) => logger.error("O volume da barra da call do Telinha quebrou", error)
});
