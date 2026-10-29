/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Quem pode assistir" for the streamer: the select (Todos da call / Só meus amigos do Discord / Só quem eu aprovar /
// Com senha) with a one-line explanation and, for "Com senha", the password field with "Gerar" and "Copiar". Used in
// the transmit picker (SourcePickerModal) and in the modal the voice bar opens to change it while live. Main window
// only (CSS classes). Nothing runs at module load.

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { friendsAccessAvailable, generateStreamPassword, getStreamPassword, setStreamAccess } from "@plugins/telinha/actions";
import { ACCESS_LABEL, isValidPassword, normalizePassword, PASSWORD_MAX_CHARS } from "@plugins/telinha/core/access";
import { settings } from "@plugins/telinha/settings";
import { useTelinhaState } from "@plugins/telinha/store";
import type { AccessMode } from "@plugins/telinha/types";
import { copyToClipboard } from "@utils/clipboard";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, Select, showToast, useState } from "@webpack/common";

import { cl, errorText, logger } from "./common";

const ACCESS_ORDER: readonly AccessMode[] = ["all", "friends", "approval", "password"];

function accessHint(access: AccessMode): string {
    switch (access) {
        case "friends":
            return "Entra direto quem é seu amigo no Discord e provou a identidade (verificado). Os outros veem que você transmite, mas não conseguem assistir.";
        case "approval":
            return "Cada pedido para assistir espera você clicar em Permitir ou Recusar na barra do Telinha (recusado sozinho em 60 s).";
        case "password":
            return "Só assiste quem digitar a senha, mesmo sem identidade verificada: a senha é a porta. Errou 5 vezes, fica bloqueado até a transmissão acabar.";
        default:
            return friendsAccessAvailable() && settings.store.requireVerifiedIdentity !== false
                ? "Quem está no seu canal de voz assiste direto; quem não tem a identidade verificada precisa do seu Permitir."
                : "Quem está no seu canal de voz assiste direto.";
    }
}

/** The choice is complete (with "Com senha", a valid password was typed or generated). */
export function accessReady(access: AccessMode, password: string): boolean {
    return access !== "password" || isValidPassword(normalizePassword(password));
}

function copyPassword(password: string) {
    const value = normalizePassword(password);
    if (!value) return;
    copyToClipboard(value).then(
        () => showToast({ text: "Senha copiada", variant: "success" }),
        () => showToast({ text: "Não consegui copiar a senha", variant: "critical" })
    );
}

export interface AccessPickerProps {
    access: AccessMode;
    onAccess(access: AccessMode): void;
    password: string;
    onPassword(password: string): void;
}

export function AccessPicker({ access, onAccess, password, onPassword }: AccessPickerProps) {
    const friendsOk = friendsAccessAvailable();
    const options = ACCESS_ORDER.map(value => ({
        value,
        label: value === "friends" && !friendsOk ? `${ACCESS_LABEL.friends} (indisponível)` : ACCESS_LABEL[value],
        disabled: value === "friends" && !friendsOk
    }));
    const normalized = normalizePassword(password);
    const tooLong = normalized.length > PASSWORD_MAX_CHARS;

    return (
        <div className={cl("access")}>
            <div className={cl("option-row")}>
                <span className={cl("option-label")}>Quem pode assistir</span>
                <div className={cl("option-control")}>
                    <Select
                        options={options}
                        isSelected={v => v === access}
                        select={v => {
                            // "Só meus amigos" depende da prova de identidade (Client ID no build)
                            if (v === "friends" && !friendsOk) return;
                            onAccess(v);
                        }}
                        serialize={v => String(v)}
                        closeOnSelect={true}
                    />
                </div>
            </div>
            <span className={cl("access-hint")}>{accessHint(access)}</span>
            {!friendsOk && (
                <span className={cl("access-hint")}>
                    "Só meus amigos do Discord" está indisponível: esta versão do Telinha não tem a prova de identidade do Discord.
                </span>
            )}
            {access === "password" && (
                <>
                    <div className={cl("access-password")}>
                        <input
                            className={cl("input")}
                            value={password}
                            placeholder="Digite uma senha ou clique em Gerar"
                            aria-label="Senha desta transmissão"
                            maxLength={PASSWORD_MAX_CHARS + 16}
                            spellCheck={false}
                            autoComplete="off"
                            onChange={e => onPassword(e.currentTarget.value)}
                        />
                        <Button size="small" variant="secondary" onClick={() => onPassword(generateStreamPassword())}>Gerar</Button>
                        <Button size="small" variant="secondary" disabled={!normalized || tooLong} onClick={() => copyPassword(password)}>Copiar</Button>
                    </div>
                    <span className={cl("access-hint", tooLong && "access-error")}>
                        {tooLong
                            ? `A senha pode ter no máximo ${PASSWORD_MAX_CHARS} caracteres.`
                            : "Vale só para esta transmissão e nunca fica salva. Passe para quem vai assistir (a senha não trafega: o Telinha só troca uma prova dela)."}
                    </span>
                </>
            )}
        </div>
    );
}

function AccessModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const { local } = useTelinhaState();
    const [access, setAccess] = useState<AccessMode>(() => local?.access ?? "all");
    const [password, setPassword] = useState(() => getStreamPassword() ?? "");
    const [error, setError] = useState<string | null>(null);

    const apply = () => {
        try {
            setStreamAccess(access, password);
            modalProps.onClose();
            showToast({ text: `Telinha: quem pode assistir agora: ${ACCESS_LABEL[access]}`, variant: "success" });
        } catch (e) {
            logger.error("setStreamAccess falhou", e);
            setError(errorText(e));
        }
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Quem pode assistir"
            subtitle="Vale para os próximos pedidos: quem já está assistindo continua assistindo."
            notice={error ? { message: error, type: "critical" } : !local ? { message: "Você não está mais transmitindo.", type: "critical" } : undefined}
            actions={[
                { text: "Aplicar", variant: "primary", onClick: apply, disabled: !local || !accessReady(access, password) },
                { text: "Cancelar", variant: "secondary", onClick: modalProps.onClose }
            ]}
        >
            <div className={cl("picker")}>
                <div className={cl("options")}>
                    <AccessPicker
                        access={access}
                        onAccess={a => {
                            setAccess(a);
                            setError(null);
                        }}
                        password={password}
                        onPassword={p => {
                            setPassword(p);
                            setError(null);
                        }}
                    />
                </div>
            </div>
        </Modal>
    );
}

/** Voice bar → change "Quem pode assistir" while live. */
export function openAccessModal() {
    openModal(props => (
        <ErrorBoundary>
            <AccessModal modalProps={props} />
        </ErrorBoundary>
    ));
}

/** Voice bar → "Copiar senha" while live with "Com senha". */
export function copyStreamPassword() {
    const password = getStreamPassword();
    if (password) copyPassword(password);
}
