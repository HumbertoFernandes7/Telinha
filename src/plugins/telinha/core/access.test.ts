/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Testes das partes PURAS de "Quem pode assistir" (core/access.ts + o passo 7 de protocol.ts) e da copia da prova
// de senha no amigo virtual. Nao entra no build (nada importa este arquivo).
// Rodar:  pnpm test:file src/plugins/telinha/core/access.test.ts  (todos: pnpm test:unit)

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import {
    isStreamAccess, parseWatchReply, parseWatchRequest, type PresenceMessage, sanitizePresence, STREAM_ACCESS_MODES, type WatchDeniedReason
} from "@plugins/telinha/protocol";

// a copia do amigo virtual (JS puro, sem build, fora de src/: nao ha alias para ela): os dois lados precisam dar a mesma prova
// eslint-disable-next-line no-restricted-imports
import * as peer from "../../../../tools/telinha-peer/password-proof.js";
import {
    ACCESS_BADGE, type AccessBlock, type AccessMode, computePasswordProof, constantTimeEqual, decideWatch, effectiveAccess, generatePassword,
    initialAccess, isValidPassword, MAX_PASSWORD_ATTEMPTS, migrateAccessSetting, normalizePassword, PASSWORD_NONCE_TTL_MS, PASSWORD_PROOF_TEST_VECTOR,
    PasswordChallenges, passwordProofMessage, type ProofState, verifyPasswordProof, type WatchAccessInput, type WatchDecision
} from "./access";
import type { PeerIdentity } from "./identity/policy";

const MODES: AccessMode[] = ["all", "friends", "approval", "password"];
const IDENTITIES: PeerIdentity[] = ["verified", "unverified", "invalid", "pending"];
const BOOLS = [false, true];
const PROOFS: ProofState[] = ["none", "ok", "wrong", "stale"];
const BLOCKS: (AccessBlock | null)[] = [null, "kicked", "declined", "tooManyAttempts"];
const ATTEMPTS = [0, 1, 4, 5, 6];

const base: WatchAccessInput = {
    configured: true,
    mode: "all",
    identity: "verified",
    admitted: true,
    blocked: null,
    duplicate: false,
    approved: false,
    requireVerified: true,
    friend: false,
    proof: "none",
    wrongAttempts: 0
};
const decide = (over: Partial<WatchAccessInput>) => decideWatch({ ...base, ...over });
const SEND: WatchDecision = { kind: "send" };
const APPROVAL: WatchDecision = { kind: "approval" };
const IGNORE: WatchDecision = { kind: "ignore" };
const deny = (reason: WatchDeniedReason): WatchDecision => ({ kind: "deny", reason });

/** Todas as combinacoes (configured × mode × identity × admitted × blocked × duplicate × approved × requireVerified × friend × proof × attempts). */
function* everyInput(): Generator<WatchAccessInput> {
    for (const configured of BOOLS) for (const mode of MODES) for (const identity of IDENTITIES) for (const admitted of BOOLS)
        for (const blocked of BLOCKS) for (const duplicate of BOOLS) for (const approved of BOOLS) for (const requireVerified of BOOLS)
            for (const friend of BOOLS) for (const proof of PROOFS) for (const wrongAttempts of ATTEMPTS)
                yield { configured, mode, identity, admitted, blocked, duplicate, approved, requireVerified, friend, proof, wrongAttempts };
}

