/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Fake `@utils/Logger`: records the lines instead of printing them (TELINHA_TEST_ECHO=1 also prints).

export interface LoggerLine {
    logger: string;
    level: "log" | "info" | "warn" | "error" | "debug";
    args: unknown[];
}

/** Every line logged through any Logger, oldest first. */
export const loggerLines: LoggerLine[] = [];

export class Logger {
    constructor(public name: string, public color = "white") { }

    private push(level: LoggerLine["level"], args: unknown[]) {
        loggerLines.push({ logger: this.name, level, args });
        if (process.env.TELINHA_TEST_ECHO) console[level](`[${this.name}]`, ...args);
    }

    log(...args: unknown[]) {
        this.push("log", args);
    }

    info(...args: unknown[]) {
        this.push("info", args);
    }

    warn(...args: unknown[]) {
        this.push("warn", args);
    }

    error(...args: unknown[]) {
        this.push("error", args);
    }

    debug(...args: unknown[]) {
        this.push("debug", args);
    }

    errorCustomFmt(_fmt: string, ...args: unknown[]) {
        this.push("error", args);
    }
}

export function resetLogger() {
    loggerLines.length = 0;
}
