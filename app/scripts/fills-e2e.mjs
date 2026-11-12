// Divisible offers on a book (BOOK, default local), with the scripted parties on the public
// testnets: bob sells 3000 CKB in pieces of at least 1000; alice takes 1000 and 1200 at the same
// time, each its own swap. Controls through the API: a 900 CKB piece is refused (under the
// minimum); the 800 left may be taken whole; after that nothing more can be taken.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { ccc } from "@ckb-ccc/core";
const BOOK = process.env.BOOK ?? "http://127.0.0.1:8792";
const APP = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s]`, ...a);
let bad = 0;
const ok = (v, what, d = "") => { if (!v) bad++; say(`${v ? "ok  " : "FAIL"} ${what}${d ? ": " + d : ""}`); };
const api = async (method, url, body) => {
  const r = await fetch(BOOK + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
function run(args, name) {
  const p = spawn(process.execPath, ["scripts/party.mjs", ...args], { cwd: APP, env: { ...process.env, BOOK } });
  let out = "";
  p.stdout.on("data", (b) => { out += b; fs.appendFileSync(`${process.env.LOGS ?? "."}/${name}.log`, b); });
  p.stderr.on("data", (b) => { out += b; fs.appendFileSync(`${process.env.LOGS ?? "."}/${name}.log`, b); });
  const done = new Promise((r) => p.on("exit", (code) => r(code)));
  return { out: () => out, done };
}

const maker = run(["maker", "CKB", "3000", "2.76", "--min", "1000", "--fills", "2", "--key", "bob"], "maker");
let id;
for (let i = 0; i < 120 && !id; i++) { id = maker.out().match(/OFFER_ID=([0-9a-f]+)/)?.[1]; await sleep(500); }
ok(!!id, "bob published 3000 CKB in pieces from 1000", id);
let o = (await api("GET", `/api/offers/${id}`)).body;
ok(o.minCkb === "100000000000" && o.remainingCkb === "300000000000", "the offer says min 1000, 3000 left");

const t1 = run(["taker", id, "--ckb", "1000", "--key", "alice"], "taker1");
await sleep(40000); // the same EVM key: let the first approve and lock land before the second
const t2 = run(["taker", id, "--ckb", "1200", "--key", "alice"], "taker2");
await sleep(15000);
o = (await api("GET", `/api/offers/${id}`)).body;
ok(o.remainingCkb === "80000000000", "two pieces taken: 800 left", o.remainingCkb);

// Controls through the API, as a third person.
// a third person with an address of their own (nobody holds its key; no fill of theirs is ever locked)
const client = new ccc.ClientPublicTestnet();
const carolLock = await ccc.Script.fromKnownScript(client, ccc.KnownScript.Secp256k1Blake160, ccc.hexFrom(crypto.randomBytes(20)));
const carol = { evm: "0x000000000000000000000000000000000000c0de", ckbAddress: ccc.Address.fromScript(carolLock, client).toString() };
const h = () => "0x" + crypto.randomBytes(32).toString("hex");
const under = await api("POST", `/api/offers/${id}/fills`, { taker: carol, hashlock: h(), ckb: "900" });
ok(under.status === 409 && /between 1000/.test(under.body.error), "a 900 CKB piece is refused", `${under.status} ${under.body.error}`);
const rest = await api("POST", `/api/offers/${id}/fills`, { taker: carol, hashlock: h(), ckb: "800" });
ok(rest.status === 200 && rest.body.fill.ckbAmount === "80000000000" && rest.body.fill.usdcAmount === "736000", "the 800 left may be taken whole, at the offer's price", `${rest.status} ${rest.body.fill?.usdcAmount}`);
const more = await api("POST", `/api/offers/${id}/fills`, { taker: carol, hashlock: h(), ckb: "1000" });
ok(more.status === 409, "nothing more can be taken", `${more.status} ${more.body.error}`);
const list = (await api("GET", "/api/offers")).body;
ok(!list.some((x) => x.id === id), "an offer with nothing left leaves the open list");

const [c1, c2, cm] = await Promise.all([t1.done, t2.done, maker.done]);
o = (await api("GET", `/api/offers/${id}`)).body;
const byStatus = o.fills.map((f) => `${f.id}:${f.ckbAmount.slice(0, -8)}:${f.status}`).join(", ");
ok(c1 === 0 && c2 === 0 && cm === 0, "both takers and the maker finished", `${c1} ${c2} ${cm}`);
ok(o.fills.filter((f) => f.status === "done").length === 2, "two fills done, each its own swap", byStatus);
ok(o.stats.done >= 2 && o.stats.failed === 0, "bob's record counts them", JSON.stringify(o.stats));
say(bad ? `${bad} check(s) failed` : "all checks passed");
process.exit(bad ? 1 : 0);
