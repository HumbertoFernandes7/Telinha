/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PROCESSO MAIN SOMENTE (Linux): importado apenas pelo screenAudioMain.ts.
//
// Audio do PC sem o Discord pelo PipeWire, sem ajudante proprio: as ferramentas pw-* do sistema (no Flatpak do Discord,
// as do runtime freedesktop; o Flatpak do Discord ja fala com o PipeWire por xdg-run/pipewire-0). O loopback do Chromium
// no Linux e o monitor da saida padrao, onde a voz da call tambem toca; por isso a mistura e feita aqui:
// - pw-record abre um no de captura que nada liga sozinho (node.autoconnect=false) e escreve no stdout o mesmo PCM do
//   telinha-audio.exe (float32 48 kHz estereo); node.always-process faz ele mandar silencio quando nada toca;
// - pw-dump --monitor conta cada objeto do PipeWire que aparece, muda ou some (arrays JSON um atras do outro);
// - pw-link liga as portas de saida de cada fluxo que toca (Stream/Output/Audio) as entradas desse no, MENOS as do
//   Discord (a voz da call, os sons do Discord, uma live que ele mostra). As ligacoes morrem com o no ou com o fluxo.
//
// Nada roda no carregamento do modulo.

import { type ChildProcessWithoutNullStreams, spawn } from "child_process";

import { SCREEN_AUDIO_CHANNELS, SCREEN_AUDIO_RATE } from "./types";

export const PW_RECORD = "pw-record";
export const PW_DUMP = "pw-dump";
export const PW_LINK = "pw-link";

/** O Discord (binario, nome do app ou app id do Flatpak): nunca vai para a transmissao. */
const DISCORD_RE = /discord/i;
const DISCORD_PROPS = ["application.process.binary", "application.name", "pipewire.access.portal.app_id"];

/** Para onde vai cada canal de um fluxo (o no do Telinha e estereo). shortcut: o LFE fica de fora; ninguem pediu 5.1. */
const CHANNEL_MAP: Record<string, readonly ("FL" | "FR")[]> = {
    FL: ["FL"], FR: ["FR"], MONO: ["FL", "FR"], FC: ["FL", "FR"], RL: ["FL"], SL: ["FL"], RR: ["FR"], SR: ["FR"]
};

/** Um objeto do pw-dump; `info: null` = o objeto sumiu. */
export interface PwObject {
    id: number;
    type?: string;
    info?: { direction?: string; props?: Record<string, unknown>; } | null;
}

/** Argumentos do pw-record: PCM cru no stdout, no formato do contrato (types.ts), num no que nada liga sozinho. */
export function pwRecordArgs(nodeName: string): string[] {
    return [
        "--raw", "--target", "0", "--format", "f32", "--rate", String(SCREEN_AUDIO_RATE), "--channels", String(SCREEN_AUDIO_CHANNELS),
        "-P", `{ node.name = "${nodeName}" node.description = "Telinha" node.autoconnect = false node.always-process = true }`,
        "-"
    ];
}

/** Por que uma ferramenta pw-* nao abriu, em pt-BR. */
export function pipeWireSpawnReason(e: NodeJS.ErrnoException, tool: string) {
    if (e?.code === "ENOENT") return `as ferramentas do PipeWire (${PW_RECORD}, ${PW_DUMP} e ${PW_LINK}) não estão instaladas (faltou o ${tool})`;
    return `não foi possível abrir o ${tool}: ${e?.code ?? ""} ${e?.message ?? String(e)}`.trim();
}

/** Por que o pw-record (ou o pw-dump da sonda) saiu, em pt-BR; `lastLine` = a ultima linha do stderr dele. */
export function pipeWireExitReason(code: number | null, signal: NodeJS.Signals | null, lastLine: string | null): string {
    const why = lastLine ? ` — ${lastLine}` : "";
    if (signal) return "a captura de áudio do PipeWire foi encerrada";
    return `a captura de áudio do PipeWire parou (código ${code ?? "?"}${why})`;
}

/** Junta o texto do pw-dump --monitor (arrays JSON um atras do outro, em pedacos) e devolve cada array completo. Lanca se vier JSON ruim. */
export function jsonArraySplitter(): (chunk: string) => unknown[] {
    let buf = "";
    let pos = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    return chunk => {
        buf += chunk;
        const out: unknown[] = [];
        for (; pos < buf.length; pos++) {
            const c = buf[pos];
            if (inString) {
                if (escaped) escaped = false;
                else if (c === "\\") escaped = true;
                else if (c === "\"") inString = false;
            } else if (c === "\"") inString = true;
            else if (c === "[" || c === "{") depth++;
            else if ((c === "]" || c === "}") && --depth === 0) {
                out.push(JSON.parse(buf.slice(0, pos + 1)));
                buf = buf.slice(pos + 1);
                pos = -1;
            }
        }
        return out;
    };
}

function isDiscord(props: Record<string, unknown>) {
    return DISCORD_PROPS.some(k => typeof props[k] === "string" && DISCORD_RE.test(props[k] as string));
}