describe("decideWatch: tabela de decisao", () => {
    test("tabela explicita (modo × identidade × amigo × aprovado × senha × tentativas × bloqueio)", () => {
        const rows: [string, Partial<WatchAccessInput>, WatchDecision][] = [
            // todos da call (comportamento de hoje)
            ["all, verificado", { mode: "all", identity: "verified" }, SEND],
            ["all, nao verificado, exigir verificada", { mode: "all", identity: "unverified" }, APPROVAL],
            ["all, nao verificado, sem exigir", { mode: "all", identity: "unverified", requireVerified: false }, SEND],
            ["all, nao verificado, aprovado", { mode: "all", identity: "unverified", approved: true }, SEND],
            ["all, sem Client ID", { mode: "all", identity: "unverified", configured: false }, SEND],
            // so amigos
            ["friends, verificado e amigo", { mode: "friends", identity: "verified", friend: true }, SEND],
            ["friends, verificado, nao amigo", { mode: "friends", identity: "verified", friend: false }, deny("friendsOnly")],
            ["friends, nao verificado e amigo", { mode: "friends", identity: "unverified", friend: true }, deny("notVerified")],
            ["friends, nao verificado, nao amigo", { mode: "friends", identity: "unverified", friend: false }, deny("notVerified")],
            ["friends, nao amigo mas aprovado antes", { mode: "friends", identity: "verified", approved: true }, SEND],
            ["friends sem Client ID vira aprovacao", { mode: "friends", configured: false, identity: "unverified", friend: true }, APPROVAL],
            // so quem eu aprovar
            ["approval, verificado e amigo", { mode: "approval", identity: "verified", friend: true }, APPROVAL],
            ["approval, nao verificado", { mode: "approval", identity: "unverified" }, APPROVAL],
            ["approval, aprovado", { mode: "approval", approved: true }, SEND],
            // com senha
            ["password, sem prova", { mode: "password" }, { kind: "password", wrong: false, attemptsLeft: 5 }],
            ["password, prova certa, verificado", { mode: "password", proof: "ok" }, SEND],
            ["password, prova certa, NAO verificado (a senha e a porta)", { mode: "password", proof: "ok", identity: "unverified" }, SEND],
            ["password, prova certa, sem Client ID", { mode: "password", proof: "ok", identity: "unverified", configured: false }, SEND],
            ["password, 1o erro", { mode: "password", proof: "wrong", wrongAttempts: 1 }, { kind: "password", wrong: true, attemptsLeft: 4 }],
            ["password, 4o erro", { mode: "password", proof: "wrong", wrongAttempts: 4 }, { kind: "password", wrong: true, attemptsLeft: 1 }],
            ["password, 5o erro bloqueia", { mode: "password", proof: "wrong", wrongAttempts: 5 }, { kind: "deny", reason: "tooManyAttempts", block: true }],
            ["password, desafio vencido nao conta", { mode: "password", proof: "stale", wrongAttempts: 2 }, { kind: "password", wrong: false, attemptsLeft: 3 }],
            ["password, sem prova depois de 2 erros", { mode: "password", wrongAttempts: 2 }, { kind: "password", wrong: false, attemptsLeft: 3 }],
            ["password, aprovado (ja assistia quando a regra mudou)", { mode: "password", approved: true }, SEND],
            // regras de sempre por cima de qualquer modo
            ["expulso", { mode: "password", proof: "ok", blocked: "kicked" }, deny("kicked")],
            ["recusado", { mode: "friends", friend: true, blocked: "declined" }, deny("declined")],
            ["bloqueado por senha", { mode: "password", proof: "ok", blocked: "tooManyAttempts" }, deny("tooManyAttempts")],
            ["duplicado", { mode: "all", duplicate: true }, deny("duplicate")],
            ["duplicado e aprovado", { mode: "approval", duplicate: true, approved: true }, deny("duplicate")],
            ["fora do canal de voz", { mode: "all", admitted: false }, IGNORE],
            ["fora do canal, prova certa", { mode: "password", admitted: false, proof: "ok" }, IGNORE],
            ["identidade falsa, mesmo admitida por engano", { mode: "password", identity: "invalid", proof: "ok" }, IGNORE],
            ["identidade falsa, amigo", { mode: "friends", identity: "invalid", friend: true }, IGNORE],
            ["conferindo a identidade", { mode: "friends", identity: "pending", friend: true }, IGNORE]
        ];
        for (const [name, input, expected] of rows) assert.deepEqual(decide(input), expected, name);
    });

    test("invariantes em TODAS as combinacoes", () => {
        let n = 0;
        for (const input of everyInput()) {
            n++;
            const d = decideWatch(input);
            const why = JSON.stringify(input) + " -> " + JSON.stringify(d);
            const fake = input.configured && (input.identity === "invalid" || input.identity === "pending");
            // 1. nao admitido / falsa / conferindo: nunca recebe resposta
            if (!input.admitted || fake) {
                assert.deepEqual(d, IGNORE, why);
                continue;
            }
            assert.notEqual(d.kind, "ignore", why);
            // 2-3. bloqueio e duplicata valem em todos os modos, antes de tudo
            if (input.blocked) {
                assert.deepEqual(d, deny(input.blocked), why);
                continue;
            }
            if (input.duplicate) {
                assert.deepEqual(d, deny("duplicate"), why);
                continue;
            }
            // 4. aprovado nesta transmissao: entra em qualquer modo
            if (input.approved) {
                assert.deepEqual(d, SEND, why);
                continue;
            }
            const mode = effectiveAccess(input.mode, input.configured);
            if (mode === "all") {
                const mustApprove = input.configured && input.requireVerified && input.identity !== "verified";
                assert.deepEqual(d, mustApprove ? APPROVAL : SEND, why);
            } else if (mode === "friends") {
                assert.ok(input.configured, why);
                if (input.identity !== "verified") assert.deepEqual(d, deny("notVerified"), why);
                else assert.deepEqual(d, input.friend ? SEND : deny("friendsOnly"), why);
                // nunca pede aprovacao nem senha
                assert.ok(d.kind === "send" || d.kind === "deny", why);
            } else if (mode === "approval") {
                assert.deepEqual(d, APPROVAL, why);
            } else {
                // senha: so a prova certa manda; a identidade nao importa (fora a falsa, que ja saiu acima)
                if (input.proof === "ok") assert.deepEqual(d, SEND, why);
                else if (input.proof === "wrong" && input.wrongAttempts >= MAX_PASSWORD_ATTEMPTS)
                    assert.deepEqual(d, { kind: "deny", reason: "tooManyAttempts", block: true }, why);
                else assert.deepEqual(d, { kind: "password", wrong: input.proof === "wrong", attemptsLeft: Math.max(0, MAX_PASSWORD_ATTEMPTS - input.wrongAttempts) }, why);
                assert.notEqual(d.kind, "approval", why);
            }
            // amizade so pesa no modo "friends"
            if (mode !== "friends") assert.deepEqual(decideWatch({ ...input, friend: !input.friend }), d, why);
        }
        assert.equal(n, 2 * 4 * 4 * 2 * 4 * 2 * 2 * 2 * 2 * 4 * 5);
    });

    test("sem Client ID, \"all\" e exatamente a v0.1.0 (requireVerified e identidade nao pesam)", () => {
        for (const identity of IDENTITIES) for (const requireVerified of BOOLS)
            assert.deepEqual(decide({ configured: false, mode: "all", identity, requireVerified }), SEND);
    });

    test("so amigos sem Client ID: o seletor e o padrao caem para aprovacao, nunca para todos", () => {
        assert.equal(effectiveAccess("friends", false), "approval");
        assert.equal(effectiveAccess("friends", true), "friends");
        for (const m of ["all", "approval", "password"] as const) for (const c of BOOLS) assert.equal(effectiveAccess(m, c), m);
        assert.equal(initialAccess("friends", false), "approval");
        assert.equal(initialAccess("friends", true), "friends");
        assert.equal(initialAccess("password", true), "password");
        assert.equal(initialAccess(undefined, true), "all");
        assert.equal(initialAccess("everyone", true), "all");
        assert.equal(initialAccess(42, false), "all");
    });

    test("etiquetas: nada para \"all\"", () => {
        assert.equal(ACCESS_BADGE.all, null);
        assert.deepEqual([ACCESS_BADGE.password, ACCESS_BADGE.friends, ACCESS_BADGE.approval], ["🔒 com senha", "👥 só amigos", "✋ com aprovação"]);
    });
});

