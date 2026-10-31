/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do log de estatisticas do envio dentro da qualidade automatica (core/quality/controller.ts + core/statsLog.ts):
// uma linha por espectador a cada 10 s, com as mesmas leituras de 2 s (nenhum getStats a mais), mais uma linha logo
// depois de cada troca de degrau, e o resumo quando o espectador para ou a transmissao acaba. So log: as decisoes ficam
// nos outros testes do controller. A conta e o texto das linhas ficam em core/statsLog.test.ts.
// Rodar:  pnpm test:file src/plugins/telinha/core/quality/controller.stats.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { STATS_LINE_RE } from "@plugins/telinha/core/statsLog";
import { useFakeClock } from "@test/fakes/clock";
import { EncoderSim, installWebRtc, type LinkRates, type WebRtcEnv } from "@test/fakes/webrtc";
import { logsDuring, qualityHarness, qualityLines } from "@test/helpers/wpb-quality";

import { BW_GRACE_MS } from "./levels";

/** A rede do exemplo do pedido: 0,8% de perda, 34 ms de RTT, 40 kbps de retransmissao, 3 ms no pacer. */
const LINK: LinkRates = { targetKbps: 1800, rtxKbps: 40, lossPct: 0.8, rttMs: 34, jitterMs: 6, naksPerSecond: 1.2, plisPerSecond: 0, keyframesPerSecond: 0, qp: 34, pacerMs: 3 };

const statsLines = (lines: string[]) => lines.filter(l => STATS_LINE_RE.test(l));

let rtc: WebRtcEnv;
before(() => {
    rtc = installWebRtc({ hardwareConcurrency: 8 });
});
after(() => rtc.restore());

test("sem espectador: nenhuma linha em 60 s, nem ao acabar", async t => {
    const clock = useFakeClock(t);
    const h = qualityHarness(clock);
    assert.deepEqual(await logsDuring(() => h.runUntil(60_000)), []);
    assert.deepEqual(await logsDuring(() => h.controller.dispose()), []);
});

test("um espectador: uma linha a cada 10 s com as leituras de 2 s (nenhum getStats a mais) e o resumo quando ele para", async t => {
    const clock = useFakeClock(t);
    const sim = new EncoderSim({ fps: 30, sourceFps: 59, width: 1280, height: 720, kbps: 1650, encodeBusy: 0.276, link: LINK });
    const h = qualityHarness(clock, { leo: sim }, { enabled: () => false });
    await h.join("leo");

    // leituras em 2, 4, ..., 12 s: a janela da linha vai de 2 a 12 s
    const first = await logsDuring(() => h.runUntil(12_000));
    assert.deepEqual(first, [
        "Envio p/ leo: VP9 libvpx 1280x720 30,0 fps (fonte 59) · alvo 1800 enviado 1650 rtx 40 est 20000 kbps · perda 0,8% rtt 34 ms jitter 6 ms · "
        + "nack 12 pli 0 kf 0 · fila 3 ms · lim banda 0% cpu 0% · 9,2 ms/q qp 34 · nível 1080p60 fixo · rota host/host"
    ]);
    assert.equal(h.senders.get("leo")!.getStatsCalls, 6, "so as leituras da qualidade automatica");

    const second = await logsDuring(() => h.runUntil(22_000));
    assert.equal(second.length, 1);
    assert.match(second[0], /^Envio p\/ leo: VP9 libvpx 1280x720 30,0 fps .* · nível 1080p60 fixo$/, "a rota nao repete");

    assert.deepEqual(await logsDuring(() => h.controller.removeViewer("leo")), [
        "Resumo do envio p/ leo: 22 s · 0 trocas de nível · 1080p60 100% · 60 fps 100%, 30 fps 0% · 30,0 fps em média · est mediana 20000 enviado mediana "
        + "1650 kbps · perda média 0,8% rtt médio 34 ms · kf 0 · rota host/host"
    ]);
    assert.deepEqual(await logsDuring(() => h.runUntil(40_000)), [], "parou: nada mais");
});

test("troca de degrau: logo depois da linha da decisao, a linha das estatisticas de quem mudou; a proxima periodica conta dali", async t => {
    const clock = useFakeClock(t);
    // A: o WebRTC reduzindo por banda abaixo do degrau (controller.upload.test.ts); B: tudo bem
    const a = new EncoderSim({ limitation: "bandwidth", width: 1066, height: 600, link: LINK });
    const h = qualityHarness(clock, { A: a, B: new EncoderSim({ link: LINK }) });
    await h.join("A");
    await h.join("B");

    const lines = await logsDuring(() => h.runUntil(BW_GRACE_MS + 4000));
    const decision = "Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: o WebRTC reduziu para 600p por banda (degrau 1080p))";
    assert.deepEqual(qualityLines(lines), [decision]);
    const at = lines.indexOf(decision);
    assert.match(lines[at + 1], /^Envio p\/ A: VP9 libvpx 1066x600 60,0 fps \(fonte 60\) · .* · lim banda 100% cpu 0% · .* · nível 720p60 \(banda 720p60, geral 1080p60\)$/);
    assert.equal(statsLines(lines).filter(l => l.startsWith("Envio p/ B:")).length, 2, "B: so as periodicas (12 s e 22 s), sem linha extra");

    // a linha extra foi aos 24 s: a proxima de A so aos 34 s
    assert.deepEqual(statsLines(await logsDuring(() => h.runUntil(32_000))).filter(l => l.startsWith("Envio p/ A:")), []);
    assert.equal(statsLines(await logsDuring(() => h.runUntil(34_000))).filter(l => l.startsWith("Envio p/ A:")).length, 1);

    // a transmissao acaba: o resumo de cada um, com o tempo em cada degrau
    const end = await logsDuring(() => h.controller.dispose());
    assert.equal(end.length, 2);
    assert.match(end[0], /^Resumo do envio p\/ A: 34 s · 1 troca de nível · 1080p60 71%, 720p60 29% · 60 fps 100%, 30 fps 0% · /);
    assert.match(end[1], /^Resumo do envio p\/ B: 34 s · 0 trocas de nível · 1080p60 100% · /);
    assert.deepEqual(await logsDuring(() => h.controller.dispose()), [], "uma vez so");
});

test("espectador que para antes de alguma medida: sem resumo", async t => {
    const clock = useFakeClock(t);
    const h = qualityHarness(clock, { A: new EncoderSim() });
    await h.join("A");
    await h.runUntil(2000);
    assert.deepEqual(await logsDuring(() => h.controller.removeViewer("A")), []);
    h.controller.removeViewer("A");
});
