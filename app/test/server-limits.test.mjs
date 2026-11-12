// The book's limits. The public test's (2026-11-10): at a fixed 0.001 USD per CKB, 1 USD = 1,000 CKB a take,
// 1 USD a day per wallet, pair and direction, and here 2.5 USD a day per address (IP_DAY_USD).
// The limits on holding pieces of offers without locking: a person (one CKB account) holds at
// most 2 pieces at a time, one address (the client's IP, as nginx gives it) at most 3, and a held
// piece is freed after 10 minutes without a lock. Runs the real server on a free port with its own
// data folder; offers and fills only, nothing touches a chain.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ccc } from "@ckb-ccc/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const client = new ccc.ClientPublicTestnet();
const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "book-limits-"));
let server;
const addr = async () => (await ccc.Address.fromScript(await ccc.Script.fromKnownScript(client, ccc.KnownScript.Secp256k1Blake160, "0x" + crypto.randomBytes(20).toString("hex")), client)).toString();
async function post(url, body, ip) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const hash = () => "0x" + crypto.randomBytes(32).toString("hex");

before(async () => {
  server = spawn(process.execPath, [path.join(HERE, "..", "server", "server.mjs")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, WATCH_MS: "999999999", RELAYER_KEY: "", RELAYER_KEY_FILE: "", FIXED_USD_PER_CKB: "0.001", IP_DAY_USD: "2.5", LIMITS_FROM: "0" } });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error("the server did not start");
});
after(() => { server?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test("one account holds at most 2 pieces, one address at most 3", async () => {
  const maker = { ckbAddress: await addr(), evm: "0x" + "11".repeat(20) };
  const o = await post("/api/offers", { asset: "USDC", makerGives: "CKB", ckb: "10000", usdc: "10", minCkb: "500", maker });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const id = o.body.offer.id;
  const same = { ckbAddress: await addr(), evm: "0x" + "22".repeat(20) };
  const take = (taker, ip) => post(`/api/offers/${id}/fills`, { ckb: "500", hashlock: hash(), taker }, ip);
  // One account, from different addresses: the third piece is refused.
  assert.equal((await take(same, "203.0.113.1")).status, 200);
  assert.equal((await take(same, "203.0.113.2")).status, 200);
  const third = await take(same, "203.0.113.3");
  assert.equal(third.status, 429, JSON.stringify(third.body));
  // One address, different accounts: the fourth piece is refused.
  for (let i = 0; i < 3; i++) assert.equal((await take({ ckbAddress: await addr(), evm: "0x" + crypto.randomBytes(20).toString("hex") }, "198.51.100.7")).status, 200);
  const fourth = await take({ ckbAddress: await addr(), evm: "0x" + crypto.randomBytes(20).toString("hex") }, "198.51.100.7");
  assert.equal(fourth.status, 429, JSON.stringify(fourth.body));
  // Someone else, elsewhere, still takes a piece.
  assert.equal((await take({ ckbAddress: await addr(), evm: "0x" + crypto.randomBytes(20).toString("hex") }, "192.0.2.9")).status, 200);
});

test("a held piece is freed after 10 minutes without a lock", async () => {
  const { T } = await import("../shared/swaplib.mjs");
  assert.equal(T.takeToLock, 600);
});

const person = async () => ({ ckbAddress: await addr(), evm: "0x" + crypto.randomBytes(20).toString("hex") });
async function offer(makerGives) {
  const o = await post("/api/offers", { asset: "USDC", makerGives, ckb: "20000", usdc: "20", minCkb: "200", maker: await person() });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  return o.body.offer.id;
}
const takeOf = (id) => async (ckb, taker, ip) => post(`/api/offers/${id}/fills`, { ckb, hashlock: hash(), taker }, ip);

test("a take worth more than 1 USD is refused; 1 USD is taken", async () => {
  const take = takeOf(await offer("CKB"));
  const over = await take("1100", await person(), "192.0.2.21");
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.match(over.body.error ?? JSON.stringify(over.body), /at most 1 USD per swap/);
  assert.equal((await take("1000", await person(), "192.0.2.22")).status, 200, "control: 1,000 CKB, 1 USD");
});

test("one wallet takes at most 1 USD a day per pair and direction; the other direction is apart (each wallet holds at most 2 pieces, so two takes here)", async () => {
  const buyCkb = takeOf(await offer("CKB")), sellCkb = takeOf(await offer("USDC"));
  const me = await person();
  assert.equal((await buyCkb("600", me, "192.0.2.31")).status, 200);
  const more = await buyCkb("500", me, "192.0.2.32");
  assert.equal(more.status, 429, JSON.stringify(more.body));
  assert.match(more.body.error ?? JSON.stringify(more.body), /a day per pair and direction/);
  assert.equal((await sellCkb("1000", me, "192.0.2.34")).status, 200, "the other direction has its own 1 USD");
});

test("one address takes at most its daily USD across wallets", async () => {
  const take = takeOf(await offer("CKB"));
  assert.equal((await take("1000", await person(), "198.51.100.41")).status, 200);
  assert.equal((await take("1000", await person(), "198.51.100.41")).status, 200);
  const third = await take("1000", await person(), "198.51.100.41");
  assert.equal(third.status, 429, JSON.stringify(third.body));
  assert.match(third.body.error ?? JSON.stringify(third.body), /a day from one address/);
  assert.equal((await take("1000", await person(), "198.51.100.42")).status, 200, "control: another address");
});

test("the config says the limits, so the page can show them", async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/config`);
  const c = await r.json();
  assert.deepEqual(c.limits, { takeUsd: 1, takeUsdBtc: 5, dayUsd: 1, dayUsdBtc: 5, ipDayUsd: 2.5 });
});
