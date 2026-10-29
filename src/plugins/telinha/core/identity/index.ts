/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fachada da prova de identidade (renderer). Ver docs/identity.md.
//
// Lado local:  prepareIdentity() antes do joinRoom (certificado fixo + token guardado),
//              getLocalIdToken() para o hello, authorizeIdentity() no botao "Autorizar o Telinha",
//              renewIdentity() quando o token esta para vencer.
// Lado remoto: verifyRemoteIdentity({ pc, idToken, claimedUserId }) no onPeerJoin / acao "identity".
//
// Nada roda no carregamento do modulo. Tokens nunca vao para o log. O access_token e descartado na
// hora (so o id_token interessa); o refresh_token (escopo openid, so le /oauth2/userinfo) fica no
// DataStore para renovar sem abrir o modal.

import * as DataStore from "@api/DataStore";
import { errorText, log } from "@plugins/telinha/core/log";
import { UserStore } from "@webpack/common";

import { AuthorizationCancelled, openAuthorizeModal } from "./authorize";
import { getLocalCertificate, type LocalCertificate } from "./certificate";
import { DISCORD_CLIENT_ID, isIdentityConfigured, OAUTH_REDIRECT_URI, OAUTH_SCOPES, tokenNeedsRenewal } from "./config";
import { randomUrlSafe } from "./encoding";
import { nonceForFingerprint } from "./fingerprint";
import { JwksCache, type StoredJwks } from "./jwks";
import { buildCodeExchangeBody, buildRefreshBody, createPkcePair, parseAuthorizeLocation, requestToken, type TokenResponse } from "./oauth";
import { getRemoteDtlsFingerprint } from "./remoteFingerprint";
import { type IdentityVerdict, identityVerdict, type PeerIdentityResult, verifyPeerIdentity } from "./verify";

export { isIdentityConfigured } from "./config";
export type { IdentityFailure, IdentityVerdict, PeerIdentityResult } from "./verify";

const TOKEN_STORE_KEY = "telinha-identity-tokens-v1";
const JWKS_STORE_KEY = "telinha-identity-jwks-v1";
/** renovacao com modal (prompt "none") no maximo 1x neste intervalo: cancelar nao reabre a cada sala */
const INTERACTIVE_RENEW_INTERVAL_MS = 6 * 60 * 60_000;

interface StoredIdentity {
    idToken: string;
    expiresAt: number;
    /** fingerprint do certificado ao qual o token esta amarrado */
    fingerprint: string;
    refreshToken?: string;
}

/** por discordUserId (varias contas no mesmo Discord) */
type TokenStore = Record<string, StoredIdentity>;

export type LocalIdentityState =
    /** sem client id real (placeholder): ninguem prova nada */
    | { status: "disabled"; }
    /** nunca autorizou nesta conta/PC, ou o token venceu e nao deu para renovar */
    | { status: "unauthorized"; }
    | { status: "authorizing"; }
    | { status: "ready"; userId: string; expiresAt: number; }
    | { status: "error"; error: string; };

let state: LocalIdentityState = { status: "unauthorized" };
let token: StoredIdentity | null = null;
let inflightAuth: Promise<boolean> | null = null;
let lastInteractiveRenew = -Infinity;
let jwksCache: JwksCache | null = null;
const listeners = new Set<(s: LocalIdentityState) => void>();

function setState(next: LocalIdentityState) {
    state = next;
    for (const l of listeners) {
        try {
            l(next);
        } catch { }
    }
}

const myId = () => UserStore.getCurrentUser()?.id ?? "";

function jwks() {
    return jwksCache ??= new JwksCache({
        load: () => DataStore.get<StoredJwks>(JWKS_STORE_KEY),
        save: value => DataStore.set(JWKS_STORE_KEY, value)
    });
}

async function loadStored(userId: string): Promise<StoredIdentity | null> {
    try {
        return (await DataStore.get<TokenStore>(TOKEN_STORE_KEY))?.[userId] ?? null;
    } catch {
        return null;
    }
}

async function saveStored(userId: string, value: StoredIdentity | null) {
    await DataStore.update<TokenStore>(TOKEN_STORE_KEY, all => {
        const next = { ...all };
        if (value) next[userId] = value;
        else delete next[userId];
        return next;
    });
}

// #region lado local

export function getLocalIdentityState(): LocalIdentityState {
    return state;
}

