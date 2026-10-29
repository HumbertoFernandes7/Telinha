/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O que o PeerLive desenha dentro da tile de um participante na tela da call (ver patches.ts):
// - amigo transmitindo pelo PeerLive: etiqueta "PEERLIVE · Assistir"; ao clicar, o stream toca DENTRO da tile, com
//   status, volume, tela cheia, "Abrir em janela" e "Parar de assistir";
// - a sua propria tile, enquanto voce transmite: previa local (sempre muda), que da para ocultar.
// Tudo com estilo inline (a call pode estar num pop-out do Discord, que nao recebe o CSS do Vencord). Cliques fora dos
// nossos botoes seguem para o Discord (focar/ampliar a tile continua funcionando e o video cresce junto).

import ErrorBoundary from "@components/ErrorBoundary";
import { getLocalPreviewStream } from "@plugins/peerLive/actions";
import { usePeerLiveState } from "@plugins/peerLive/store";
import type { PeerId, RemotePeer, ViewerSession } from "@plugins/peerLive/types";
import { ACCENT, currentUserId, errorText, logger, peerName, watchersLabel } from "@plugins/peerLive/ui/common";
import { BroadcastIcon, CloseIcon, FullscreenIcon, StopIcon, VolumeIcon } from "@plugins/peerLive/ui/icons";
import { isViewerOpen, openViewer } from "@plugins/peerLive/ui/viewerWindows";
import { PopoutWindowStore, useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode, RefObject, SyntheticEvent } from "react";

import {
    getVolume,
    isAudioOwner,
    isLocalPreviewHidden,
    registerTile,
    releaseToWindow,
    setLocalPreviewHidden,
    setVolume,
    startTileWatch,
    stopTileWatch,
    unregisterTile,
    useTileStateVersion
} from "./tileState";

const CONTROLS_IDLE_MS = 2500;
const COMPACT_WIDTH = 300;
const TINY_WIDTH = 190;
const FONT = "var(--font-primary, \"gg sans\", \"Noto Sans\", sans-serif)";

// #region estilos

const layerStyle: CSSProperties = { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" };

const playerStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    background: "#000",
    color: "#f2f3f5",
    font: `13px/1.35 ${FONT}`,
    userSelect: "none"
};

const mediaStyle: CSSProperties = { position: "absolute", inset: 0 };

const topRowStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    // a direita ficam os indicadores do Discord (canto superior direito da tile)
    padding: "8px 44px 22px 8px",
    background: "linear-gradient(rgba(0, 0, 0, 0.7), transparent)",
    transition: "opacity 150ms ease"
};

const overlayStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 12,
    textAlign: "center",
    background: "rgba(0, 0, 0, 0.72)"
};

const pillStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 20,
    padding: "0 7px",
    borderRadius: 4,
    background: ACCENT,
    color: "#fff",
    font: `700 11px/20px ${FONT}`,
    letterSpacing: ".02em",
    whiteSpace: "nowrap"
};

const buttonBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 26,
    padding: "0 9px",
    border: 0,
    borderRadius: 5,
    color: "#fff",
    font: `600 12px ${FONT}`,
    cursor: "pointer",
    whiteSpace: "nowrap",
    pointerEvents: "auto"
};

const ghostButton: CSSProperties = { ...buttonBase, padding: "0 7px", background: "rgba(0, 0, 0, 0.55)" };
const dangerButton: CSSProperties = { ...buttonBase, background: "#da373c" };
const accentButton: CSSProperties = { ...buttonBase, background: ACCENT };

const watchBadgeStyle: CSSProperties = {
    ...buttonBase,
    position: "absolute",
    top: 8,
    left: 8,
    height: 24,
    padding: "0 9px",
    background: ACCENT,
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.45)",
    font: `700 12px ${FONT}`
};

const spinnerStyle: CSSProperties = {
    width: 26,
    height: 26,
    borderRadius: "50%",
    border: "3px solid rgba(255, 255, 255, 0.2)",
    borderTopColor: "#fff"
};

// #endregion

