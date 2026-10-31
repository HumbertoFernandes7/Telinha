/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes da atualizacao automatica do lado do renderer (core/update.ts): o agendamento (15 s depois de abrir, a cada 6 h),
// o acompanhamento do progresso (700 ms), o status guardado e quem assina, o reinicio do Discord, as frases do status e o
// texto do diagnostico. O loader do add-on (VencordNative.pluginHelpers.TelinhaAddon) e falso (test/fakes/native.ts) e o
// tempo e o relogio falso. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/core/update.test.ts  (todos: pnpm test:unit)

import "@test/fakes/dom";

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { flushPromises, useFakeClock } from "@test/fakes/clock";
import { installNative, type NativeEnv, updateStatus as statusOf } from "@test/fakes/native";
import { pluginSettings, resetVencordFakes } from "@test/fakes/vencord";

import {
    type AddonUpdateStatus, checkForUpdateNow, describeUpdate, downloadUpdateNow, explainWaiting, getUpdateStatus, refreshUpdateLog, refreshUpdateStatus, relaunchDiscord,
    startUpdateChecks, stopUpdateChecks, subscribeUpdates, updateDiagnostics, updatesSupported, type UpdateWaiting
} from "./update";

const asStatus = (patch: Parameters<typeof statusOf>[0]) => statusOf(patch) as AddonUpdateStatus;
const addonCalls = (native: NativeEnv) => native.calls.filter(c => c.name.startsWith("update"));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let native: NativeEnv | null = null;

afterEach(() => {
    stopUpdateChecks();
    native?.restore();
    native = null;
    resetVencordFakes();
});

