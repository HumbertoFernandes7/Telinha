/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Assistir dentro da tela da call do Discord (estilo Go Live). index.tsx espalha `callViewPatches` em `patches` e
// expoe `renderCallTileStream` no definePlugin (o patch chama `$self.renderCallTileStream`).
// Nada aqui roda no carregamento do modulo: React e os stores so sao lidos quando o Discord renderiza uma tile.

import { logger } from "@plugins/telinha/ui/common";
import { React } from "@webpack/common";

import { CallTileStream } from "./CallTileStream";
import { resetTileState } from "./tileState";

export { callViewPatches } from "./patches";

/**
 * Chamado pelo CallTile do Discord a cada render, logo depois do conteudo da tile (avatar/camera).
 * @param participant o participante da tile (`{ type, id, user, ... }`)
 * @param isUser `participant.type === USER`, calculado com o enum do proprio Discord (tiles de Go Live, atividades e
 *   streams escondidos ficam de fora)
 */
export function renderCallTileStream(participant: unknown, isUser: unknown) {
    try {
        if (isUser !== true) return null;
        const p = participant as { user?: { id?: unknown; }; } | null | undefined;
        const userId = p?.user?.id;
        if (typeof userId !== "string" || !userId) return null;
        return React.createElement(CallTileStream, { userId });
    } catch (e) {
        logger.error("renderCallTileStream falhou", e);
        return null;
    }
}

/** plugin stop(): esquece o estado das tiles (as sessoes ja sao encerradas pelo stopSession) */
export function stopCallView() {
    try {
        resetTileState();
    } catch (e) {
        logger.error("stopCallView falhou", e);
    }
}