/** Nossos controles nao podem acionar o clique/duplo clique/teclas da tile do Discord (focar, tela cheia...) */
const stopTileEvents = {
    onClick: (e: SyntheticEvent) => e.stopPropagation(),
    onDoubleClick: (e: SyntheticEvent) => e.stopPropagation(),
    onMouseDown: (e: SyntheticEvent) => e.stopPropagation(),
    onPointerDown: (e: SyntheticEvent) => e.stopPropagation(),
    onKeyDown: (e: SyntheticEvent) => e.stopPropagation()
};

function PopoutIcon({ size = 16 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
            <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
    );
}

function EyeOffIcon({ size = 16 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
            <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-2.6 3.1M6.2 7.6C4.2 9.2 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 3.3-.7M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        </svg>
    );
}

function Spinner() {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const anim = ref.current?.animate?.([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 900, iterations: Infinity });
        return () => anim?.cancel();
    }, []);
    return <div ref={ref} style={spinnerStyle} />;
}

// #region hooks

/** Largura da tile (o elemento ocupa a tile inteira), para escolher a versao compacta dos controles */
function useWidth(ref: RefObject<HTMLDivElement | null>) {
    const [width, setWidth] = useState(0);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        setWidth(el.clientWidth);
        const RO = el.ownerDocument.defaultView?.ResizeObserver ?? (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
        if (!RO) return;
        const ro = new RO(() => setWidth(el.clientWidth));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return width;
}

/** A janela do visualizador (pop-out/painel) desse amigo esta aberta? Atualiza com o PopoutWindowStore e a cada 1,5 s */
function useViewerOpen(peerId: PeerId) {
    const [open, setOpen] = useState(() => isViewerOpen(peerId));
    useEffect(() => {
        const check = () => setOpen(isViewerOpen(peerId));
        check();
        const timer = setInterval(check, 1500);
        let unlisten = () => { };
        try {
            PopoutWindowStore?.addChangeListener(check);
            unlisten = () => PopoutWindowStore?.removeChangeListener(check);
        } catch { }
        return () => {
            clearInterval(timer);
            unlisten();
        };
    }, [peerId]);
    return open;
}

/** Controles visiveis enquanto o mouse mexe na tile */
function useActive() {
    const [active, setActive] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);
    const poke = () => {
        setActive(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setActive(false), CONTROLS_IDLE_MS);
    };
    const leave = () => {
        if (timer.current) clearTimeout(timer.current);
        setActive(false);
    };
    return { active, poke, leave };
}

/**
 * Toca `stream` num <video> criado pelo documento da propria tile (a call pode estar num pop-out do Discord). Um mesmo
 * MediaStream pode alimentar varios <video> (tile + janela do visualizador).
 */
function useStreamVideo(containerRef: RefObject<HTMLDivElement | null>, stream: MediaStream | null, muted: boolean, volume: number) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [autoplayBlocked, setAutoplayBlocked] = useState(false);

    useEffect(() => {
        const container = containerRef.current;
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
                if ((e as DOMException)?.name !== "AbortError") logger.warn("play() da tile falhou", errorText(e));
                return;
            }
            // Autoplay com som recusado: toca mudo e oferece "Ativar som"
            setAutoplayBlocked(true);
            video.muted = true;
            video.play().catch(err => logger.warn("play() mudo da tile também falhou", errorText(err)));
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
        // Comeca mudo ate a tile saber se e a dona do som; se o Chromium pausar ao tirar o mudo, retoma (ou avisa)
        if (video.paused && video.srcObject) {
            video.play().catch(e => {
                if ((e as DOMException)?.name !== "NotAllowedError") return;
                setAutoplayBlocked(true);
                video.muted = true;
                video.play().catch(() => { });
            });
        }
    }, [muted, volume, autoplayBlocked, stream]);

    const enableSound = () => {
        setAutoplayBlocked(false);
        const video = videoRef.current;
        if (video) {
            video.muted = muted;
            video.play().catch(e => logger.warn("play() com som da tile falhou", errorText(e)));
        }
    };

    return { autoplayBlocked, enableSound };
}

