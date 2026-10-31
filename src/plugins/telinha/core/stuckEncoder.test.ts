/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes de "cada PC aprende sozinho" (core/stuckEncoder.ts): o travamento da placa de video com H.264 fica salvo nas
// configuracoes com o ambiente (placa ativa, driver, Chromium, Discord, lidos do main por gpuEnvironment). No mesmo
// ambiente o automatico comeca em VP9 (o fixado continua H.264); o botao esquece; um travamento nesta sessao desliga ja e
// so volta depois de reiniciar. A sonda WebCodecs (runStartupProbe, sobre um Worker falso): ok e inconclusiva nao mudam
// nada, travou marca o PC, e com uma transmissao comecando ela nao roda. Estado do modulo e do processo: a ordem importa.
// A mudanca de ambiente (esquece sozinho, a sonda so roda uma vez por ambiente) fica em stuckEncoder.envChange.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { settings } from "@plugins/telinha/settings";
import { getEventLog, type TelinhaEvent } from "@plugins/telinha/store";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { installWebRtc, type WebRtcEnv } from "@test/fakes/webrtc";
import { healthyProbe, installWorker, stuckProbe, type WorkerEnv } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import {
    describeEnv, type EncoderEnv, envChanges, forgetStuckEncoder, measureEnvironment, noteStreamStarting, noteStuckEncoder, PROBE_START, probeRecord, runStartupProbe,
    startLocalCaps, stuckEncoderDiagnostics, stuckInThisSession, stuckLine, stuckRecord
} from "./stuckEncoder";

/** O PC do amigo em 31/10: Radeon RX 9070 XT. */
const AMD_ENV: EncoderEnv = { vendorId: "1002", deviceId: "7550", driver: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266" };
const STUCK_AT = new Date(2026, 9, 31, 2, 54).getTime();

let rtc: WebRtcEnv;
let native: NativeEnv;
let workers: WorkerEnv | null = null;
const timing = { ...ENCODER_PROBE_TIMING };

function logMark() {
    const seen = new Set<TelinhaEvent>(getEventLog());
    return () => getEventLog().filter(e => !seen.has(e)).map(e => `${e.level}: ${e.msg}`);
}

const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

before(() => {
    rtc = installWebRtc();
    rtc.mediaCapabilities.hwEncode = ["42001f"];
    rtc.mediaCapabilities.hwDecode = ["42001f"];
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266", error: null })
    });
    pluginSettings.load({ stuckHwH264: { at: STUCK_AT, env: { ...AMD_ENV }, source: "stream" } });
    PROBE_START.delayMs = 0;
    ENCODER_PROBE_TIMING.configureMs = 40;
    ENCODER_PROBE_TIMING.encodeMs = 60;
});

after(() => {
    workers?.restore();
    Object.assign(ENCODER_PROBE_TIMING, timing);
    native.restore();
    rtc.restore();
});

