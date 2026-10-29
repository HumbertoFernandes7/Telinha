/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fachada da prova de identidade (renderer). Ver docs/identity.md.
//
// Lado local:  prepareIdentity() antes do joinRoom (certificado fixo + token guardado),
//              getLocalIdToken({ fingerprint }) para o hello, authorizeIdentity() no botao "Autorizar o
//              Telinha no Discord", renewIdentity() ao entrar numa sala quando o token ja esta velho (a
//              prova vale ate MAX_TOKEN_AGE_MS depois do `exp`; ver docs/identity.md).
// Lado remoto: verifyRemoteIdentity({ pc, idToken, claimedUserId }) no onPeerJoin / acao "identity".
//
// Sem Client ID (isIdentityConfigured() false) nada disso faz efeito: estado "disabled", sem certificado
// proprio, sem token, sem rede (comportamento da v0.1.0).
//
// Nada roda no carregamento do modulo. Tokens nunca vao para o log nem para o diagnostico. O access_token
// e descartado na hora (so o id_token interessa); o refresh_token (escopo openid, so le /oauth2/userinfo)
// fica no DataStore do Vencord (IndexedDB), por conta do Discord, para renovar sem abrir o modal.

import * as DataStore from "@api/DataStore";
import { errorText, log, logThrottled } from "@plugins/telinha/core/log";
import { UserStore } from "@webpack/common";

import { AuthorizationCancelled, openAuthorizeModal } from "./authorize";
import { getLocalCertificate, type LocalCertificate } from "./certificate";
import { DISCORD_CLIENT_ID, isIdentityConfigured, OAUTH_REDIRECT_URI, OAUTH_SCOPES, tokenAcceptedUntil, tokenNeedsRenewal } from "./config";
import { randomUrlSafe } from "./encoding";
import { nonceForFingerprint } from "./fingerprint";
import { JwksCache, type StoredJwks } from "./jwks";
import { decodeJwt } from "./jwt";
import { buildCodeExchangeBody, buildRefreshBody, createPkcePair, parseAuthorizeLocation, requestToken, type TokenResponse } from "./oauth";
import { getRemoteDtlsFingerprint } from "./remoteFingerprint";
import { type IdentityVerdict, identityVerdict, type PeerIdentityResult, verifyPeerIdentity } from "./verify";

export { isIdentityConfigured } from "./config";
export type { IdentityFailure, IdentityVerdict, PeerIdentityResult } from "./verify";

const TOKEN_STORE_KEY = "telinha-identity-tokens-v1";
const JWKS_STORE_KEY = "telinha-identity-jwks-v1";
/** renovacao com modal (prompt "none") no maximo 1x neste intervalo: cancelar nao reabre a cada sala */
const INTERACTIVE_RENEW_INTERVAL_MS = 24 * 60 * 60_000;
/** refresh_token recusado: nao tenta de novo a cada sala antes disto */
const REFRESH_RETRY_MS = 30 * 60_000;