describe("frases do status (describeUpdate)", () => {
    test("sem leitura ainda", () => {
        assert.equal(describeUpdate(null), "Ainda não verifiquei.");
    });

    test("procurando e baixando", () => {
        assert.equal(describeUpdate(asStatus({ phase: "checking" })), "Procurando atualização…");
        assert.equal(describeUpdate(asStatus({ phase: "downloading", latest: { version: "0.3.0", tag: "v0.3.0" } })), "Baixando a versão 0.3.0…");
        assert.equal(describeUpdate(asStatus({ phase: "downloading", latest: null })), "Baixando a versão nova…");
    });

    test("em dia, com o aviso da versao ignorada ou desfeita", () => {
        assert.equal(describeUpdate(asStatus({ phase: "up-to-date" })), "Em dia.");
        assert.equal(describeUpdate(asStatus({ phase: "up-to-date", skipped: "0.3.0" })), "Em dia. A versão 0.3.0 foi ignorada porque não iniciou direito.");
        assert.equal(
            describeUpdate(asStatus({ phase: "up-to-date", lastRollback: { version: "0.3.0", to: "0.2.3", at: "2026-10-29", reason: "crash" } })),
            "Em dia. A versão 0.3.0 não iniciou direito e foi desfeita sozinha."
        );
        assert.equal(
            describeUpdate(asStatus({ phase: "up-to-date", lastRollback: { version: "0.3.0", to: "0.2.0", at: "2026-10-29", reason: "crash" } })),
            "Em dia.",
            "o desfazer foi para outra versao: nao e a instalada agora"
        );
        assert.equal(
            describeUpdate(asStatus({ phase: "up-to-date", installed: null, lastRollback: { version: "0.3.0", to: "0.2.3", at: "2026-10-29", reason: "crash" } })),
            "Em dia."
        );
    });

    test("disponivel e pronta", () => {
        assert.equal(describeUpdate(asStatus({ phase: "available", latest: { version: "0.3.0", tag: "v0.3.0" } })), "Versão 0.3.0 disponível.");
        assert.equal(describeUpdate(asStatus({ phase: "available", latest: null })), "Versão nova disponível.");
        assert.equal(describeUpdate(asStatus({ phase: "ready", ready: "0.3.0" })), "Versão 0.3.0 pronta: reinicie o Discord para usar.");
        assert.equal(describeUpdate(asStatus({ phase: "ready", ready: "0.3.0", waiting: null })), "Versão 0.3.0 pronta: reinicie o Discord para usar.");
    });

    test("pronta, mas nao entrou ao reiniciar: diz por que e o que fazer (e quantas vezes ja tentou)", () => {
        const stuck = (reason: string, detail: Record<string, unknown> | null = null, starts = 1) =>
            describeUpdate(asStatus({ phase: "ready", ready: "0.2.8", waiting: { reason, detail, at: "2026-10-31T05:53:00Z", starts } }));
        assert.equal(
            stuck("others", { pids: [1234], exes: ["DiscordPTB.exe"] }),
            "Versão 0.2.8 pronta, mas não entrou ao reiniciar: outro Discord está aberto com o Telinha (Discord PTB). Feche todos os Discords, inclusive pelo ícone perto do relógio (botão direito → Sair do Discord), e abra de novo."
        );
        assert.equal(
            stuck("in-use", { code: "EBUSY" }, 3),
            "Versão 0.2.8 pronta, mas não entrou ao reiniciar (3 tentativas): um arquivo do Telinha estava em uso (o ajudante de áudio ou o antivírus). Feche o Discord por completo e abra de novo. Se não resolver, reinicie o computador."
        );
        assert.equal(
            stuck("activate-failed", { code: "EPERM" }),
            "Versão 0.2.8 pronta, mas não entrou ao reiniciar: o Windows não deixou pôr a versão nova no lugar (antivírus?). Feche o Discord por completo e abra de novo. Se não resolver, reinicie o computador."
        );
        assert.equal(stuck("locked"), "Versão 0.2.8 pronta, mas não entrou ao reiniciar: outro Discord estava trocando de versão ao mesmo tempo. Feche o Discord por completo e abra de novo.");
        assert.equal(stuck("trial"), "Versão 0.2.8 pronta, mas não entrou ao reiniciar: a versão atual ainda não tinha confirmado que abriu direito. Reinicie o Discord mais uma vez.");
        assert.equal(stuck("algo-novo"), "Versão 0.2.8 pronta, mas não entrou ao reiniciar: não deu pra trocar desta vez. Reinicie o Discord mais uma vez.");
    });

    test("erro: a mensagem do loader, ou a frase padrao; mais o desfazer", () => {
        assert.equal(describeUpdate(asStatus({ phase: "error", error: { kind: "network", message: "sem rede", quiet: true } })), "Erro: sem rede.");
        assert.equal(describeUpdate(asStatus({ phase: "error", error: null })), "Erro: a verificação falhou.");
        assert.equal(
            describeUpdate(asStatus({ phase: "error", error: { kind: "hash", message: "SHA-256 diferente", quiet: false }, lastRollback: { version: "0.3.0", to: "0.2.3", at: "x", reason: "y" } })),
            "Erro: SHA-256 diferente. A versão 0.3.0 não iniciou direito e foi desfeita sozinha."
        );
    });

    test("fase desconhecida ou ociosa: ainda nao verificou nesta sessao", () => {
        assert.equal(describeUpdate(asStatus({ phase: "idle" })), "Ainda não verifiquei nesta sessão.");
        assert.equal(
            describeUpdate(asStatus({ phase: "idle", lastRollback: { version: "0.3.0", to: "0.2.3", at: "x", reason: "y" } })),
            "Ainda não verifiquei nesta sessão. A versão 0.3.0 não iniciou direito e foi desfeita sozinha."
        );
    });
});

describe("por que a versao nao entrou (explainWaiting)", () => {
    const w = (reason: string, detail: UpdateWaiting["detail"] = null): UpdateWaiting => ({ reason, detail, at: null, starts: 1 });

    test("sem motivo: nada a explicar", () => {
        assert.equal(explainWaiting(null), null);
        assert.equal(explainWaiting(undefined), null);
    });

    test("outro Discord: o nome de cada tipo de Discord, sem repetir; programa desconhecido sai como veio; sem nomes, so a frase", () => {
        const why = (detail: UpdateWaiting["detail"]) => explainWaiting(w("others", detail))!.why;
        assert.equal(why({ pids: [1, 2], exes: ["Discord.exe", "discordcanary.EXE"] }), "outro Discord está aberto com o Telinha (Discord, Discord Canary)");
        assert.equal(why({ pids: [1, 2], exes: ["DiscordPTB.exe", "DiscordPTB.exe"] }), "outro Discord está aberto com o Telinha (Discord PTB)");
        assert.equal(why({ pids: [1], exes: ["DiscordDevelopment.exe"] }), "outro Discord está aberto com o Telinha (Discord Development)");
        assert.equal(why({ pids: [1], exes: ["Estranho.exe"] }), "outro Discord está aberto com o Telinha (Estranho.exe)");
        assert.equal(why({ pids: [1], exes: [null, ""] }), "outro Discord está aberto com o Telinha");
        assert.equal(why({ pids: [1] }), "outro Discord está aberto com o Telinha");
        assert.equal(why(null), "outro Discord está aberto com o Telinha");
    });
});

