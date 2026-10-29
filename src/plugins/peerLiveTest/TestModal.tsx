/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useRef } from "@webpack/common";
import type { ReactNode } from "react";

import { openPopoutForRun, refreshSources, runPathBTest, selectSource, setListenAudio, setOptions, setPopoutStrategy, startRun, stopRun, testAllStrategies, testDecodeStartupByCodec } from "./runner";
import { errorText, getNative, getState, logError, TestState, useTestState } from "./state";
import { DEFAULT_STRATEGY, STRATEGY_LABELS, STRATEGY_SHORT, TEST_ALL_ORDER } from "./strategies";
import type { CaptureSourceInfo, CodecChoice, PopoutStrategy, StrategyResult } from "./types";

const cl = classNameFactory("vc-plt-");

const hw = (v: boolean | null | undefined) => v == null ? "?" : v ? "hardware" : "software";
const res = (w: number | null | undefined, h: number | null | undefined) => w && h ? `${w}x${h}` : "?";
const mbps = (kbps: number | null | undefined) => kbps == null ? "?" : `${(kbps / 1000).toFixed(2)} Mbps`;
const yesNo = (v: boolean | null | undefined) => v == null ? "?" : v ? "sim" : "não";

interface SegOption<T> {
    value: T;
    label: string;
    title?: string;
    disabled?: boolean;
}

function Segmented<T extends string | number>({ label, value, options, onChange, disabled }: {
    label: string;
    value: T;
    options: SegOption<T>[];
    onChange(value: T): void;
    disabled?: boolean;
}) {
    return (
        <div className={cl("option-row")}>
            <span className={cl("option-label")}>{label}</span>
            <div className={cl("segmented")}>
                {options.map(o => (
                    <Button
                        key={String(o.value)}
                        size="small"
                        variant={o.value === value ? "primary" : "secondary"}
                        disabled={disabled || o.disabled}
                        title={o.title}
                        onClick={() => onChange(o.value)}
                    >
                        {o.label}
                    </Button>
                ))}
            </div>
        </div>
    );
}

function Row({ label, children }: { label: string; children: ReactNode; }) {
    return (
        <div className={cl("row")}>
            <span className={cl("row-label")}>{label}</span>
            <span className={cl("row-value")}>{children}</span>
        </div>
    );
}

function SourceCard({ source, selected, disabled }: { source: CaptureSourceInfo; selected: boolean; disabled: boolean; }) {
    return (
        <button
            className={classes(cl("source"), selected && cl("source-selected"))}
            disabled={disabled}
            title={source.id}
            onClick={() => selectSource(source.id)}
        >
            {source.thumbnail
                ? <img className={cl("thumb")} src={source.thumbnail} alt="" />
                : <div className={classes(cl("thumb"), cl("thumb-empty"))}>sem miniatura</div>}
            <span className={cl("source-name")}>{source.name}</span>
        </button>
    );
}

function SourcePicker({ s }: { s: TestState; }) {
    const locked = s.phase !== "idle";
    const screens = s.sources.filter(x => x.kind === "screen");
    const windows = s.sources.filter(x => x.kind === "window");

    return (
        <section className={cl("section")}>
            <div className={cl("section-header")}>
                <HeadingTertiary>1. Fonte</HeadingTertiary>
                <Button size="small" variant="secondary" disabled={s.loadingSources || locked} onClick={() => void refreshSources()}>
                    {s.loadingSources ? "Carregando…" : "Atualizar lista"}
                </Button>
            </div>
            <Paragraph className={cl("muted")}>
                Listado via: {s.sourcesVia ?? "?"}{s.sourcesError ? ` (erro: ${s.sourcesError})` : ""}
            </Paragraph>

            {screens.length > 0 && <div className={cl("group-label")}>Telas</div>}
            <div className={cl("grid")}>
                {screens.map(src => <SourceCard key={src.id} source={src} selected={src.id === s.selectedSourceId} disabled={locked} />)}
            </div>

            {windows.length > 0 && <div className={cl("group-label")}>Janelas</div>}
            <div className={cl("grid")}>
                {windows.map(src => <SourceCard key={src.id} source={src} selected={src.id === s.selectedSourceId} disabled={locked} />)}
            </div>

            {!s.loadingSources && !s.sources.length && <Paragraph>Nenhuma fonte encontrada. Veja o log abaixo.</Paragraph>}
        </section>
    );
}

