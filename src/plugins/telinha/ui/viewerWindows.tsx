/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// One viewer per watched stream. Each opens in its own Discord pop-out window (a real OS window that can go to
// another monitor); if the pop-out does not render within MOUNT_TIMEOUT_MS, it falls back to a draggable floating
// panel inside Discord (openViewer(peerId, { inApp: true }) opens that panel right away, without the pop-out).
// Closing the window/panel (by any means) calls unwatch(peerId) exactly once.
// The third kind is the "janelinha" (mode "pip"): a small frame that keeps playing the SAME session after the user leaves
// the call screen. openPip/dockPip never call watch/unwatch: opening reuses the session that is already running, docking
// (a tile of the friend mounted again) hands it back to the tile. Only its X (or the session ending) unwatches.

import ErrorBoundary from "@components/ErrorBoundary";
import { unwatch, watch } from "@plugins/telinha/actions";
import { getState } from "@plugins/telinha/store";
import type { PeerId } from "@plugins/telinha/types";
import { filters, find } from "@webpack";
import { createRoot, PopoutActions, PopoutWindowStore, showToast, useRef, useState } from "@webpack/common";
import type { ComponentType, PointerEvent as ReactPointerEvent } from "react";
import type { Root } from "react-dom/client";

import { cl, errorText, findPeer, logger, peerName, runAction } from "./common";
import { CloseIcon } from "./icons";
import { initialPipPos, type Pos, type Rect } from "./pipGeometry";
import { PipViewer } from "./PipViewer";
import { ViewerContent, ViewerMode } from "./ViewerContent";

// Discord's desktop app only lets window.open() through for frame names starting with "DISCORD_"
const KEY_PREFIX = "DISCORD_TELINHA_VIEWER_";
const MOUNT_TIMEOUT_MS = 6000;

interface ViewerRecord {
    peerId: PeerId;
    key: string;
    title: string;
    mode: ViewerMode;
    mounted: boolean;
    /** The pop-out was reported open by PopoutWindowStore at least once */
    sawOpen: boolean;
    /** Switching pop-out → floating: the pop-out closing must not end the session */
    switching: boolean;
    closed: boolean;
    /** Janelinha: clique nela (volta para a call); quem chamou openPip fornece */
    onReturn?: () => void;
    /** Janelinha: em que lugar da pilha (0 = o canto) ela abriu; o menor lugar livre vale para a proxima */
    pipSlot?: number;
    mountTimer?: ReturnType<typeof setTimeout>;
    floating?: { root: Root; el: HTMLDivElement; };
}

const viewers = new Map<PeerId, ViewerRecord>();
let storeListening = false;
let floatingCount = 0;
/** Onde a janelinha foi largada pela ultima vez (so memoria: some no reload) */
let lastPipPos: Pos | null = null;

let popoutWindowComponent: ComponentType<any> | null | undefined;

function getPopoutWindowComponent(): ComponentType<any> | null {
    if (popoutWindowComponent !== undefined) return popoutWindowComponent;

    let found: ComponentType<any> | null = null;
    try {
        // Same lookup the spike (and Equicord's SidebarChat) use for the wrapper that draws Discord's pop-out title bar
        found = find(filters.componentByCode("Missing guestWindow reference"), { isIndirect: true }) ?? null;
    } catch { }
    if (!found) logger.warn("Componente PopoutWindow do Discord não encontrado; o pop-out abre sem a moldura do Discord");

    popoutWindowComponent = found;
    return found;
}

function popoutKey(peerId: PeerId) {
    // Discord persists each pop-out's size/position by key: keying by the friend's Discord id makes each friend's
    // viewer reopen where it was last time (e.g. on the second monitor), and doesn't pile up one entry per session.
    const id = findPeer(getState(), peerId)?.discordUserId || peerId;
    return KEY_PREFIX + id.replace(/[^A-Za-z0-9_]/g, "_");
}

function isPopoutOpen(key: string) {
    try {
        return !!PopoutWindowStore?.getWindowOpen(key);
    } catch {
        return false;
    }
}

function closePopout(key: string) {
    try {
        if (isPopoutOpen(key)) PopoutActions.close(key);
    } catch (e) {
        logger.warn("Falha ao fechar o pop-out", errorText(e));
    }
}

function onPopoutStoreChange() {
    for (const rec of [...viewers.values()]) {
        if (rec.mode !== "popout" || rec.closed || rec.switching) continue;
        if (isPopoutOpen(rec.key)) rec.sawOpen = true;
        else if (rec.sawOpen) finalize(rec, "janela fechada");
    }
}

function ensureStoreListener() {
    if (storeListening || !PopoutWindowStore) return;
    try {
        PopoutWindowStore.addChangeListener(onPopoutStoreChange);
        storeListening = true;
    } catch (e) {
        logger.warn("Não consegui observar o PopoutWindowStore", errorText(e));
    }
}

