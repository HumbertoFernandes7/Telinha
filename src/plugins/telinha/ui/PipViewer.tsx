/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A moldura da janelinha: o video que fica flutuando no canto do Discord quando se sai da tela da call. Ela so cuida do
// quadro (posicao, arraste, clique, barra com nome/voltar/X e o fim da transmissao); o video e o som sao do
// ViewerContent em modo "pip". Vive so na janela principal (que tem o CSS do Vencord), por isso o quadro usa classes.
// Clique sem arrastar = voltar para a call; arrastar muda de lugar; o X para de assistir. Quem fecha a janelinha e
// quem chamou (onClose): este componente nunca se desmonta sozinho.

import { useTelinhaState } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import { useEffect, useRef, useState } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { cl } from "./common";
import { CloseIcon } from "./icons";
import { clampPip, isDrag, type Pos } from "./pipGeometry";
import { ViewerContent, type ViewerContentProps } from "./ViewerContent";

/** Depois de "A transmissão terminou", a janelinha some sozinha em tanto tempo (o X fecha na hora) */
export const PIP_ENDED_CLOSE_MS = 4000;

export interface PipViewerProps {
    peerId: PeerId;
    /** "<nome> — Telinha" */
    title: string;
    /** Onde abre (vem de initialPipPos) */
    initial: Pos;
    /** Props do player, em modo "pip" (montadas por viewerWindows.contentProps) */
    content: ViewerContentProps;
    /** Clique sem arraste (ou o botao "Voltar para a call") */
    onReturn(): void;
    /** X, a sessao acabou ou a transmissao terminou; `reason` vai para o log */
    onClose(reason: string): void;
    /** Fim de um arraste (para lembrar o lugar na proxima janelinha) */
    onMoved(pos: Pos): void;
}

interface DragState {
    /** Onde o ponteiro estava (tela) e onde a janelinha estava quando apertou */
    startX: number;
    startY: number;
    from: Pos;
    /** Ja passou do limite de clique */
    moved: boolean;
}

export function PipViewer({ peerId, title, initial, content, onReturn, onClose, onMoved }: PipViewerProps) {
    const state = useTelinhaState();
    const session = state.viewing[peerId];
    const status = session?.status;

    const [pos, setPos] = useState<Pos>(() => initial);
    // A posicao mais recente, lida no pointerup (o estado do React ainda pode nao ter assentado)
    const posRef = useRef<Pos>(initial);
    const drag = useRef<DragState | null>(null);

    // Os callbacks mudam de identidade a cada render do chamador; os efeitos abaixo leem sempre o ultimo
    const cb = useRef({ onReturn, onClose, onMoved });
    cb.current = { onReturn, onClose, onMoved };

    const place = (p: Pos) => {
        posRef.current = p;
        setPos(p);
    };

    useEffect(() => {
        const onResize = () => place(clampPip(posRef.current, window.innerWidth, window.innerHeight));
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    // A sessao existia e sumiu (saiu da call de voz, o core largou): nao ha o que mostrar. Avisa uma vez so
    const sawSession = useRef(false);
    const goneNotified = useRef(false);
    useEffect(() => {
        if (session) {
            sawSession.current = true;
        } else if (sawSession.current && !goneNotified.current) {
            goneNotified.current = true;
            cb.current.onClose("a sessão acabou");
        }
    }, [session]);

    // O amigo parou de transmitir: deixa ler o aviso e fecha. `error` fica aberta (o clique leva a tile, "Tentar de novo")
    useEffect(() => {
        if (status !== "ended") return;
        const timer = setTimeout(() => cb.current.onClose("a transmissão terminou"), PIP_ENDED_CLOSE_MS);
        return () => clearTimeout(timer);
    }, [status]);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        drag.current = { startX: e.clientX, startY: e.clientY, from: posRef.current, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.moved && !isDrag(dx, dy)) return;
        d.moved = true;
        place(clampPip({ x: d.from.x + dx, y: d.from.y + dy }, window.innerWidth, window.innerHeight));
    };

    const onPointerUp = () => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        if (d.moved) cb.current.onMoved(posRef.current);
        else cb.current.onReturn();
    };

    // Cancelado (o sistema tomou o toque): nao e clique, so larga o arraste
    const onPointerCancel = () => void (drag.current = null);

    return (
        <div
            className={cl("pip")}
            style={{ left: pos.x, top: pos.y }}
            role="group"
            aria-label={title}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
        >
            <div className={cl("pip-body")}>
                <ViewerContent {...content} />
            </div>
            <div className={cl("pip-bar")}>
                <span className={cl("pip-title")}>{title}</span>
                <button className={cl("pip-button")} aria-label="Voltar para a call" title="Voltar para a call" onClick={() => cb.current.onReturn()}>
                    <span aria-hidden="true">↩</span>
                </button>
                <button className={cl("pip-button")} aria-label="Parar de assistir" title="Parar de assistir" onClick={() => cb.current.onClose("janelinha fechada")}>
                    <CloseIcon size={16} />
                </button>
            </div>
        </div>
    );
}
