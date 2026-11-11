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
//              prova vale ate MAX_TOKEN_AGE_MS depois do `exp`; ver docs/identity.md). A renovacao faz direto os
//              pedidos HTTP do modal (directAuthorize.ts), sem janela; so se o Discord nao deixar, abre o modal.
// Lado remoto: verifyRemoteIdentity({ pc, idToken, claimedUserId }) no onPeerJoin / acao "identity".
//
// Sem Client ID (isIdentityConfigured() false) nada disso faz efeito: estado "disabled", sem certificado
// proprio, sem token, sem rede (comportamento da v0.1.0).
//
// Nada roda no carregamento do modulo. Tokens nunca vao para o log nem para o diagnostico. O access_token
// e descartado na hora (so o id_token interessa); o refresh_token (escopo openid) ainda e guardado no DataStore do
// Vencord (IndexedDB), mas nao renova nada: o Discord nao devolve id_token nesse caminho.

import * as DataStore from "@api/DataStore";
import { errorMessage, errorText, log, logThrottled } from "@plugins/telinha/core/log";
import { UserStore } from "@webpack/common";

import { AuthorizationCancelled, openAuthorizeModal } from "./authorize";
import { getLocalCertificate, type LocalCertificate } from "./certificate";
import { DISCORD_CLIENT_ID, isIdentityConfigured, OAUTH_REDIRECT_URI, OAUTH_SCOPES, tokenAcceptedUntil, tokenNeedsRenewal } from "./config";
import { authorizeDirect } from "./directAuthorize";
import { randomUrlSafe } from "./encoding";
import { nonceForFingerprint } from "./fingerprint";
import { JwksCache, type StoredJwks } from "./jwks";
import { decodeJwt } from "./jwt";
import { buildCodeExchangeBody, createPkcePair, parseAuthorizeLocation, requestToken, type TokenResponse } from "./oauth";
import { getRemoteDtlsFingerprint } from "./remoteFingerprint";
import { type IdentityVerdict, identityVerdict, type PeerIdentityResult, verifyPeerIdentity } from "./verify";

export { isIdentityConfigured } from "./config";
export type { IdentityFailure, IdentityVerdict, PeerIdentityResult } from "./verify";

