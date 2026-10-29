/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@utils/clipboard`: copyToClipboard records the text. To make it fail:
//   mock.method(clipboardImpl, "copy", async () => { throw new Error("negado"); });

/** Everything copied, oldest first (the clipboard "content" is the last one). */
export const clipboard: string[] = [];

export const clipboardImpl = {
    async copy(text: string): Promise<void> {
        clipboard.push(text);
    }
};

export function copyToClipboard(text: string): Promise<void> {
    return clipboardImpl.copy(text);
}

export function resetClipboard() {
    clipboard.length = 0;
}