const STRATEGY_ORDER: PopoutStrategy[] = ["direct", "realm", "canvas", "trackProcessor", "control"];

const CODECS: { value: CodecChoice; label: string; }[] = [
    { value: "H264", label: "H.264" },
    { value: "VP8", label: "VP8" },
    { value: "VP9", label: "VP9" },
    { value: "AV1", label: "AV1" },
    { value: "H265", label: "H.265" }
];

function OptionsPanel({ s }: { s: TestState; }) {
    const o = s.options;
    const locked = s.phase !== "idle";
    const codecAvailable = (c: CodecChoice) =>
        !s.availableVideoCodecs.length || s.availableVideoCodecs.some(x => x.toLowerCase().startsWith(`video/${c.toLowerCase()}`));

    let audioText: string;
    if (!s.selectedSourceId) audioText = "selecione uma fonte";
    else if (s.resolvingAudio) audioText = "descobrindo o processo da janela…";
    else if (s.audioResolution) audioText = `${s.audioResolution.device ?? "nenhum"}: ${s.audioResolution.decision}`;
    else audioText = "?";

    return (
        <section className={cl("section")}>
            <HeadingTertiary>2. Opções</HeadingTertiary>
            <Segmented
                label="Resolução"
                value={o.resolution}
                disabled={locked}
                onChange={resolution => setOptions({ resolution })}
                options={[{ value: "720p", label: "720p" }, { value: "1080p", label: "1080p" }, { value: "1440p", label: "1440p" }]}
            />
            <Segmented
                label="FPS"
                value={o.fps}
                disabled={locked}
                onChange={fps => setOptions({ fps })}
                options={[{ value: 30, label: "30" }, { value: 60, label: "60" }]}
            />
            <Segmented
                label="Bitrate máx."
                value={o.maxBitrateMbps}
                disabled={locked}
                onChange={maxBitrateMbps => setOptions({ maxBitrateMbps })}
                options={[4, 6, 10, 15, 20, 30].map(v => ({ value: v, label: `${v} Mbps` }))}
            />
            <Segmented
                label="Áudio"
                value={o.audioMode}
                disabled={locked}
                onChange={audioMode => setOptions({ audioMode })}
                options={[
                    { value: "none", label: "Nenhum" },
                    { value: "auto", label: "Automático", title: "Janela: applicationLoopback:<pid> (só o app). Tela: loopbackWithoutChrome." },
                    { value: "loopback", label: "Forçar loopback", title: "Todo o áudio do sistema" },
                    { value: "loopbackWithoutChrome", label: "Forçar loopbackWithoutChrome", title: "Sistema menos o áudio do Chromium" }
                ]}
            />
            <Segmented
                label="Codec"
                value={o.codec}
                disabled={locked}
                onChange={codec => setOptions({ codec })}
                options={CODECS.map(c => ({ ...c, disabled: !codecAvailable(c.value), title: codecAvailable(c.value) ? undefined : "Indisponível neste Chromium" }))}
            />
            <Segmented
                label="Duração"
                value={o.durationSec}
                disabled={locked}
                onChange={durationSec => setOptions({ durationSec })}
                options={[{ value: 20, label: "20 s" }, { value: 60, label: "60 s" }, { value: 0, label: "Até parar" }]}
            />
            <Row label="Dispositivo de áudio">{audioText}</Row>
            <FormSwitch
                title="Bitrate inicial alto"
                description="Coloca x-google-start-bitrate / x-google-max-bitrate na resposta SDP, para o teste não gastar segundos subindo a banda."
                value={o.startBitrateHint}
                disabled={locked}
                onChange={startBitrateHint => setOptions({ startBitrateHint })}
            />
            <FormSwitch
                title="Abrir a janela flutuante ao iniciar"
                value={o.autoPopout}
                disabled={locked}
                onChange={autoPopout => setOptions({ autoPopout })}
            />
            <Segmented
                label="Estratégia da janela"
                value={o.popoutStrategy}
                disabled={!!s.longTest}
                onChange={setPopoutStrategy}
                options={STRATEGY_ORDER.map(value => ({
                    value,
                    label: value === DEFAULT_STRATEGY ? `${STRATEGY_SHORT[value]} (padrão)` : STRATEGY_SHORT[value],
                    title: STRATEGY_LABELS[value]
                }))}
            />
            <Paragraph className={cl("muted")}>
                {STRATEGY_LABELS[o.popoutStrategy]}. Pode ser trocada durante o teste: vale ao clicar em "Abrir janela flutuante" de novo.
            </Paragraph>
        </section>
    );
}

