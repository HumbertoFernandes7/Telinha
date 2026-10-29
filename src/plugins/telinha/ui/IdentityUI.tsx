/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Discord identity proof in the UI (docs/identity.md): the per-peer badge (verificado / não verificado / identidade
// falsa), the one-line "Autorize o Telinha no Discord" banner in the voice bar, and the settings page section with
// "Autorizar o Telinha no Discord" / "Desvincular". Without a Discord Client ID in the build (identityEnabled() false)
// all of it renders nothing, exactly like v0.1.0. Nothing here runs at module load.

import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import {
    authorizeTelinhaIdentity, getLocalIdentity, identityEnabled, type LocalIdentityState, subscribeLocalIdentityState, unlinkTelinhaIdentity
} from "@plugins/telinha/actions";
import type { PeerIdentityStatus } from "@plugins/telinha/types";
import { React, showToast, useState } from "@webpack/common";

import { cl, runAction } from "./common";
import { CloseIcon } from "./icons";

/** Re-renders when the local identity state changes (authorized, expired, authorizing...). */
export function useLocalIdentity(): LocalIdentityState {
    return React.useSyncExternalStore(subscribeLocalIdentityState, getLocalIdentity);
}

const BADGE: Record<PeerIdentityStatus, { text: string; short: string; title: string; }> = {
    verified: {
        text: "✔ verificado",
        short: "✔",
        title: "Identidade verificada: provou ser esta conta do Discord nesta conexão"
    },
    unverified: {
        text: "não verificado",
        short: "não verificado",
        title: "Não verificado: não provou ser esta conta do Discord (não autorizou o Telinha ou usa uma versão antiga)"
    },
    invalid: {
        text: "✖ identidade falsa",
        short: "✖ falsa",
        title: "Identidade falsa: apresentou uma prova que não confere (pode ser alguém se passando por essa pessoa). Ignorada."
    },
    pending: {
        text: "conferindo…",
        short: "…",
        title: "Conferindo a identidade no Discord"
    }
};

/** Small identity badge next to a peer's name. Renders nothing when the feature is off (identity undefined). */
export function IdentityBadge({ identity, compact = false }: { identity: PeerIdentityStatus | undefined; compact?: boolean; }) {
    if (!identity) return null;
    const b = BADGE[identity];
    return (
        <span className={cl("id-badge", `id-badge-${identity}`)} title={b.title} aria-label={b.title}>
            {compact ? b.short : b.text}
        </span>
    );
}

/** Short pt-BR text for a peer's identity, for tooltips/notifications ("" when the feature is off or verified-only contexts). */
export function identityHint(identity: PeerIdentityStatus | undefined): string {
    if (identity === "verified") return "identidade verificada";
    if (identity === "unverified") return "não verificado";
    return "";
}

function authorizeWithToast() {
    runAction("authorizeIdentity", () => authorizeTelinhaIdentity().then(ok => {
        const s = getLocalIdentity();
        if (ok) showToast({ text: "Telinha autorizado: seus amigos conseguem confirmar que é você", variant: "success" });
        else if (s.status === "error") showToast({ text: `Telinha: não deu para autorizar (${s.error})`, variant: "critical" });
    }));
}

// The banner is dismissed for this Discord session only: it comes back after a restart while still unauthorized.
let bannerDismissed = false;

/** Voice bar banner: shown only with a Client ID and while this account isn't authorized (or the last try failed). */
export function IdentityBanner() {
    const s = useLocalIdentity();
    const [dismissed, setDismissed] = useState(bannerDismissed);
    if (!identityEnabled() || dismissed || (s.status !== "unauthorized" && s.status !== "error")) return null;

    const title = s.status === "error"
        ? `A última autorização não deu certo (${s.error}). Sem ela, seus amigos veem você como "não verificado".`
        : "Uma vez só: o Discord mostra a janela dele pedindo para o Telinha saber quem você é. Sem isso, seus amigos veem você como \"não verificado\".";
    return (
        <div className={cl("bar-identity")} role="status" title={title}>
            <span className={cl("bar-row-text", "bar-identity-text")}>Autorize o Telinha no Discord para provar que é você</span>
            <button className={cl("bar-request-btn", "bar-request-allow")} onClick={authorizeWithToast}>Autorizar</button>
            <button
                className={cl("bar-error-close")}
                aria-label="Agora não"
                title="Agora não (volta a aparecer quando o Discord reiniciar)"
                onClick={() => {
                    bannerDismissed = true;
                    setDismissed(true);
                }}
            >
                <CloseIcon size={12} />
            </button>
        </div>
    );
}

function describe(s: LocalIdentityState): { label: string; detail: string; } {
    switch (s.status) {
        case "ready":
            return { label: "autorizado", detail: "Seus amigos com o Telinha conseguem confirmar que é você (selo \"verificado\"). A autorização se renova sozinha." };
        case "expired":
            return { label: "autorização vencida", detail: "Ela se renova sozinha quando você entrar numa call. Se preferir, autorize de novo agora." };
        case "authorizing":
            return { label: "autorizando…", detail: "Confirme na janela do Discord." };
        case "error":
            return { label: "erro", detail: `Não deu certo da última vez: ${s.error}` };
        case "loading":
            return { label: "carregando…", detail: "" };
        case "disabled":
            return { label: "desligada", detail: "" };
        default:
            return { label: "não autorizado", detail: "Seus amigos veem você como \"não verificado\" e, se eles exigirem identidade verificada, precisam permitir para você assistir." };
    }
}

/** Settings page section: state + "Autorizar o Telinha no Discord" / "Desvincular". Nothing without a Client ID. */
export function IdentitySection() {
    const s = useLocalIdentity();
    const [busy, setBusy] = useState(false);
    if (!identityEnabled()) return null;

    const { label, detail } = describe(s);
    const unlink = () => {
        setBusy(true);
        unlinkTelinhaIdentity()
            .then(() => showToast({ text: "Telinha desvinculado desta conta neste PC", variant: "success" }))
            .catch(() => showToast({ text: "Telinha: não deu para desvincular", variant: "critical" }))
            .finally(() => setBusy(false));
    };

    return (
        <div className={cl("identity")}>
            <Paragraph>
                Identidade no Discord: <strong>{label}</strong>
            </Paragraph>
            {detail && <Paragraph className={cl("identity-status")}>{detail}</Paragraph>}
            <div className={cl("identity-buttons")}>
                {s.status === "ready"
                    ? (
                        <Button size="small" variant="secondary" disabled={busy} onClick={unlink}>
                            Desvincular
                        </Button>
                    )
                    : (
                        <Button size="small" disabled={busy || s.status === "authorizing" || s.status === "loading"} onClick={authorizeWithToast}>
                            Autorizar o Telinha no Discord
                        </Button>
                    )}
            </div>
            {s.status === "ready" && (
                <Paragraph className={cl("identity-status")}>
                    Desvincular apaga a autorização só deste PC. Para tirar também do Discord: Configurações de usuário → Apps autorizados → Telinha.
                </Paragraph>
            )}
        </div>
    );
}
