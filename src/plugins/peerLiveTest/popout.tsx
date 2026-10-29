/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Hosts for the received video: a Discord pop-out window (PopoutWindow wrapper, then raw content) or, as a
// fallback / "control" mode, a floating panel inside the main window. React only draws the frame around the
// media (title, overlay, fullscreen button); the strategy code (strategies.ts) puts its own <video>/<canvas>
// into the empty `container` div imperatively, created with that container's ownerDocument.

import ErrorBoundary from "@components/ErrorBoundary";
import { filters, find } from "@webpack";
import { createRoot, PopoutActions, PopoutWindowStore, useEffect, useRef } from "@webpack/common";
import type { ComponentType, CSSProperties } from "react";
import type { Root } from "react-dom/client";

import { sleep } from "./media";
import { errorText, log, logWarn, setState, useTestState } from "./state";
import type { PlayerHost, PopoutAttempt, StatsSample } from "./types";

// Discord's desktop app only lets window.open() through for frame names starting with "DISCORD_"
export const POPOUT_KEY = "DISCORD_PEERLIVE_TEST";
const MOUNT_TIMEOUT_MS = 6000;

export type HostKind = "popout" | "floating";

type StageEvent =
    | { type: "mounted"; id: number; host: PlayerHost; container: HTMLDivElement; }
    | { type: "unmounted"; id: number; }
    | { type: "error"; id: number; error: string; };

const stageListeners = new Set<(e: StageEvent) => void>();
const emit = (e: StageEvent) => stageListeners.forEach(l => l(e));
let stageSeq = 0;

export class HostHandle {
    closed = false;
    private readonly closeListeners = new Set<() => void>();
    private readonly cleanups: (() => void)[] = [];

    constructor(
        readonly id: number,
        readonly host: PlayerHost,
        readonly kind: HostKind,
        /** Window that owns `container` (the pop-out's own window object, or the main window) */
        readonly win: Window,
        readonly container: HTMLDivElement
    ) {
        if (kind === "popout") {
            const onHide = () => this.markClosed();
            win.addEventListener("pagehide", onHide);
            this.cleanups.push(() => {
                try {
                    win.removeEventListener("pagehide", onHide);
                } catch { }
            });
        }
    }

    /** Called once when the window/panel goes away (user closed it, run stopped, another host opened) */
    onClose(cb: () => void) {
        this.closeListeners.add(cb);
        return () => void this.closeListeners.delete(cb);
    }

    markClosed() {
        if (this.closed) return;
        this.closed = true;
        this.cleanups.forEach(c => c());
        for (const cb of [...this.closeListeners]) {
            try {
                cb();
            } catch (e) {
                logWarn("Falha num callback de fechamento da janela", errorText(e));
            }
        }
        this.closeListeners.clear();
    }
}

let current: HostHandle | null = null;
let floating: { root: Root; el: HTMLDivElement; } | null = null;

stageListeners.add(e => {
    if (e.type === "unmounted" && current?.id === e.id) {
        const closing = current;
        current = null;
        log(`Janela do player (${closing.host}) fechada`);
        closing.markClosed();
    }
});

export function getCurrentHost() {
    return current && !current.closed ? current : null;
}

function findPopoutWindowComponent(): ComponentType<any> | null {
    try {
        // Same lookup Equicord's SidebarChat uses for the wrapper that draws Discord's pop-out title bar
        return find(filters.componentByCode("Missing guestWindow reference"), { isIndirect: true }) ?? null;
    } catch {
        return null;
    }
}

function reportFullscreen(ok: boolean, error: string | null) {
    setState({ fullscreen: { ok, error } });
    if (ok) log("Tela cheia: OK");
    else logWarn("Tela cheia falhou", error);
}

function overlayLines(sample: StatsSample | null) {
    if (!sample) return ["aguardando estatísticas…"];

    const { recv, send, cpu } = sample;
    const hw = (v: boolean | null | undefined) => v == null ? "?" : v ? "HW" : "SW";
    return [
        recv
            ? `recebido ${recv.width ?? "?"}x${recv.height ?? "?"} @ ${recv.fps ?? "?"} fps${recv.decodeStalled ? " (SEM DECODIFICAR)" : ""} · ${recv.bitrateKbps != null ? (recv.bitrateKbps / 1000).toFixed(1) : "?"} Mbps · ${recv.decoderImplementation ?? "?"} (${hw(recv.powerEfficientDecoder)})`
            : "recebido: —",
        send
            ? `encoder ${send.encoderImplementation ?? "?"} (${hw(send.powerEfficientEncoder)}) · limitação: ${send.qualityLimitationReason ?? "?"}`
            : "enviado: —",
        cpu ? `CPU Discord ${cpu.totalPercentCPU}% de 1 núcleo (${cpu.normalizedPercentCPU}% da máquina)` : ""
    ].filter(Boolean);
}

