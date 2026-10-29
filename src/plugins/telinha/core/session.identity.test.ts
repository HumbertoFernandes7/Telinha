/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da prova de identidade DENTRO da sessao (core/session.ts), de ponta a ponta: cada peer manda um id_token RS256
// assinado com uma chave de teste que o JWKS falso do Discord publica, com o nonce amarrado ao certificado DTLS que ele
// usa na RTCPeerConnection falsa. Conferindo -> verificado/falso/nao verificado, impostores, a acao "identity"
// (renovacao e limites), o anuncio do nosso token quando ele muda, verificacoes lentas (relogio falso) e o diagnostico.
// Rodar:  pnpm test:file src/plugins/telinha/core/session.identity.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getState } from "@plugins/telinha/store";
import { eventually, useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { type FakeRoom, trystero } from "@test/fakes/trystero";
import { dataStoreData, FRIEND_ID, joinVoice, ME_ID, modals, OTHER_ID, VOICE_CHANNEL_ID, VoiceStateStore } from "@test/fakes/vencord";
import { FakeMediaStream, FakeRTCPeerConnection, installWebRtc, videoTrack, type WebRtcEnv } from "@test/fakes/webrtc";
import { fakeDer, type FakeDiscord, installFakeDiscord, makeIdToken, makeRsaKey, type TestKey, tokenResponse } from "@test/helpers/wpa-identity";
import { hello, logged, logMark, presence, settleImmediates, untilTrue } from "@test/helpers/wpa-session";
import type { ReactElement } from "react";

import { rt } from "./context";
import { authorizeIdentity, forgetIdentity, prepareIdentity } from "./identity";
import { getLocalCertificate, type LocalCertificate } from "./identity/certificate";
import { OAUTH_REDIRECT_URI } from "./identity/config";
import { decodeJwt } from "./identity/jwt";
import { peerIdentityDiagnostics, startSession, stopSession } from "./session";
import { watch } from "./viewing";

const TOKENS_KEY = "telinha-identity-tokens-v1";
const DUP_ID = "200000000000000009";
const DAY = 24 * 60 * 60_000;

/** a RTCPeerConnection falsa onde o Trystero falso espera a real */
const asPc = (pc: FakeRTCPeerConnection) => pc as unknown as RTCPeerConnection;

describe("sessao: prova de identidade dos peers", () => {
    let rtc: WebRtcEnv;
    let native: NativeEnv;
    let discord: FakeDiscord;
    let K1: TestKey;
    let cert: LocalCertificate;
    let ourToken: string;
    let room: FakeRoom;

    /** a conexao com o peer (a classe do Telinha), com o certificado DER que ele usou no DTLS */
    function newPc(der?: ArrayBuffer): FakeRTCPeerConnection {
        const Pc = room.config.rtcPolyfill as typeof FakeRTCPeerConnection;
        const pc = new Pc(room.config.rtcConfig);
        if (der) pc.sctp!.transport.remoteCertificates = [der];
        return pc;
    }

    /** um peer com prova (token amarrado ao certificado que ele usa; opcoes trocam o token) */
    async function connectWithToken(peerId: string, userId: string, name: string, over: { fingerprint?: string; expMs?: number; iatMs?: number; } = {}) {
        const { der, fingerprint } = fakeDer();
        const pc = newPc(der);
        const idToken = await makeIdToken({ userId, fingerprint: over.fingerprint ?? fingerprint, key: K1, expMs: over.expMs, iatMs: over.iatMs });
        await room.connectPeer(peerId, { hello: hello(userId, name, idToken), pc: asPc(pc) });
        return { pc, der, fingerprint, idToken };
    }

    const identityOf = (peerId: string) => rt.peers.get(peerId)?.identity;

    before(async () => {
        rtc = installWebRtc();
        native = installNative();
        K1 = makeRsaKey("k1");
        discord = installFakeDiscord({ keys: [K1.jwk] });
        trystero.reset();

        // ja autorizamos o Telinha nesta conta: token guardado, amarrado ao nosso certificado
        cert = await getLocalCertificate();
        ourToken = await makeIdToken({ userId: ME_ID, fingerprint: cert.fingerprint, key: K1 });
        const { exp } = decodeJwt(ourToken)!.payload as { exp: number; };
        dataStoreData.set(TOKENS_KEY, { [ME_ID]: { idToken: ourToken, expiresAt: exp * 1000, fingerprint: cert.fingerprint } });
    });

    after(() => {
        stopSession();
        discord.restore();
        native.restore();
        rtc.restore();
        modals.reset();
    });

    describe("na sala (timers reais)", () => {
        before(async () => {
            startSession();
            joinVoice(VOICE_CHANNEL_ID, { users: [FRIEND_ID, OTHER_ID, DUP_ID] });
            room = await eventually(() => trystero.lastRoom);
            await eventually(() => (rt.room as unknown) === room);
        });

        after(() => stopSession());

        test("o nosso hello leva o id_token amarrado ao certificado da sala (e nao repete pela acao identity)", async () => {
            assert.equal(rt.certFingerprint, cert.fingerprint);
            const { sentHello } = await room.connectPeer("peerSemProva", { hello: hello(DUP_ID, "semprova") });
            assert.equal((sentHello as { idToken?: string; }).idToken, ourToken);
            assert.equal(room.sentOn("identity", "peerSemProva").filter(m => m.target != null).length, 0);
            assert.equal(identityOf("peerSemProva"), "unverified");
            assert.equal(rt.peers.get("peerSemProva")?.identityReason, "missing");
        });

        test("prova valida: 'conferindo' (sem presenca) e depois verificado, admitido e com a presenca", async () => {
            const mark = logMark();
            const { pc } = await connectWithToken("peerVerif1", FRIEND_ID, "amigo");
            const entry = rt.peers.get("peerVerif1")!;
            assert.equal(entry.identity, "pending");
            assert.equal(entry.admitted, false);
            assert.equal(room.sentOn("presence", "peerVerif1").filter(m => m.target != null).length, 0, "conferindo: nada de presenca");
            assert.equal("idToken" in entry.hello!, false, "o token nao fica no estado da sessao");
            assert.equal(logged(/^amigo \(peerVe\) entrou na sala; conferindo a identidade do Discord…$/, mark).length, 1);

            await eventually(() => entry.identity === "verified");
            assert.equal(entry.admitted, true);
            assert.equal(room.sentOn("presence", "peerVerif1").length >= 1, true);
            assert.equal(logged(/^amigo \(peerVe\): identidade do Discord verificada$/, mark).length, 1);
            await eventually(() => getState().peers.find(p => p.peerId === "peerVerif1")?.identity === "verified");
            assert.ok(pc);
        });

        test("prova falsa (token copiado de outra conexao): fora da lista, alerta 'fake', nada dele e ouvido", async () => {
            const mark = logMark();
            const victim = fakeDer();
            const { pc } = await connectWithToken("peerFalso1", OTHER_ID, "vitima", { fingerprint: victim.fingerprint });
            // pedimos para assistir enquanto ainda conferia: vira o erro da prova falsa
            watch("peerFalso1");
            assert.match(rt.viewing.get("peerFalso1")?.error ?? "", /Ainda conferindo a identidade/);

            await eventually(() => identityOf("peerFalso1") === "invalid");
            assert.equal(logged(/^Uma conexão \(peerFa\) apresentou uma prova de identidade falsa de vitima \(discord 300000000000000003\): prova de outra conexão \(copiada\)\. Pode ser alguém se passando/, mark)[0]?.level, "warn");
            assert.match(rt.viewing.get("peerFalso1")?.error ?? "", /prova de identidade falsa/);
            await eventually(() => getState().identityAlerts?.some(a => a.kind === "fake"));
            assert.deepEqual(getState().identityAlerts?.find(a => a.kind === "fake"), { discordUserId: OTHER_ID, username: "vitima", peerIds: ["peerFalso1"], self: false, kind: "fake" });
            assert.equal(getState().peers.some(p => p.peerId === "peerFalso1"), false);

            const sent = room.sent.length;
            room.receive("presence", presence(OTHER_ID, "vitima", { streaming: true }), "peerFalso1");
            room.receive("watch", { op: "start" }, "peerFalso1");
            room.emitStream("peerFalso1", new FakeMediaStream([videoTrack()]));
            room.receive("identity", { idToken: "a.b.c" }, "peerFalso1");
            assert.equal(room.sent.length, sent, "nenhuma resposta");
            assert.equal(rt.peers.get("peerFalso1")?.presence, null);
            assert.match(peerIdentityDiagnostics(), /vitima \(peerFa\)=identidade falsa \[fingerprint-mismatch\]/);
            assert.match(peerIdentityDiagnostics(), /últimas falhas de verificação: \d\d:\d\d:\d\d vitima \(peerFa\) identidade falsa \[fingerprint-mismatch\]/);
            assert.ok(pc);
        });

        test("impostores: conexoes sem prova dizendo ser quem provou a identidade; so elas ficam marcadas", async () => {
            const mark = logMark();
            await room.connectPeer("peerImpA01", { hello: hello(FRIEND_ID, "amigo") });
            assert.equal(logged(/^Uma conexão não verificada \(peerIm\) diz ser amigo \(discord 200000000000000002\), que provou a identidade em peerVe: só a não verificada fica bloqueada\.$/, mark).length, 1);
            assert.deepEqual([rt.peers.get("peerImpA01")?.impostor, rt.peers.get("peerVerif1")?.duplicate], [true, false]);

            await room.connectPeer("peerImpB01", { hello: hello(FRIEND_ID, "amigo") });
            assert.equal(logged(/^2 conexões não verificadas \(peerIm, peerIm\) dizem ser amigo \(discord 200000000000000002\), que provou a identidade em peerVe: só as não verificadas ficam bloqueadas\.$/, mark).length, 1);
            await eventually(() => getState().identityAlerts?.some(a => a.kind === "impostor"));
            assert.deepEqual(getState().identityAlerts?.find(a => a.kind === "impostor")?.peerIds, ["peerImpA01", "peerImpB01"]);
            assert.match(peerIdentityDiagnostics(), /amigo \(peerIm\)=não verificado \[missing\] \(impostor\)/);

            room.disconnectPeer("peerImpA01");
            room.disconnectPeer("peerImpB01");
            await eventually(() => !getState().identityAlerts?.some(a => a.kind === "impostor"));
        });

        test("acao identity: quem autorizou no meio da call vira verificado; lixo, verificado e falso sao ignorados", async t => {
            const { der, fingerprint } = fakeDer();
            await room.connectPeer("peerTarde1", { hello: hello(DUP_ID, "tarde"), pc: asPc(newPc(der)) });
            assert.equal(identityOf("peerTarde1"), "unverified");
            const mark = logMark();

            room.receive("identity", "lixo", "peerTarde1");
            room.receive("identity", { idToken: 42 }, "peerTarde1");
            room.receive("identity", { idToken: "a.b.c" }, "desconhecido");
            room.receive("identity", { idToken: "a.b.c" }, "peerLixo00");
            room.receive("identity", {
                get idToken(): string {
                    throw new Error("getter hostil");
                }
            }, "peerTarde1");
            assert.equal(logged(/^Identidade: mensagem de identidade ignorada: Error: getter hostil$/, mark).length, 1);

            // prova vencida (alem da carencia): continua nao verificado, mas agora com o motivo
            const expired = await makeIdToken({ userId: DUP_ID, fingerprint, key: K1, iatMs: Date.now() - 10 * DAY, expMs: Date.now() - 9 * DAY });
            room.receive("identity", { idToken: expired }, "peerTarde1");
            await eventually(() => rt.peers.get("peerTarde1")?.identityReason === "expired");
            assert.equal(identityOf("peerTarde1"), "unverified");
            assert.match(peerIdentityDiagnostics(), /tarde \(peerTa\) não verificado \[expired\]/);

            // menos de 10 s depois: ignorada (mesmo valida)
            const good = await makeIdToken({ userId: DUP_ID, fingerprint, key: K1 });
            room.receive("identity", { idToken: good }, "peerTarde1");
            await settleImmediates();
            assert.equal(identityOf("peerTarde1"), "unverified");

            const real = Date.now;
            t.mock.method(Date, "now", () => real() + 11_000);
            room.receive("identity", { idToken: good }, "peerTarde1");
            await eventually(() => identityOf("peerTarde1") === "verified");
            assert.equal(rt.peers.get("peerTarde1")?.identityReason, undefined);
            const checked = rt.peers.get("peerTarde1")!.identityCheckedAt;
            room.receive("identity", { idToken: good }, "peerTarde1");
            assert.equal(rt.peers.get("peerTarde1")!.identityCheckedAt, checked, "verificado fica ate a conexao cair");
        });

        test("acao identity com prova falsa de quem ja estava admitido (sem prova): perde a admissao", async () => {
            await room.connectPeer("peerVira01", { hello: hello(DUP_ID, "vira"), pc: asPc(newPc(fakeDer().der)) });
            assert.equal(rt.peers.get("peerVira01")?.admitted, true);
            const copied = await makeIdToken({ userId: DUP_ID, fingerprint: fakeDer().fingerprint, key: K1 });
            const mark = logMark();
            room.receive("identity", { idToken: copied }, "peerVira01");
            await eventually(() => identityOf("peerVira01") === "invalid");
            assert.equal(rt.peers.get("peerVira01")?.admitted, false);
            assert.equal(logged(/^vira \(peerVi\) não está mais admitido \(prova de identidade falsa\)$/, mark).length, 1);
            room.disconnectPeer("peerVira01");
        });

        test("verificacao que lanca (conexao quebrada): nao verificado por timeout, com aviso", async () => {
            const pc = newPc();
            Object.defineProperty(pc, "sctp", {
                get() {
                    throw new Error("conexao fechada");
                }
            });
            const mark = logMark();
            await room.connectPeer("peerQuebra", { hello: hello(DUP_ID, "quebrada", "a.b.c"), pc: asPc(pc) });
            await eventually(() => identityOf("peerQuebra") === "unverified");
            assert.equal(rt.peers.get("peerQuebra")?.identityReason, "timeout");
            assert.equal(logged(/^Identidade: erro ao conferir um peer: Error: conexao fechada$/, mark).length, 1);
            room.disconnectPeer("peerQuebra");
        });

        test("erro ao aplicar o resultado: aviso no log, a sessao segue", async t => {
            const { der, fingerprint } = fakeDer();
            const pc = newPc(der);
            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            pc.stats = async () => {
                await gate;
                return [];
            };
            const idToken = await makeIdToken({ userId: DUP_ID, fingerprint, key: K1 });
            await room.connectPeer("peerAplica", { hello: hello(DUP_ID, "aplica", idToken), pc: asPc(pc) });
            const mark = logMark();
            t.mock.method(VoiceStateStore, "getVoiceStatesForChannel", () => {
                throw new Error("store quebrado");
            });
            release();
            await eventually(() => logged(/^Identidade: erro ao aplicar a verificação de um peer: Error: store quebrado$/, mark).length === 1);
            assert.equal(identityOf("peerAplica"), "verified");
            t.mock.restoreAll();
            room.disconnectPeer("peerAplica");
        });

        /** O usuario autoriza o Telinha (modal falso + token endpoint falso devolvendo `idToken`). */
        async function authorizeWith(idToken: string) {
            discord.tokenImpl = () => tokenResponse({ id_token: idToken });
            const done = authorizeIdentity();
            const m = await eventually(() => modals.top());
            const { props } = modals.element(m.key) as ReactElement<{ state: string; callback(r: { location: string; }): void; }>;
            props.callback({ location: `${OAUTH_REDIRECT_URI}?code=c&state=${props.state}` });
            modals.close(m.key);
            assert.equal(await done, true);
        }

        test("o nosso token muda no meio da sala: vai pela acao identity para quem ainda nao recebeu (nunca para o falso)", async () => {
            const newToken = await makeIdToken({ userId: ME_ID, fingerprint: cert.fingerprint, key: K1, iatMs: Date.now() - 30_000 });
            await authorizeWith(newToken);
            const announced = room.sentOn("identity").filter(m => m.target != null).at(-1)!;
            assert.deepEqual(announced.data, { idToken: newToken });
            const targets = announced.target as string[];
            assert.ok(targets.includes("peerVerif1") && targets.includes("peerSemProva") && targets.includes("peerTarde1"));
            assert.equal(targets.includes("peerFalso1"), false);

            // o mesmo token de novo (outra mudanca de estado): nada sai
            const count = room.sentOn("identity").length;
            await prepareIdentity();
            assert.equal(room.sentOn("identity").length, count);

            // erro ao montar a mensagem: so um aviso
            const mark = logMark();
            const desc = Object.getOwnPropertyDescriptor(rt, "certFingerprint")!;
            Object.defineProperty(rt, "certFingerprint", {
                configurable: true,
                get() {
                    throw new Error("estado quebrado");
                }
            });
            try {
                await prepareIdentity();
            } finally {
                Object.defineProperty(rt, "certFingerprint", desc);
            }
            assert.equal(logged(/^Identidade: falha ao anunciar o token: Error: estado quebrado$/, mark).length, 1);

            // desvinculado: nada a anunciar; quem chega agora recebe o hello sem token
            await forgetIdentity();
            assert.equal(room.sentOn("identity").length, count);
            const { sentHello } = await room.connectPeer("peerNovo01", { hello: hello(DUP_ID, "novo") });
            assert.equal("idToken" in (sentHello as object), false);

            // autorizou de novo, e o envio falha: so um aviso
            const action = room.actions.get("identity")!;
            action.sendImpl = () => Promise.reject(new Error("canal fechado"));
            await authorizeWith(await makeIdToken({ userId: ME_ID, fingerprint: cert.fingerprint, key: K1, iatMs: Date.now() - 20_000 }));
            assert.ok((room.sentOn("identity").at(-1)!.target as string[]).includes("peerNovo01"));
            await eventually(() => logged(/^Falha ao enviar a prova de identidade: Error: canal fechado$/, mark).length === 1);
            action.sendImpl = null;
        });

        test("ultimas falhas: so as 10 mais recentes no diagnostico", async () => {
            for (let i = 0; i < 11; i++) {
                const peerId = `peerVelho${String(i).padStart(2, "0")}`;
                await connectWithToken(peerId, DUP_ID, `velho${i}`, { iatMs: Date.now() - 10 * DAY, expMs: Date.now() - 9 * DAY });
                await eventually(() => rt.peers.get(peerId)?.identityReason === "expired");
            }
            const failures = /últimas falhas de verificação: (.*)$/.exec(peerIdentityDiagnostics())![1].split("; ");
            assert.equal(failures.length, 10);
            assert.match(failures.at(-1)!, /velho10 \(peerVe\) não verificado \[expired\]$/);
        });
    });

    describe("verificacoes lentas (relogio falso)", () => {
        async function enterRoom(t: Parameters<typeof useFakeClock>[0]) {
            const clock = useFakeClock(t, { startEpoch: Date.now() });
            startSession();
            room = await untilTrue(() => rt.room) as unknown as FakeRoom;
            return clock;
        }

        test("depois de parar e entrar de novo, o diagnostico comeca vazio", async t => {
            await enterRoom(t);
            assert.match(peerIdentityDiagnostics(), /identidade dos peers: nenhum\núltimas falhas de verificação: nenhuma$/);
            stopSession();
        });

        test("DTLS ainda nao conectado no join: confere de novo em 1,5 s", async t => {
            const clock = await enterRoom(t);
            const { der, fingerprint } = fakeDer();
            const pc = newPc(der);
            pc.sctp!.transport.state = "connecting";
            const idToken = await makeIdToken({ userId: FRIEND_ID, fingerprint, key: K1 });
            const mark = logMark();
            await room.connectPeer("peerLento1", { hello: hello(FRIEND_ID, "lento", idToken), pc: asPc(pc) });
            await untilTrue(() => logged(/^Identidade: fingerprint DTLS do peer indisponível \(dtls-not-connected\)$/, mark).length === 1);
            await settleImmediates();
            assert.equal(identityOf("peerLento1"), "pending", "ainda conferindo");

            pc.sctp!.transport.state = "connected";
            clock.tick(1500);
            await untilTrue(() => identityOf("peerLento1") === "verified");

            // de novo sem fingerprint na segunda vez: fica nao verificado
            const other = newPc();
            other.sctp!.transport.state = "new";
            await room.connectPeer("peerLento2", { hello: hello(OTHER_ID, "lento2", idToken), pc: asPc(other) });
            await settleImmediates();
            clock.tick(1500);
            await untilTrue(() => identityOf("peerLento2") === "unverified");
            assert.equal(rt.peers.get("peerLento2")?.identityReason, "no-fingerprint");

            // saiu antes da segunda conferencia: nada acontece
            const gone = newPc();
            gone.sctp!.transport.state = "new";
            await room.connectPeer("peerLento3", { hello: hello(DUP_ID, "lento3", idToken), pc: asPc(gone) });
            await settleImmediates();
            room.disconnectPeer("peerLento3");
            clock.tick(1500);
            await settleImmediates();
            assert.equal(rt.peers.has("peerLento3"), false);
            stopSession();
        });

        test("verificacao que nao termina em 10 s: nao verificado ('demorou demais'); quem saiu no meio e ignorado", async t => {
            const clock = await enterRoom(t);
            const stuck = (pc: FakeRTCPeerConnection) => {
                pc.stats = () => new Promise(() => { });
                return pc;
            };
            const { der, fingerprint } = fakeDer();
            const idToken = await makeIdToken({ userId: FRIEND_ID, fingerprint, key: K1 });
            await room.connectPeer("peerTravado", { hello: hello(FRIEND_ID, "travado", idToken), pc: asPc(stuck(newPc(der))) });
            await room.connectPeer("peerSaiu001", { hello: hello(OTHER_ID, "saiu", idToken), pc: asPc(stuck(newPc(der))) });
            await settleImmediates();
            room.disconnectPeer("peerSaiu001");
            clock.tick(9_999);
            await settleImmediates();
            assert.equal(identityOf("peerTravado"), "pending");

            clock.tick(1);
            await untilTrue(() => identityOf("peerTravado") === "unverified");
            assert.equal(rt.peers.get("peerTravado")?.identityReason, "timeout");
            assert.match(peerIdentityDiagnostics(), /travado \(peerTr\) não verificado \[timeout\]/);
            assert.equal(/saiu/.test(peerIdentityDiagnostics()), false);
            stopSession();
        });
    });
});