/**
 * As ligacoes [porta de saida, porta de entrada] que o no `nodeName` precisa agora: cada saida de cada fluxo que toca,
 * menos o Discord. null = o no ainda nao apareceu com as duas entradas (FL e FR).
 */
export function plannedLinks(objects: Iterable<PwObject>, nodeName: string): [number, number][] | null {
    const nodes = new Map<number, Record<string, unknown>>();
    const ports: { id: number; direction?: string; props: Record<string, unknown>; }[] = [];
    for (const o of objects) {
        const props = o.info?.props;
        if (!props) continue;
        if (o.type === "PipeWire:Interface:Node") nodes.set(o.id, props);
        else if (o.type === "PipeWire:Interface:Port") ports.push({ id: o.id, direction: o.info!.direction, props });
    }
    const own = [...nodes].find(([, p]) => p["node.name"] === nodeName)?.[0];
    const inputs: Record<string, number> = {};
    for (const p of ports) if (own !== undefined && p.props["node.id"] === own && p.direction === "input") inputs[String(p.props["audio.channel"])] = p.id;
    if (inputs.FL === undefined || inputs.FR === undefined) return null;

    const links: [number, number][] = [];
    for (const p of ports) {
        if (p.direction !== "output") continue;
        const node = nodes.get(p.props["node.id"] as number);
        if (node?.["media.class"] !== "Stream/Output/Audio" || isDiscord(node)) continue;
        for (const ch of CHANNEL_MAP[String(p.props["audio.channel"])] ?? []) links.push([p.id, inputs[ch]]);
    }
    return links;
}

export interface PipeWireLinker {
    stop(): void;
}

/**
 * Acompanha o PipeWire (pw-dump --monitor) e liga cada fluxo que toca, menos o Discord, ao no `nodeName`. `onReady`: o no
 * apareceu (uma vez). `onFail`: o acompanhamento parou (o pw-dump saiu ou faltam as ferramentas); depois disso nada mais
 * e chamado. Nunca lanca.
 */
export function startPipeWireLinks(nodeName: string, events: { onReady(): void; onFail(reason: string): void; }): PipeWireLinker {
    const objects = new Map<number, PwObject>();
    const requested = new Set<string>();
    const split = jsonArraySplitter();
    let ready = false;
    let stopped = false;
    let dump: ChildProcessWithoutNullStreams | null = null;

    const stop = () => {
        stopped = true;
        try {
            dump?.kill();
        } catch { }
    };
    const fail = (reason: string) => {
        if (stopped) return;
        stop();
        events.onFail(reason);
    };

    const link = (out: number, input: number) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(PW_LINK, [String(out), String(input)], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
            fail(pipeWireSpawnReason(e as NodeJS.ErrnoException, PW_LINK));
            return;
        }
        // uma ligacao que falha (o fluxo sumiu no meio) nao derruba nada; so a falta do pw-link derruba
        child.on("error", e => {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") fail(pipeWireSpawnReason(e, PW_LINK));
        });
        child.stdin.on("error", () => { });
        child.stdout.on("error", () => { });
        child.stderr.on("error", () => { });
        child.stdout.resume();
        child.stderr.resume();
        child.stdin.end();
    };

    const onBatch = (batch: unknown) => {
        if (!Array.isArray(batch)) return;
        for (const o of batch as PwObject[]) {
            if (typeof o?.id !== "number") continue;
            if (o.info !== null) {
                objects.set(o.id, o);
                continue;
            }
            // o id pode voltar para outro objeto: esquece as ligacoes pedidas com ele
            objects.delete(o.id);
            for (const key of requested) if (key.startsWith(`${o.id}:`) || key.endsWith(`:${o.id}`)) requested.delete(key);
        }
    };

    try {
        dump = spawn(PW_DUMP, ["--monitor", "--no-colors"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
        const reason = pipeWireSpawnReason(e as NodeJS.ErrnoException, PW_DUMP);
        queueMicrotask(() => fail(reason));
        return { stop };
    }
    dump.on("error", e => fail(pipeWireSpawnReason(e, PW_DUMP)));
    dump.on("exit", code => fail(`o PipeWire parou de avisar os fluxos de áudio (${PW_DUMP} saiu com código ${code ?? "?"})`));
    dump.stdin.on("error", () => { });
    dump.stdout.on("error", () => { });
    dump.stderr.on("error", () => { });
    dump.stderr.resume();
    dump.stdout.setEncoding("utf8");
    dump.stdout.on("data", (text: string) => {
        if (stopped) return;
        try {
            split(text).forEach(onBatch);
        } catch {
            fail(`o ${PW_DUMP} mandou uma lista ilegível`);
            return;
        }
        const links = plannedLinks(objects.values(), nodeName);
        if (!links) return;
        for (const [out, input] of links) {
            const key = `${out}:${input}`;
            if (requested.has(key)) continue;
            requested.add(key);
            link(out, input);
            if (stopped) return;
        }
        if (!ready) {
            ready = true;
            events.onReady();
        }
    });

    return { stop };
}
