/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Roda o PCM_PLAYER_SOURCE (o AudioWorkletProcessor de core/audio/worklet.ts, que no Discord vai como texto para um
// blob:/data: URL) num node:vm com o que o AudioWorkletGlobalScope tem: AudioWorkletProcessor, registerProcessor,
// sampleRate e currentFrame. O teste empurra PCM pela porta (como o renderer) e chama process() quantum a quantum
// (128 frames, como o motor de audio). ArrayBuffer/Float32Array sao os do proprio Node para o `instanceof` do
// processador reconhecer o que o teste manda.

import vm from "node:vm";

import { PCM_PLAYER_SOURCE } from "@plugins/telinha/core/audio/worklet";

import { pcm } from "./wpd-audio";

export const QUANTUM = 128;

/** O que o teste ve do processador (os campos sao os do worklet.ts: leitura apenas). */
export interface PlayerInternals {
    target: number;
    maxTarget: number;
    step: number;
    excess: number;
    count: number;
    underruns: number;
    dropped: number;
    received: number;
    priming: boolean;
    ratio: number;
    alive: boolean;
    ema: number;
    rd: number;
    w: number;
}

export interface Player {
    /** nome com que o worklet se registrou */
    readonly registeredName: string;
    readonly node: PlayerInternals;
    /** mensagens que o processador postou para o renderer (stats) */
    readonly posted: Record<string, unknown>[];
    /** currentFrame atual (avanca 128 por quantum) */
    frame: number;
    /** entrega uma mensagem ao processador, como o port.postMessage do renderer */
    send(data: unknown): void;
    /** manda `frames` frames de PCM (L = first + k, R = -(first + k)) */
    push(frames: number, first?: number): void;
    /** um quantum de process(): devolve o que saiu, o retorno e os canais passados */
    process(opts?: { channels?: number; size?: number; fill?: number; }): { left: Float32Array; right: Float32Array | null; alive: boolean; };
}

export function loadPlayer(opts: { sampleRate?: number; options?: unknown; noOptions?: boolean; } = {}): Player {
    const sampleRate = opts.sampleRate ?? 48000;
    const posted: Record<string, unknown>[] = [];
    let registered: { name: string; ctor: new (options?: unknown) => unknown; } | null = null;

    class AudioWorkletProcessor {
        port = {
            onmessage: null as ((e: { data: unknown; }) => void) | null,
            postMessage: (data: Record<string, unknown>) => {
                posted.push(data);
            }
        };
    }

    const sandbox: Record<string, unknown> = {
        AudioWorkletProcessor,
        registerProcessor: (name: string, ctor: new (options?: unknown) => unknown) => {
            registered = { name, ctor };
        },
        sampleRate,
        currentFrame: 0,
        ArrayBuffer,
        Float32Array,
        Math,
        Number
    };
    vm.createContext(sandbox);
    new vm.Script(PCM_PLAYER_SOURCE, { filename: "telinha-pcm-player.js" }).runInContext(sandbox);
    if (!registered) throw new Error("o worklet nao chamou registerProcessor");
    const { name, ctor } = registered as { name: string; ctor: new (options?: unknown) => unknown; };
    const node = (opts.noOptions ? new ctor() : new ctor({ processorOptions: opts.options })) as PlayerInternals & {
        port: AudioWorkletProcessor["port"];
        process(inputs: unknown[], outputs: Float32Array[][]): boolean;
    };

    const player: Player = {
        registeredName: name,
        node,
        posted,
        frame: 0,
        send(data) {
            node.port.onmessage?.({ data });
        },
        push(frames, first = 1) {
            const bytes = pcm(frames, first);
            player.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        },
        process({ channels = 2, size = QUANTUM, fill = 9 } = {}) {
            const out = Array.from({ length: channels }, () => new Float32Array(size).fill(fill));
            sandbox.currentFrame = player.frame;
            const alive = node.process([], [out]);
            player.frame += size;
            return { left: out[0], right: out[1] ?? null, alive };
        }
    };
    return player;
}

/** Chama process() `quanta` vezes e junta o canal esquerdo (e o numero de silencios). */
export function playQuanta(player: Player, quanta: number): { left: number[]; silent: number; } {
    const left: number[] = [];
    let silent = 0;
    for (let i = 0; i < quanta; i++) {
        const out = player.process();
        if (out.left.every(v => v === 0)) silent++;
        for (const v of out.left) left.push(v);
    }
    return { left, silent };
}
