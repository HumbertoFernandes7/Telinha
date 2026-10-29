/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do seletor "Transmitir com Telinha" (ui/SourcePickerModal.tsx), aberto de verdade pelo openSourcePicker():
// carregando a lista de telas e janelas (natives), escolher a fonte, a qualidade, o som (janela x tela inteira, com e
// sem o ajudante de audio) e "Quem pode assistir", e o botao Transmitir/Trocar com o nucleo de verdade por tras
// (captura, erros, trocar de fonte com a transmissao no ar).
// Rodar:  pnpm test:file src/plugins/telinha/ui/SourcePickerModal.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getStreamPassword, stopStreaming } from "@plugins/telinha/actions";
import { getState, resetState } from "@plugins/telinha/store";
import type { CaptureSource } from "@plugins/telinha/types";
import { installWebAudio, type WebAudioEnv } from "@test/fakes/audio";
import { installNative } from "@test/fakes/native";
import { act, fireEvent, screen, settle, waitFor, within } from "@test/fakes/render";
import { caughtErrors, modals, pluginSettings, resetVencordFakes, SelectedChannelStore, toasts, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { captureStream } from "@test/fakes/webrtc";
import { type LiveScene, openLiveScene } from "@test/helpers/wpf-live";
import { openInHost, until } from "@test/helpers/wpf-modal";

import { openSourcePicker } from "./SourcePickerModal";

const SCREEN: CaptureSource = { id: "screen:0:0", name: "Tela inteira", kind: "screen" };
const GAME: CaptureSource = { id: "window:1234:0", name: "Jogo", kind: "window" };
const CHAT: CaptureSource = { id: "window:77:0", name: "Navegador", kind: "window" };

const sources = (...list: CaptureSource[]) => async () => ({ sources: list });
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const card = (name: string) => screen.getByTitle(name) as HTMLButtonElement;
const audioSwitch = () => screen.getByRole("switch") as HTMLInputElement;
const qualitySelect = () => screen.getAllByRole("combobox")[0] as HTMLSelectElement;
const accessSelect = () => screen.getAllByRole("combobox")[1] as HTMLSelectElement;

describe("openSourcePicker: antes de abrir", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
    });

    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    test("fora de um canal de voz e sem transmitir: avisa e nao abre nada", () => {
        openSourcePicker();
        assert.deepEqual(toasts, [{ text: "Telinha: entre num canal de voz para transmitir.", variant: "critical" }]);
        assert.equal(modals.list().length, 0);
    });
});

