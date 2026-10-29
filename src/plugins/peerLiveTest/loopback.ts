/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { errorText, log, logError, logWarn } from "./state";
import type { CodecChoice, LoopbackInfo, ReceiverRealm } from "./types";

type Codec = RTCRtpCapabilities["codecs"][number];

const NON_MEDIA_CODECS = /^video\/(rtx|red|ulpfec|flexfec)/i;
const CONNECT_TIMEOUT_MS = 10_000;

export function describeCodec(c: { mimeType: string; sdpFmtpLine?: string; }) {
    return c.sdpFmtpLine ? `${c.mimeType} ${c.sdpFmtpLine}` : c.mimeType;
}

export function getVideoCodecCapabilities() {
    const send = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    const recv = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    const has = (mime: string) => send.some(c => c.mimeType.toLowerCase() === mime);

    return {
        send: send.map(describeCodec),
        recv: recv.map(describeCodec),
        hasH264: has("video/h264"),
        hasH265: has("video/h265"),
        hasAV1: has("video/av1"),
        hasVP9: has("video/vp9")
    };
}

/** Puts the chosen codec first (H.264 packetization-mode=1 before mode 0), keeping everything else after it */
function sortCodecs(codecs: Codec[], choice: CodecChoice) {
    const wanted = `video/${choice}`.toLowerCase();
    const isWanted = (c: Codec) => c.mimeType.toLowerCase() === wanted;
    const pm1 = (c: Codec) => /packetization-mode=1/.test(c.sdpFmtpLine ?? "") ? 1 : 0;

    const preferred = codecs.filter(isWanted);
    if (choice === "H264") preferred.sort((a, b) => pm1(b) - pm1(a));

    return { sorted: [...preferred, ...codecs.filter(c => !isWanted(c))], matched: preferred.length };
}

function applyCodecPreferences(transceiver: RTCRtpTransceiver, choice: CodecChoice, side: "envio" | "recepção") {
    const sources = side === "envio"
        ? [["sender", RTCRtpSender.getCapabilities("video")?.codecs], ["receiver", RTCRtpReceiver.getCapabilities("video")?.codecs]] as const
        : [["receiver", RTCRtpReceiver.getCapabilities("video")?.codecs]] as const;

    for (const [capsName, caps] of sources) {
        if (!caps?.length) continue;

        const { sorted, matched } = sortCodecs(caps, choice);
        if (!matched) return `${choice} não está disponível em ${capsName}.getCapabilities; ordem padrão mantida`;

        try {
            transceiver.setCodecPreferences(sorted);
            return `${choice} primeiro (${matched} variante(s), capacidades de ${capsName}) no lado de ${side}`;
        } catch (e) {
            logWarn(`setCodecPreferences (${side}, capacidades de ${capsName}) falhou`, errorText(e));
        }
    }

    return `setCodecPreferences falhou no lado de ${side}; ordem padrão mantida`;
}

/** First payload type of m=video in the SDP, as "mime fmtp" */
function negotiatedVideoCodec(sdp: string | undefined) {
    if (!sdp) return null;

    const mLine = /^m=video \d+ [^ ]+ (\d+)/m.exec(sdp);
    if (!mLine) return null;

    const pt = mLine[1];
    const rtpmap = new RegExp(`^a=rtpmap:${pt} ([^\\r\\n]+)`, "m").exec(sdp)?.[1];
    const fmtp = new RegExp(`^a=fmtp:${pt} ([^\\r\\n]+)`, "m").exec(sdp)?.[1];
    return `${rtpmap ?? "pt " + pt}${fmtp ? " " + fmtp : ""}`;
}

/**
 * Adds x-google-start/max-bitrate to every real video codec of the remote answer handed to the sender,
 * so libwebrtc's bandwidth estimator starts high instead of ramping from ~300 kbps.
 * Only the remote description is touched (munging remote SDP is allowed; local munging is being phased out).
 */
function mungeAnswerBitrate(sdp: string, maxKbps: number) {
    const startKbps = Math.round(maxKbps * 0.7);
    const params = `x-google-start-bitrate=${startKbps};x-google-max-bitrate=${maxKbps}`;
    const lines = sdp.split("\r\n");
    const out: string[] = [];
    const touched: string[] = [];

    let inVideo = false;
    const videoPts = new Map<string, string>();
    for (const line of lines) {
        if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
        const m = inVideo && /^a=rtpmap:(\d+) ([^/]+)/.exec(line);
        if (m && !NON_MEDIA_CODECS.test("video/" + m[2])) videoPts.set(m[1], m[2]);
    }

    const hasFmtp = new Set<string>();
    for (const line of lines) {
        const m = /^a=fmtp:(\d+) /.exec(line);
        if (m) hasFmtp.add(m[1]);
    }

    for (const line of lines) {
        const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
        if (fmtp && videoPts.has(fmtp[1]) && !fmtp[2].includes("x-google-")) {
            out.push(`${line};${params}`);
            touched.push(`${fmtp[1]}/${videoPts.get(fmtp[1])}`);
            continue;
        }

        out.push(line);

        const rtpmap = /^a=rtpmap:(\d+) /.exec(line);
        if (rtpmap && videoPts.has(rtpmap[1]) && !hasFmtp.has(rtpmap[1])) {
            out.push(`a=fmtp:${rtpmap[1]} ${params}`);
            touched.push(`${rtpmap[1]}/${videoPts.get(rtpmap[1])}`);
        }
    }

    return { sdp: out.join("\r\n"), description: `${params} em ${touched.join(", ") || "nenhum codec"}` };
}

