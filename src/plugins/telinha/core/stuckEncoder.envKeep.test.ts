/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do inicio da sessao (core/stuckEncoder.ts → startLocalCaps) com um travamento salvo num driver antigo e nenhuma
// sonda possivel neste ambiente (sem Worker): o ambiente mudou, mas nada confirmou que a placa funciona, entao o
// travamento continua valendo (VP9). E a sonda de codecs corre junto com a leitura do ambiente (o main lento nao atrasa
// as capacidades), com o H.264 automatico esperando o ambiente. Um processo so para isto: o inicio roda uma vez por sessao.
// Rodar:  pnpm test:file src/plugins/telinha/core/stuckEncoder.envKeep.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { getEventLog } from "@plugins/telinha/store";
import { installNative } from "@test/fakes/native";
import { pluginSettings } from "@test/fakes/vencord";
import { installWebRtc } from "@test/fakes/webrtc";

import { chooseCodec, getLocalCaps } from "./codec";
import { startLocalCaps, stuckRecord } from "./stuckEncoder";

const rtc = installWebRtc();
let answerEnv: (env: unknown) => void = () => { };
const native = installNative({ gpuEnvironment: () => new Promise(resolve => (answerEnv = resolve)) });

after(() => {
    native.restore();
    rtc.restore();
});

const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

test("driver novo e nenhuma sonda possivel: o travamento continua (VP9); a sonda de codecs nao espera o ambiente", async () => {
    rtc.mediaCapabilities.hwEncode = ["42001f"];
    rtc.mediaCapabilities.hwDecode = ["42001f"];
    const at = new Date(2026, 9, 31, 2, 54).getTime();
    pluginSettings.load({ stuckHwH264: { at, env: { vendorId: "1002", deviceId: "7550", driver: "32.0.21001.9024", chrome: "152.0.7444.59", discord: "1.0.9266" } } });
    const lines: string[] = [];
    const start = startLocalCaps(line => lines.push(line));
    await flush();
    assert.ok(rtc.mediaCapabilities.calls.length > 0, "a sonda de codecs ja rodou com o main ainda sem responder");
    assert.equal(getLocalCaps().h264HwProfile, "42001f");
    assert.equal(getLocalCaps().h264HwEncode, false, "o H.264 automatico espera o ambiente");

    answerEnv({ vendorId: 0x1002, deviceId: 0x7550, driverVersion: "32.0.21013.1000", chrome: "152.0.7444.80", discord: "1.0.9300", error: null });
    await start;
    assert.ok(stuckRecord(), "continua lembrado");
    assert.equal(getLocalCaps().h264HwEncode, false);
    assert.equal(chooseCodec({ h264HwDecode: true }, "auto").codec, "vp9");
    assert.ok(getEventLog().some(e => e.msg === "A placa de vídeo tinha travado com H.264 neste PC em 31/10; o ambiente mudou "
        + "(driver da placa de vídeo 32.0.21001.9024 → 32.0.21013.1000), mas a sonda deste ambiente não confirmou que ela funciona (inconclusiva): continua em VP9"));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith("; sonda WebCodecs H.264 placa: não feita (sem Worker); H.264 automático desligado: a placa de vídeo travou com H.264 neste PC em 31/10 (usando VP9)"), lines[0]);
});