export function subscribeLocalIdentity(listener: (s: LocalIdentityState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** id_token para o hello / acao "identity"; null se nao ha um valido para a conta atual. */
export function getLocalIdToken(now = Date.now()): string | null {
    if (!token || state.status !== "ready" || state.userId !== myId() || token.expiresAt <= now) return null;
    return token.idToken;
}

/**
 * Chamar antes do joinRoom e passar `certificates` em rtcConfig. Nunca lanca: sem certificado
 * persistente o Telinha funciona como hoje (so nao prova a identidade).
 */
export async function prepareIdentity(): Promise<{ certificates: RTCCertificate[]; }> {
    let cert: LocalCertificate;
    try {
        cert = await getLocalCertificate();
    } catch (e) {
        log.warn("Identidade: não foi possível preparar o certificado DTLS: " + errorText(e));
        return { certificates: [] };
    }
    if (!cert.persisted) log.warn("Identidade: o certificado DTLS não pôde ser gravado; a autorização valerá só até fechar o Discord.");

    if (!isIdentityConfigured()) {
        setState({ status: "disabled" });
        return { certificates: [cert.certificate] };
    }

    const userId = myId();
    const stored = userId ? await loadStored(userId) : null;
    const now = Date.now();
    if (stored && stored.fingerprint === cert.fingerprint && stored.expiresAt > now) {
        token = stored;
        setState({ status: "ready", userId, expiresAt: stored.expiresAt });
    } else if (state.status !== "authorizing") {
        token = null;
        setState({ status: "unauthorized" });
    }
    return { certificates: [cert.certificate] };
}

/** true se ja autorizou alguma vez nesta conta (renovar pode usar prompt "none"). */
export async function hasAuthorizedBefore(): Promise<boolean> {
    const userId = myId();
    return !!userId && !!await loadStored(userId);
}

/** Confere o proprio token como um peer conferiria e guarda. Lanca com mensagem clara se nao bater. */
async function acceptOwnTokens(tokens: TokenResponse, cert: LocalCertificate, userId: string, previousRefresh?: string) {
    if (!tokens.id_token) throw new Error("o Discord não devolveu id_token (o escopo openid foi concedido?)");
    const result = await verifyPeerIdentity({
        idToken: tokens.id_token,
        claimedUserId: userId,
        remoteDtlsFingerprint: cert.fingerprint,
        now: Date.now(),
        jwks: await jwks().get()
    });
    if (!result.ok) throw new Error(`o token do Discord não passou na própria verificação (${result.reason})`);
    const value: StoredIdentity = {
        idToken: tokens.id_token,
        expiresAt: result.expiresAt,
        fingerprint: cert.fingerprint,
        refreshToken: tokens.refresh_token ?? previousRefresh
    };
    await saveStored(userId, value);
    token = value;
    setState({ status: "ready", userId, expiresAt: result.expiresAt });
    const minutes = Math.round((result.expiresAt - Date.now()) / 60_000);
    log.info(`Identidade do Discord pronta (válida por ~${minutes} min)`);
}

/**
 * Abre o modal "Autorizar" do Discord e troca o code pelo id_token. `silent` usa prompt "none":
 * o Discord confirma sozinho se ja houve autorizacao (senao mostra a tela normal).
 * true = pronto; false = cancelado/falhou (estado e log explicam).
 */
export function authorizeIdentity({ silent = false }: { silent?: boolean; } = {}): Promise<boolean> {
    if (!isIdentityConfigured()) {
        setState({ status: "disabled" });
        return Promise.resolve(false);
    }
    return inflightAuth ??= (async () => {
        const previous = state;
        const userId = myId();
        try {
            if (!userId) throw new Error("usuário do Discord desconhecido");
            const cert = await getLocalCertificate();
            const [pkce, nonce] = await Promise.all([createPkcePair(), nonceForFingerprint(cert.fingerprint)]);
            const oauthState = randomUrlSafe(16);
            setState({ status: "authorizing" });

            const location = await openAuthorizeModal({
                clientId: DISCORD_CLIENT_ID,
                redirectUri: OAUTH_REDIRECT_URI,
                scopes: [...OAUTH_SCOPES],
                state: oauthState,
                nonce,
                codeChallenge: pkce.challenge,
                codeChallengeMethod: "S256",
                prompt: silent ? "none" : "consent"
            });
            const parsed = parseAuthorizeLocation(location, { state: oauthState, redirectUri: OAUTH_REDIRECT_URI });
            if (!parsed.ok) throw new Error(parsed.error);

            const tokens = await requestToken(buildCodeExchangeBody({
                clientId: DISCORD_CLIENT_ID, code: parsed.code, codeVerifier: pkce.verifier, redirectUri: OAUTH_REDIRECT_URI
            }));
            const stored = await loadStored(userId);
            await acceptOwnTokens(tokens, cert, userId, stored?.refreshToken);
            return true;
        } catch (e) {
            if (e instanceof AuthorizationCancelled) {
                setState(previous.status === "authorizing" ? { status: "unauthorized" } : previous);
                return false;
            }
            log.warn("Identidade: falha ao autorizar o Telinha: " + errorText(e));
            setState({ status: "error", error: errorText(e) });
            return false;
        } finally {
            inflightAuth = null;
        }
    })();
}

/**
 * Renova o token proprio se esta para vencer: primeiro pelo refresh_token (sem UI); se o Discord nao
 * devolver um id_token amarrado ao nosso certificado e `interactive`, reabre o modal com prompt "none".
 */
export async function renewIdentity({ interactive = false }: { interactive?: boolean; } = {}): Promise<boolean> {
    if (!isIdentityConfigured()) return false;
    const now = Date.now();
    if (state.status === "ready" && token && !tokenNeedsRenewal(token.expiresAt, now)) return true;

    const userId = myId();
    const stored = userId ? await loadStored(userId) : null;
    if (!stored) return false; // nunca autorizou: so pelo botao
    if (stored.refreshToken) {
        try {
            const cert = await getLocalCertificate();
            const tokens = await requestToken(buildRefreshBody({ clientId: DISCORD_CLIENT_ID, refreshToken: stored.refreshToken }));
            await acceptOwnTokens(tokens, cert, userId, stored.refreshToken);
            return true;
        } catch (e) {
            log.info("Identidade: renovação sem janela não deu certo (" + errorText(e) + ")");
        }
    }
    if (!interactive || Date.now() - lastInteractiveRenew < INTERACTIVE_RENEW_INTERVAL_MS) return false;
    lastInteractiveRenew = Date.now();
    return authorizeIdentity({ silent: true });
}

/** Esquece o token desta conta (o certificado continua). */
export async function forgetIdentity(): Promise<void> {
    const userId = myId();
    token = null;
    if (userId) await saveStored(userId, null);
    setState(isIdentityConfigured() ? { status: "unauthorized" } : { status: "disabled" });
}

// #endregion

// #region lado remoto

export interface RemoteIdentity {
    verdict: IdentityVerdict;
    result: PeerIdentityResult;
}

/**
 * Verifica o id_token que o peer mandou contra o certificado DTLS que ele usou NESTA conexao.
 * `pc` = rt.room.getPeers()[peerId] (so existe depois do handshake, i.e. no onPeerJoin).
 */
export async function verifyRemoteIdentity({ pc, idToken, claimedUserId }: { pc: RTCPeerConnection | null | undefined; idToken: unknown; claimedUserId: string; }): Promise<RemoteIdentity> {
    const done = (result: PeerIdentityResult): RemoteIdentity => ({ verdict: identityVerdict(result), result });
    if (!isIdentityConfigured()) return done({ ok: false, reason: "not-configured" });
    if (typeof idToken !== "string" || !idToken) return done({ ok: false, reason: "missing" });
    if (!pc) return done({ ok: false, reason: "no-fingerprint" });

    const remote = await getRemoteDtlsFingerprint(pc);
    if (remote.fingerprint === null) {
        log.warn(`Identidade: fingerprint DTLS do peer indisponível (${remote.reason})`);
        return done({ ok: false, reason: "no-fingerprint" });
    }

    let keys;
    try {
        keys = await jwks().get();
    } catch (e) {
        log.warn("Identidade: não foi possível baixar as chaves do Discord: " + errorText(e));
        return done({ ok: false, reason: "unknown-key" });
    }
    const input = { idToken, claimedUserId, remoteDtlsFingerprint: remote.fingerprint, now: Date.now(), jwks: keys };
    let result = await verifyPeerIdentity(input);
    if (!result.ok && result.reason === "unknown-key") {
        const fresh = await jwks().refresh();
        if (fresh) result = await verifyPeerIdentity({ ...input, jwks: fresh });
    }
    return done(result);
}

// #endregion
