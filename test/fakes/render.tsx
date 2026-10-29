/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Rendering for component tests: @testing-library/react on happy-dom (installed by importing this module, which
// imports @test/fakes/dom first). Plugin components get the real React through the @webpack/common fake.
// Import every testing-library function from HERE (not from "@testing-library/..."): this is one pre-bundled copy
// (test/fakes/vendor.ts, ~0.4 s faster per test process), configured by its own render/act.
//
//   import { act, fireEvent, render, screen } from "@test/fakes/render";
//   render(<VoiceUserTag userId={FRIEND_ID} />);
//   act(() => setState(...));                       // plugin store changes outside an event: wrap in act
//
// Cleanup (unmount + document reset) runs after every test of the file that imports this module.

import "./dom";

import { afterEach } from "node:test";

import type * as Rtl from "@testing-library/react";

import { requireBundled } from "./vendor";

const rtl = requireBundled<typeof Rtl>("testing-library-react", "@testing-library/react", ["react", "react/*", "react-dom", "react-dom/*"]);

export const { act, cleanup, configure, createEvent, fireEvent, render, renderHook, screen, waitFor, waitForElementToBeRemoved, within, prettyDOM } = rtl;

afterEach(() => cleanup());

/**
 * Lets the plugin's pending store updates land inside act(): core/context.ts publish() runs in a microtask, so a
 * click that changes the core state re-renders AFTER fireEvent returns.
 */
export async function settle(): Promise<void> {
    await act(async () => {
        await new Promise(resolve => setImmediate(resolve));
    });
}