function Controls({ s }: { s: TestState; }) {
    const phaseText = {
        idle: "parado",
        starting: "iniciando…",
        running: `rodando: ${s.elapsedSec} s${s.options.durationSec ? ` de ${s.options.durationSec} s` : ""}`,
        stopping: "finalizando (caminho alternativo + JSON)…"
    }[s.phase];
    const busy = !!s.longTest;
    const canSequence = !busy && (s.phase === "running" || (s.phase === "idle" && !!s.selectedSourceId && !s.resolvingAudio));

    return (
        <section className={cl("section")}>
            <HeadingTertiary>3. Teste ({phaseText})</HeadingTertiary>
            <Paragraph className={cl("muted")}>
                Deixe um vídeo ou jogo em movimento e com som na fonte escolhida: a captura de tela só gera quadros quando a imagem muda.
            </Paragraph>
            <div className={cl("buttons")}>
                <Button variant="positive" disabled={s.phase !== "idle" || !s.selectedSourceId || s.resolvingAudio} onClick={() => void startRun()}>
                    Iniciar teste
                </Button>
                <Button variant="dangerPrimary" disabled={s.phase !== "running" && s.phase !== "starting"} onClick={() => void stopRun()}>
                    Parar
                </Button>
                <Button variant="secondary" disabled={s.phase !== "running" || busy} onClick={() => void openPopoutForRun()}>
                    Abrir janela flutuante
                </Button>
                <Button variant="primary" disabled={!canSequence} onClick={() => void testAllStrategies()}>
                    Testar todas as estratégias de janela
                </Button>
                <Button variant="secondary" disabled={!canSequence} onClick={() => void testDecodeStartupByCodec()}>
                    Testar início da decodificação por codec
                </Button>
                <Button variant="secondary" disabled={s.pathBRunning || !s.selectedSourceId || s.phase === "starting" || s.phase === "stopping"} onClick={() => void runPathBTest()}>
                    {s.pathBRunning ? "Testando caminho alternativo…" : "Testar caminho alternativo"}
                </Button>
            </div>
            {s.longTest && (
                <Paragraph>
                    Em andamento ({s.longTest.kind}): {s.longTest.step}
                </Paragraph>
            )}
            <Paragraph className={cl("muted")}>
                "Testar todas" mede {TEST_ALL_ORDER.map(x => STRATEGY_SHORT[x]).join(" → ")} por 8 s cada (depois do 1º quadro) na captura atual; se o teste estiver parado, inicia um com a fonte selecionada e salva o JSON no fim.
                "Por codec" cria um receptor novo para VP8, VP9, AV1 e H.264 (com e sem bitrate inicial alto), sem player, e mede quanto o decodificador demora para soltar o 1º quadro.
            </Paragraph>
            <FormSwitch
                title="Ouvir áudio recebido"
                description="Atenção: tocar o áudio capturado nos alto-falantes faz ele ser capturado de novo (eco/microfonia). Desligado por padrão; use fones."
                value={s.listenAudio}
                onChange={setListenAudio}
                hideBorder
            />
        </section>
    );
}

