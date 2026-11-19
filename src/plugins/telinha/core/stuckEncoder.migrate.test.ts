/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// A migracao do registro do H.265/AV1 (core/stuckEncoder.ts → migrateHwOnlyRecords, no startLocalCaps): ate a v0.4.10 UMA
// falha no envio (o WebRTC trocou sozinho de codec) gravava o "travou" do H.265 de vez, e num Discord sem H.264 (1.0.9269)
// todo espectador novo ia para o VP9 por CPU. Agora a 1a falha so tira aquele espectador; o registro antigo de uma falha so
// (source "stream", sem `v`) e descartado uma vez, e o do PC do dono (live de 18/11) volta a usar o H.265 da placa depois
// da sonda. Ficam: o da sonda, o de um envio que travou, os com `v`, o "ok", e as chaves do H.264. Estado do modulo e do
// processo: a ordem importa.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.migrate.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getEventLog, type TelinhaEvent } from "@plugins/telinha/store";
import { eventually } from "@test/fakes/clock";
import { installNative, type NativeEnv } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { installWebRtc, rtpCapabilities, type WebRtcEnv } from "@test/fakes/webrtc";
import { type FakeWorker, healthyProbe, installWorker, type WorkerEnv } from "@test/fakes/worker";

import { chooseCodec, getLocalCaps } from "./codec";
import { ENCODER_PROBE_TIMING } from "./encoderProbe";
import { av1ProbeRecord, type EncoderEnv, h265ProbeRecord, highProbeRecord, HW_ONLY_RECORD_VERSION, migrateHwOnlyRecords, PROBE_START, probeRecord, startLocalCaps, stuckRecord } from "./stuckEncoder";

const NV_ENV: EncoderEnv = { vendorId: "10de", deviceId: "2484", driver: "32.0.16.2101", chrome: "152.0.7977.167", discord: "1.0.9269" };
const H265_SEND = "level-id=123;profile-id=1;tier-flag=0;tx-mode=SRST";
const CODEC = "hvc1.1.6.L123.B0";
const OK_DETAIL = "30 pacotes de 30 quadros";
const AT = new Date(2026, 10, 18, 20, 28).getTime();
const vcodec = (mimeType: string, sdpFmtpLine?: string): RTCRtpCodec => ({ mimeType, clockRate: 90000, ...(sdpFmtpLine ? { sdpFmtpLine } : {}) });
/** O sender do Discord 1.0.9269 no Windows: sem nenhum H.264. */
const SENDER = [vcodec("video/VP8"), vcodec("video/rtx"), vcodec("video/AV1", "level-idx=5;profile=0;tier=0"), vcodec("video/VP9", "profile-id=0"), vcodec("video/H265", H265_SEND)];
const RECEIVER = [vcodec("video/VP8"), vcodec("video/H264", "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f"), vcodec("video/VP9", "profile-id=0"), vcodec("video/H265", H265_SEND)];
const BOTH = { h264HwDecode: true, hwDecode: { v: 1, h264High: true, h265: true } };
/** O registro gravado no PC do dono em 18/11: uma falha so no envio (o WebRTC trocou o H.265 por VP9 ao subir para 1080p). */
const LEGACY = { at: AT, env: NV_ENV, verdict: "broken", detail: "o WebRTC trocou o H.265 por VP9 numa transmissão (theeux (abc123))", codec: CODEC, source: "stream" };

let rtc: WebRtcEnv;
let native: NativeEnv;
let workers: WorkerEnv | null = null;
const timing = { ...ENCODER_PROBE_TIMING };

function logMark() {
    const seen = new Set<TelinhaEvent>(getEventLog());
    return () => getEventLog().filter(e => !seen.has(e)).map(e => `${e.level}: ${e.msg}`);
}

const configOf = (w: FakeWorker) => (w.posted[0] as { config: Record<string, unknown>; }).config;

before(() => {
    rtc = installWebRtc();
    rtpCapabilities.sender = { ...rtpCapabilities.sender, video: SENDER };
    rtpCapabilities.receiver = { ...rtpCapabilities.receiver, video: RECEIVER };
    rtc.mediaCapabilities.hwEncode = ["h265"];
    rtc.mediaCapabilities.hwDecode = ["42001f", "h265"];
    native = installNative({
        gpuEnvironment: async () => ({ vendorId: 0x10de, deviceId: 0x2484, driverVersion: NV_ENV.driver, chrome: NV_ENV.chrome, discord: NV_ENV.discord, error: null })
    });
    pluginSettings.load({ codec: "auto", hwH265Probe: LEGACY });
    Object.assign(PROBE_START, { delayMs: 0, confirmMs: 0 });
    Object.assign(ENCODER_PROBE_TIMING, { configureMs: 40, noChunkMs: 60, flushMs: 60 });
});

after(() => {
    workers?.restore();
    Object.assign(ENCODER_PROBE_TIMING, timing);
    native.restore();
    rtc.restore();
});

