/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Os botoes Transmitir e Trocar do seletor (ui/SourcePickerModal.tsx) com o nucleo de verdade por tras
// (test/helpers/wpf-live.ts): a captura, o som da janela e da tela inteira, "Quem pode assistir" com senha, o botao
// Iniciando…, a captura recusada, e o seletor virando Trocar com a transmissao no ar. A lista e as opcoes estao em
// SourcePickerModal.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/SourcePickerModal.start.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getStreamPassword, stopStreaming } from "@plugins/telinha/actions";
import { getState } from "@plugins/telinha/store";
import { act, fireEvent, screen, settle, waitFor } from "@test/fakes/render";
import { caughtErrors, modals, SelectedChannelStore, toasts, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { captureStream } from "@test/fakes/webrtc";
import { type LiveScene, openLiveScene } from "@test/helpers/wpf-live";
import { openInHost, until } from "@test/helpers/wpf-modal";

import { openSourcePicker } from "./SourcePickerModal";

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const card = (name: string) => screen.getByTitle(name) as HTMLButtonElement;
const audioSwitch = () => screen.getByRole("switch") as HTMLInputElement;
const qualitySelect = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;
const accessSelect = () => screen.getAllByRole("combobox")[1] as HTMLSelectElement;

describe("SourcePickerModal: Transmitir de verdade (nucleo por tras)", () => {
    let scene: LiveScene;

    before(async () => {
        scene = await openLiveScene();
    });

    after(() => scene.close());

    beforeEach(() => {
        scene.resetUi();
        stopStreaming();
    });

    afterEach(() => {
        assert.deepEqual(caughtErrors, [], "nenhum componente quebrou");
        stopStreaming();
    });

    /** Abre o seletor e escolhe uma fonte pelo nome. */
    async function pick(name: string, tabName?: RegExp) {
        const modal = openInHost(openSourcePicker);
        await settle();
        if (tabName) fireEvent.click(tab(tabName));
        fireEvent.click(card(name));
        return modal;
    }

    test("janela com som e as opcoes padrao: o modal fecha, o toast avisa e o nucleo transmite a janela", async () => {
        const modal = await pick("Jogo");
        modal.click("Transmitir");
        await until(() => modals.list().length === 0);

        assert.deepEqual(toasts, [{ text: "Telinha: transmissão iniciada", variant: "success" }]);
        const { local } = getState();
        assert.equal(local?.source.id, "window:1234:0");
        assert.equal(local?.quality, "1080p60");
        assert.equal(local?.access, "all");
        assert.equal(local?.hasAudio, true, "o som da janela veio junto");
        assert.deepEqual(scene.native.calls.find(c => c.name === "prepareDisplayMedia")?.args, ["window:1234:0", "Jogo", true]);
    });

    test("som desligado, 720p e Quem pode assistir = so quem eu aprovar: o nucleo recebe exatamente isso", async () => {
        const modal = await pick("Jogo");
        fireEvent.click(audioSwitch());
        fireEvent.change(qualitySelect(), { target: { value: "720p60" } });
        fireEvent.change(accessSelect(), { target: { value: "approval" } });
        modal.click("Transmitir");
        await until(() => modals.list().length === 0);

        const { local } = getState();
        assert.equal(local?.quality, "720p60");
        assert.equal(local?.access, "approval");
        assert.equal(local?.hasAudio, false);
    });

    test("Com senha: so transmite com a senha, e o nucleo guarda a senha ja sem espacos", async () => {
        const modal = await pick("Jogo");
        fireEvent.change(accessSelect(), { target: { value: "password" } });
        fireEvent.change(screen.getByLabelText("Senha desta transmissão"), { target: { value: "  sofa-77 " } });
        modal.click("Transmitir");
        await until(() => modals.list().length === 0);

        assert.equal(getState().local?.access, "password");
        assert.equal(getStreamPassword(), "sofa-77");
    });

    test("tela inteira sem o ajudante de som: transmite so a imagem", async () => {
        const modal = await pick("Tela inteira", /^Telas/);
        assert.equal(audioSwitch().disabled, true);
        modal.click("Transmitir");
        await until(() => modals.list().length === 0);

        assert.equal(getState().local?.source.kind, "screen");
        assert.equal(getState().local?.hasAudio, false);
        assert.deepEqual(scene.native.calls.filter(c => c.name === "prepareDisplayMedia").at(-1)?.args, ["screen:0:0", "Tela inteira", false]);
    });

    test("duplo clique no cartao transmite na hora, sem apertar Transmitir", async () => {
        openInHost(openSourcePicker);
        await settle();
        fireEvent.doubleClick(card("Jogo"));
        await until(() => modals.list().length === 0);
        assert.equal(getState().local?.source.name, "Jogo");
    });

    test("enquanto a captura nao responde: o botao fica Iniciando… e nao deixa clicar de novo", async () => {
        let release!: () => void;
        scene.rtc.mediaDevices.getDisplayMediaImpl = constraints => new Promise(resolve => (release = () => resolve(captureStream({ audio: !!constraints.audio }))));
        const callsBefore = scene.rtc.mediaDevices.displayMediaCalls.length;
        const modal = await pick("Jogo");
        modal.click("Transmitir");
        await settle();

        const busy = modal.button("Iniciando…");
        assert.equal(busy.disabled, true);
        assert.equal(modal.button("Cancelar").disabled, false, "da para desistir");
        assert.equal(scene.rtc.mediaDevices.displayMediaCalls.length, callsBefore + 1, "so um pedido de captura");

        // um duplo clique no cartao nessa hora tambem nao pede outra captura
        fireEvent.doubleClick(card("Jogo"));
        await settle();
        assert.equal(scene.rtc.mediaDevices.displayMediaCalls.length, callsBefore + 1, "continua um so");

        await act(async () => release());
        await until(() => modals.list().length === 0);
        assert.equal(getState().local?.source.name, "Jogo");
    });

    test("a captura e recusada: o motivo aparece no modal, que continua aberto; arrumando, transmite", async () => {
        scene.rtc.mediaDevices.getDisplayMediaImpl = () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
        const modal = await pick("Jogo");
        modal.click("Transmitir");
        await waitFor(() => assert.ok(modal.notice(), "o aviso apareceu no modal"));

        assert.equal(modal.notice(), "Não foi possível começar a transmissão: A captura foi recusada. Se a janela foi fechada, escolha outra.");
        assert.equal(modals.list().length, 1, "continua aberto");
        assert.equal(modal.button("Transmitir").disabled, false, "pode tentar de novo");
        assert.deepEqual(toasts, []);
        assert.equal(getState().local, null);

        scene.rtc.mediaDevices.getDisplayMediaImpl = constraints => Promise.resolve(captureStream({ audio: !!constraints.audio }));
        modal.click("Transmitir");
        await until(() => modals.list().length === 0);
        assert.equal(getState().local?.source.name, "Jogo");
    });

    test("com a transmissao no ar o seletor vira Trocar: sem Quem pode assistir, qualidade atual e aviso proprio", async () => {
        // no ar em 720p60 e "Só quem eu aprovar": trocar de fonte nao mexe em nenhum dos dois
        const first = await pick("Jogo");
        fireEvent.change(qualitySelect(), { target: { value: "720p60" } });
        fireEvent.change(accessSelect(), { target: { value: "approval" } });
        first.click("Transmitir");
        await until(() => modals.list().length === 0);
        scene.resetUi();

        const modal = openInHost(openSourcePicker);
        await settle();
        assert.equal(modal.title(), "Trocar o que você transmite");
        assert.match(modal.text(), /Quem está assistindo passa a ver a nova tela ou janela\./);
        assert.equal(screen.getAllByRole("combobox").length, 1, "so a qualidade: quem pode assistir se muda pela barra");
        assert.equal(qualitySelect().value, "720p60", "a qualidade do ar");
        assert.equal(modal.button("Trocar").disabled, true);

        fireEvent.click(tab(/^Telas/));
        fireEvent.click(card("Tela inteira"));
        modal.click("Trocar");
        await until(() => modals.list().length === 0);

        assert.deepEqual(toasts, [{ text: "Telinha: transmissão trocada", variant: "success" }]);
        const { local } = getState();
        assert.equal(local?.source.kind, "screen");
        assert.equal(local?.access, "approval", "o modo continua o mesmo");
    });

    test("trocando de fonte com a transmissao no ar, o seletor abre mesmo fora do canal de voz", async t => {
        const first = await pick("Jogo");
        first.click("Transmitir");
        await until(() => modals.list().length === 0);
        scene.resetUi();

        SelectedChannelStore.setVoiceChannel(null);
        t.after(() => SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID));
        const modal = openInHost(openSourcePicker);
        await settle();
        assert.equal(modal.title(), "Trocar o que você transmite");
        assert.deepEqual(toasts, []);
    });
});