interface StoredIdentity {
    idToken: string;
    /** `exp` do id_token (ms); o token ainda vale ate tokenAcceptedUntil(expiresAt) */
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
    /** ainda lendo o token guardado (logo depois de abrir o Discord) */
    | { status: "loading"; }
    /** nunca autorizou nesta conta/PC (ou desvinculou) */
    | { status: "unauthorized"; }
    /** ja autorizou, mas o token passou da carencia (ou o certificado mudou): renova sozinho ao entrar numa call */
    | { status: "expired"; }
    | { status: "authorizing"; }
    /** `issuedAt` = quando o Discord emitiu o token; `expiresAt` = ate quando ele e aceito (exp + carencia) */
    | { status: "ready"; userId: string; issuedAt: number; expiresAt: number; }
    | { status: "error"; error: string; };

export type LocalIdentityStatus = LocalIdentityState["status"];

let state: LocalIdentityState = isIdentityConfigured() ? { status: "loading" } : { status: "disabled" };
let token: StoredIdentity | null = null;
let inflightAuth: Promise<boolean> | null = null;
let lastInteractiveRenew = -Infinity;
let lastRefreshFailure = -Infinity;
let jwksCache: JwksCache | null = null;
/** ultimo erro do lado local (diagnostico; nunca contem tokens) */
let lastError: { at: number; text: string; } | null = null;
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

/** `iat` do id_token guardado (ms); 0 se ilegivel (entao tokenNeedsRenewal manda renovar). */
function issuedAtOf(value: StoredIdentity): number {
    const iat = decodeJwt(value.idToken)?.payload.iat;
    return typeof iat === "number" && Number.isFinite(iat) ? iat * 1000 : 0;
}

const readyState = (userId: string, value: StoredIdentity): LocalIdentityState =>
    ({ status: "ready", userId, issuedAt: issuedAtOf(value), expiresAt: tokenAcceptedUntil(value.expiresAt) });

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

/**
 * id_token para o hello / acao "identity"; null se nao ha um aceitavel (dentro da carencia pos-`exp`) para a
 * conta atual: um token alem dela nunca e enviado. Com `fingerprint`
 * (o certificado que a sala atual usa), so devolve o token amarrado a ele: um token de outro certificado
 * faria os peers verem "identidade falsa".
 */
export function getLocalIdToken({ fingerprint, now = Date.now() }: { fingerprint?: string | null; now?: number; } = {}): string | null {
    if (!token || state.status !== "ready" || state.userId !== myId() || tokenAcceptedUntil(token.expiresAt) <= now) return null;
    if (fingerprint !== undefined && token.fingerprint !== fingerprint) return null;
    return token.idToken;
}

export interface PreparedIdentity {
    /** para rtcConfig.certificates (vazio = o Chromium gera um por conexao, como na v0.1.0) */
    certificates: RTCCertificate[];
    /** fingerprint do certificado acima (null sem certificado) */
    fingerprint: string | null;
}

/**
 * Chamar antes do joinRoom e passar `certificates` em rtcConfig. Nunca lanca: sem certificado
 * persistente o Telinha funciona como hoje (so nao prova a identidade). Sem Client ID nao faz nada.
 */
export async function prepareIdentity(): Promise<PreparedIdentity> {
    if (!isIdentityConfigured()) {
        if (state.status !== "disabled") setState({ status: "disabled" });
        return { certificates: [], fingerprint: null };
    }

    let cert: LocalCertificate;
    try {
        cert = await getLocalCertificate();
    } catch (e) {
        log.warn("Identidade: não foi possível preparar o certificado DTLS: " + errorText(e));
        lastError = { at: Date.now(), text: "certificado DTLS: " + errorText(e) };
        if (state.status === "loading") setState({ status: "error", error: "certificado DTLS indisponível" });
        return { certificates: [], fingerprint: null };
    }
    if (!cert.persisted) logThrottled("identity-cert-persist", "warn", "Identidade: o certificado DTLS não pôde ser gravado; a autorização valerá só até fechar o Discord.", 6 * 60 * 60_000);

    const userId = myId();
    const stored = userId ? await loadStored(userId) : null;
    const now = Date.now();
    if (stored && stored.fingerprint === cert.fingerprint && tokenAcceptedUntil(stored.expiresAt) > now) {
        token = stored;
        setState(readyState(userId, stored));
    } else if (state.status !== "authorizing") {
        token = null;
        setState(stored ? { status: "expired" } : { status: "unauthorized" });
    }
    return { certificates: [cert.certificate], fingerprint: cert.fingerprint };
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
    setState(readyState(userId, value));
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
        // renovacao silenciosa com o token antigo ainda aceito: segue "pronta" (o hello continua levando o token
        // e uma falha do Discord nao derruba uma prova ainda boa)
        const keepReady = silent && previous.status === "ready" && previous.userId === userId && previous.expiresAt > Date.now();
        try {
            if (!userId) throw new Error("usuário do Discord desconhecido");
            const cert = await getLocalCertificate();
            const [pkce, nonce] = await Promise.all([createPkcePair(), nonceForFingerprint(cert.fingerprint)]);
            const oauthState = randomUrlSafe(16);
            if (!keepReady) setState({ status: "authorizing" });

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
            lastError = { at: Date.now(), text: "autorizar: " + errorText(e) };
            setState(keepReady ? previous : { status: "error", error: errorText(e) });
            return false;
        } finally {
            inflightAuth = null;
        }
    })();
}