describe("sem o loader do add-on", () => {
    test("nao ha atualizacao automatica: nada e lido nem agendado", async t => {
        const clock = useFakeClock(t);
        assert.equal(updatesSupported(), false);
        assert.equal(await refreshUpdateStatus(), null);
        assert.equal(await checkForUpdateNow(), null);
        assert.equal(await downloadUpdateNow(), null);
        startUpdateChecks();
        await clock.tickAsync(7 * HOUR, 60 * MINUTE);
        assert.equal(getUpdateStatus(), null);
    });

    test("o diagnostico diz que a versao e desconhecida", () => {
        assert.equal(updateDiagnostics(), "versão: ? (sem o loader do add-on: atualização automática indisponível)");
    });

    test("loader sem VencordNative, ou com funcoes faltando (loader antigo), tambem conta como sem suporte", () => {
        const g = globalThis as { VencordNative?: unknown; };
        const before = g.VencordNative;
        delete g.VencordNative;
        try {
            assert.equal(updatesSupported(), false);
        } finally {
            g.VencordNative = before;
        }
        native = installNative({}, { addon: { updateDownload: undefined as never } });
        assert.equal(updatesSupported(), false);
        native.restore();
        native = installNative({}, { addon: null }); // so os natives do plugin: Telinha instalado dentro de um Vencord, sem o loader
        assert.equal(updatesSupported(), false);
    });
});