describe("placa de video que trava com H.264: lembrada neste PC", () => {
    test("o mesmo ambiente: o automatico ja comeca em VP9 (o fixado continua H.264), sem rodar a sonda; a linha das capacidades diz tudo", async () => {
        workers = installWorker(healthyProbe());
        const lines: string[] = [];
        await startLocalCaps(line => lines.push(line));
        const caps = getLocalCaps();
        assert.equal(caps.h264HwProfile, "42001f", "a sonda de codecs mediu a placa");
        assert.equal(caps.h264HwEncode, false, "mas o automatico trata o H.264 da placa como indisponivel");
        assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "vp9");
        assert.equal(chooseCodec({ h264HwDecode: true }, "h264").codec, "h264", "fixado continua fixado");
        assert.equal(workers.instances.length, 0, "a placa ja travou neste PC: a sonda nao precisa rodar");
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^Capacidades locais: H\.264 por hardware — decodifica: sim, codifica: sim \(perfil 42001f\); envia: /);
        assert.ok(lines[0].endsWith("; placa de vídeo 1002:7550, driver 32.0.21001.9024; Chromium 152.0.7444.59; Discord 1.0.9266; "
            + "sonda WebCodecs H.264 placa: não feita (a placa já travou neste PC); "
            + "H.264 automático desligado: a placa de vídeo travou com H.264 neste PC em 31/10 (usando VP9)"), lines[0]);
        assert.deepEqual(native.calls.filter(c => c.name === "gpuEnvironment").length, 1);
        await startLocalCaps(line => lines.push(line));
        assert.equal(lines.length, 1, "uma vez por sessao do Discord");
        workers.restore();
        workers = null;
    });

    test("a linha da pagina do plugin e o diagnostico", () => {
        const record = stuckRecord()!;
        assert.equal(stuckLine(record), "A placa de vídeo travou com H.264 neste PC em 31/10; usando VP9.");
        const diag = stuckEncoderDiagnostics().split("\n");
        assert.deepEqual(diag.slice(0, 3), [
            "ambiente do encoder: placa de vídeo 1002:7550, driver 32.0.21001.9024; Chromium 152.0.7444.59; Discord 1.0.9266 (placa via main)",
            `H.264 da placa travado neste PC: em ${new Date(STUCK_AT).toISOString()} (placa de vídeo 1002:7550, driver 32.0.21001.9024; Chromium 152.0.7444.59; Discord 1.0.9266); H.264 automático desligado`,
            "travou nesta sessão: não"
        ]);
        assert.equal(diag[3], "sonda WebCodecs H.264 placa: não feita (a placa já travou neste PC)");
    });

    test("\"Tentar a placa de vídeo de novo\" sem nada travado nesta sessao: esquece e o H.264 automatico volta ja", () => {
        const since = logMark();
        assert.equal(forgetStuckEncoder(), true);
        assert.equal(stuckRecord(), null);
        assert.equal(pluginSettings.get("stuckHwH264"), null);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "h264");
        assert.deepEqual(since(), ["info: Você pediu para tentar o H.264 da placa de vídeo de novo: vale a partir da próxima pessoa que assistir"]);
    });
});

describe("sonda WebCodecs (runStartupProbe)", () => {
    test("ok: enquanto roda o automatico vai de VP9; depois, nada muda (o resultado fica salvo com o ambiente)", async () => {
        workers = installWorker(healthyProbe(30));
        const run = runStartupProbe(AMD_ENV, "42001f");
        assert.equal(getLocalCaps().h264HwEncode, false, "durante a sonda: VP9");
        await run;
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(stuckRecord(), null);
        assert.deepEqual({ ...probeRecord()!, at: 0 }, { at: 0, env: AMD_ENV, verdict: "ok", detail: "30 pacotes de 30 quadros" });
        assert.equal(workers.instances[0].terminated, true);
        assert.ok(stuckEncoderDiagnostics().includes("sonda WebCodecs H.264 placa: ok (30 pacotes de 30 quadros); salva: ok em "));
        workers.restore();
    });

    test("inconclusiva (a placa nao aceita o perfil): nada muda", async () => {
        workers = installWorker(w => w.emit({ ev: "done", verdict: "unsupported" }));
        await runStartupProbe(AMD_ENV, "42001f");
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(stuckRecord(), null);
        assert.equal(probeRecord()?.verdict, "unknown");
        workers.restore();
    });

    test("uma transmissao comecando: a sonda nao roda (fica para a proxima vez) e a trava sai", async () => {
        workers = installWorker(stuckProbe());
        noteStreamStarting(true);
        try {
            await runStartupProbe(AMD_ENV, "42001f");
        } finally {
            noteStreamStarting(false);
        }
        assert.equal(workers.instances.length, 0);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(probeRecord()?.verdict, "unknown", "o resultado salvo nao mudou");
        assert.ok(stuckEncoderDiagnostics().includes("sonda WebCodecs H.264 placa: não feita (uma transmissão estava começando ou no ar"));
        workers.restore();
    });

    test("travou (o 31/10 no navegador): marca o PC antes de qualquer transmissao, e o Worker preso fica (nunca terminado)", async () => {
        workers = installWorker(stuckProbe());
        const since = logMark();
        await runStartupProbe(AMD_ENV, "42001f");
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "vp9", "a 1a transmissao ja vai em VP9");
        const record = stuckRecord()!;
        assert.equal(record.source, "probe");
        assert.deepEqual(record.env, AMD_ENV);
        assert.equal(probeRecord()?.verdict, "broken");
        assert.equal(workers.instances[0].terminated, false);
        assert.deepEqual(since(), [
            "warn: Sonda WebCodecs do H.264 da placa de vídeo: o encoder ficou preso (nenhum pacote em 0.06 s (o flush() não terminou)); o Worker dela fica como está até o Discord fechar",
            "warn: A sonda WebCodecs mostrou que o H.264 da placa de vídeo trava neste PC (nenhum pacote em 0.06 s (o flush() não terminou)): "
            + "o automático vai em VP9, sem criar o encoder H.264 da placa, até o driver, o Discord ou a placa mudarem"
        ]);
        assert.ok(stuckEncoderDiagnostics().includes("[visto pela sonda]"));
        assert.equal(stuckInThisSession(), false, "nenhum envio travou: o botao vale ja");
        assert.equal(forgetStuckEncoder(), true);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(probeRecord()?.verdict, "broken", "o botao nao apaga a sonda: ela nao roda de novo neste ambiente");
    });
});

