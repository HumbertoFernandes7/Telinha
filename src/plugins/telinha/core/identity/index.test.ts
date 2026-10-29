/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do lado LOCAL da prova de identidade (core/identity/index.ts) de ponta a ponta com o Discord falso: o modal
// OAuth2 (fake), a troca do code no token endpoint (installFetch), o id_token assinado com uma chave de teste que o
// JWKS falso publica, o DataStore e o certificado DTLS falsos. Os testes rodam EM ORDEM: o estado do modulo (token,
// limites de renovacao, cache do JWKS) passa de um para o outro, como numa sessao do Discord.
// Rodar:  pnpm test:file src/plugins/telinha/core/identity/index.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eventually } from "@test/fakes/clock";
import { dataStoreData, dataStoreImpl, makeUser, ME_ID, modals, UserStore } from "@test/fakes/vencord";
import { FakeRTCPeerConnection, installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { type FakeDiscord, installFakeDiscord, makeIdToken, makeRsaKey, type ShiftableNow, shiftableNow, type TestKey, tokenResponse } from "@test/helpers/wpa-identity";
import { logged, logMark } from "@test/helpers/wpa-session";
import type { ReactElement } from "react";

import { getLocalCertificate, type LocalCertificate } from "./certificate";
import { DISCORD_CLIENT_ID, MAX_TOKEN_AGE_MS, OAUTH_REDIRECT_URI } from "./config";
import { nonceForFingerprint } from "./fingerprint";
import {
    authorizeIdentity, forgetIdentity, getLocalIdentityState, getLocalIdToken, hasAuthorizedBefore, localIdentityDiagnostics,
type LocalIdentityState, prepareIdentity, renewIdentity, subscribeLocalIdentity
} from "./index";
import { decodeJwt } from "./jwt";
import { pkceChallenge } from "./oauth";

const TOKENS_KEY = "telinha-identity-tokens-v1";
const HOUR = 60 * 60_000;

interface StoredIdentity { idToken: string; expiresAt: number; fingerprint: string; refreshToken?: string; }

const stored = (userId = ME_ID): StoredIdentity | undefined => (dataStoreData.get(TOKENS_KEY) as Record<string, StoredIdentity> | undefined)?.[userId];

function setStored(value: StoredIdentity | null, userId = ME_ID) {
    const all = { ...(dataStoreData.get(TOKENS_KEY) as Record<string, StoredIdentity> | undefined) };
    if (value) all[userId] = value;
    else delete all[userId];
    dataStoreData.set(TOKENS_KEY, all);
}

type ModalProps = Record<string, any> & { callback(response?: { location?: unknown; }): void; };

/** O modal "Autorizar" que o plugin abriu agora (espera ele abrir). */
async function nextModal(): Promise<{ key: string; props: ModalProps; }> {
    const m = await eventually(() => modals.top());
    return { key: m.key, props: (modals.element(m.key) as ReactElement<ModalProps>).props };
}

/** O usuario clica em Autorizar: o Discord chama o callback com o location e fecha o modal. */
function approve(modal: { key: string; props: ModalProps; }, location?: unknown) {
    modal.props.callback({ location: location ?? `${OAUTH_REDIRECT_URI}?code=CODE-${modal.props.state}&state=${modal.props.state}&iss=https%3A%2F%2Fdiscord.com` });
    modals.close(modal.key);
}

describe("identidade local (index.ts)", () => {
    let rtc: WebRtcEnv;
    let clock: ShiftableNow;
    let discord: FakeDiscord;
    let K1: TestKey;
    let cert: LocalCertificate;
    /** ultimo id_token que o token endpoint falso devolveu */
    let issued = "";

    const goodToken = (over: { claims?: Record<string, unknown>; fingerprint?: string; } = {}) =>
        makeIdToken({ userId: ME_ID, fingerprint: over.fingerprint ?? cert.fingerprint, key: K1, claims: over.claims });

    /** token endpoint: devolve `fields` (+ um id_token bom, salvo se `idToken` for dado/null). */
    function answerTokens(fields: Record<string, unknown> = {}, idToken?: () => Promise<string | null>) {
        discord.tokenImpl = async () => {
            const token = idToken ? await idToken() : await goodToken();
            if (token) issued = token;
            return tokenResponse({ ...fields, ...(token ? { id_token: token } : {}) });
        };
    }

    /** autorizacao completa que da certo (estado "ready") */
    async function authorizeOk(refreshToken?: string) {
        answerTokens(refreshToken ? { refresh_token: refreshToken } : {});
        const done = authorizeIdentity();
        approve(await nextModal());
        assert.equal(await done, true);
    }

    before(() => {
        clock = shiftableNow();
        rtc = installWebRtc();
        K1 = makeRsaKey("k1");
        discord = installFakeDiscord({ keys: [K1.jwk] });
    });

    after(() => {
        discord.restore();
        rtc.restore();
        clock.restore();
        modals.reset();
    });

    test("comeca 'carregando', sem token", () => {
        assert.deepEqual(getLocalIdentityState(), { status: "loading" });
        assert.equal(getLocalIdToken(), null);
        assert.equal(localIdentityDiagnostics(), `identidade: configurada (app ${DISCORD_CLIENT_ID}); local: carregando; renovação sem janela: não`);
    });

    test("certificado DTLS indisponivel: estado de erro, sem certificado (o Telinha segue sem prova)", async () => {
        FakeRTCPeerConnection.generateCertificateImpl = () => Promise.reject(new Error("sem suporte"));
        const mark = logMark();
        assert.deepEqual(await prepareIdentity(), { certificates: [], fingerprint: null });
        assert.deepEqual(getLocalIdentityState(), { status: "error", error: "certificado DTLS indisponível" });
        assert.equal(logged(/^Identidade: não foi possível preparar o certificado DTLS: Error: sem suporte$/, mark).length, 1);
        assert.match(localIdentityDiagnostics(), /local: erro \(certificado DTLS indisponível\); renovação sem janela: não; último erro local \d{4}-\d\d-\d\d \d\d:\d\d UTC: certificado DTLS: Error: sem suporte$/);
        // de novo: continua em erro (so o primeiro carregamento muda o estado)
        await prepareIdentity();
        assert.equal(getLocalIdentityState().status, "error");
        FakeRTCPeerConnection.generateCertificateImpl = null;
    });

    test("certificado que nao pode ser gravado: aviso (vale ate fechar o Discord); nunca autorizou: 'unauthorized'", async t => {
        const set = t.mock.method(dataStoreImpl, "set", async () => {
            throw new Error("IndexedDB cheio");
        });
        const mark = logMark();
        const prepared = await prepareIdentity();
        set.mock.restore();
        cert = await getLocalCertificate();
        assert.equal(cert.persisted, false);
        assert.deepEqual(prepared, { certificates: [cert.certificate], fingerprint: cert.fingerprint });
        assert.deepEqual(getLocalIdentityState(), { status: "unauthorized" });
        assert.equal(logged(/o certificado DTLS não pôde ser gravado; a autorização valerá só até fechar o Discord/, mark).length, 1);
        assert.match(localIdentityDiagnostics(), /local: não autorizada;/);
    });

    test("hasAuthorizedBefore: nunca autorizou, ou sem usuario: false", async () => {
        assert.equal(await hasAuthorizedBefore(), false);
        UserStore.setCurrentUser(null);
        assert.equal(await hasAuthorizedBefore(), false);
        UserStore.reset();
    });

    test("autorizar: modal com PKCE/state/nonce do certificado, troca do code, a propria verificacao e o token guardado", async () => {
        const seen: LocalIdentityState[] = [];
        const off = subscribeLocalIdentity(s => seen.push(s));
        const offBroken = subscribeLocalIdentity(() => {
            throw new Error("ouvinte quebrado");
        });
        answerTokens({ refresh_token: "R1" });
        const mark = logMark();

        const done = authorizeIdentity();
        const modal = await nextModal();
        const { props } = modal;
        assert.equal(getLocalIdentityState().status, "authorizing");
        assert.match(localIdentityDiagnostics(), /local: autorizando;/);
        assert.equal(props.clientId, DISCORD_CLIENT_ID);
        assert.deepEqual(props.scopes, ["openid"]);
        assert.equal(props.redirectUri, OAUTH_REDIRECT_URI);
        assert.equal(props.prompt, "consent");
        assert.equal(props.codeChallengeMethod, "S256");
        assert.equal(props.nonce, await nonceForFingerprint(cert.fingerprint), "nonce = hash do fingerprint do NOSSO certificado");
        assert.match(props.state, /^[A-Za-z0-9_-]{22}$/);
        approve(modal);
        assert.equal(await done, true);

        // o token endpoint recebeu o code e o verifier do PKCE (cliente publico: sem client_secret)
        const body = discord.tokenRequests.at(-1)!;
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), `CODE-${props.state}`);
        assert.equal(body.get("client_id"), DISCORD_CLIENT_ID);
        assert.equal(body.get("redirect_uri"), OAUTH_REDIRECT_URI);
        assert.equal(await pkceChallenge(body.get("code_verifier")!), props.codeChallenge);
        assert.equal(body.has("client_secret"), false);
        assert.equal(discord.jwksRequests.at(-1)?.init?.credentials, "omit");

        const { iat, exp } = decodeJwt(issued)!.payload as { iat: number; exp: number; };
        assert.deepEqual(getLocalIdentityState(), { status: "ready", userId: ME_ID, issuedAt: iat * 1000, expiresAt: exp * 1000 + MAX_TOKEN_AGE_MS });
        assert.deepEqual(stored(), { idToken: issued, expiresAt: exp * 1000, fingerprint: cert.fingerprint, refreshToken: "R1" });
        assert.deepEqual(seen.map(s => s.status), ["authorizing", "ready"]);
        assert.equal(logged(/^Identidade do Discord pronta \(válida por ~60 min\)$/, mark).length, 1);
        assert.match(localIdentityDiagnostics(), /local: pronta \(prova renovada em \d{4}-\d\d-\d\d \d\d:\d\d, aceita até \d{4}-\d\d-\d\d \d\d:\d\d UTC\); renovação sem janela: sim; último erro local .*certificado DTLS/);
        assert.equal(await hasAuthorizedBefore(), true);
        off();
        offBroken();
    });

    test("getLocalIdToken: so o token da conta atual, amarrado ao certificado da sala e dentro da carencia", () => {
        assert.equal(getLocalIdToken(), issued);
        assert.equal(getLocalIdToken({ fingerprint: cert.fingerprint }), issued);
        assert.equal(getLocalIdToken({ fingerprint: null }), null, "sala sem o nosso certificado");
        assert.equal(getLocalIdToken({ fingerprint: "sha-256:" + "00".repeat(32) }), null);
        const { expiresAt } = getLocalIdentityState() as { expiresAt: number; };
        assert.equal(getLocalIdToken({ now: expiresAt - 1 }), issued);
        assert.equal(getLocalIdToken({ now: expiresAt }), null, "alem da carencia nunca e enviado");
        UserStore.setCurrentUser(makeUser("999999999999999999", "outra conta"));
        assert.equal(getLocalIdToken(), null, "outra conta no mesmo Discord");
        UserStore.reset();
    });

    test("dois cliques: o mesmo pedido; fechar o modal cancela e a prova anterior continua", async () => {
        const mark = logMark();
        const p1 = authorizeIdentity();
        const p2 = authorizeIdentity();
        assert.equal(p1, p2);
        const modal = await nextModal();
        assert.equal(getLocalIdentityState().status, "authorizing");
        modals.close(modal.key);
        assert.equal(await p1, false);
        assert.equal(getLocalIdentityState().status, "ready");
        assert.equal(getLocalIdToken(), issued);
        assert.equal(logged(/falha ao autorizar/, mark).length, 0, "cancelar nao e erro");
    });

    describe("falhas ao autorizar: estado de erro com a mensagem e o ultimo erro no diagnostico", () => {
        async function failing(expected: RegExp, finish: (modal: { key: string; props: ModalProps; }) => void) {
            const mark = logMark();
            const done = authorizeIdentity();
            finish(await nextModal());
            assert.equal(await done, false);
            const s = getLocalIdentityState();
            assert.equal(s.status, "error");
            const { error } = s as { error: string; };
            assert.match(error, expected);
            assert.doesNotMatch(error, /^\w*Error: /, "a UI mostra so a mensagem, sem o nome tecnico do erro");
            assert.equal(logged(/^Identidade: falha ao autorizar o Telinha: \w*Error: /, mark).length, 1, "o log fica com o nome do erro");
            assert.match(localIdentityDiagnostics(), /; último erro local .* UTC: autorizar: \w*Error: /);
        }

        test("o token endpoint recusa o code", async () => {
            discord.tokenImpl = () => tokenResponse({ error: "invalid_grant" }, { status: 400 });
            await failing(/^OAuth2 400 invalid_grant$/, approve);
            assert.equal(getLocalIdToken(), null, "erro: o token antigo nao vai mais no hello");
        });

        test("sem rede ate o Discord: a mensagem do erro, sem IPs", async () => {
            discord.tokenImpl = () => Promise.reject(new TypeError("connect ECONNREFUSED 162.159.128.233:443"));
            await failing(/^connect ECONNREFUSED \[ip\]:443$/, approve);
        });

        test("o modal nao devolve o location", async () => {
            await failing(/O Discord não devolveu a autorização/, m => {
                m.props.callback({});
                modals.close(m.key);
            });
        });

        test("state do redirect diferente (resposta de outro pedido)", async () => {
            await failing(/state não confere/, m => approve(m, `${OAUTH_REDIRECT_URI}?code=X&state=outro`));
        });

        test("sem id_token (escopo openid nao concedido)", async () => {
            answerTokens({}, async () => null);
            await failing(/o Discord não devolveu id_token/, approve);
        });

        test("id_token amarrado a outro certificado: nao passa na propria verificacao", async () => {
            answerTokens({}, () => goodToken({ fingerprint: "sha-256:" + "ab".repeat(32) }));
            await failing(/o token do Discord não passou na própria verificação \(fingerprint-mismatch\)/, approve);
        });

        test("sem usuario do Discord: nem abre o modal; e o proximo clique (com usuario) abre", async () => {
            UserStore.setCurrentUser(null);
            const done = authorizeIdentity();
            assert.equal(await done, false);
            assert.deepEqual(getLocalIdentityState(), { status: "error", error: "usuário do Discord desconhecido" });
            assert.equal(modals.list().length, 0);
            UserStore.reset();

            // regressao: a falha sem nenhum await deixava o pedido "em andamento" para sempre
            const again = authorizeIdentity();
            assert.notEqual(again, done);
            const modal = await nextModal();
            modals.close(modal.key);
            assert.equal(await again, false);
        });
    });

    test("renovacao silenciosa (prompt none) com a prova ainda aceita: continua 'pronta' durante e depois de uma falha", async () => {
        await authorizeOk("R2");
        const before = issued;

        discord.tokenImpl = () => tokenResponse({ error: "server_error" }, { status: 500 });
        const failed = authorizeIdentity({ silent: true });
        const m1 = await nextModal();
        assert.equal(m1.props.prompt, "none");
        assert.equal(getLocalIdentityState().status, "ready", "sem 'autorizando' na renovacao silenciosa");
        approve(m1);
        assert.equal(await failed, false);
        assert.equal(getLocalIdentityState().status, "ready");
        assert.equal(getLocalIdToken(), before);

        // da certo sem refresh_token novo: guarda o anterior
        clock.advance(1000);
        answerTokens({});
        const ok = authorizeIdentity({ silent: true });
        approve(await nextModal());
        assert.equal(await ok, true);
        assert.notEqual(issued, before);
        assert.equal(getLocalIdToken(), issued);
        assert.equal(stored()?.refreshToken, "R2");
    });

    describe("prepareIdentity com o token guardado (Discord reaberto)", () => {
        test("guardado para este certificado e na carencia: pronta, sem rede", async () => {
            const keep = stored()!;
            await forgetIdentity();
            assert.equal(getLocalIdToken(), null);
            setStored(keep);
            const requests = discord.calls.length;
            assert.deepEqual(await prepareIdentity(), { certificates: [cert.certificate], fingerprint: cert.fingerprint });
            assert.equal(getLocalIdentityState().status, "ready");
            assert.equal(getLocalIdToken(), keep.idToken);
            assert.equal(discord.calls.length, requests);
        });

        test("token ilegivel: pronta, com emissao 0 (a renovacao vai acontecer)", async () => {
            const keep = stored()!;
            setStored({ ...keep, idToken: "lixo" });
            await prepareIdentity();
            assert.deepEqual(getLocalIdentityState(), { status: "ready", userId: ME_ID, issuedAt: 0, expiresAt: keep.expiresAt + MAX_TOKEN_AGE_MS });
            setStored(keep);
            await prepareIdentity();
        });

        test("guardado para outro certificado, ou alem da carencia: 'expired' (renova ao entrar numa call)", async () => {
            const keep = stored()!;
            setStored({ ...keep, fingerprint: "sha-256:" + "cd".repeat(32) });
            await prepareIdentity();
            assert.deepEqual(getLocalIdentityState(), { status: "expired" });
            assert.equal(getLocalIdToken(), null);
            assert.match(localIdentityDiagnostics(), /local: vencida \(renova ao entrar numa call\);/);

            setStored({ ...keep, expiresAt: Date.now() - MAX_TOKEN_AGE_MS - 1 });
            await prepareIdentity();
            assert.deepEqual(getLocalIdentityState(), { status: "expired" });
            setStored(keep);
        });

        test("nada guardado, DataStore travado ou sem usuario: 'unauthorized'", async t => {
            const keep = stored()!;
            setStored(null);
            await prepareIdentity();
            assert.deepEqual(getLocalIdentityState(), { status: "unauthorized" });

            setStored(keep);
            const get = t.mock.method(dataStoreImpl, "get", async () => {
                throw new Error("IndexedDB travado");
            });
            await prepareIdentity();
            assert.deepEqual(getLocalIdentityState(), { status: "unauthorized" });
            get.mock.restore();

            UserStore.setCurrentUser(null);
            await prepareIdentity();
            assert.deepEqual(getLocalIdentityState(), { status: "unauthorized" });
            UserStore.reset();
        });

        test("com o modal aberto ('autorizando'), carregar de novo nao mexe no estado", async () => {
            setStored(null);
            const done = authorizeIdentity();
            const modal = await nextModal();
            await prepareIdentity();
            assert.equal(getLocalIdentityState().status, "authorizing");
            modals.close(modal.key);
            assert.equal(await done, false);
            assert.deepEqual(getLocalIdentityState(), { status: "unauthorized" }, "cancelar volta ao estado de antes");
        });
    });

    describe("renewIdentity", () => {
        test("nunca autorizou (ou sem usuario): false, sem rede", async () => {
            const requests = discord.tokenRequests.length;
            assert.equal(await renewIdentity({ interactive: true }), false);
            UserStore.setCurrentUser(null);
            assert.equal(await renewIdentity({ interactive: true }), false);
            UserStore.reset();
            assert.equal(discord.tokenRequests.length, requests);
            assert.equal(modals.list().length, 0);
        });

        test("token novo: true sem fazer nada", async () => {
            await authorizeOk("R3");
            const requests = discord.tokenRequests.length;
            assert.equal(await renewIdentity(), true);
            assert.equal(discord.tokenRequests.length, requests);
        });

        test("emitido ha mais de 24 h: renova pelo refresh_token, sem janela", async () => {
            clock.advance(25 * HOUR);
            const before = issued;
            answerTokens({ refresh_token: "R4" });
            assert.equal(await renewIdentity(), true);
            const body = discord.tokenRequests.at(-1)!;
            assert.equal(body.get("grant_type"), "refresh_token");
            assert.equal(body.get("refresh_token"), "R3");
            assert.notEqual(issued, before);
            assert.equal(stored()?.refreshToken, "R4");
            assert.equal(getLocalIdToken(), issued);
        });

        test("refresh devolve id_token sem o nonce: guarda o refresh_token novo mesmo assim, e nao tenta de novo por 30 min", async () => {
            clock.advance(25 * HOUR);
            const old = stored()!;
            answerTokens({ refresh_token: "R5" }, () => goodToken({ claims: { nonce: undefined } }));
            const mark = logMark();
            assert.equal(await renewIdentity(), false);
            assert.deepEqual(stored(), { ...old, refreshToken: "R5" }, "o Discord ja invalidou o R4");
            assert.equal(logged(/^Identidade: renovação sem janela não deu certo \(Error: o token do Discord não passou na própria verificação \(fingerprint-mismatch\)\)$/, mark).length, 1);
            assert.match(localIdentityDiagnostics(), /último erro local .* UTC: renovação sem janela: /);

            const requests = discord.tokenRequests.length;
            assert.equal(await renewIdentity(), false);
            assert.equal(discord.tokenRequests.length, requests, "dentro de 30 min: nem tenta");
        });

        test("interativa: reabre o modal com prompt none (no maximo 1x/24 h)", async () => {
            discord.tokenImpl = () => tokenResponse({ error: "server_error" }, { status: 500 });
            const first = renewIdentity({ interactive: true });
            const modal = await nextModal();
            assert.equal(modal.props.prompt, "none");
            approve(modal);
            assert.equal(await first, false);

            assert.equal(await renewIdentity({ interactive: true }), false);
            assert.equal(modals.list().length, 0, "cancelado/falhou ha pouco: nao reabre");
        });

        test("passado o intervalo: tenta o refresh de novo e, se falhar, o modal; o modal da certo", async () => {
            clock.advance(24 * HOUR + 1);
            let refreshes = 0;
            discord.tokenImpl = async body => {
                if (body.get("grant_type") === "refresh_token") {
                    refreshes++;
                    return tokenResponse({ error: "invalid_grant" }, { status: 400 });
                }
                issued = await goodToken();
                return tokenResponse({ id_token: issued });
            };
            const renewing = renewIdentity({ interactive: true });
            approve(await nextModal());
            assert.equal(await renewing, true);
            assert.equal(refreshes, 1);
            assert.equal(stored()?.refreshToken, "R5", "refresh recusado sem refresh_token novo: fica o guardado");
            assert.equal(getLocalIdToken(), issued);
        });

        test("falha ao guardar o refresh_token novo nao estoura", async t => {
            clock.advance(31 * 60_000 + 25 * HOUR);
            answerTokens({ refresh_token: "R6" }, () => goodToken({ claims: { nonce: undefined } }));
            t.mock.method(dataStoreImpl, "update", async () => {
                throw new Error("IndexedDB travado");
            });
            assert.equal(await renewIdentity(), false);
            assert.equal(stored()?.refreshToken, "R5");
        });

        test("sem refresh_token guardado: so pelo modal", async () => {
            const keep = stored()!;
            setStored({ ...keep, refreshToken: undefined });
            clock.advance(31 * 60_000);
            const requests = discord.tokenRequests.length;
            assert.equal(await renewIdentity(), false);
            assert.equal(discord.tokenRequests.length, requests);
            setStored(keep);
        });
    });

    test("desvincular com o DataStore falhando: rejeita e nada muda (continua pronta, o token continua indo no hello)", async t => {
        const before = getLocalIdentityState();
        assert.equal(before.status, "ready");
        const token = getLocalIdToken();
        assert.ok(token);
        t.mock.method(dataStoreImpl, "update", async () => {
            throw new Error("IndexedDB travado");
        });
        await assert.rejects(forgetIdentity(), /IndexedDB travado/);
        assert.equal(getLocalIdentityState(), before);
        assert.equal(getLocalIdToken(), token);
        assert.equal(stored()?.idToken, token);
    });

    test("forgetIdentity: esquece o token desta conta (o certificado fica)", async () => {
        const mark = logMark();
        await forgetIdentity();
        assert.equal(stored(), undefined);
        assert.equal(getLocalIdToken(), null);
        assert.deepEqual(getLocalIdentityState(), { status: "unauthorized" });
        assert.equal(logged(/^Identidade: Telinha desvinculado desta conta neste PC$/, mark).length, 1);
        assert.equal((await getLocalCertificate()).fingerprint, cert.fingerprint);

        UserStore.setCurrentUser(null);
        const updates = dataStoreData.size;
        await forgetIdentity();
        assert.equal(dataStoreData.size, updates);
        assert.deepEqual(getLocalIdentityState(), { status: "unauthorized" });
        UserStore.reset();
    });
});