function LiveStats({ s }: { s: TestState; }) {
    const x = s.lastSample;

    return (
        <section className={cl("section")}>
            <HeadingTertiary>Estatísticas ao vivo</HeadingTertiary>
            {!x
                ? <Paragraph className={cl("muted")}>Sem amostras ainda.</Paragraph>
                : (
                    <div className={cl("table")}>
                        <Row label="Captura (media-source)">{x.source ? `${res(x.source.width, x.source.height)} @ ${x.source.fps ?? "?"} fps` : "?"}</Row>
                        <Row label="Enviado">
                            {x.send ? `${res(x.send.width, x.send.height)} @ ${x.send.fps ?? "?"} fps · ${mbps(x.send.bitrateKbps)} (alvo ${mbps(x.send.targetBitrateKbps)}, banda estimada ${mbps(x.send.availableOutgoingKbps)}) · ${x.send.codec ?? "?"}` : "?"}
                        </Row>
                        <Row label="Encoder">
                            {x.send ? `${x.send.encoderImplementation ?? "?"} (${hw(x.send.powerEfficientEncoder)}) · limitação: ${x.send.qualityLimitationReason ?? "?"} · ${x.send.avgEncodeMs ?? "?"} ms/quadro` : "?"}
                        </Row>
                        <Row label="Recebido">
                            {x.recv ? `${res(x.recv.width, x.recv.height)} @ ${x.recv.fps ?? "?"} fps${x.recv.decodeStalled ? " · SEM DECODIFICAR" : ""} · ${mbps(x.recv.bitrateKbps)} · decodificados ${x.recv.framesDecoded ?? "?"} · descartados ${x.recv.framesDropped ?? "?"} · PLIs ${x.recv.pliSent ?? "?"} · congelamentos ${x.recv.freezeCount ?? "?"}` : "?"}
                        </Row>
                        <Row label="Decoder">
                            {x.recv ? `${x.recv.decoderImplementation ?? "?"} (${hw(x.recv.powerEfficientDecoder)}) · ${x.recv.avgDecodeMs ?? "?"} ms/quadro · jitter buffer ${x.recv.jitterBufferMs ?? "?"} ms` : "?"}
                        </Row>
                        <Row label="Áudio">
                            {x.audio.trackPresent
                                ? `captura ${x.audio.captureRmsDb ?? "?"} dBFS (pico ${x.audio.capturePeak ?? "?"}) · recebido ${x.audio.receivedRmsDb ?? "?"} dBFS · nível stats ${x.audio.statsCaptureLevel ?? "?"} / ${x.audio.statsReceivedLevel ?? "?"} · ${x.audio.sendBitrateKbps ?? "?"} kbps`
                                : "sem faixa de áudio"}
                        </Row>
                        <Row label="CPU do Discord">
                            {x.cpu
                                ? `${x.cpu.totalPercentCPU}% de 1 núcleo (${x.cpu.normalizedPercentCPU}% da máquina, ${x.cpu.cpuCount} núcleos) · ${Object.entries(x.cpu.byType).map(([k, v]) => `${k} ${v}%`).join(" · ")}`
                                : "?"}
                        </Row>
                        <Row label="Janela">
                            {s.sinkLive ? `${s.sinkLive.strategy}: exibindo ${s.sinkLive.fps ?? "?"} fps (${s.sinkLive.width}x${s.sinkLive.height})` : s.activeStrategy ? `${s.activeStrategy}: aguardando quadros` : "fechada"}
                        </Row>
                    </div>
                )}
        </section>
    );
}