describe("prova da senha (HMAC-SHA256)", () => {
    const V = PASSWORD_PROOF_TEST_VECTOR;

    test("vetor de teste fixo: o plugin, o amigo virtual e o node:crypto dao a mesma prova", async () => {
        const viaNode = createHmac("sha256", Buffer.from(V.password, "utf8")).update(passwordProofMessage(V.nonce, V.streamerId, V.viewerId), "utf8").digest("base64url");
        assert.equal(viaNode, V.proof);
        assert.equal(await computePasswordProof(V), V.proof);
        assert.equal(await peer.computePasswordProof(V), V.proof);
        assert.equal(passwordProofMessage(V.nonce, V.streamerId, V.viewerId), `telinha-pw-v1|${V.nonce}|${V.streamerId}|${V.viewerId}`);
    });

    test("o vetor e o MESMO nos dois arquivos, e o amigo virtual passa no proprio autoteste", async () => {
        assert.deepEqual({ ...peer.TEST_VECTOR }, { ...V });
        assert.equal(peer.PASSWORD_PROOF_LABEL, "telinha-pw-v1");
        assert.equal(peer.MAX_PASSWORD_ATTEMPTS, MAX_PASSWORD_ATTEMPTS);
        assert.equal(peer.PASSWORD_NONCE_TTL_MS, PASSWORD_NONCE_TTL_MS);
        assert.equal(await peer.selfTest(), true);
    });

    test("verificacao cruzada: um lado calcula, o outro confere (senhas variadas)", async () => {
        const cases = ["a", "pipoca-42", "Pão de Queijo 🧀", "x".repeat(64), "senha com espaço no meio"];
        for (const password of cases) {
            const nonce = peer.newPasswordNonce();
            const input = { password, nonce, streamerId: "111111111111111111", viewerId: "222222222222222222" };
            const fromPlugin = await computePasswordProof(input);
            const fromPeer = await peer.computePasswordProof(input);
            assert.equal(fromPlugin, fromPeer, password);
            assert.equal(await peer.verifyPasswordProof({ ...input, proof: fromPlugin }), true);
            assert.equal(await verifyPasswordProof({ ...input, proof: fromPeer }), true);
        }
    });

    test("a prova amarra senha, nonce, transmissor e espectador", async () => {
        const ok = (over: Record<string, unknown>) => verifyPasswordProof({ ...V, ...over });
        assert.equal(await ok({}), true);
        assert.equal(await ok({ password: "pão-43" }), false);
        assert.equal(await ok({ password: "PÃO-42" }), false);
        assert.equal(await ok({ nonce: "AAECAwQFBgcICQoLDA0OEA" }), false);
        assert.equal(await ok({ streamerId: V.viewerId, viewerId: V.streamerId }), false);
        assert.equal(await ok({ viewerId: "876543210987654322" }), false);
    });

    test("prova hostil: formato errado e falso, nunca lanca", async () => {
        const bad: unknown[] = [undefined, null, 42, {}, [], "", "abc", V.proof + "A", V.proof.slice(0, 42), V.proof.replace(/./, "+"), "=".repeat(43), "A".repeat(43), "x".repeat(100_000)];
        for (const proof of bad) assert.equal(await verifyPasswordProof({ ...V, proof }), false, String(proof).slice(0, 20));
        assert.equal(await verifyPasswordProof({ ...V, password: "" }), false);
        assert.equal(await verifyPasswordProof({ ...V, password: "x".repeat(65) }), false);
        await assert.rejects(computePasswordProof({ ...V, password: "" }));
    });

    test("normalizacao: NFC e sem espacos nas pontas (os dois lados iguais)", async () => {
        const decomposed = "pão-42"; // "ã" como a + til combinante
        assert.notEqual(decomposed, V.password);
        assert.equal(normalizePassword(`  ${decomposed}\t`), V.password);
        assert.equal(peer.normalizePassword(`  ${decomposed}\t`), V.password);
        assert.equal(await computePasswordProof({ ...V, password: normalizePassword(decomposed) }), V.proof);
        assert.equal(isValidPassword(" pipoca"), false);
        assert.equal(isValidPassword("pipoca"), true);
        assert.equal(isValidPassword(""), false);
        assert.equal(isValidPassword("x".repeat(64)), true);
        assert.equal(isValidPassword("x".repeat(65)), false);
        assert.equal(normalizePassword(42 as unknown as string), "");
    });

    test("comparacao em tempo constante: so igual quando todos os bytes e o tamanho batem", () => {
        const a = new Uint8Array([1, 2, 3, 4]);
        assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 3, 4])), true);
        assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 3, 5])), false);
        assert.equal(constantTimeEqual(a, new Uint8Array([0, 2, 3, 4])), false);
        assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 3])), false);
        assert.equal(constantTimeEqual(a, new Uint8Array([1, 2, 3, 4, 0])), false);
        assert.equal(constantTimeEqual(new Uint8Array(), new Uint8Array()), true);
    });

    test("senha gerada: palavra-NN, curta e valida", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const p = generatePassword();
            assert.match(p, /^[a-z]+-[1-9]\d$/);
            assert.ok(isValidPassword(p) && p.length <= 16, p);
            seen.add(p);
        }
        assert.ok(seen.size > 100, `pouca variedade: ${seen.size}`);
        assert.equal(generatePassword(() => new Uint32Array([0, 0])), "pipoca-10");
        assert.equal(generatePassword(() => new Uint32Array([33, 89])), "sofa-99");
    });
});