const TOKEN_STORE_KEY = "telinha-identity-tokens-v1";
const JWKS_STORE_KEY = "telinha-identity-jwks-v1";
/** renovacao com modal (prompt "none") no maximo 1x neste intervalo: cancelar nao reabre a cada sala */
const INTERACTIVE_RENEW_INTERVAL_MS = 24 * 60 * 60_000;
/** renovacao direta (sem janela) que nao deu certo: nao tenta de novo a cada sala antes disto */
const DIRECT_RETRY_MS = 30 * 60_000;

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
/** renovacao sem janela em andamento (separada do modal: o clique em "Autorizar" nunca fica sem janela por causa dela) */
let inflightDirect: Promise<boolean> | null = null;
/** sobe quando a conta/token e trocado (Desvincular): a renovacao direta que comecou antes nao grava nada */
let identityEpoch = 0;
let lastInteractiveRenew = -Infinity;
let lastDirectFailure = -Infinity;
/** ultimo resultado da renovacao direta (diagnostico) */
let lastDirect: { at: number; ok: true; } | { at: number; ok: false; reason: string; } | null = null;
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
async function acceptOwnTokens(tokens: TokenResponse, cert: LocalCertificate, userId: string, previousRefresh?: string, stillValid?: () => boolean) {
    if (!tokens.id_token) throw new Error("o Discord não devolveu id_token (o escopo openid foi concedido?)");
    const result = await verifyPeerIdentity({
        idToken: tokens.id_token,
        claimedUserId: userId,
        remoteDtlsFingerprint: cert.fingerprint,
        now: Date.now(),
        jwks: await jwks().get()
    });
    if (!result.ok) throw new Error(`o token do Discord não passou na própria verificação (${result.reason})`);
    if (stillValid && !stillValid()) throw new Error("a conta ou a autorização mudou durante a renovação");
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
 * `via: "direct"` (com `silent`) faz os mesmos pedidos do modal sem abri-lo (directAuthorize.ts): se o Discord nao
 * deixar, volta ao estado de antes (nunca "authorizing"/"error") e devolve false.
 * true = pronto; false = cancelado/falhou (estado e log explicam).
 */
export function authorizeIdentity({ silent = false, via = "modal" }: { silent?: boolean; via?: "modal" | "direct"; } = {}): Promise<boolean> {
    if (!isIdentityConfigured()) {
        setState({ status: "disabled" });
        return Promise.resolve(false);
    }
    const direct = silent && via === "direct";
    if (direct) {
        if (inflightDirect) return inflightDirect;
        if (inflightAuth) return Promise.resolve(false); // ja ha um modal aberto: nada de segunda tentativa
    } else {
        if (inflightAuth) return inflightAuth;
        // clique/modal com a direta em andamento: espera; se nao deu, abre o modal normalmente (nunca morre sem janela)
        if (inflightDirect) return inflightDirect.catch(() => false).then(ok => ok || authorizeIdentity({ silent, via }));
    }
    const run = (async () => {
        const previous = state;
        const userId = myId();
        const epoch = identityEpoch;
        const stale = () => identityEpoch !== epoch || myId() !== userId;
        // renovacao silenciosa com o token antigo ainda aceito: segue "pronta" (o hello continua levando o token
        // e uma falha do Discord nao derruba uma prova ainda boa)
        const keepReady = silent && previous.status === "ready" && previous.userId === userId && previous.expiresAt > Date.now();
        try {
            if (!userId) throw new Error("usuário do Discord desconhecido");
            const cert = await getLocalCertificate();
            const [pkce, nonce] = await Promise.all([createPkcePair(), nonceForFingerprint(cert.fingerprint)]);
            const oauthState = randomUrlSafe(16);
            const request = {
                clientId: DISCORD_CLIENT_ID,
                redirectUri: OAUTH_REDIRECT_URI,
                scopes: [...OAUTH_SCOPES],
                state: oauthState,
                nonce,
                codeChallenge: pkce.challenge,
                codeChallengeMethod: "S256",
                prompt: silent ? "none" : "consent"
            } as const;

            let location: string;
            if (direct) {
                const result = await authorizeDirect({ ...request, scopes: [...request.scopes] });
                if (stale()) return false;
                if (!result.ok) {
                    lastDirect = { at: Date.now(), ok: false, reason: result.reason };
                    lastError = { at: Date.now(), text: "renovação sem janela: " + result.reason };
                    log.info(`Identidade: renovação sem janela não deu certo (${result.reason})`);
                    return false;
                }
                location = result.location;
            } else {
                if (!keepReady) setState({ status: "authorizing" });
                location = await openAuthorizeModal({ ...request, scopes: [...request.scopes] });
            }
            const parsed = parseAuthorizeLocation(location, { state: oauthState, redirectUri: OAUTH_REDIRECT_URI });
            if (!parsed.ok) throw new Error(parsed.error);

            const tokens = await requestToken(buildCodeExchangeBody({
                clientId: DISCORD_CLIENT_ID, code: parsed.code, codeVerifier: pkce.verifier, redirectUri: OAUTH_REDIRECT_URI
            }));
            const stored = await loadStored(userId);
            if (direct && stale()) return false;
            await acceptOwnTokens(tokens, cert, userId, stored?.refreshToken, direct ? () => !stale() : undefined);
            if (direct) lastDirect = { at: Date.now(), ok: true };
            return true;
        } catch (e) {
            if (direct) {
                if (stale()) return false; // Desvincular/troca de conta no meio: nao mexe em nada
                // renovacao sem janela nunca derruba o estado nem mostra erro: quem chamou cai no modal
                lastDirect = { at: Date.now(), ok: false, reason: errorText(e) };
                lastError = { at: Date.now(), text: "renovação sem janela: " + errorText(e) };
                log.info(`Identidade: renovação sem janela não deu certo (${errorText(e)})`);
                setState(previous);
                return false;
            }
            if (e instanceof AuthorizationCancelled) {
                setState(previous.status === "authorizing" ? { status: "unauthorized" } : previous);
                return false;
            }
            log.warn("Identidade: falha ao autorizar o Telinha: " + errorText(e));
            lastError = { at: Date.now(), text: "autorizar: " + errorText(e) };
            // o estado vai para a UI (toast, barra): so a mensagem; o log e o diagnostico ficam com o nome do erro
            setState(keepReady ? previous : { status: "error", error: errorMessage(e) });
            return false;
        }
    })();
    if (direct) inflightDirect = run;
    else inflightAuth = run;
    // limpa so depois da atribuicao acima: sem usuario o corpo termina sem nenhum await, e um `finally` dentro dele
    // rodaria ANTES dela (o pedido ficava "em andamento" para sempre e "Autorizar" nunca mais abria o modal).
    // Limpa tambem se o pedido falhar de vez (ex.: o proprio log do erro lancar): quem chamou ainda recebe a rejeicao.
    const done = () => {
        if (inflightAuth === run) inflightAuth = null;
        if (inflightDirect === run) inflightDirect = null;
    };
    void run.then(done, done);
    return run;
}

/**
 * Renova o token proprio se ja esta velho (tokenNeedsRenewal): primeiro direto pelo Discord, sem janela (os mesmos
 * pedidos do modal, ver directAuthorize.ts); se nao der e `interactive`, reabre o modal com prompt "none".
 */
export async function renewIdentity({ interactive = false }: { interactive?: boolean; } = {}): Promise<boolean> {
    if (!isIdentityConfigured()) return false;
    const now = Date.now();
    if (state.status === "ready" && token && !tokenNeedsRenewal(issuedAtOf(token), token.expiresAt, now)) return true;

    const userId = myId();
    const stored = userId ? await loadStored(userId) : null;
    if (!stored) return false; // nunca autorizou: so pelo botao
    if (inflightAuth) return false; // ja ha um modal aberto: nao tenta nada nem conta como falha da direta
    if (Date.now() - lastDirectFailure >= DIRECT_RETRY_MS) {
        if (await authorizeIdentity({ silent: true, via: "direct" })) return true;
        lastDirectFailure = Date.now();
    }
    if (!interactive || Date.now() - lastInteractiveRenew < INTERACTIVE_RENEW_INTERVAL_MS) return false;
    lastInteractiveRenew = Date.now();
    return authorizeIdentity({ silent: true });
}

/** Esquece o token desta conta ("Desvincular"; o certificado continua). Quem ja verificou continua ate reconectar. */
export async function forgetIdentity(): Promise<void> {
    const userId = myId();
    identityEpoch++; // uma renovacao direta em andamento nao grava por cima
    // grava primeiro: se o DataStore falhar, nada muda (a UI avisa "não deu para desvincular" e continua coerente:
    // autorizada, com o token ainda indo no hello)
    if (userId) await saveStored(userId, null);
    token = null;
    lastInteractiveRenew = lastDirectFailure = -Infinity;
    lastDirect = null;
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
    const direct = !lastDirect ? "ainda não tentada" : lastDirect.ok ? `ok às ${time(lastDirect.at)} UTC` : `não deu: ${lastDirect.reason} às ${time(lastDirect.at)} UTC`;
    return `identidade: configurada (app ${DISCORD_CLIENT_ID}); local: ${local}; renovação sem janela: direta pelo Discord (última: ${direct})`
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
