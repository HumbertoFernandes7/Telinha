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
//   injeta x-google-start/max-bitrate (em todas as de video) + opus estereo (ver sdp.ts). Isso garante o codec mesmo
//   quando quem oferta e o outro lado (ex.: os dois transmitindo um para o outro, transceiver reaproveitado)
//   e corta a rampa inicial de bitrate (~12 s de 320x180 ate 720p no spike).
// - candidatos pelo Teredo (core/teredo.ts → TeredoFilter): o Trystero manda os nossos candidatos um a um pelo
//   `onicecandidate` (trickle) e o SDP de cada renegociacao pelo `localDescription`, e aplica os do outro lado com
//   addIceCandidate e setRemoteDescription. Os quatro passam por aqui: um candidato pelo Teredo so sai ou entra quando nao
//   ha outro caminho para o mesmo componente. Os ganchos sao desta classe (o Trystero so ve ela): nada no Trystero e
//   mudado. Se um dia ele passar a ler os candidatos por outro caminho, o filtro so deixa de agir (a conexao nao quebra).
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
// - nenhuma renegociacao chega ao Chromium: setRemoteDescription e setLocalDescription (fora o "rollback") sao recusados.
//   Uma oferta do outro lado (ele comeca ou para de transmitir para nos nesta conexao, ou reinicia o ICE) rodaria SRD/SLD,
//   e o libwebrtc recria o envio de video se as extensoes de cabecalho, o mid ou o extmap-allow-mixed mudarem: e o mesmo
//   travamento. O signal() do Trystero pega a recusa e a manda para o handler de erro (a conexao sai da sala; uma nova,
//   em VP9, pode ser criada depois).
// Limite: o resto do Chromium nao passa por aqui. Recarregar a pagina (Ctrl+R) fecha a conexao por dentro e trava; por
// isso o aviso pede para fechar o Discord por completo.

import { applyCodecPreferences } from "./codec";
import { errorText, log, logThrottled } from "./log";
import { mungeRemoteSdp, type VideoCodecName } from "./sdp";
import { TeredoFilter } from "./teredo";

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

/**
 * Conexoes contidas (ver o topo) → objetos ligados ao envio travado (sender, stream...), guardados com a conexao.
 * Referencia forte de proposito: nunca sai daqui.
 */
const contained = new Map<RTCPeerConnection, unknown[]>();

export function setPcHooks(next: PcHooks | null) {
    hooks = next;
}

/**
 * Contem esta conexao (um envio de video dela travou na placa de video): close/removeTrack viram nada e nenhuma
 * renegociacao passa. `keep`: objetos a guardar junto. Para sempre (ate o Discord reiniciar).
 */
export function containPeerConnection(pc: RTCPeerConnection, keep: unknown[] = []) {
    contained.set(pc, [...(contained.get(pc) ?? []), ...keep]);
}

export function isContained(pc: RTCPeerConnection | null | undefined): boolean {
    return !!pc && contained.has(pc);
}

/** Quantas conexoes estao contidas nesta sessao do Discord (diagnostico). */
export function containedCount(): number {
    return contained.size;
}

/** Recusa uma negociacao numa conexao contida (ver o topo), com um aviso no log. */
function refuseNegotiation(what: string): Promise<void> {
    logThrottled("pc-negotiation-contained", "warn", `${what} recusado na conexão com o envio travado pela placa de vídeo `
        + "(renegociar recriaria o envio e travaria o Discord): essa conexão sai da sala", 60_000);
    return Promise.reject(new DOMException(`Telinha: ${what} recusado (envio travado pela placa de vídeo)`, "InvalidStateError"));
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
    const key = `${plan.codec}:${plan.h264Profile ?? ""}`;
    for (const t of sendingTransceivers(pc, "video")) {
        if (appliedPrefs.get(t) === key) continue;
        appliedPrefs.set(t, key);
        log.info(`${plan.label}: preferência de codec ${applyCodecPreferences(t, plan.codec, plan.h264Profile)}`);
    }
}

function mungeRemoteDescription(pc: RTCPeerConnection, description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
    if (!description?.sdp || (description.type !== "offer" && description.type !== "answer" && description.type !== "pranswer")) return description;
    const plan = hooks?.planFor(pc);
    if (!plan) return description;

    const mids = (kind: "audio" | "video") => new Set(sendingTransceivers(pc, kind).map(t => t.mid).filter((m): m is string => !!m));
    const videoMids = mids("video");
    const audioMids = mids("audio");
    // a banda vai em toda m-section de video, enviando ou nao (sdp.ts → RemoteSdpPlan.bitrate)
    if (!videoMids.size && !audioMids.size && !plan.bitrate) return description;

    const result = mungeRemoteSdp(description.sdp, { videoMids, audioMids, codec: plan.codec, h264Profile: plan.h264Profile, bitrate: plan.bitrate });
    const summary = [...result.changes, ...result.notes].join("; ");
    if (summary && loggedMunge.get(pc) !== summary) {
        loggedMunge.set(pc, summary);
        log.info(`${plan.label}: SDP remoto (${description.type}) ajustado — ${summary}`);
    }
    return result.changes.length ? { type: description.type, sdp: result.sdp } : description;
}

