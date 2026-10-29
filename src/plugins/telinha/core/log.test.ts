/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do log do nucleo (core/log.ts): mascara de IPs, texto de erro, nivel -> console, buffer do diagnostico
// e o limite de repeticao por chave (logThrottled).
// Rodar:  pnpm test:file src/plugins/telinha/core/log.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getEventLog } from "@plugins/telinha/store";

import { errorMessage, errorText, log, logThrottled, shortId, stripIps } from "./log";

const last = () => getEventLog().at(-1)!;

describe("stripIps", () => {
    test("IPv4 e IPv6 (completo e abreviado) viram [ip]; o resto fica", () => {
        assert.equal(stripIps("candidato 192.168.0.10:5000 e 10.0.0.1"), "candidato [ip]:5000 e [ip]");
        assert.equal(stripIps("v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 fim"), "v6 [ip] fim");
        assert.equal(stripIps("v6 curto fe80::1 e 2001:db8::8a2e:370:7334"), "v6 curto [ip] e [ip]");
        assert.equal(stripIps("sem endereco, versao 1.2.3"), "sem endereco, versao 1.2.3");
    });
});

describe("errorText", () => {
    test("Error, objeto com message, texto e nulo; sempre sem IPs", () => {
        assert.equal(errorText(new TypeError("falhou em 1.2.3.4")), "TypeError: falhou em [ip]");
        assert.equal(errorText({ message: "sem nome" }), "Error: sem nome");
        assert.equal(errorText({ name: "OAuthError", message: "x" }), "OAuthError: x");
        assert.equal(errorText("texto 8.8.8.8"), "texto [ip]");
        assert.equal(errorText(null), "null");
        assert.equal(errorText(undefined), "undefined");
        assert.equal(errorText(42), "42");
    });
});

describe("errorMessage (textos da UI)", () => {
    test("so a mensagem, sem o nome tecnico; sem IPs", () => {
        assert.equal(errorMessage(new Error("state não confere")), "state não confere");
        assert.equal(errorMessage({ name: "OAuthError", message: "OAuth2 400 invalid_grant" }), "OAuth2 400 invalid_grant");
        assert.equal(errorMessage(new TypeError("connect ECONNREFUSED 10.0.0.1:443")), "connect ECONNREFUSED [ip]:443");
        assert.equal(errorMessage("texto 8.8.8.8"), "texto [ip]");
        assert.equal(errorMessage(undefined), "undefined");
    });
});

describe("log", () => {
    test("cada nivel vai para o console certo e para o buffer do diagnostico, sem IPs", t => {
        const out = t.mock.method(console, "log", () => { });
        const warn = t.mock.method(console, "warn", () => { });
        const error = t.mock.method(console, "error", () => { });

        log.info("info 1.1.1.1");
        assert.deepEqual(out.mock.calls.at(-1)?.arguments, ["[Telinha]", "info [ip]"]);
        assert.deepEqual({ level: last().level, msg: last().msg }, { level: "info", msg: "info [ip]" });

        log.warn("aviso");
        assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["[Telinha]", "aviso"]);
        assert.equal(last().level, "warn");

        log.error("erro");
        assert.deepEqual(error.mock.calls.at(-1)?.arguments, ["[Telinha]", "erro"]);
        assert.equal(last().level, "error");
        assert.ok(Math.abs(last().at - Date.now()) < 5000);
    });

    test("shortId: os 6 primeiros caracteres", () => {
        assert.equal(shortId("abcdefghij"), "abcdef");
        assert.equal(shortId("abc"), "abc");
    });
});

describe("logThrottled", () => {
    test("no maximo uma linha por intervalo; a proxima conta as omitidas", t => {
        let now = 1_000_000;
        t.mock.method(Date, "now", () => now);
        const before = getEventLog().length;

        logThrottled("k1", "warn", "repetido");
        logThrottled("k1", "warn", "repetido");
        logThrottled("k1", "warn", "repetido");
        assert.equal(getEventLog().length, before + 1);
        assert.equal(last().msg, "repetido");

        now += 9_999;
        logThrottled("k1", "warn", "repetido");
        assert.equal(getEventLog().length, before + 1, "ainda dentro dos 10 s padrao");

        now += 1;
        logThrottled("k1", "warn", "repetido");
        assert.equal(last().msg, "repetido (+3 repetições omitidas)");
        assert.equal(last().level, "warn");

        // intervalo proprio; sem repeticoes omitidas nao ha sufixo
        now += 50;
        logThrottled("k2", "info", "outro", 100);
        now += 100;
        logThrottled("k2", "error", "outro de novo", 100);
        assert.equal(last().msg, "outro de novo");
        assert.equal(last().level, "error");
    });

    test("mais de 500 chaves: o mapa e esvaziado (a memoria nao cresce sem limite)", t => {
        const now = 5_000_000;
        t.mock.method(Date, "now", () => now);
        logThrottled("primeira", "info", "a primeira");
        logThrottled("primeira", "info", "a primeira");
        const count = getEventLog().length;
        logThrottled("primeira", "info", "a primeira");
        assert.equal(getEventLog().length, count, "suprimida");

        // as chaves das outras provas tambem contam: enche ate passar de 500 e mais uma limpa tudo
        for (let i = 0; i < 502; i++) logThrottled(`enche-${i}`, "info", "x");
        logThrottled("primeira", "info", "a primeira");
        assert.equal(last().msg, "a primeira", "esquecida na limpeza: sai de novo, sem contar as omitidas de antes");
    });
});
