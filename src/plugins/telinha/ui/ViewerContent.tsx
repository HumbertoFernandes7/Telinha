/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The player shown inside a viewer window (Discord pop-out) or the in-app floating panel. It plays the main
// window's MediaStream directly in a <video> created by the host document ("direct" strategy from the spike:
// 1080p at ~49 fps in the pop-out). Everything here is styled inline: pop-outs don't receive Vencord's CSS.

import { useTelinhaState } from "@plugins/telinha/store";
import type { PeerId, ViewerSession } from "@plugins/telinha/types";
import { useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode, RefObject } from "react";

import { ACCENT, errorText, findPeer, logger, peerName } from "./common";
import { CloseIcon, FullscreenIcon, StopIcon, VolumeIcon } from "./icons";

export type ViewerMode = "popout" | "floating";

/** Volume per Discord user, kept while Discord is open so reopening a friend's stream keeps the level */
const volumes = new Map<string, { volume: number; muted: boolean; }>();

const CONTROLS_IDLE_MS = 2500;

const FONT = "var(--font-primary, \"gg sans\", \"Noto Sans\", sans-serif)";

const rootStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    height: "100%",
    minHeight: 160,
    background: "#000",
    overflow: "hidden",
    color: "#f2f3f5",
    font: `14px/1.35 ${FONT}`,
    userSelect: "none"
};

const mediaStyle: CSSProperties = { position: "absolute", inset: 0 };

const overlayStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
    textAlign: "center",
    background: "rgba(0, 0, 0, 0.72)"
};

const topBarStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px 24px",
    background: "linear-gradient(rgba(0, 0, 0, 0.7), transparent)",
    pointerEvents: "none",
    transition: "opacity 150ms ease"
};

const bottomBarStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "24px 12px 10px",
    background: "linear-gradient(transparent, rgba(0, 0, 0, 0.78))",
    transition: "opacity 150ms ease"
};

const buttonBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    padding: "0 12px",
    border: 0,
    borderRadius: 6,
    color: "#fff",
    font: `600 13px ${FONT}`,
    cursor: "pointer",
    whiteSpace: "nowrap"
};

const ghostButton: CSSProperties = { ...buttonBase, padding: "0 8px", background: "rgba(255, 255, 255, 0.12)" };
const dangerButton: CSSProperties = { ...buttonBase, background: "#da373c" };
const accentButton: CSSProperties = { ...buttonBase, background: ACCENT };

const spinnerStyle: CSSProperties = {
    width: 34,
    height: 34,
    borderRadius: "50%",
    border: "3px solid rgba(255, 255, 255, 0.2)",
    borderTopColor: "#fff"
};

/** Spinner animated with the Web Animations API (no stylesheet needed in the pop-out) */
function Spinner() {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const anim = ref.current?.animate?.([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 900, iterations: Infinity });
        return () => anim?.cancel();
    }, []);
    return <div ref={ref} style={spinnerStyle} />;
}

interface OverlayInfo {
    title: string;
    detail?: string;
    spinner?: boolean;
    closable?: boolean;
}

function getOverlay(session: ViewerSession | undefined, hadSession: boolean): OverlayInfo | null {
    if (!session) {
        return hadSession
            ? { title: "A transmissão terminou", closable: true }
            : { title: "Conectando…", spinner: true };
    }

    switch (session.status) {
        case "connecting":
            return { title: "Conectando…", spinner: true };
        case "waiting-first-frame":
            return { title: "Aguardando a primeira imagem…", spinner: true };
        case "playing":
            return session.stream ? null : { title: "Aguardando a primeira imagem…", spinner: true };
        case "ended":
            return { title: "A transmissão terminou", closable: true };
        case "error":
            return { title: "Não foi possível assistir a esta transmissão", detail: session.error, closable: true };
        default:
            return null;
    }
}