describe("com o loader do add-on", () => {
    test("o status lido do main fica guardado e avisa quem assina (so uma vez por leitura)", async () => {
        native = installNative({}, { addon: { updateStatus: async () => asStatus({ phase: "available", latest: { version: "0.3.0", tag: "v0.3.0" } }) } });
        assert.equal(updatesSupported(), true);
        const seen: (string | undefined)[] = [];
        const off = subscribeUpdates(() => seen.push(getUpdateStatus()?.phase));
        const status = await refreshUpdateStatus();
        assert.equal(status?.phase, "available");
        assert.deepEqual(seen, ["available"]);

        off();
        await refreshUpdateStatus();
        assert.deepEqual(seen, ["available"], "quem cancelou a assinatura nao e mais chamado");
    });

    test("um assinante que quebra nao impede os outros", async t => {
        native = installNative();
        const error = t.mock.method(console, "error", () => { });
        const good: string[] = [];
        const offBad = subscribeUpdates(() => {
            throw new Error("quebrei");
        });
        const offGood = subscribeUpdates(() => good.push("ok"));
        await refreshUpdateStatus();
        assert.deepEqual(good, ["ok"]);
        assert.equal(error.mock.callCount(), 1);
        assert.equal(error.mock.calls[0].arguments[0], "[Telinha] update listener failed");
        offBad();
        offGood();
    });

    test("uma leitura que falha so vai para o console e o status anterior continua", async t => {
        native = installNative({}, { addon: { updateStatus: async () => asStatus({ phase: "ready", ready: "0.3.0" }) } });
        await refreshUpdateStatus();
        native.restore();
        native = installNative({}, {
            addon: {
                updateStatus: async () => {
                    throw new Error("IPC caiu");
                }
            }
        });
        const warn = t.mock.method(console, "warn", () => { });
        const status = await refreshUpdateStatus();
        assert.equal(status?.phase, "ready");
        assert.equal(warn.mock.calls[0].arguments[0], "[Telinha] update status failed");
    });

    test("'Procurar atualizacao': pede ao main com manual=true e acompanha o progresso de 700 em 700 ms", async t => {
        const clock = useFakeClock(t);
        let release!: (s: AddonUpdateStatus) => void;
        let phase: AddonUpdateStatus["phase"] = "checking";
        native = installNative({}, {
            addon: {
                updateCheck: () => new Promise<AddonUpdateStatus>(resolve => { release = resolve; }),
                updateStatus: async () => asStatus({ phase })
            }
        });
        const phases: string[] = [];
        const off = subscribeUpdates(() => phases.push(getUpdateStatus()!.phase));

        const done = checkForUpdateNow();
        await clock.tickAsync(699);
        assert.deepEqual(phases, [], "ainda nao passou 700 ms");
        await clock.tickAsync(1);
        assert.deepEqual(phases, ["checking"]);
        phase = "downloading";
        await clock.tickAsync(700);
        assert.deepEqual(phases, ["checking", "downloading"]);

        release(asStatus({ phase: "up-to-date" }));
        const result = await done;
        assert.equal(result?.phase, "up-to-date");
        assert.deepEqual(addonCalls(native).filter(c => c.name === "updateCheck").map(c => c.args[0]), [{ autoDownload: true, manual: true }]);

        const reads = addonCalls(native).filter(c => c.name === "updateStatus").length;
        await clock.tickAsync(5000);
        assert.equal(addonCalls(native).filter(c => c.name === "updateStatus").length, reads, "terminou: o acompanhamento parou");
        off();
    });

    test("'Procurar atualizacao' com a atualizacao automatica desligada: nao baixa sozinho", async () => {
        native = installNative();
        pluginSettings.set("autoUpdate", false);
        await checkForUpdateNow();
        assert.deepEqual(addonCalls(native).find(c => c.name === "updateCheck")?.args[0], { autoDownload: false, manual: true });
    });

    test("'Atualizar': baixa e deixa pronta para o proximo inicio", async () => {
        native = installNative();
        const result = await downloadUpdateNow();
        assert.equal(result?.phase, "ready");
        assert.equal(result?.ready, "0.2.4");
        assert.equal(addonCalls(native).filter(c => c.name === "updateDownload").length, 1);
    });

    test("falha de IPC no meio de uma operacao longa: so console, sem derrubar o botao", async t => {
        native = installNative({}, {
            addon: {
                updateDownload: async () => {
                    throw new Error("canal fechado");
                }
            }
        });
        const warn = t.mock.method(console, "warn", () => { });
        const status = await downloadUpdateNow();
        assert.ok(status, "devolve o ultimo status conhecido");
        assert.equal(warn.mock.calls[0].arguments[0], "[Telinha] update call failed");
    });
});

