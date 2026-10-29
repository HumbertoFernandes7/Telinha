/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { getScreenAudioStatus, listSources, screenAudioSupported, startStreaming } from "@plugins/telinha/actions";
import { getState } from "@plugins/telinha/store";
import type { CaptureSource, Quality } from "@plugins/telinha/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, Select, showToast, useEffect, useState } from "@webpack/common";

import { cl, defaultQuality, errorText, inVoiceChannel, logger, QUALITY_OPTIONS, shareAudioByDefault } from "./common";

type Kind = CaptureSource["kind"];

const WINDOW_AUDIO_NOTE = "Envia junto o som do aplicativo dessa janela.";
const SCREEN_AUDIO_NOTE = "Vai todo o som do PC, menos o do Discord (seus amigos não ouvem a própria voz).";
const SCREEN_AUDIO_CHECKING = "Verificando se este PC consegue compartilhar o som da tela inteira…";

type ScreenAudioState = Awaited<ReturnType<typeof getScreenAudioStatus>>;

function SourceCard({ source, selected, onSelect, onConfirm }: {
    source: CaptureSource;
    selected: boolean;
    onSelect(): void;
    onConfirm(): void;
}) {
    return (
        <button
            className={cl("source", selected && "source-selected")}
            title={source.name}
            aria-pressed={selected}
            onClick={onSelect}
            onDoubleClick={onConfirm}
        >
            <div className={cl("thumb")}>
                {source.thumbnail
                    ? <img src={source.thumbnail} alt="" draggable={false} />
                    : <span className={cl("thumb-empty")}>Sem prévia</span>}
            </div>
            <span className={cl("source-name")}>{source.name || (source.kind === "screen" ? "Tela" : "Janela sem título")}</span>
        </button>
    );
}

