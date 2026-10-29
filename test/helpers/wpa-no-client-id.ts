/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O Telinha SEM Client ID (prova de identidade desligada = comportamento da v0.1.0) para os testes de UM processo:
// carrega core/identity/config.ts e troca o module.exports dele no cache do require por uma copia com
// DISCORD_CLIENT_ID vazio, ANTES de qualquer modulo do plugin carregar. Importe este arquivo PRIMEIRO no teste.
// O plugin publicado tem o Client ID numa constante; isto nao muda nada fora do processo do teste.

import { createRequire } from "node:module";
import { join } from "node:path";

const req = createRequire(__filename);
const file = join(__dirname, "..", "..", "src", "plugins", "telinha", "core", "identity", "config.ts");

if (req.cache[req.resolve(file)]) throw new Error("wpa-no-client-id: core/identity/config.ts ja estava carregado; importe este arquivo antes do plugin");

const real = req(file) as typeof import("@plugins/telinha/core/identity/config");
const patched: Record<string, unknown> = {
    ...real,
    DISCORD_CLIENT_ID: "",
    isIdentityConfigured: (clientId = "") => real.isIdentityConfigured(clientId)
};
Object.defineProperty(patched, "__esModule", { value: true });
req.cache[req.resolve(file)]!.exports = patched;

