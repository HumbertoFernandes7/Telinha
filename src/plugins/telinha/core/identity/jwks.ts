/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Cache do JWKS do Discord (https://discord.com/api/oauth2/keys). PURO: fetch, relogio e
// persistencia sao injetados. O endpoint manda Cache-Control: max-age=3600.
//
// - get(): devolve o JWKS fresco (< ttl) ou busca; se a busca falhar, usa o ultimo conhecido ate
//   maxStaleMs (o Discord troca de chave raramente; melhor verificar com a chave de ontem do que
//   deixar todo mundo "nao verificado" por um soluço de rede).
// - refresh(): busca de novo quando aparece um `kid` desconhecido (rotacao), no maximo 1x por minRefetchMs.

import { DISCORD_JWKS_URL } from "./config";
import { isJwks, type Jwks } from "./jwt";

export interface StoredJwks {
    jwks: Jwks;
    fetchedAt: number;
}

export interface JwksCacheOptions {
    fetchImpl?: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
    url?: string;
    now?: () => number;
    ttlMs?: number;
    minRefetchMs?: number;
    maxStaleMs?: number;
    load?: () => Promise<StoredJwks | undefined>;
    save?: (value: StoredJwks) => Promise<void>;
}

export class JwksCache {
    private current: StoredJwks | null = null;
    private loaded = false;
    private inflight: Promise<StoredJwks> | null = null;
    private lastAttempt = -Infinity;
    private readonly opts: Required<Omit<JwksCacheOptions, "load" | "save">> & Pick<JwksCacheOptions, "load" | "save">;

    constructor(options: JwksCacheOptions = {}) {
        this.opts = {
            fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
            url: options.url ?? DISCORD_JWKS_URL,
            now: options.now ?? Date.now,
            ttlMs: options.ttlMs ?? 60 * 60_000,
            minRefetchMs: options.minRefetchMs ?? 60_000,
            maxStaleMs: options.maxStaleMs ?? 30 * 24 * 60 * 60_000,
            load: options.load,
            save: options.save
        };
    }

    private async loadPersisted() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const stored = await this.opts.load?.();
            if (stored && isJwks(stored.jwks) && Number.isFinite(stored.fetchedAt) && !this.current) this.current = stored;
        } catch { }
    }

    private fetchNow(): Promise<StoredJwks> {
        this.inflight ??= (async () => {
            this.lastAttempt = this.opts.now();
            try {
                const res = await this.opts.fetchImpl(this.opts.url, { credentials: "omit", headers: { Accept: "application/json" } });
                if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
                const jwks: unknown = await res.json();
                if (!isJwks(jwks)) throw new Error("JWKS inválido");
                const value = { jwks, fetchedAt: this.opts.now() };
                this.current = value;
                this.opts.save?.(value).catch(() => { });
                return value;
            } finally {
                this.inflight = null;
            }
        })();
        return this.inflight;
    }

    /** JWKS utilizavel agora. Lanca so se nunca houve um JWKS (ou o ultimo esta velho demais). */
    async get(): Promise<Jwks> {
        await this.loadPersisted();
        const now = this.opts.now();
        const cur = this.current;
        if (cur && now - cur.fetchedAt < this.opts.ttlMs) return cur.jwks;
        try {
            return (await this.fetchNow()).jwks;
        } catch (e) {
            if (cur && now - cur.fetchedAt < this.opts.maxStaleMs) return cur.jwks;
            throw e;
        }
    }

    /** Busca de novo (kid desconhecido). null se ainda dentro do intervalo minimo ou se falhar. */
    async refresh(): Promise<Jwks | null> {
        await this.loadPersisted();
        if (this.opts.now() - this.lastAttempt < this.opts.minRefetchMs) return null;
        try {
            return (await this.fetchNow()).jwks;
        } catch {
            return null;
        }
    }
}
