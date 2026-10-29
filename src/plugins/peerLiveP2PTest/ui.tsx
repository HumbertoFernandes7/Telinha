/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { HeadingTertiary } from "@components/Heading";
import { Modal, openModal, useEffect, useReducer, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

import { getLogFileInfo, getRecentEvents, getTimings, onDiagChange, openLogFolder } from "./diagnostics";
import { RELAY_URLS } from "./protocol";
import { type Admission, getSessionView, onSessionChange, type PeerView, rejoin, reportFirstRenderedFrame, stopWatching, toggleTestStream, watch, type WatchView } from "./session";
import { pairLabel } from "./stats";
import { formatClock } from "./testPattern";

const S = {
    section: { marginBottom: 16 } satisfies CSSProperties,
    row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 } satisfies CSSProperties,
    table: { width: "100%", borderCollapse: "collapse", fontSize: 13, color: "var(--text-default)" } satisfies CSSProperties,
    td: { padding: "3px 6px", borderBottom: "1px solid var(--border-subtle, rgba(128,128,128,.2))", verticalAlign: "top" } satisfies CSSProperties,
    mono: { fontFamily: "var(--font-code, Consolas, monospace)", fontSize: 12 } satisfies CSSProperties,
    text: { color: "var(--text-default)", fontSize: 14, lineHeight: "20px" } satisfies CSSProperties,
    muted: { color: "var(--text-muted)", fontSize: 12 } satisfies CSSProperties,
    events: {
        fontFamily: "var(--font-code, Consolas, monospace)", fontSize: 11, maxHeight: 220, overflowY: "auto",
        background: "var(--background-secondary, rgba(0,0,0,.15))", padding: 8, borderRadius: 6, color: "var(--text-default)"
    } satisfies CSSProperties
};

const LEVEL_COLOR = { info: "var(--text-default)", warn: "#f0b232", error: "#f23f43" };
// Sem JSX no topo do modulo: o factory do JSX (VencordCreateElement) le Vencord.Webpack.Common.React na
// primeira chamada, e durante a avaliacao do renderer.js o global Vencord ainda nao existe (o bundle quebra).
const ADMISSION_LABEL: Record<Admission, { text: string; color: string; bold?: boolean; }> = {
    "ok": { text: "✓ no canal", color: "#23a55a" },
    "fora-do-canal": { text: "⚠ FORA DO CANAL", color: "#f23f43", bold: true },
    "sem-id": { text: "? sem ID", color: "#f0b232", bold: true },
    "sem-verificacao": { text: "? não verificado", color: "#f0b232" }
};

function AdmissionLabel({ admission }: { admission: Admission; }) {
    const { text, color, bold } = ADMISSION_LABEL[admission];
    return bold ? <b style={{ color }}>{text}</b> : <span style={{ color }}>{text}</span>;
}

