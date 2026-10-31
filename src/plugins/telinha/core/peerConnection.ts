/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// RTCPeerConnection do Telinha, entregue ao Trystero via `rtcPolyfill` (o Trystero so faz
// `new (rtcPolyfill ?? RTCPeerConnection)(config)`). E o unico gancho limpo na negociacao:
//
// - setLocalDescription() implicito (o Trystero sempre chama sem argumento, tanto para oferta quanto
//   para resposta): antes de deixar o Chromium gerar o SDP, aplica setCodecPreferences nos
//   transceivers em que ENVIAMOS video para esse peer (codec escolhido por chooseCodec; H.264: o perfil que
//   este PC codifica por hardware na frente das outras variantes).
// - setRemoteDescription(): reordena o codec escolhido para o inicio das m-sections em que enviamos e
//   injeta x-google-start/max-bitrate + opus estereo (ver sdp.ts). Isso garante o codec mesmo quando
//   quem oferta e o outro lado (ex.: os dois transmitindo um para o outro, transceiver reaproveitado)
//   e corta a rampa inicial de bitrate (~12 s de 320x180 ate 720p no spike).
//
// Se o SDP ajustado for recusado, aplica o original (nunca derruba a conexao por causa do ajuste).
//
// Conexao contida (containPeerConnection, Telinha 0.2.9): um envio de video dela travou na placa de video
// (streaming.ts → containStuck; core/stuckEncoder.ts). Desmontar esse envio faz o Chromium destruir o VideoSendStream
// na thread WebRTC_W_and_N, que todas as conexoes do Discord usam, e esperar o encoder travado para sempre: todas as
// conexoes caem e a proxima chamada sincrona congela o Discord. Por isso, ate o Discord reiniciar:
// - close() nao fecha (o Trystero fecha a conexao quando o outro lado sai da sala, quando a nossa sala fecha e quando o
//   data channel cai; e a unica forma de segurar isso sem mexer no Trystero: ele so ve esta classe). O data channel o
//   proprio Trystero fecha antes, entao o outro lado ve a saida normal; a conexao fica aberta, sem ninguem, ate o ICE cair
//   sozinho, e guardada aqui (nao vira lixo coletado);
// - removeTrack() nao tira nada (o removeStream do Trystero, inclusive o da sala que fecha, terminaria em renegociacao);
// - renegociacoes que o outro lado pedir usam o plano congelado no ultimo SDP aplicado (mesmo codec, mesma ordem, mesmos
//   x-google-*): a negociacao nao troca o codec nem os parametros do envio travado.
// Limite: o resto do Chromium nao passa por aqui. Recarregar a pagina (Ctrl+R) fecha a conexao por dentro e trava; por
// isso o aviso pede para fechar o Discord por completo.

import { applyCodecPreferences } from "./codec";
import { errorText, log, logThrottled } from "./log";
import { mungeRemoteSdp, type VideoCodecName } from "./sdp";