function strategyText(r: StrategyResult) {
    const w = r.window;
    const m = r.measurement;
    return [
        r.verdict,
        r.host ? `em "${r.host}"` : null,
        m?.missedFrames ? `${m.missedFrames} quadros perdidos pelo rVFC` : null,
        m?.avgDrawMs != null ? `drawImage ${m.avgDrawMs} ms` : null,
        w ? `recebido ${w.recvAvgFps ?? "?"} fps` : null,
        w ? `CPU ${w.cpuAvgPercentOneCore ?? "?"}% de 1 núcleo` : null,
        r.freshReceiver ? `receptor novo #${r.loopbackId} (${r.receiverRealm})` : null
    ].filter(Boolean).join(" · ");
}

function StrategyRows({ s }: { s: TestState; }) {
    const latest = new Map<PopoutStrategy, StrategyResult>();
    for (const r of s.strategyResults) latest.set(r.strategy, r);
    if (!latest.size) return <Row label="Estratégias de janela">nenhuma medida ainda</Row>;

    return (
        <>
            {[...latest.values()].map(r => <Row key={r.strategy} label={`Janela: ${STRATEGY_SHORT[r.strategy]}`}>{strategyText(r)}</Row>)}
            {s.testAll && <Row label="Melhor estratégia de pop-out">{s.testAll.best ?? "nenhuma confirmou reprodução"}</Row>}
        </>
    );
}

function DecodeRows({ s }: { s: TestState; }) {
    return (
        <>
            {s.decodeStartups.map(d => (
                <Row key={d.loopbackId} label={`Receptor #${d.loopbackId} (${d.receiverRealm})`}>
                    {d.firstDecodedMs != null ? `1º quadro decodificado em ${d.firstDecodedMs} ms` : d.aborted ? "substituído antes de decodificar" : "não decodificou"}
                    {` · ${d.decoderImplementation ?? "?"} · ${d.pliSent ?? "?"} PLIs · ${d.framesDropped ?? "?"} descartados · ${d.reason}`}
                </Row>
            ))}
            {s.codecProbe?.entries.map((e, i) => (
                <Row key={i} label={`Codec ${e.codec}${e.startBitrateHint ? "" : " (sem bitrate inicial)"}`}>
                    {e.error
                        ? `erro: ${e.error}`
                        : `1º quadro ${e.startup?.firstDecodedMs ?? "nunca"} ms (${e.startup?.pliSent ?? "?"} PLIs) · ${e.window?.recvAvgFps ?? "?"} fps recebidos · ${e.window?.encoders.join(", ") || "?"} → ${e.window?.decoders.join(", ") || "?"} · CPU ${e.window?.cpuAvgPercentOneCore ?? "?"}% de 1 núcleo`}
                </Row>
            ))}
        </>
    );
}

