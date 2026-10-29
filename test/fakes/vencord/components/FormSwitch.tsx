/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@components/FormSwitch`: a checkbox with role="switch", labelled by `title` (fireEvent.click toggles it).

import type { ReactNode } from "react";

export interface FormSwitchProps {
    title: ReactNode;
    description?: ReactNode;
    value: boolean;
    onChange(value: boolean): void;
    disabled?: boolean;
    className?: string;
    hideBorder?: boolean;
}

export function FormSwitch({ title, description, value, onChange, disabled, className }: FormSwitchProps) {
    return (
        <label className={className}>
            <input type="checkbox" role="switch" checked={value} disabled={disabled} onChange={e => onChange(e.currentTarget.checked)} />
            <span>{title}</span>
            {description != null && <span data-description="">{description}</span>}
        </label>
    );
}
