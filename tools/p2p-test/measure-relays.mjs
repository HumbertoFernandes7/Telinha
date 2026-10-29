/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PeerLive P2P spike - mede relays Nostr publicos a partir desta maquina.
//
// Para cada relay: conecta 2 sockets (assinante + publicador), manda um REQ igual
// ao do Trystero (kind efemero 20000-29999 + tag "x"), mede o tempo ate o EOSE,
// publica um evento assinado igual ao do Trystero e mede o tempo ate o OK e ate a
// entrega no assinante. So relays que ENTREGAM o evento servem para sinalizacao.
//
// Uso (na raiz do repo, precisa do `trystero` instalado):
//   node tools/p2p-test/measure-relays.mjs [rodadas] [relay1 relay2 ...]

import { createEvent, subscribe } from "trystero";

const CANDIDATES = [
    // Brasil / America do Sul
    "relay.nostr.dev.br",
    // grandes e conhecidos
    "nos.lol",
    "relay.damus.io",
    "relay.primal.net",
    "nostr.mom",
    "relay.snort.social",
    "offchain.pub",
    "nostr.oxtr.dev",
    "relay.nostr.bg",
    "nostr-pub.wellorder.net",
    "nostr.bitcoiner.social",
    "relay.mostr.pub",
    "nostr.einundzwanzig.space",
    "relay.nostr.net",
    "nostr.data.haus",
    // lista padrao do Trystero 0.26.0
    "0x-nostr-relay.fly.dev",
    "cdn.satellite.earth",
    "nostr.chaima.info",
    "nostr.christiansass.de",
    "nostr.rblb.it",
    "nostr.red5d.dev",
    "nostr.robosats.org",
    "nostr.stakey.net",
    "nostrcity-club.fly.dev",
    "relay-dev.gulugulu.moe",
    "relay.aarpia.com",
    "relay.agentry.com",
    "relay.bitmacro.cloud",
    "relay.bullishbounty.com",
    "relay.degmods.com",
    "relay.flashapp.me",
    "relay.grigic.org",
    "relay.hackshed.dev",
    "relay.kaleidoswap.com",
    "relay.layer.systems",
    "relay.nostr.blockhenge.com",
    "relay.nostrmap.net",
    "relay.novospes.com",
    "relay.piazza.today",
    "relay.routstr.com",
    "testr.nymble.world"
];

const TIMEOUT_MS = 6000;
const rounds = Number(process.argv[2]) || 3;
const relays = process.argv.length > 3 ? process.argv.slice(3) : CANDIDATES;

const now = () => performance.now();

function openSocket(url) {
    return new Promise((resolve, reject) => {
        const t0 = now();
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            try { ws.close(); } catch { }
            reject(new Error("timeout de conexao"));
        }, TIMEOUT_MS);
        ws.onopen = () => {
            clearTimeout(timer);
            resolve({ ws, connectMs: now() - t0 });
        };
        ws.onerror = e => {
            clearTimeout(timer);
            reject(new Error("erro de websocket" + (e?.message ? ": " + e.message : "")));
        };
    });
}

function waitFor(ws, predicate, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeEventListener("message", onMsg);
            reject(new Error("timeout esperando " + label));
        }, TIMEOUT_MS);
        function onMsg(e) {
            let msg;
            try { msg = JSON.parse(String(e.data)); } catch { return; }
            const r = predicate(msg);
            if (r !== undefined) {
                clearTimeout(timer);
                ws.removeEventListener("message", onMsg);
                if (r instanceof Error) reject(r);
                else resolve(r);
            }
        }
        ws.addEventListener("message", onMsg);
    });
}

async function measureOnce(host) {
    const url = "wss://" + host;
    const res = { host, ok: false };
    let sub, pub;
    try {
        sub = await openSocket(url);
        res.connectMs = sub.connectMs;

        const topic = "peerlive-relay-probe-" + Math.random().toString(36).slice(2);
        const subId = "probe" + Math.random().toString(36).slice(2, 10);

        // REQ -> EOSE (mesmo filtro que o Trystero usa)
        const tReq = now();
        const eoseP = waitFor(sub.ws, m => {
            if (m[0] === "EOSE" && m[1] === subId) return true;
            if (m[0] === "CLOSED" && m[1] === subId) return new Error("CLOSED: " + m[2]);
            return undefined;
        }, "EOSE");
        sub.ws.send(subscribe(subId, topic));
        await eoseP;
        res.reqEoseMs = now() - tReq;

        pub = await openSocket(url);
        const content = JSON.stringify({ probe: true, t: Date.now() });
        const event = await createEvent(topic, content);
        const eventId = JSON.parse(event)[1].id;
        res.kind = JSON.parse(event)[1].kind;

        const tPub = now();
        const okP = waitFor(pub.ws, m => (m[0] === "OK" && m[1] === eventId ? { accepted: m[2], msg: m[3] } : undefined), "OK");
        const deliveredP = waitFor(sub.ws, m => (m[0] === "EVENT" && m[1] === subId && m[2]?.id === eventId ? now() - tPub : undefined), "entrega");
        pub.ws.send(event);

        const ok = await okP.catch(e => ({ accepted: false, msg: e.message }));
        res.okMs = now() - tPub;
        res.accepted = ok.accepted;
        res.okMsg = ok.msg || "";
        res.deliveryMs = await deliveredP.catch(() => undefined);
        res.ok = res.accepted === true && res.deliveryMs !== undefined;
    } catch (e) {
        res.error = e.message;
    } finally {
        try { sub?.ws.close(); } catch { }
        try { pub?.ws.close(); } catch { }
    }
    return res;
}

const median = xs => {
    const s = xs.filter(x => typeof x === "number").sort((a, b) => a - b);
    if (!s.length) return undefined;
    return s[Math.floor(s.length / 2)];
};
const fmt = x => (x === undefined ? "-" : Math.round(x) + "ms");

// poucos relays por vez: abrir dezenas de TLS em paralelo distorce o tempo de conexao
const CONCURRENCY = 4;
const queue = [...relays];
const results = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let host = queue.shift(); host; host = queue.shift()) await measureRelay(host);
}));

async function measureRelay(host) {
    const runs = [];
    for (let i = 0; i < rounds; i++) runs.push(await measureOnce(host));
    const okRuns = runs.filter(r => r.ok);
    results.push({
        host,
        okCount: okRuns.length,
        connect: median(runs.map(r => r.connectMs)),
        reqEose: median(runs.map(r => r.reqEoseMs)),
        okLat: median(okRuns.map(r => r.okMs)),
        delivery: median(okRuns.map(r => r.deliveryMs)),
        note: runs.find(r => !r.ok)?.error ?? runs.find(r => !r.ok)?.okMsg ?? ""
    });
}

results.sort((a, b) => b.okCount - a.okCount || (a.delivery ?? 1e9) - (b.delivery ?? 1e9));
console.log(`rodadas por relay: ${rounds}  (ok = aceitou E entregou o evento efemero do Trystero)`);
console.log("relay".padEnd(30), "ok".padEnd(5), "conexao".padEnd(9), "REQ/EOSE".padEnd(9), "OK".padEnd(9), "entrega".padEnd(9), "obs");
for (const r of results) {
    console.log(
        r.host.padEnd(30),
        `${r.okCount}/${rounds}`.padEnd(5),
        fmt(r.connect).padEnd(9),
        fmt(r.reqEose).padEnd(9),
        fmt(r.okLat).padEnd(9),
        fmt(r.delivery).padEnd(9),
        r.note
    );
}
process.exit(0);
