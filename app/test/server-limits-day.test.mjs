// DAY_USD sets a wallet's daily limit apart from one take's. At 0.001 USD per CKB with DAY_USD 1.5: a take is
// still at most 1 USD, but the same wallet takes again the same day up to 1.5 USD. server-limits.test.mjs
// (no DAY_USD) is the control: there the second take of the day is refused. A wallet holds at most 2 pieces
// without a lock, so each case here is two takes.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "book-limits-day-"));
let server;
const addr = async () => (await ccc.Address.fromScript(await ccc.Script.fromKnownScript(client, ccc.KnownScript.Secp256k1Blake160, "0x" + crypto.randomBytes(20).toString("hex")), client)).toString();
async function post(url, body, ip) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const hash = () => "0x" + crypto.randomBytes(32).toString("hex");
const person = async () => ({ ckbAddress: await addr(), evm: "0x" + crypto.randomBytes(20).toString("hex") });
async function offer() {
  const o = await post("/api/offers", { asset: "USDC", makerGives: "CKB", ckb: "20000", usdc: "20", minCkb: "200", maker: await person() });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  return (ckb, taker, ip) => post(`/api/offers/${o.body.offer.id}/fills`, { ckb, hashlock: hash(), taker }, ip);
}

before(async () => {
  server = spawn(process.execPath, [path.join(HERE, "..", "server", "server.mjs")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, WATCH_MS: "999999999", RELAYER_KEY: "", RELAYER_KEY_FILE: "", FIXED_USD_PER_CKB: "0.001", DAY_USD: "1.5", IP_DAY_USD: "0", LIMITS_FROM: "0" } });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error("the server did not start");
});
after(() => { server?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test("the same wallet takes twice in a day, up to DAY_USD", async () => {
  const take = await offer(), me = await person();
  assert.equal((await take("1000", me, "192.0.2.51")).status, 200);
  const second = await take("500", me, "192.0.2.52");
  assert.equal(second.status, 200, "1.5 USD in the day: " + JSON.stringify(second.body));
});

test("past DAY_USD the day's limit refuses, and says the day's figure", async () => {
  const take = await offer(), me = await person();
  assert.equal((await take("1000", me, "192.0.2.61")).status, 200);
  const more = await take("700", me, "192.0.2.62");
  assert.equal(more.status, 429, JSON.stringify(more.body));
  assert.match(more.body.error ?? JSON.stringify(more.body), /at most 1\.5 USD a day per pair and direction/);
});

test("one take is still at most 1 USD", async () => {
  const take = await offer();
  const over = await take("1100", await person(), "192.0.2.71");
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.match(over.body.error ?? JSON.stringify(over.body), /at most 1 USD per swap/);
});

test("the config says both limits", async () => {
  const c = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json();
  assert.deepEqual(c.limits, { takeUsd: 1, takeUsdBtc: 5, dayUsd: 1.5, dayUsdBtc: 5, ipDayUsd: 0 });
});