describe("desafios (nonce)", () => {
    function clock(start = 1_000_000) {
        let t = start;
        return { now: () => t, advance: (ms: number) => void (t += ms) };
    }

    test("uso unico: o mesmo nonce nao vale duas vezes", () => {
        const c = clock();
        let i = 0;
        const ch = new PasswordChallenges(c.now, PASSWORD_NONCE_TTL_MS, () => `nonce-${++i}-aaaaaaaaaaaa`);
        const { nonce } = ch.issue("p1");
        assert.equal(ch.has("p1"), true);
        assert.equal(ch.take("p1"), nonce);
        assert.equal(ch.take("p1"), null);
        assert.equal(ch.has("p1"), false);
    });

    test("vence em ~2 min", () => {
        const c = clock();
        const ch = new PasswordChallenges(c.now);
        const { nonce, expiresAt } = ch.issue("p1");
        assert.equal(expiresAt - c.now(), 120_000);
        c.advance(119_999);
        assert.equal(ch.has("p1"), true);
        assert.equal(ch.take("p1"), nonce);
        ch.issue("p1");
        c.advance(120_000);
        assert.equal(ch.has("p1"), false);
        assert.equal(ch.take("p1"), null);
    });

    test("um desafio novo substitui o anterior; cada conexao tem o seu", () => {
        const ch = new PasswordChallenges(clock().now);
        const a = ch.issue("p1").nonce;
        const b = ch.issue("p1").nonce;
        const other = ch.issue("p2").nonce;
        assert.notEqual(a, b);
        assert.equal(ch.take("p1"), b);
        assert.equal(ch.take("p2"), other);
        assert.match(a, /^[A-Za-z0-9_-]{22}$/);
    });

    test("sweep tira os vencidos e diz de quem eram; clear/delete", () => {
        const c = clock();
        const ch = new PasswordChallenges(c.now);
        ch.issue("old");
        c.advance(60_000);
        ch.issue("new");
        c.advance(60_000);
        assert.deepEqual(ch.sweep(), ["old"]);
        assert.equal(ch.size, 1);
        ch.delete("new");
        assert.equal(ch.size, 0);
        ch.issue("x");
        ch.clear();
        assert.equal(ch.take("x"), null);
    });
});