function describeCandidate(c: RTCIceCandidate) {
    const addr = c.address ?? "";
    const addrKind = addr.endsWith(".local") ? "mDNS" : addr.includes(":") ? "IPv6" : addr ? "IPv4" : "?";
    return `${c.type ?? "?"}/${c.protocol ?? "?"}/${addrKind}`;
}

export interface LoopbackSession {
    id: number;
    /** Window whose JS realm created the RECEIVING RTCPeerConnection (main window or the pop-out) */
    realm: Window;
    realmName: ReceiverRealm;
    pcSend: RTCPeerConnection;
    pcRecv: RTCPeerConnection;
    videoSender: RTCRtpSender;
    /** Belongs to `realm` (created by its RTCPeerConnection) */
    receivedVideoTrack: MediaStreamTrack;
    receivedAudioTrack: MediaStreamTrack | null;
    info: LoopbackInfo;
    /** performance.now() (main window) when ICE connected */
    connectedAt: number;
    readonly closed: boolean;
    close(): void;
}

export interface LoopbackOptions {
    id: number;
    reason: string;
    maxBitrateBps: number;
    maxFramerate: number;
    codec: CodecChoice;
    startBitrateHint: boolean;
    /**
     * Window whose RTCPeerConnection constructor creates the receiver. Defaults to the main window.
     * Signaling between the two realms is plain SDP/ICE data (toJSON), so nothing realm-bound crosses over.
     */
    recvRealm?: Window;
}

type RealmWindow = Window & typeof globalThis;

function waitConnected(pc: RTCPeerConnection) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`ICE não conectou em ${CONNECT_TIMEOUT_MS / 1000} s (estado: ${pc.connectionState}/${pc.iceConnectionState})`));
        }, CONNECT_TIMEOUT_MS);

        const check = () => {
            if (pc.connectionState === "connected") {
                cleanup();
                resolve();
            } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
                cleanup();
                reject(new Error(`Conexão ${pc.connectionState} (ICE ${pc.iceConnectionState})`));
            }
        };

        const cleanup = () => {
            clearTimeout(timer);
            pc.removeEventListener("connectionstatechange", check);
        };

        pc.addEventListener("connectionstatechange", check);
        check();
    });
}

/**
 * Local RTCPeerConnection pair (sender -> receiver) inside the renderer, no network involved.
 * Exercises the real WebRTC encoder + decoder with the requested codec / bitrate / framerate.
 */
