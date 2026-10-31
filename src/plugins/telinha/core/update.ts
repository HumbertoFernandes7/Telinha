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

/**
 * Por que a versão pronta não entrou no último início do Discord (updater.js startup(), state.json `waiting`):
 *   trial            a versão atual ainda não confirmou que abriu direito
 *   others           outro Discord estava aberto quando este abriu (detail: pids e, quando deu pra ver, os programas)
 *   in-use           um arquivo da pasta do Telinha estava em uso (detail.code: EPERM, EBUSY...)
 *   activate-failed  a pasta da versão nova não pôde ser posta no lugar (antivírus?)
 *   locked           outro início do Discord estava trocando a versão ao mesmo tempo (swap.lock recente)
 *   lock-stuck       um swap.lock antigo que não pôde ser apagado
 * Só o início DESTE Discord: o loader não repassa o que outro Discord gravou no state.json.
 */
export interface UpdateWaiting {
    reason: string;
    detail: { pids?: number[]; exes?: (string | null)[]; code?: string | null; } | null;
    at: string | null;
    /** quantos inícios seguidos ela já esperou */
    starts: number;
}

/** O que o updater.js devolve (status()). */
export interface AddonUpdateStatus {
    supported: boolean;
    installed: { version: string; commit: string | null; } | null;
    phase: UpdatePhase;
    latest: { version: string; tag: string; } | null;
    /** versão baixada e conferida, esperando o Discord reiniciar */
    ready: string | null;
    /** por que `ready` não entrou no último início (ausente num loader antigo) */
    waiting?: UpdateWaiting | null;
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
    /** as últimas linhas "update" do main.log (ausente num loader antigo) */
    updateLog?(): Promise<string[]>;
}

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const PROGRESS_POLL_MS = 700;

let status: AddonUpdateStatus | null = null;
/** últimas linhas "update" do main.log, lidas para o "Copiar diagnóstico"; null = não deu pra ler */
let recentLog: string[] | null = null;
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

/** Lê do main as últimas linhas "update" do main.log (para o "Copiar diagnóstico"). */
export async function refreshUpdateLog(): Promise<string[] | null> {
    const api = addonNative();
    recentLog = null;
    if (typeof api?.updateLog !== "function") return null;
    try {
        const lines = await api.updateLog();
        recentLog = Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string") : null;
    } catch (e) {
        console.warn("[Telinha] update log failed", e);
    }
    return recentLog;
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

const FLAVORS: Record<string, string> = {
    "discord.exe": "Discord", "discordptb.exe": "Discord PTB", "discordcanary.exe": "Discord Canary", "discorddevelopment.exe": "Discord Development"
};
const CLOSE_AND_REOPEN = "Feche o Discord por completo e abra de novo. Se não resolver, reinicie o computador.";

/** Por que a versão pronta não entrou ao reiniciar, e o que fazer (frases curtas do aviso e das configurações). */
export function explainWaiting(w: UpdateWaiting | null | undefined): { why: string; fix: string; } | null {
    if (!w) return null;
    switch (w.reason) {
        case "others": {
            const exes = (w.detail?.exes ?? []).filter((e): e is string => typeof e === "string" && e.length > 0);
            const names = [...new Set(exes.map(e => FLAVORS[e.toLowerCase()] ?? e))];
            return {
                why: `outro Discord estava aberto quando este abriu${names.length ? ` (${names.join(", ")})` : ""}`,
                fix: "Feche todos os Discords, inclusive pelo ícone perto do relógio (botão direito → Sair do Discord), e abra de novo."
            };
        }
        case "in-use":
            return { why: "um arquivo do Telinha estava em uso (o ajudante de áudio ou o antivírus)", fix: CLOSE_AND_REOPEN };
        case "activate-failed":
            return { why: "o Windows não deixou pôr a versão nova no lugar (antivírus?)", fix: CLOSE_AND_REOPEN };
        case "locked":
            return { why: "outro Discord estava trocando de versão ao mesmo tempo", fix: "Feche o Discord por completo e abra de novo." };
        case "lock-stuck":
            return { why: "uma trava antiga da atualização não pôde ser apagada", fix: "Reinicie o computador e abra o Discord de novo." };
        case "trial":
            return { why: "a versão atual ainda não tinha confirmado que abriu direito", fix: "Reinicie o Discord mais uma vez." };
        default:
            return { why: "não deu pra trocar desta vez", fix: "Reinicie o Discord mais uma vez." };
    }
}

/**
 * Rótulo do botão que reinicia o Discord (aviso e configurações). Com outro Discord aberto, reiniciar só este não
 * resolve: o botão lembra de fechar os outros antes.
 */
export function restartLabel(w: UpdateWaiting | null | undefined): string {
    return w?.reason === "others" ? "Fechei os outros, reiniciar" : "Reiniciar agora";
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
        case "ready": {
            const w = s.waiting;
            const stuck = explainWaiting(w);
            if (!stuck || !w) return `Versão ${s.ready} pronta: reinicie o Discord para usar.`;
            const tries = w.starts > 1 ? ` (${w.starts} tentativas)` : "";
            return `Versão ${s.ready} pronta, mas não entrou ao reiniciar${tries}: ${stuck.why}. ${stuck.fix}`;
        }
        case "error":
            return `Erro: ${s.error?.message ?? "a verificação falhou"}.${rolledBack}`;
        default:
            return `Ainda não verifiquei nesta sessão.${rolledBack}`;
    }
}

/**
 * Para o "Copiar diagnóstico": versão e status; o motivo cru de uma versão que não entrou (quando houver); as últimas
 * linhas "update" do main.log (lidas antes por refreshUpdateLog()).
 */
export function updateDiagnostics(): string {
    if (!updatesSupported()) return "versão: ? (sem o loader do add-on: atualização automática indisponível)";
    const s = status;
    const version = s?.installed ? `${s.installed.version}${s.installed.commit ? ` (${s.installed.commit})` : ""}` : "?";
    const lines = [`versão: ${version}; atualização automática: ${autoUpdate() ? "ligada" : "desligada"}; atualização: ${describeUpdate(s)}`];
    const w = s?.waiting;
    if (w) lines.push(`atualização esperando: ${w.reason}; ${w.starts} início(s) seguido(s); último ${w.at ?? "?"}${w.detail ? `; ${JSON.stringify(w.detail)}` : ""}`);
    if (!recentLog) lines.push("main.log: não deu pra ler (loader antigo ou sem acesso)");
    else if (!recentLog.length) lines.push("main.log: nenhuma linha de atualização");
    else lines.push("main.log (últimas linhas de atualização):", ...recentLog.map(l => `  ${l}`));
    return lines.join("\n");
}