function useFullscreen(rootRef: RefObject<HTMLDivElement | null>) {
    const [fullscreen, setFullscreen] = useState(false);
    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc) return;
        const onChange = () => setFullscreen(doc.fullscreenElement === rootRef.current);
        doc.addEventListener("fullscreenchange", onChange);
        return () => doc.removeEventListener("fullscreenchange", onChange);
    }, []);
    const toggle = () => {
        const root = rootRef.current;
        if (!root) return;
        const doc = root.ownerDocument;
        const action = doc.fullscreenElement ? doc.exitFullscreen() : root.requestFullscreen();
        action.catch(e => logger.warn("Tela cheia da tile falhou", errorText(e)));
    };
    return { fullscreen, toggle };
}

// #endregion

interface StatusInfo {
    title: string;
    detail?: string;
    spinner?: boolean;
    finished?: boolean;
}

function getStatus(session: ViewerSession): StatusInfo | null {
    switch (session.status) {
        case "connecting":
            return { title: "Conectando…", spinner: true };
        case "waiting-first-frame":
            return { title: "Aguardando a primeira imagem…", spinner: true };
        case "playing":
            return session.stream ? null : { title: "Aguardando a primeira imagem…", spinner: true };
        case "ended":
            return { title: "A transmissão terminou", finished: true };
        case "error":
            return { title: "Não foi possível assistir", detail: session.error, finished: true };
        default:
            return null;
    }
}

interface IconButtonProps {
    label: string;
    style?: CSSProperties;
    onClick(): void;
    children: ReactNode;
    text?: string;
    /** false enquanto os controles estao escondidos: o clique passa para a tile do Discord */
    interactive?: boolean;
}

function IconButton({ label, style = ghostButton, onClick, children, text, interactive = true }: IconButtonProps) {
    return (
        <button type="button" style={{ ...style, pointerEvents: interactive ? "auto" : "none" }} title={label} aria-label={label} tabIndex={interactive ? undefined : -1} onClick={onClick}>
            {children}
            {text}
        </button>
    );
}

// #region amigo transmitindo