function removeStoreListener() {
    if (!storeListening) return;
    try {
        PopoutWindowStore.removeChangeListener(onPopoutStoreChange);
    } catch { }
    storeListening = false;
}

/** Ends a viewer: unwatch once (unless `keepSession`: the session goes on elsewhere), then close whatever window/panel is still showing it */
function finalize(rec: ViewerRecord, reason: string, keepSession = false) {
    if (rec.closed) return;
    rec.closed = true;
    if (rec.mountTimer) clearTimeout(rec.mountTimer);
    if (viewers.get(rec.peerId) === rec) viewers.delete(rec.peerId);

    logger.info(`Visualizador de ${rec.peerId} encerrado (${reason})`);
    if (!keepSession) runAction("unwatch", () => unwatch(rec.peerId), msg => logger.warn("unwatch falhou", msg));

    if (rec.mode === "popout") closePopout(rec.key);
    unmountFloating(rec);

    if (!viewers.size) removeStoreListener();
}

function unmountFloating(rec: ViewerRecord) {
    const f = rec.floating;
    if (!f) return;
    rec.floating = undefined;
    // Unmounting synchronously from inside a React event handler of the same root is not allowed
    setTimeout(() => {
        try {
            f.root.unmount();
        } catch { }
        f.el.remove();
    }, 0);
}

function contentProps(rec: ViewerRecord, mode: ViewerMode) {
    return {
        peerId: rec.peerId,
        mode,
        onMounted() {
            if (rec.mode !== mode) return;
            rec.mounted = true;
            if (rec.mountTimer) clearTimeout(rec.mountTimer);
        },
        onUnmounted() {
            if (rec.closed || rec.mode !== mode) return;
            if (mode === "floating" || mode === "pip") {
                finalize(rec, "painel desmontado");
                return;
            }
            // The pop-out content goes away when its window closes; the store listener usually sees it first
            setTimeout(() => {
                if (!rec.closed && !rec.switching && rec.mode === "popout" && !isPopoutOpen(rec.key)) finalize(rec, "pop-out desmontado");
            }, 250);
        },
        onClose: () => finalize(rec, "parar de assistir")
    };
}

function openPopout(rec: ViewerRecord) {
    const PopoutWindow = getPopoutWindowComponent();

    const render = () => (
        <ErrorBoundary onError={({ error }) => logger.error("O player no pop-out quebrou", error)}>
            {PopoutWindow
                ? (
                    <PopoutWindow withTitleBar windowKey={rec.key} title={rec.title}>
                        <ViewerContent {...contentProps(rec, "popout")} />
                    </PopoutWindow>
                )
                : <ViewerContent {...contentProps(rec, "popout")} />}
        </ErrorBoundary>
    );

    PopoutActions.open(rec.key, render, { defaultWidth: 1280, defaultHeight: 760 });
    if (isPopoutOpen(rec.key)) rec.sawOpen = true;
}

function FloatingViewer({ rec, index }: { rec: ViewerRecord; index: number; }) {
    const [pos, setPos] = useState(() => ({
        x: Math.max(16, window.innerWidth - 560 - 24 - index * 28),
        y: Math.max(16, window.innerHeight - 360 - 24 - index * 28)
    }));
    const drag = useRef<{ dx: number; dy: number; } | null>(null);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if ((e.target as HTMLElement).closest("button")) return;
        drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        setPos({
            x: Math.min(Math.max(0, e.clientX - drag.current.dx), window.innerWidth - 120),
            y: Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - 40)
        });
    };
    const onPointerUp = () => void (drag.current = null);

    return (
        <div className={cl("floating")} style={{ left: pos.x, top: pos.y }}>
            <div
                className={cl("floating-header")}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            >
                <span className={cl("floating-title")}>{rec.title}</span>
                <button className={cl("floating-close")} aria-label="Fechar" title="Fechar" onClick={() => finalize(rec, "painel fechado")}>
                    <CloseIcon size={16} />
                </button>
            </div>
            <div className={cl("floating-body")}>
                <ViewerContent {...contentProps(rec, "floating")} />
            </div>
        </div>
    );
}

function openFloating(rec: ViewerRecord) {
    rec.mode = "floating";
    rec.switching = false;
    rec.mounted = false;

    const el = document.createElement("div");
    document.body.appendChild(el);

    const root = createRoot(el);
    rec.floating = { root, el };
    root.render(
        <ErrorBoundary onError={({ error }) => logger.error("O painel flutuante quebrou", error)}>
            <FloatingViewer rec={rec} index={floatingCount++ % 6} />
        </ErrorBoundary>
    );
}

function focusViewer(rec: ViewerRecord) {
    if (rec.mode === "popout") {
        try {
            PopoutWindowStore.getWindow(rec.key)?.focus();
        } catch { }
    } else if (rec.floating) {
        // Re-append to paint it above the other floating panels
        document.body.appendChild(rec.floating.el);
    }
}

