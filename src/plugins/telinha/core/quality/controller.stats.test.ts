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

import { SenderLog, STATS_LINE_RE } from "@plugins/telinha/core/statsLog";
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
        "Resumo do envio p/ leo: 22 s · 0 trocas de nível · 1080p60 100% · 60 fps 100%, 30 fps 0% · tamanho 1280x720 100% · fps medido 30 100% · "
        + "30,0 fps em média · est mediana 20000 enviado mediana 1650 kbps · perda média 0,8% rtt médio 34 ms · kf 0 · rota host/host"
    ]);
    assert.deepEqual(await logsDuring(() => h.runUntil(40_000)), [], "parou: nada mais");
});

test("troca de degrau: logo depois da linha da decisao, a linha das estatisticas de quem mudou; a proxima periodica conta dali", async t => {
    const clock = useFakeClock(t);
    // A: caminho estreito (a banda estimada nunca da os 4500 do 1080p60, controller.network.test.ts); B: tudo bem
    const a = new EncoderSim({ availableKbps: 3000, kbps: 2800, link: LINK });
    const h = qualityHarness(clock, { A: a, B: new EncoderSim({ link: LINK }) });
    await h.join("A");
    await h.join("B");

    const lines = await logsDuring(() => h.runUntil(BW_GRACE_MS + 12_000));
    const decision = "Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 3000 kbps, o degrau pede 4500 há 14 s); nova subida só após 30 s estável";
    assert.deepEqual(qualityLines(lines), [decision]);
    const at = lines.indexOf(decision);
    assert.match(lines[at + 1], /^Envio p\/ A: VP9 libvpx 1920x1080 60,0 fps \(fonte 60\) · .* · nível 720p60 \(banda 720p60, geral 1080p60\), antes 1080p60 \(banda: banda estimada\)$/);
    assert.equal(statsLines(lines).filter(l => l.startsWith("Envio p/ B:")).length, 3, "B: so as periodicas (12, 22 e 32 s), sem linha extra");

    // a linha extra foi aos 32 s (no lugar da periodica): a proxima de A so aos 42 s, ja sem o "antes"
    assert.deepEqual(statsLines(await logsDuring(() => h.runUntil(40_000))).filter(l => l.startsWith("Envio p/ A:")), []);
    const next = statsLines(await logsDuring(() => h.runUntil(42_000))).filter(l => l.startsWith("Envio p/ A:"));
    assert.equal(next.length, 1);
    assert.doesNotMatch(next[0], /antes/);

    // a transmissao acaba: o resumo de cada um, com o tempo em cada degrau e cada troca com o motivo
    const end = await logsDuring(() => h.controller.dispose());
    assert.equal(end.length, 2);
    assert.match(end[0], /^Resumo do envio p\/ A: 42 s · 1 troca de nível: 1080p60→720p60 \(banda: banda estimada\) aos 32 s · 1080p60 76%, 720p60 24% · 60 fps 100%, 30 fps 0% · /);
    assert.match(end[1], /^Resumo do envio p\/ B: 42 s · 0 trocas de nível · 1080p60 100% · /);
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

test("o log de estatisticas quebrado (toda chamada do SenderLog lanca): as decisoes e os applies seguem; um aviso so", async t => {
    const boom = () => {
        throw new Error("falha de teste no log");
    };
    for (const m of ["add", "line", "trackLevel", "summary"] as const) t.mock.method(SenderLog.prototype, m, boom);
    const clock = useFakeClock(t);
    const a = new EncoderSim({ availableKbps: 3000, kbps: 2800, link: LINK });
    const h = qualityHarness(clock, { A: a, B: new EncoderSim({ link: LINK }) });

    const lines = await logsDuring(async () => {
        await h.join("A");
        await h.join("B");
        await h.runUntil(BW_GRACE_MS + 12_000);
    });
    assert.deepEqual(qualityLines(lines), ["Qualidade automática: 1080p 60 fps → 720p 60 fps para A (banda: banda estimada 3000 kbps, o degrau pede 4500 há 14 s); nova subida só após 30 s estável"]);
    assert.equal(h.lastApplied("A"), "720p60", "o degrau novo chegou no encoder");
    assert.equal(h.lastApplied("B"), "1080p60");
    assert.deepEqual(statsLines(lines), []);
    assert.deepEqual(lines.filter(l => l.startsWith("O log de estatísticas falhou")), [
        "O log de estatísticas falhou (só diagnóstico: a transmissão e a recepção continuam): Error: falha de teste no log"
    ]);

    // parar um espectador e acabar a transmissao tambem nao lancam (e o aviso nao repete)
    const end = await logsDuring(() => {
        h.controller.removeViewer("B");
        h.controller.dispose();
    });
    assert.deepEqual(end, []);
});
