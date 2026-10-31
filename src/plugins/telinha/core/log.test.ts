/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes do log do nucleo (core/log.ts): mascara de IPs, a mascara do que sai do PC (maskPrivate: pasta do usuario e
// tokens), texto de erro, nivel -> console, buffer do diagnostico e o limite de repeticao por chave (logThrottled).
// Rodar:  pnpm test:file src/plugins/telinha/core/log.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getEventLog } from "@plugins/telinha/store";

import { errorMessage, errorText, log, logThrottled, maskPrivate, notePrivateTitle, shortId, stripIps } from "./log";

const last = () => getEventLog().at(-1)!;

describe("stripIps", () => {
    test("IPv4 e IPv6 (completo e abreviado) viram [ip]; o resto fica", () => {
        assert.equal(stripIps("candidato 192.168.0.10:5000 e 10.0.0.1"), "candidato [ip]:5000 e [ip]");
        assert.equal(stripIps("v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 fim"), "v6 [ip] fim");
        assert.equal(stripIps("v6 curto fe80::1 e 2001:db8::8a2e:370:7334"), "v6 curto [ip] e [ip]");
        assert.equal(stripIps("sem endereco, versao 1.2.3"), "sem endereco, versao 1.2.3");
    });
});

describe("maskPrivate (o que sai do PC no diagnostico compartilhado)", () => {
    test("IPs e a pasta do usuario (Windows, com a barra dobrada do JSON, Linux e macOS)", () => {
        assert.equal(maskPrivate("de 10.0.0.1 e fe80::1"), "de [ip] e [ip]");
        assert.equal(maskPrivate("C:\\Users\\Fulano de Tal\\AppData\\Roaming"), "C:\\Users\\[usuário]\\AppData\\Roaming");
        assert.equal(maskPrivate("d:/users/fulano/x"), "d:/users/[usuário]/x");
        assert.equal(maskPrivate("{\"dir\":\"C:\\\\Users\\\\Fulano\\\\Telinha\"}"), "{\"dir\":\"C:\\\\Users\\\\[usuário]\\\\Telinha\"}");
        assert.equal(maskPrivate("C:\\Documents and Settings\\Fulano\\x"), "C:\\Documents and Settings\\[usuário]\\x");
        assert.equal(maskPrivate("perfil C:\\Users\\Fulano"), "perfil C:\\Users\\[usuário]", "a pasta no fim do texto");
        assert.equal(maskPrivate("/home/fulano/.config e /Users/fulano/Library"), "/home/[usuário]/.config e /Users/[usuário]/Library");
        assert.equal(maskPrivate("https://discord.com/api/users/@me e C:\\Program Files\\Discord"), "https://discord.com/api/users/@me e C:\\Program Files\\Discord", "o resto fica");
    });

    test("tokens: JWT (id_token), token de conta do Discord, Bearer e campos com nome de segredo", () => {
        assert.equal(maskPrivate("tok eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl fim"), "tok [token] fim");
        // so o formato (id em base64 . 6 . 27 a 40), montado aqui: um literal com essa cara seria barrado pelo GitHub
        const accountToken = ["A".repeat(26), "B".repeat(6), "c".repeat(38)].join(".");
        assert.equal(maskPrivate(`conta ${accountToken} fim`), "conta [token] fim");
        assert.equal(maskPrivate("Authorization: Bearer abc.DEF-123_x= fim"), "Authorization: Bearer [token] fim");
        assert.equal(maskPrivate("access_token=abc&refresh_token=def"), "access_token=[token]&refresh_token=[token]");
        assert.equal(maskPrivate("{\"id_token\":\"abc\",\"client_secret\": \"x\", \"code_verifier\":\"y\"}"), "{\"id_token\":\"[token]\",\"client_secret\": \"[token]\", \"code_verifier\":\"[token]\"}");
        assert.equal(maskPrivate("o id_token venceu; prova renovada"), "o id_token venceu; prova renovada", "a palavra sozinha fica");
        assert.equal(maskPrivate("Envio p/ leo (abc123): VP9 1280x720 29,8 fps"), "Envio p/ leo (abc123): VP9 1280x720 29,8 fps");
    });

    test("ids numericos do Discord (17 a 20 digitos) viram [id]; numeros menores ficam", () => {
        assert.equal(maskPrivate("amigo (discord 200000000000000002) e (discord 12345678901234567890)"), "amigo (discord [id]) e (discord [id])");
        assert.equal(maskPrivate("canal: 1234567890123456789; app 1565419793446862929"), "canal: [id]; app [id]");
        assert.equal(maskPrivate("enviado 1650000 bytes em 1730000000000 ms; 123456789012345678901"), "enviado 1650000 bytes em 1730000000000 ms; 123456789012345678901");
    });

    test("nome da janela capturada: a linha de inicio (de qualquer sessao) e, nesta sessao, o nome em qualquer linha", () => {
        // de uma sessao anterior (nome desconhecido aqui): so pela forma da linha, inclusive com aspas no nome
        assert.equal(
            maskPrivate("Iniciando transmissão: janela \"Doc \"x\" - Word\" em 1080p60 com áudio"),
            "Iniciando transmissão: janela \"[janela]\" em 1080p60 com áudio"
        );
        assert.equal(maskPrivate("Iniciando transmissão: tela \"Tela 1\" em 720p60 sem áudio"), "Iniciando transmissão: tela \"[janela]\" em 720p60 sem áudio");
        assert.equal(maskPrivate("Iniciando transmissão: janela \"cortada"), "Iniciando transmissão: janela \"cortada", "sem o fim da linha, a forma nao confere");

        notePrivateTitle("Banco Secreto 10.1.2.3 - Chrome");
        notePrivateTitle("Banco Secreto");
        notePrivateTitle("abc");
        notePrivateTitle("Banco Secreto");
        assert.equal(maskPrivate("erro na Banco Secreto [ip] - Chrome e na Banco Secreto 10.1.2.3 - Chrome"), "erro na [janela] e na [janela]", "o nome inteiro primeiro, com e sem o IP");
        assert.equal(maskPrivate("Banco Secreto caiu; abc fica"), "[janela] caiu; abc fica", "nome curto demais nao e mascarado solto");
        for (let i = 0; i < 25; i++) notePrivateTitle(`janela numero ${i}`);
        assert.equal(maskPrivate("Banco Secreto e janela numero 24"), "Banco Secreto e [janela]", "guarda so os 20 mais recentes");
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
