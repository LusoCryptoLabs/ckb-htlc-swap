// Shared setup for the testnet swap scripts: keys, clients, the deployed lock and Train.
import { ccc } from "@ckb-ccc/core";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KEYS_DIR = process.env.KEYS_DIR ?? "./keys";
export const DEPLOY_JSON = path.join(HERE, "deploy.testnet.json");
export const client = new ccc.ClientPublicTestnet();

export const readKey = (name) => fs.readFileSync(path.join(KEYS_DIR, `${name}.key`), "utf8").trim();
export const ckbSigner = (name) => new ccc.SignerCkbPrivateKey(client, readKey(name));
export const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
export const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
export const MAX_FEE = 1_000_000n; // 0.01 CKB per input
export const SINCE_TS = 0x4000_0000_0000_0000n;

export function deployment() {
  if (!fs.existsSync(DEPLOY_JSON)) throw new Error("run deploy.mjs first");
  return JSON.parse(fs.readFileSync(DEPLOY_JSON, "utf8"));
}

/** The htlc-lock script for these terms. Timeout is an absolute timestamp in seconds. */
export function htlcScript(d, { hashlock, recipientLock, senderLock, timeoutSec, maxFee = MAX_FEE }) {
  const args = Buffer.concat([
    Buffer.from(hashlock),
    Buffer.from(ccc.bytesFrom(recipientLock.hash())),
    Buffer.from(ccc.bytesFrom(senderLock.hash())),
    le64(SINCE_TS | BigInt(timeoutSec)),
    le64(maxFee),
  ]);
  return ccc.Script.from({ codeHash: d.dataHash, hashType: d.hashType, args: ccc.hexFrom(args) });
}

export const cellDep = (d) => ({ outPoint: { txHash: d.txHash, index: d.index }, depType: "code" });

export async function waitTx(hash, label) {
  const t0 = Date.now();
  const r = await client.waitTransaction(hash, 0, 240_000);
  console.log(`  ${label}: ${hash} committed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return r;
}

/** The node's median time (seconds): what an absolute timestamp `since` is judged against. */
export async function medianTimeSec() {
  const tip = await client.getTipHeader();
  const res = await fetch("https://testnet.ckb.dev/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_block_median_time", params: [tip.hash] }),
  }).then((r) => r.json());
  return Number(BigInt(res.result) / 1000n);
}
