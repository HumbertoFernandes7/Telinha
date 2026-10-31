/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Avisos de atualização dentro do Discord, com a notificação do Vencord (a mesma que o atualizador do Vencord usa):
//   - pronta (baixada e conferida):            "Telinha X.Y.Z pronto"     Reiniciar agora / Depois
//     (se ela já não entrou num início, o texto diz por quê e o que fazer: outro Discord aberto, arquivo em uso...)
//   - disponível (atualização automática off): "Telinha X.Y.Z disponível"  Atualizar / Depois
// Nunca no meio de uma transmissão (sua ou que você está assistindo): o aviso espera ela acabar. Também espera o
// Discord estar em foco, para aparecer dentro dele com os botões. Um aviso por versão por sessão. Erros (rede, limite
// do GitHub, offline) nunca viram aviso: ficam na linha de status das configurações e no log.
// Nada roda no carregamento do módulo: startUpdateNotices()/stopUpdateNotices() são chamados pelo plugin.

import { showNotification } from "@api/Notifications";
import { Button } from "@components/Button";
import { log } from "@plugins/telinha/core/log";
import { downloadUpdateNow, explainWaiting, getUpdateStatus, relaunchDiscord, subscribeUpdates, type UpdateWaiting } from "@plugins/telinha/core/update";
import { getState, subscribe } from "@plugins/telinha/store";
import { showToast } from "@webpack/common";

import { cl, logger } from "./common";

type Notice = { kind: "ready" | "available"; version: string; waiting?: UpdateWaiting | null; };

const noticeKey = (n: Notice) => `${n.kind}:${n.version}`;
const shown = new Set<string>();
let pending: Notice | null = null;
let unsubscribers: (() => void)[] = [];
let waitingForFocus = false;

/** Transmitindo, ou assistindo alguém: não é hora de aviso. */
function inStream() {
    const s = getState();
    return !!s.local || Object.values(s.viewing).some(v => v.status !== "ended" && v.status !== "error");
}

function restartNow() {
    if (!relaunchDiscord()) showToast({ text: "Feche o Discord por completo e abra de novo para usar a versão nova", variant: "default" });
}

function updateNow() {
    showToast({ text: "Baixando a atualização do Telinha…", variant: "default" });
    void downloadUpdateNow();
}

function NoticeBody({ text, primary, onPrimary }: { text: string; primary: string; onPrimary(): void; }) {
    // A notificação inteira fecha ao clicar (inclusive em "Depois"); o botão principal age antes de fechar.
    return (
        <div className={cl("update-notice")}>
            <p className={cl("update-notice-text")}>{text}</p>
            <div className={cl("update-notice-buttons")}>
                <Button size="small" onClick={onPrimary}>{primary}</Button>
                <Button size="small" variant="secondary">Depois</Button>
            </div>
        </div>
    );
}

function show(n: Notice) {
    const ready = n.kind === "ready";
    // pronta, mas já não entrou num início: diz por quê, e não promete que "entra sozinha"
    const stuck = ready ? explainWaiting(n.waiting) : null;
    const title = `Telinha ${n.version} ${ready ? "pronto" : "disponível"}`;
    const text = stuck
        ? `Não deu pra trocar de versão: ${stuck.why}. ${stuck.fix}`
        : ready
            ? "A versão nova entra quando o Discord reiniciar. Se preferir, ela entra sozinha na próxima vez que você abrir o Discord."
            : "Há uma versão nova do Telinha. Atualizar baixa e confere a versão agora; ela entra quando o Discord reiniciar.";
    log.info(`Aviso de atualização: ${title}${stuck ? ` (não entrou: ${n.waiting!.reason})` : ""}`);
    try {
        showNotification({
            title,
            // notificação do Windows (sem botões): só o texto
            body: stuck
                ? `Não deu pra trocar de versão: ${stuck.why}.`
                : ready ? "Reinicie o Discord para usar a versão nova." : "Abra Configurações → Vencord → Plugins → Telinha para atualizar.",
            richBody: <NoticeBody text={text} primary={ready ? "Reiniciar agora" : "Atualizar"} onPrimary={ready ? restartNow : updateNow} />,
            permanent: true,
            noPersist: true
        }).catch(e => logger.warn("Aviso de atualização do Telinha falhou", e));
    } catch (e) {
        logger.warn("Aviso de atualização do Telinha falhou", e);
    }
}

function tryShow() {
    if (!pending || inStream()) return;
    if (typeof document !== "undefined" && !document.hasFocus()) {
        if (!waitingForFocus) {
            waitingForFocus = true;
            window.addEventListener("focus", () => {
                waitingForFocus = false;
                tryShow();
            }, { once: true });
        }
        return;
    }
    const n = pending;
    pending = null;
    shown.add(noticeKey(n));
    show(n);
}

function onUpdateStatus() {
    const s = getUpdateStatus();
    let want: Notice | null = null;
    if (s?.phase === "ready" && s.ready) want = { kind: "ready", version: s.ready, waiting: s.waiting ?? null };
    else if (s?.phase === "available" && s.latest) want = { kind: "available", version: s.latest.version };
    if (!want || shown.has(noticeKey(want))) return;
    pending = want;
    tryShow();
}

export function startUpdateNotices() {
    if (unsubscribers.length) return;
    unsubscribers = [subscribeUpdates(onUpdateStatus), subscribe(tryShow)];
}

export function stopUpdateNotices() {
    for (const off of unsubscribers) off();
    unsubscribers = [];
    pending = null;
}