describe("travou numa transmissao nesta sessao", () => {
    test("desliga o H.264 automatico ja, lembra com o ambiente, e o botao so vale depois de reiniciar", async () => {
        noteStuckEncoder();
        assert.equal(getLocalCaps().h264HwEncode, false);
        await flush();
        const record = stuckRecord()!;
        assert.deepEqual(record.env, AMD_ENV);
        assert.equal(record.source, undefined, "visto numa transmissao");
        assert.ok(Math.abs(record.at - Date.now()) < 5000);
        assert.equal(stuckInThisSession(), true);
        assert.ok(stuckEncoderDiagnostics().includes("travou nesta sessão: sim (0 conexões contidas)"));

        const since = logMark();
        assert.equal(forgetStuckEncoder(), false);
        assert.equal(stuckRecord(), null, "esquecido para a proxima sessao");
        assert.equal(getLocalCaps().h264HwEncode, false, "nesta sessao continua VP9 (ha um envio travado)");
        assert.deepEqual(since(), ["info: Você pediu para tentar o H.264 da placa de vídeo de novo: vale depois que você reiniciar o Discord"]);
    });
});

describe("ambiente e registros salvos", () => {
    test("envChanges: so o que e conhecido dos dois lados e diferente; describeEnv com o desconhecido em \"?\"", () => {
        const unknown: EncoderEnv = { vendorId: null, deviceId: null, driver: null, chrome: null, discord: null };
        assert.deepEqual(envChanges(AMD_ENV, AMD_ENV), []);
        assert.deepEqual(envChanges(AMD_ENV, unknown), [], "desconhecido e curinga: continua lembrando");
        assert.deepEqual(envChanges(unknown, AMD_ENV), []);
        assert.deepEqual(envChanges(AMD_ENV, { ...AMD_ENV, driver: "32.0.21013.1000", discord: "1.0.9300" }), [
            "driver da placa de vídeo 32.0.21001.9024 → 32.0.21013.1000",
            "Discord 1.0.9266 → 1.0.9300"
        ]);
        assert.deepEqual(envChanges(AMD_ENV, { ...AMD_ENV, vendorId: "10de", deviceId: "2484" }), ["fabricante da placa de vídeo 1002 → 10de", "placa de vídeo 7550 → 2484"]);
        assert.equal(describeEnv(unknown), "placa de vídeo ?:?, driver ?; Chromium ?; Discord ?");
    });

    test("registros estragados nas configuracoes viram \"nenhum\"; campos estranhos do ambiente ficam de fora", () => {
        for (const bad of [null, "x", 5, {}, { at: "ontem" }, { at: Number.NaN }]) {
            pluginSettings.set("stuckHwH264", bad);
            pluginSettings.set("hwH264Probe", bad);
            assert.equal(stuckRecord(), null, JSON.stringify(bad));
            assert.equal(probeRecord(), null, JSON.stringify(bad));
        }
        pluginSettings.set("stuckHwH264", { at: 1, env: { vendorId: 4098, driver: "  31.0  ", evil: "x" } });
        assert.deepEqual(stuckRecord(), { at: 1, env: { vendorId: null, deviceId: null, driver: "31.0", chrome: null, discord: null } });
        pluginSettings.set("stuckHwH264", { at: 1, env: "x" });
        assert.deepEqual(stuckRecord()?.env, { vendorId: null, deviceId: null, driver: null, chrome: null, discord: null });
        pluginSettings.set("hwH264Probe", { at: 1, env: {}, verdict: "talvez" });
        assert.equal(probeRecord(), null, "veredito desconhecido");
        pluginSettings.set("hwH264Probe", { at: 1, env: {}, verdict: "ok" });
        assert.equal(probeRecord()?.detail, "");
    });

    test("o diagnostico avisa quando o ambiente mudou desde o travamento salvo", () => {
        pluginSettings.set("stuckHwH264", { at: STUCK_AT, env: { ...AMD_ENV, driver: "31.0.1" } });
        assert.ok(stuckEncoderDiagnostics().includes("driver 31.0.1; Chromium 152.0.7444.59; Discord 1.0.9266) — o ambiente mudou desde então"));
        pluginSettings.set("stuckHwH264", null);
    });

    test("nao deu para salvar nas configuracoes: so um aviso no log (nunca lanca no meio do travamento)", () => {
        const plain = settings.plain as Record<string, unknown>;
        Object.defineProperty(plain, "stuckHwH264", {
            configurable: true,
            get: () => undefined,
            set: () => {
                throw new Error("disco cheio");
            }
        });
        const since = logMark();
        try {
            forgetStuckEncoder();
        } finally {
            delete plain.stuckHwH264;
        }
        assert.ok(since().includes("warn: Não deu para salvar nas configurações que a placa de vídeo travou: Error: disco cheio"));
    });
});

