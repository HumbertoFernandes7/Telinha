/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do seletor "Transmitir com Telinha" (ui/SourcePickerModal.tsx), aberto de verdade pelo openSourcePicker():
// carregando a lista de telas e janelas (natives), escolher a fonte, a qualidade, o som (janela x tela inteira, com e
// sem o ajudante de audio) e "Quem pode assistir". Os botoes Transmitir e Trocar, com o nucleo de verdade por tras,
// estao em SourcePickerModal.start.test.tsx.
// Rodar:  pnpm test:file src/plugins/telinha/ui/SourcePickerModal.test.tsx  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { getState, resetState } from "@plugins/telinha/store";
import type { CaptureSource } from "@plugins/telinha/types";
import { installWebAudio, type WebAudioEnv } from "@test/fakes/audio";
import { installNative } from "@test/fakes/native";
import { act, fireEvent, screen, settle, within } from "@test/fakes/render";
import { caughtErrors, modals, pluginSettings, resetVencordFakes, SelectedChannelStore, toasts, VOICE_CHANNEL_ID } from "@test/fakes/vencord";
import { openInHost } from "@test/helpers/wpf-modal";

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