/**
 * Renova o token proprio se ja esta velho (tokenNeedsRenewal): primeiro pelo refresh_token (sem UI); se o Discord nao
 * devolver um id_token amarrado ao nosso certificado e `interactive`, reabre o modal com prompt "none".
 */
export async function renewIdentity({ interactive = false }: { interactive?: boolean; } = {}): Promise<boolean> {
    if (!isIdentityConfigured()) return false;
    const now = Date.now();
    if (state.status === "ready" && token && !tokenNeedsRenewal(issuedAtOf(token), token.expiresAt, now)) return true;

    const userId = myId();
    const stored = userId ? await loadStored(userId) : null;
    if (!stored) return false; // nunca autorizou: so pelo botao
    if (stored.refreshToken && Date.now() - lastRefreshFailure >= REFRESH_RETRY_MS) {
        try {
            const cert = await getLocalCertificate();
            const tokens = await requestToken(buildRefreshBody({ clientId: DISCORD_CLIENT_ID, refreshToken: stored.refreshToken }));
            try {
                await acceptOwnTokens(tokens, cert, userId, stored.refreshToken);
            } catch (e) {
                // o Discord troca o refresh_token a cada uso: guarda o novo mesmo se o id_token nao servir (ex.: sem
                // o nonce), senao a proxima renovacao sem janela usaria um refresh_token ja invalidado
                if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
                    await saveStored(userId, { ...stored, refreshToken: tokens.refresh_token }).catch(() => { });
                }
                throw e;
            }
            return true;
        } catch (e) {
            lastRefreshFailure = Date.now();
            lastError = { at: Date.now(), text: "renovação sem janela: " + errorText(e) };
            log.info("Identidade: renovação sem janela não deu certo (" + errorText(e) + ")");
        }
    }
    if (!interactive || Date.now() - lastInteractiveRenew < INTERACTIVE_RENEW_INTERVAL_MS) return false;
    lastInteractiveRenew = Date.now();
    return authorizeIdentity({ silent: true });
}

/** Esquece o token desta conta ("Desvincular"; o certificado continua). Quem ja verificou continua ate reconectar. */
export async function forgetIdentity(): Promise<void> {
    const userId = myId();
    token = null;
    lastInteractiveRenew = lastRefreshFailure = -Infinity;
    if (userId) await saveStored(userId, null);
    setState(isIdentityConfigured() ? { status: "unauthorized" } : { status: "disabled" });
    log.info("Identidade: Telinha desvinculado desta conta neste PC");
}

const LOCAL_STATUS_TEXT: Record<Exclude<LocalIdentityStatus, "ready" | "error">, string> = {
    disabled: "desligada",
    loading: "carregando",
    unauthorized: "não autorizada",
    expired: "vencida (renova ao entrar numa call)",
    authorizing: "autorizando"
};

/** Linha do "Copiar diagnóstico" (lado local). Nunca contem tokens. */
export function localIdentityDiagnostics(): string {
    if (!isIdentityConfigured()) return "identidade: desligada (sem Client ID)";
    const time = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
    const s = state;
    const local = s.status === "ready" ? `pronta (prova renovada em ${time(s.issuedAt)}, aceita até ${time(s.expiresAt)} UTC)`
        : s.status === "error" ? `erro (${s.error})`
            : LOCAL_STATUS_TEXT[s.status];
    return `identidade: configurada (app ${DISCORD_CLIENT_ID}); local: ${local}; renovação sem janela: ${token?.refreshToken ? "sim" : "não"}`
        + (lastError ? `; último erro local ${time(lastError.at)} UTC: ${lastError.text}` : "");
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