describe("o registro antigo de uma falha so no envio", () => {
    test("o PC do dono (18/11, Discord sem H.264): no inicio da sessao o travou de uma falha so e descartado, a sonda do H.265 roda e o automatico volta ao H.265", async () => {
        workers = installWorker(healthyProbe());
        const since = logMark();
        const lines: string[] = [];
        await startLocalCaps(line => lines.push(line));
        await eventually(() => lines.length === 1);
        assert.ok(since().includes(`info: O H.265 da placa de vídeo estava desligado neste PC por uma falha só num envio (${LEGACY.detail}): agora uma falha tira só `
            + "aquele espectador, então o registro foi descartado e o H.265 volta a ser usado (a sonda dele roda de novo)"), since().join("\n"));
        assert.deepEqual(workers.instances.map(w => configOf(w).codec), [CODEC], "a sonda do H.265 rodou de novo");
        assert.deepEqual({ ...h265ProbeRecord()!, at: 0 }, { at: 0, env: NV_ENV, verdict: "ok", detail: OK_DETAIL, codec: CODEC });
        assert.equal((pluginSettings.get("hwH265Probe") as { v?: number; }).v, HW_ONLY_RECORD_VERSION, "o registro novo leva a versao");
        assert.equal(getLocalCaps().h265ProbeOk, true);
        assert.equal(chooseCodec(BOTH, "auto").codec, "h265");
        workers.restore();
        workers = null;
    });

    test("fica: o da sonda (com ou sem source), o de um envio que travou, os com versao, o ok, nada salvo; so a 1a chamada descarta", () => {
        const kept: Record<string, unknown>[] = [
            { ...LEGACY, source: "probe" },
            { at: AT, env: NV_ENV, verdict: "broken", detail: "confirmado na 2ª rodada", codec: CODEC },
            { ...LEGACY, detail: "o encoder da placa de vídeo travou numa transmissão em H.265" },
            // o envio parado do checkStall (o encoder sem soltar quadro) sempre gravou na hora: fica
            { ...LEGACY, detail: "O encoder H.265 para theeux (abc123) não codificou nenhum quadro em 8 s, com a conexão no ar e a captura entregando quadros (720 quadros da captura, 0 codificados), fora da placa de" },
            { ...LEGACY, verdict: "offHw", detail: "O AV1 para theeux (abc123) codificou quadros, mas nenhum saiu deste PC em 8 s, com a conexão no ar" },
            { ...LEGACY, v: HW_ONLY_RECORD_VERSION },
            { ...LEGACY, verdict: "ok" },
            { ...LEGACY, verdict: "unknown" }
        ];
        for (const record of kept) {
            pluginSettings.set("hwH265Probe", record);
            assert.deepEqual(migrateHwOnlyRecords(), [], JSON.stringify(record));
            assert.deepEqual(pluginSettings.get("hwH265Probe"), record, JSON.stringify(record));
        }
        pluginSettings.set("hwH265Probe", null);
        assert.deepEqual(migrateHwOnlyRecords(), []);

        pluginSettings.set("hwH265Probe", LEGACY);
        assert.deepEqual(migrateHwOnlyRecords(), ["h265"]);
        assert.equal(h265ProbeRecord(), null);
        assert.deepEqual(migrateHwOnlyRecords(), [], "ja descartado");
    });

    test("o AV1: o saiu da placa (offHw) e o travou de uma falha so tambem saem; sem detalhe, o log diz 'sem detalhe'", () => {
        pluginSettings.set("hwAv1Probe", { at: AT, env: NV_ENV, verdict: "offHw", detail: "AV1 saiu da placa (libaom) p/ X: 1920x1080", codec: "av01.0.05M.08", source: "stream" });
        pluginSettings.set("hwH265Probe", { ...LEGACY, detail: 42 });
        const since = logMark();
        assert.deepEqual(migrateHwOnlyRecords(), ["h265", "av1"]);
        assert.equal(av1ProbeRecord(), null);
        assert.equal(h265ProbeRecord(), null);
        const lines = since();
        assert.ok(lines.some(l => l.startsWith("info: O H.265 da placa de vídeo estava desligado neste PC por uma falha só num envio (sem detalhe)")), lines.join("\n"));
        assert.ok(lines.some(l => l.startsWith("info: O AV1 da placa de vídeo estava desligado neste PC por uma falha só num envio (AV1 saiu da placa (libaom) p/ X: 1920x1080): ")
            && l.endsWith("o AV1 volta a ser usado (a sonda dele roda de novo)")), lines.join("\n"));
    });

    test("nunca toca no H.264: o travamento do Baseline, a sonda dele e o travou do High (mesmo de um envio) ficam", () => {
        const stuck = { at: AT, env: NV_ENV, source: "stream" };
        const baseline = { at: AT, env: NV_ENV, verdict: "broken", detail: "x" };
        const high = { at: AT, env: NV_ENV, verdict: "broken", detail: "o encoder da placa de vídeo travou numa transmissão em High", profile: "640032", source: "stream" };
        pluginSettings.set("stuckHwH264", stuck);
        pluginSettings.set("hwH264Probe", baseline);
        pluginSettings.set("hwH264HighProbe", high);
        assert.deepEqual(migrateHwOnlyRecords(), []);
        assert.deepEqual(pluginSettings.get("stuckHwH264"), stuck);
        assert.equal(stuckRecord()?.at, AT);
        assert.equal(probeRecord()?.verdict, "broken");
        assert.equal(highProbeRecord()?.verdict, "broken");
        for (const key of ["stuckHwH264", "hwH264Probe", "hwH264HighProbe"]) pluginSettings.set(key, null);
    });
});
