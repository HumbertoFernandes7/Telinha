/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Viewer side of "Quem pode assistir": the password field shown when the stream is "Com senha" and the
// "Autorizar o Telinha" button shown after a "notVerified" refusal ("Só meus amigos do Discord"). Used by the viewer
// window (ViewerContent) and by the call tile player, so everything is styled inline (pop-outs and the call view don't
// receive Vencord's CSS). Nothing runs at module load.

import { authorizeAndRewatch, identityEnabled, submitWatchPassword } from "@plugins/telinha/actions";
import type { PeerId, ViewerSession } from "@plugins/telinha/types";
import { showToast, useState } from "@webpack/common";
import type { CSSProperties, SyntheticEvent } from "react";

import { ACCENT, logger } from "./common";

const FONT = "var(--font-primary, \"gg sans\", \"Noto Sans\", sans-serif)";

const buttonBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 30,
    padding: "0 12px",
    border: 0,
    borderRadius: 6,
    color: "#fff",
    font: `600 13px ${FONT}`,
    cursor: "pointer",
    whiteSpace: "nowrap",
    pointerEvents: "auto"
};

const accentButton: CSSProperties = { ...buttonBase, background: ACCENT };
const ghostButton: CSSProperties = { ...buttonBase, padding: "0 8px", background: "rgba(255, 255, 255, 0.14)" };

const inputStyle: CSSProperties = {
    width: 180,
    minWidth: 0,
    flex: "1 1 auto",
    height: 30,
    padding: "0 10px",
    border: "1px solid rgba(255, 255, 255, 0.25)",
    borderRadius: 6,
    background: "rgba(0, 0, 0, 0.55)",
    color: "#fff",
    font: `14px ${FONT}`,
    outline: "none",
    pointerEvents: "auto"
};

/** Our controls must not trigger the Discord tile's click/double click/keys (focus, fullscreen...) */
const stopEvents = {
    onClick: (e: SyntheticEvent) => e.stopPropagation(),
    onDoubleClick: (e: SyntheticEvent) => e.stopPropagation(),
    onMouseDown: (e: SyntheticEvent) => e.stopPropagation(),
    onPointerDown: (e: SyntheticEvent) => e.stopPropagation(),
    onKeyDown: (e: SyntheticEvent) => e.stopPropagation(),
    onKeyUp: (e: SyntheticEvent) => e.stopPropagation()
};

function attemptsText(attemptsLeft: number | null): string {
    if (attemptsLeft == null) return "";
    return attemptsLeft === 1 ? "Resta 1 tentativa." : `Restam ${attemptsLeft} tentativas.`;
}

/** Title + detail of the overlay while the streamer asks for the password (null = not asking). */
export function passwordOverlayText(session: ViewerSession, streamerName: string): { title: string; detail: string; } | null {
    const prompt = session.status === "connecting" ? session.passwordPrompt : undefined;
    if (!prompt) return null;
    const left = attemptsText(prompt.attemptsLeft);
    return prompt.wrong
        ? { title: "Senha incorreta", detail: `Confira com ${streamerName} e tente de novo. ${left}`.trim() }
        : { title: "Esta transmissão é com senha", detail: `Digite a senha que ${streamerName} passou para assistir.` };
}

/** Password field + "Assistir". Only the HMAC proof leaves this PC (core/viewing.ts). */
export function PasswordForm({ peerId, compact = false }: { peerId: PeerId; compact?: boolean; }) {
    const [value, setValue] = useState("");
    const [show, setShow] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = () => {
        try {
            if (submitWatchPassword(peerId, value)) {
                setValue("");
                setError(null);
            } else {
                setError(value.trim() ? "Senha longa demais (máximo 64 caracteres)." : "Digite a senha.");
            }
        } catch (e) {
            logger.error("submitWatchPassword falhou", e);
            setError("Não foi possível enviar a senha.");
        }
    };

    return (
        <form
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: "100%", maxWidth: 360, pointerEvents: "auto" }}
            onSubmit={e => {
                e.preventDefault();
                submit();
            }}
            {...stopEvents}
        >
            <div style={{ display: "flex", gap: 6, width: "100%" }}>
                <input
                    type={show ? "text" : "password"}
                    value={value}
                    autoFocus
                    maxLength={128}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Senha"
                    aria-label="Senha da transmissão"
                    style={{ ...inputStyle, width: compact ? 100 : 180 }}
                    onChange={e => {
                        setValue(e.currentTarget.value);
                        setError(null);
                    }}
                />
                {!compact && (
                    <button type="button" style={ghostButton} title={show ? "Esconder a senha" : "Mostrar a senha"} aria-label={show ? "Esconder a senha" : "Mostrar a senha"} onClick={() => setShow(s => !s)}>
                        {show ? "Esconder" : "Mostrar"}
                    </button>
                )}
                <button type="submit" style={accentButton}>Assistir</button>
            </div>
            {error && <div style={{ color: "#f0b232", fontSize: 12 }}>{error}</div>}
        </form>
    );
}

/** After a "notVerified" refusal: opens Discord's own "Autorizar" and, once authorized, asks to watch again. */
export function AuthorizeToWatchButton({ peerId }: { peerId: PeerId; }) {
    const [busy, setBusy] = useState(false);
    if (!identityEnabled()) return null;
    return (
        <button
            type="button"
            style={{ ...accentButton, opacity: busy ? 0.6 : 1 }}
            disabled={busy}
            {...stopEvents}
            onClick={e => {
                e.stopPropagation();
                setBusy(true);
                authorizeAndRewatch(peerId)
                    .then(ok => {
                        if (ok) showToast({ text: "Telinha autorizado: pedindo para assistir de novo…", variant: "success" });
                    })
                    .catch(err => {
                        logger.error("authorizeAndRewatch falhou", err);
                        showToast({ text: "Telinha: não deu para autorizar agora", variant: "critical" });
                    })
                    .finally(() => setBusy(false));
            }}
        >
            {busy ? "Autorizando…" : "Autorizar o Telinha"}
        </button>
    );
}
