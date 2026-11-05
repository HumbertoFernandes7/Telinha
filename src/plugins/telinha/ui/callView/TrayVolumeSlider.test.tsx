/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do volume da barra da call: o patch (expressao regular rodada contra o trecho minificado citado em
// patches.ts) e o componente TrayVolume (assume o controle so com a live tocando na tile, mexe em ui/volumes.ts, nunca
// no volume da voz do Discord, e cai no slider do Discord se quebrar).
// Rodar:  pnpm test:file src/plugins/telinha/ui/callView/TrayVolumeSlider.test.tsx

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { getVolume, setVolume } from "@plugins/telinha/ui/volumes";
import { act, cleanup, render } from "@test/fakes/render";
import { caughtErrors, loggerLines, resetVencordFakes } from "@test/fakes/vencord";
import * as React from "react";

import { callViewPatches } from "./index";
import { isTrayBarActive, resetTrayVolume, setTileAudio } from "./trayVolume";
import { TrayVolume } from "./TrayVolumeSlider";

// #region o patch

function canonicalize(match: RegExp): RegExp {
    return new RegExp(match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"), match.flags);
}

const PROPS = "{currentWindow:C,iconClassName:s()(t,m.pd),sliderClassName:l,className:n,value:(0,u.M)(p),muted:E,maxValue:A.isPlatformEmbedded?200:100,"
    + "onValueChange:e=>{e>0&&E&&r.default.toggleLocalMute(g,x),r.default.setLocalVolume(g,(0,u.w)(e),x)},"
    + "onToggleMute:()=>{null!=f&&(0,o.XJ)(f,o.OP.VOLUME,E),r.default.toggleLocalMute(g,x)}}";
const PRE = "function g(e){let{className:n,userId:g,context:x,currentWindow:C=window,location:f}=e,{currentVolume:p,muted:E}=(0,a.cf)([d.Ay],()=>({currentVolume:d.Ay.getLocalVolume(g,x),muted:d.Ay.isLocalMute(g,x)}));return(0,i.jsx)(h.A,{children:";
const POST = "})}";
const SAMPLE = `${PRE}(0,i.jsx)(c.A,${PROPS})${POST}`;

describe("patch do volume da barra da call", () => {
    const patch = callViewPatches[1];
    const { match, replace } = patch.replacement as { match: RegExp; replace: string; };
    const run = (code: string) => code.replace(canonicalize(match), replace);

    test("procura o modulo do volume pelo currentVolume:", () => {
        assert.equal(callViewPatches.length, 2);
        assert.equal(patch.find, "currentVolume:");
        assert.equal((patch as { all?: boolean; }).all, true, "o modulo pode estar em dois chunks");
        assert.equal((patch as { noWarn?: boolean; }).noWarn, true);
    });

    test("troca so a chamada do slider pelo TrayVolume (saida exata no trecho real)", () => {
        assert.equal(
            run(SAMPLE),
            `${PRE}(0,i.jsx)($self.TrayVolume,{Slider:c.A,discordProps:${PROPS},userId:g,context:x})${POST}`
        );
    });

    test("usa os nomes do build em que roda", () => {
        const renamed = SAMPLE.replace("(0,i.jsx)(c.A,", "(0,Q$.jsx)(zz.Qq,").replace("toggleLocalMute(g,x)}}", "toggleLocalMute(uu,ctx)}}");
        const out = run(renamed);
        assert.ok(out.includes("(0,Q$.jsx)($self.TrayVolume,{Slider:zz.Qq,discordProps:{currentWindow:C,"), out);
        assert.ok(out.endsWith(",userId:uu,context:ctx})})}"), out);
    });

    test("continua casando depois que o VolumeBooster reescreve o maxValue", () => {
        const boosted = SAMPLE.replace("A.isPlatformEmbedded?200:100", "200*$self.settings.store.multiplier"); // o rewrite real do VolumeBooster
        const out = run(boosted);
        assert.ok(out.includes("$self.TrayVolume"), out);
        assert.ok(out.includes("maxValue:200*$self.settings.store.multiplier,"), out);
    });

    test("se o Discord mudar o trecho o patch nao aplica e o codigo fica como estava", () => {
        const renamed = SAMPLE.replace(/toggleLocalMute\(g,x\)\}\}/, "toggleMute(g,x)}}");
        assert.equal(run(renamed), renamed);
        const noWindow = SAMPLE.replace("{currentWindow:C,", "{win:C,");
        assert.equal(run(noWindow), noWindow);
    });
});