const ms = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)} ms`);
const val = (n: number | string | null | undefined, suffix = "") => (n == null || n === "" ? "—" : `${n}${suffix}`);

function useLive() {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        const a = onSessionChange(force);
        const b = onDiagChange(force);
        return () => {
            a();
            b();
        };
    }, []);
}

function LocalClock() {
    const [now, setNow] = useState(formatClock());
    useEffect(() => {
        const id = setInterval(() => setNow(formatClock()), 31);
        return () => clearInterval(id);
    }, []);
    return <span style={{ ...S.mono, fontSize: 28, fontWeight: 700 }}>{now}</span>;
}

function StatGrid({ items }: { items: [string, ReactNode][]; }) {
    return (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6, ...S.text }}>
            {items.map(([k, v]) => (
                <div key={k}>
                    <div style={S.muted}>{k}</div>
                    <div style={{ ...S.mono, fontSize: 14 }}>{v}</div>
                </div>
            ))}
        </div>
    );
}

function WatchPane({ w, peer }: { w: WatchView; peer?: PeerView; }) {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = w.stream;
        if (!w.stream) return;
        video.play().catch(() => { });
        const { peerId } = w;
        const onFrame = () => reportFirstRenderedFrame(peerId);
        if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(onFrame);
        else (video as HTMLVideoElement).addEventListener("loadeddata", onFrame, { once: true });
    }, [w.stream]);

    const s = w.last;
    const name = peer?.presence?.username ?? peer?.hello?.username ?? w.peerId.slice(0, 6);
    return (
        <div style={S.section}>
            <HeadingTertiary>Assistindo {name}</HeadingTertiary>
            {w.ended && <div style={{ ...S.text, color: "#f0b232" }}>Encerrado: {w.ended}</div>}
            <video ref={videoRef} autoPlay playsInline controls style={{ width: "100%", maxHeight: 420, background: "#000", borderRadius: 6 }} />
            <div style={{ ...S.row, justifyContent: "space-between", marginTop: 6 }}>
                <div style={S.text}>Meu relógio (compare com o do vídeo): <LocalClock /></div>
                <Button size="small" variant="secondary" onClick={stopWatching}>Parar de assistir</Button>
            </div>
            <StatGrid items={[
                ["Assistir → ICE conectado", w.iceNote ? `${ms(w.iceMs)} (já conectado)` : ms(w.iceMs)],
                ["Assistir → stream (ontrack)", ms(w.streamMs)],
                ["Assistir → 1º quadro decodificado", ms(w.firstFrameMs)],
                ["Assistir → 1º quadro na tela", ms(w.renderedMs)],
                ["Resolução", s?.width ? `${s.width}x${s.height}` : "—"],
                ["FPS recebido", val(s?.fps)],
                ["Bitrate vídeo", val(s?.kbps, " kbps")],
                ["Bitrate áudio", val(s?.audioKbps, " kbps")],
                ["RTT", val(s?.rttMs, " ms")],
                ["Perda de pacotes", s?.lossPct != null ? `${s.lossPct}% (${s.packetsLost})` : "—"],
                ["Jitter", val(s?.jitterMs, " ms")],
                ["Quadros perdidos / travadas", `${val(s?.framesDropped)} / ${val(s?.freezeCount)}`],
                ["Decoder", val(s?.decoder)],
                ["Conexão", pairLabel(peer?.pair)]
            ]} />
        </div>
    );
}

function P2PPanelInner({ inSettings }: { inSettings?: boolean; }) {
    useLive();
    const v = getSessionView();
    const file = getLogFileInfo();
    const events = getRecentEvents(inSettings ? 20 : 60).slice().reverse();
    const timings = getTimings().slice(-12).reverse();
    const watchedPeer = v.watching ? v.peers.find(p => p.peerId === v.watching!.peerId) : undefined;

    return (
        <div style={S.text}>
            <div style={S.section}>
                <div style={S.row}>
                    <Button variant={v.streaming ? "dangerPrimary" : "primary"} onClick={toggleTestStream}>
                        {v.streaming ? "Parar padrão de teste" : "Transmitir padrão de teste"}
                    </Button>
                    <Button variant="secondary" onClick={rejoin} disabled={!v.channelId}>Entrar de novo na sala</Button>
                    <Button variant="secondary" onClick={() => void openLogFolder()} disabled={!file.nativeAvailable}>Abrir pasta de logs</Button>
                    {inSettings && <Button variant="secondary" onClick={openP2PPanel}>Abrir painel</Button>}
                </div>
                <div>
                    Estado: <b>{v.status === "na-sala" ? "na sala" : v.status === "entrando" ? "entrando…" : "fora (entre num canal de voz)"}</b>
                    {v.roomId && <> · sala <span style={S.mono}>{v.roomId.slice(0, 12)}…</span></>}
                    {" "}· senha do grupo: {v.hasPassword ? "sim" : "não"}
                    {" "}· sala → 1º peer: <b>{ms(v.firstPeerMs)}</b>
                </div>
                <div style={S.muted}>
                    Meu peer id (Trystero): <span style={S.mono}>{v.selfId}</span>
                </div>
                <div style={S.muted}>
                    Log: <span style={S.mono}>{file.filePath ?? (file.nativeAvailable ? `(gravando ${file.fileName}…)` : "parte nativa não carregada — feche e abra o Discord por completo")}</span>
                    {file.fileError && <span style={{ color: "#f23f43" }}> · erro: {file.fileError}</span>}
                </div>
            </div>

            <div style={S.section}>
                <HeadingTertiary>Peers na sala ({v.peers.length})</HeadingTertiary>
                {v.peers.length === 0
                    ? <div style={S.muted}>Ninguém ainda. Os outros precisam estar no mesmo canal de voz, com o plugin ligado e a mesma senha.</div>
                    : (
                        <table style={S.table}>
                            <tbody>
                                {v.peers.map(p => {
                                    const streaming = !!p.presence?.streaming;
                                    const isWatching = v.watching?.peerId === p.peerId;
                                    return (
                                        <tr key={p.peerId}>
                                            <td style={S.td}>
                                                <b>{p.presence?.username ?? p.hello?.username ?? "?"}</b>
                                                <div style={S.muted}>discord {p.presence?.discordUserId ?? p.hello?.discordUserId ?? "?"} · peer {p.peerId.slice(0, 6)}</div>
                                            </td>
                                            <td style={S.td}><AdmissionLabel admission={p.admission} /></td>
                                            <td style={S.td}>
                                                <div>{pairLabel(p.pair)}</div>
                                                <div style={S.muted}>visto {p.seenAfterMs} ms após entrar · ping {ms(p.pingMs)} · RTT ICE {ms(p.pair?.rttMs)}</div>
                                            </td>
                                            <td style={{ ...S.td, textAlign: "right", whiteSpace: "nowrap" }}>
                                                {streaming
                                                    ? (isWatching
                                                        ? <Button size="small" variant="secondary" onClick={stopWatching}>Parar</Button>
                                                        : <Button size="small" variant="positive" onClick={() => watch(p.peerId)}>Assistir</Button>)
                                                    : <span style={S.muted}>não transmite</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
            </div>

            {v.watching && <WatchPane w={v.watching} peer={watchedPeer} />}

            {v.streaming && (
                <div style={S.section}>
                    <HeadingTertiary>Minha transmissão → espectadores ({v.viewers.length})</HeadingTertiary>
                    {v.viewers.length === 0 && <div style={S.muted}>Ninguém assistindo ainda.</div>}
                    {v.viewers.map(id => {
                        const o = v.outbound[id];
                        const p = v.peers.find(x => x.peerId === id);
                        return (
                            <div key={id} style={{ marginBottom: 8 }}>
                                <b>{p?.presence?.username ?? id.slice(0, 6)}</b>
                                <StatGrid items={[
                                    ["Resolução enviada", o?.width ? `${o.width}x${o.height}` : "—"],
                                    ["FPS enviado", val(o?.fps)],
                                    ["Bitrate", val(o?.kbps, " kbps")],
                                    ["RTT", val(o?.rttMs, " ms")],
                                    ["Perda (lado dele)", val(o?.remoteLossPct, "%")],
                                    ["Limitação", val(o?.qualityLimitation)],
                                    ["Encoder", val(o?.encoder)]
                                ]} />
                            </div>
                        );
                    })}
                </div>
            )}

            <div style={S.section}>
                <HeadingTertiary>Relays Nostr</HeadingTertiary>
                <table style={S.table}>
                    <tbody>
                        {RELAY_URLS.map(url => {
                            const st = v.relays[url] ?? "não iniciado";
                            return (
                                <tr key={url}>
                                    <td style={{ ...S.td, ...S.mono }}>{url}</td>
                                    <td style={{ ...S.td, color: st === "aberto" ? "#23a55a" : st === "conectando" ? "#f0b232" : "#f23f43" }}>{st}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {timings.length > 0 && (
                <div style={S.section}>
                    <HeadingTertiary>Tempos medidos</HeadingTertiary>
                    <table style={S.table}>
                        <tbody>
                            {timings.map((t, i) => (
                                <tr key={i}>
                                    <td style={S.td}>{t.name}{t.note ? <span style={S.muted}> ({t.note})</span> : null}</td>
                                    <td style={{ ...S.td, ...S.mono, textAlign: "right" }}>{ms(t.ms)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div style={S.section}>
                <HeadingTertiary>Eventos (mais recentes primeiro)</HeadingTertiary>
                <div style={S.events}>
                    {events.map((e, i) => (
                        <div key={i} style={{ color: LEVEL_COLOR[e.level] }}>
                            {(e.t / 1000).toFixed(1).padStart(7)}s [{e.type}] {e.msg}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export const P2PPanel = ErrorBoundary.wrap(P2PPanelInner);

export function openP2PPanel() {
    openModal(props => (
        <Modal {...props} size="xl" title="PeerLive P2P — teste de viabilidade" subtitle="Descoberta via Nostr (Trystero) + WebRTC direto, sem servidor próprio">
            <P2PPanel />
        </Modal>
    ));
}
