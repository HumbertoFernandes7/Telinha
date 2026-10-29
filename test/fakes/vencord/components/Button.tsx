/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@components/Button`: a plain <button> (variant/size go to data-* attributes).

import type { ComponentPropsWithRef } from "react";

export type ButtonProps = ComponentPropsWithRef<"button"> & { variant?: string; size?: string; };

export function Button({ variant = "primary", size = "medium", children, ...rest }: ButtonProps) {
    return <button type="button" data-variant={variant} data-size={size} {...rest}>{children}</button>;
}

export function TextButton({ variant = "primary", ...rest }: ButtonProps) {
    return <button type="button" data-variant={variant} {...rest} />;
}