export interface SendPlan {
    /** codec de video que queremos ENVIAR para o peer desta conexao */
    codec: VideoCodecName | null;
    /** H.264: perfil por hardware que vai na frente das outras variantes (CodecDecision.h264Profile) */
    h264Profile?: string | null;
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
/** transceiver → "codec:perfil" ja aplicado com setCodecPreferences */
const appliedPrefs = new WeakMap<RTCRtpTransceiver, string>();
const loggedMunge = new WeakMap<RTCPeerConnection, string>();
/** o ultimo plano usado numa negociacao desta conexao (vira o plano congelado se ela for contida) */
const lastPlans = new WeakMap<RTCPeerConnection, SendPlan>();

interface Contained {
    /** plano das negociacoes daqui em diante: o da ultima negociacao (null = nenhuma, nada e reordenado) */
    plan: SendPlan | null;
    /** objetos ligados ao envio travado (sender, stream...): guardados com a conexao ate o Discord reiniciar */
    keep: unknown[];
}

/** Conexoes contidas (ver o topo). Referencia forte de proposito: nunca sai daqui. */
const contained = new Map<RTCPeerConnection, Contained>();

export function setPcHooks(next: PcHooks | null) {
    hooks = next;
}

/**
 * Contem esta conexao (um envio de video dela travou na placa de video): close/removeTrack viram nada e as
 * renegociacoes usam o plano da ultima negociacao. `keep`: objetos a guardar junto. Para sempre (ate o Discord reiniciar).
 */
export function containPeerConnection(pc: RTCPeerConnection, keep: unknown[] = []) {
    const entry = contained.get(pc);
    if (entry) {
        entry.keep.push(...keep);
        return;
    }
    let plan = lastPlans.get(pc) ?? null;
    try {
        plan ??= hooks?.planFor(pc) ?? null;
    } catch { }
    contained.set(pc, { plan, keep: [...keep] });
}

export function isContained(pc: RTCPeerConnection | null | undefined): boolean {
    return !!pc && contained.has(pc);
}

/** Quantas conexoes estao contidas nesta sessao do Discord (diagnostico). */
export function containedCount(): number {
    return contained.size;
}

/** Plano de envio desta conexao: o congelado, se ela estiver contida; senao, o do streaming.ts. */
function planOf(pc: RTCPeerConnection): SendPlan | null {
    const c = contained.get(pc);
    if (c) return c.plan;
    const plan = hooks?.planFor(pc) ?? null;
    if (plan) lastPlans.set(pc, plan);
    return plan;
}

function sendingTransceivers(pc: RTCPeerConnection, kind: "audio" | "video") {
    return pc.getTransceivers().filter(t =>
        t.sender.track?.kind === kind
        && (t.direction === "sendrecv" || t.direction === "sendonly")
        && t.currentDirection !== "stopped"
    );
}

function prepareLocalDescription(pc: RTCPeerConnection) {
    const plan = planOf(pc);
    if (!plan?.codec) return;
    const key = `${plan.codec}:${plan.h264Profile ?? ""}`;
    for (const t of sendingTransceivers(pc, "video")) {
        if (appliedPrefs.get(t) === key) continue;
        appliedPrefs.set(t, key);
        log.info(`${plan.label}: preferência de codec ${applyCodecPreferences(t, plan.codec, plan.h264Profile)}`);
    }
}

function mungeRemoteDescription(pc: RTCPeerConnection, description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (!description?.sdp || (description.type !== "offer" && description.type !== "answer" && description.type !== "pranswer")) return description;
    const plan = planOf(pc);
    if (!plan) return description;

    const mids = (kind: "audio" | "video") => new Set(sendingTransceivers(pc, kind).map(t => t.mid).filter((m): m is string => !!m));
    const videoMids = mids("video");
    const audioMids = mids("audio");
    if (!videoMids.size && !audioMids.size) return description;

    const result = mungeRemoteSdp(description.sdp, { videoMids, audioMids, codec: plan.codec, h264Profile: plan.h264Profile, bitrate: plan.bitrate });
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

        /** Contida: nao fecha (fechar desmonta o envio travado e trava o Discord). Ver o topo. */
        override close(): void {
            if (contained.has(this)) {
                logThrottled("pc-close-contained", "warn", "Uma conexão com o envio travado pela placa de vídeo não foi fechada (fechar travaria o Discord): "
                    + "ela fica aberta, sem uso, até o Discord reiniciar", 60_000);
                return;
            }
            super.close();
        }

        /** Contida: nao tira a faixa (o removeTrack termina numa renegociacao que desmonta o envio travado). */
        override removeTrack(sender: RTCRtpSender): void {
            if (contained.has(this)) {
                logThrottled("pc-remove-contained", "warn", "Uma faixa da conexão com o envio travado pela placa de vídeo não foi removida "
                    + "(remover travaria o Discord)", 60_000);
                return;
            }
            super.removeTrack(sender);
        }
    };
}
