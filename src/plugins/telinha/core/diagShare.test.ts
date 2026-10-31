/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do diagnostico compartilhado (core/diagShare.ts; protocol.ts passo 9), com a sessao inteira pelos fakes e o
// relogio falso da WP-B (o tick de 1 s so roda quando o teste anda o relogio). Os dois papeis:
// - quem manda (este PC): as regras (as duas pontas com a opcao, verificado, no canal de voz, admitido; faltou uma, nada
//   sai), o texto do "Copiar diagnóstico" antes das linhas novas (sem repetir nem perder linha), mascara (IP, pasta do
//   usuario, token), limite por segundo e tamanho da linha, e cada motivo de parar;
// - quem pede (este PC): "Receber diagnóstico", o prefixo "[Telinha] [diag <nome>]" no console, o limite de recepcao e
//   cada motivo de parar de pedir.
// E a compatibilidade com quem nao conhece a acao (v0.2.8 e anteriores): nunca recebe nada da acao "diag".
// Rodar:  pnpm test:file src/plugins/telinha/core/diagShare.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test, type TestContext } from "node:test";

import {
    buildHello, DIAG_MAX_LINE_CHARS, DIAG_MAX_LINES_PER_MESSAGE, DIAG_MAX_LINES_PER_SECOND, type DiagLine, type DiagMessage, isPresenceMessage,
    parseDiagMessage, type PresenceMessage, PROTOCOL_VERSION, sanitizePresence
} from "@plugins/telinha/protocol";
import { formatDiagnostics, getEventLog, getState } from "@plugins/telinha/store";
import type { FakeAction } from "@test/fakes/trystero";
import { ME_ID, pluginSettings } from "@test/fakes/vencord";
import { connectViewer, createRig, destroyRig, enterCall, leaveCall, seconds, setMembers, type StreamingRig, turns, windowOptions } from "@test/helpers/wpb-streaming";

import { rt } from "./context";
import { diagLogSession } from "./diagLog";
import {
    DIAG_LIVE_BUFFER_LINES, DIAG_MAX_QUEUED_MESSAGES, DIAG_MAX_SNAPSHOT_LINES, DIAG_RECEIVE_BURST, DIAG_RECEIVE_PER_SECOND, DIAG_REFRESH_TIMEOUT_MS, DIAG_SNAPSHOT_MIN_INTERVAL_MS,
    diagEligible, diagName, diagText, formatDiagReceived, localDateTime, localTime, onShareDiagnosticsChanged, setDiagnosticsSource, setDiagRequest,
    startDiagShare, stopDiagShare, tickDiagShare
} from "./diagShare";
import { log } from "./log";
import { selfPresence } from "./presence";
import { startSession, stopSession } from "./session";
import { startStreaming, stopStreaming } from "./streaming";