describe("verificacoes agendadas", () => {
    test("le o status na hora, procura 15 s depois de abrir e de novo a cada 6 h", async t => {
        const clock = useFakeClock(t);
        native = installNative();
        startUpdateChecks();
        await clock.tickAsync(0);
        assert.deepEqual(addonCalls(native).map(c => c.name), ["updateStatus"]);

        await clock.tickAsync(14_900);
        assert.equal(addonCalls(native).filter(c => c.name === "updateCheck").length, 0);
        await clock.tickAsync(200);
        assert.deepEqual(addonCalls(native).filter(c => c.name === "updateCheck").map(c => c.args[0]), [{ autoDownload: true, manual: false }]);

        await clock.tickAsync(6 * HOUR - 15_100 - 1, 30 * MINUTE);
        assert.equal(addonCalls(native).filter(c => c.name === "updateCheck").length, 1, "1 ms antes das 6 h");
        await clock.tickAsync(1);
        assert.equal(addonCalls(native).filter(c => c.name === "updateCheck").length, 2);
        await clock.tickAsync(6 * HOUR, 30 * MINUTE);
        assert.equal(addonCalls(native).filter(c => c.name === "updateCheck").length, 3);
    });

    test("ligar duas vezes nao agenda em dobro; parar cancela tudo e da para ligar de novo", async t => {
        const clock = useFakeClock(t);
        native = installNative();
        startUpdateChecks();
        startUpdateChecks();
        await clock.tickAsync(20_000);
        assert.equal(addonCalls(native).filter(c => c.name === "updateStatus").length, 1);
        assert.equal(addonCalls(native).filter(c => c.name === "updateCheck").length, 1);

        stopUpdateChecks();
        const calls = native.calls.length;
        await clock.tickAsync(13 * HOUR, 60 * MINUTE);
        assert.equal(native.calls.length, calls, "parado: nenhuma verificacao");

        startUpdateChecks();
        await clock.tickAsync(20_000);
        assert.equal(addonCalls(native).filter(c => c.name === "updateCheck").length, 2);
    });

    test("parar antes dos 15 s tambem cancela a primeira verificacao", async t => {
        const clock = useFakeClock(t);
        native = installNative();
        startUpdateChecks();
        await clock.tickAsync(5000);
        stopUpdateChecks();
        await clock.tickAsync(HOUR, 30 * MINUTE);
        assert.equal(addonCalls(native).filter(c => c.name === "updateCheck").length, 0);
    });

    test("a verificacao silenciosa respeita 'Atualizar automaticamente' e falhas nao viram aviso", async t => {
        const clock = useFakeClock(t);
        const warn = t.mock.method(console, "warn", () => { });
        native = installNative({}, {
            addon: {
                updateCheck: async () => {
                    throw new Error("GitHub fora do ar");
                }
            }
        });
        pluginSettings.set("autoUpdate", false);
        startUpdateChecks();
        await clock.tickAsync(16_000);
        assert.deepEqual(addonCalls(native).find(c => c.name === "updateCheck")?.args[0], { autoDownload: false, manual: false });
        assert.deepEqual(warn.mock.calls.map(c => c.arguments[0]), ["[Telinha] update check failed"]);
    });

    test("o loader some entre ligar e a primeira verificacao: nada acontece", async t => {
        const clock = useFakeClock(t);
        native = installNative();
        startUpdateChecks();
        await clock.tickAsync(1000);
        const env = native;
        native.restore(); // o Discord foi reiniciado sem o loader
        await clock.tickAsync(20_000);
        assert.equal(addonCalls(env).filter(c => c.name === "updateCheck").length, 0);
    });

    test("uma resposta vazia do main nao apaga o status que ja existe", async () => {
        native = installNative({}, { addon: { updateStatus: async () => asStatus({ phase: "ready", ready: "0.3.0" }) } });
        await refreshUpdateStatus();
        native.restore();
        native = installNative({}, { addon: { updateStatus: async () => null } });
        assert.equal((await refreshUpdateStatus())?.phase, "ready");
    });

    test("o 'estado' do ultimo check chega a quem assina", async t => {
        const clock = useFakeClock(t);
        native = installNative({}, { addon: { updateCheck: async () => asStatus({ phase: "available", latest: { version: "0.3.0", tag: "v0.3.0" } }) } });
        const seen: string[] = [];
        const off = subscribeUpdates(() => seen.push(getUpdateStatus()!.phase));
        startUpdateChecks();
        await clock.tickAsync(16_000);
        assert.equal(seen.at(-1), "available");
        off();
    });
});

describe("reiniciar o Discord", () => {
    const g = globalThis as { DiscordNative?: unknown; };

    afterEach(() => {
        delete g.DiscordNative;
    });

    test("sem DiscordNative ou sem app.relaunch: false (a UI mostra 'feche o Discord por completo')", () => {
        assert.equal(relaunchDiscord(), false);
        g.DiscordNative = {};
        assert.equal(relaunchDiscord(), false);
        g.DiscordNative = { app: {} };
        assert.equal(relaunchDiscord(), false);
    });

    test("com DiscordNative.app.relaunch: reinicia uma vez e devolve true", t => {
        const relaunch = t.mock.fn();
        g.DiscordNative = { app: { relaunch } };
        assert.equal(relaunchDiscord(), true);
        assert.equal(relaunch.mock.callCount(), 1);
    });
});