describe("SourcePickerModal: a lista e as opcoes", () => {
    beforeEach(() => {
        resetVencordFakes();
        resetState();
        SelectedChannelStore.setVoiceChannel(VOICE_CHANNEL_ID);
    });

    afterEach(() => assert.deepEqual(caughtErrors, [], "nenhum componente quebrou"));

    function openWith(t: { after(fn: () => void): void; }, list: () => Promise<{ sources: CaptureSource[]; error?: string; }>, extra: Record<string, (...a: any[]) => any> = {}) {
        const native = installNative({ listSources: list, ...extra });
        t.after(() => native.restore());
        return { native, modal: openInHost(openSourcePicker) };
    }

    test("carregando: avisa que esta buscando, ainda sem contagem nas abas e sem poder transmitir", async t => {
        let resolve!: (v: { sources: CaptureSource[]; }) => void;
        const { modal } = openWith(t, () => new Promise(r => (resolve = r)));
        await settle();

        assert.equal(modal.title(), "Transmitir com Telinha");
        assert.match(modal.text(), /Escolha o que seus amigos na call vão ver\. A imagem vai direto do seu PC para o deles, sem servidor\./);
        screen.getByText("Carregando telas e janelas…");
        assert.equal((screen.getByRole("button", { name: "Atualizando…" }) as HTMLButtonElement).disabled, true);
        assert.equal(tab(/^Telas$/).textContent, "Telas", "sem contagem enquanto carrega");
        assert.equal(modal.button("Transmitir").disabled, true);

        await act(async () => resolve({ sources: [SCREEN, GAME] }));
        screen.getByRole("button", { name: "Atualizar lista" });
        assert.equal(screen.queryByText("Carregando telas e janelas…"), null);
    });

    test("com janelas abertas, comeca na aba Janelas com a contagem de cada aba; nada vem escolhido", async t => {
        const { modal } = openWith(t, sources(SCREEN, GAME, CHAT));
        await settle();

        assert.equal(tab(/^Janelas/).getAttribute("aria-selected"), "true");
        assert.equal(tab(/^Janelas/).textContent, "Janelas2");
        assert.equal(tab(/^Telas/).getAttribute("aria-selected"), "false");
        assert.equal(tab(/^Telas/).textContent, "Telas1");
        assert.equal(card("Jogo").getAttribute("aria-pressed"), "false");
        assert.equal(card("Navegador").getAttribute("aria-pressed"), "false");
        assert.equal(screen.queryByTitle("Tela inteira"), null, "a tela esta na outra aba");
        assert.equal(modal.button("Transmitir").disabled, true, "falta escolher");
    });

    test("so telas (sem janela aberta): ja abre na aba Telas; a aba Janelas diz que nao ha nenhuma", async t => {
        openWith(t, sources(SCREEN));
        await settle();

        assert.equal(tab(/^Telas/).getAttribute("aria-selected"), "true");
        card("Tela inteira");
        fireEvent.click(tab(/^Janelas/));
        screen.getByText("Nenhuma janela aberta encontrada.");
        assert.equal(screen.queryByTitle("Tela inteira"), null);
    });

    test("so janelas: a aba Telas diz que nao ha nenhuma", async t => {
        openWith(t, sources(GAME));
        await settle();
        fireEvent.click(tab(/^Telas/));
        screen.getByText("Nenhuma tela encontrada.");
    });

    test("escolher uma fonte marca o cartao, libera o Transmitir e trocar de escolha desmarca a anterior", async t => {
        const { modal } = openWith(t, sources(GAME, CHAT));
        await settle();

        fireEvent.click(card("Jogo"));
        assert.equal(card("Jogo").getAttribute("aria-pressed"), "true");
        assert.equal(modal.button("Transmitir").disabled, false);
        fireEvent.click(card("Navegador"));
        assert.equal(card("Jogo").getAttribute("aria-pressed"), "false");
        assert.equal(card("Navegador").getAttribute("aria-pressed"), "true");
    });

    test("Atualizar lista: busca de novo, mantem a escolha se a fonte continua la e desmarca se ela sumiu", async t => {
        let current = [GAME, CHAT];
        const { native, modal } = openWith(t, async () => ({ sources: current }));
        await settle();
        fireEvent.click(card("Jogo"));

        await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Atualizar lista" })));
        assert.equal(card("Jogo").getAttribute("aria-pressed"), "true", "continua escolhida");
        assert.equal(native.calls.filter(c => c.name === "listSources").length, 2);
        assert.deepEqual(native.calls[0].args, [320, 180], "pede miniaturas pequenas");

        current = [CHAT, SCREEN];
        await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Atualizar lista" })));
        assert.equal(screen.queryByTitle("Jogo"), null, "o jogo foi fechado");
        assert.equal(tab(/^Janelas/).textContent, "Janelas1");
        assert.equal(tab(/^Telas/).textContent, "Telas1");
        assert.equal(modal.button("Transmitir").disabled, true, "a escolha sumiu junto");
    });

    test("cartao com miniatura mostra a imagem; sem miniatura diz Sem previa; sem nome usa um nome padrao", async t => {
        openWith(t, sources(
            { ...GAME, thumbnail: "data:image/jpeg;base64,AAAA" },
            { id: "window:9:0", name: "", kind: "window" },
            { id: "window:10:0", name: "Bloco", kind: "window" }
        ));
        await settle();

        assert.equal(card("Jogo").querySelector("img")?.getAttribute("src"), "data:image/jpeg;base64,AAAA");
        assert.equal(within(card("Bloco")).getByText("Sem prévia").tagName, "SPAN");
        screen.getByText("Janela sem título");
    });

    test("uma tela sem nome aparece como Tela", async t => {
        openWith(t, sources({ id: "screen:1:0", name: "", kind: "screen" }));
        await settle();
        screen.getByText("Tela");
    });

    test("sem a parte nativa: a lista vem vazia e o motivo aparece embaixo", async () => {
        openInHost(openSourcePicker);
        await settle();
        // sem nenhuma janela na lista, o seletor abre na aba Telas
        const empty = screen.getByText(/Nenhuma tela encontrada\./);
        assert.match(empty.textContent!, /A parte nativa do Telinha não está carregada/);
        assert.equal(tab(/^Telas/).getAttribute("aria-selected"), "true");
        assert.match(getState().lastError ?? "", /nativa/);
    });

    describe("qualidade", () => {
        test("vem a qualidade padrao das configuracoes e da para trocar", async t => {
            pluginSettings.set("defaultQuality", "720p60");
            openWith(t, sources(GAME));
            await settle();

            assert.deepEqual([...qualitySelect().options].map(o => o.textContent), ["1080p · 60 fps", "720p · 60 fps", "1080p · 30 fps"]);
            assert.equal(qualitySelect().value, "720p60");
            fireEvent.change(qualitySelect(), { target: { value: "1080p30" } });
            assert.equal(qualitySelect().value, "1080p30");
        });
    });

    describe("som", () => {
        // o ajudante de som da tela inteira precisa de Web Audio (AudioWorklet): sem isso o nucleo diz que este Discord nao tem
        let webAudio: WebAudioEnv;
        beforeEach(() => void (webAudio = installWebAudio()));
        afterEach(() => webAudio.restore());

        test("janela: o som do aplicativo da janela, ligado por padrao", async t => {
            openWith(t, sources(GAME));
            await settle();
            assert.equal(audioSwitch().checked, true);
            assert.equal(audioSwitch().disabled, false);
            screen.getByText("Envia junto o som do aplicativo dessa janela.");
        });

        test("o padrao das configuracoes desligado: vem desligado, e da para ligar", async t => {
            pluginSettings.set("shareAudioByDefault", false);
            openWith(t, sources(GAME));
            await settle();
            assert.equal(audioSwitch().checked, false);
            fireEvent.click(audioSwitch());
            assert.equal(audioSwitch().checked, true);
        });

        test("tela inteira sem o ajudante de audio: desligado, bloqueado e com o motivo", async t => {
            openWith(t, sources(SCREEN));
            await settle();
            assert.equal(audioSwitch().checked, false);
            assert.equal(audioSwitch().disabled, true);
            screen.getByText("Sem som na tela inteira: o ajudante de áudio (telinha-audio.exe) não foi instalado. A tela vai só com imagem.");
        });

        test("tela inteira sem motivo informado: usa a frase padrao", async t => {
            openWith(t, sources(SCREEN), { screenAudioStatus: async () => ({ available: false }) });
            await settle();
            screen.getByText("Sem som na tela inteira: o ajudante de áudio não está disponível. A tela vai só com imagem.");
        });

        test("tela inteira enquanto o PC ainda e verificado: diz que esta verificando", async t => {
            let resolve!: (v: { available: boolean; }) => void;
            openWith(t, sources(SCREEN), { screenAudioStatus: () => new Promise(r => (resolve = r)) });
            await settle();
            screen.getByText("Verificando se este PC consegue compartilhar o som da tela inteira…");
            assert.equal(audioSwitch().disabled, true);

            await act(async () => resolve({ available: true }));
            screen.getByText("Vai todo o som do PC, menos o do Discord (seus amigos não ouvem a própria voz).");
            assert.equal(audioSwitch().disabled, false);
            assert.equal(audioSwitch().checked, true);
        });

        test("tela inteira com o ajudante: o som do PC sem o do Discord, e o aviso muda ao trocar de aba", async t => {
            openWith(t, sources(SCREEN, GAME), { screenAudioStatus: async () => ({ available: true }) });
            await settle();

            // aba Janelas (a inicial): o som e o da janela
            screen.getByText("Envia junto o som do aplicativo dessa janela.");
            fireEvent.click(tab(/^Telas/));
            screen.getByText("Vai todo o som do PC, menos o do Discord (seus amigos não ouvem a própria voz).");
            assert.equal(audioSwitch().disabled, false);

            // a fonte escolhida manda: escolhendo a janela, o som volta a ser o da janela
            fireEvent.click(tab(/^Janelas/));
            fireEvent.click(card("Jogo"));
            fireEvent.click(tab(/^Telas/));
            screen.getByText("Envia junto o som do aplicativo dessa janela.");
        });

        test("o ajudante falha ao responder: a tela inteira fica sem som e o motivo aparece", async t => {
            openWith(t, sources(SCREEN), {
                screenAudioStatus: async () => {
                    throw new Error("helper travou");
                }
            });
            await settle();
            screen.getByText(/Sem som na tela inteira: falha ao consultar o ajudante de áudio: .*helper travou\. A tela vai só com imagem\./);
            assert.equal(audioSwitch().disabled, true);
        });
    });

    describe("Quem pode assistir", () => {
        test("vem o padrao das configuracoes e da para trocar; Com senha pede a senha antes de transmitir", async t => {
            pluginSettings.set("defaultAccess", "approval");
            const { modal } = openWith(t, sources(GAME));
            await settle();

            assert.equal(accessSelect().value, "approval");
            fireEvent.click(card("Jogo"));
            assert.equal(modal.button("Transmitir").disabled, false);

            fireEvent.change(accessSelect(), { target: { value: "password" } });
            assert.equal(modal.button("Transmitir").disabled, true, "Com senha sem senha digitada");
            assert.equal(modal.notice(), null);

            // duplo clique no cartao tenta transmitir assim mesmo: explica o que falta, sem chamar o nucleo
            fireEvent.doubleClick(card("Jogo"));
            assert.equal(modal.notice(), "Não foi possível começar a transmissão: Digite ou gere uma senha para esta transmissão.");

            fireEvent.change(screen.getByLabelText("Senha desta transmissão"), { target: { value: "pipoca-42" } });
            assert.equal(modal.notice(), null, "mexer na senha limpa o aviso");
            assert.equal(modal.button("Transmitir").disabled, false);

            fireEvent.change(accessSelect(), { target: { value: "friends" } });
            fireEvent.change(accessSelect(), { target: { value: "all" } });
            assert.equal(modal.button("Transmitir").disabled, false);
        });

        test("a senha nunca vem preenchida: digitada ou gerada a cada transmissao", async t => {
            openWith(t, sources(GAME));
            await settle();
            fireEvent.change(accessSelect(), { target: { value: "password" } });
            assert.equal((screen.getByLabelText("Senha desta transmissão") as HTMLInputElement).value, "");
        });
    });

    test("Cancelar fecha o seletor sem transmitir", async t => {
        const { modal } = openWith(t, sources(GAME));
        await settle();
        modal.click("Cancelar");
        assert.equal(modals.list().length, 0);
        assert.deepEqual(toasts, []);
    });
});

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
        const modal = openInHost(openSourcePicker);
        await settle();
        fireEvent.doubleClick(card("Jogo"));
        await until(() => modals.list().length === 0);
        assert.equal(getState().local?.source.name, "Jogo");
        assert.ok(modal);
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
        // no ar em 720p60 com a senha: trocar nao mexe em quem pode assistir
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
