/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WP-F helper: open one of the plugin's modals (openAccessModal, openSourcePicker, openStreamersModal...) the way
// Discord would, rendered by the fake ModalHost, and read it back as the user sees it.
//
//   const modal = openInHost(() => openViewersModal());     // inside act(): the modal is on screen
//   modal.button("Fechar")                                  // its "Fechar" action
//   modal.text()                                            // everything written in it

import { act, fireEvent, render, screen, within } from "@test/fakes/render";
import { ModalHost } from "@test/fakes/vencord";

export interface OpenModalView {
    /** the Modal's dialog element (the last one opened) */
    dialog(): HTMLElement;
    /** a button of the dialog by its visible text */
    button(name: string | RegExp): HTMLButtonElement;
    /** the same, or null when there is none */
    maybeButton(name: string | RegExp): HTMLButtonElement | null;
    /** the dialog's notice (the red/yellow box under the title), or null */
    notice(): string | null;
    /** the dialog's title */
    title(): string;
    /** the dialog's whole text */
    text(): string;
    /** click a button of the dialog (wrapped in act by fireEvent) */
    click(name: string | RegExp): void;
}

/** Renders the fake modal host and runs `open` (which calls the plugin's open*Modal function) inside act. */
export function openInHost(open: () => void): OpenModalView {
    render(<ModalHost />);
    act(() => open());
    const dialog = () => {
        const all = screen.getAllByRole("dialog");
        return all[all.length - 1];
    };
    const find = (name: string | RegExp) => within(dialog()).queryByRole("button", { name }) as HTMLButtonElement | null;
    return {
        dialog,
        button(name) {
            const b = find(name);
            if (!b) throw new Error(`no button ${String(name)} in the modal: ${dialog().textContent}`);
            return b;
        },
        maybeButton: find,
        notice() {
            return within(dialog()).queryByRole("alert")?.textContent ?? null;
        },
        title() {
            return dialog().querySelector("h1")?.textContent ?? "";
        },
        text() {
            return dialog().textContent ?? "";
        },
        click(name) {
            fireEvent.click(this.button(name));
        }
    };
}