// #endregion

// #region TrayVolume

const U = "200000000000000002";
let n = 0;

interface Spy {
    props: Record<string, any>[];
}

function setup(extra: { userId?: unknown; context?: unknown; discordProps?: Record<string, any>; } = {}) {
    const spy: Spy = { props: [] };
    const Slider = (p: Record<string, any>) => {
        spy.props.push(p);
        return <div data-testid="slider" />;
    };
    const discordProps = extra.discordProps ?? { className: "x", sliderClassName: "y", maxValue: 200, onValueChange: () => { throw new Error("discord"); } };
    const el = (
        <TrayVolume
            Slider={Slider}
            discordProps={discordProps}
            userId={"userId" in extra ? extra.userId : U}
            context={"context" in extra ? extra.context : "default"}
        />
    );
    const last = () => spy.props[spy.props.length - 1];
    return { spy, el, discordProps, last };
}

describe("TrayVolume", () => {
    let key: string;

    beforeEach(() => {
        resetVencordFakes();
        resetTrayVolume();
        key = `peer-${++n}`;
    });

    afterEach(() => {
        cleanup();
        resetTrayVolume();
        assert.deepEqual(caughtErrors, [], "nada quebrou");
    });

    test("sem som da live na tile: o slider do Discord com exatamente as props dele", () => {
        const { el, last, discordProps } = setup();
        render(el);
        assert.deepEqual(last(), discordProps);
        assert.equal(isTrayBarActive(U, window), false);
    });

    test("contexto diferente de default ou usuario que nao e texto: passa direto", () => {
        setTileAudio(U, Symbol(), key);
        const a = setup({ context: "stream" });
        render(a.el);
        assert.deepEqual(a.last(), a.discordProps);
        const b = setup({ userId: 123 });
        render(b.el);
        assert.deepEqual(b.last(), b.discordProps);
        assert.equal(isTrayBarActive(U, window), false);
    });

    test("assume o controle: valor, mudo e maxValue vem do volume da live; o resto das props segue", () => {
        setVolume(key, { volume: 0.4, muted: false });
        setTileAudio(U, Symbol(), key);
        const { el, last } = setup();
        render(el);
        const p = last();
        assert.equal(p.value, 40);
        assert.equal(p.muted, false);
        assert.equal(p.maxValue, 100);
        assert.equal(p.className, "x");
        assert.equal(isTrayBarActive(U, window), true);
    });

    test("mudo mostra 0; mexer no slider atualiza ui/volumes.ts sem chamar o Discord", () => {
        setVolume(key, { volume: 0.5, muted: true });
        setTileAudio(U, Symbol(), key);
        const { el, last } = setup();
        render(el);
        assert.equal(last().value, 0);
        assert.equal(last().muted, true);

        act(() => last().onValueChange(30)); // o handler do Discord (que lanca) nao e chamado
        assert.deepEqual(getVolume(key), { volume: 0.3, muted: false });
        assert.equal(last().value, 30);

        act(() => last().onValueChange(0));
        assert.deepEqual(getVolume(key), { volume: 0, muted: true });

        act(() => last().onValueChange(60));
        act(() => last().onToggleMute());
        assert.deepEqual(getVolume(key), { volume: 0.6, muted: true });
        act(() => last().onToggleMute());
        assert.deepEqual(getVolume(key), { volume: 0.6, muted: false });
    });

    test("desregistra a barra ao desmontar e quando a tile para de tocar o som", () => {
        const token = Symbol();
        setTileAudio(U, token, key);
        const { el, last, discordProps } = setup();
        const view = render(el);
        assert.equal(isTrayBarActive(U, window), true);

        act(() => setTileAudio(U, token, null));
        assert.equal(isTrayBarActive(U, window), false);
        assert.deepEqual(last(), discordProps);

        act(() => setTileAudio(U, token, key));
        assert.equal(isTrayBarActive(U, window), true);
        view.unmount();
        assert.equal(isTrayBarActive(U, window), false);
    });

    test("o onToggleMute original do Discord nunca e chamado na tomada; mudo alterna sem perder o volume", () => {
        setVolume(key, { volume: 0.7, muted: false });
        setTileAudio(U, Symbol(), key);
        let discordCalls = 0;
        const { el, last } = setup({ discordProps: { onToggleMute: () => void discordCalls++ } });
        render(el);
        act(() => last().onToggleMute());
        assert.equal(discordCalls, 0);
        assert.deepEqual(getVolume(key), { volume: 0.7, muted: true });
        act(() => last().onToggleMute());
        assert.equal(discordCalls, 0);
        assert.deepEqual(getVolume(key), { volume: 0.7, muted: false });
    });

    test("desmutar com o volume em 0 devolve o som (volume 1)", () => {
        setVolume(key, { volume: 0, muted: true });
        setTileAudio(U, Symbol(), key);
        const { el, last } = setup();
        render(el);
        act(() => last().onToggleMute());
        assert.deepEqual(getVolume(key), { volume: 1, muted: false });
    });

    test("registra na janela do currentWindow do Discord (e na principal se nao for um objeto)", () => {
        setTileAudio(U, Symbol(), key);
        const popout = { name: "popout" } as unknown as Window;
        const a = setup({ discordProps: { currentWindow: popout } });
        const view = render(a.el);
        assert.equal(isTrayBarActive(U, popout), true);
        assert.equal(isTrayBarActive(U, window), false);
        view.unmount();
        assert.equal(isTrayBarActive(U, popout), false);

        const b = setup({ discordProps: { currentWindow: "nao e janela" } });
        render(b.el);
        assert.equal(isTrayBarActive(U, window), true);
    });

    test("se a tomada quebrar depois de registrar a barra, o desfazer roda", () => {
        setVolume(key, { volume: 0.5, muted: false });
        setTileAudio(U, Symbol(), key);
        const Slider = (p: Record<string, any>) => {
            if (p.value === 0) throw new Error("quebrou depois");
            return <div data-testid="slider" />;
        };
        render(<TrayVolume Slider={Slider} discordProps={{ className: "c" }} userId={U} context="default" />);
        assert.equal(isTrayBarActive(U, window), true);
        act(() => setVolume(key, { volume: 0, muted: true }));
        assert.equal(isTrayBarActive(U, window), false, "a barra foi desregistrada");
        assert.ok(caughtErrors.length > 0);
        caughtErrors.length = 0;
    });

    test("se o componente quebrar, o slider do Discord continua la", () => {
        setTileAudio(U, Symbol(), key);
        const calls: Record<string, any>[] = [];
        const Slider = (p: Record<string, any>) => {
            calls.push(p);
            if (p.muted !== undefined) throw new Error("quebrou");
            return <div data-testid="slider" />;
        };
        const props = { className: "c" };
        const view = render(<TrayVolume Slider={Slider} discordProps={props} userId={U} context="default" />);
        assert.ok(view.container.querySelector("[data-testid=slider]"));
        assert.deepEqual(calls[calls.length - 1], props);
        assert.equal(loggerLines.find(l => l.level === "error")?.args[0], "O volume da barra da call do Telinha quebrou");
        assert.ok(caughtErrors.length > 0);
        caughtErrors.length = 0;
    });
});

// #endregion