function TilePlayer({ peer, session }: { peer: RemotePeer; session: ViewerSession; }) {
    const { peerId } = peer;
    const name = peerName(peer);
    const stream = session.stream ?? null;

    const rootRef = useRef<HTMLDivElement>(null);
    const mediaRef = useRef<HTMLDivElement>(null);
    const tokenRef = useRef<symbol | null>(null);

    useTileStateVersion();
    useEffect(() => {
        const token = registerTile(peerId);
        tokenRef.current = token;
        return () => {
            tokenRef.current = null;
            unregisterTile(peerId, token);
        };
    }, [peerId]);

    const width = useWidth(rootRef);
    const compact = width > 0 && width < COMPACT_WIDTH;
    const tiny = width > 0 && width < TINY_WIDTH;
    const viewerOpen = useViewerOpen(peerId);
    const { active, poke, leave } = useActive();
    const { fullscreen, toggle: toggleFullscreen } = useFullscreen(rootRef);

    const volumeKey = peer.discordUserId || peerId;
    const [{ volume, muted }, setVolumeState] = useState(() => getVolume(volumeKey));
    const updateVolume = (next: { volume: number; muted: boolean; }) => {
        setVolumeState(next);
        setVolume(volumeKey, next);
    };

    // O som toca numa tile so (a primeira montada) e nunca junto com a janela do visualizador
    const audioHere = !viewerOpen && isAudioOwner(peerId, tokenRef.current);
    const { autoplayBlocked, enableSound } = useStreamVideo(mediaRef, stream, muted || !audioHere, volume);

    const hasAudio = (stream?.getAudioTracks().length ?? 0) > 0 || !!peer.stream?.hasAudio;
    const status = getStatus(session);
    const showControls = active || fullscreen || status != null || (autoplayBlocked && hasAudio && audioHere);

    const { stats } = session;
    const statsText = stats && stats.height ? `${stats.height}p · ${Math.round(stats.fps)} fps` : null;

    // A linha de controles nao captura cliques (clicar no video foca a tile no Discord); so os botoes visiveis capturam
    const pe = showControls;

    let sound: ReactNode = null;
    if (hasAudio && viewerOpen) {
        sound = compact ? null : <span style={{ color: "#dbdee1", fontSize: 12, whiteSpace: "nowrap" }}>Som na janela</span>;
    } else if (hasAudio && audioHere && autoplayBlocked) {
        sound = (
            <IconButton label="Ativar som" style={accentButton} onClick={enableSound} text={tiny ? undefined : "Ativar som"} interactive={pe}>
                <VolumeIcon muted={true} size={14} />
            </IconButton>
        );
    } else if (hasAudio && audioHere) {
        const shown = muted ? 0 : Math.round(volume * 100);
        sound = (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <IconButton label={muted ? "Ativar som" : "Silenciar"} onClick={() => updateVolume({ volume, muted: !muted })} interactive={pe}>
                    <VolumeIcon muted={muted || volume === 0} size={14} />
                </IconButton>
                {!compact && (
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={shown}
                        aria-label="Volume"
                        title={`Volume: ${shown}%`}
                        tabIndex={pe ? undefined : -1}
                        style={{ width: 80, accentColor: ACCENT, cursor: "pointer", pointerEvents: pe ? "auto" : "none" }}
                        onChange={e => {
                            const v = Number(e.currentTarget.value) / 100;
                            updateVolume({ volume: v, muted: v === 0 });
                        }}
                    />
                )}
            </span>
        );
    }

    const openWindow = () => {
        if (fullscreen) toggleFullscreen();
        releaseToWindow(peerId);
        openViewer(peerId);
    };

    return (
        <div
            ref={rootRef}
            style={{ ...playerStyle, cursor: showControls ? undefined : "none" }}
            onMouseMove={poke}
            onMouseLeave={leave}
        >
            {/* O <video> entra aqui imperativamente; o React nunca renderiza filhos nele */}
            <div ref={mediaRef} style={mediaStyle} />

            {status && (
                <div style={overlayStyle}>
                    {status.spinner && <Spinner />}
                    <div style={{ fontSize: tiny ? 12 : 15, fontWeight: 600 }}>{status.title}</div>
                    {status.detail && !tiny && <div style={{ maxWidth: 420, color: "#b5bac1", fontSize: 12 }}>{status.detail}</div>}
                    {status.finished && (
                        <div style={{ display: "flex", gap: 6 }} {...stopTileEvents}>
                            {peer.streaming && (
                                <IconButton label="Tentar de novo" style={accentButton} onClick={() => startTileWatch(peerId)} text="Tentar de novo">
                                    <BroadcastIcon size={14} />
                                </IconButton>
                            )}
                            <IconButton label="Fechar" onClick={() => stopTileWatch(peerId)} text="Fechar">
                                <CloseIcon size={14} />
                            </IconButton>
                        </div>
                    )}
                </div>
            )}

            <div style={{ ...topRowStyle, opacity: showControls ? 1 : 0, pointerEvents: "none" }} {...stopTileEvents}>
                <span style={{ ...pillStyle, pointerEvents: pe ? "auto" : "none" }} title={`${name} está transmitindo pelo PeerLive`}>
                    <BroadcastIcon size={11} />
                    {tiny ? null : "PEERLIVE"}
                </span>
                {(fullscreen || !compact) && <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }}>{name}</span>}
                {!compact && statsText && <span style={{ color: "#b5bac1", fontSize: 12, whiteSpace: "nowrap" }}>{statsText}</span>}
                {sound}
                <IconButton label={viewerOpen ? "Mostrar a janela" : "Abrir em janela"} onClick={openWindow} text={compact ? undefined : viewerOpen ? "Mostrar janela" : "Abrir em janela"} interactive={pe}>
                    <PopoutIcon size={14} />
                </IconButton>
                <IconButton label={fullscreen ? "Sair da tela cheia" : "Tela cheia"} onClick={toggleFullscreen} interactive={pe}>
                    <FullscreenIcon exit={fullscreen} size={14} />
                </IconButton>
                <IconButton label="Parar de assistir" style={dangerButton} onClick={() => stopTileWatch(peerId)} text={compact ? undefined : "Parar de assistir"} interactive={pe}>
                    <StopIcon size={12} />
                </IconButton>
            </div>
        </div>
    );
}