const DEFAULT_SOURCE = { refresh: () => Promise.resolve(), format: () => formatDiagnostics() };
const PREFIX_RE = /^\[Telinha\] \[diag /;
const NOTHING_STORED = "--- sessão anterior: nada guardado neste PC (o registro em arquivo só grava com a opção ligada) ---";

let rig: StreamingRig;
let seq = 0;

interface Friend {
    peerId: string;
    id: string;
    name: string;
}

interface FriendOptions {
    name?: string;
    /** "Compartilhar diagnóstico" ligado la (caps.diag); padrao: sim */
    diag?: boolean;
    /** identidade do Discord verificada; padrao: sim */
    verified?: boolean;
    /** no nosso canal de voz; padrao: sim */
    inVoice?: boolean;
    /** manda presenca; padrao: sim */
    presence?: boolean;
}

function presenceOf(f: Pick<Friend, "id" | "name">, diag: boolean): PresenceMessage {
    return { v: PROTOCOL_VERSION, discordUserId: f.id, username: f.name, streaming: false, caps: { h264HwDecode: false, ...(diag ? { diag: true } : {}) } };
}

/** Alguem chega na call: no canal de voz, verificado, com a opcao ligada (cada opcao tira uma das regras). */
async function friend(opts: FriendOptions = {}): Promise<Friend> {
    seq++;
    const name = opts.name ?? `amigo${seq}`;
    const f = { peerId: `dg${String(seq).padStart(3, "0")}${name}`, id: String(910_000_000_000_000_000n + BigInt(seq)), name };
    await connectViewer(rig, f.peerId, f.id, name, { inVoice: opts.inVoice, presence: false });
    if (opts.verified !== false) rt.peers.get(f.peerId)!.identity = "verified";
    if (opts.presence !== false) rig.room.receive("presence", presenceOf(f, opts.diag !== false), f.peerId);
    await turns();
    return f;
}

/** O que mandamos para essa conexao na acao "diag", em ordem. */
const diagTo = (f: Friend) => rig.room.sentOn("diag", f.peerId).filter(m => m.target === f.peerId).map(m => m.data as DiagMessage);
const linesMsgsTo = (f: Friend) => diagTo(f).filter((m): m is Extract<DiagMessage, { op: "lines"; }> => m.op === "lines");
const linesTo = (f: Friend): DiagLine[] => linesMsgsTo(f).flatMap(m => m.lines);
const textsTo = (f: Friend) => linesTo(f).map(l => l.text);
const label = (f: Friend) => `${f.name} (${f.peerId.slice(0, 6)})`;

async function asksUs(f: Friend, op: "subscribe" | "unsubscribe" = "subscribe") {
    rig.room.receive("diag", { op }, f.peerId);
    await turns();
}

/** Mensagens do log do nucleo depois da marca. */
function logSince(): () => { level: string; msg: string; }[] {
    const seen = new Set(getEventLog());
    return () => getEventLog().filter(e => !seen.has(e));
}

/** As linhas "[Telinha] [diag ...]" que forem para o console a partir daqui. */
function captureConsole(t: TestContext): string[] {
    const out: string[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => {
        const text = args.map(String).join(" ");
        if (PREFIX_RE.test(text)) out.push(text);
    });
    return out;
}

before(async () => {
    rig = createRig();
    await enterCall(rig, []);
});

after(async () => {
    await destroyRig(rig);
});

beforeEach(() => {
    pluginSettings.set("shareDiagnostics", true);
});

afterEach(async () => {
    for (const id of [...rt.peers.keys()]) rig.room.disconnectPeer(id);
    for (const id of [...rt.diagRequested.keys()]) setDiagRequest(id, "?", false);
    setDiagnosticsSource(DEFAULT_SOURCE);
    pluginSettings.set("rejectOutsiders", true);
    pluginSettings.set("shareDiagnostics", false);
    await turns();
});

describe("protocolo (acao \"diag\")", () => {
    test("subscribe/unsubscribe: so o op, sem campos a mais", () => {
        assert.deepEqual(parseDiagMessage({ op: "subscribe", evil: "x".repeat(10_000) }), { op: "subscribe" });
        assert.deepEqual(parseDiagMessage({ op: "unsubscribe", lines: [] }), { op: "unsubscribe" });
        for (const bad of [null, undefined, "subscribe", 9, [], [{ op: "subscribe" }], {}, { op: "SUBSCRIBE" }, { op: "lines" }, { op: "lines", lines: "x" }, { op: "lines", lines: {} }])
            assert.equal(parseDiagMessage(bad), null, JSON.stringify(bad));
    });

    test("lines: cada linha malformada fica de fora e conta em dropped; so os campos conhecidos passam", () => {
        const ok = { t: "09:00:00.000", level: "info", text: "ok" };
        const msg = parseDiagMessage({
            op: "lines",
            lines: [
                { ...ok, extra: "fora" },
                { t: "2026-10-29 09:00:00.123", level: "warn", text: "" },
                { ...ok, t: "9:00:00.000" },
                { ...ok, t: "09:00:00" },
                { ...ok, t: 9 },
                { ...ok, level: "debug" },
                { ...ok, text: 7 },
                { ...ok, text: "x".repeat(DIAG_MAX_LINE_CHARS + 1) },
                { ...ok, text: "x".repeat(DIAG_MAX_LINE_CHARS) },
                "texto",
                null,
                [ok]
            ]
        });
        assert.deepEqual(msg, {
            op: "lines",
            lines: [ok, { t: "2026-10-29 09:00:00.123", level: "warn", text: "" }, { ...ok, text: "x".repeat(DIAG_MAX_LINE_CHARS) }],
            dropped: 9
        });
    });

    test("lines: no maximo DIAG_MAX_LINES_PER_MESSAGE por mensagem (o resto conta); dropped so inteiro de 0 a 1.000.000", () => {
        const line = { t: "09:00:00.000", level: "error", text: "e" };
        const many = parseDiagMessage({ op: "lines", lines: Array.from({ length: DIAG_MAX_LINES_PER_MESSAGE + 50 }, () => line), dropped: 3 });
        assert.equal(many?.op === "lines" && many.lines.length, DIAG_MAX_LINES_PER_MESSAGE);
        assert.equal(many?.op === "lines" && many.dropped, 53);
        for (const bad of [-1, 1.5, "4", 1_000_001, null, Infinity])
            assert.deepEqual(parseDiagMessage({ op: "lines", lines: [line], dropped: bad }), { op: "lines", lines: [line] }, String(bad));
        assert.deepEqual(parseDiagMessage({ op: "lines", lines: [], dropped: 1_000_000 }), { op: "lines", lines: [], dropped: 1_000_000 });
        assert.equal(parseDiagMessage({ op: "lines", lines: [] }), null, "nada a dizer");
        assert.equal(parseDiagMessage({ op: "lines", lines: [], dropped: 0 }), null);
    });

    test("presenca: caps.diag so passa quando e exatamente true", () => {
        const base = presenceOf({ id: "1", name: "a" }, false);
        assert.deepEqual(sanitizePresence({ ...base, caps: { h264HwDecode: true, diag: true } }).caps, { h264HwDecode: true, diag: true });
        for (const diag of ["true", 1, false, null, {}])
            assert.deepEqual(sanitizePresence({ ...base, caps: { h264HwDecode: false, diag } as never }).caps, { h264HwDecode: false }, String(diag));
    });
});

describe("texto, hora e nome", () => {
    test("diagText: uma linha so, mascarada, cortada em DIAG_MAX_LINE_CHARS com reticencias", () => {
        assert.equal(diagText("a\nb\r\nc"), "a ⏎ b ⏎ c");
        assert.equal(diagText("a\u0007b\u001b[31m\tc"), "a b [31m c", "sem caracteres de controle (o JSON os escreve com 6 bytes)");
        assert.equal(diagText("pasta C:\\Users\\Fulano\\AppData e 10.1.2.3"), "pasta C:\\Users\\[usuário]\\AppData e [ip]");
        assert.equal(diagText("amigo (discord 200000000000000002) no canal 1234567890123456789"), "amigo (discord [id]) no canal [id]");
        const long = diagText("x".repeat(5000));
        assert.equal(long.length, DIAG_MAX_LINE_CHARS);
        assert.ok(long.endsWith("…"));
        assert.equal(diagText("x".repeat(DIAG_MAX_LINE_CHARS)), "x".repeat(DIAG_MAX_LINE_CHARS), "no limite: inteira");
    });

    test("hora local com milissegundos; com data para a sessao anterior", () => {
        const at = new Date(2026, 0, 5, 7, 8, 9, 42).getTime();
        assert.equal(localTime(at), "07:08:09.042");
        assert.equal(localDateTime(at), "2026-01-05 07:08:09.042");
    });

    test("nome do prefixo: so [A-Za-z0-9_.-], ate 32; vazio vira '?'", () => {
        assert.equal(diagName("_gupi"), "_gupi");
        assert.equal(diagName("João Silva!"), "Jo_o_Silva_");
        assert.equal(diagName("a.b-c"), "a.b-c");
        assert.equal(diagName("n".repeat(40)).length, 32);
        assert.equal(diagName(""), "?");
    });

    test("linha no console de quem pede: prefixo fixo, a hora de la, a daqui, o nivel e o texto sem caracteres de controle", () => {
        const at = new Date(2026, 9, 31, 15, 46, 1, 500).getTime();
        assert.equal(
            formatDiagReceived("_gupi", { t: "15:46:01.234", level: "warn", text: "Envio p/ x\u0007\u001b[31m" }, at),
            "[Telinha] [diag _gupi] 15:46:01.234 (aqui 15:46:01.500) warn Envio p/ x [31m"
        );
    });
});

describe("quem manda: as regras (as duas pontas com a opcao, verificado, no canal de voz)", () => {
    test("passou em tudo: manda o 'Copiar diagnóstico' e avisa so no log e na pagina do plugin", async () => {
        const f = await friend({ name: "gupi" });
        assert.equal(diagEligible(rt.peers.get(f.peerId)), true);
        const since = logSince();
        await asksUs(f);
        const texts = textsTo(f);
        assert.equal(texts[0], NOTHING_STORED, "primeiro a sessao anterior (o arquivo falso esta vazio)");
        assert.equal(texts[1], "Telinha — diagnóstico", "o mesmo texto do botao (store.formatDiagnostics sem o index.tsx)");
        assert.match(texts.at(-1)!, /^--- ao vivo: cada linha nova do Telinha deste PC a partir daqui ---$/);
        assert.ok(since().some(e => e.msg === `Enviando o diagnóstico deste PC para ${label(f)} (pedido pelo "Compartilhar diagnóstico", ligado aqui)`));
        await turns();
        assert.deepEqual(getState().diag?.sendingTo, ["gupi"]);
        assert.match(formatDiagnostics(), /\ndiagnóstico compartilhado: enviando para gupi; pedido a 0, recebendo de 0\n/);
        for (const l of linesTo(f)) assert.match(l.t, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    const refused: [string, FriendOptions, string][] = [
        ["sem a opcao do lado de la (ou versao antiga)", { diag: false }, "\"Compartilhar diagnóstico\" desligado do lado de lá"],
        ["sem presenca", { presence: false }, "\"Compartilhar diagnóstico\" desligado do lado de lá"],
        ["identidade nao verificada", { verified: false }, "identidade do Discord não verificada"],
        ["fora do canal de voz", { inVoice: false }, "fora do seu canal de voz"]
    ];
    for (const [what, opts, why] of refused) {
        test(`faltou uma regra (${what}): nada sai, so um aviso no log`, async () => {
            const f = await friend(opts);
            const since = logSince();
            await asksUs(f);
            await seconds(rig, 2);
            assert.deepEqual(diagTo(f), []);
            assert.deepEqual(since().filter(e => e.msg.startsWith("Pedido de diagnóstico")).map(e => [e.level, e.msg]), [["warn", `Pedido de diagnóstico de ${label(f)} ignorado: ${why}`]]);
        });
    }

    test("fora do canal de voz, mesmo admitido (\"Recusar quem não está na call\" desligado): nada sai", async () => {
        pluginSettings.set("rejectOutsiders", false);
        const f = await friend({ inVoice: false });
        assert.equal(rt.peers.get(f.peerId)?.admitted, true);
        await asksUs(f);
        assert.deepEqual(diagTo(f), []);
    });

    test("ainda nao admitido (identidade sendo conferida): nada sai", async () => {
        const f = await friend();
        Object.assign(rt.peers.get(f.peerId)!, { identity: "pending", admitted: false });
        const since = logSince();
        await asksUs(f);
        assert.deepEqual(diagTo(f), []);
        assert.ok(since().some(e => e.msg === `Pedido de diagnóstico de ${label(f)} ignorado: não admitido na sala`));
    });

    test("opcao desligada AQUI: nada sai, nem a presenca anuncia caps.diag", async () => {
        pluginSettings.set("shareDiagnostics", false);
        const f = await friend();
        const since = logSince();
        await asksUs(f);
        assert.deepEqual(diagTo(f), []);
        assert.ok(since().some(e => e.level === "info" && e.msg === `${label(f)} pediu o diagnóstico deste PC, mas "Compartilhar diagnóstico" desligado aqui: ignorado`));
        const sent = rig.room.sentOn("presence", f.peerId).at(-1)?.data as PresenceMessage;
        assert.deepEqual(sent.caps, { h264HwDecode: false }, "sem a opcao, a presenca de sempre");
    });

    test("prova de identidade falsa, conexao incompativel ou desconhecida: a mensagem nem e lida", async () => {
        const fake = await friend();
        rt.peers.get(fake.peerId)!.identity = "invalid";
        await asksUs(fake);
        assert.deepEqual(diagTo(fake), []);

        await rig.room.connectPeer("dgIncompat", { hello: { type: "outra-coisa" } });
        await rig.room.connectPeer("dgEuMesmo", { hello: buildHello(ME_ID, "eu") });
        const ids = ["dgIncompat", "dgEuMesmo", "dgNinguem"];
        for (const peerId of ids) rig.room.receive("diag", { op: "subscribe" }, peerId);
        await turns();
        assert.deepEqual(rig.room.sent.filter(m => m.namespace === "diag" && ids.includes(m.target as string)), [], "nenhuma linha para eles");
        assert.equal(rt.diagSending.size, 0);
    });

    test("mensagem malformada e ignorada sem erro", async () => {
        const f = await friend();
        for (const bad of ["lixo", null, { op: "talvez" }, { op: "lines", lines: "x" }]) rig.room.receive("diag", bad, f.peerId);
        await turns();
        assert.deepEqual(diagTo(f), []);
        assert.equal(rt.diagSending.size, 0);
    });
});

describe("quem manda: o 'Copiar diagnóstico' primeiro, depois as linhas novas", () => {
    test("linha que entra enquanto o texto e preparado vai no texto (uma vez so); as seguintes, ao vivo, na ordem", async () => {
        let release!: () => void;
        setDiagnosticsSource({
            refresh: () => new Promise<void>(resolve => (release = resolve)),
            format: () => ["Telinha — diagnóstico", "eventos:", ...getEventLog().map(e => e.msg)].join("\n")
        });
        const f = await friend();
        await asksUs(f);
        log.info("durante o preparo");
        await seconds(rig);
        assert.deepEqual(diagTo(f), [], "nada sai antes do texto");

        release();
        await turns();
        const first = textsTo(f);
        assert.deepEqual(first.slice(0, 2), [NOTHING_STORED, "Telinha — diagnóstico"]);
        assert.ok(first.includes("durante o preparo"));
        assert.match(first.at(-1)!, /^--- ao vivo/);

        const at = Date.now();
        log.info("depois 1");
        log.warn("depois 2");
        await seconds(rig);
        const all = textsTo(f);
        assert.equal(all.filter(t => t === "durante o preparo").length, 1, "sem repetir");
        const live = linesTo(f).slice(first.length);
        assert.deepEqual(live.map(l => [l.level, l.text]), [["info", "depois 1"], ["warn", "depois 2"]]);
        assert.equal(live[0].t, localTime(at), "a hora local de quando a linha entrou no log");
    });

    test("o texto do 'Copiar diagnóstico' sai mascarado, em mensagens de no maximo DIAG_MAX_LINES_PER_MESSAGE linhas", async () => {
        const text = ["Telinha — diagnóstico", "helper: C:\\Users\\Fulano\\AppData\\Roaming\\Telinha\\addon", ...Array.from({ length: DIAG_MAX_SNAPSHOT_LINES + 10 }, (_, i) => `linha ${i}`)].join("\n");
        setDiagnosticsSource({ refresh: () => Promise.reject(new Error("main ocupado")), format: () => text });
        const f = await friend();
        await asksUs(f);
        const msgs = linesMsgsTo(f);
        assert.ok(msgs.every(m => m.lines.length <= DIAG_MAX_LINES_PER_MESSAGE && !m.dropped));
        const texts = textsTo(f);
        assert.equal(texts[2], "helper: C:\\Users\\[usuário]\\AppData\\Roaming\\Telinha\\addon");
        assert.equal(texts.length, DIAG_MAX_SNAPSHOT_LINES + 3, "a linha da sessao anterior + 1000 linhas + o aviso do corte + o marcador 'ao vivo'");
        assert.equal(texts.at(-2), "(+12 linhas do diagnóstico ficaram de fora)");
        assert.equal(linesTo(f).at(-2)?.level, "warn");
    });

    test("o texto falhou ao montar: uma linha dizendo isso, e segue ao vivo", async () => {
        setDiagnosticsSource({
            refresh: () => Promise.resolve(), format: () => {
                throw new Error("quebrou");
            }
        });
        const f = await friend();
        await asksUs(f);
        assert.equal(textsTo(f)[1], "diagnóstico indisponível: Error: quebrou");
        log.info("segue");
        await seconds(rig);
        assert.equal(textsTo(f).at(-1), "segue");
    });

    test("o main nao responde: o texto sai depois de DIAG_REFRESH_TIMEOUT_MS mesmo assim", async () => {
        setDiagnosticsSource({ refresh: () => new Promise(() => { }), format: () => "Telinha — diagnóstico" });
        const f = await friend();
        await asksUs(f);
        await seconds(rig, DIAG_REFRESH_TIMEOUT_MS / 1000 - 1);
        assert.deepEqual(diagTo(f), []);
        await seconds(rig, 2);
        assert.equal(textsTo(f)[1], "Telinha — diagnóstico");
    });

    test("pediu de novo em menos de 30 s: so as linhas novas; depois de 30 s, o texto completo de novo", async () => {
        const f = await friend();
        await asksUs(f);
        const full = textsTo(f).length;
        assert.ok(full > 5);
        await asksUs(f, "unsubscribe");
        await seconds(rig, 3);
        await asksUs(f);
        const again = textsTo(f).slice(full);
        assert.equal(again.length, 1);
        assert.match(again[0], /^--- o diagnóstico completo saiu há \d+ s: daqui em diante, só as linhas novas ---$/);
        log.info("nova");
        await seconds(rig);
        assert.equal(textsTo(f).at(-1), "nova");

        await asksUs(f, "unsubscribe");
        await seconds(rig, DIAG_SNAPSHOT_MIN_INTERVAL_MS / 1000);
        const before = textsTo(f).length;
        await asksUs(f);
        assert.equal(textsTo(f)[before + 1], "Telinha — diagnóstico");
    });

    test("subscribe repetido enquanto recebe: ignorado (o texto nao sai duas vezes)", async () => {
        const f = await friend();
        await asksUs(f);
        const n = diagTo(f).length;
        await asksUs(f);
        assert.equal(diagTo(f).length, n);
    });

    test("parou de pedir enquanto o texto era preparado: nada sai, e o pedido seguinte leva o texto completo", async () => {
        let release!: () => void;
        setDiagnosticsSource({ refresh: () => new Promise<void>(resolve => (release = resolve)), format: () => "Telinha — diagnóstico" });
        const f = await friend();
        await asksUs(f);
        await asksUs(f, "unsubscribe");
        release();
        await turns();
        await seconds(rig);
        assert.deepEqual(diagTo(f), []);

        // o cancelado nao conta como "saiu ha pouco": logo em seguida, o texto completo
        setDiagnosticsSource({ refresh: () => Promise.resolve(), format: () => "Telinha — diagnóstico" });
        await asksUs(f);
        assert.deepEqual(textsTo(f).slice(0, 2), [NOTHING_STORED, "Telinha — diagnóstico"]);
        assert.equal(textsTo(f).some(t => t.includes("saiu há")), false);
    });

    test("o canal nao anda: no maximo DIAG_MAX_QUEUED_MESSAGES mensagens na fila; o resto conta no dropped da proxima", async () => {
        const f = await friend();
        const action = rig.room.actions.get("diag") as FakeAction;
        const waiting: (() => void)[] = [];
        action.sendImpl = () => new Promise<void>(resolve => waiting.push(resolve));
        try {
            await asksUs(f);
            // a primeira parte (1 mensagem) espera o canal; cada segundo com uma linha nova enfileira mais uma
            const ticks = DIAG_MAX_QUEUED_MESSAGES + 5;
            for (let i = 0; i < ticks; i++) {
                log.info(`fila ${i}`);
                await seconds(rig);
            }
            assert.equal(linesMsgsTo(f).length, 1, "so a primeira chegou ao canal");
        } finally {
            action.sendImpl = null;
        }
        waiting[0]();
        await turns();
        const queued = linesMsgsTo(f);
        assert.equal(queued.length, DIAG_MAX_QUEUED_MESSAGES, "a fila andou: so as que couberam");
        assert.equal(queued.at(-1)?.lines[0].text, `fila ${DIAG_MAX_QUEUED_MESSAGES - 2}`);

        await seconds(rig);
        const next = linesMsgsTo(f).at(-1)!;
        assert.equal(linesMsgsTo(f).length, DIAG_MAX_QUEUED_MESSAGES + 1, "o que ficou de fora vai no proximo segundo, mesmo sem linha nova");
        assert.deepEqual(next.lines, []);
        assert.equal(next.dropped, 6, "as 6 linhas das mensagens que nao couberam");
    });

    test("parou de pedir com mensagens na fila: as que ainda nao sairam nao saem", async () => {
        setDiagnosticsSource({ refresh: () => Promise.resolve(), format: () => Array.from({ length: 450 }, (_, i) => `l${i}`).join("\n") });
        const f = await friend();
        const action = rig.room.actions.get("diag") as FakeAction;
        let release!: () => void;
        action.sendImpl = () => new Promise<void>(resolve => (release = resolve));
        try {
            await asksUs(f);
            assert.equal(linesMsgsTo(f).length, 1, "a primeira mensagem saiu e esta esperando o canal");
            await asksUs(f, "unsubscribe");
            release();
            await turns();
            assert.equal(linesMsgsTo(f).length, 1, "as outras duas ficaram de fora");
        } finally {
            action.sendImpl = null;
        }
    });

    test("falha ao enviar: um aviso no log (sem derrubar nada)", async () => {
        const f = await friend();
        const action = rig.room.actions.get("diag") as FakeAction;
        action.sendImpl = () => Promise.reject(new Error("canal fechado"));
        try {
            const since = logSince();
            await asksUs(f);
            assert.ok(since().some(e => e.level === "warn" && e.msg === `Falha ao enviar o diagnóstico para ${f.name}: Error: canal fechado`));
        } finally {
            action.sendImpl = null;
        }
    });
});

describe("quem manda: limites e mascara das linhas ao vivo", () => {
    async function live(): Promise<Friend> {
        const f = await friend();
        await asksUs(f);
        return f;
    }

    test("no maximo DIAG_MAX_LINES_PER_SECOND linhas por segundo; o resto so conta em dropped", async () => {
        const f = await live();
        const before = linesMsgsTo(f).length;
        for (let i = 0; i < 100; i++) log.info(`rajada ${i}`);
        await seconds(rig);
        const [msg, ...rest] = linesMsgsTo(f).slice(before);
        assert.deepEqual(rest, []);
        assert.equal(msg.lines.length, DIAG_MAX_LINES_PER_SECOND);
        assert.equal(msg.lines[0].text, "rajada 0");
        assert.equal(msg.dropped, 100 - DIAG_MAX_LINES_PER_SECOND);
        await seconds(rig);
        assert.equal(linesMsgsTo(f).length, before + 1, "o que ficou de fora nao sai depois");
    });

    test("mais linhas que a janela entre dois envios: as que sairam da janela tambem contam", async () => {
        const f = await live();
        const before = linesMsgsTo(f).length;
        const total = DIAG_LIVE_BUFFER_LINES + 50;
        for (let i = 0; i < total; i++) log.info(`muitas ${i}`);
        await seconds(rig);
        const msg = linesMsgsTo(f)[before];
        assert.equal(msg.lines[0].text, "muitas 50", "as 50 mais velhas sairam da janela");
        assert.equal(msg.dropped, total - DIAG_MAX_LINES_PER_SECOND);
    });

    test("linha longa cortada; IP, pasta do usuario e token mascarados; quebra de linha vira ⏎", async () => {
        const f = await live();
        log.info("x".repeat(5000));
        log.warn("perfil C:\\Users\\Fulano\\Desktop, json \"C:\\\\Users\\\\Fulano\\\\x\", /home/fulano/a e /Users/fulano/b");
        log.error("token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl e Bearer abc.def-ghi, id_token=segredo; peer 192.168.0.10\nsegunda");
        await seconds(rig);
        const [long, paths, tokens] = linesTo(f).slice(-3);
        assert.equal(long.text.length, DIAG_MAX_LINE_CHARS);
        assert.ok(long.text.endsWith("…"));
        assert.equal(paths.text, "perfil C:\\Users\\[usuário]\\Desktop, json \"C:\\\\Users\\\\[usuário]\\\\x\", /home/[usuário]/a e /Users/[usuário]/b");
        assert.equal(tokens.level, "error");
        assert.equal(tokens.text, "token [token] e Bearer [token], id_token=[token]; peer [ip] ⏎ segunda");
    });

    test("ids do Discord e o nome da janela transmitida saem mascarados; o log local fica como esta", async () => {
        const f = await live();
        const title = "Planilha \"salários\" 10.0.0.7 - Excel";
        pluginSettings.set("autoQuality", false);
        try {
            await startStreaming(windowOptions({ source: { id: "window:1234:0", name: title, kind: "window" } }));
            log.info(`${f.name} (discord ${f.id}) viu a "${title}"`);
            await seconds(rig);
        } finally {
            stopStreaming();
            pluginSettings.set("autoQuality", true);
        }
        const texts = textsTo(f);
        assert.ok(texts.includes("Iniciando transmissão: janela \"[janela]\" em 1080p60 sem áudio"), texts.join("\n"));
        assert.ok(texts.includes(`${f.name} (discord [id]) viu a "[janela]"`));
        assert.equal(texts.some(t => t.includes("salários") || t.includes(f.id)), false);
        assert.ok(getEventLog().some(e => e.msg === `Iniciando transmissão: janela "${title.replace("10.0.0.7", "[ip]")}" em 1080p60 sem áudio`), "no log local, o nome fica");
    });
});

describe("quem manda: o fim da sessao anterior (registro em arquivo)", () => {
    afterEach(() => {
        rig.native.telinha.readDiagLog = async () => [];
    });

    test("vai antes do 'Copiar diagnóstico': so outras sessoes, com a data, mascarado, entre marcadores", async () => {
        const at = Date.UTC(2026, 9, 28, 22, 15, 3, 7);
        const iso = (ms: number) => new Date(at + ms).toISOString();
        rig.native.telinha.readDiagLog = async () => [
            `${iso(0)} 0badc0de info --- registro do Telinha em arquivo ligado (sessão 0badc0de) ---`,
            `${iso(1000)} 0badc0de error travou com C:\\Users\\Fulano\\AppData aberto`,
            `${iso(2000)} ${diagLogSession()} info desta sessao`
        ];
        const f = await friend();
        await asksUs(f);
        const lines = linesTo(f);
        assert.equal(lines[0].text, "--- sessão anterior: as últimas 2 linhas do registro deste PC ---");
        assert.deepEqual(lines[1], { t: localDateTime(at), level: "info", text: "--- registro do Telinha em arquivo ligado (sessão 0badc0de) ---" });
        assert.deepEqual(lines[2], { t: localDateTime(at + 1000), level: "error", text: "travou com C:\\Users\\[usuário]\\AppData aberto" });
        assert.equal(lines[3].text, "--- fim da sessão anterior; agora, o \"Copiar diagnóstico\" desta sessão ---");
        assert.equal(lines[4].text, "Telinha — diagnóstico");
        assert.equal(textsTo(f).includes("desta sessao"), false, "a sessao atual vai no 'Copiar diagnóstico', nao aqui");
    });

    test("o arquivo nao responde: o resto sai depois de DIAG_REFRESH_TIMEOUT_MS, sem a sessao anterior", async () => {
        rig.native.telinha.readDiagLog = () => new Promise(() => { });
        const f = await friend();
        await asksUs(f);
        assert.deepEqual(diagTo(f), []);
        await seconds(rig, DIAG_REFRESH_TIMEOUT_MS / 1000 + 1);
        assert.deepEqual(textsTo(f).slice(0, 2), [NOTHING_STORED, "Telinha — diagnóstico"]);
    });

    const appended = () => rig.native.calls.filter(c => c.name === "appendDiagLog").map(c => String(c.args[0])).join("");
    const clears = () => rig.native.calls.filter(c => c.name === "clearDiagLog").length;

    test("com a opcao ligada, o log vai para o arquivo em lotes; desligada, para e o arquivo e apagado", async () => {
        log.info("isto vai para o arquivo");
        await seconds(rig, 3);
        assert.match(appended(), new RegExp(` ${diagLogSession()} info isto vai para o arquivo\\n`));

        const before = clears();
        pluginSettings.set("shareDiagnostics", false);
        assert.equal(clears(), before + 1, "desligar apaga renderer.log e .1");
        log.info("isto nao vai");
        await seconds(rig, 3);
        assert.doesNotMatch(appended(), /isto nao vai/);
    });

    test("desligada sem o onChange (configuracao sincronizada): o tick para de gravar (sem apagar)", async () => {
        const before = clears();
        pluginSettings.load({ shareDiagnostics: false });
        await seconds(rig);
        log.info("depois da sincronizacao");
        await seconds(rig, 3);
        assert.doesNotMatch(appended(), /depois da sincronizacao/);
        assert.equal(clears(), before, "so o onChange apaga");
    });
});

describe("quem manda: quando para", () => {
    async function sending(): Promise<Friend> {
        const f = await friend();
        await asksUs(f);
        assert.ok(rt.diagSending.has(f.peerId));
        return f;
    }

    /** Parou de mandar: a linha no log com o motivo, e nada mais sai para essa conexao. */
    async function assertStopped(f: Friend, why: string, since: ReturnType<typeof logSince>) {
        assert.equal(rt.diagSending.has(f.peerId), false);
        assert.ok(since().some(e => e.msg === `Parou de enviar o diagnóstico para ${f.name} (${f.peerId.slice(0, 6)}): ${why}`), why);
        const n = diagTo(f).length;
        log.info("depois de parar");
        await seconds(rig);
        assert.equal(diagTo(f).length, n, "nada mais sai");
    }

    test("quem pede mandou unsubscribe", async () => {
        const f = await sending();
        const since = logSince();
        await asksUs(f, "unsubscribe");
        await assertStopped(f, "parou de pedir", since);
        await asksUs(f, "unsubscribe");
    });

    test("quem pede saiu da sala (recarregou o Discord, caiu)", async () => {
        const f = await sending();
        const since = logSince();
        rig.room.disconnectPeer(f.peerId);
        await assertStopped(f, "saiu da sala", since);
    });

    test("quem pede saiu do canal de voz", async () => {
        const other = await friend();
        const f = await sending();
        const since = logSince();
        setMembers(rig, [other.id]);
        await seconds(rig);
        await assertStopped(f, "fora do seu canal de voz", since);
    });

    test("quem pede desligou a opcao (presenca sem caps.diag)", async () => {
        const f = await sending();
        const since = logSince();
        rig.room.receive("presence", presenceOf(f, false), f.peerId);
        await seconds(rig);
        await assertStopped(f, "\"Compartilhar diagnóstico\" desligado do lado de lá", since);
    });

    test("este PC desligou a opcao: para na hora e a presenca deixa de anunciar caps.diag", async () => {
        const f = await sending();
        const since = logSince();
        pluginSettings.set("shareDiagnostics", false);
        await turns();
        assert.deepEqual((rig.room.sentOn("presence", f.peerId).at(-1)?.data as PresenceMessage).caps, { h264HwDecode: false });
        await assertStopped(f, "você desligou \"Compartilhar diagnóstico\"", since);
        assert.ok(since().some(e => e.msg === "\"Compartilhar diagnóstico\" desligado"));
    });

    test("conexao que ficou incompativel ou sumiu do estado: o tick para (mesmo sem o aviso de saida)", async () => {
        const a = await sending();
        const b = await sending();
        const since = logSince();
        rt.peers.get(a.peerId)!.incompatible = true;
        rt.peers.delete(b.peerId);
        await seconds(rig);
        await assertStopped(a, "conexão incompatível", since);
        await assertStopped(b, "saiu da sala", since);
    });

    test("a opcao desligada sem o aviso do onChange: o tick para mesmo assim", async () => {
        const f = await sending();
        const since = logSince();
        pluginSettings.load({ shareDiagnostics: false });
        await seconds(rig);
        await assertStopped(f, "\"Compartilhar diagnóstico\" desligado aqui", since);
    });

    test("este PC saiu da call (a sala fechou)", async () => {
        const f = await sending();
        const since = logSince();
        await leaveCall(rig);
        assert.equal(rt.diagSending.size, 0);
        assert.ok(since().some(e => e.msg === `Parou de enviar o diagnóstico para ${f.name} (${f.peerId.slice(0, 6)}): a sala fechou`));
        await enterCall(rig);
    });
});

describe("quem pede (este PC): \"Receber diagnóstico\"", () => {
    test("pede a quem passa nas regras e escreve cada linha no console com o prefixo de grep", async t => {
        const out = captureConsole(t);
        const f = await friend({ name: "_gupi" });
        const since = logSince();
        setDiagRequest(f.id, f.name, true);
        assert.deepEqual(diagTo(f), [{ op: "subscribe" }]);
        assert.ok(since().some(e => e.msg === `Pedindo o diagnóstico de ${label(f)}`));
        await turns();
        assert.deepEqual(getState().diag?.requested, [f.id]);
        assert.deepEqual(getState().diag?.receivingFrom, []);
        assert.match(formatDiagnostics(), /\ndiagnóstico compartilhado: enviando para ninguém; pedido a 1, recebendo de 0\n/);

        const here = localTime(Date.now());
        rig.room.receive("diag", { op: "lines", lines: [{ t: "08:00:00.001", level: "info", text: "Telinha — diagnóstico" }, { t: "08:00:01.002", level: "error", text: "Recepção de x: ruim" }] }, f.peerId);
        assert.deepEqual(out, [
            `[Telinha] [diag _gupi] 08:00:00.001 (aqui ${here}) info Telinha — diagnóstico`,
            `[Telinha] [diag _gupi] 08:00:01.002 (aqui ${here}) error Recepção de x: ruim`
        ]);
        assert.ok(since().some(e => e.msg === `Recebendo o diagnóstico de ${label(f)}: no console do Discord (renderer_js.log), linhas "[Telinha] [diag _gupi]"`));
        await turns();
        assert.deepEqual(getState().diag?.receivingFrom, [f.id]);

        rig.room.receive("diag", { op: "lines", lines: [], dropped: 7 }, f.peerId);
        assert.equal(out.length, 2, "o que ficou de fora so soma; o aviso sai no tick");
        await seconds(rig);
        const tick = localTime(Date.now());
        assert.deepEqual(out.slice(2), [`[Telinha] [diag _gupi] ${tick} (aqui ${tick}) warn (7 linha(s) ficaram de fora pelos limites)`]);
        assert.equal(since().filter(e => e.msg.startsWith("Recebendo o diagnóstico")).length, 1, "o aviso de 'recebendo' sai uma vez");
    });

    test("so 'ficaram de fora' em rajada (10 mil mensagens): no maximo um aviso por segundo, com a soma", async t => {
        const out = captureConsole(t);
        const f = await friend({ name: "inunda" });
        setDiagRequest(f.id, f.name, true);
        for (let i = 0; i < 10_000; i++) rig.room.receive("diag", { op: "lines", lines: [], dropped: 1 }, f.peerId);
        assert.deepEqual(out, [], "nada no console na hora");
        await seconds(rig);
        assert.equal(out.length, 1);
        assert.match(out[0], /^\[Telinha\] \[diag inunda\] .* warn \(10000 linha\(s\) ficaram de fora pelos limites\)$/);
        await seconds(rig, 3);
        assert.equal(out.length, 1, "nada novo: nenhum aviso");
    });

    test("quem nao passa nas regras nao recebe o pedido; quando passar (ligou a opcao la), o tick pede", async () => {
        const f = await friend({ diag: false });
        setDiagRequest(f.id, f.name, true);
        await seconds(rig);
        assert.deepEqual(diagTo(f), []);
        rig.room.receive("presence", presenceOf(f, true), f.peerId);
        await seconds(rig);
        assert.deepEqual(diagTo(f), [{ op: "subscribe" }]);
    });

    test("sem a opcao ligada aqui, ou pedindo duas vezes, ou desligando o que nao estava ligado: nada acontece", async () => {
        const f = await friend();
        pluginSettings.set("shareDiagnostics", false);
        setDiagRequest(f.id, f.name, true);
        assert.equal(rt.diagRequested.size, 0);
        pluginSettings.set("shareDiagnostics", true);
        setDiagRequest(f.id, f.name, true);
        setDiagRequest(f.id, f.name, true);
        assert.deepEqual(diagTo(f), [{ op: "subscribe" }]);
        setDiagRequest("123", "ninguem", false);
        assert.equal(rt.diagRequested.size, 1);
    });

    test("linhas de quem nao pedimos: ignoradas (nada no console, um aviso no log)", async t => {
        const out = captureConsole(t);
        const f = await friend();
        const since = logSince();
        rig.room.receive("diag", { op: "lines", lines: [{ t: "08:00:00.000", level: "info", text: "intruso" }] }, f.peerId);
        assert.deepEqual(out, []);
        assert.ok(since().some(e => e.level === "warn" && e.msg === `Linhas de diagnóstico de ${label(f)} sem pedido: ignoradas`));
    });

    test("limite de recepcao: um balde de DIAG_RECEIVE_BURST linhas que enche com o tempo", async t => {
        const out = captureConsole(t);
        const f = await friend({ name: "rajada" });
        setDiagRequest(f.id, f.name, true);
        const line = { t: "08:00:00.000", level: "info", text: "l" };
        const batch = { op: "lines", lines: Array.from({ length: DIAG_MAX_LINES_PER_MESSAGE }, () => line) };
        const messages = Math.ceil(DIAG_RECEIVE_BURST / DIAG_MAX_LINES_PER_MESSAGE) + 2;
        for (let i = 0; i < messages; i++) rig.room.receive("diag", batch, f.peerId);
        const printed = out.filter(l => l.endsWith(" info l")).length;
        assert.equal(printed, DIAG_RECEIVE_BURST);
        const notices = () => out.filter(l => / warn \(\d+ linha\(s\) ficaram de fora pelos limites\)$/.test(l));
        assert.equal(notices().length, 0, "o aviso espera o tick");

        await seconds(rig, 2);
        assert.equal(notices().length, 1);
        assert.match(notices()[0], / warn \(400 linha\(s\)/, "as duas mensagens que nao couberam, num aviso so");
        out.length = 0;
        rig.room.receive("diag", batch, f.peerId);
        assert.equal(out.filter(l => l.endsWith(" info l")).length, 2 * DIAG_RECEIVE_PER_SECOND, "2 s depois: o que encheu");
    });

    test("o console quebrado nao derruba o handler da acao (vira um aviso)", async t => {
        const f = await friend();
        setDiagRequest(f.id, f.name, true);
        const since = logSince();
        // o log do nucleo tambem usa console.log: so durante a mensagem
        const broken = t.mock.method(console, "log", () => {
            throw new Error("console quebrado");
        });
        try {
            rig.room.receive("diag", { op: "lines", lines: [{ t: "08:00:00.000", level: "info", text: "x" }] }, f.peerId);
        } finally {
            broken.mock.restore();
        }
        assert.ok(since().some(e => e.level === "warn" && e.msg === `Mensagem "diag" de ${label(f)} ignorada: Error: console quebrado`));
    });
});

describe("quem pede: quando para de pedir", () => {
    async function asking(opts: FriendOptions = {}): Promise<Friend> {
        const f = await friend(opts);
        setDiagRequest(f.id, f.name, true);
        assert.ok(rt.diagReceiving.has(f.peerId));
        return f;
    }

    const stoppedLine = (f: Friend, why: string) => `Parou de receber o diagnóstico de ${f.name} (${f.peerId.slice(0, 6)}): ${why}`;

    test("desligou \"Receber diagnóstico\": unsubscribe, e o que chegar depois e ignorado", async t => {
        const out = captureConsole(t);
        const f = await asking();
        const since = logSince();
        setDiagRequest(f.id, f.name, false);
        assert.deepEqual(diagTo(f), [{ op: "subscribe" }, { op: "unsubscribe" }]);
        assert.ok(since().some(e => e.msg === stoppedLine(f, "você desligou \"Receber diagnóstico\"")));
        rig.room.receive("diag", { op: "lines", lines: [{ t: "08:00:00.000", level: "info", text: "tarde" }] }, f.peerId);
        assert.deepEqual(out, []);
        await turns();
        assert.equal(getState().diag, undefined, "nada acontecendo: sem o campo no estado");
    });

    test("a pessoa saiu do canal de voz ou desligou a opcao: o tick manda unsubscribe", async () => {
        const a = await asking();
        const b = await asking();
        const since = logSince();
        setMembers(rig, [b.id]);
        rig.room.receive("presence", presenceOf(b, false), b.peerId);
        await seconds(rig);
        assert.deepEqual(diagTo(a), [{ op: "subscribe" }, { op: "unsubscribe" }]);
        assert.deepEqual(diagTo(b), [{ op: "subscribe" }, { op: "unsubscribe" }]);
        assert.ok(since().some(e => e.msg === stoppedLine(a, "fora do seu canal de voz")));
        assert.ok(since().some(e => e.msg === stoppedLine(b, "\"Compartilhar diagnóstico\" desligado do lado de lá")));
    });

    test("a pessoa saiu da sala e voltou (reabriu o Discord): o pedido continua e vai para a conexao nova", async () => {
        const f = await asking();
        const since = logSince();
        rig.room.disconnectPeer(f.peerId);
        assert.equal(rt.diagReceiving.size, 0);
        assert.ok(since().some(e => e.msg === stoppedLine(f, "saiu da sala")));

        const back = { ...f, peerId: `${f.peerId}b` };
        await connectViewer(rig, back.peerId, f.id, f.name, { presence: false });
        rt.peers.get(back.peerId)!.identity = "verified";
        rig.room.receive("presence", presenceOf(f, true), back.peerId);
        await seconds(rig);
        assert.deepEqual(diagTo(back), [{ op: "subscribe" }]);
    });

    test("conexao que sumiu do estado sem o aviso de saida: o tick esquece sem mandar nada", async () => {
        const f = await asking();
        rt.peers.delete(f.peerId);
        await seconds(rig);
        assert.equal(rt.diagReceiving.size, 0);
        assert.deepEqual(diagTo(f), [{ op: "subscribe" }]);
    });

    test("este PC desligou a opcao: unsubscribe para todos e os pedidos sao esquecidos", async () => {
        const f = await asking();
        pluginSettings.set("shareDiagnostics", false);
        assert.deepEqual(diagTo(f), [{ op: "subscribe" }, { op: "unsubscribe" }]);
        assert.equal(rt.diagRequested.size, 0);
        pluginSettings.set("shareDiagnostics", true);
        await seconds(rig);
        assert.deepEqual(diagTo(f), [{ op: "subscribe" }, { op: "unsubscribe" }], "religar nao pede de novo sozinho");
    });

    test("este PC saiu da call: os pedidos sao esquecidos; pedir fora da call so guarda, e pede ao entrar", async () => {
        const f = await asking();
        const since = logSince();
        await leaveCall(rig);
        assert.equal(rt.diagRequested.size, 0);
        assert.ok(since().some(e => e.msg === stoppedLine(f, "a sala fechou")));

        setDiagRequest(f.id, f.name, true);
        assert.equal(rt.diagReceiving.size, 0, "sem sala, nada a mandar");
        await enterCall(rig);
        const back = await friend({ name: "volta" });
        setDiagRequest(back.id, back.name, true);
        assert.deepEqual(diagTo(back), [{ op: "subscribe" }]);
    });

    test("falha ao mandar subscribe/unsubscribe: so um aviso no log", async () => {
        const f = await friend();
        const action = rig.room.actions.get("diag") as FakeAction;
        action.sendImpl = () => Promise.reject(new Error("sem canal"));
        try {
            const since = logSince();
            setDiagRequest(f.id, f.name, true);
            setDiagRequest(f.id, f.name, false);
            await turns();
            assert.ok(since().some(e => e.level === "warn" && e.msg === "Falha ao pedir o diagnóstico: Error: sem canal"));
            assert.ok(since().some(e => e.level === "warn" && e.msg === "Falha ao parar o diagnóstico: Error: sem canal"));
        } finally {
            action.sendImpl = null;
        }
    });
});

describe("compatibilidade com quem nao conhece a acao (v0.2.8 e anteriores, o amigo virtual)", () => {
    test("a presenca com a opcao ligada so ganha caps.diag (o resto igual, valida para o parser antigo)", async () => {
        const on = selfPresence();
        assert.equal(on.caps.diag, true);
        assert.ok(isPresenceMessage(on));
        pluginSettings.set("shareDiagnostics", false);
        const off = selfPresence();
        assert.equal("diag" in off.caps, false, "desligada: exatamente a presenca de antes");
        const { diag: _, ...withoutDiag } = on.caps;
        assert.deepEqual(withoutDiag, off.caps);
    });

    test("quem nunca anuncia caps.diag nunca recebe nada da acao \"diag\", nem quando pedimos o dele", async () => {
        const old = await friend({ diag: false });
        await asksUs(old);
        setDiagRequest(old.id, old.name, true);
        log.info("linha qualquer");
        await seconds(rig, 3);
        assert.deepEqual(diagTo(old), []);
        assert.equal(getState().peers.find(p => p.peerId === old.peerId)?.diagShare, undefined);
    });

    test("o estado diz quem esta com a opcao ligada (a pagina do plugin lista so esses)", async () => {
        const f = await friend();
        await turns();
        assert.equal(getState().peers.find(p => p.peerId === f.peerId)?.diagShare, true);
    });
});

describe("ganchos fora da sessao", () => {
    test("sem a sessao ativa, o tick, a opcao e parar de novo nao fazem nada; iniciar duas vezes tambem nao", async () => {
        stopSession();
        await turns();
        const since = logSince();
        tickDiagShare();
        onShareDiagnosticsChanged();
        stopDiagShare();
        assert.deepEqual(since(), []);
        startSession();
        startDiagShare();
        await enterCall(rig);
        const f = await friend();
        await asksUs(f);
        log.info("uma vez");
        await seconds(rig);
        assert.equal(textsTo(f).filter(t => t === "uma vez").length, 1, "um listener so");
    });

    test("o plugin desligou (este PC recarregou): para de mandar", async () => {
        const f = await friend();
        await asksUs(f);
        const since = logSince();
        const clearsBefore = rig.native.calls.filter(c => c.name === "clearDiagLog").length;
        stopSession();
        await turns();
        assert.equal(rt.diagSending.size, 0);
        assert.ok(since().some(e => e.msg === `Parou de enviar o diagnóstico para ${f.name} (${f.peerId.slice(0, 6)}): a sala fechou`));
        assert.equal(rig.native.calls.filter(c => c.name === "clearDiagLog").length, clearsBefore, "parar o plugin nao apaga o registro");

        // a opcao desligada com o plugin parado: o registro e apagado do mesmo jeito
        pluginSettings.set("shareDiagnostics", false);
        assert.equal(rig.native.calls.filter(c => c.name === "clearDiagLog").length, clearsBefore + 1);
        startSession();
        await enterCall(rig);
    });
});