/**
 * Starts watching `peerId` and opens its viewer window (or focuses it if it is already open). `inApp`: straight to the
 * floating panel inside Discord, no pop-out window (the voice tag uses it when the call screen shows no tile).
 */
export function openViewer(peerId: PeerId, opts: { inApp?: boolean; } = {}) {
    const existing = viewers.get(peerId);
    if (existing && !existing.closed) {
        focusViewer(existing);
        return;
    }

    const peer = findPeer(getState(), peerId);
    const rec: ViewerRecord = {
        peerId,
        key: popoutKey(peerId),
        title: `${peerName(peer)} — Telinha`,
        mode: opts.inApp ? "floating" : "popout",
        mounted: false,
        sawOpen: false,
        switching: false,
        closed: false
    };
    viewers.set(peerId, rec);

    runAction("watch", () => watch(peerId), message => {
        showToast({ text: `Telinha: não foi possível assistir — ${message}`, variant: "critical" });
        finalize(rec, "watch falhou");
    });
    if (rec.closed) return;

    if (opts.inApp) {
        openFloating(rec);
        return;
    }

    ensureStoreListener();

    const fallBack = (why: string) => {
        if (rec.closed) return;
        logger.warn(`Pop-out do visualizador indisponível (${why}); usando o painel flutuante dentro do Discord`);
        rec.switching = true;
        closePopout(rec.key);
        openFloating(rec);
    };

    try {
        if (isPopoutOpen(rec.key)) closePopout(rec.key); // leftover window with our key: would only be focused
        openPopout(rec);
    } catch (e) {
        fallBack("abrir lançou: " + errorText(e));
        return;
    }

    rec.mountTimer = setTimeout(() => {
        if (!rec.closed && !rec.mounted && rec.mode === "popout") fallBack(`o player não montou em ${MOUNT_TIMEOUT_MS / 1000} s`);
    }, MOUNT_TIMEOUT_MS);
}

/** Retangulos do PiP do proprio Discord (palpite: classes que os temas usam), para a janelinha nao ficar em cima */
function discordPipRects(): Rect[] {
    const rects: Rect[] = [];
    try {
        for (const el of document.querySelectorAll('[class*="pictureInPictureWindow"]')) {
            const { left, top, right, bottom } = el.getBoundingClientRect();
            rects.push({ left, top, right, bottom });
        }
    } catch { }
    return rects;
}

/**
 * Saiu da tela da call: a MESMA sessao continua na janelinha (nao chama watch: nada de reconectar).
 * false se ja ha um visualizador desse amigo (a janela dele continua dona)
 */
export function openPip(peerId: PeerId, opts: { onReturn(): void; }): boolean {
    const existing = viewers.get(peerId);
    if (existing && !existing.closed) return false;

    // O menor lugar da pilha que nenhuma janelinha aberta ocupa (fechar a de baixo nao joga a nova em cima da de cima)
    const used = new Set<number>();
    for (const v of viewers.values()) if (v.mode === "pip") used.add(v.pipSlot as number);
    let index = 0;
    while (used.has(index)) index++;

    const peer = findPeer(getState(), peerId);
    const rec: ViewerRecord = {
        peerId,
        key: popoutKey(peerId),
        title: peerName(peer),
        mode: "pip",
        mounted: false,
        sawOpen: false,
        switching: false,
        closed: false,
        onReturn: opts.onReturn,
        pipSlot: index
    };
    viewers.set(peerId, rec);

    const initial = initialPipPos({
        winW: window.innerWidth,
        winH: window.innerHeight,
        index,
        remembered: index === 0 ? lastPipPos : null,
        avoid: discordPipRects()
    });

    const el = document.createElement("div");
    document.body.appendChild(el);

    const root = createRoot(el);
    rec.floating = { root, el };
    root.render(
        <ErrorBoundary onError={({ error }) => logger.error("A janelinha quebrou", error)}>
            <PipViewer
                peerId={peerId}
                title={rec.title}
                initial={initial}
                content={contentProps(rec, "pip")}
                onReturn={opts.onReturn}
                onClose={why => finalize(rec, why)}
                onMoved={p => void (lastPipPos = p)}
            />
        </ErrorBoundary>
    );
    return true;
}

/** Uma tile do amigo montou: tira a janelinha SEM parar de assistir (a tile volta a ser dona). false se nao havia */
export function dockPip(peerId: PeerId): boolean {
    const rec = viewers.get(peerId);
    if (!rec || rec.closed || rec.mode !== "pip") return false;
    finalize(rec, "voltou para a call", true);
    return true;
}

export function closeViewer(peerId: PeerId) {
    const rec = viewers.get(peerId);
    if (rec) finalize(rec, "fechado pela UI");
}

export function isViewerOpen(peerId: PeerId) {
    const rec = viewers.get(peerId);
    return !!rec && !rec.closed;
}

/** Plugin stop: close every viewer (each one unwatches) */
export function closeAllViewers() {
    for (const rec of [...viewers.values()]) finalize(rec, "plugin parado");
    removeStoreListener();
}