export async function createLoopback(stream: MediaStream, opts: LoopbackOptions): Promise<LoopbackSession> {
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    if (!videoTrack) throw new Error("Stream sem faixa de vídeo");

    videoTrack.contentHint = "motion";
    if (audioTrack) audioTrack.contentHint = "music";

    const realm = (opts.recvRealm ?? window) as RealmWindow;
    const realmName: ReceiverRealm = realm === window ? "janela principal" : "pop-out";
    const RecvPeerConnection = realm.RTCPeerConnection;
    if (typeof RecvPeerConnection !== "function") throw new Error(`RTCPeerConnection não existe no realm "${realmName}"`);

    const info: LoopbackInfo = {
        id: opts.id,
        reason: opts.reason,
        receiverRealm: realmName,
        codec: opts.codec,
        startBitrateHint: opts.startBitrateHint,
        ok: false,
        error: null,
        connectMs: null,
        iceCandidates: [],
        codecPreference: "",
        offeredVideoCodecs: [],
        negotiatedVideoCodec: null,
        sdpMunging: null,
        senderParametersApplied: "",
        senderParameters: null,
        contentHint: videoTrack.contentHint
    };

    const pcSend = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    const pcRecv: RTCPeerConnection = new RecvPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    let closed = false;
    const close = () => {
        closed = true;
        // the pop-out realm may already be gone (window closed): its PC is closed by Chromium then and close() may throw
        try {
            pcSend.close();
        } catch { }
        try {
            pcRecv.close();
        } catch { }
    };

    try {
        // Plain init dictionaries (toJSON / {type, sdp}) so no object of one realm is handed to the other realm's PC
        pcSend.onicecandidate = e => {
            if (!e.candidate) return;
            info.iceCandidates.push("envio " + describeCandidate(e.candidate));
            pcRecv.addIceCandidate(e.candidate.toJSON()).catch(err => logWarn("addIceCandidate (recepção)", errorText(err)));
        };
        pcRecv.onicecandidate = e => {
            if (!e.candidate) return;
            info.iceCandidates.push("recepção " + describeCandidate(e.candidate));
            pcSend.addIceCandidate(e.candidate.toJSON()).catch(err => logWarn("addIceCandidate (envio)", errorText(err)));
        };
        pcRecv.oniceconnectionstatechange = () => log(`Loopback #${opts.id} (${realmName}): ICE ${pcRecv.iceConnectionState}`);

        const received: { video: MediaStreamTrack | null; audio: MediaStreamTrack | null; } = { video: null, audio: null };
        pcRecv.ontrack = e => {
            if (e.track.kind === "video") received.video = e.track;
            else if (e.track.kind === "audio") received.audio = e.track;
        };

        const videoTx = pcSend.addTransceiver(videoTrack, {
            direction: "sendonly",
            streams: [stream],
            sendEncodings: [{
                maxBitrate: opts.maxBitrateBps,
                maxFramerate: opts.maxFramerate,
                priority: "high",
                networkPriority: "high"
            }]
        });
        if (audioTrack) pcSend.addTransceiver(audioTrack, { direction: "sendonly", streams: [stream] });

        info.codecPreference = applyCodecPreferences(videoTx, opts.codec, "envio");

        const t0 = performance.now();
        await pcSend.setLocalDescription(await pcSend.createOffer());
        await pcRecv.setRemoteDescription({ type: "offer", sdp: pcSend.localDescription!.sdp });
        info.offeredVideoCodecs = [...(pcSend.localDescription?.sdp ?? "").matchAll(/^a=rtpmap:\d+ ([^\r\n]+)/gm)]
            .map(m => m[1])
            .filter(c => !/^(opus|red|telephone-event|CN|G722|PCMU|PCMA|ISAC|ILBC)\//i.test(c));

        const recvVideoTx = pcRecv.getTransceivers().find(t => t.receiver.track.kind === "video");
        if (recvVideoTx) info.codecPreference += "; " + applyCodecPreferences(recvVideoTx, opts.codec, "recepção");

        await pcRecv.setLocalDescription(await pcRecv.createAnswer());

        let answerSdp = pcRecv.localDescription!.sdp;
        if (opts.startBitrateHint) {
            const munged = mungeAnswerBitrate(answerSdp, Math.round(opts.maxBitrateBps / 1000));
            answerSdp = munged.sdp;
            info.sdpMunging = munged.description;
        }
        await pcSend.setRemoteDescription({ type: "answer", sdp: answerSdp });
        info.negotiatedVideoCodec = negotiatedVideoCodec(answerSdp);

        await waitConnected(pcRecv);
        const connectedAt = performance.now();
        info.connectMs = Math.round(connectedAt - t0);

        const videoSender = videoTx.sender;
        const params = videoSender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        Object.assign(params.encodings[0], {
            maxBitrate: opts.maxBitrateBps,
            maxFramerate: opts.maxFramerate,
            priority: "high",
            networkPriority: "high"
        });
        params.degradationPreference = "maintain-framerate";

        try {
            await videoSender.setParameters(params);
            info.senderParametersApplied = "maxBitrate, maxFramerate, priority, degradationPreference=maintain-framerate";
        } catch (e) {
            logWarn("setParameters com degradationPreference falhou; tentando sem", errorText(e));
            const retry = videoSender.getParameters();
            if (!retry.encodings?.length) retry.encodings = [{}];
            Object.assign(retry.encodings[0], { maxBitrate: opts.maxBitrateBps, maxFramerate: opts.maxFramerate });
            try {
                await videoSender.setParameters(retry);
                info.senderParametersApplied = `maxBitrate, maxFramerate (degradationPreference rejeitado: ${errorText(e)})`;
            } catch (e2) {
                info.senderParametersApplied = `setParameters falhou: ${errorText(e2)}`;
                logError("setParameters falhou", errorText(e2));
            }
        }

        const applied = videoSender.getParameters();
        info.senderParameters = {
            degradationPreference: applied.degradationPreference ?? null,
            encodings: applied.encodings,
            firstCodec: applied.codecs?.[0] ? describeCodec(applied.codecs[0]) : null
        };

        if (!received.video) throw new Error("O lado de recepção não recebeu faixa de vídeo (ontrack)");

        info.ok = true;
        log(`Loopback #${opts.id} conectado em ${info.connectMs} ms (receptor: ${realmName}; motivo: ${opts.reason}); codec negociado: ${info.negotiatedVideoCodec}; preferência: ${info.codecPreference}`);
        log(`Loopback: parâmetros do sender: ${info.senderParametersApplied}`, info.senderParameters);
        if (info.sdpMunging) log(`Loopback: SDP ajustado: ${info.sdpMunging}`);

        return {
            id: opts.id,
            realm,
            realmName,
            pcSend,
            pcRecv,
            videoSender,
            receivedVideoTrack: received.video,
            receivedAudioTrack: received.audio,
            info,
            connectedAt,
            get closed() {
                return closed;
            },
            close
        };
    } catch (e) {
        info.error = errorText(e);
        close();
        const err = new Error(info.error) as Error & { loopbackInfo?: LoopbackInfo; };
        err.loopbackInfo = info;
        throw err;
    }
}