function SourcePickerModal({ modalProps, switching, initialQuality }: { modalProps: RenderModalProps; switching: boolean; initialQuality: Quality; }) {
    const [sources, setSources] = useState<CaptureSource[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [tab, setTab] = useState<Kind>("window");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [quality, setQuality] = useState<Quality>(initialQuality);
    const [audio, setAudio] = useState(shareAudioByDefault);
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState<string | null>(null);
    // null = ainda verificando; so a tela inteira depende disso (janela usa o som do proprio processo)
    const [screenAudio, setScreenAudio] = useState<ScreenAudioState | null>(null);

    const load = async (first = false) => {
        setLoading(true);
        setLoadError(null);
        try {
            // listSources() resolves [] on failure and puts the reason in lastError
            const list = await listSources();
            setSources(list);
            if (!list.length) setLoadError(getState().lastError);
            if (first && !list.some(s => s.kind === "window")) setTab("screen");
            setSelectedId(id => list.some(s => s.id === id) ? id : null);
        } catch (e) {
            logger.error("listSources falhou", e);
            setLoadError(errorText(e));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => void load(true), []);

    useEffect(() => {
        let cancelled = false;
        getScreenAudioStatus()
            .catch((e): ScreenAudioState => ({ available: false, reason: errorText(e) }))
            .then(status => {
                if (!cancelled) setScreenAudio(status);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const screens = sources?.filter(s => s.kind === "screen") ?? [];
    const windows = sources?.filter(s => s.kind === "window") ?? [];
    const visible = tab === "screen" ? screens : windows;
    const selected = sources?.find(s => s.id === selectedId) ?? null;

    const audioKind: Kind = selected?.kind ?? tab;
    const screenAudioReady = screenAudioSupported && screenAudio?.available === true;
    const audioUnavailable = audioKind === "screen" && !screenAudioReady;
    let audioDescription = WINDOW_AUDIO_NOTE;
    if (audioKind === "screen") {
        if (screenAudioReady) audioDescription = SCREEN_AUDIO_NOTE;
        else if (!screenAudio) audioDescription = SCREEN_AUDIO_CHECKING;
        else audioDescription = `Sem som na tela inteira: ${screenAudio.reason || "o ajudante de áudio não está disponível"}. A tela vai só com imagem.`;
    }

    const start = async (source = selected) => {
        if (!source || starting) return;
        setStarting(true);
        setStartError(null);
        try {
            await startStreaming({ source, quality, withAudio: audio && (source.kind !== "screen" || screenAudioReady) });
            modalProps.onClose();
            showToast({ text: switching ? "Telinha: transmissão trocada" : "Telinha: transmissão iniciada", variant: "success" });
        } catch (e) {
            logger.error("startStreaming falhou", e);
            setStartError(errorText(e));
            setStarting(false);
        }
    };

    let body;
    if (!sources && loadError) {
        body = <Paragraph className={cl("empty")}>Não foi possível listar telas e janelas: {loadError}</Paragraph>;
    } else if (!sources) {
        body = <Paragraph className={cl("empty")}>Carregando telas e janelas…</Paragraph>;
    } else if (!visible.length) {
        body = (
            <Paragraph className={cl("empty")}>
                {tab === "screen" ? "Nenhuma tela encontrada." : "Nenhuma janela aberta encontrada."}
                {!sources.length && loadError && <><br />{loadError}</>}
            </Paragraph>
        );
    } else {
        body = (
            <div className={cl("grid")}>
                {visible.map(s => (
                    <SourceCard
                        key={s.id}
                        source={s}
                        selected={s.id === selectedId}
                        onSelect={() => setSelectedId(s.id)}
                        onConfirm={() => {
                            setSelectedId(s.id);
                            void start(s);
                        }}
                    />
                ))}
            </div>
        );
    }

    const tabButton = (kind: Kind, label: string, count: number) => (
        <button
            role="tab"
            aria-selected={tab === kind}
            className={cl("tab", tab === kind && "tab-active")}
            onClick={() => setTab(kind)}
        >
            {label}
            {sources && <span className={cl("tab-count")}>{count}</span>}
        </button>
    );

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={switching ? "Trocar o que você transmite" : "Transmitir com Telinha"}
            subtitle={switching
                ? "Quem está assistindo passa a ver a nova tela ou janela."
                : "Escolha o que seus amigos na call vão ver. A imagem vai direto do seu PC para o deles, sem servidor."}
            notice={startError ? { message: `Não foi possível começar a transmissão: ${startError}`, type: "critical" } : undefined}
            actions={[
                { text: starting ? "Iniciando…" : switching ? "Trocar" : "Transmitir", variant: "primary", onClick: () => void start(), disabled: !selected || starting, loading: starting },
                { text: "Cancelar", variant: "secondary", onClick: modalProps.onClose }
            ]}
        >
            <div className={cl("picker")}>
                <div className={cl("picker-top")}>
                    <div className={cl("tabs")} role="tablist">
                        {tabButton("screen", "Telas", screens.length)}
                        {tabButton("window", "Janelas", windows.length)}
                    </div>
                    <Button size="small" variant="secondary" disabled={loading} onClick={() => void load()}>
                        {loading ? "Atualizando…" : "Atualizar lista"}
                    </Button>
                </div>

                {body}

                <div className={cl("options")}>
                    <div className={cl("option-row")}>
                        <span className={cl("option-label")}>Qualidade</span>
                        <div className={cl("option-control")}>
                            <Select
                                options={QUALITY_OPTIONS}
                                isSelected={v => v === quality}
                                select={v => setQuality(v)}
                                serialize={v => String(v)}
                                closeOnSelect={true}
                            />
                        </div>
                    </div>
                    <FormSwitch
                        title="Compartilhar som"
                        description={audioDescription}
                        value={audio && !audioUnavailable}
                        disabled={audioUnavailable}
                        onChange={setAudio}
                        hideBorder
                    />
                </div>
            </div>
        </Modal>
    );
}

/** Opens the source picker. While streaming it switches the source (startStreaming() also does that). */
export function openSourcePicker() {
    const { local } = getState();
    if (!local && !inVoiceChannel()) {
        showToast({ text: "Telinha: entre num canal de voz para transmitir.", variant: "critical" });
        return;
    }

    openModal(props => (
        <ErrorBoundary>
            <SourcePickerModal modalProps={props} switching={!!local} initialQuality={local?.quality ?? defaultQuality()} />
        </ErrorBoundary>
    ));
}
