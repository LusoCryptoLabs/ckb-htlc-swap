// The public test's daily limits count only takes from when the limits went live (LIMITS_FROM): a
// tester's swaps from before did block their first try (2026-11-10). Here LIMITS_FROM is in the future,
// so no take counts toward the daily limit; server-limits.test.mjs (LIMITS_FROM 0) is the control.
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "book-limits-from-"));
let server;
const addr = async () => (await ccc.Address.fromScript(await ccc.Script.fromKnownScript(client, ccc.KnownScript.Secp256k1Blake160, "0x" + crypto.randomBytes(20).toString("hex")), client)).toString();
const person = async () => ({ ckbAddress: await addr(), evm: "0x" + crypto.randomBytes(20).toString("hex") });
async function post(url, body, ip) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  server = spawn(process.execPath, [path.join(HERE, "..", "server", "server.mjs")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, WATCH_MS: "999999999", RELAYER_KEY: "", RELAYER_KEY_FILE: "", FIXED_USD_PER_CKB: "0.001", LIMITS_FROM: String(Math.floor(Date.now() / 1000) + 3600) } });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error("the server did not start");
});
after(() => { server?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test("takes from before the limits went live do not count toward the daily limit", async () => {
  const o = await post("/api/offers", { asset: "USDC", makerGives: "CKB", ckb: "20000", usdc: "20", minCkb: "200", maker: await person() });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const me = await person();
  const take = (ckb) => post(`/api/offers/${o.body.offer.id}/fills`, { ckb, hashlock: "0x" + crypto.randomBytes(32).toString("hex"), taker: me }, "192.0.2.51");
  assert.equal((await take("600")).status, 200);
  const second = await take("500");
  assert.equal(second.status, 200, "with LIMITS_FROM 0 this second take is refused (server-limits.test.mjs): " + JSON.stringify(second.body));
  const big = await post(`/api/offers/${o.body.offer.id}/fills`, { ckb: "1100", hashlock: "0x" + crypto.randomBytes(32).toString("hex"), taker: await person() }, "192.0.2.52");
  assert.equal(big.status, 409, "the per-swap cap still holds: " + JSON.stringify(big.body));
});