/** Nome do peer desta conexao para o log (do plano de envio); nunca lanca. */
function labelOf(pc: RTCPeerConnection): string {
    try {
        return hooks?.planFor(pc)?.label ?? "conexão";
    } catch {
        return "conexão";
    }
}

const teredoFilters = new WeakMap<RTCPeerConnection, TeredoFilter>();

/** O filtro de candidatos pelo Teredo desta conexao (core/teredo.ts). */
function teredoOf(pc: RTCPeerConnection): TeredoFilter {
    let filter = teredoFilters.get(pc);
    if (!filter) teredoFilters.set(pc, filter = new TeredoFilter(() => labelOf(pc)));
    return filter;
}

/** O SDP dos nossos candidatos que vai para o outro lado, sem os pelo Teredo que tem outro caminho. */
function filteredLocal(pc: RTCPeerConnection, d: RTCSessionDescription | null): RTCSessionDescription | null {
    if (!d?.sdp) return d;
    let { sdp } = d;
    try {
        sdp = teredoOf(pc).filterSdp(d.sdp, "local");
    } catch (e) {
        logThrottled("pc-teredo-local", "warn", "Falha ao filtrar os candidatos do SDP local (usando o original): " + errorText(e));
    }
    return sdp === d.sdp ? d : { type: d.type, sdp, toJSON: () => ({ type: d.type, sdp }) } as RTCSessionDescription;
}

/** Classe criada sob demanda (nunca no carregamento do modulo). */
export function getPeerConnectionClass(): typeof RTCPeerConnection {
    if (PeerConnectionClass) return PeerConnectionClass;
    const iceHandlers = new WeakMap<RTCPeerConnection, ((ev: RTCPeerConnectionIceEvent) => any) | null>();
    const Base = RTCPeerConnection;
    const cls = class TelinhaPeerConnection extends Base {
        constructor(config?: RTCConfiguration) {
            super(config);
            // os nossos candidatos: o handler que o Trystero poe em onicecandidate (acessor abaixo) so recebe o que o
            // filtro deixa passar; o evento original nunca chega nele direto
            this.addEventListener("icecandidate", ev => {
                const handler = iceHandlers.get(this);
                if (!handler) return;
                try {
                    teredoOf(this).localCandidate(ev as RTCPeerConnectionIceEvent, e => handler.call(this, e));
                } catch (e) {
                    logThrottled("pc-teredo-ice", "warn", "Falha ao filtrar um candidato local (enviado como veio): " + errorText(e));
                    handler.call(this, ev as RTCPeerConnectionIceEvent);
                }
            });
        }

        override addIceCandidate(candidate?: RTCIceCandidateInit | null, ...legacy: any[]): Promise<void> {
            if (legacy.length || typeof candidate?.candidate !== "string" || !candidate.candidate) return (super.addIceCandidate as any)(candidate, ...legacy);
            const init: RTCIceCandidateInit = {
                candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment
            };
            let now: Promise<void> | null = null;
            let sync = true;
            try {
                teredoOf(this).remoteCandidate(init, c => {
                    const added = super.addIceCandidate(c);
                    if (sync) now = added;
                    // segurado e liberado depois (core/teredo.ts): o Trystero ja seguiu; um erro aqui (ex.: conexao fechada) so some
                    else added.catch(() => { });
                });
            } catch (e) {
                logThrottled("pc-teredo-remote", "warn", "Falha ao filtrar um candidato do outro lado (aplicado como veio): " + errorText(e));
                return super.addIceCandidate(candidate);
            } finally {
                sync = false;
            }
            return now ?? Promise.resolve();
        }

        override setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
            // contida: so o rollback passa (desfaz uma oferta nossa pendente sem tocar no envio)
            if (contained.has(this) && description?.type !== "rollback") return refuseNegotiation("setLocalDescription");
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
            if (contained.has(this)) return refuseNegotiation("setRemoteDescription");
            let munged = description;
            try {
                munged = mungeRemoteDescription(this, description);
            } catch (e) {
                logThrottled("pc-munge", "warn", "Falha ao ajustar o SDP remoto (usando o original): " + errorText(e));
            }
            try {
                // candidatos do outro lado no SDP (renegociacao, reinicio do ICE): sem os pelo Teredo que tem outro caminho
                const sdp = munged.sdp && teredoOf(this).filterSdp(munged.sdp, "remote");
                if (sdp && sdp !== munged.sdp) munged = { type: munged.type, sdp };
            } catch (e) {
                logThrottled("pc-teredo-remote-sdp", "warn", "Falha ao filtrar os candidatos do SDP remoto (usando o original): " + errorText(e));
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
    // acessores definidos fora da sintaxe de classe: no TypeScript do DOM os dois sao propriedades
    Object.defineProperty(cls.prototype, "onicecandidate", {
        configurable: true,
        get(this: RTCPeerConnection) {
            return iceHandlers.get(this) ?? null;
        },
        set(this: RTCPeerConnection, handler: ((ev: RTCPeerConnectionIceEvent) => any) | null) {
            iceHandlers.set(this, typeof handler === "function" ? handler : null);
        }
    });
    Object.defineProperty(cls.prototype, "localDescription", {
        configurable: true,
        get(this: RTCPeerConnection) {
            return filteredLocal(this, Reflect.get(Base.prototype, "localDescription", this));
        }
    });
    return PeerConnectionClass = cls;
}