function WatchBadge({ peer }: { peer: RemotePeer; }) {
    const layerRef = useRef<HTMLDivElement>(null);
    const width = useWidth(layerRef);
    const tiny = width > 0 && width < TINY_WIDTH;
    const name = peerName(peer);

    return (
        <div ref={layerRef} style={layerStyle}>
            <button
                type="button"
                style={watchBadgeStyle}
                title={`${name} está transmitindo pelo PeerLive — clique para assistir aqui na call`}
                aria-label={`Assistir a transmissão de ${name} pelo PeerLive`}
                {...stopTileEvents}
                onClick={e => {
                    e.stopPropagation();
                    startTileWatch(peer.peerId);
                }}
            >
                <BroadcastIcon size={12} />
                {tiny ? "Assistir" : "PEERLIVE · Assistir"}
            </button>
        </div>
    );
}

// #endregion

// #region sua propria transmissao

function LocalPreview({ viewers }: { viewers: number; }) {
    useTileStateVersion();
    const hidden = isLocalPreviewHidden();
    const stream = hidden ? null : getLocalPreviewStream();

    const rootRef = useRef<HTMLDivElement>(null);
    const mediaRef = useRef<HTMLDivElement>(null);
    const width = useWidth(rootRef);
    const compact = width > 0 && width < COMPACT_WIDTH;
    const { active, poke, leave } = useActive();
    useStreamVideo(mediaRef, stream, true, 0);

    const label = `Sua transmissão · ${watchersLabel(viewers)}`;
    return (
        <div
            ref={rootRef}
            style={hidden ? layerStyle : { ...playerStyle, pointerEvents: "auto" }}
            onMouseMove={poke}
            onMouseLeave={leave}
        >
            <div ref={mediaRef} style={mediaStyle} />
            <div style={{ ...topRowStyle, background: hidden || !active ? "none" : topRowStyle.background, pointerEvents: "none", color: "#f2f3f5", font: `13px/1.35 ${FONT}` }} {...stopTileEvents}>
                <span style={{ ...pillStyle, pointerEvents: "auto" }} title={label}>
                    <BroadcastIcon size={11} />
                    PEERLIVE
                </span>
                {!compact && (active || hidden) && <span style={{ whiteSpace: "nowrap", textShadow: "0 1px 2px #000" }}>{label}</span>}
                {(active || hidden) && (
                    <IconButton label={hidden ? "Mostrar a prévia" : "Ocultar a prévia"} onClick={() => setLocalPreviewHidden(!hidden)} text={compact ? undefined : hidden ? "Mostrar prévia" : "Ocultar prévia"}>
                        {hidden ? <BroadcastIcon size={14} /> : <EyeOffIcon size={14} />}
                    </IconButton>
                )}
            </div>
        </div>
    );
}

// #endregion

function CallTileStreamInner({ userId }: { userId: string; }) {
    const state = usePeerLiveState();
    if (!state.inRoom) return null;

    if (userId === currentUserId()) return state.local ? <LocalPreview viewers={state.local.viewers.length} /> : null;

    const peer = state.peers.find(p => p.discordUserId === userId);
    if (!peer) return null;

    const session = state.viewing[peer.peerId];
    if (session) return <TilePlayer key={peer.peerId} peer={peer} session={session} />;
    return peer.streaming ? <WatchBadge peer={peer} /> : null;
}

export const CallTileStream = ErrorBoundary.wrap(CallTileStreamInner, {
    noop: true,
    displayName: "PeerLiveCallTileStream",
    onError: ({ error }) => logger.error("A tile da call do PeerLive quebrou", error)
});