describe("protocolo: mensagens novas da acao \"watch\" e stream.access", () => {
    const PROOF = PASSWORD_PROOF_TEST_VECTOR.proof;
    const NONCE = PASSWORD_PROOF_TEST_VECTOR.nonce;

    test("pedido: start com prova valida, start simples, stop; o resto e descartado", () => {
        assert.deepEqual(parseWatchRequest({ op: "start" }), { op: "start" });
        assert.deepEqual(parseWatchRequest({ op: "start", proof: PROOF }), { op: "start", proof: PROOF });
        assert.deepEqual(parseWatchRequest({ op: "stop", proof: PROOF }), { op: "stop" });
        // prova fora do formato: o pedido vira um start simples (recebe um desafio novo)
        for (const proof of [42, null, "", "abc", PROOF + "A", PROOF.slice(1), "+".repeat(43), "x".repeat(10_000), { a: 1 }])
            assert.deepEqual(parseWatchRequest({ op: "start", proof }), { op: "start" }, String(proof).slice(0, 20));
        // campos extras nunca passam adiante
        assert.deepEqual(parseWatchRequest({ op: "start", proof: PROOF, password: "segredo", evil: true }), { op: "start", proof: PROOF });
        for (const bad of [null, undefined, "start", 1, [], {}, { op: "password", nonce: NONCE }, { op: "START" }]) assert.equal(parseWatchRequest(bad), null);
    });

    test("resposta \"password\": nonce obrigatorio no formato, tentativas 0..99, wrong so se true", () => {
        assert.deepEqual(parseWatchReply({ op: "password", nonce: NONCE }), { op: "password", nonce: NONCE });
        assert.deepEqual(parseWatchReply({ op: "password", nonce: NONCE, attemptsLeft: 4, wrong: true }), { op: "password", nonce: NONCE, attemptsLeft: 4, wrong: true });
        assert.deepEqual(parseWatchReply({ op: "password", nonce: NONCE, attemptsLeft: 0, wrong: false }), { op: "password", nonce: NONCE, attemptsLeft: 0 });
        for (const attemptsLeft of [-1, 1.5, 100, "3", NaN, Infinity, null])
            assert.deepEqual(parseWatchReply({ op: "password", nonce: NONCE, attemptsLeft }), { op: "password", nonce: NONCE }, String(attemptsLeft));
        assert.deepEqual(parseWatchReply({ op: "password", nonce: NONCE, wrong: "yes" }), { op: "password", nonce: NONCE });
        for (const nonce of [undefined, 1, "", "short", "a".repeat(65), "a b".repeat(8), NONCE + "=", { x: 1 }])
            assert.equal(parseWatchReply({ op: "password", nonce }), null, String(nonce));
    });

    test("motivos novos de \"denied\"; desconhecido continua virando \"declined\"", () => {
        for (const reason of ["friendsOnly", "notVerified", "tooManyAttempts", "kicked", "declined", "timeout", "duplicate"] as const)
            assert.deepEqual(parseWatchReply({ op: "denied", reason }), { op: "denied", reason });
        assert.deepEqual(parseWatchReply({ op: "denied", reason: "somethingNew" }), { op: "denied", reason: "declined" });
        assert.deepEqual(parseWatchReply({ op: "denied" }), { op: "denied", reason: "declined" });
        assert.deepEqual(parseWatchReply({ op: "pending", nonce: NONCE }), { op: "pending" });
    });

    test("stream.access na presenca: so os 4 valores; ausente (v0.1.0) e desconhecido ficam de fora", () => {
        const presence = (access: unknown): PresenceMessage => ({
            v: 1, discordUserId: "123", username: "Ana", streaming: true,
            stream: { kind: "screen", title: "t", hasAudio: false, width: 1920, height: 1080, fps: 60, ...(access === undefined ? {} : { access }) } as any,
            caps: { h264HwDecode: false }
        });
        for (const access of STREAM_ACCESS_MODES) assert.equal(sanitizePresence(presence(access)).stream?.access, access);
        assert.equal("access" in (sanitizePresence(presence(undefined)).stream ?? {}), false);
        for (const access of ["everyone", 1, null, { a: 1 }, ["password"], "PASSWORD"])
            assert.equal("access" in (sanitizePresence(presence(access)).stream ?? {}), false, String(access));
        // nao transmitindo: sem stream, com ou sem access
        assert.equal(sanitizePresence({ ...presence("password"), streaming: false }).stream, undefined);
        assert.deepEqual([...STREAM_ACCESS_MODES], ["all", "friends", "approval", "password"]);
        assert.equal(isStreamAccess("friends"), true);
        assert.equal(isStreamAccess("toString"), false);
    });
});

