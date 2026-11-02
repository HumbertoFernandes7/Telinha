/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// "Resolução" and "FPS" of the live stream, in the modal the voice bar's "Qualidade: 1080p · 60 fps  Mudar" row opens
// (like "Quem pode assistir" → AccessPicker). Picking one applies it and closes the modal (the voice bar does the
// recapture: viewers keep watching). Shows the 2K note ("2K escolhido, a tela tem 1080p…") and, if the change got locked
// meanwhile, the reason. Main window only (CSS classes). Nothing runs at module load.

import ErrorBoundary from "@components/ErrorBoundary";
import { HINT_2K, qualityOf, splitQuality } from "@plugins/telinha/core/quality/choice";
import { useTelinhaState } from "@plugins/telinha/store";
import type { Quality } from "@plugins/telinha/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal } from "@webpack/common";

import { cl, FPS_OPTIONS, RESOLUTION_OPTIONS } from "./common";

/** "Resolução" or "FPS": small buttons side by side, the chosen one highlighted */
export function Segmented<T extends number>({ label, options, value, disabled, titleOf, onPick }: {
    label: string;
    options: readonly { value: T; label: string; }[];
    value: T;
    disabled: boolean;
    titleOf?(value: T): string | undefined;
    onPick(value: T): void;
}) {
    return (
        <div className={cl("bar-seg")} role="group" aria-label={label}>
            <span className={cl("bar-seg-label")} aria-hidden="true">{label}</span>
            <div className={cl("bar-seg-buttons")}>
                {options.map(o => (
                    <button
                        key={o.value}
                        className={cl("bar-seg-btn", o.value === value && "bar-seg-active")}
                        aria-pressed={o.value === value}
                        title={titleOf?.(o.value)}
                        disabled={disabled}
                        onClick={() => onPick(o.value)}
                    >
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function QualityModal({ modalProps, onPick }: { modalProps: RenderModalProps; onPick(quality: Quality): void; }) {
    const { local } = useTelinhaState();
    const quality = local?.quality ?? "1080p60";
    const { resolution, fps } = splitQuality(quality);
    const lock = local?.qualityLock ?? null;
    const sizeNote = local?.sizeNote ?? null;
    const off = !local || !!lock;

    const pick = (next: Quality) => {
        if (off || next === quality) return;
        modalProps.onClose();
        onPick(next);
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Qualidade da transmissão"
            subtitle="Ao trocar, o Telinha captura a mesma tela de novo: quem assiste continua assistindo."
            notice={!local ? { message: "Você não está mais transmitindo.", type: "critical" } : undefined}
            actions={[{ text: "Fechar", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div className={cl("picker")}>
                <div className={cl("options")}>
                    <div className={cl("bar-quality")}>
                        <Segmented
                            label="Resolução"
                            options={RESOLUTION_OPTIONS}
                            value={resolution}
                            disabled={off}
                            titleOf={r => lock ?? (r === 1440 ? HINT_2K : undefined)}
                            onPick={r => pick(qualityOf(r, fps))}
                        />
                        <Segmented
                            label="FPS"
                            options={FPS_OPTIONS}
                            value={fps}
                            disabled={off}
                            titleOf={lock ? () => lock : undefined}
                            onPick={f => pick(qualityOf(resolution, f))}
                        />
                    </div>
                    {resolution === 1440 && <span className={cl("quality-hint")}>{HINT_2K}</span>}
                    {sizeNote && <span className={cl("quality-hint")}>{sizeNote}</span>}
                    {lock && <span className={cl("quality-hint", "quality-lock")}>{lock}</span>}
                </div>
            </div>
        </Modal>
    );
}

/** Voice bar → "Mudar" the quality while live. `onPick` runs after the modal closes. */
export function openQualityModal(onPick: (quality: Quality) => void) {
    openModal(props => (
        <ErrorBoundary>
            <QualityModal modalProps={props} onPick={onPick} />
        </ErrorBoundary>
    ));
}
