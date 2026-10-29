/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { filters, find } from "@webpack";
import { createRoot, PopoutActions, PopoutWindowStore, useEffect, useRef } from "@webpack/common";
import type { ComponentType, CSSProperties } from "react";
import type { Root } from "react-dom/client";

import { sleep, verifyVideoPlayback } from "./media";
import { errorText, getState, log, logError, logWarn, setState, useTestState } from "./state";
import type { PlaybackCheck, PlayerHost, PopoutAttempt, PopoutResult, StatsSample } from "./types";

// Discord's desktop app only lets window.open() through for frame names starting with "DISCORD_"
export const POPOUT_KEY = "DISCORD_PEERLIVE_TEST";
const MOUNT_TIMEOUT_MS = 6000;
const CHECK_TIMEOUT_MS = 20000;

type PlayerEvent =
    | { type: "mounted"; host: PlayerHost; }
    | { type: "error"; host: PlayerHost; error: string; }
    | { type: "check"; host: PlayerHost; check: PlaybackCheck; };

const playerListeners = new Set<(e: PlayerEvent) => void>();
const emit = (e: PlayerEvent) => playerListeners.forEach(l => l(e));

let floating: { root: Root; el: HTMLDivElement; } | null = null;
/** Bumped by closePlayer() so an openPlayer() still in progress does not reopen anything afterwards */
let generation = 0;

function findPopoutWindowComponent(): ComponentType<any> | null {
    try {
        // Same lookup Equicord's SidebarChat uses for the wrapper that draws Discord's pop-out title bar
        return find(filters.componentByCode("Missing guestWindow reference"), { isIndirect: true }) ?? null;
    } catch {
        return null;
    }
}

function reportFullscreen(ok: boolean, error: string | null) {
    const { popout } = getState();
    if (popout) setState({ popout: { ...popout, fullscreen: { ok, error } } });
    if (ok) log("Tela cheia: OK");
    else logWarn("Tela cheia falhou", error);
}

function overlayLines(sample: StatsSample | null) {
    if (!sample) return ["aguardando estatísticas…"];

    const { recv, send, cpu } = sample;
    const hw = (v: boolean | null | undefined) => v == null ? "?" : v ? "HW" : "SW";
    return [
        recv
            ? `recebido ${recv.width ?? "?"}x${recv.height ?? "?"} @ ${recv.fps ?? "?"} fps · ${recv.bitrateKbps != null ? (recv.bitrateKbps / 1000).toFixed(1) : "?"} Mbps · ${recv.decoderImplementation ?? "?"} (${hw(recv.powerEfficientDecoder)})`
            : "recebido: —",
        send
            ? `encoder ${send.encoderImplementation ?? "?"} (${hw(send.powerEfficientEncoder)}) · limitação: ${send.qualityLimitationReason ?? "?"}`
            : "enviado: —",
        cpu ? `CPU Discord ${cpu.totalPercentCPU}% (${cpu.normalizedPercentCPU}% da máquina)` : ""
    ].filter(Boolean);
}

