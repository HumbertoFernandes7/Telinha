/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// RTCPeerConnection do Telinha, entregue ao Trystero via `rtcPolyfill` (o Trystero so faz
// `new (rtcPolyfill ?? RTCPeerConnection)(config)`). E o unico gancho limpo na negociacao:
//
// - setLocalDescription() implicito (o Trystero sempre chama sem argumento, tanto para oferta quanto
//   para resposta): antes de deixar o Chromium gerar o SDP, aplica setCodecPreferences nos
//   transceivers em que ENVIAMOS video para esse peer (codec escolhido por chooseCodec).
// - setRemoteDescription(): reordena o codec escolhido para o inicio das m-sections em que enviamos e
//   injeta x-google-start/max-bitrate + opus estereo (ver sdp.ts). Isso garante o codec mesmo quando
//   quem oferta e o outro lado (ex.: os dois transmitindo um para o outro, transceiver reaproveitado)
//   e corta a rampa inicial de bitrate (~12 s de 320x180 ate 720p no spike).
//
// Se o SDP ajustado for recusado, aplica o original (nunca derruba a conexao por causa do ajuste).

import { applyCodecPreferences } from "./codec";
import { errorText, log, logThrottled } from "./log";
import { mungeRemoteSdp, type VideoCodecName } from "./sdp";

export interface SendPlan {
    /** codec de video que queremos ENVIAR para o peer desta conexao */
    codec: VideoCodecName | null;
    bitrate: { startKbps: number; maxKbps: number; } | null;
    /** nome do peer para os logs */
    label: string;
}

export interface PcHooks {
    /** Plano de envio para o peer desta RTCPeerConnection, ou null se nao enviamos nada para ele. */
    planFor(pc: RTCPeerConnection): SendPlan | null;
}

let hooks: PcHooks | null = null;
let PeerConnectionClass: typeof RTCPeerConnection | null = null;
const appliedPrefs = new WeakMap<RTCRtpTransceiver, VideoCodecName>();
const loggedMunge = new WeakMap<RTCPeerConnection, string>();

export function setPcHooks(next: PcHooks | null) {
    hooks = next;
}

function sendingTransceivers(pc: RTCPeerConnection, kind: "audio" | "video") {
    return pc.getTransceivers().filter(t =>
        t.sender.track?.kind === kind
        && (t.direction === "sendrecv" || t.direction === "sendonly")
        && t.currentDirection !== "stopped"
    );
}

function prepareLocalDescription(pc: RTCPeerConnection) {
    const plan = hooks?.planFor(pc);
    if (!plan?.codec) return;
    for (const t of sendingTransceivers(pc, "video")) {
        if (appliedPrefs.get(t) === plan.codec) continue;
        appliedPrefs.set(t, plan.codec);
        log.info(`${plan.label}: preferência de codec ${applyCodecPreferences(t, plan.codec)}`);
    }
}

function mungeRemoteDescription(pc: RTCPeerConnection, description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (!description?.sdp || (description.type !== "offer" && description.type !== "answer" && description.type !== "pranswer")) return description;
    const plan = hooks?.planFor(pc);
    if (!plan) return description;

    const mids = (kind: "audio" | "video") => new Set(sendingTransceivers(pc, kind).map(t => t.mid).filter((m): m is string => !!m));
    const videoMids = mids("video");
    const audioMids = mids("audio");
    if (!videoMids.size && !audioMids.size) return description;

    const result = mungeRemoteSdp(description.sdp, { videoMids, audioMids, codec: plan.codec, bitrate: plan.bitrate });
    const summary = [...result.changes, ...result.notes].join("; ");
    if (summary && loggedMunge.get(pc) !== summary) {
        loggedMunge.set(pc, summary);
        log.info(`${plan.label}: SDP remoto (${description.type}) ajustado — ${summary}`);
    }
    return result.changes.length ? { type: description.type, sdp: result.sdp } : description;
}

/** Classe criada sob demanda (nunca no carregamento do modulo). */
export function getPeerConnectionClass(): typeof RTCPeerConnection {
    return PeerConnectionClass ??= class TelinhaPeerConnection extends RTCPeerConnection {
        override setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
            if (!description || (description.type !== "rollback" && !description.sdp)) {
                try {
                    prepareLocalDescription(this);
                } catch (e) {
                    logThrottled("pc-local", "warn", "Falha ao preparar a preferência de codec: " + errorText(e));
                }
            }
            return super.setLocalDescription(description);
        }

        override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
            let munged = description;
            try {
                munged = mungeRemoteDescription(this, description);
            } catch (e) {
                logThrottled("pc-munge", "warn", "Falha ao ajustar o SDP remoto (usando o original): " + errorText(e));
            }
            if (munged === description) return super.setRemoteDescription(description);
            return super.setRemoteDescription(munged).catch(e => {
                log.warn("O Chromium recusou o SDP ajustado; aplicando o original: " + errorText(e));
                return super.setRemoteDescription(description);
            });
        }
    };
}
