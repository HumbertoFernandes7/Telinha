/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Atualização automática, lado renderer. O trabalho de verdade fica no processo main, no loader do add-on
// (addon/loader/updater.js; contrato em addon/PAYLOAD.md, seção 8): procurar a versão nova no GitHub, baixar,
// conferir o SHA-256, deixar pronta em addon.new e trocar só na próxima abertura do Discord, com rollback automático.
// Aqui: agendar as verificações (ao abrir e a cada 6 h), guardar o último status e avisar quem assina.
// Nada roda no carregamento do módulo: startUpdateChecks()/stopUpdateChecks() são chamados pelo plugin.

import { settings } from "@plugins/telinha/settings";

export type UpdatePhase = "idle" | "checking" | "downloading" | "up-to-date" | "available" | "ready" | "error";

/** O que o updater.js devolve (status()). */
export interface AddonUpdateStatus {
    supported: boolean;
    installed: { version: string; commit: string | null; } | null;
    phase: UpdatePhase;
    latest: { version: string; tag: string; } | null;
    /** versão baixada e conferida, esperando o Discord reiniciar */
    ready: string | null;
    /** quiet = rede, limite do GitHub ou offline: nunca vira aviso, só a linha de status */
    error: { kind: string; message: string; quiet: boolean; } | null;
    checkedAt: number | null;
    /** a versão mais nova foi ignorada porque já falhou ao iniciar (rollback) */
    skipped: string | null;
    lastRollback: { version: string; to: string; at: string; reason: string; } | null;
}

/** Natives do próprio loader (VencordNative.pluginHelpers.TelinhaAddon), fora dos natives do plugin. */
interface AddonNative {
    updateStatus(): Promise<AddonUpdateStatus>;
    updateCheck(opts: { autoDownload: boolean; manual: boolean; }): Promise<AddonUpdateStatus>;
    updateDownload(): Promise<AddonUpdateStatus>;
}

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const PROGRESS_POLL_MS = 700;

let status: AddonUpdateStatus | null = null;
const listeners = new Set<() => void>();
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

function addonNative(): AddonNative | null {
    if (typeof VencordNative === "undefined") return null;
    const api = (VencordNative.pluginHelpers as Record<string, unknown> | undefined)?.TelinhaAddon as Partial<AddonNative> | undefined;
    return typeof api?.updateStatus === "function" && typeof api.updateCheck === "function" && typeof api.updateDownload === "function"
        ? api as AddonNative
        : null;
}

/** Sem o loader do add-on (ex.: plugin compilado dentro de um Vencord), não há atualização automática. */
export function updatesSupported() {
    return addonNative() !== null;
}

function setStatus(next: AddonUpdateStatus | null) {
    if (!next) return;
    status = next;
    for (const fn of listeners) {
        try {
            fn();
        } catch (e) {
            console.error("[Telinha] update listener failed", e);
        }
    }
}

export const getUpdateStatus = () => status;

export function subscribeUpdates(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

export async function refreshUpdateStatus(): Promise<AddonUpdateStatus | null> {
    const api = addonNative();
    if (!api) return null;
    try {
        setStatus(await api.updateStatus());
    } catch (e) {
        console.warn("[Telinha] update status failed", e);
    }
    return status;
}

/** Roda uma operação longa no main, atualizando o status enquanto ela anda (procurando → baixando → pronto). */
async function withProgress(run: (api: AddonNative) => Promise<AddonUpdateStatus>): Promise<AddonUpdateStatus | null> {
    const api = addonNative();
    if (!api) return null;
    const poll = setInterval(() => void refreshUpdateStatus(), PROGRESS_POLL_MS);
    try {
        setStatus(await run(api));
    } catch (e) {
        // falha de IPC (não de rede): só no console, nunca um aviso
        console.warn("[Telinha] update call failed", e);
    } finally {
        clearInterval(poll);
    }
    return status;
}

const autoUpdate = () => settings.store.autoUpdate !== false;

/** Verificação silenciosa (ao abrir o Discord e a cada 6 h): com "Atualizar automaticamente", já baixa e prepara. */
async function autoCheck() {
    const api = addonNative();
    if (!api) return;
    try {
        setStatus(await api.updateCheck({ autoDownload: autoUpdate(), manual: false }));
    } catch (e) {
        console.warn("[Telinha] update check failed", e);
    }
}

/** Botão "Procurar atualização". */
export function checkForUpdateNow() {
    return withProgress(api => api.updateCheck({ autoDownload: autoUpdate(), manual: true }));
}

/** Botão "Atualizar" (atualização automática desligada): baixa, confere e deixa pronta para o próximo início. */
export function downloadUpdateNow() {
    return withProgress(api => api.updateDownload());
}

export function startUpdateChecks() {
    if (firstTimer || intervalTimer || !addonNative()) return;
    void refreshUpdateStatus();
    firstTimer = setTimeout(() => {
        firstTimer = null;
        void autoCheck();
    }, FIRST_CHECK_DELAY_MS);
    intervalTimer = setInterval(() => void autoCheck(), CHECK_INTERVAL_MS);
}

export function stopUpdateChecks() {
    if (firstTimer) clearTimeout(firstTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    firstTimer = intervalTimer = null;
}

/**
 * Reinicia o Discord inteiro, como o atualizador do próprio Vencord faz (src/utils/native.ts relaunch():
 * DiscordNative.app.relaunch()). A troca de versão acontece nesse novo início, antes de o Telinha carregar.
 */
export function relaunchDiscord(): boolean {
    const app = (window as { DiscordNative?: { app?: { relaunch?: () => void; }; }; }).DiscordNative?.app;
    if (typeof app?.relaunch !== "function") return false;
    app.relaunch();
    return true;
}

/** Linha de status da página de configurações: em dia / baixando / pronto, reinicie / erro curto. */
export function describeUpdate(s: AddonUpdateStatus | null): string {
    if (!s) return "Ainda não verifiquei.";
    const rolledBack = s.lastRollback && s.lastRollback.to === s.installed?.version
        ? ` A versão ${s.lastRollback.version} não iniciou direito e foi desfeita sozinha.`
        : "";
    switch (s.phase) {
        case "checking":
            return "Procurando atualização…";
        case "downloading":
            return `Baixando a versão ${s.latest?.version ?? "nova"}…`;
        case "up-to-date":
            return `Em dia.${s.skipped ? ` A versão ${s.skipped} foi ignorada porque não iniciou direito.` : rolledBack}`;
        case "available":
            return `Versão ${s.latest?.version ?? "nova"} disponível.`;
        case "ready":
            return `Versão ${s.ready} pronta: reinicie o Discord para usar.`;
        case "error":
            return `Erro: ${s.error?.message ?? "a verificação falhou"}.${rolledBack}`;
        default:
            return `Ainda não verifiquei nesta sessão.${rolledBack}`;
    }
}

/** Para o "Copiar diagnóstico". */
export function updateDiagnostics(): string {
    if (!updatesSupported()) return "versão: ? (sem o loader do add-on: atualização automática indisponível)";
    const s = status;
    const version = s?.installed ? `${s.installed.version}${s.installed.commit ? ` (${s.installed.commit})` : ""}` : "?";
    return `versão: ${version}; atualização automática: ${autoUpdate() ? "ligada" : "desligada"}; atualização: ${describeUpdate(s)}`;
}