function Player({ stream, host, fill }: { stream: MediaStream; host: PlayerHost; fill: "viewport" | "parent"; }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const { lastSample } = useTestState();

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        emit({ type: "mounted", host });
        video.srcObject = stream;
        video.play().catch(e => logWarn(`play() no player (${host})`, errorText(e)));

        let cancelled = false;
        verifyVideoPlayback(video, host, 3000).then(check => {
            if (!cancelled) emit({ type: "check", host, check });
        });

        return () => {
            cancelled = true;
            video.srcObject = null;
        };
    }, [stream]);

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

    return (
        <div ref={boxRef} style={boxStyle}>
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
            />
            <div style={{ position: "absolute", top: 6, left: 6, padding: "4px 6px", borderRadius: 4, background: "rgba(0,0,0,0.6)", color: "#e6e6e6", font: "11px/1.4 monospace", pointerEvents: "none" }}>
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

function FloatingPanel({ stream }: { stream: MediaStream; }) {
    return (
        <div style={{ position: "fixed", right: 16, bottom: 16, width: 520, height: 330, zIndex: 10000, display: "flex", flexDirection: "column", background: "#000", border: "1px solid #444", borderRadius: 8, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", background: "#111", color: "#ddd", font: "12px sans-serif" }}>
                <span>PeerLive: painel flutuante (fallback do pop-out)</span>
                <button onClick={closePlayer} style={{ border: 0, borderRadius: 4, padding: "2px 8px", background: "#333", color: "#eee", cursor: "pointer" }}>Fechar</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <Player stream={stream} host="painel flutuante no app" fill="parent" />
            </div>
        </div>
    );
}

function watchPlayer(host: PlayerHost) {
    let resolveMount!: (v: { ok: boolean; error: string | null; }) => void;
    let resolveCheck!: (v: PlaybackCheck | null) => void;
    const mounted = new Promise<{ ok: boolean; error: string | null; }>(r => resolveMount = r);
    const check = new Promise<PlaybackCheck | null>(r => resolveCheck = r);

    const listener = (e: PlayerEvent) => {
        if (e.host !== host) return;
        if (e.type === "mounted") resolveMount({ ok: true, error: null });
        else if (e.type === "check") resolveCheck(e.check);
        else {
            resolveMount({ ok: false, error: e.error });
            resolveCheck(null);
        }
    };
    playerListeners.add(listener);

    const timer = setTimeout(() => resolveMount({ ok: false, error: `o player não montou em ${MOUNT_TIMEOUT_MS / 1000} s` }), MOUNT_TIMEOUT_MS);

    return {
        mounted,
        check: Promise.race([check, sleep(CHECK_TIMEOUT_MS).then(() => null)]),
        dispose() {
            clearTimeout(timer);
            playerListeners.delete(listener);
        }
    };
}

async function attempt(host: PlayerHost, open: (onError: (error: unknown) => void) => void): Promise<{ info: PopoutAttempt; check: Promise<PlaybackCheck | null>; }> {
    const t0 = performance.now();
    const watch = watchPlayer(host);
    const ms = () => Math.round(performance.now() - t0);

    try {
        open(error => emit({ type: "error", host, error: errorText(error) }));
    } catch (e) {
        watch.dispose();
        return { info: { host, mounted: false, error: "abrir lançou: " + errorText(e), ms: ms() }, check: Promise.resolve(null) };
    }

    const mount = await watch.mounted;
    if (!mount.ok) {
        watch.dispose();
        let windowOpen: boolean | string;
        try {
            windowOpen = PopoutWindowStore?.getWindowOpen(POPOUT_KEY) ?? "PopoutWindowStore indisponível";
        } catch (e) {
            windowOpen = errorText(e);
        }
        const error = `${mount.error} (janela aberta segundo PopoutWindowStore: ${windowOpen})`;
        logWarn(`Player (${host}) não renderizou: ${error}`);
        return { info: { host, mounted: false, error, ms: ms() }, check: Promise.resolve(null) };
    }

    log(`Player montou em "${host}" após ${ms()} ms; verificando reprodução…`);
    return {
        info: { host, mounted: true, error: null, ms: ms() },
        check: watch.check.finally(() => watch.dispose())
    };
}

function openPopoutWindow(stream: MediaStream, host: PlayerHost, PopoutWindow: ComponentType<any> | null) {
    return attempt(host, onError => {
        const render = () => (
            <ErrorBoundary onError={({ error }) => onError(error)}>
                {PopoutWindow
                    ? (
                        <PopoutWindow withTitleBar windowKey={POPOUT_KEY} title="PeerLive: teste de captura">
                            <Player stream={stream} host={host} fill="viewport" />
                        </PopoutWindow>
                    )
                    : (
                        <div style={{ width: "100vw", height: "100vh", background: "#000" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 32, padding: "0 8px", background: "#111", color: "#ddd", font: "12px sans-serif" }}>
                                <span>PeerLive: teste de captura (pop-out sem a moldura do Discord)</span>
                                <button onClick={() => PopoutActions.close(POPOUT_KEY)} style={{ border: 0, borderRadius: 4, padding: "2px 8px", background: "#333", color: "#eee", cursor: "pointer" }}>Fechar</button>
                            </div>
                            <Player stream={stream} host={host} fill="viewport" />
                        </div>
                    )}
            </ErrorBoundary>
        );

        PopoutActions.open(POPOUT_KEY, render, { defaultWidth: 960, defaultHeight: 600 });
    });
}

function openFloatingPanel(stream: MediaStream) {
    return attempt("painel flutuante no app", onError => {
        const el = document.createElement("div");
        el.id = "vc-peerlive-test-floating";
        document.body.appendChild(el);

        const root = createRoot(el);
        floating = { root, el };
        root.render(
            <ErrorBoundary onError={({ error }) => onError(error)}>
                <FloatingPanel stream={stream} />
            </ErrorBoundary>
        );
    });
}

function closePopoutWindow() {
    try {
        if (PopoutWindowStore?.getWindowOpen(POPOUT_KEY)) PopoutActions.close(POPOUT_KEY);
    } catch (e) {
        logWarn("Falha ao fechar o pop-out", errorText(e));
    }
}

export function closePlayer() {
    generation++;
    closePopoutWindow();

    if (floating) {
        const { root, el } = floating;
        floating = null;
        try {
            root.unmount();
        } catch { }
        el.remove();
    }
}

/**
 * Shows the RECEIVED stream in a Discord pop-out window. Tries Discord's PopoutWindow wrapper first,
 * then raw content in the pop-out, then an in-app floating panel. Verifies playback programmatically.
 */
export async function openPlayer(stream: MediaStream): Promise<PopoutResult> {
    closePlayer();
    const gen = generation;
    const cancelled = () => gen !== generation;
    await sleep(300);

    const PopoutWindow = findPopoutWindowComponent();
    const result: PopoutResult = {
        at: new Date().toISOString(),
        popoutWindowComponentFound: !!PopoutWindow,
        attempts: [],
        host: null,
        playback: null,
        fullscreen: null,
        cancelled: false
    };

    if (PopoutWindow) log("Pop-out: componente PopoutWindow do Discord encontrado");
    else logWarn("Pop-out: componente PopoutWindow NÃO encontrado (filtro \"Missing guestWindow reference\"); tentando conteúdo cru");

    const plan: PlayerHost[] = PopoutWindow ? ["popout+PopoutWindow", "popout (conteúdo cru)"] : ["popout (conteúdo cru)"];

    let check: Promise<PlaybackCheck | null> = Promise.resolve(null);
    for (const host of plan) {
        if (cancelled()) break;
        const res = await openPopoutWindow(stream, host, host === "popout+PopoutWindow" ? PopoutWindow : null);
        result.attempts.push(res.info);
        if (res.info.mounted) {
            result.host = host;
            check = res.check;
            break;
        }
        closePopoutWindow();
        await sleep(500);
    }

    if (!result.host && !cancelled()) {
        logWarn("O pop-out do Discord não renderizou; caindo para o painel flutuante dentro do app");
        const res = await openFloatingPanel(stream);
        result.attempts.push(res.info);
        if (res.info.mounted) {
            result.host = res.info.host;
            check = res.check;
        }
    }

    result.playback = await check;
    result.cancelled = cancelled();

    if (result.cancelled) logWarn("Abertura do player cancelada (teste parado ou player reaberto)");
    else if (!result.host) logError("Nenhum player renderizou (pop-out e painel flutuante falharam)", result.attempts);
    else if (result.playback?.ok) log(`Player em "${result.host}" reproduzindo: ${result.playback.videoWidth}x${result.playback.videoHeight}, ${result.playback.measuredFps} fps medidos`, result.playback);
    else logError(`Player em "${result.host}" montou mas a reprodução não foi confirmada: ${result.playback?.error ?? "verificação expirou"}`, result.playback);

    return result;
}