describe("texto do diagnostico", () => {
    test("com o loader: versao instalada (e commit), atualizacao automatica e a frase do status", async () => {
        native = installNative();
        await refreshUpdateStatus();
        await refreshUpdateLog();
        assert.equal(updateDiagnostics(), "versão: 0.2.3 (abcdef12); atualização automática: ligada; atualização: Em dia.\nmain.log: nenhuma linha de atualização");

        pluginSettings.set("autoUpdate", false);
        assert.match(updateDiagnostics(), /atualização automática: desligada/);
    });

    test("sem commit, ou sem versao instalada", async () => {
        native = installNative({}, { addon: { updateStatus: async () => asStatus({ installed: { version: "0.2.3", commit: null }, phase: "ready", ready: "0.3.0" }) } });
        await refreshUpdateStatus();
        await refreshUpdateLog();
        assert.equal(updateDiagnostics().split("\n")[0], "versão: 0.2.3; atualização automática: ligada; atualização: Versão 0.3.0 pronta: reinicie o Discord para usar.");

        native.restore();
        native = installNative({}, { addon: { updateStatus: async () => asStatus({ installed: null }) } });
        await refreshUpdateStatus();
        assert.match(updateDiagnostics(), /^versão: \?;/);
        await flushPromises();
    });

    test("versao que nao entrou: o motivo cru (pids, programas, codigo) e as ultimas linhas do main.log", async () => {
        const waiting = { reason: "others", detail: { pids: [1234], exes: ["DiscordPTB.exe"] }, at: "2026-10-31T05:53:12.000Z", starts: 2 };
        const log = ["2026-10-31T05:53:10.000Z [1234] update: staged, applied at the next Discord start {}", "2026-10-31T05:53:12.000Z [5678] update: staged update waits, another Discord is running from this add-on {\"pids\":[1234]}"];
        native = installNative({}, { addon: { updateStatus: async () => asStatus({ phase: "ready", ready: "0.2.8", waiting }), updateLog: async () => [...log, 42] } });
        await refreshUpdateStatus();
        assert.deepEqual(await refreshUpdateLog(), log, "so texto");
        const lines = updateDiagnostics().split("\n");
        assert.match(lines[0], /atualização: Versão 0\.2\.8 pronta, mas não entrou ao reiniciar \(2 tentativas\): outro Discord está aberto com o Telinha \(Discord PTB\)\./);
        assert.equal(lines[1], 'atualização esperando: others; 2 início(s) seguido(s); último 2026-10-31T05:53:12.000Z; {"pids":[1234],"exes":["DiscordPTB.exe"]}');
        assert.equal(lines[2], "main.log (últimas linhas de atualização):");
        assert.deepEqual(lines.slice(3), log.map(l => `  ${l}`));
    });

    test("motivo sem detalhe nem hora", async () => {
        native = installNative({}, { addon: { updateStatus: async () => asStatus({ phase: "ready", ready: "0.2.8", waiting: { reason: "locked", detail: null, at: null, starts: 1 } }) } });
        await refreshUpdateStatus();
        assert.equal(updateDiagnostics().split("\n")[1], "atualização esperando: locked; 1 início(s) seguido(s); último ?");
    });

    test("main.log que nao da pra ler: loader antigo (sem updateLog), falha no main, resposta que nao e lista", async t => {
        const warn = t.mock.method(console, "warn", () => { });
        native = installNative({}, { addon: { updateLog: undefined as never } });
        await refreshUpdateStatus();
        assert.equal(await refreshUpdateLog(), null);
        assert.equal(updateDiagnostics().split("\n").at(-1), "main.log: não deu pra ler (loader antigo ou sem acesso)");
        native.restore();

        native = installNative({}, { addon: { updateLog: async () => { throw new Error("ipc"); } } });
        assert.equal(await refreshUpdateLog(), null);
        assert.deepEqual(warn.mock.calls.map(c => c.arguments[0]), ["[Telinha] update log failed"]);
        native.restore();

        native = installNative({}, { addon: { updateLog: async () => "texto" } });
        assert.equal(await refreshUpdateLog(), null);
        assert.equal(updateDiagnostics().split("\n").at(-1), "main.log: não deu pra ler (loader antigo ou sem acesso)");
    });

    test("sem o loader, refreshUpdateLog nao chama nada", async () => {
        assert.equal(await refreshUpdateLog(), null);
    });
});