describe("migracao da opcao approveViewers (v0.1.0)", () => {
    test("approveViewers: true vira \"Só quem eu aprovar\"; a chave antiga sai", () => {
        assert.deepEqual(migrateAccessSetting({ approveViewers: true }), { defaultAccess: "approval", dropApproveViewers: true });
    });
    test("approveViewers: false (ou ausente) mantem o padrao \"Todos da call\"", () => {
        assert.deepEqual(migrateAccessSetting({ approveViewers: false }), { defaultAccess: null, dropApproveViewers: true });
        assert.deepEqual(migrateAccessSetting({}), { defaultAccess: null, dropApproveViewers: false });
        assert.deepEqual(migrateAccessSetting(undefined), { defaultAccess: null, dropApproveViewers: false });
        assert.deepEqual(migrateAccessSetting(null), { defaultAccess: null, dropApproveViewers: false });
    });
    test("uma escolha nova ja gravada vence (e a chave antiga sai)", () => {
        for (const mode of STREAM_ACCESS_MODES) {
            assert.deepEqual(migrateAccessSetting({ approveViewers: true, defaultAccess: mode }), { defaultAccess: null, dropApproveViewers: true });
            assert.deepEqual(migrateAccessSetting({ defaultAccess: mode }), { defaultAccess: null, dropApproveViewers: false });
        }
    });
    test("valores estranhos: so true conta; defaultAccess invalido e tratado como ausente", () => {
        for (const v of ["true", 1, {}, null]) assert.deepEqual(migrateAccessSetting({ approveViewers: v }), { defaultAccess: null, dropApproveViewers: true });
        assert.deepEqual(migrateAccessSetting({ approveViewers: true, defaultAccess: "everyone" }), { defaultAccess: "approval", dropApproveViewers: true });
    });
});