function Results({ s }: { s: TestState; }) {
    const { pathA, pathB, summary } = s;
    const videoSettings = pathA?.videoSettings as MediaTrackSettings | null | undefined;

    const showInFolder = async () => {
        try {
            if (s.resultPath) await getNative().showResultInFolder(s.resultPath);
        } catch (e) {
            logError("Falha ao abrir a pasta", errorText(e));
        }
    };

    return (
        <section className={cl("section")}>
            <HeadingTertiary>Resultados</HeadingTertiary>
            <div className={cl("table")}>
                <Row label="Caminho A (getDisplayMedia)">
                    {!pathA ? "não testado"
                        : pathA.ok
                            ? `OK em ${pathA.getDisplayMediaMs} ms · ${res(videoSettings?.width, videoSettings?.height)} @ ${videoSettings?.frameRate ?? "?"} fps · áudio: ${pathA.audioTrackPresent ? "sim" : "não"} · handler: ${pathA.handlerEvent ? `respondeu áudio ${pathA.handlerEvent.answered?.audio ?? "nenhum"}` : "não chamado"}`
                            : `FALHOU: ${pathA.error} · handler: ${pathA.handlerEvent ? (pathA.handlerEvent.error ?? "chamado") : "não chamado"}`}
                </Row>
                <Row label="Caminho B (getUserMedia legado)">
                    {!pathB ? "não testado" : pathB.ok ? `OK em ${pathB.getUserMediaMs} ms · ${pathB.playback?.measuredFps ?? "?"} fps medidos` : `FALHOU: ${pathB.error}`}
                </Row>
                <StrategyRows s={s} />
                {s.fullscreen && <Row label="Tela cheia">{s.fullscreen.ok ? "OK" : s.fullscreen.error}</Row>}
                <DecodeRows s={s} />
                {summary && (
                    <>
                        <Row label="Resolução alvo atingida">{yesNo(summary.verdict.reachedTargetResolution)} ({Object.keys(summary.send.resolutions).join(", ") || "?"})</Row>
                        <Row label="FPS alvo atingido">{yesNo(summary.verdict.reachedTargetFps)} (média {summary.send.avgFps ?? "?"} fps enviados, {summary.recv.avgFps ?? "?"} recebidos; {summary.recv.avgFpsWhileDecoding ?? "?"} só com o decodificador ativo)</Row>
                        <Row label="Encoder / decoder em hardware">{yesNo(summary.verdict.hardwareEncoder)} / {yesNo(summary.verdict.hardwareDecoder)} ({summary.send.encoderImplementations.join(", ") || "?"})</Row>
                        <Row label="Áudio com sinal">{yesNo(summary.verdict.audioSignalDetected)} ({summary.audio.secondsWithSignal} s, média {summary.audio.captureRmsAvgDb ?? "?"} dBFS)</Row>
                        <Row label="CPU média do Discord">{summary.cpu.avgTotalPercent ?? "?"}% de 1 núcleo ({summary.cpu.avgNormalizedPercent ?? "?"}% da máquina)</Row>
                        {summary.verdict.notes.map((n, i) => <Row key={i} label="Observação">{n}</Row>)}
                    </>
                )}
                <Row label="Arquivo JSON">
                    {s.resultPath
                        ? <>
                            <code className={cl("path")}>{s.resultPath}</code>{" "}
                            <Button size="small" variant="secondary" onClick={() => void showInFolder()}>Mostrar na pasta</Button>
                        </>
                        : s.resultError ? `erro ao salvar: ${s.resultError}` : "gerado ao final do teste"}
                </Row>
            </div>
        </section>
    );
}

function LogPanel({ logs }: { logs: string[]; }) {
    const ref = useRef<HTMLPreElement>(null);

    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, [logs]);

    return (
        <section className={cl("section")}>
            <HeadingTertiary>Log (também no console com o prefixo [PeerLive Test])</HeadingTertiary>
            <pre ref={ref} className={cl("log")}>{logs.join("\n") || "vazio"}</pre>
        </section>
    );
}

function TestModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const s = useTestState();

    useEffect(() => {
        const { sources, loadingSources } = getState();
        if (!sources.length && !loadingSources) void refreshSources();
    }, []);

    return (
        <Modal
            {...modalProps}
            size="xl"
            title="PeerLive: autoteste de captura"
            subtitle="Captura de tela/janela com áudio, codificação local 1080p60 (WebRTC) e exibição numa janela flutuante do Discord. Fechar este modal não para o teste."
            actions={[{ text: "Fechar", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div className={cl("root")}>
                <SourcePicker s={s} />
                <OptionsPanel s={s} />
                <Controls s={s} />
                <LiveStats s={s} />
                <Results s={s} />
                <LogPanel logs={s.logs} />
            </div>
        </Modal>
    );
}

export function openTestModal() {
    openModal(props => (
        <ErrorBoundary>
            <TestModal modalProps={props} />
        </ErrorBoundary>
    ));
}