/** Keeps `el` exactly as tall as the space left in its window (pop-outs have a title bar of unknown height) */
function useFillWindow(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
    useLayoutEffect(() => {
        const el = ref.current;
        const win = el?.ownerDocument.defaultView;
        if (!enabled || !el || !win) return;

        const update = () => {
            const top = Math.max(0, el.getBoundingClientRect().top);
            el.style.height = `${Math.max(160, win.innerHeight - top)}px`;
        };
        update();
        // Discord's pop-out title bar may lay out after us
        const late = setTimeout(update, 400);
        win.addEventListener("resize", update);
        return () => {
            clearTimeout(late);
            win.removeEventListener("resize", update);
        };
    }, [enabled]);
}

export interface ViewerContentProps {
    peerId: PeerId;
    mode: ViewerMode;
    /** Called once the player is in the DOM (the window manager uses it to know the pop-out worked) */
    onMounted(doc: Document): void;
    onUnmounted(): void;
    /** "Parar de assistir" / "Fechar" */
    onClose(): void;
}

export function ViewerContent({ peerId, mode, onMounted, onUnmounted, onClose }: ViewerContentProps) {
    const state = useTelinhaState();
    const session = state.viewing[peerId] as ViewerSession | undefined;
    const peer = findPeer(state, peerId);
    const name = peerName(peer);
    const stream = session?.stream ?? null;

    const rootRef = useRef<HTMLDivElement>(null);
    const mediaRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const hadSession = useRef(false);
    if (session) hadSession.current = true;

    const volumeKey = peer?.discordUserId ?? peerId;
    const saved = volumes.get(volumeKey) ?? { volume: 1, muted: false };
    const [volume, setVolume] = useState(saved.volume);
    const [muted, setMuted] = useState(saved.muted);
    const [autoplayBlocked, setAutoplayBlocked] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const [active, setActive] = useState(true);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useFillWindow(rootRef, mode === "popout");

    useEffect(() => {
        const root = rootRef.current;
        if (root) onMounted(root.ownerDocument);
        idleTimer.current = setTimeout(() => setActive(false), CONTROLS_IDLE_MS);
        return () => {
            if (idleTimer.current) clearTimeout(idleTimer.current);
            onUnmounted();
        };
    }, []);

    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc) return;
        if (mode === "popout") doc.title = `${name} — Telinha`;

        const onChange = () => setFullscreen(doc.fullscreenElement === rootRef.current);
        doc.addEventListener("fullscreenchange", onChange);
        return () => doc.removeEventListener("fullscreenchange", onChange);
    }, [name]);

    // Attach the stream to a <video> owned by this window's document
    useEffect(() => {
        const container = mediaRef.current;
        if (!container || !stream) return;

        const video = container.ownerDocument.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = muted;
        video.volume = volume;
        Object.assign(video.style, { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: "contain", background: "#000" });
        container.appendChild(video);
        videoRef.current = video;
        setAutoplayBlocked(false);

        video.srcObject = stream;
        video.play().catch(e => {
            if ((e as DOMException)?.name !== "NotAllowedError") {
                logger.warn("play() do player falhou", errorText(e));
                return;
            }
            // Autoplay with sound refused: play muted and offer a click to turn the sound on
            setAutoplayBlocked(true);
            video.muted = true;
            video.play().catch(err => logger.warn("play() mudo também falhou", errorText(err)));
        });

        return () => {
            videoRef.current = null;
            try {
                video.pause();
                video.srcObject = null;
                video.remove();
            } catch { }
        };
    }, [stream]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.volume = volume;
        video.muted = muted || autoplayBlocked;
        volumes.set(volumeKey, { volume, muted });
    }, [volume, muted, autoplayBlocked, stream]);

    const hasAudio = (stream?.getAudioTracks().length ?? 0) > 0 || !!peer?.stream?.hasAudio;
    const overlay = getOverlay(session, hadSession.current);
    const showControls = active || overlay != null;

    const poke = () => {
        if (!active) setActive(true);
        if (idleTimer.current) clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => setActive(false), CONTROLS_IDLE_MS);
    };

    const toggleFullscreen = () => {
        const root = rootRef.current;
        if (!root) return;
        const doc = root.ownerDocument;
        const action = doc.fullscreenElement ? doc.exitFullscreen() : root.requestFullscreen();
        action.catch(e => logger.warn("Tela cheia falhou", errorText(e)));
    };

    const enableSound = () => {
        setAutoplayBlocked(false);
        setMuted(false);
        const video = videoRef.current;
        if (video) {
            video.muted = false;
            video.play().catch(e => logger.warn("play() com som falhou", errorText(e)));
        }
    };

    const stats = session?.stats;
    const statsText = stats && stats.width && stats.height
        ? `${stats.width}×${stats.height} · ${Math.round(stats.fps)} fps${stats.kbps ? ` · ${(stats.kbps / 1000).toFixed(1)} Mbps` : ""}`
        : null;

    let soundControls: ReactNode = null;
    if (hasAudio && autoplayBlocked) {
        soundControls = (
            <button style={accentButton} onClick={enableSound}>
                <VolumeIcon muted={true} />
                Ativar som
            </button>
        );
    } else if (hasAudio) {
        soundControls = (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                    style={ghostButton}
                    title={muted ? "Ativar som" : "Silenciar"}
                    aria-label={muted ? "Ativar som" : "Silenciar"}
                    onClick={() => setMuted(m => !m)}
                >
                    <VolumeIcon muted={muted || volume === 0} />
                </button>
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={muted ? 0 : Math.round(volume * 100)}
                    aria-label="Volume"
                    title={`Volume: ${muted ? 0 : Math.round(volume * 100)}%`}
                    style={{ width: 110, accentColor: ACCENT, cursor: "pointer" }}
                    onChange={e => {
                        const v = Number(e.currentTarget.value) / 100;
                        setVolume(v);
                        setMuted(v === 0);
                    }}
                />
            </div>
        );
    }

    return (
        <div
            ref={rootRef}
            style={{ ...rootStyle, cursor: showControls ? "default" : "none" }}
            onMouseMove={poke}
            onMouseLeave={() => {
                if (idleTimer.current) clearTimeout(idleTimer.current);
                setActive(false);
            }}
        >
            {/* The <video> is appended here imperatively; React never renders children into it */}
            <div ref={mediaRef} style={mediaStyle} onDoubleClick={toggleFullscreen} />

            {overlay && (
                <div style={overlayStyle}>
                    {overlay.spinner && <Spinner />}
                    <div style={{ fontSize: 17, fontWeight: 600 }}>{overlay.title}</div>
                    {overlay.detail && <div style={{ maxWidth: 520, color: "#b5bac1", fontSize: 13 }}>{overlay.detail}</div>}
                    {overlay.closable && (
                        <button style={ghostButton} onClick={onClose}>
                            <CloseIcon size={14} />
                            Fechar
                        </button>
                    )}
                </div>
            )}

            {(mode === "floating" || fullscreen) && (
                <div style={{ ...topBarStyle, opacity: showControls ? 1 : 0 }}>
                    <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name} — Telinha</span>
                </div>
            )}

            <div style={{ ...bottomBarStyle, opacity: showControls ? 1 : 0, pointerEvents: showControls ? "auto" : "none" }}>
                <button style={dangerButton} onClick={onClose}>
                    <StopIcon size={14} />
                    Parar de assistir
                </button>
                {soundControls}
                <div style={{ flex: 1 }} />
                {statsText && <span style={{ color: "#b5bac1", fontSize: 12, whiteSpace: "nowrap" }}>{statsText}</span>}
                <button
                    style={ghostButton}
                    title={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
                    aria-label={fullscreen ? "Sair da tela cheia" : "Tela cheia"}
                    onClick={toggleFullscreen}
                >
                    <FullscreenIcon exit={fullscreen} />
                </button>
            </div>
        </div>
    );
}