function Stage({ id, host, fill }: { id: number; host: PlayerHost; fill: "viewport" | "parent"; }) {
    const boxRef = useRef<HTMLDivElement>(null);
    const mediaRef = useRef<HTMLDivElement>(null);
    const { lastSample, activeStrategy, sinkLive } = useTestState();

    useEffect(() => {
        const media = mediaRef.current;
        if (media) emit({ type: "mounted", id, host, container: media });
        return () => emit({ type: "unmounted", id });
    }, []);

    const toggleFullscreen = () => {
        const box = boxRef.current;
        if (!box) return;

        const doc = box.ownerDocument;
        const action = doc.fullscreenElement ? doc.exitFullscreen() : box.requestFullscreen();
        action.then(() => reportFullscreen(true, null), e => reportFullscreen(false, errorText(e)));
    };

    const boxStyle: CSSProperties = {
        position: "relative",
        width: "100%",
        height: fill === "viewport" ? "calc(100vh - 32px)" : "100%",
        minHeight: 180,
        background: "#000",
        overflow: "hidden"
    };

    const live = sinkLive && sinkLive.strategy === activeStrategy
        ? `exibindo ${sinkLive.fps ?? "?"} fps (${sinkLive.width}x${sinkLive.height}, ${sinkLive.frames} quadros)`
        : "aguardando quadros…";

    return (
        <div ref={boxRef} style={boxStyle}>
            {/* strategies.ts appends its <video>/<canvas> here; React never renders children into it */}
            <div ref={mediaRef} style={{ position: "absolute", inset: 0 }} />
            <div style={{ position: "absolute", top: 6, left: 6, padding: "4px 6px", borderRadius: 4, background: "rgba(0,0,0,0.6)", color: "#e6e6e6", font: "11px/1.4 monospace", pointerEvents: "none" }}>
                <div>{activeStrategy ? `estratégia: ${activeStrategy} · ${live}` : "sem estratégia ativa"}</div>
                {overlayLines(lastSample).map((line, i) => <div key={i}>{line}</div>)}
            </div>
            <button
                onClick={toggleFullscreen}
                style={{ position: "absolute", top: 6, right: 6, padding: "4px 10px", border: 0, borderRadius: 4, background: "rgba(88,101,242,0.9)", color: "#fff", font: "12px sans-serif", cursor: "pointer" }}
            >
                Tela cheia
            </button>
        </div>
    );
}

function FloatingPanel({ id, onClose }: { id: number; onClose(): void; }) {
    return (
        <div style={{ position: "fixed", right: 16, bottom: 16, width: 520, height: 330, zIndex: 10000, display: "flex", flexDirection: "column", background: "#000", border: "1px solid #444", borderRadius: 8, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", background: "#111", color: "#ddd", font: "12px sans-serif" }}>
                <span>PeerLive: painel flutuante no app</span>
                <button onClick={onClose} style={{ border: 0, borderRadius: 4, padding: "2px 8px", background: "#333", color: "#eee", cursor: "pointer" }}>Fechar</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <Stage id={id} host="painel flutuante no app" fill="parent" />
            </div>
        </div>
    );
}

function waitMount(id: number, isCancelled: () => boolean) {
    return new Promise<{ container: HTMLDivElement | null; error: string | null; }>(resolve => {
        let done = false;
        const finish = (v: { container: HTMLDivElement | null; error: string | null; }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearInterval(poll);
            stageListeners.delete(listener);
            resolve(v);
        };
        const listener = (e: StageEvent) => {
            if (e.id !== id) return;
            if (e.type === "mounted") finish({ container: e.container, error: null });
            else if (e.type === "error") finish({ container: null, error: e.error });
        };
        stageListeners.add(listener);
        const timer = setTimeout(() => finish({ container: null, error: `o player não montou em ${MOUNT_TIMEOUT_MS / 1000} s` }), MOUNT_TIMEOUT_MS);
        const poll = setInterval(() => isCancelled() && finish({ container: null, error: "cancelado" }), 100);
    });
}

async function attempt(host: PlayerHost, kind: HostKind, open: (id: number) => void, isCancelled: () => boolean): Promise<{ info: PopoutAttempt; handle: HostHandle | null; }> {
    const id = ++stageSeq;
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    const mount = waitMount(id, isCancelled);

    try {
        open(id);
    } catch (e) {
        emit({ type: "error", id, error: "abrir lançou: " + errorText(e) });
    }

    const { container, error } = await mount;
    if (!container) {
        let windowOpen: boolean | string;
        try {
            windowOpen = PopoutWindowStore?.getWindowOpen(POPOUT_KEY) ?? "PopoutWindowStore indisponível";
        } catch (e) {
            windowOpen = errorText(e);
        }
        const fullError = kind === "popout" ? `${error} (janela aberta segundo PopoutWindowStore: ${windowOpen})` : error;
        logWarn(`Player (${host}) não renderizou: ${fullError}`);
        return { info: { host, mounted: false, error: fullError, ms: ms() }, handle: null };
    }

    const win = container.ownerDocument.defaultView;
    if (!win) return { info: { host, mounted: false, error: "o documento do player não tem defaultView", ms: ms() }, handle: null };

    const handle = new HostHandle(id, host, kind, win, container);
    log(`Player montou em "${host}" após ${ms()} ms (${win === window ? "mesma janela" : "janela própria"})`);
    return { info: { host, mounted: true, error: null, ms: ms() }, handle };
}

function openPopoutWindow(host: PlayerHost, PopoutWindow: ComponentType<any> | null, isCancelled: () => boolean) {
    return attempt(host, "popout", id => {
        const render = () => (
            <ErrorBoundary onError={({ error }) => emit({ type: "error", id, error: errorText(error) })}>
                {PopoutWindow
                    ? (
                        <PopoutWindow withTitleBar windowKey={POPOUT_KEY} title="PeerLive: teste de captura">
                            <Stage id={id} host={host} fill="viewport" />
                        </PopoutWindow>
                    )
                    : (
                        <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 32, padding: "0 8px", background: "#111", color: "#ddd", font: "12px sans-serif" }}>
                                <span>PeerLive: teste de captura (pop-out sem a moldura do Discord)</span>
                                <button onClick={() => PopoutActions.close(POPOUT_KEY)} style={{ border: 0, borderRadius: 4, padding: "2px 8px", background: "#333", color: "#eee", cursor: "pointer" }}>Fechar</button>
                            </div>
                            <Stage id={id} host={host} fill="viewport" />
                        </div>
                    )}
            </ErrorBoundary>
        );

        PopoutActions.open(POPOUT_KEY, render, { defaultWidth: 960, defaultHeight: 600 });
    }, isCancelled);
}

