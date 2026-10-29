/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@components/Paragraph`: a plain <p>.

import type { ComponentPropsWithRef } from "react";

export function Paragraph({ children, ...rest }: ComponentPropsWithRef<"p"> & { size?: string; weight?: string; }) {
    return <p {...rest}>{children}</p>;
}
