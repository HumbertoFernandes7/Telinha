/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes dos icones SVG (ui/icons.tsx) e do Avatar (ui/Avatar.tsx): decorativos (escondidos de leitores de tela),
// herdam a cor do texto e o tamanho vem das props, para renderizar igual dentro dos pop-outs do Discord.
// Rodar:  pnpm test:file src/plugins/telinha/ui/icons.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { render } from "@test/fakes/render";
import { FRIEND_ID, makeUser, OTHER_ID, resetVencordFakes, UserStore } from "@test/fakes/vencord";
import type { ComponentType } from "react";

import { Avatar } from "./Avatar";
import { BroadcastIcon, CloseIcon, EyeIcon, FullscreenIcon, StopIcon, VolumeIcon, WarningIcon } from "./icons";

function svgOf(container: HTMLElement): SVGElement {
    const svg = container.querySelector("svg");
    assert.ok(svg, "desenhou um svg");
    return svg;
}

describe("icones", () => {
    const simple: [string, ComponentType<{ size?: number; className?: string; }>][] = [
        ["BroadcastIcon", BroadcastIcon], ["EyeIcon", EyeIcon], ["StopIcon", StopIcon], ["CloseIcon", CloseIcon], ["WarningIcon", WarningIcon]
    ];

    for (const [name, Icon] of simple) {
        test(`${name}: 16 px por padrao, decorativo, herda a cor do texto`, () => {
            const svg = svgOf(render(<Icon />).container);
            assert.equal(svg.getAttribute("width"), "16");
            assert.equal(svg.getAttribute("height"), "16");
            assert.equal(svg.getAttribute("viewBox"), "0 0 24 24");
            assert.equal(svg.getAttribute("aria-hidden"), "true", "leitor de tela ignora");
            assert.equal(svg.getAttribute("focusable"), "false");
            assert.equal(svg.getAttribute("class"), null);
            assert.ok(svg.innerHTML.includes("currentColor"), "usa currentColor, sem cor fixa");
        });

        test(`${name}: tamanho e classe vem das props`, () => {
            const svg = svgOf(render(<Icon size={10} className="minha-classe" />).container);
            assert.equal(svg.getAttribute("width"), "10");
            assert.equal(svg.getAttribute("height"), "10");
            assert.equal(svg.getAttribute("class"), "minha-classe");
        });
    }

    test("VolumeIcon: mudo desenha o X, com som desenha as ondas", () => {
        const muted = svgOf(render(<VolumeIcon muted />).container);
        const loud = svgOf(render(<VolumeIcon muted={false} size={20} />).container);
        assert.ok(muted.innerHTML.includes("m15 9 6 6m0-6-6 6"), "X do mudo");
        assert.ok(!loud.innerHTML.includes("m15 9 6 6m0-6-6 6"));
        assert.ok(loud.innerHTML.includes("M14.5 8.5"), "ondas do som");
        assert.equal(loud.getAttribute("width"), "20");
    });

    test("FullscreenIcon: o desenho de sair da tela cheia e diferente do de entrar", () => {
        const enter = svgOf(render(<FullscreenIcon exit={false} />).container).innerHTML;
        const leave = svgOf(render(<FullscreenIcon exit />).container).innerHTML;
        assert.notEqual(enter, leave);
        assert.ok(enter.includes("M4 9V4h5"));
        assert.ok(leave.includes("M9 4v5H4"));
    });
});

describe("Avatar", () => {
    beforeEach(() => resetVencordFakes());

    test("usuario conhecido do Discord: a foto dele, sem texto alternativo (decorativa)", () => {
        UserStore.addUsers(makeUser(FRIEND_ID, "ana"));
        const { container } = render(<Avatar userId={FRIEND_ID} />);
        const img = container.querySelector("img")!;
        assert.equal(img.className, "vc-telinha-avatar");
        assert.match(img.getAttribute("src")!, /size=64/);
        assert.equal(img.getAttribute("alt"), "");
        assert.equal(container.querySelector("svg"), null);
    });

    test("usuario que o Discord nao conhece (ou sem id): o icone do Telinha no lugar da foto", () => {
        for (const id of [OTHER_ID, undefined]) {
            const { container, unmount } = render(<Avatar userId={id} />);
            assert.equal(container.querySelector("img"), null);
            const empty = container.querySelector("span")!;
            assert.equal(empty.className, "vc-telinha-avatar vc-telinha-avatar-empty");
            assert.equal(empty.querySelector("svg")!.getAttribute("width"), "18");
            unmount();
        }
    });
});