function openFloatingPanel(isCancelled: () => boolean) {
    return attempt("painel flutuante no app", "floating", id => {
        const el = document.createElement("div");
        el.id = "vc-peerlive-test-floating";
        document.body.appendChild(el);

        const root = createRoot(el);
        floating = { root, el };
        root.render(
            <ErrorBoundary onError={({ error }) => emit({ type: "error", id, error: errorText(error) })}>
                <FloatingPanel id={id} onClose={closeHost} />
            </ErrorBoundary>
        );
    }, isCancelled);
}

function closePopoutWindow() {
    try {
        if (PopoutWindowStore?.getWindowOpen(POPOUT_KEY)) PopoutActions.close(POPOUT_KEY);
    } catch (e) {
        logWarn("Falha ao fechar o pop-out", errorText(e));
    }
}

function unmountFloating() {
    if (!floating) return;
    const { root, el } = floating;
    floating = null;
    try {
        root.unmount();
    } catch { }
    el.remove();
}

/** Closes whatever host is open (fires its onClose callbacks first) */
export function closeHost() {
    const closing = current;
    current = null;
    closing?.markClosed();
    closePopoutWindow();
    unmountFloating();
}

export interface HostOpenResult {
    handle: HostHandle | null;
    attempts: PopoutAttempt[];
    popoutWindowComponentFound: boolean | null;
    reused: boolean;
}

/**
 * Returns an open host of the requested kind, reusing the current one when possible.
 * Pop-out: Discord's PopoutWindow wrapper first, then raw content, then the floating panel as last resort.
 */
export async function openHost(kind: HostKind, isCancelled: () => boolean): Promise<HostOpenResult> {
    const existing = getCurrentHost();
    if (existing?.kind === kind) return { handle: existing, attempts: [], popoutWindowComponentFound: null, reused: true };

    if (existing || PopoutWindowStore?.getWindowOpen?.(POPOUT_KEY) || floating) {
        closeHost();
        await sleep(300);
    }

    const result: HostOpenResult = { handle: null, attempts: [], popoutWindowComponentFound: null, reused: false };

    if (kind === "popout") {
        const PopoutWindow = findPopoutWindowComponent();
        result.popoutWindowComponentFound = !!PopoutWindow;
        if (!PopoutWindow) logWarn("Pop-out: componente PopoutWindow NÃO encontrado (filtro \"Missing guestWindow reference\"); tentando conteúdo cru");

        const plan: PlayerHost[] = PopoutWindow ? ["popout+PopoutWindow", "popout (conteúdo cru)"] : ["popout (conteúdo cru)"];
        for (const host of plan) {
            if (isCancelled()) return result;
            const res = await openPopoutWindow(host, host === "popout+PopoutWindow" ? PopoutWindow : null, isCancelled);
            result.attempts.push(res.info);
            if (res.handle) {
                result.handle = res.handle;
                break;
            }
            closePopoutWindow();
            await sleep(500);
        }

        if (!result.handle && !isCancelled()) logWarn("O pop-out do Discord não renderizou; caindo para o painel flutuante dentro do app");
    }

    if (!result.handle && !isCancelled()) {
        const res = await openFloatingPanel(isCancelled);
        result.attempts.push(res.info);
        result.handle = res.handle;
    }

    if (result.handle && isCancelled()) {
        current = result.handle;
        closeHost();
        result.handle = null;
    } else if (result.handle) {
        current = result.handle;
    }

    return result;
}
