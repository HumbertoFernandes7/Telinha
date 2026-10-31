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
import { eventually } from "@test/fakes/clock";
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
    Object.assign(PROBE_START, { delayMs: 0, confirmMs: 0 });
    Object.assign(ENCODER_PROBE_TIMING, { configureMs: 40, noChunkMs: 60, flushMs: 60 });
});

after(() => {
    workers?.restore();
    Object.assign(ENCODER_PROBE_TIMING, timing);
    native.restore();
    rtc.restore();
});

/** O detalhe do 31/10 nos prazos curtos deste arquivo. */
const STUCK_DETAIL = "nenhum pacote em 0.06 s desde o 1º quadro (o flush() não terminou)";

/** Um Worker por rodada: o roteiro `scripts[n]` na n-esima (o ultimo vale para as seguintes). */
function workersFor(...scripts: NonNullable<WorkerEnv["script"]>[]) {
    let n = 0;
    return installWorker((w, data) => scripts[Math.min(n++, scripts.length - 1)](w, data));
}

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

    test("\"Tentar a placa de vídeo de novo\": esquece o travamento E a sonda, e o H.264 so volta depois de a sonda responder", async () => {
        pluginSettings.set("hwH264Probe", { at: STUCK_AT, env: AMD_ENV, verdict: "broken", detail: "x" });
        workers = installWorker(healthyProbe(30));
        const since = logMark();
        assert.equal(forgetStuckEncoder(), "testing");
        assert.equal(stuckRecord(), null);
        assert.equal(pluginSettings.get("stuckHwH264"), null);
        assert.equal(getLocalCaps().h264HwEncode, false, "testando: ainda VP9");
        await eventually(() => probeRecord()?.verdict === "ok");
        await flush();
        assert.equal(getLocalCaps().h264HwEncode, true, "a sonda respondeu: o H.264 volta");
        assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "h264");
        assert.equal(workers.instances.length, 1);
        assert.deepEqual(since(), ["info: Você pediu para tentar o H.264 da placa de vídeo de novo: testando a placa agora (sonda WebCodecs); o H.264 só volta se ela não travar no teste"]);
        workers.restore();

        // sem Worker (nenhuma sonda possivel): volta ja, como antes
        pluginSettings.set("stuckHwH264", { at: STUCK_AT, env: AMD_ENV });
        assert.equal(forgetStuckEncoder(), "now");
        assert.equal(probeRecord(), null, "o resultado da sonda tambem foi esquecido");
        assert.equal(getLocalCaps().h264HwEncode, true);
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

    test("inconclusiva (a placa nao aceita o perfil): nada muda, e nada fica salvo (roda de novo na proxima abertura)", async () => {
        pluginSettings.set("hwH264Probe", null);
        workers = installWorker(w => w.emit({ ev: "done", verdict: "unsupported" }));
        await runStartupProbe(AMD_ENV, "42001f");
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.equal(stuckRecord(), null);
        assert.equal(probeRecord(), null);
        assert.ok(stuckEncoderDiagnostics().includes("sonda WebCodecs H.264 placa: inconclusiva (sem suporte: a placa não aceita avc1.42001f)"));
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
        assert.equal(probeRecord(), null, "nada salvo");
        assert.ok(stuckEncoderDiagnostics().includes("sonda WebCodecs H.264 placa: não feita (uma transmissão estava começando ou no ar"));
        workers.restore();
    });

    test("travou na 1a rodada e passou na 2a (a placa so estava ocupada): nada marcado, o H.264 continua", async () => {
        workers = workersFor(stuckProbe(), healthyProbe(30));
        await runStartupProbe(AMD_ENV, "42001f");
        assert.equal(workers.instances.length, 2, "a 2a rodada confirma");
        assert.equal(workers.instances[0].terminated, false, "o preso da 1a fica");
        assert.equal(stuckRecord(), null);
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.deepEqual({ ...probeRecord()!, at: 0 }, { at: 0, env: AMD_ENV, verdict: "ok", detail: `30 pacotes de 30 quadros (a 1ª rodada tinha travado: ${STUCK_DETAIL})` });
        workers.restore();
    });

    test("travou e uma transmissao comecou antes da confirmacao: VP9 so nesta sessao, nada salvo", async () => {
        pluginSettings.set("hwH264Probe", null);
        workers = installWorker((w, data) => {
            stuckProbe()(w, data);
            noteStreamStarting(true);
        });
        try {
            await runStartupProbe(AMD_ENV, "42001f");
        } finally {
            noteStreamStarting(false);
        }
        assert.equal(workers.instances.length, 1);
        assert.equal(getLocalCaps().h264HwEncode, false, "VP9 nesta sessao");
        assert.equal(stuckRecord(), null, "nada salvo");
        assert.equal(probeRecord(), null);
        assert.ok(stuckEncoderDiagnostics().includes(`sonda WebCodecs H.264 placa: travou uma vez (${STUCK_DETAIL}), sem confirmar (uma transmissão começou): VP9 nesta sessão`));
        workers.restore();
        assert.equal(forgetStuckEncoder(), "now", "sem Worker agora: volta ja");
    });

    test("travou e a 2a rodada fica presa no isConfigSupported (o driver travado pelo encoder da 1a): confirmado, fica salvo", async () => {
        workers = workersFor(stuckProbe(), w => w.emit({ ev: "phase", phase: "isConfigSupported" }));
        await runStartupProbe(AMD_ENV, "42001f");
        assert.deepEqual(workers.instances.map(w => w.terminated), [false, false], "os dois presos ficam");
        assert.equal(stuckRecord()?.source, "probe");
        assert.deepEqual({ ...probeRecord()!, at: 0 }, { at: 0, env: AMD_ENV, verdict: "broken", detail: "isConfigSupported sem resposta em 0.04 s; confirmado na 2ª rodada" });
        assert.equal(getLocalCaps().h264HwEncode, false);
        workers.restore();
        assert.equal(forgetStuckEncoder(), "now");
    });

    test("travou e a 2a rodada e inconclusiva sem nada preso: nao confirma nem libera (VP9 nesta sessao, nada salvo)", async () => {
        workers = workersFor(stuckProbe(), w => w.emit({ ev: "done", verdict: "unsupported" }));
        await runStartupProbe(AMD_ENV, "42001f");
        assert.equal(workers.instances.length, 2);
        assert.equal(getLocalCaps().h264HwEncode, false, "VP9 nesta sessao");
        assert.equal(stuckRecord(), null, "nada salvo");
        assert.equal(probeRecord(), null);
        assert.ok(stuckEncoderDiagnostics().includes(`sonda WebCodecs H.264 placa: travou uma vez (${STUCK_DETAIL}); a 2ª rodada não conseguiu dizer `
            + "(sem suporte: a placa não aceita avc1.42001f): VP9 nesta sessão"));
        workers.restore();
        assert.equal(forgetStuckEncoder(), "now");
    });

    test("travou duas vezes (o 31/10 no navegador): marca o PC antes de qualquer transmissao, e os Workers presos ficam (nunca terminados)", async () => {
        workers = installWorker(stuckProbe());
        const since = logMark();
        await runStartupProbe(AMD_ENV, "42001f");
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "vp9", "a 1a transmissao ja vai em VP9");
        const record = stuckRecord()!;
        assert.equal(record.source, "probe");
        assert.deepEqual(record.env, AMD_ENV);
        assert.equal(probeRecord()?.verdict, "broken");
        assert.equal(probeRecord()?.detail, `${STUCK_DETAIL}; confirmado na 2ª rodada`);
        assert.deepEqual(workers.instances.map(w => w.terminated), [false, false]);
        const hung = `warn: Sonda WebCodecs do H.264 da placa de vídeo: o encoder ficou preso (${STUCK_DETAIL}); o Worker dela fica como está até o Discord fechar`;
        assert.deepEqual(since(), [
            hung,
            `info: Sonda WebCodecs do H.264 da placa de vídeo: travou (${STUCK_DETAIL}); confirmando em 0 s`,
            hung,
            `warn: A sonda WebCodecs mostrou que o H.264 da placa de vídeo trava neste PC (${STUCK_DETAIL}; confirmado na 2ª rodada): `
            + "o automático vai em VP9, sem criar o encoder H.264 da placa, até o driver, o Chromium ou a placa mudarem"
        ]);
        assert.ok(stuckEncoderDiagnostics().includes("[visto pela sonda]"));
        assert.equal(stuckInThisSession(), false);
        workers.restore();
    });

    test("travamento salvo de outro driver: a sonda deste ambiente dizendo ok esquece; inconclusiva mantem o VP9", async () => {
        const newDriver = { ...AMD_ENV, driver: "32.0.21013.1000" };
        pluginSettings.set("stuckHwH264", { at: STUCK_AT, env: AMD_ENV });
        pluginSettings.set("hwH264Probe", null);
        workers = installWorker(w => w.emit({ ev: "done", verdict: "unsupported" }));
        const since = logMark();
        await runStartupProbe(newDriver, "42001f");
        assert.ok(stuckRecord(), "inconclusiva: continua lembrado");
        assert.equal(probeRecord(), null, "e a inconclusiva nao fica salva: a sonda roda de novo na proxima abertura");
        assert.equal(getLocalCaps().h264HwEncode, false);
        assert.ok(since().some(l => l.endsWith("mas a sonda deste ambiente não confirmou que ela funciona (inconclusiva): continua em VP9")));
        workers.restore();

        workers = installWorker(healthyProbe(30));
        await runStartupProbe(newDriver, "42001f");
        assert.equal(stuckRecord(), null, "ok: esquecido");
        assert.equal(getLocalCaps().h264HwEncode, true);
        assert.ok(since().some(l => l.endsWith("e a sonda deste ambiente passou: o automático volta a tentar o H.264 da placa de vídeo")));
        workers.restore();
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
        assert.equal(forgetStuckEncoder(), "restart");
        assert.equal(stuckRecord(), null, "esquecido para a proxima sessao (a sonda roda ao abrir)");
        assert.equal(getLocalCaps().h264HwEncode, false, "nesta sessao continua VP9 (ha um envio travado)");
        assert.deepEqual(since(), ["info: Você pediu para tentar o H.264 da placa de vídeo de novo: a placa é testada de novo quando o Discord reiniciar"]);
    });
});

describe("ambiente e registros salvos", () => {
    test("envChanges: so o que e conhecido dos dois lados e diferente (o Discord nao conta; o Chromium so pela versao principal)", () => {
        const unknown: EncoderEnv = { vendorId: null, deviceId: null, driver: null, chrome: null, discord: null };
        assert.deepEqual(envChanges(AMD_ENV, AMD_ENV), []);
        assert.deepEqual(envChanges(AMD_ENV, unknown), [], "desconhecido e curinga: continua lembrando");
        assert.deepEqual(envChanges(unknown, AMD_ENV), []);
        assert.deepEqual(envChanges(AMD_ENV, { ...AMD_ENV, discord: "1.0.9300", chrome: "152.0.7500.10" }), [], "Discord novo e o mesmo Chromium 152");
        assert.deepEqual(envChanges(AMD_ENV, { ...AMD_ENV, driver: "32.0.21013.1000", chrome: "153.0.7600.1" }), [
            "driver da placa de vídeo 32.0.21001.9024 → 32.0.21013.1000",
            "Chromium 152.0.7444.59 → 153.0.7600.1"
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