describe("leitura do ambiente (measureEnvironment)", () => {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const gpu = (requestAdapter: () => unknown) => Object.defineProperty(nav, "gpu", { configurable: true, value: { requestAdapter } });

    after(() => {
        delete nav.gpu;
        delete nav.userAgent;
    });

    test("o main manda lixo ou um motivo: placa desconhecida; sem WebGPU; Chromium e Discord pelo userAgent", async () => {
        Object.defineProperty(nav, "userAgent", { configurable: true, value: "Mozilla/5.0 (Windows NT 10.0) Chrome/152.0.7444.59 discord/1.0.9266 Electron/44.9.3" });
        native.restore();
        native = installNative({ gpuEnvironment: async () => ({ vendorId: "x", deviceId: 70_000, driverVersion: 5, chrome: null, discord: null, error: "getGPUInfo sem gpuDevice" }) });
        assert.deepEqual(await measureEnvironment(), { vendorId: null, deviceId: null, driver: null, chrome: "152.0.7444.59", discord: "1.0.9266" });
        assert.ok(stuckEncoderDiagnostics().includes("(placa via getGPUInfo sem gpuDevice; sem WebGPU)"));
    });

    test("o main nao responde ou lanca; sem a funcao nativa (Discord nao reiniciado depois da atualizacao)", async () => {
        native.restore();
        native = installNative({ gpuEnvironment: async () => null });
        await measureEnvironment();
        assert.ok(stuckEncoderDiagnostics().includes("(placa via o processo main não respondeu; sem WebGPU)"));

        native.restore();
        native = installNative({
            gpuEnvironment: async () => {
                throw new Error("No handler registered");
            }
        });
        await measureEnvironment();
        assert.ok(stuckEncoderDiagnostics().includes("(placa via Error: No handler registered; sem WebGPU)"));

        native.restore();
        native = installNative();
        await measureEnvironment();
        assert.ok(stuckEncoderDiagnostics().includes("(placa via parte nativa sem gpuEnvironment (Discord ainda não reiniciado depois da atualização); sem WebGPU)"));
    });

    test("WebGPU como plano B: fabricante pelo nome (ou o nome cru), device id quando vem, nada sem fabricante, erro", async () => {
        gpu(async () => ({ info: { vendor: "Qualcomm", device: "0x73DF" } }));
        assert.deepEqual(await measureEnvironment(), { vendorId: "5143", deviceId: "73df", driver: null, chrome: "152.0.7444.59", discord: "1.0.9266" });
        assert.ok(stuckEncoderDiagnostics().includes("(placa via webgpu)"));

        gpu(async () => ({ info: { vendor: "acme", device: "" } }));
        assert.equal((await measureEnvironment()).vendorId, "acme");

        gpu(async () => ({ info: { vendor: "" } }));
        await measureEnvironment();
        assert.ok(stuckEncoderDiagnostics().includes("sem WebGPU)"));

        gpu(() => {
            throw new Error("WebGPU desligado");
        });
        await measureEnvironment();
        assert.ok(stuckEncoderDiagnostics().includes("; WebGPU: Error: WebGPU desligado)"));
    });
});
