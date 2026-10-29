/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Helpers de DOM do pacote WP-E.
//
// happy-dom: Animation.cancel() LANCA um AbortError na hora (no Chromium ele so rejeita animation.finished, sem
// lancar). Os spinners da UI (ui/callView/CallTileStream.tsx, ui/ViewerContent.tsx) animam com a Web Animations API e
// cancelam ao desmontar, entao o desmonte de qualquer aviso com spinner quebraria o teste. Aqui o animate() vira um
// que guarda as chamadas e cancela sem lancar.

import assert from "node:assert/strict";

/**
 * "Nao ha esse elemento": assert.equal(elemento, null) imprime o elemento INTEIRO (a arvore do happy-dom) quando
 * falha, e isso leva quase um minuto e encheu a memoria do processo. Aqui a mensagem e uma linha so.
 */
export function assertAbsent(node: unknown, message?: string): void {
    if (node === null || node === undefined) return;
    const el = node as { tagName?: string; textContent?: string | null; };
    const what = el.tagName ? `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").slice(0, 60)}"` : typeof node;
    assert.fail(`${message ?? "esperava que nao houvesse nada"}: mas ha ${what}`);
}

export interface RecordedAnimation {
    keyframes: unknown;
    options: unknown;
    cancelled: boolean;
}

export const animations = {
    started: [] as RecordedAnimation[],
    reset() {
        animations.started.length = 0;
    }
};

/** Troca Element.prototype.animate pelo gravador; devolve a funcao que poe o original de volta. */
export function installAnimate(): () => void {
    const proto = Element.prototype as unknown as { animate?: unknown; };
    const original = proto.animate;
    proto.animate = function (keyframes: unknown, options: unknown) {
        const record: RecordedAnimation = { keyframes, options, cancelled: false };
        animations.started.push(record);
        return {
            cancel() {
                record.cancelled = true;
            }
        };
    };
    return () => {
        proto.animate = original;
    };
}
